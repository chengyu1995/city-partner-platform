# Hermes V2 Schema Manual Execution Plan

Scope: Phase 2C execution planning only.

This plan does not authorize Codex, Worker, or any agent to execute SQL or connect to Supabase. If Phase 2D is approved, a human should copy the reviewed SQL from `docs/setup-hermes-v2-schema.sql` into Supabase SQL Editor and run it manually.

## 1. Pre-Execution Checklist

- [ ] Owner has approved entering Phase 2D.
- [ ] Target environment is explicitly named: local, staging, or production.
- [ ] Runtime mode remains V1; no API, Worker, or Feishu code switches to V2 during schema creation.
- [ ] Fresh backup, restore point, or Supabase project snapshot is available.
- [ ] Rollback owner and communication channel are assigned.
- [ ] Human reviewer confirms the SQL only creates `hermes_v2_` tables and helper trigger function.
- [ ] Human reviewer confirms `hermes_jobs` remains untouched.
- [ ] Human reviewer confirms no secrets, service-role keys, app secrets, or connection strings are present.
- [ ] Human reviewer confirms no RLS policy is created in this phase.
- [ ] Human reviewer confirms no business table already uses the `hermes_v2_` names.
- [ ] Human reviewer confirms `pgcrypto` / `gen_random_uuid()` can be enabled or is already available.

## 2. Suggested Supabase SQL Editor Order

Use one manual SQL Editor session after review. Recommended chunks:

1. Safety header review only: read the first comment block and confirm the target project.
2. Run extension and trigger function setup:
   - `create extension if not exists pgcrypto;`
   - `create or replace function hermes_v2_set_updated_at() ...`
3. Run table creation statements in file order:
   - `hermes_v2_projects`
   - `hermes_v2_tasks`
   - `hermes_v2_agents`
   - `hermes_v2_task_attempts`
   - `hermes_v2_task_checkpoints`
   - `hermes_v2_human_decisions`
   - `hermes_v2_deployments`
   - `hermes_v2_task_events`
   - `hermes_v2_feishu_sync_outbox`
4. Run comments.
5. Run indexes.
6. Run the guarded trigger creation `do` block.
7. Run the verification SQL in this plan.

## 3. Content To Back Up Before Execution

- Current database schema metadata for the target schema.
- Current `hermes_jobs` table schema and row count.
- Any existing tables whose names start with `hermes_v2_`, if present.
- Supabase project restore point or equivalent backup reference.
- Current application runtime mode/configuration showing V1 is still active.

No V1 data should be migrated, updated, or backfilled in Phase 2D.

## 4. Post-Execution Verification SQL

Run these manually after the schema script completes:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'hermes_v2_projects',
    'hermes_v2_tasks',
    'hermes_v2_task_checkpoints',
    'hermes_v2_task_attempts',
    'hermes_v2_task_events',
    'hermes_v2_agents',
    'hermes_v2_human_decisions',
    'hermes_v2_deployments',
    'hermes_v2_feishu_sync_outbox'
  )
order by table_name;
```

```sql
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name like 'hermes_v2_%'
  and column_name in ('id', 'created_at', 'updated_at')
order by table_name, column_name;
```

```sql
select tgrelid::regclass as table_name, tgname
from pg_trigger
where not tgisinternal
  and tgname like 'trg_hermes_v2_%_set_updated_at'
order by table_name::text, tgname;
```

```sql
select indexname
from pg_indexes
where schemaname = 'public'
  and tablename like 'hermes_v2_%'
order by tablename, indexname;
```

```sql
select to_regclass('public.hermes_jobs') as hermes_jobs_regclass;
```

```sql
select gen_random_uuid();
```

Expected results:

- Exactly 9 V2 tables exist.
- Each V2 table has `id`, `created_at`, and `updated_at`.
- Each V2 table has one `updated_at` trigger.
- V2 indexes exist with `idx_hermes_v2_` names.
- `hermes_jobs` still exists if it existed before, with no schema or data change from this script.
- `gen_random_uuid()` returns a UUID.

## 5. Failure And Rollback Plan

If execution fails before any table is created:

- Stop.
- Save the SQL Editor error.
- Do not retry blindly.
- Ask the owner to decide whether to revise the SQL or target environment.

If execution fails after some V2 objects are created:

- Stop immediately.
- Keep runtime mode in V1.
- Do not run cleanup automatically.
- Record which `hermes_v2_` objects were created.
- Ask the owner whether to keep partial V2 objects for inspection or approve manual cleanup.

If execution accidentally targets production:

- Stop immediately.
- Do not enable V2 runtime paths.
- Notify the owner with the executed statement range and timestamp.
- Use the approved Supabase backup or restore process only if the owner chooses recovery.

Rollback principles:

- Never modify `hermes_jobs` as part of rollback for this phase.
- Never clean up V2 objects from an agent.
- If manual cleanup is approved, the human must confirm no V2 data exists or export it first.
- Prefer leaving unused V2 tables in place over destructive cleanup until a human approves.

## 6. Stop And Ask Owner Conditions

Stop and ask the owner if any of these occur:

- Target environment is not clearly local, staging, or production.
- Backup or restore point is missing.
- Supabase rejects `create extension if not exists pgcrypto;`.
- Any `hermes_v2_` table already exists with a conflicting structure.
- Any statement appears to affect `hermes_jobs` or non-V2 business tables.
- SQL Editor reports a partial execution failure.
- The reviewer wants RLS included before execution.
- The reviewer wants V1 backfill, dual-write, API, Worker, Feishu, or deployment changes included.
- Any secret appears in SQL, logs, or copied notes.

## 7. Repeatability Notes

Most statements are intended to be repeatable:

- `create extension if not exists`
- `create table if not exists`
- `create index if not exists`
- Guarded trigger creation through the `do` block

Statements that require extra care:

- `create or replace function hermes_v2_set_updated_at()` replaces the helper function body if rerun.
- `comment on` statements overwrite comments on V2 objects.
- If an existing `hermes_v2_` table has a different column layout, `create table if not exists` will not fix it, and later comments, indexes, or triggers may fail.

## 8. Recommendation On Phase 2D

Phase 2C recommends entering Phase 2D only after owner approval.

If Phase 2D happens, it should be manual database execution:

- Human opens Supabase SQL Editor.
- Human reviews the target project and backup.
- Human copies the approved SQL from `docs/setup-hermes-v2-schema.sql`.
- Human executes the SQL in the reviewed order.
- Human runs the verification SQL above.
- Human records the result and decides whether later API/Worker/Feishu phases may proceed.

Codex and Worker should not connect to Supabase, execute SQL, deploy, or switch runtime modes in Phase 2D.
