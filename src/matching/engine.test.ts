import { describe, expect, it } from 'vitest';

import type {
  Candidate,
  CandidatePosition,
  MatchingInput,
  Question,
  ScaleValue,
  Theme,
  ThemeWeight,
  UserAnswer,
} from '../domain/types';
import { computeMatching } from './engine';
import { MatchingValidationError } from './errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds `themeSizes.length` themes holding the given number of questions. */
function questionnaire(themeSizes: number[]): {
  themes: Theme[];
  questions: Question[];
} {
  const themes: Theme[] = themeSizes.map((_, t) => ({
    id: `t${t + 1}`,
    name: `Theme ${t + 1}`,
    displayOrder: t + 1,
    active: true,
  }));

  const questions: Question[] = [];
  themeSizes.forEach((size, t) => {
    for (let q = 0; q < size; q += 1) {
      questions.push({
        id: `t${t + 1}q${q + 1}`,
        themeId: `t${t + 1}`,
        text: `Question ${t + 1}.${q + 1}`,
        displayOrder: q + 1,
        active: true,
      });
    }
  });

  return { themes, questions };
}

function candidate(id: string, normalizedName = id, officialOrder: number | null = null): Candidate {
  return {
    id,
    displayName: normalizedName,
    normalizedName,
    officialOrder,
    inclusionStatus: 'included',
  };
}

function answerAll(questions: Question[], value: ScaleValue): UserAnswer[] {
  return questions.map((q) => ({ questionId: q.id, kind: 'answered', value }));
}

function positionsAll(
  candidateId: string,
  questions: Question[],
  position: ScaleValue,
  status: CandidatePosition['status'] = 'confirmed',
): CandidatePosition[] {
  return questions.map((q) => ({
    candidateId,
    questionId: q.id,
    position,
    status,
    programVersionId: 'pv1',
  }));
}

function input(overrides: Partial<MatchingInput> & Pick<MatchingInput, 'themes' | 'questions'>): MatchingInput {
  return {
    electionId: 'e1',
    candidates: [],
    positions: [],
    answers: [],
    ...overrides,
  };
}

function only(result: ReturnType<typeof computeMatching>) {
  expect(result.results).toHaveLength(1);
  return result.results[0];
}

// ---------------------------------------------------------------------------
// §36 — Matching engine test cases
// ---------------------------------------------------------------------------

describe('score bounds (§21, §36)', () => {
  it('perfect agreement scores 1000', () => {
    const { themes, questions } = questionnaire([4, 4]);
    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: positionsAll('c1', questions, 2),
          answers: answerAll(questions, 2),
        }),
      ),
    );
    expect(r.comparable).toBe(true);
    expect(r).toMatchObject({ scoreMilli: 1000, rank: 1 });
  });

  it('perfect disagreement scores 0, not "not comparable"', () => {
    const { themes, questions } = questionnaire([4, 4]);
    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: positionsAll('c1', questions, -2),
          answers: answerAll(questions, 2),
        }),
      ),
    );
    expect(r.comparable).toBe(true);
    expect(r).toMatchObject({ scoreMilli: 0 });
  });

  it('neutral answers against neutral positions score 1000', () => {
    const { themes, questions } = questionnaire([4]);
    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: positionsAll('c1', questions, 0),
          answers: answerAll(questions, 0),
        }),
      ),
    );
    expect(r).toMatchObject({ comparable: true, scoreMilli: 1000 });
  });
});

describe('exclusions (§13, §42, §43)', () => {
  it('a skipped question leaves both numerator and denominator', () => {
    const { themes, questions } = questionnaire([4]);
    // Agrees on 3 questions, skips the 4th where the candidate is opposed.
    const answers: UserAnswer[] = [
      ...answerAll(questions.slice(0, 3), 2),
      { questionId: questions[3].id, kind: 'skipped' },
    ];
    const positions: CandidatePosition[] = [
      ...positionsAll('c1', questions.slice(0, 3), 2),
      ...positionsAll('c1', questions.slice(3), -2),
    ];

    const r = only(
      computeMatching(
        input({ themes, questions, candidates: [candidate('c1')], positions, answers }),
      ),
    );

    // The opposed question is not counted at all: the score stays perfect.
    expect(r).toMatchObject({ comparable: true, scoreMilli: 1000 });
    expect(r.coverage).toMatchObject({ answered: 3, documented: 3, used: 3 });
  });

  it('a missing candidate position is excluded and lowers coverage', () => {
    const { themes, questions } = questionnaire([4]);
    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          // Documented on 2 of the 4 questions only.
          positions: positionsAll('c1', questions.slice(0, 2), 2),
          answers: answerAll(questions, 2),
        }),
      ),
    );

    expect(r).toMatchObject({ comparable: true, scoreMilli: 1000 });
    expect(r.coverage).toMatchObject({ answered: 4, documented: 2, used: 2 });
  });

  it('an uncertain position is excluded and counts as undocumented', () => {
    const { themes, questions } = questionnaire([2]);
    const positions: CandidatePosition[] = [
      ...positionsAll('c1', questions.slice(0, 1), 2, 'confirmed'),
      ...positionsAll('c1', questions.slice(1), -2, 'uncertain'),
    ];

    const r = only(
      computeMatching(
        input({ themes, questions, candidates: [candidate('c1')], positions, answers: answerAll(questions, 2) }),
      ),
    );

    expect(r).toMatchObject({ comparable: true, scoreMilli: 1000 });
    expect(r.coverage).toMatchObject({ answered: 2, documented: 1, used: 1 });
  });

  it('a not_available position is treated exactly like a missing one', () => {
    const { themes, questions } = questionnaire([2]);
    const withStatus = (status: CandidatePosition['status']) =>
      only(
        computeMatching(
          input({
            themes,
            questions,
            candidates: [candidate('c1')],
            positions: [
              ...positionsAll('c1', questions.slice(0, 1), 2, 'confirmed'),
              ...positionsAll('c1', questions.slice(1), 0, status),
            ],
            answers: answerAll(questions, 2),
          }),
        ),
      );

    expect(withStatus('not_available').coverage).toEqual(withStatus('uncertain').coverage);
  });

  it('a neutral position is compared, unlike a missing one (§43)', () => {
    const { themes, questions } = questionnaire([1]);
    const neutral = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: positionsAll('c1', questions, 0, 'confirmed'),
          answers: answerAll(questions, 2),
        }),
      ),
    );
    const missing = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: [],
          answers: answerAll(questions, 2),
        }),
      ),
    );

    // A neutral position is a position: distance 2 of 4 gives 500.
    expect(neutral).toMatchObject({ comparable: true, scoreMilli: 500 });
    // A missing position is not comparable at all.
    expect(missing).toMatchObject({ comparable: false, reason: 'no_documented_position' });
  });
});

describe('not comparable (§15, §43)', () => {
  it('a candidate with no documented position gets no score', () => {
    const { themes, questions } = questionnaire([4]);
    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: [],
          answers: answerAll(questions, 1),
        }),
      ),
    );

    expect(r).toMatchObject({ comparable: false, reason: 'no_documented_position' });
    expect(r).not.toHaveProperty('scoreMilli');
    expect(r.coverage).toMatchObject({ answered: 4, documented: 0, used: 0 });
  });

  it('documented positions that all fall in zero-weight themes give no score', () => {
    const { themes, questions } = questionnaire([2, 2]);
    const themeWeights: ThemeWeight[] = [
      { themeId: 't1', weightBp: 0 },
      { themeId: 't2', weightBp: 10_000 },
    ];

    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          // Documented only inside the theme weighted 0.
          positions: positionsAll('c1', questions.slice(0, 2), 2),
          answers: answerAll(questions, 2),
          themeWeights,
        }),
      ),
    );

    // Distinguished from "no documented position": the data exists, the user's
    // priorities removed it. No division by zero, no score of 0.
    expect(r).toMatchObject({ comparable: false, reason: 'no_usable_question' });
  });

  it('produces no results rather than throwing when there is no candidate data', () => {
    const { themes, questions } = questionnaire([4]);
    const result = computeMatching(
      input({ themes, questions, candidates: [], positions: [], answers: answerAll(questions, 1) }),
    );
    expect(result.results).toEqual([]);
  });
});

describe('theme weighting (§15, §21)', () => {
  it('equal priority means equal influence whatever the question count', () => {
    // Theme 1 holds 2 questions, theme 2 holds 6. The candidate agrees fully on
    // theme 1 and is fully opposed on theme 2. With correct per-question
    // weighting the two themes cancel exactly.
    const { themes, questions } = questionnaire([2, 6]);
    const t1 = questions.filter((q) => q.themeId === 't1');
    const t2 = questions.filter((q) => q.themeId === 't2');

    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: [...positionsAll('c1', t1, 2), ...positionsAll('c1', t2, -2)],
          answers: answerAll(questions, 2),
        }),
      ),
    );

    // Without the theme_weight / question_count conversion this would be 250,
    // because the 6-question theme would outweigh the 2-question one.
    expect(r).toMatchObject({ scoreMilli: 500 });
  });

  it('defaults to exactly equal weights when none are supplied', () => {
    // Three themes: 10000 basis points do not divide evenly, so a basis-point
    // default would produce 3333/3333/3334 and a measurable asymmetry.
    const { themes, questions } = questionnaire([1, 1, 1]);
    const perThemeAgreement: CandidatePosition[] = [
      ...positionsAll('c1', [questions[0]], 2),
      ...positionsAll('c1', [questions[1]], -2),
      ...positionsAll('c1', [questions[2]], -2),
    ];

    const rotate = (offset: number) =>
      only(
        computeMatching(
          input({
            themes,
            questions,
            candidates: [candidate('c1')],
            positions: perThemeAgreement.map((p, i) => ({
              ...p,
              questionId: questions[(i + offset) % 3].id,
            })),
            answers: answerAll(questions, 2),
          }),
        ),
      );

    // Whichever theme holds the agreement, the score must be identical.
    const scores = [rotate(0), rotate(1), rotate(2)].map((r) =>
      r.comparable ? r.scoreMilli : null,
    );
    expect(new Set(scores).size).toBe(1);
  });

  it('honours 100% weight on a single theme', () => {
    const { themes, questions } = questionnaire([2, 2]);
    const t1 = questions.filter((q) => q.themeId === 't1');
    const t2 = questions.filter((q) => q.themeId === 't2');

    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: [...positionsAll('c1', t1, 2), ...positionsAll('c1', t2, -2)],
          answers: answerAll(questions, 2),
          themeWeights: [
            { themeId: 't1', weightBp: 10_000 },
            { themeId: 't2', weightBp: 0 },
          ],
        }),
      ),
    );

    expect(r).toMatchObject({ scoreMilli: 1000 });
  });

  it('removes a zero-weight theme from the calculation entirely', () => {
    const { themes, questions } = questionnaire([2, 2]);
    const t1 = questions.filter((q) => q.themeId === 't1');
    const t2 = questions.filter((q) => q.themeId === 't2');
    const positions = [...positionsAll('c1', t1, 2), ...positionsAll('c1', t2, -2)];

    const zeroWeighted = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions,
          answers: answerAll(questions, 2),
          themeWeights: [
            { themeId: 't1', weightBp: 10_000 },
            { themeId: 't2', weightBp: 0 },
          ],
        }),
      ),
    );

    // `used` counts only questions that carried weight.
    expect(zeroWeighted.coverage).toMatchObject({ answered: 4, documented: 4, used: 2 });
  });

  it('applies different theme weights proportionally', () => {
    const { themes, questions } = questionnaire([1, 1]);
    const r = only(
      computeMatching(
        input({
          themes,
          questions,
          candidates: [candidate('c1')],
          positions: [
            ...positionsAll('c1', [questions[0]], 2),
            ...positionsAll('c1', [questions[1]], -2),
          ],
          answers: answerAll(questions, 2),
          themeWeights: [
            { themeId: 't1', weightBp: 7_500 },
            { themeId: 't2', weightBp: 2_500 },
          ],
        }),
      ),
    );

    // 0.75 × 1 + 0.25 × 0 = 0.75
    expect(r).toMatchObject({ scoreMilli: 750 });
  });
});

describe('ordering and ties (§24)', () => {
  const { themes, questions } = questionnaire([1]);

  function rank(candidates: Candidate[], positions: CandidatePosition[]) {
    return computeMatching(
      input({ themes, questions, candidates, positions, answers: answerAll(questions, 2) }),
    ).results;
  }

  it('orders by descending score', () => {
    const results = rank(
      [candidate('c1', 'alpha'), candidate('c2', 'bravo')],
      [
        ...positionsAll('c1', questions, -2),
        ...positionsAll('c2', questions, 2),
      ],
    );
    expect(results.map((r) => r.candidateId)).toEqual(['c2', 'c1']);
  });

  it('breaks ties alphabetically, never on the candidate id', () => {
    // The ids order zoe-before-alice; the normalized names order the other way.
    const results = rank(
      [candidate('aaa-id', 'zoe'), candidate('zzz-id', 'alice')],
      [
        ...positionsAll('aaa-id', questions, 2),
        ...positionsAll('zzz-id', questions, 2),
      ],
    );

    expect(results.map((r) => r.candidateId)).toEqual(['zzz-id', 'aaa-id']);
    expect(results.every((r) => r.comparable && r.rank === 1)).toBe(true);
  });

  it('gives tied candidates the same rank and skips the consumed ranks', () => {
    const { themes: th, questions: qs } = questionnaire([1]);
    const cands = [
      candidate('a', 'a'),
      candidate('b', 'b'),
      candidate('c', 'c'),
      candidate('d', 'd'),
    ];
    const results = computeMatching(
      input({
        themes: th,
        questions: qs,
        candidates: cands,
        positions: [
          ...positionsAll('a', qs, 2), // 1000
          ...positionsAll('b', qs, 0), // 500
          ...positionsAll('c', qs, 0), // 500
          ...positionsAll('d', qs, -2), // 0
        ],
        answers: answerAll(qs, 2),
      }),
    ).results;

    expect(results.map((r) => (r.comparable ? r.rank : null))).toEqual([1, 2, 2, 4]);
  });

  it('lists not-comparable candidates after the scored ones, never omitted', () => {
    const results = rank(
      [candidate('scored', 'scored'), candidate('unknown', 'aaa-first-alphabetically')],
      positionsAll('scored', questions, 2),
    );

    expect(results).toHaveLength(2);
    expect(results[0].candidateId).toBe('scored');
    expect(results[1]).toMatchObject({ comparable: false, reason: 'no_documented_position' });
  });

  it('does not depend on the order candidates are supplied in', () => {
    const cands = [candidate('a', 'a'), candidate('b', 'b'), candidate('c', 'c')];
    const positions = [
      ...positionsAll('a', questions, 2),
      ...positionsAll('b', questions, 2),
      ...positionsAll('c', questions, 0),
    ];

    const forward = rank(cands, positions).map((r) => r.candidateId);
    const reversed = rank([...cands].reverse(), [...positions].reverse()).map((r) => r.candidateId);

    expect(reversed).toEqual(forward);
  });
});

describe('validation (§15, §26)', () => {
  const { themes, questions } = questionnaire([2, 2]);
  const base = { themes, questions, candidates: [candidate('c1')], positions: [] };

  function expectCode(fn: () => unknown, code: string) {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(MatchingValidationError);
      expect((error as MatchingValidationError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${code} to be thrown`);
  }

  it('rejects an answer outside the scale', () => {
    expectCode(
      () =>
        computeMatching(
          input({
            ...base,
            answers: [{ questionId: 't1q1', kind: 'answered', value: 3 as ScaleValue }],
          }),
        ),
      'INVALID_ANSWER_VALUE',
    );
  });

  it('rejects an unknown question', () => {
    expectCode(
      () =>
        computeMatching(
          input({ ...base, answers: [{ questionId: 'nope', kind: 'answered', value: 1 }] }),
        ),
      'UNKNOWN_QUESTION',
    );
  });

  it('rejects a duplicate answer', () => {
    expectCode(
      () =>
        computeMatching(
          input({
            ...base,
            answers: [
              { questionId: 't1q1', kind: 'answered', value: 1 },
              { questionId: 't1q1', kind: 'answered', value: -1 },
            ],
          }),
        ),
      'DUPLICATE_ANSWER',
    );
  });

  it('rejects theme weights that do not sum to exactly 10000', () => {
    expectCode(
      () =>
        computeMatching(
          input({
            ...base,
            answers: [],
            themeWeights: [
              { themeId: 't1', weightBp: 5_000 },
              { themeId: 't2', weightBp: 4_999 },
            ],
          }),
        ),
      'THEME_WEIGHT_SUM',
    );
  });

  it('rejects a negative theme weight', () => {
    expectCode(
      () =>
        computeMatching(
          input({
            ...base,
            answers: [],
            themeWeights: [
              { themeId: 't1', weightBp: 11_000 },
              { themeId: 't2', weightBp: -1_000 },
            ],
          }),
        ),
      'NEGATIVE_THEME_WEIGHT',
    );
  });

  it('rejects a weight set that omits an active theme', () => {
    expectCode(
      () =>
        computeMatching(
          input({ ...base, answers: [], themeWeights: [{ themeId: 't1', weightBp: 10_000 }] }),
        ),
      'MISSING_THEME_WEIGHT',
    );
  });

  it('rejects an unknown theme', () => {
    expectCode(
      () =>
        computeMatching(
          input({
            ...base,
            answers: [],
            themeWeights: [
              { themeId: 't1', weightBp: 5_000 },
              { themeId: 't2', weightBp: 4_000 },
              { themeId: 'ghost', weightBp: 1_000 },
            ],
          }),
        ),
      'UNKNOWN_THEME',
    );
  });

  it('never puts a submitted value in the error message (§32)', () => {
    try {
      computeMatching(
        input({
          ...base,
          answers: [{ questionId: 't1q1', kind: 'answered', value: 42 as ScaleValue }],
        }),
      );
    } catch (error) {
      expect((error as Error).message).not.toContain('42');
      expect((error as Error).message).toBe('INVALID_ANSWER_VALUE at answers[0]');
    }
  });
});

describe('determinism (§4)', () => {
  it('produces byte-identical output across repeated runs', () => {
    const { themes, questions } = questionnaire([4, 4, 2]);
    const cands = [candidate('a', 'ana'), candidate('b', 'bea'), candidate('c', 'cid')];
    const positions = cands.flatMap((c, i) =>
      questions.map((q, j) => ({
        candidateId: c.id,
        questionId: q.id,
        position: (((i + j) % 5) - 2) as ScaleValue,
        status: 'confirmed' as const,
        programVersionId: `pv${i}`,
      })),
    );
    const answers = questions.map((q, j) => ({
      questionId: q.id,
      kind: 'answered' as const,
      value: ((j % 5) - 2) as ScaleValue,
    }));

    const run = () =>
      JSON.stringify(
        computeMatching(input({ themes, questions, candidates: cands, positions, answers })),
      );

    expect(run()).toBe(run());
    expect(run()).toBe(run());
  });

  it('reports the engine version and the program versions used', () => {
    const { themes, questions } = questionnaire([1]);
    const result = computeMatching(
      input({
        themes,
        questions,
        candidates: [candidate('c1')],
        positions: [
          { candidateId: 'c1', questionId: 't1q1', position: 1, status: 'confirmed', programVersionId: 'pv-b' },
        ],
        answers: answerAll(questions, 1),
      }),
    );

    expect(result.engineVersion).toBe('1.0.0');
    expect(result.programVersions).toEqual(['pv-b']);
  });
});
