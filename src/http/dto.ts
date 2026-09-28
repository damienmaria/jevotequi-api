/**
 * Wire format for the API.
 *
 * The JSON uses snake_case, matching the shape documented in guideline §21 and
 * the political data files. The domain stays camelCase; this module is the only
 * place the two meet.
 */

import { z } from 'zod';

import type { CandidateResult, MatchingResult, UserAnswer } from '../domain/types';

export const matchingRequestSchema = z.object({
  election_id: z.string().min(1),
  answers: z
    .array(
      z.union([
        z.object({
          question_id: z.string().min(1),
          value: z.number().int().min(-2).max(2),
        }),
        z.object({
          question_id: z.string().min(1),
          skipped: z.literal(true),
        }),
      ]),
    )
    .min(1),
  theme_weights: z
    .array(
      z.object({
        theme_id: z.string().min(1),
        weight_bp: z.number().int(),
      }),
    )
    .optional(),
});

export type MatchingRequest = z.infer<typeof matchingRequestSchema>;

export function toDomainAnswers(request: MatchingRequest): UserAnswer[] {
  return request.answers.map((a) =>
    'skipped' in a
      ? { questionId: a.question_id, kind: 'skipped' as const }
      : { questionId: a.question_id, kind: 'answered' as const, value: a.value as -2 | -1 | 0 | 1 | 2 },
  );
}

function presentResult(result: CandidateResult) {
  const common = {
    candidate_id: result.candidateId,
    coverage: {
      answered: result.coverage.answered,
      documented: result.coverage.documented,
      used: result.coverage.used,
      by_theme: result.coverage.byTheme.map((t) => ({
        theme_id: t.themeId,
        answered: t.answered,
        documented: t.documented,
      })),
    },
    themes: result.themes.map((t) => ({
      theme_id: t.themeId,
      score_milli: t.scoreMilli,
      weight_bp: t.weightBp,
      answered: t.answered,
      documented: t.documented,
    })),
  };

  // §24: a candidate either has a score and a rank, or an explicit reason for
  // having none. The wire format keeps those mutually exclusive so a client
  // cannot render a missing score as zero.
  return result.comparable
    ? { ...common, comparable: true as const, rank: result.rank, score_milli: result.scoreMilli }
    : { ...common, comparable: false as const, reason: result.reason };
}

export function presentMatching(result: MatchingResult) {
  return {
    engine_version: result.engineVersion,
    election_id: result.electionId,
    program_versions: result.programVersions,
    results: result.results.map(presentResult),
  };
}
