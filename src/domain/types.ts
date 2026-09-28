/**
 * Domain types shared by the matching engine and the HTTP layer.
 *
 * Guideline references are to jevotequi-docs/guideline/guideline-ai.md.
 */

/** Answer scale of §13. The same scale is used for candidate positions. */
export const SCALE_MIN = -2;
export const SCALE_MAX = 2;

/** §13: max_distance is derived from the scale, not configured separately. */
export const MAX_DISTANCE = SCALE_MAX - SCALE_MIN; // 4

/**
 * §21: lcm(1..8), so that `theme_weight_bp * WEIGHT_LCM / questionCount`
 * stays an integer for any theme holding up to 8 questions.
 */
export const WEIGHT_LCM = 840;

/** §15: theme weights are integers in basis points and sum to exactly this. */
export const TOTAL_WEIGHT_BP = 10_000;

/** §21: scores are integers in tenths of a percent. */
export const SCORE_SCALE = 1_000;

export type ScaleValue = -2 | -1 | 0 | 1 | 2;

/**
 * §42: only `confirmed` positions are scored. `uncertain` and `not_available`
 * are both excluded and both count as undocumented in the coverage (§43).
 */
export type PositionStatus = 'confirmed' | 'uncertain' | 'not_available';

export interface Theme {
  id: string;
  name: string;
  displayOrder: number;
  active: boolean;
}

export interface Question {
  id: string;
  themeId: string;
  text: string;
  displayOrder: number;
  active: boolean;
}

export interface Candidate {
  id: string;
  displayName: string;
  /** §9, §24: used for deterministic alphabetical ordering. */
  normalizedName: string;
  /** §9: order published by the authority; null when none exists. */
  officialOrder: number | null;
  inclusionStatus: 'included' | 'listed_without_data';
}

export interface CandidatePosition {
  candidateId: string;
  questionId: string;
  position: ScaleValue;
  status: PositionStatus;
  programVersionId: string;
}

/**
 * §13: a user either answers on the scale, or skips.
 * A skip is not a neutral answer.
 */
export type UserAnswer = { questionId: string } & (
  | { kind: 'answered'; value: ScaleValue }
  | { kind: 'skipped' }
);

/** §15: integer basis points, summing to exactly TOTAL_WEIGHT_BP. */
export interface ThemeWeight {
  themeId: string;
  weightBp: number;
}

export interface MatchingInput {
  electionId: string;
  themes: Theme[];
  questions: Question[];
  candidates: Candidate[];
  positions: CandidatePosition[];
  answers: UserAnswer[];
  /** §15: absent means equal weights, applied explicitly by the engine. */
  themeWeights?: ThemeWeight[];
}

/** §43: coverage travels with the score and is never optional. */
export interface Coverage {
  /** Questions the user answered (skips excluded). */
  answered: number;
  /** Of those, how many the candidate has a `confirmed` position for. */
  documented: number;
  /** Of those, how many carried non-zero weight and entered the calculation. */
  used: number;
  /** Per-theme detail, for the "incomplete themes" line of §43. */
  byTheme: ThemeCoverage[];
}

export interface ThemeCoverage {
  themeId: string;
  answered: number;
  documented: number;
}

export interface ThemeBreakdown {
  themeId: string;
  /** null when no usable question remained in this theme (§43). */
  scoreMilli: number | null;
  weightBp: number;
  answered: number;
  documented: number;
}

/**
 * §24: a candidate either has a score and a rank, or is explicitly not
 * comparable. There is no third state, and never a score of 0 standing in for
 * missing data.
 */
export type CandidateResult =
  | {
      candidateId: string;
      comparable: true;
      rank: number;
      scoreMilli: number;
      coverage: Coverage;
      themes: ThemeBreakdown[];
    }
  | {
      candidateId: string;
      comparable: false;
      reason: 'no_documented_position' | 'no_usable_question';
      coverage: Coverage;
      themes: ThemeBreakdown[];
    };

export interface MatchingResult {
  engineVersion: string;
  electionId: string;
  programVersions: string[];
  results: CandidateResult[];
}
