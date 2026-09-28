/**
 * Schemas for the political data files (ADR 0003).
 *
 * These run in CI, so a violation fails the merge request before the data ever
 * reaches a database. §16's "a position must never exist without a source" is
 * enforced here, where it is expressible, rather than only as a trigger.
 */

import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case identifier');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase sha-256 hex digest');

/** §13: the answer scale, shared by user answers and candidate positions. */
const scaleValue = z.number().int().min(-2).max(2);

export const themeSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().min(1),
  display_order: z.number().int().positive(),
  active: z.boolean(),
});

/** §12: the four neutrality tests, all of them, recorded per question. */
const NEUTRALITY_TESTS = ['symmetry', 'vocabulary', 'single_issue', 'answerability'] as const;

export const questionSchema = z.object({
  id,
  theme_id: id,
  display_order: z.number().int().positive(),
  text: z.string().min(1),
  active: z.boolean(),
  neutrality_review: z.object({
    by: z.string().min(1),
    date: isoDate,
    tests: z
      .array(z.enum(NEUTRALITY_TESTS))
      .refine(
        (tests) => NEUTRALITY_TESTS.every((t) => tests.includes(t)),
        'all four neutrality tests of §12 must be recorded',
      ),
    public_review_mr: z.union([z.number().int().positive(), z.null()]),
  }),
});

export const candidateSchema = z.object({
  id,
  election_id: id,
  display_name: z.string().min(1),
  normalized_name: z
    .string()
    .regex(
      /^[a-z0-9 '-]+$/,
      'lowercase, diacritics stripped: ordering must not depend on locale data (§24)',
    ),
  political_group: z.string().min(1),
  official_order: z.union([z.number().int().positive(), z.null()]),
  inclusion_status: z.enum(['included', 'listed_without_data']),
});

export const electionSchema = z.object({
  id,
  slug: id,
  name: z.string().min(1),
  country: z.string().length(2),
  election_type: z.string().min(1),
  election_date: isoDate,
  status: z.enum(['draft', 'open', 'closed']),
  fictional: z.boolean().default(false),
  inclusion_criterion: z.object({
    rule: z.string().min(1),
    decided_on: isoDate,
    published: z.boolean(),
    note: z.string().optional(),
  }),
  answer_scale: z.object({
    min: z.literal(-2),
    max: z.literal(2),
    labels: z.record(z.string(), z.string()),
    skip_label: z.string().min(1),
  }),
});

export const sourceSchema = z.object({
  id,
  title: z.string().min(1),
  url: z.string().url(),
  source_type: z.enum([
    'official_program',
    'party_program',
    'official_website',
    'policy_document',
    'interview',
    'speech',
    'debate',
    'policy_proposal',
    'secondary',
  ]),
  published_at: isoDate,
  retrieved_at: isoDate,
  content_hash: sha256,
  // §17: campaign material disappears; a published position must stay
  // verifiable after the election.
  archived_copy_url: z.string().url(),
});

const positionSourceRef = z.object({
  source_id: id,
  locator: z.string().min(1).optional(),
});

export const positionSchema = z
  .object({
    question_id: id,
    position: scaleValue,
    status: z.enum(['confirmed', 'uncertain', 'not_available']),
    // §14: the passage that justifies the value.
    quote: z.string().min(1),
    note: z.string().optional(),
    // §16: at least one source. Not a convention — the array cannot be empty.
    sources: z.array(positionSourceRef).min(1, 'a position must never exist without a source (§16)'),
    coded_by: z.string().min(1),
    coded_at: isoDate,
    reviewed_by: z.union([z.string().min(1), z.null()]),
    reviewed_at: isoDate.optional(),
    valid_from: isoDate,
    valid_until: z.union([isoDate, z.null()]).optional(),
  })
  .refine(
    // §14 degraded mode: a position coded by one person is born `uncertain`.
    // It becomes `confirmed` only after a second pass, recorded here.
    (p) => p.status !== 'confirmed' || p.reviewed_by !== null,
    { message: 'a confirmed position requires a recorded second pass (§14)', path: ['reviewed_by'] },
  );

export const candidatePositionsFileSchema = z.object({
  candidate_id: id,
  program: z.object({
    id,
    version_id: id,
    title: z.string().min(1),
    published_at: isoDate,
  }),
  sources: z.array(sourceSchema).min(1),
  defaults: z.unknown().optional(), // YAML anchor holder, not part of the data
  positions: z.array(positionSchema).min(1),
});

export type ThemeFile = z.infer<typeof themeSchema>;
export type QuestionFile = z.infer<typeof questionSchema>;
export type CandidateFile = z.infer<typeof candidateSchema>;
export type ElectionFile = z.infer<typeof electionSchema>;
export type CandidatePositionsFile = z.infer<typeof candidatePositionsFileSchema>;
