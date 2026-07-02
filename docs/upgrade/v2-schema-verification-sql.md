# Hermes V2 Schema Verification SQL

Scope: copyable manual verification SQL only.

Do not execute this SQL from Codex, Worker, CI, or any automated client. A human may copy it into Supabase SQL Editor after the V2 schema SQL has been manually executed.

```sql
-- Hermes V2 schema verification.
-- Expected context: Supabase SQL Editor, approved target project.
-- This script only reads catalog metadata and row counts.

-- 1. Check the 9 V2 tables exist.
with expected(table_name) as (
  values
    ('hermes_v2_projects'),
    ('hermes_v2_tasks'),
    ('hermes_v2_task_checkpoints'),
    ('hermes_v2_task_attempts'),
    ('hermes_v2_task_events'),
    ('hermes_v2_agents'),
    ('hermes_v2_human_decisions'),
    ('hermes_v2_deployments'),
    ('hermes_v2_feishu_sync_outbox')
)
select
  expected.table_name,
  case when tables.table_name is null then 'missing' else 'exists' end as table_status
from expected
left join information_schema.tables tables
  on tables.table_schema = 'public'
 and tables.table_name = expected.table_name
order by expected.table_name;

-- 2. Check hermes_jobs still exists.
select
  'hermes_jobs' as table_name,
  to_regclass('public.hermes_jobs') as regclass_value,
  case when to_regclass('public.hermes_jobs') is null then 'missing' else 'exists' end as table_status;

-- 3. Check hermes_jobs has not been renamed or deleted.
select
  table_schema,
  table_name,
  table_type
from information_schema.tables
where table_schema = 'public'
  and table_name = 'hermes_jobs';

-- 4. Check key columns on each V2 table.
with expected_columns(table_name, column_name) as (
  values
    ('hermes_v2_projects', 'id'),
    ('hermes_v2_projects', 'key'),
    ('hermes_v2_projects', 'name'),
    ('hermes_v2_projects', 'status'),
    ('hermes_v2_tasks', 'id'),
    ('hermes_v2_tasks', 'project_id'),
    ('hermes_v2_tasks', 'parent_task_id'),
    ('hermes_v2_tasks', 'legacy_hermes_job_id'),
    ('hermes_v2_tasks', 'legacy_job_id'),
    ('hermes_v2_tasks', 'task_type'),
    ('hermes_v2_tasks', 'task_level'),
    ('hermes_v2_tasks', 'title'),
    ('hermes_v2_tasks', 'status'),
    ('hermes_v2_tasks', 'need_human_decision'),
    ('hermes_v2_tasks', 'requires_human_decision'),
    ('hermes_v2_tasks', 'dependency_task_ids'),
    ('hermes_v2_tasks', 'last_attempt_id'),
    ('hermes_v2_task_checkpoints', 'id'),
    ('hermes_v2_task_checkpoints', 'task_id'),
    ('hermes_v2_task_checkpoints', 'attempt_id'),
    ('hermes_v2_task_checkpoints', 'checkpoint_type'),
    ('hermes_v2_task_checkpoints', 'status'),
    ('hermes_v2_task_checkpoints', 'validation_status'),
    ('hermes_v2_task_attempts', 'id'),
    ('hermes_v2_task_attempts', 'task_id'),
    ('hermes_v2_task_attempts', 'agent_id'),
    ('hermes_v2_task_attempts', 'attempt_number'),
    ('hermes_v2_task_attempts', 'retry_count'),
    ('hermes_v2_task_attempts', 'status'),
    ('hermes_v2_task_attempts', 'claim_token'),
    ('hermes_v2_task_attempts', 'heartbeat_at'),
    ('hermes_v2_task_attempts', 'exit_code'),
    ('hermes_v2_task_attempts', 'error_text'),
    ('hermes_v2_task_events', 'id'),
    ('hermes_v2_task_events', 'project_id'),
    ('hermes_v2_task_events', 'task_id'),
    ('hermes_v2_task_events', 'attempt_id'),
    ('hermes_v2_task_events', 'agent_id'),
    ('hermes_v2_task_events', 'event_type'),
    ('hermes_v2_task_events', 'severity'),
    ('hermes_v2_agents', 'id'),
    ('hermes_v2_agents', 'project_id'),
    ('hermes_v2_agents', 'current_task_id'),
    ('hermes_v2_agents', 'name'),
    ('hermes_v2_agents', 'role'),
    ('hermes_v2_agents', 'agent_type'),
    ('hermes_v2_agents', 'status'),
    ('hermes_v2_agents', 'heartbeat_at'),
    ('hermes_v2_human_decisions', 'id'),
    ('hermes_v2_human_decisions', 'project_id'),
    ('hermes_v2_human_decisions', 'task_id'),
    ('hermes_v2_human_decisions', 'attempt_id'),
    ('hermes_v2_human_decisions', 'decision_type'),
    ('hermes_v2_human_decisions', 'decision_status'),
    ('hermes_v2_human_decisions', 'question'),
    ('hermes_v2_human_decisions', 'options'),
    ('hermes_v2_human_decisions', 'selected_option'),
    ('hermes_v2_human_decisions', 'decision_text'),
    ('hermes_v2_deployments', 'id'),
    ('hermes_v2_deployments', 'project_id'),
    ('hermes_v2_deployments', 'task_id'),
    ('hermes_v2_deployments', 'attempt_id'),
    ('hermes_v2_deployments', 'provider'),
    ('hermes_v2_deployments', 'environment'),
    ('hermes_v2_deployments', 'deploy_status'),
    ('hermes_v2_deployments', 'git_commit_sha'),
    ('hermes_v2_deployments', 'preview_url'),
    ('hermes_v2_deployments', 'production_url'),
    ('hermes_v2_feishu_sync_outbox', 'id'),
    ('hermes_v2_feishu_sync_outbox', 'project_id'),
    ('hermes_v2_feishu_sync_outbox', 'task_id'),
    ('hermes_v2_feishu_sync_outbox', 'attempt_id'),
    ('hermes_v2_feishu_sync_outbox', 'deployment_id'),
    ('hermes_v2_feishu_sync_outbox', 'human_decision_id'),
    ('hermes_v2_feishu_sync_outbox', 'sync_type'),
    ('hermes_v2_feishu_sync_outbox', 'target_type'),
    ('hermes_v2_feishu_sync_outbox', 'operation'),
    ('hermes_v2_feishu_sync_outbox', 'desired_payload'),
    ('hermes_v2_feishu_sync_outbox', 'sync_status'),
    ('hermes_v2_feishu_sync_outbox', 'retry_count'),
    ('hermes_v2_feishu_sync_outbox', 'next_attempt_at'),
    ('hermes_v2_feishu_sync_outbox', 'last_error_text')
)
select
  expected_columns.table_name,
  expected_columns.column_name,
  case when columns.column_name is null then 'missing' else 'exists' end as column_status
from expected_columns
left join information_schema.columns columns
  on columns.table_schema = 'public'
 and columns.table_name = expected_columns.table_name
 and columns.column_name = expected_columns.column_name
order by expected_columns.table_name, expected_columns.column_name;

-- 5. Check every V2 table has created_at and updated_at.
with expected(table_name) as (
  values
    ('hermes_v2_projects'),
    ('hermes_v2_tasks'),
    ('hermes_v2_task_checkpoints'),
    ('hermes_v2_task_attempts'),
    ('hermes_v2_task_events'),
    ('hermes_v2_agents'),
    ('hermes_v2_human_decisions'),
    ('hermes_v2_deployments'),
    ('hermes_v2_feishu_sync_outbox')
),
required_columns(column_name) as (
  values ('created_at'), ('updated_at')
)
select
  expected.table_name,
  required_columns.column_name,
  case when columns.column_name is null then 'missing' else 'exists' end as column_status
from expected
cross join required_columns
left join information_schema.columns columns
  on columns.table_schema = 'public'
 and columns.table_name = expected.table_name
 and columns.column_name = required_columns.column_name
order by expected.table_name, required_columns.column_name;

-- 6. Check key indexes exist.
with expected_indexes(index_name) as (
  values
    ('idx_hermes_v2_projects_status'),
    ('idx_hermes_v2_projects_key'),
    ('idx_hermes_v2_tasks_project_id'),
    ('idx_hermes_v2_tasks_parent_task_id'),
    ('idx_hermes_v2_tasks_status'),
    ('idx_hermes_v2_tasks_status_priority_created_at'),
    ('idx_hermes_v2_tasks_claimed_by'),
    ('idx_hermes_v2_tasks_dependency_task_ids'),
    ('idx_hermes_v2_agents_project_id'),
    ('idx_hermes_v2_agents_current_task_id'),
    ('idx_hermes_v2_agents_status'),
    ('idx_hermes_v2_task_attempts_task_id'),
    ('idx_hermes_v2_task_attempts_agent_id'),
    ('idx_hermes_v2_task_attempts_status'),
    ('idx_hermes_v2_task_attempts_heartbeat_at'),
    ('idx_hermes_v2_task_checkpoints_task_id'),
    ('idx_hermes_v2_task_checkpoints_attempt_id'),
    ('idx_hermes_v2_human_decisions_task_id'),
    ('idx_hermes_v2_human_decisions_status'),
    ('idx_hermes_v2_deployments_project_id'),
    ('idx_hermes_v2_deployments_environment_status'),
    ('idx_hermes_v2_task_events_task_id_created_at'),
    ('idx_hermes_v2_task_events_event_type'),
    ('idx_hermes_v2_feishu_sync_outbox_status'),
    ('idx_hermes_v2_feishu_sync_outbox_status_next_attempt'),
    ('idx_hermes_v2_feishu_sync_outbox_target')
)
select
  expected_indexes.index_name,
  case when pg_indexes.indexname is null then 'missing' else 'exists' end as index_status
from expected_indexes
left join pg_indexes
  on pg_indexes.schemaname = 'public'
 and pg_indexes.indexname = expected_indexes.index_name
order by expected_indexes.index_name;

-- 7. Check updated_at trigger function and per-table triggers exist.
select
  proname as function_name,
  case when proname = 'hermes_v2_set_updated_at' then 'exists' else 'unexpected' end as function_status
from pg_proc
where proname = 'hermes_v2_set_updated_at';

with expected_triggers(table_name, trigger_name) as (
  values
    ('hermes_v2_projects', 'trg_hermes_v2_projects_set_updated_at'),
    ('hermes_v2_tasks', 'trg_hermes_v2_tasks_set_updated_at'),
    ('hermes_v2_task_checkpoints', 'trg_hermes_v2_task_checkpoints_set_updated_at'),
    ('hermes_v2_task_attempts', 'trg_hermes_v2_task_attempts_set_updated_at'),
    ('hermes_v2_task_events', 'trg_hermes_v2_task_events_set_updated_at'),
    ('hermes_v2_agents', 'trg_hermes_v2_agents_set_updated_at'),
    ('hermes_v2_human_decisions', 'trg_hermes_v2_human_decisions_set_updated_at'),
    ('hermes_v2_deployments', 'trg_hermes_v2_deployments_set_updated_at'),
    ('hermes_v2_feishu_sync_outbox', 'trg_hermes_v2_feishu_sync_outbox_set_updated_at')
)
select
  expected_triggers.table_name,
  expected_triggers.trigger_name,
  case when pg_trigger.tgname is null then 'missing' else 'exists' end as trigger_status
from expected_triggers
left join pg_class
  on pg_class.relname = expected_triggers.table_name
left join pg_namespace
  on pg_namespace.oid = pg_class.relnamespace
 and pg_namespace.nspname = 'public'
left join pg_trigger
  on pg_trigger.tgname = expected_triggers.trigger_name
 and pg_trigger.tgrelid = pg_class.oid
order by expected_triggers.table_name;

-- 8. Check check constraints exist.
with expected_constraints(constraint_name) as (
  values
    ('hermes_v2_projects_status_check'),
    ('hermes_v2_tasks_source_check'),
    ('hermes_v2_tasks_status_check'),
    ('hermes_v2_tasks_task_type_check'),
    ('hermes_v2_tasks_task_level_check'),
    ('hermes_v2_tasks_risk_level_check'),
    ('hermes_v2_tasks_progress_percent_check'),
    ('hermes_v2_tasks_dependency_task_ids_array_check'),
    ('hermes_v2_agents_status_check'),
    ('hermes_v2_agents_agent_type_check'),
    ('hermes_v2_task_attempts_status_check'),
    ('hermes_v2_task_attempts_task_attempt_unique'),
    ('hermes_v2_task_checkpoints_status_check'),
    ('hermes_v2_task_checkpoints_type_check'),
    ('hermes_v2_human_decisions_type_check'),
    ('hermes_v2_human_decisions_status_check'),
    ('hermes_v2_deployments_environment_check'),
    ('hermes_v2_deployments_status_check'),
    ('hermes_v2_task_events_type_check'),
    ('hermes_v2_task_events_severity_check'),
    ('hermes_v2_feishu_sync_outbox_sync_type_check'),
    ('hermes_v2_feishu_sync_outbox_operation_check'),
    ('hermes_v2_feishu_sync_outbox_status_check')
)
select
  expected_constraints.constraint_name,
  case when constraints.conname is null then 'missing' else 'exists' end as constraint_status
from expected_constraints
left join pg_constraint constraints
  on constraints.conname = expected_constraints.constraint_name
order by expected_constraints.constraint_name;

-- 9. Check foreign keys exist.
select
  conrelid::regclass as table_name,
  conname as foreign_key_name,
  confrelid::regclass as references_table
from pg_constraint
where contype = 'f'
  and conrelid::regclass::text like 'hermes_v2_%'
order by table_name::text, foreign_key_name;

-- 10. Check V2 table row counts. Expected: 0 unless there was a known prior V2 run.
select 'hermes_v2_projects' as table_name, count(*) as row_count from public.hermes_v2_projects
union all select 'hermes_v2_tasks', count(*) from public.hermes_v2_tasks
union all select 'hermes_v2_task_checkpoints', count(*) from public.hermes_v2_task_checkpoints
union all select 'hermes_v2_task_attempts', count(*) from public.hermes_v2_task_attempts
union all select 'hermes_v2_task_events', count(*) from public.hermes_v2_task_events
union all select 'hermes_v2_agents', count(*) from public.hermes_v2_agents
union all select 'hermes_v2_human_decisions', count(*) from public.hermes_v2_human_decisions
union all select 'hermes_v2_deployments', count(*) from public.hermes_v2_deployments
union all select 'hermes_v2_feishu_sync_outbox', count(*) from public.hermes_v2_feishu_sync_outbox
order by table_name;

-- 11. Check feishu_sync_outbox async sync fields.
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'hermes_v2_feishu_sync_outbox'
  and column_name in (
    'sync_type',
    'target_type',
    'operation',
    'payload',
    'desired_payload',
    'sync_status',
    'retry_count',
    'max_attempts',
    'next_attempt_at',
    'last_attempt_at',
    'last_success_at',
    'last_error',
    'last_error_text',
    'idempotency_key'
  )
order by column_name;

-- 12. Check human_decisions human decision status fields.
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'hermes_v2_human_decisions'
  and column_name in (
    'decision_type',
    'decision_status',
    'question',
    'options',
    'selected_option',
    'decision_text',
    'requested_by_agent_id',
    'decided_by_agent_id',
    'external_channel',
    'external_message_id',
    'expires_at',
    'decided_at',
    'resolved_at'
  )
order by column_name;
```

Expected verification summary:

- All 9 V2 tables are `exists`.
- `public.hermes_jobs` is `exists`.
- No check suggests `hermes_jobs` was renamed or deleted.
- Each V2 table has expected key fields.
- Each V2 table has `created_at` and `updated_at`.
- Key `idx_hermes_v2_` indexes exist.
- `hermes_v2_set_updated_at()` exists.
- Each V2 table has one `trg_hermes_v2_*_set_updated_at` trigger.
- Check constraints and foreign keys exist.
- V2 table row counts are 0 unless the boss already approved prior V2 test data.
- `hermes_v2_feishu_sync_outbox` has durable async sync fields.
- `hermes_v2_human_decisions` has decision lifecycle fields.
