-- BATCH-ARCH-COMPLETE-00-DIAGNOSTICS-SCHEMA-ALIGNMENT-AND-IDEMPOTENCE-FIX-01
-- Draft only. Do not execute automatically.
--
-- Purpose:
--   Add the nullable JSONB storage field used by Worker terminal reports:
--   hermes_jobs.result.diagnostics
--
-- Safety contract:
--   - No historical rows are updated.
--   - Existing failed rows keep result = NULL unless they already had a value.
--   - No status enum, RLS, secret, index, or table rewrite changes are made.

BEGIN;

-- Preflight: capture row counts and status distribution before the change.
SELECT COUNT(*) AS hermes_jobs_count_before
FROM public.hermes_jobs;

SELECT status, COUNT(*) AS count_before
FROM public.hermes_jobs
GROUP BY status
ORDER BY status;

SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'hermes_jobs'
ORDER BY ordinal_position;

-- Schema change: nullable so all existing rows remain valid and untouched.
ALTER TABLE public.hermes_jobs
  ADD COLUMN IF NOT EXISTS result jsonb NULL;

-- Postflight verification.
SELECT column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'hermes_jobs'
  AND column_name = 'result';

SELECT COUNT(*) AS hermes_jobs_count_after
FROM public.hermes_jobs;

SELECT status, COUNT(*) AS count_after
FROM public.hermes_jobs
GROUP BY status
ORDER BY status;

-- Existing failed records must not be backfilled by this migration.
SELECT COUNT(*) AS failed_rows_with_result_after_migration
FROM public.hermes_jobs
WHERE status = 'failed'
  AND result IS NOT NULL;

COMMIT;

-- Rollback, if the column must be removed before runtime depends on it.
-- BEGIN;
-- ALTER TABLE public.hermes_jobs DROP COLUMN IF EXISTS result;
-- COMMIT;
