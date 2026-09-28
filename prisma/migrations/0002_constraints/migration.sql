-- Guideline §27: invariants Prisma cannot express.
--
-- Run after the generated schema migration.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- §20: validity intervals are half-open — valid_from inclusive, valid_until
-- exclusive — and two positions for the same (candidate, question) must never
-- overlap. A generated range column plus an EXCLUDE constraint expresses this
-- exactly; the application cannot bypass it.
ALTER TABLE candidate_position
  ADD COLUMN IF NOT EXISTS validity daterange
  GENERATED ALWAYS AS (daterange(valid_from, valid_until, '[)')) STORED;

ALTER TABLE candidate_position
  DROP CONSTRAINT IF EXISTS candidate_position_no_overlap;

ALTER TABLE candidate_position
  ADD CONSTRAINT candidate_position_no_overlap
  EXCLUDE USING gist (
    candidate_id WITH =,
    question_id  WITH =,
    validity     WITH &&
  );

-- §13: the answer scale bounds the stored position.
ALTER TABLE candidate_position
  DROP CONSTRAINT IF EXISTS candidate_position_scale;

ALTER TABLE candidate_position
  ADD CONSTRAINT candidate_position_scale
  CHECK (position BETWEEN -2 AND 2);

ALTER TABLE candidate_position
  DROP CONSTRAINT IF EXISTS candidate_position_status;

ALTER TABLE candidate_position
  ADD CONSTRAINT candidate_position_status
  CHECK (status IN ('confirmed', 'uncertain', 'not_available'));

-- §14 degraded mode: a confirmed position requires a recorded second pass.
ALTER TABLE candidate_position
  DROP CONSTRAINT IF EXISTS candidate_position_confirmed_needs_review;

ALTER TABLE candidate_position
  ADD CONSTRAINT candidate_position_confirmed_needs_review
  CHECK (status <> 'confirmed' OR reviewed_by IS NOT NULL);

-- §16: a position must never exist without at least one source.
--
-- This is the one invariant that is not expressible as a plain constraint: it
-- spans two tables and only holds at the end of a transaction. A deferred
-- constraint trigger is the closest SQL gets. The file validator in CI catches
-- it earlier and with a better message; this exists so the invariant survives
-- anyone writing to the database by another route.
CREATE OR REPLACE FUNCTION assert_position_has_source() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM candidate_position_source
    WHERE candidate_position_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'candidate_position % has no source (guideline §16)', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidate_position_requires_source ON candidate_position;

CREATE CONSTRAINT TRIGGER candidate_position_requires_source
  AFTER INSERT OR UPDATE ON candidate_position
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_position_has_source();

-- §32: an audit query, not a constraint. A table whose name suggests it holds
-- user answers is a schema review failure. Kept here so the intent is visible
-- to anyone reading the migrations.
--
--   SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public'
--     AND (tablename LIKE '%answer%' OR tablename LIKE '%user%'
--          OR tablename LIKE '%response%' OR tablename LIKE '%result%');
--
-- Expected: zero rows.
