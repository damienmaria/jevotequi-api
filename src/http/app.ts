/**
 * HTTP layer.
 *
 * Built on Express directly rather than through Nest decorators so that the
 * request pipeline stays visible: §32 and §47 depend on exactly which pieces of
 * middleware can see the matching payload, and that is easier to audit — and to
 * test — when the pipeline is written out.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { computeMatching } from '../matching/engine';
import { MatchingValidationError } from '../matching/errors';
import type { LoadedElection } from '../data/load';
import { matchingRequestSchema, presentMatching, toDomainAnswers } from './dto';
import { isSensitiveRoute, safeErrorForLog, safeRequestContext } from './redaction';

export interface Logger {
  info(entry: unknown): void;
  error(entry: unknown): void;
}

export const consoleLogger: Logger = {
  info: (entry) => console.log(JSON.stringify(entry)),
  error: (entry) => console.error(JSON.stringify(entry)),
};

export function createApp(elections: LoadedElection[], logger: Logger = consoleLogger): Express {
  const app = express();
  const byId = new Map(elections.map((e) => [e.election.id, e]));

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Access log. It goes through `safeRequestContext`, which drops the body of
  // a sensitive route entirely (§47).
  app.use((req, _res, next) => {
    logger.info({ at: 'request', ...safeRequestContext(req) });
    next();
  });

  // §47: the health endpoint exposes no political data version, no counts and
  // no configuration.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/v1/elections', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      elections: elections.map((e) => ({
        id: e.election.id,
        slug: e.election.slug,
        name: e.election.name,
        country: e.election.country,
        election_type: e.election.election_type,
        election_date: e.election.election_date,
        status: e.election.status,
        fictional: e.election.fictional,
      })),
    });
  });

  app.get('/api/v1/elections/:id', (req, res) => {
    const election = byId.get(req.params.id);
    if (!election) return notFound(res, 'UNKNOWN_ELECTION');

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      id: election.election.id,
      name: election.election.name,
      election_date: election.election.election_date,
      status: election.election.status,
      fictional: election.election.fictional,
      // §9, §44: the inclusion criterion travels with the election, so a
      // client cannot display candidates without being able to say how they
      // were chosen.
      inclusion_criterion: election.election.inclusion_criterion,
      answer_scale: election.election.answer_scale,
    });
  });

  app.get('/api/v1/elections/:id/themes', (req, res) => {
    const election = byId.get(req.params.id);
    if (!election) return notFound(res, 'UNKNOWN_ELECTION');

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      themes: election.themes
        .filter((t) => t.active)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((t) => ({ id: t.id, name: t.name, display_order: t.displayOrder })),
    });
  });

  app.get('/api/v1/elections/:id/questions', (req, res) => {
    const election = byId.get(req.params.id);
    if (!election) return notFound(res, 'UNKNOWN_ELECTION');

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      questions: election.questions
        .filter((q) => q.active)
        .map((q) => ({
          id: q.id,
          theme_id: q.themeId,
          text: q.text,
          display_order: q.displayOrder,
        })),
    });
  });

  app.get('/api/v1/elections/:id/candidates', (req, res) => {
    const election = byId.get(req.params.id);
    if (!election) return notFound(res, 'UNKNOWN_ELECTION');

    // §24: the default order outside the results is the official order, with
    // an alphabetical fallback. The API serves it already ordered so the
    // client has nothing to decide.
    const ordered = [...election.candidates].sort((a, b) => {
      const aHas = a.officialOrder !== null;
      const bHas = b.officialOrder !== null;
      if (aHas && bHas && a.officialOrder !== b.officialOrder) {
        return (a.officialOrder as number) - (b.officialOrder as number);
      }
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.normalizedName < b.normalizedName ? -1 : 1;
    });

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      candidates: ordered.map((c) => ({
        id: c.id,
        display_name: c.displayName,
        official_order: c.officialOrder,
        inclusion_status: c.inclusionStatus,
      })),
    });
  });

  app.post('/api/v1/matching', (req, res) => {
    // §32: never cached, at any layer.
    res.set('Cache-Control', 'no-store');

    const parsed = matchingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // §26: the error names the field, never the submitted value.
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: { code: 'INVALID_REQUEST', field: issue.path.join('.') },
      });
    }

    const election = byId.get(parsed.data.election_id);
    if (!election) return notFound(res, 'UNKNOWN_ELECTION');

    try {
      const result = computeMatching({
        electionId: election.election.id,
        themes: election.themes,
        questions: election.questions,
        candidates: election.candidates,
        positions: election.positions,
        answers: toDomainAnswers(parsed.data),
        themeWeights: parsed.data.theme_weights?.map((w) => ({
          themeId: w.theme_id,
          weightBp: w.weight_bp,
        })),
      });

      // Nothing is persisted. The result is computed in memory and returned.
      return res.json(presentMatching(result));
    } catch (error) {
      if (error instanceof MatchingValidationError) {
        return res.status(400).json({ error: { code: error.code, field: error.field } });
      }
      throw error;
    }
  });

  app.use((_req, res) => notFound(res, 'NOT_FOUND'));

  // Error handler. §47: it redacts explicitly rather than relying on there
  // being no logging call downstream.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const path = req.path ?? req.url ?? '';
    logger.error({
      at: 'error',
      ...safeRequestContext(req),
      error: safeErrorForLog(error, path),
    });

    const status = isJsonParseError(error) ? 400 : 500;
    res.status(status).json({
      error: { code: status === 400 ? 'MALFORMED_JSON' : 'INTERNAL_ERROR' },
    });
  });

  return app;
}

function notFound(res: Response, code: string) {
  return res.status(404).json({ error: { code } });
}

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as { status?: number }).status === 400
  );
}

export { isSensitiveRoute };
