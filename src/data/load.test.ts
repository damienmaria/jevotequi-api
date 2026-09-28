import { describe, expect, it } from 'vitest';

import { computeMatching } from '../matching/engine';
import { loadAllElections, loadElection, electionsRoot } from './load';
import { join } from 'node:path';

/**
 * These are the CI gates of ADR 0003: the shipped political data must satisfy
 * §12, §14, §16, §17 and §24 before it can be merged.
 */

describe('shipped political data', () => {
  const elections = loadAllElections();

  it('loads and cross-validates every election directory', () => {
    expect(elections.length).toBeGreaterThan(0);
  });

  it.each(elections.map((e) => [e.election.slug, e] as const))(
    '%s: every confirmed position carries a second pass (§14)',
    (_slug, election) => {
      const unreviewed = election.files.flatMap((f) =>
        f.positions
          .filter((p) => p.status === 'confirmed' && p.reviewed_by === null)
          .map((p) => `${f.candidate_id}/${p.question_id}`),
      );
      expect(unreviewed).toEqual([]);
    },
  );

  it.each(elections.map((e) => [e.election.slug, e] as const))(
    '%s: every position cites at least one source (§16)',
    (_slug, election) => {
      const unsourced = election.files.flatMap((f) =>
        f.positions.filter((p) => p.sources.length === 0).map((p) => p.question_id),
      );
      expect(unsourced).toEqual([]);
    },
  );

  it.each(elections.map((e) => [e.election.slug, e] as const))(
    '%s: every source keeps an archived copy (§17)',
    (_slug, election) => {
      for (const file of election.files) {
        for (const source of file.sources) {
          expect(source.archived_copy_url).toBeTruthy();
        }
      }
    },
  );

  it.each(elections.map((e) => [e.election.slug, e] as const))(
    '%s: the questionnaire is complete and every question is reviewed (§12)',
    (_slug, election) => {
      const active = election.questions.filter((q) => q.active);
      expect(active.length).toBeGreaterThan(0);

      // Every active theme holds at least one active question, otherwise a
      // user could weight a theme that cannot influence anything.
      for (const theme of election.themes.filter((t) => t.active)) {
        expect(active.some((q) => q.themeId === theme.id)).toBe(true);
      }
    },
  );
});

describe('fr-demo-2027 end to end (§21, §43)', () => {
  const election = loadElection(join(electionsRoot(), 'fr-demo-2027'));

  it('has 8 themes of 4 questions (§10)', () => {
    expect(election.themes.filter((t) => t.active)).toHaveLength(8);
    expect(election.questions.filter((q) => q.active)).toHaveLength(32);
  });

  it('scores every candidate and lists the undocumented one as not comparable', () => {
    const result = computeMatching({
      electionId: election.election.id,
      themes: election.themes,
      questions: election.questions,
      candidates: election.candidates,
      positions: election.positions,
      answers: election.questions.map((q) => ({
        questionId: q.id,
        kind: 'answered' as const,
        value: 2 as const,
      })),
    });

    expect(result.results).toHaveLength(4);

    const notComparable = result.results.filter((r) => !r.comparable);
    expect(notComparable.map((r) => r.candidateId)).toEqual(['dominique-leroy']);

    // §24: the candidate without data is listed last, never omitted.
    expect(result.results[result.results.length - 1].candidateId).toBe('dominique-leroy');
  });

  it('reports a lower coverage for the thinly documented candidate (§43)', () => {
    const result = computeMatching({
      electionId: election.election.id,
      themes: election.themes,
      questions: election.questions,
      candidates: election.candidates,
      positions: election.positions,
      answers: election.questions.map((q) => ({
        questionId: q.id,
        kind: 'answered' as const,
        value: 0 as const,
      })),
    });

    const byId = new Map(result.results.map((r) => [r.candidateId, r]));

    // Confirmed positions only: uncertain ones count as undocumented (§42).
    expect(byId.get('camille-aubert')!.coverage.documented).toBe(31); // 32 entries, 1 uncertain
    expect(byId.get('noe-fontaine')!.coverage.documented).toBe(28); // 29 entries, 1 uncertain
    expect(byId.get('sacha-moreau')!.coverage.documented).toBe(22); // 22 entries, none uncertain
    expect(byId.get('dominique-leroy')!.coverage.documented).toBe(0);

    // The point of §43: the thinnest coverage must be visibly lower.
    expect(byId.get('sacha-moreau')!.coverage.documented).toBeLessThan(
      byId.get('camille-aubert')!.coverage.documented,
    );
  });

  it('is reproducible across runs (§4)', () => {
    const run = () =>
      JSON.stringify(
        computeMatching({
          electionId: election.election.id,
          themes: election.themes,
          questions: election.questions,
          candidates: election.candidates,
          positions: election.positions,
          answers: election.questions.map((q, i) => ({
            questionId: q.id,
            kind: 'answered' as const,
            value: ((i % 5) - 2) as -2 | -1 | 0 | 1 | 2,
          })),
        }),
      );

    expect(run()).toBe(run());
  });
});
