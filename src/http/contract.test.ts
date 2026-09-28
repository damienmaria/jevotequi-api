import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { electionsRoot, loadElection } from '../data/load';
import { createApp, type Logger } from './app';

/**
 * The API contract is the only coupling point between the two repositories
 * (§2), so it is the worst place to let documentation drift. These tests fail
 * both ways: a route missing from `openapi.yaml`, and a documented route the
 * app does not serve.
 */

const spec = parse(readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf8'));
const election = loadElection(join(electionsRoot(), 'fr-demo-2027'));
const silent: Logger = { info: () => {}, error: () => {} };
const app = createApp([election], silent);

/** Express path template (`/a/:id`) → OpenAPI template (`/a/{id}`). */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function registeredRoutes(): Set<string> {
  // Express 5 exposes the router as `app.router`; Express 4 as `app._router`.
  const router =
    (app as unknown as { router?: { stack: unknown[] } }).router ??
    (app as unknown as { _router?: { stack: unknown[] } })._router;

  const found = new Set<string>();
  for (const layer of (router?.stack ?? []) as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      found.add(`${method.toUpperCase()} ${toOpenApiPath(layer.route.path)}`);
    }
  }
  return found;
}

function documentedRoutes(): Set<string> {
  const found = new Set<string>();
  for (const [path, operations] of Object.entries(spec.paths as Record<string, object>)) {
    for (const method of Object.keys(operations)) {
      found.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

describe('openapi.yaml matches the app (§2, §25)', () => {
  it('documents every route the app serves', () => {
    const undocumented = [...registeredRoutes()].filter((r) => !documentedRoutes().has(r));
    expect(undocumented).toEqual([]);
  });

  it('serves every route it documents', () => {
    const unserved = [...documentedRoutes()].filter((r) => !registeredRoutes().has(r));
    expect(unserved).toEqual([]);
  });

  it('is versioned, and every API route sits under that version', () => {
    const apiRoutes = [...documentedRoutes()].filter((r) => r.includes('/api/'));
    expect(apiRoutes.length).toBeGreaterThan(0);
    for (const route of apiRoutes) {
      expect(route).toContain('/api/v1/');
    }
  });
});

describe('the documented invariants hold on a real response (§21, §43)', () => {
  const answers = election.questions
    .filter((q) => q.active)
    .map((q) => ({ question_id: q.id, value: 1 }));

  it('returns score_milli as an integer in [0, 1000], with a rank', async () => {
    const response = await request(app)
      .post('/api/v1/matching')
      .send({ election_id: election.election.id, answers });

    const comparable = response.body.results.filter((r: { comparable: boolean }) => r.comparable);
    expect(comparable.length).toBeGreaterThan(0);

    for (const result of comparable) {
      expect(Number.isInteger(result.score_milli)).toBe(true);
      expect(result.score_milli).toBeGreaterThanOrEqual(0);
      expect(result.score_milli).toBeLessThanOrEqual(1000);
      expect(result.rank).toBeGreaterThanOrEqual(1);
    }
  });

  it('never returns a score without a coverage', async () => {
    const response = await request(app)
      .post('/api/v1/matching')
      .send({ election_id: election.election.id, answers });

    for (const result of response.body.results) {
      expect(result.coverage).toBeDefined();
      expect(Number.isInteger(result.coverage.documented)).toBe(true);
      // The two are mutually exclusive: a client cannot read a missing score
      // as zero.
      expect(result.comparable).toBe(result.score_milli !== undefined);
    }
  });

  it('returns results already ordered, ranks non-decreasing', async () => {
    const response = await request(app)
      .post('/api/v1/matching')
      .send({ election_id: election.election.id, answers });

    const comparable = response.body.results.filter((r: { comparable: boolean }) => r.comparable);
    for (let i = 1; i < comparable.length; i += 1) {
      expect(comparable[i].score_milli).toBeLessThanOrEqual(comparable[i - 1].score_milli);
      expect(comparable[i].rank).toBeGreaterThanOrEqual(comparable[i - 1].rank);
    }

    // Not-comparable candidates come last, never interleaved.
    const firstNotComparable = response.body.results.findIndex(
      (r: { comparable: boolean }) => !r.comparable,
    );
    if (firstNotComparable !== -1) {
      const tail = response.body.results.slice(firstNotComparable);
      expect(tail.every((r: { comparable: boolean }) => !r.comparable)).toBe(true);
    }
  });

  it('rejects theme weights that do not sum to 10000, naming the field only', async () => {
    const themes = election.themes.filter((t) => t.active);
    const response = await request(app)
      .post('/api/v1/matching')
      .send({
        election_id: election.election.id,
        answers,
        theme_weights: themes.map((t, i) => ({
          theme_id: t.id,
          weight_bp: i === 0 ? 1_250 : 1_249,
        })),
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('THEME_WEIGHT_SUM');
    expect(JSON.stringify(response.body)).not.toContain('1249');
  });
});
