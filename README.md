# jevotequi-api

Political data, matching engine and business rules.

The rules this code implements live in
[`jevotequi-docs/guideline/guideline-ai.md`](../jevotequi-docs/guideline/guideline-ai.md).
Section references in comments (§21, §43…) point there. Read §21, §24, §32 and
§43 before changing anything under `src/matching` or `src/http`.

## Run

```bash
npm ci
npm start          # http://localhost:3001
npm test
npm run validate:data
```

No database is required to run the API: political data is loaded from
`data/elections/` at startup (ADR 0003). PostgreSQL is for the read model and
is not yet wired in.

## Layout

```text
src/domain/types.ts     domain types and the constants of the answer scale
src/matching/engine.ts  the matching engine — pure, integer arithmetic, no imports
                        from the framework, the database or the environment
src/matching/ordering.ts ordering and tie rules (§24)
src/data/               political data loading and cross-file validation
src/http/app.ts         the HTTP pipeline
src/http/redaction.ts   the §32 / §47 privacy guarantee
data/elections/         the political data itself, versioned (ADR 0003)
prisma/                 read-model schema, plus the constraints Prisma cannot express
```

## Three things that are easy to break

**The score is an integer.** `score_milli` is in tenths of a percent, in
`[0, 1000]`. Ranking and ties are decided on it. Do not convert it to a float
and do not re-round it downstream (§21).

**A missing position is not a neutral position.** It is excluded and lowers the
coverage. A score must never be displayed without its coverage (§43). The API
returns them together for that reason.

**The matching payload must never be logged.** Not in an access log, not in an
error, not in a stack trace. `src/http/redaction.ts` enforces it and
`src/http/privacy.test.ts` proves it, including on the unexpected-error path.
If you add middleware upstream of the matching route, add a case to that test.
