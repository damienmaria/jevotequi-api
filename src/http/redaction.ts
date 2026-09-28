/**
 * §32 and §47: the body of `POST /api/v1/matching` must never reach a log, at
 * any level, including error logs, stack traces and crash reports.
 *
 * §47 is explicit that this must be an active redaction rather than the mere
 * absence of a logging call, because most frameworks log the request body on
 * error by default. Everything a handler is allowed to log about a sensitive
 * route goes through `safeRequestContext`, which is total: there is no branch
 * that can return a value taken from the body.
 */

/** Routes whose request body carries political opinions (GDPR art. 9). */
const SENSITIVE_ROUTES = [/^\/api\/v\d+\/matching\/?$/];

export function isSensitiveRoute(path: string): boolean {
  const withoutQuery = path.split('?')[0];
  return SENSITIVE_ROUTES.some((pattern) => pattern.test(withoutQuery));
}

export interface SafeRequestContext {
  method: string;
  path: string;
  /** Present only for non-sensitive routes. */
  body?: unknown;
}

/**
 * Builds the only representation of a request that may be logged.
 *
 * For a sensitive route the body is dropped entirely — not masked field by
 * field, which would leak the shape of the answers and break the moment a
 * field is added.
 */
export function safeRequestContext(req: {
  method: string;
  path?: string;
  url?: string;
  body?: unknown;
}): SafeRequestContext {
  const path = req.path ?? req.url ?? '';
  if (isSensitiveRoute(path)) {
    return { method: req.method, path };
  }
  return { method: req.method, path, body: req.body };
}

/**
 * Strips anything that could carry an answer out of an error before it is
 * logged. A validation error built by the domain already contains only a code
 * and a field path (see `MatchingValidationError`), but a third-party error —
 * a JSON parse failure from body-parser, for instance — can embed a fragment
 * of the payload in its message.
 */
export function safeErrorForLog(error: unknown, path: string): {
  name: string;
  message: string;
  stack?: string;
} {
  const err = error instanceof Error ? error : new Error('non-error thrown');

  if (!isSensitiveRoute(path)) {
    return { name: err.name, message: err.message, stack: err.stack };
  }

  // On a sensitive route the message is replaced rather than filtered: a
  // filter has to guess what a payload fragment looks like, and guessing wrong
  // publishes a political opinion.
  return {
    name: err.name,
    message: `[redacted: ${err.name} on a sensitive route]`,
    stack: err.stack
      ?.split('\n')
      .filter((line) => line.trimStart().startsWith('at '))
      .join('\n'),
  };
}
