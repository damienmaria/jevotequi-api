import { join } from 'node:path';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { electionsRoot, loadElection } from '../data/load';
import { createApp, type Logger } from './app';

/**
 * §35, privacy regression tests. These exist because §32 is a legal constraint
 * and §47 requires it to be tested rather than asserted: the default behaviour
 * of most frameworks is to log the request body on error.
 *
 * The rule under test: no answer value may appear in any log line produced
 * while handling `POST /api/v1/matching`.
 */

const election = loadElection(join(electionsRoot(), 'fr-demo-2027'));

function appWithCapturedLogs() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (entry) => lines.push(JSON.stringify(entry)),
    error: (entry) => lines.push(JSON.stringify(entry)),
  };
  return { app: createApp([election], logger), lines };
}

/**
 * A payload whose answer values are individually recognisable, so that a leak
 * is detectable no matter which field it escapes through.
 */
const MARKER_QUESTION = 'imm-1';
const MARKER_VALUE = -2;

function markedAnswers() {
  return election.questions
    .filter((q) => q.active)
    .map((q) => ({
      question_id: q.id,
      value: q.id === MARKER_QUESTION ? MARKER_VALUE : 1,
    }));
}

function assertNoAnswersLeaked(lines: string[]) {
  const joined = lines.join('\n');
  // The question id alone is public; the pairing of a question with a value is
  // what reveals an opinion. Both the serialized pair and the raw answers array
  // must be absent.
  expect(joined).not.toContain(`"question_id":"${MARKER_QUESTION}"`);
  expect(joined).not.toContain('"answers"');
  expect(joined).not.toContain('"theme_weights"');
  expect(joined).not.toContain(`"value":${MARKER_VALUE}`);
}

describe('POST /api/v1/matching never logs the payload (§32, §47)', () => {
  it('does not log answers on a successful request', async () => {
    const { app, lines } = appWithCapturedLogs();

    const response = await request(app)
      .post('/api/v1/matching')
      .send({ election_id: election.election.id, answers: markedAnswers() });

    expect(response.status).toBe(200);
    expect(lines.length).toBeGreaterThan(0); // the access log did run
    assertNoAnswersLeaked(lines);
  });

  it('does not log answers on a validation error', async () => {
    const { app, lines } = appWithCapturedLogs();

    const response = await request(app)
      .post('/api/v1/matching')
      .send({
        election_id: election.election.id,
        answers: [{ question_id: MARKER_QUESTION, value: MARKER_VALUE }],
        theme_weights: [{ theme_id: 'economie', weight_bp: 9_999 }],
      });

    expect(response.status).toBe(400);
    assertNoAnswersLeaked(lines);
  });

  it('does not log answers when the handler throws unexpectedly', async () => {
    // §47 is explicit that redaction must be active, not a consequence of
    // there being no logging call. The only way to test that is to force the
    // error path that a framework would normally use to log the body.
    const { app, lines } = appWithCapturedLogs();

    const engine = await import('../matching/engine');
    const spy = vi.spyOn(engine, 'computeMatching').mockImplementation(() => {
      throw new Error('boom');
    });

    try {
      const response = await request(app)
        .post('/api/v1/matching')
        .send({ election_id: election.election.id, answers: markedAnswers() });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR' } });
      assertNoAnswersLeaked(lines);
      // The error message itself is replaced, not filtered.
      expect(lines.join('\n')).toContain('[redacted:');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not echo submitted values back in an error response (§26)', async () => {
    const { app } = appWithCapturedLogs();

    const response = await request(app)
      .post('/api/v1/matching')
      .send({
        election_id: election.election.id,
        answers: [{ question_id: MARKER_QUESTION, value: 99 }],
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('99');
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('marks the matching response no-store (§32, §48)', async () => {
    const { app } = appWithCapturedLogs();

    const response = await request(app)
      .post('/api/v1/matching')
      .send({ election_id: election.election.id, answers: markedAnswers() });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('still logs the body of a non-sensitive route, so the test is meaningful', async () => {
    // A redaction test passes trivially if nothing is ever logged. This asserts
    // the logger does capture bodies elsewhere.
    const { app, lines } = appWithCapturedLogs();
    await request(app).post('/api/v1/elections').send({ probe: 'visible' });
    expect(lines.join('\n')).toContain('visible');
  });
});

describe('read routes (§24, §44)', () => {
  it('serves candidates in the official order, not insertion order', async () => {
    const { app } = appWithCapturedLogs();
    const response = await request(app).get(
      `/api/v1/elections/${election.election.id}/candidates`,
    );

    expect(response.status).toBe(200);
    expect(response.body.candidates.map((c: { id: string }) => c.id)).toEqual([
      'noe-fontaine', // official_order 1
      'camille-aubert', // 2
      'sacha-moreau', // 3
      'dominique-leroy', // 4
    ]);
  });

  it('serves the inclusion criterion with the election (§9)', async () => {
    const { app } = appWithCapturedLogs();
    const response = await request(app).get(`/api/v1/elections/${election.election.id}`);

    expect(response.body.inclusion_criterion.rule).toBeTruthy();
    expect(response.body.inclusion_criterion.published).toBe(true);
  });

  it('returns a rank and a coverage for every comparable candidate (§21, §43)', async () => {
    const { app } = appWithCapturedLogs();
    const response = await request(app)
      .post('/api/v1/matching')
      .send({ election_id: election.election.id, answers: markedAnswers() });

    for (const result of response.body.results) {
      expect(result.coverage).toBeDefined();
      if (result.comparable) {
        expect(result.rank).toBeGreaterThan(0);
        expect(result.score_milli).toBeGreaterThanOrEqual(0);
        expect(result.score_milli).toBeLessThanOrEqual(1000);
      } else {
        expect(result.score_milli).toBeUndefined();
        expect(result.reason).toBeTruthy();
      }
    }
  });

  it('keeps the health endpoint free of political data (§47)', async () => {
    const { app } = appWithCapturedLogs();
    const response = await request(app).get('/health');
    expect(response.body).toEqual({ status: 'ok' });
  });
});
