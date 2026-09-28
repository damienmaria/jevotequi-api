/**
 * §26: validation errors must never echo the submitted answers back.
 *
 * The error carries a stable machine code and a field path, never a value
 * taken from the request body. This is enforced by the shape of the type: there
 * is nowhere to put a value.
 */
export type ValidationCode =
  | 'UNKNOWN_ELECTION'
  | 'UNKNOWN_QUESTION'
  | 'INACTIVE_QUESTION'
  | 'DUPLICATE_ANSWER'
  | 'INVALID_ANSWER_VALUE'
  | 'UNKNOWN_THEME'
  | 'INACTIVE_THEME'
  | 'DUPLICATE_THEME_WEIGHT'
  | 'MISSING_THEME_WEIGHT'
  | 'NEGATIVE_THEME_WEIGHT'
  | 'THEME_WEIGHT_SUM'
  | 'EMPTY_QUESTIONNAIRE'
  | 'WEIGHT_GRANULARITY';

export class MatchingValidationError extends Error {
  constructor(
    readonly code: ValidationCode,
    readonly field: string,
  ) {
    // The message is built from the code and the field only. No user data.
    super(`${code} at ${field}`);
    this.name = 'MatchingValidationError';
  }
}
