# Hermes V2 Schema Verification Result

Scope: Phase 2E verification record only.

This document records the expected verification checks and the completeness of the provided manual verification result. It does not execute SQL, does not connect to Supabase, and does not modify the database.

## 1. Verification SQL Source

Verification SQL source file:

- `docs/upgrade/v2-schema-verification-sql.md`

The verification SQL is read-only catalog and row-count SQL intended for manual use in Supabase SQL Editor after the V2 schema SQL has been manually executed.

## 2. Manual Verification Boundary

The verification SQL was expected to be executed manually by the boss in Supabase SQL Editor.

It was not executed by Codex, Worker, CI, scripts, or any automated database client.

Codex did not connect to Supabase and did not inspect the live database.

## 3. Overall Verification Status

Verification status: incomplete.

Reason: the boss-provided manual result block was not filled with concrete verification output. The original task still contains placeholders such as `是 / 否` and does not include result rows, screenshots, row counts, or per-check summaries.

## 4. V2 Table Existence Check

Expected V2 tables:

- `hermes_v2_projects`
- `hermes_v2_tasks`
- `hermes_v2_agents`
- `hermes_v2_task_attempts`
- `hermes_v2_task_checkpoints`
- `hermes_v2_human_decisions`
- `hermes_v2_deployments`
- `hermes_v2_task_events`
- `hermes_v2_feishu_sync_outbox`

Boss-provided result: not provided.

Conclusion: cannot verify from the supplied task text whether all 9 V2 tables exist in Supabase.

## 5. hermes_jobs Preservation Check

Expected result:

- `public.hermes_jobs` exists.
- `hermes_jobs` was not renamed.
- `hermes_jobs` was not deleted.
- `hermes_jobs` was not modified by the V2 schema SQL.

Boss-provided result: not provided.

Conclusion: cannot verify from the supplied task text whether `hermes_jobs` still exists in Supabase.

## 6. created_at / updated_at Field Check

Expected result:

- Every V2 table has `created_at`.
- Every V2 table has `updated_at`.
- The shared trigger function `hermes_v2_set_updated_at()` exists.
- One `trg_hermes_v2_*_set_updated_at` trigger exists for each V2 table.

Boss-provided result: not provided.

Conclusion: cannot verify live database fields or triggers from the supplied task text.

## 7. Key Index Check

Expected result:

- Key `idx_hermes_v2_*` indexes exist for project, task tree, queue, status, role, claim, heartbeat, event, deployment, and Feishu outbox access patterns.
- The verification SQL checks a representative required index set listed in `docs/upgrade/v2-schema-verification-sql.md`.

Boss-provided result: not provided.

Conclusion: cannot verify live database indexes from the supplied task text.

## 8. Trigger Check

Expected result:

- `hermes_v2_set_updated_at()` exists.
- Each of the 9 V2 tables has one corresponding `before update` trigger.

Boss-provided result: not provided.

Conclusion: cannot verify live database triggers from the supplied task text.

## 9. Check Constraint Check

Expected result:

- Status, type, progress, retry, and JSON-array constraints exist according to `docs/setup-hermes-v2-schema.sql`.
- The verification SQL checks constraints including task status, task type, agent status, attempt status, checkpoint status, decision status, deployment status, event severity, and outbox status constraints.

Boss-provided result: not provided.

Conclusion: cannot verify live database check constraints from the supplied task text.

## 10. Foreign Key Check

Expected result:

- V2-only foreign keys exist where table order and design permit.
- No foreign key points to `hermes_jobs`.
- `hermes_v2_tasks.last_attempt_id` intentionally remains without a foreign key to avoid a circular create-table dependency.
- `hermes_v2_tasks.dependency_task_ids` remains a JSONB array and must be validated later by API or Worker logic.

Boss-provided result: not provided.

Conclusion: cannot verify live database foreign keys from the supplied task text.

## 11. Initial V2 Row Count Check

Expected result:

- Each V2 table has `0` rows unless there was a known prior approved V2 run or approved test data.

Boss-provided result: not provided.

Conclusion: cannot verify V2 table row counts from the supplied task text.

## 12. Missing Verification Result Items

The following verification items are missing and must be supplied by the boss before this document can be treated as a complete verification report:

- Verification SQL success: `是` or `否`.
- Result rows proving all 9 V2 tables exist.
- Result row proving `public.hermes_jobs` exists.
- Key column check output.
- `created_at` / `updated_at` check output.
- Key index check output.
- Trigger function and trigger check output.
- Check constraint check output.
- Foreign key check output.
- V2 table row counts.
- Feishu outbox async field check output.
- Human decision lifecycle field check output.
- Screenshot or copied result summary from Supabase SQL Editor.

Until these values are provided, the verification conclusion remains incomplete and the stage should stay `waiting_review`.
