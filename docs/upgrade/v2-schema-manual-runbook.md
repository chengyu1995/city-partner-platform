# Hermes V2 Schema Manual Runbook

Scope: Phase 2D manual runbook only.

This runbook is for a human operator. Codex and Worker must not execute these SQL steps, connect to Supabase, or modify the database.

## 1. Manual Execution Steps

1. Confirm boss approval to enter the manual execution phase.
2. Confirm the target Supabase project and environment.
3. Confirm backup or restore point availability.
4. Open Supabase Dashboard for the approved project.
5. Go to SQL Editor.
6. Copy the reviewed SQL from `docs/setup-hermes-v2-schema.sql`.
7. Re-check the SQL for forbidden destructive statements.
8. Execute the SQL manually, preferably in reviewed chunks.
9. Run the verification SQL from `docs/upgrade/v2-schema-verification-sql.md`.
10. Save screenshots or exported results for the execution record.
11. Notify the system owner that the database schema step is complete and ready for the next review gate.

## 2. Supabase SQL Editor Location

In Supabase Dashboard:

1. Open the approved Supabase organization.
2. Select the approved project.
3. Confirm the project name, project reference, and environment notes.
4. In the left navigation, open SQL Editor.
5. Create a new query tab.
6. Paste only the reviewed Hermes V2 SQL.

Do not use a different project tab or browser session unless the project identity has been rechecked.

## 3. Backup Recommendation Before Execution

Before running SQL, create or confirm one of the following:

- Supabase backup or restore point.
- Project snapshot if available for the current plan.
- Schema metadata export.
- At minimum, screenshots of current `hermes_jobs` schema and row count.

Record:

- Backup or restore reference.
- Timestamp.
- Operator name.
- Target project reference.
- Rollback owner.

## 4. Pre-Execution Checks

The human operator must confirm:

- Current Supabase project is correct.
- This is not another customer's, staging, demo, or unrelated project.
- Existing `hermes_jobs` will not be modified.
- Current runtime remains V1.
- No V2 API, Worker, Feishu sync, or deployment behavior will be enabled in this step.
- SQL has no `DROP TABLE`.
- SQL has no `TRUNCATE`.
- SQL has no `DELETE FROM`.
- SQL has no `ALTER TABLE hermes_jobs`.
- SQL does not contain secrets, service-role keys, app secrets, or connection strings.
- Existing `hermes_v2_` objects, if any, are understood before execution.

Suggested pre-check SQL for human use, not for Codex execution:

```sql
select to_regclass('public.hermes_jobs') as hermes_jobs_regclass;

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name like 'hermes_v2_%'
order by table_name;
```

## 5. SQL Execution Method

Recommended method: execute in reviewed chunks, not as an uninspected blind full paste.

Suggested chunk order:

1. Safety header review only.
2. Extension and helper function:
   - `create extension if not exists pgcrypto;`
   - `create or replace function hermes_v2_set_updated_at() ...`
3. Table creation in dependency order:
   - `hermes_v2_projects`
   - `hermes_v2_tasks`
   - `hermes_v2_agents`
   - `hermes_v2_task_attempts`
   - `hermes_v2_task_checkpoints`
   - `hermes_v2_human_decisions`
   - `hermes_v2_deployments`
   - `hermes_v2_task_events`
   - `hermes_v2_feishu_sync_outbox`
4. Comments.
5. Indexes.
6. Guarded trigger creation `do` block.
7. Verification SQL.

If the operator chooses full-file execution, they must still read the file first and confirm all pre-execution checks.

## 6. Successful Execution Check Order

After SQL succeeds, run checks in this order:

1. Confirm all 9 V2 tables exist.
2. Confirm `hermes_jobs` still exists.
3. Confirm each V2 table has `id`, `created_at`, and `updated_at`.
4. Confirm key fields exist on each V2 table.
5. Confirm key indexes exist.
6. Confirm one `updated_at` trigger exists for each V2 table.
7. Confirm check constraints exist.
8. Confirm foreign keys exist.
9. Confirm V2 table row counts are 0 unless a known pre-existing V2 object already had data.
10. Confirm `hermes_v2_feishu_sync_outbox` has async sync fields.
11. Confirm `hermes_v2_human_decisions` has human decision status fields.

Use `docs/upgrade/v2-schema-verification-sql.md` as the copyable verification script.

## 7. Failure Stop Rules

If any SQL statement fails:

- Stop immediately.
- Save the error message and screenshot.
- Record which chunk failed.
- Record which chunks had already succeeded.
- Do not blindly retry the whole script.
- Do not immediately run cleanup.
- Do not enable V2 runtime code.
- Keep runtime mode in V1.
- Ask the boss for the next decision.

## 8. No Blind Repeat Rule

Do not rerun the full SQL after a failure without understanding the partial state.

Some statements are repeatable, but an incompatible partially created table can cause later comments, indexes, triggers, or constraints to fail again. Inspect first, then decide whether to revise SQL, continue from a specific safe point, or leave partial V2 objects for review.

## 9. Common Error Handling

Permission error:

- Stop.
- Confirm whether the operator has permission for schema changes or extension creation.
- Do not switch to a service-role key inside docs or SQL notes.
- Ask the boss whether an approved database owner should run the step.

Extension error:

- Stop if `pgcrypto` cannot be created or `gen_random_uuid()` is unavailable.
- Confirm Supabase extension settings and operator privileges.
- Do not replace UUID defaults without a reviewed SQL revision.

Table already exists error or incompatible existing table:

- Stop.
- Inspect the existing `hermes_v2_` table structure.
- Confirm whether it is from an earlier approved run.
- Do not drop the table without boss approval.

Index already exists or conflicting index error:

- Stop.
- Inspect the existing index definition.
- If the index is equivalent, record it.
- If it differs, ask for a reviewed SQL revision.

Trigger or function error:

- Stop.
- Inspect whether `hermes_v2_set_updated_at()` or `trg_hermes_v2_*_set_updated_at` already exists.
- Do not remove triggers without approval.

## 10. Notify System To Enter Next Stage

After successful execution and verification, notify the owner with:

- Target Supabase project and environment.
- Execution timestamp.
- Operator name.
- Confirmation that 9 V2 tables exist.
- Confirmation that `hermes_jobs` still exists.
- Verification SQL result summary.
- Any warnings or unexpected pre-existing objects.
- Recommendation that the task can move from `waiting_review` to the next approved phase gate.

Do not mark later API, Worker, Feishu, deployment, or V2 runtime work as approved just because the schema exists.
