/**
 * Jevotequi matching engine.
 *
 * Pure, dependency-free, deterministic (guideline §4, §21). It must not import
 * anything from the framework, the database or the environment, and it must not
 * read the clock or any source of randomness.
 *
 * All arithmetic is integer arithmetic. There is exactly one division, at the
 * end of each candidate's score. See §21.
 */

import {
  MAX_DISTANCE,
  SCALE_MAX,
  SCALE_MIN,
  SCORE_SCALE,
  TOTAL_WEIGHT_BP,
  type Candidate,
  type CandidatePosition,
  type CandidateResult,
  type Coverage,
  type MatchingInput,
  type MatchingResult,
  type Question,
  type ThemeBreakdown,
  type ThemeCoverage,
  type UserAnswer,
} from '../domain/types';
import { MatchingValidationError } from './errors';
import { assignRanks, compareNormalizedName } from './ordering';

export const ENGINE_VERSION = '1.0.0';

/** Guard against an input that would overflow exact integer arithmetic. */
const MAX_SAFE_NUMERATOR = Number.MAX_SAFE_INTEGER / (2 * SCORE_SCALE);

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/**
 * §21: `question_weight = theme_units × L / questions_in_theme`, where `L` is
 * the least common multiple of the active question counts across themes. Using
 * the lcm keeps every question weight an integer whatever the question counts
 * are, so the single division stays at the very end.
 *
 * The guideline quotes 840 = lcm(1…8) as the worst case for themes holding up
 * to eight questions; computing it removes that ceiling.
 */
function questionWeightMultiplier(questionCounts: readonly number[]): number {
  return questionCounts.reduce((acc, n) => lcm(acc, n), 1);
}

// ---------------------------------------------------------------------------
// Validation (§15, §26)
// ---------------------------------------------------------------------------

interface Prepared {
  activeThemeIds: string[];
  activeQuestions: Question[];
  questionsByTheme: Map<string, Question[]>;
  /** Integer weight units per theme; the unit cancels in the final ratio. */
  themeUnits: Map<string, number>;
  /** Integer weight per question, already scaled by the lcm multiplier. */
  questionWeight: Map<string, number>;
  answerByQuestion: Map<string, UserAnswer>;
  answeredQuestionIds: Set<string>;
}

function prepare(input: MatchingInput): Prepared {
  const activeThemes = input.themes
    .filter((t) => t.active)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const activeThemeIds = activeThemes.map((t) => t.id);
  const activeThemeIdSet = new Set(activeThemeIds);

  const activeQuestions = input.questions
    .filter((q) => q.active && activeThemeIdSet.has(q.themeId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (activeQuestions.length === 0) {
    throw new MatchingValidationError('EMPTY_QUESTIONNAIRE', 'questions');
  }

  const questionsByTheme = new Map<string, Question[]>();
  for (const themeId of activeThemeIds) questionsByTheme.set(themeId, []);
  for (const q of activeQuestions) {
    questionsByTheme.get(q.themeId)!.push(q);
  }

  // A theme with no active question cannot receive a question weight. It is
  // dropped rather than treated as weight-zero, so that the lcm below is not
  // computed over a zero.
  const scoringThemeIds = activeThemeIds.filter(
    (id) => (questionsByTheme.get(id) ?? []).length > 0,
  );

  // --- theme weights -------------------------------------------------------
  const themeUnits = new Map<string, number>();

  if (input.themeWeights === undefined) {
    // §15: the equal-weight default is applied explicitly, and with one unit
    // per theme rather than 10000/n basis points — 10000 does not divide
    // evenly by every theme count, and a 3333/3333/3334 split would not be
    // equal. The unit cancels in the final ratio, so this is exact.
    for (const id of scoringThemeIds) themeUnits.set(id, 1);
  } else {
    const seen = new Set<string>();
    let sum = 0;

    for (const [i, tw] of input.themeWeights.entries()) {
      const field = `themeWeights[${i}]`;
      if (!activeThemeIdSet.has(tw.themeId)) {
        throw new MatchingValidationError(
          input.themes.some((t) => t.id === tw.themeId)
            ? 'INACTIVE_THEME'
            : 'UNKNOWN_THEME',
          field,
        );
      }
      if (seen.has(tw.themeId)) {
        throw new MatchingValidationError('DUPLICATE_THEME_WEIGHT', field);
      }
      if (!Number.isInteger(tw.weightBp)) {
        throw new MatchingValidationError('WEIGHT_GRANULARITY', field);
      }
      if (tw.weightBp < 0) {
        throw new MatchingValidationError('NEGATIVE_THEME_WEIGHT', field);
      }
      seen.add(tw.themeId);
      sum += tw.weightBp;
    }

    for (const id of activeThemeIds) {
      if (!seen.has(id)) {
        throw new MatchingValidationError('MISSING_THEME_WEIGHT', 'themeWeights');
      }
    }
    // §15: tolerance is zero.
    if (sum !== TOTAL_WEIGHT_BP) {
      throw new MatchingValidationError('THEME_WEIGHT_SUM', 'themeWeights');
    }

    for (const tw of input.themeWeights) {
      if (scoringThemeIds.includes(tw.themeId)) {
        themeUnits.set(tw.themeId, tw.weightBp);
      }
    }
  }

  // --- question weights ----------------------------------------------------
  const counts = scoringThemeIds.map((id) => questionsByTheme.get(id)!.length);
  const multiplier = questionWeightMultiplier(counts);

  const questionWeight = new Map<string, number>();
  for (const themeId of scoringThemeIds) {
    const questions = questionsByTheme.get(themeId)!;
    const units = themeUnits.get(themeId) ?? 0;
    // §21: equal priority must mean equal influence, whatever the question
    // count. This division is exact by construction of the multiplier.
    const weight = (units * multiplier) / questions.length;
    for (const q of questions) questionWeight.set(q.id, weight);
  }

  // --- answers -------------------------------------------------------------
  const questionById = new Map(activeQuestions.map((q) => [q.id, q]));
  const allQuestionIds = new Set(input.questions.map((q) => q.id));
  const answerByQuestion = new Map<string, UserAnswer>();
  const answeredQuestionIds = new Set<string>();

  for (const [i, answer] of input.answers.entries()) {
    const field = `answers[${i}]`;
    if (!questionById.has(answer.questionId)) {
      throw new MatchingValidationError(
        allQuestionIds.has(answer.questionId)
          ? 'INACTIVE_QUESTION'
          : 'UNKNOWN_QUESTION',
        field,
      );
    }
    if (answerByQuestion.has(answer.questionId)) {
      throw new MatchingValidationError('DUPLICATE_ANSWER', field);
    }
    if (answer.kind === 'answered') {
      const v = answer.value as number;
      if (!Number.isInteger(v) || v < SCALE_MIN || v > SCALE_MAX) {
        throw new MatchingValidationError('INVALID_ANSWER_VALUE', field);
      }
      answeredQuestionIds.add(answer.questionId);
    }
    answerByQuestion.set(answer.questionId, answer);
  }

  return {
    activeThemeIds: scoringThemeIds,
    activeQuestions,
    questionsByTheme,
    themeUnits,
    questionWeight,
    answerByQuestion,
    answeredQuestionIds,
  };
}

// ---------------------------------------------------------------------------
// Scoring (§21)
// ---------------------------------------------------------------------------

/**
 * Rounds `SCORE_SCALE * numerator / denominator` to the nearest integer, half
 * away from zero, using integer arithmetic only. Both arguments are
 * non-negative here.
 */
function scaledRound(numerator: number, denominator: number): number {
  return Math.floor((2 * SCORE_SCALE * numerator + denominator) / (2 * denominator));
}

interface CandidateAccumulator {
  numerator: number;
  weightSum: number;
  documented: number;
  used: number;
  byTheme: Map<string, { numerator: number; weightSum: number; documented: number }>;
}

function scoreCandidate(
  candidate: Candidate,
  prepared: Prepared,
  positionsFor: Map<string, CandidatePosition>,
): CandidateResult {
  const acc: CandidateAccumulator = {
    numerator: 0,
    weightSum: 0,
    documented: 0,
    used: 0,
    byTheme: new Map(),
  };

  for (const themeId of prepared.activeThemeIds) {
    acc.byTheme.set(themeId, { numerator: 0, weightSum: 0, documented: 0 });
  }

  // Iteration follows `activeQuestions`, which is sorted by id. Integer
  // arithmetic makes the order irrelevant to the result; it is fixed anyway so
  // that intermediate values are reproducible when debugging.
  for (const question of prepared.activeQuestions) {
    const answer = prepared.answerByQuestion.get(question.id);
    if (answer === undefined || answer.kind === 'skipped') continue;

    const position = positionsFor.get(question.id);
    // §42, §43: only `confirmed` positions are scored. `uncertain` and
    // `not_available` are excluded and count as undocumented.
    if (position === undefined || position.status !== 'confirmed') continue;

    acc.documented += 1;
    const themeAcc = acc.byTheme.get(question.themeId)!;
    themeAcc.documented += 1;

    const weight = prepared.questionWeight.get(question.id) ?? 0;
    // A theme weighted 0 contributes nothing to either side of the ratio, so
    // it is removed from the calculation exactly as §15 requires.
    if (weight === 0) continue;

    // s_q = MAX_DISTANCE - |answer - position|, an integer in [0, 4].
    const distance = Math.abs(answer.value - position.position);
    const s = MAX_DISTANCE - distance;

    acc.numerator += s * weight;
    acc.weightSum += weight;
    acc.used += 1;

    themeAcc.numerator += s * weight;
    themeAcc.weightSum += weight;
  }

  if (acc.numerator > MAX_SAFE_NUMERATOR) {
    // Unreachable at the scale of a real election; a loud failure is better
    // than a silently inexact score.
    throw new RangeError('matching numerator exceeds exact integer range');
  }

  const themes: ThemeBreakdown[] = prepared.activeThemeIds.map((themeId) => {
    const t = acc.byTheme.get(themeId)!;
    const denominator = MAX_DISTANCE * t.weightSum;
    return {
      themeId,
      scoreMilli: denominator === 0 ? null : scaledRound(t.numerator, denominator),
      weightBp: prepared.themeUnits.get(themeId) ?? 0,
      answered: countAnsweredInTheme(prepared, themeId),
      documented: t.documented,
    };
  });

  const coverage: Coverage = {
    answered: prepared.answeredQuestionIds.size,
    documented: acc.documented,
    used: acc.used,
    byTheme: prepared.activeThemeIds.map<ThemeCoverage>((themeId) => ({
      themeId,
      answered: countAnsweredInTheme(prepared, themeId),
      documented: acc.byTheme.get(themeId)!.documented,
    })),
  };

  // §15, §43: no usable question means no score. Never 0, never a division by
  // zero. The two reasons are distinguished so the UI can say which it is.
  if (acc.weightSum === 0) {
    return {
      candidateId: candidate.id,
      comparable: false,
      reason: acc.documented === 0 ? 'no_documented_position' : 'no_usable_question',
      coverage,
      themes,
    };
  }

  const denominator = MAX_DISTANCE * acc.weightSum;

  return {
    candidateId: candidate.id,
    comparable: true,
    rank: 0, // assigned after sorting
    scoreMilli: scaledRound(acc.numerator, denominator),
    coverage,
    themes,
  };
}

function countAnsweredInTheme(prepared: Prepared, themeId: string): number {
  let n = 0;
  for (const q of prepared.questionsByTheme.get(themeId) ?? []) {
    if (prepared.answeredQuestionIds.has(q.id)) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeMatching(input: MatchingInput): MatchingResult {
  const prepared = prepare(input);

  const positionsByCandidate = new Map<string, Map<string, CandidatePosition>>();
  for (const candidate of input.candidates) {
    positionsByCandidate.set(candidate.id, new Map());
  }
  for (const position of input.positions) {
    positionsByCandidate.get(position.candidateId)?.set(position.questionId, position);
  }

  const candidateById = new Map(input.candidates.map((c) => [c.id, c]));

  const results = input.candidates.map((candidate) =>
    scoreCandidate(candidate, prepared, positionsByCandidate.get(candidate.id)!),
  );

  const comparable = results.filter(
    (r): r is Extract<CandidateResult, { comparable: true }> => r.comparable,
  );
  const notComparable = results.filter((r) => !r.comparable);

  // §24: descending score, then alphabetical on normalizedName within a tie.
  // The candidate id is never consulted.
  comparable.sort((a, b) => {
    if (a.scoreMilli !== b.scoreMilli) return b.scoreMilli - a.scoreMilli;
    return compareNormalizedName(
      candidateById.get(a.candidateId)!,
      candidateById.get(b.candidateId)!,
    );
  });

  const ranks = assignRanks(comparable, (r) => r.scoreMilli);
  comparable.forEach((result, i) => {
    result.rank = ranks[i];
  });

  // §24: candidates without a score are listed after the scored ones, never
  // omitted. Among themselves they keep the neutral default order.
  notComparable.sort((a, b) =>
    compareNormalizedName(
      candidateById.get(a.candidateId)!,
      candidateById.get(b.candidateId)!,
    ),
  );

  const programVersions = [
    ...new Set(input.positions.map((p) => p.programVersionId)),
  ].sort();

  return {
    engineVersion: ENGINE_VERSION,
    electionId: input.electionId,
    programVersions,
    results: [...comparable, ...notComparable],
  };
}
