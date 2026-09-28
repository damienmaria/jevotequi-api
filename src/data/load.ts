/**
 * Loads and cross-validates one election's political data files (ADR 0003).
 *
 * Everything here runs in CI. A merge request carrying data that breaks §12,
 * §14, §16, §17 or §20 fails before the data reaches a database.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import type {
  Candidate,
  CandidatePosition,
  Question,
  ScaleValue,
  Theme,
} from '../domain/types';
import {
  candidatePositionsFileSchema,
  candidateSchema,
  electionSchema,
  questionSchema,
  themeSchema,
  type CandidateFile,
  type CandidatePositionsFile,
  type ElectionFile,
} from './schema';

export class DataValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`political data validation failed:\n  - ${problems.join('\n  - ')}`);
    this.name = 'DataValidationError';
  }
}

function readYaml<T>(path: string, schema: z.ZodType<T>, problems: string[]): T | null {
  // `merge: true` enables YAML merge keys (`<<: *anchor`), which the position
  // files use to share the coder, the date and the source reference. The yaml
  // package leaves them off by default because they are a YAML 1.1 feature.
  const parsed = parse(readFileSync(path, 'utf8'), { merge: true });
  const result = schema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${path}: ${issue.path.join('.')} — ${issue.message}`);
    }
    return null;
  }
  return result.data;
}

export interface LoadedElection {
  election: ElectionFile;
  themes: Theme[];
  questions: Question[];
  candidates: Candidate[];
  positions: CandidatePosition[];
  /** Kept for the seed script and the explainability payload (§22). */
  files: CandidatePositionsFile[];
}

export function loadElection(dir: string): LoadedElection {
  const problems: string[] = [];

  const election = readYaml(join(dir, 'election.yaml'), electionSchema, problems);
  const themeFiles = readYaml(join(dir, 'themes.yaml'), z.array(themeSchema), problems) ?? [];
  const questionFiles =
    readYaml(join(dir, 'questions.yaml'), z.array(questionSchema), problems) ?? [];
  const candidateFiles =
    readYaml(join(dir, 'candidates.yaml'), z.array(candidateSchema), problems) ?? [];

  const positionsDir = join(dir, 'positions');
  const files: CandidatePositionsFile[] = [];
  for (const name of readdirSync(positionsDir).sort()) {
    if (!name.endsWith('.yaml')) continue;
    const file = readYaml(
      join(positionsDir, name),
      candidatePositionsFileSchema,
      problems,
    );
    if (file) files.push(file);
  }

  // --- cross-file invariants ----------------------------------------------
  const themeIds = new Set(themeFiles.map((t) => t.id));
  const questionIds = new Set(questionFiles.map((q) => q.id));
  const candidateIds = new Set(candidateFiles.map((c) => c.id));

  for (const q of questionFiles) {
    if (!themeIds.has(q.theme_id)) {
      problems.push(`questions.yaml: ${q.id} references unknown theme ${q.theme_id}`);
    }
  }

  for (const c of candidateFiles) {
    if (election && c.election_id !== election.id) {
      problems.push(`candidates.yaml: ${c.id} belongs to another election`);
    }
  }

  // §24: official_order must be unique, otherwise the "default order" is not a
  // total order and the fallback would depend on insertion order.
  const orders = candidateFiles
    .map((c) => c.official_order)
    .filter((o): o is number => o !== null);
  if (new Set(orders).size !== orders.length) {
    problems.push('candidates.yaml: official_order values must be unique (§24)');
  }

  // §24: normalized_name must be unique, for the same reason — it is the tie
  // breaker of last resort.
  const names = candidateFiles.map((c) => c.normalized_name);
  if (new Set(names).size !== names.length) {
    problems.push('candidates.yaml: normalized_name values must be unique (§24)');
  }

  for (const file of files) {
    const where = `positions/${file.candidate_id}.yaml`;

    if (!candidateIds.has(file.candidate_id)) {
      problems.push(`${where}: unknown candidate ${file.candidate_id}`);
    }

    const declaredSources = new Set(file.sources.map((s) => s.id));
    const seenQuestions = new Set<string>();

    for (const p of file.positions) {
      if (!questionIds.has(p.question_id)) {
        problems.push(`${where}: unknown question ${p.question_id}`);
      }
      // §20: two positions for the same (candidate, question) would need
      // non-overlapping validity ranges. Within one file version we simply
      // forbid the duplicate.
      if (seenQuestions.has(p.question_id)) {
        problems.push(`${where}: duplicate position for ${p.question_id} (§20)`);
      }
      seenQuestions.add(p.question_id);

      for (const ref of p.sources) {
        if (!declaredSources.has(ref.source_id)) {
          problems.push(
            `${where}: ${p.question_id} references source ${ref.source_id}, not declared in this file (§16)`,
          );
        }
      }
    }
  }

  // §9: a candidate marked `listed_without_data` must genuinely have no
  // positions, and one marked `included` must have a positions file. Silent
  // omission is what this check exists to prevent.
  const withPositions = new Set(files.map((f) => f.candidate_id));
  for (const c of candidateFiles) {
    if (c.inclusion_status === 'included' && !withPositions.has(c.id)) {
      problems.push(
        `candidates.yaml: ${c.id} is marked included but has no positions file; mark it listed_without_data instead of omitting it (§9)`,
      );
    }
    if (c.inclusion_status === 'listed_without_data' && withPositions.has(c.id)) {
      problems.push(`candidates.yaml: ${c.id} has positions but is marked listed_without_data`);
    }
  }

  if (problems.length > 0 || !election) {
    throw new DataValidationError(problems.length > 0 ? problems : ['election.yaml is missing']);
  }

  return {
    election,
    themes: themeFiles.map(toTheme),
    questions: questionFiles.map(toQuestion),
    candidates: candidateFiles.map(toCandidate),
    positions: files.flatMap((f) =>
      f.positions.map<CandidatePosition>((p) => ({
        candidateId: f.candidate_id,
        questionId: p.question_id,
        position: p.position as ScaleValue,
        status: p.status,
        programVersionId: f.program.version_id,
      })),
    ),
    files,
  };
}

const toTheme = (t: z.infer<typeof themeSchema>): Theme => ({
  id: t.id,
  name: t.name,
  displayOrder: t.display_order,
  active: t.active,
});

const toQuestion = (q: z.infer<typeof questionSchema>): Question => ({
  id: q.id,
  themeId: q.theme_id,
  text: q.text,
  displayOrder: q.display_order,
  active: q.active,
});

const toCandidate = (c: CandidateFile): Candidate => ({
  id: c.id,
  displayName: c.display_name,
  normalizedName: c.normalized_name,
  officialOrder: c.official_order,
  inclusionStatus: c.inclusion_status,
});

export function electionsRoot(): string {
  return join(process.cwd(), 'data', 'elections');
}

export function loadAllElections(): LoadedElection[] {
  const root = electionsRoot();
  return readdirSync(root)
    .sort()
    .map((slug) => loadElection(join(root, slug)));
}
