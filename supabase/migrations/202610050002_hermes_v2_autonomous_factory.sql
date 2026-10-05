-- Hermes V2 autonomous software factory control plane.
--
-- Safety scope:
-- - This migration only creates additive Hermes V2 objects with the `hermes_v2_` prefix.
-- - This file does not modify `hermes_jobs`.
-- - This file does not remove, rename, or clear any table or data.
-- - RLS is enabled without public policies; server-side service-role access is required.
-- - A human must review this migration before manually running it.
-- - Codex, Worker, and other agents must not execute this SQL automatically.
--
-- Secret policy:
-- - Do not place real keys, tokens, app secrets, service-role values, or connection strings in this file.
-- - Feishu app/table identifiers in this schema are locators only, not secrets.

begin;

create extension if not exists pgcrypto;

set search_path = public, extensions;

create or replace function hermes_v2_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists hermes_v2_projects (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name text not null,
  description text,
  repository_full_name text,
  repository_url text,
  default_base_branch text not null default 'develop',
  default_worktree_path text,
  production_url text,
  preview_url_pattern text,
  feishu_app_token text,
  feishu_task_table_id text,
  settings jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_projects_key_unique unique (key),
  constraint hermes_v2_projects_status_check check (status in ('active', 'paused', 'archived'))
);

comment on table hermes_v2_projects is 'Hermes V2 project context, repository defaults, and non-secret integration locators.';
comment on column hermes_v2_projects.feishu_app_token is 'Non-secret Feishu app/table locator; app secrets stay outside the database.';

create table if not exists hermes_v2_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  parent_task_id uuid references hermes_v2_tasks(id),
  canonical_hermes_job_id uuid references hermes_jobs(id) on delete restrict,
  source text not null default 'manual',
  source_external_id text,
  feishu_event_id text,
  feishu_message_id text,
  feishu_chat_id text,
  feishu_user_id text,
  feishu_record_id text,
  task_type text not null default 'subtask',
  task_level text not null default 'subtask',
  role text,
  title text not null,
  description text,
  request_text text,
  acceptance_criteria text,
  prompt text,
  repo text,
  base_branch text,
  target_branch text,
  priority integer not null default 100,
  status text not null default 'draft',
  stage text,
  status_message text,
  risk_level text not null default 'low',
  need_human_decision boolean not null default false,
  requires_human_decision boolean generated always as (need_human_decision) stored,
  blocked_reason text,
  dependency_task_ids jsonb not null default '[]'::jsonb,
  dependency_notes text,
  result_summary text,
  result_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  dispatched_at timestamptz,
  reviewed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_tasks_source_check check (source in ('feishu_event', 'feishu_bitable', 'manual', 'api', 'system')),
  constraint hermes_v2_tasks_status_check check (status in ('draft', 'awaiting_human', 'ready', 'dispatched', 'awaiting_review', 'approved', 'rejected', 'cancelled')),
  constraint hermes_v2_tasks_task_type_check check (task_type in ('requirement', 'parent_task', 'phase', 'task', 'subtask', 'bugfix', 'review', 'maintenance')),
  constraint hermes_v2_tasks_task_level_check check (task_level in ('project', 'phase', 'task', 'subtask', 'checkpoint')),
  constraint hermes_v2_tasks_risk_level_check check (risk_level in ('low', 'medium', 'high', 'critical')),
  constraint hermes_v2_tasks_dependency_task_ids_array_check check (jsonb_typeof(dependency_task_ids) = 'array')
);

comment on table hermes_v2_tasks is 'Requirement and plan nodes. Runtime execution state remains canonical in hermes_jobs.';
comment on column hermes_v2_tasks.canonical_hermes_job_id is 'Optional link to the one canonical Worker job aggregate. V2 never owns attempts, leases, claims, or terminal execution state.';
comment on column hermes_v2_tasks.dependency_task_ids is 'JSONB array of V2 planning-task UUID strings. The dispatcher validates existence and acyclicity before creating canonical Hermes jobs.';

create table if not exists hermes_v2_agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references hermes_v2_projects(id),
  name text not null,
  role text not null,
  planning_agent text not null,
  runtime_executor text not null default 'codex_agent',
  capabilities jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_agents_role_unique unique (project_id, role),
  constraint hermes_v2_agents_capabilities_array_check check (jsonb_typeof(capabilities) = 'array')
);

comment on table hermes_v2_agents is 'Logical business-role registry. Real execution is delegated to the canonical Hermes Worker state machine.';

create table if not exists hermes_v2_task_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references hermes_v2_tasks(id),
  canonical_hermes_job_id uuid references hermes_jobs(id) on delete restrict,
  checkpoint_order integer not null default 0,
  checkpoint_type text not null default 'validation',
  title text not null,
  status text not null default 'not_checked',
  progress_percent integer not null default 0,
  git_ref text,
  git_sha text,
  worktree_path text,
  is_worktree_clean boolean,
  changed_paths jsonb not null default '[]'::jsonb,
  untracked_paths jsonb not null default '[]'::jsonb,
  validation_status text not null default 'not_checked',
  validation_notes text,
  evidence_ref text,
  created_by_agent_id uuid references hermes_v2_agents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_task_checkpoints_status_check check (status in ('pending', 'running', 'passed', 'failed', 'skipped', 'not_checked')),
  constraint hermes_v2_task_checkpoints_type_check check (checkpoint_type in ('intake', 'pre_execution', 'pre_attempt', 'post_codex', 'pre_commit', 'post_commit', 'validation', 'review', 'completion', 'rollback')),
  constraint hermes_v2_task_checkpoints_validation_status_check check (validation_status in ('passed', 'failed', 'not_checked')),
  constraint hermes_v2_task_checkpoints_progress_percent_check check (progress_percent between 0 and 100),
  constraint hermes_v2_task_checkpoints_order_check check (checkpoint_order >= 0),
  constraint hermes_v2_task_checkpoints_changed_paths_array_check check (jsonb_typeof(changed_paths) = 'array'),
  constraint hermes_v2_task_checkpoints_untracked_paths_array_check check (jsonb_typeof(untracked_paths) = 'array')
);

comment on table hermes_v2_task_checkpoints is 'Checkpoint metadata for V2 task proofs, validation gates, and rollback anchors.';

create table if not exists hermes_v2_human_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid not null references hermes_v2_tasks(id),
  decision_type text not null default 'clarification',
  decision_status text not null default 'waiting',
  question text not null,
  options jsonb not null default '[]'::jsonb,
  selected_option text,
  decision_text text,
  requested_by_agent_id uuid references hermes_v2_agents(id),
  decided_by_agent_id uuid references hermes_v2_agents(id),
  external_channel text,
  external_message_id text,
  expires_at timestamptz,
  decided_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_human_decisions_type_check check (decision_type in ('clarification', 'approval', 'rejection', 'review', 'risk_acceptance', 'production_gate')),
  constraint hermes_v2_human_decisions_status_check check (decision_status in ('waiting', 'answered', 'cancelled', 'expired')),
  constraint hermes_v2_human_decisions_options_array_check check (jsonb_typeof(options) = 'array')
);

comment on table hermes_v2_human_decisions is 'First-class human approval, rejection, clarification, review, and production gate records.';
comment on column hermes_v2_human_decisions.decision_status is 'Decision lifecycle status for Phase 2C: waiting, answered, cancelled, or expired.';

create table if not exists hermes_v2_deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid references hermes_v2_tasks(id),
  canonical_hermes_job_id uuid references hermes_jobs(id) on delete restrict,
  provider text not null default 'vercel',
  environment text not null default 'preview',
  deploy_status text not null default 'pending',
  git_commit_sha text not null,
  git_branch text,
  preview_url text,
  production_url text,
  deployment_url text,
  provider_deployment_id text,
  callback_idempotency_key text,
  started_at timestamptz,
  finished_at timestamptz,
  last_callback_at timestamptz,
  error_text text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_deployments_environment_check check (environment in ('preview', 'staging', 'production', 'unknown')),
  constraint hermes_v2_deployments_status_check check (deploy_status in ('pending', 'building', 'ready', 'failed', 'cancelled', 'unknown')),
  constraint hermes_v2_deployments_provider_check check (provider in ('vercel', 'github', 'manual', 'other'))
);

comment on table hermes_v2_deployments is 'Observed deployment evidence linked to a planning task, canonical Hermes job, and Git commit.';
comment on column hermes_v2_deployments.preview_url is 'Preview URL when the environment is preview or staging.';
comment on column hermes_v2_deployments.production_url is 'Production URL when the environment is production.';
comment on column hermes_v2_deployments.git_commit_sha is 'Commit SHA associated with this deployment.';

create table if not exists hermes_v2_task_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid not null references hermes_v2_tasks(id),
  agent_id uuid references hermes_v2_agents(id),
  human_decision_id uuid references hermes_v2_human_decisions(id),
  deployment_id uuid references hermes_v2_deployments(id),
  event_type text not null,
  from_status text,
  to_status text,
  severity text not null default 'info',
  message text,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_task_events_type_check check (event_type in (
    'task.created',
    'task.plan_stored',
    'task.awaiting_human',
    'task.dispatched',
    'task.review_requested',
    'task.reviewed',
    'task.cancelled',
    'canonical_job.observed',
    'human_decision.requested',
    'human_decision.resolved',
    'deployment.updated',
    'feishu.sync_queued',
    'feishu.sync_failed',
    'feishu.sync_succeeded',
    'memory.updated',
    'error.recorded'
  )),
  constraint hermes_v2_task_events_severity_check check (severity in ('debug', 'info', 'warning', 'error'))
);

comment on table hermes_v2_task_events is 'Append-oriented control-plane audit stream. Worker execution transitions remain in the canonical Hermes job aggregate.';

create table if not exists hermes_v2_feishu_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid references hermes_v2_tasks(id),
  deployment_id uuid references hermes_v2_deployments(id),
  human_decision_id uuid references hermes_v2_human_decisions(id),
  sync_type text not null default 'task_status',
  target_type text not null default 'bitable_record',
  target_table text,
  target_table_id text,
  target_record_id text,
  target_app_token text,
  target_chat_id text,
  target_message_id text,
  operation text not null,
  payload jsonb not null default '{}'::jsonb,
  desired_payload jsonb not null default '{}'::jsonb,
  sync_status text not null default 'pending',
  retry_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_text text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_feishu_sync_outbox_sync_type_check check (sync_type in ('task_status', 'deployment_status', 'decision_request', 'message_reply', 'review_packet')),
  constraint hermes_v2_feishu_sync_outbox_target_type_check check (target_type in ('bitable_record', 'chat_message', 'comment', 'unknown')),
  constraint hermes_v2_feishu_sync_outbox_operation_check check (operation in ('create_record', 'upsert_record', 'update_record', 'send_message', 'update_message', 'cancel_sync')),
  constraint hermes_v2_feishu_sync_outbox_status_check check (sync_status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  constraint hermes_v2_feishu_sync_outbox_retry_count_check check (retry_count >= 0),
  constraint hermes_v2_feishu_sync_outbox_max_attempts_check check (max_attempts >= 1)
);

comment on table hermes_v2_feishu_sync_outbox is 'Durable asynchronous Feishu and Bitable writeback queue. Feishu sync failure must not block canonical task execution.';
comment on column hermes_v2_feishu_sync_outbox.sync_status is 'Outbox status: pending, processing, succeeded, failed, or cancelled.';
comment on column hermes_v2_feishu_sync_outbox.retry_count is 'Number of async sync attempts already made.';

create index if not exists idx_hermes_v2_projects_status on hermes_v2_projects (status);
create index if not exists idx_hermes_v2_projects_key on hermes_v2_projects (key);
create index if not exists idx_hermes_v2_projects_created_at on hermes_v2_projects (created_at);

create index if not exists idx_hermes_v2_tasks_project_id on hermes_v2_tasks (project_id);
create index if not exists idx_hermes_v2_tasks_parent_task_id on hermes_v2_tasks (parent_task_id);
create index if not exists idx_hermes_v2_tasks_status on hermes_v2_tasks (status);
create index if not exists idx_hermes_v2_tasks_status_priority_created_at on hermes_v2_tasks (status, priority, created_at);
create index if not exists idx_hermes_v2_tasks_role on hermes_v2_tasks (role);
create index if not exists idx_hermes_v2_tasks_created_at on hermes_v2_tasks (created_at);
create index if not exists idx_hermes_v2_tasks_need_human_decision on hermes_v2_tasks (need_human_decision) where need_human_decision = true;
create index if not exists idx_hermes_v2_tasks_task_level on hermes_v2_tasks (task_level);
create index if not exists idx_hermes_v2_tasks_risk_level on hermes_v2_tasks (risk_level);
create unique index if not exists idx_hermes_v2_tasks_canonical_hermes_job_id
  on hermes_v2_tasks (canonical_hermes_job_id)
  where canonical_hermes_job_id is not null;
create index if not exists idx_hermes_v2_tasks_feishu_record_id on hermes_v2_tasks (feishu_record_id);
create index if not exists idx_hermes_v2_tasks_dependency_task_ids on hermes_v2_tasks using gin (dependency_task_ids);

create index if not exists idx_hermes_v2_agents_project_id on hermes_v2_agents (project_id);
create index if not exists idx_hermes_v2_agents_name on hermes_v2_agents (name);
create index if not exists idx_hermes_v2_agents_role on hermes_v2_agents (role);

create index if not exists idx_hermes_v2_task_checkpoints_task_id on hermes_v2_task_checkpoints (task_id, checkpoint_order);
create index if not exists idx_hermes_v2_task_checkpoints_canonical_job_id on hermes_v2_task_checkpoints (canonical_hermes_job_id);
create index if not exists idx_hermes_v2_task_checkpoints_status on hermes_v2_task_checkpoints (status);
create index if not exists idx_hermes_v2_task_checkpoints_created_at on hermes_v2_task_checkpoints (created_at);

create index if not exists idx_hermes_v2_human_decisions_project_id on hermes_v2_human_decisions (project_id);
create index if not exists idx_hermes_v2_human_decisions_task_id on hermes_v2_human_decisions (task_id);
create index if not exists idx_hermes_v2_human_decisions_status on hermes_v2_human_decisions (decision_status);
create index if not exists idx_hermes_v2_human_decisions_created_at on hermes_v2_human_decisions (created_at);
create index if not exists idx_hermes_v2_human_decisions_decided_at on hermes_v2_human_decisions (decided_at);

create index if not exists idx_hermes_v2_deployments_project_id on hermes_v2_deployments (project_id);
create index if not exists idx_hermes_v2_deployments_task_id on hermes_v2_deployments (task_id);
create index if not exists idx_hermes_v2_deployments_canonical_job_id on hermes_v2_deployments (canonical_hermes_job_id);
create index if not exists idx_hermes_v2_deployments_environment_status on hermes_v2_deployments (environment, deploy_status);
create index if not exists idx_hermes_v2_deployments_git_commit_sha on hermes_v2_deployments (git_commit_sha);
create index if not exists idx_hermes_v2_deployments_created_at on hermes_v2_deployments (created_at);
create index if not exists idx_hermes_v2_deployments_callback_key on hermes_v2_deployments (callback_idempotency_key) where callback_idempotency_key is not null;

create index if not exists idx_hermes_v2_task_events_project_id_created_at on hermes_v2_task_events (project_id, created_at);
create index if not exists idx_hermes_v2_task_events_task_id_created_at on hermes_v2_task_events (task_id, created_at);
create index if not exists idx_hermes_v2_task_events_agent_id on hermes_v2_task_events (agent_id);
create index if not exists idx_hermes_v2_task_events_event_type on hermes_v2_task_events (event_type);
create index if not exists idx_hermes_v2_task_events_created_at on hermes_v2_task_events (created_at);
create unique index if not exists idx_hermes_v2_task_events_idempotency_key on hermes_v2_task_events (idempotency_key) where idempotency_key is not null;

create index if not exists idx_hermes_v2_feishu_sync_outbox_project_id on hermes_v2_feishu_sync_outbox (project_id);
create index if not exists idx_hermes_v2_feishu_sync_outbox_task_id on hermes_v2_feishu_sync_outbox (task_id);
create index if not exists idx_hermes_v2_feishu_sync_outbox_status on hermes_v2_feishu_sync_outbox (sync_status);
create index if not exists idx_hermes_v2_feishu_sync_outbox_status_next_attempt on hermes_v2_feishu_sync_outbox (sync_status, next_attempt_at);
create index if not exists idx_hermes_v2_feishu_sync_outbox_target on hermes_v2_feishu_sync_outbox (target_table_id, target_record_id);
create index if not exists idx_hermes_v2_feishu_sync_outbox_created_at on hermes_v2_feishu_sync_outbox (created_at);
create index if not exists idx_hermes_v2_feishu_sync_outbox_idempotency_key on hermes_v2_feishu_sync_outbox (idempotency_key) where idempotency_key is not null;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'hermes_v2_projects',
    'hermes_v2_tasks',
    'hermes_v2_agents',
    'hermes_v2_task_checkpoints',
    'hermes_v2_human_decisions',
    'hermes_v2_deployments',
    'hermes_v2_task_events',
    'hermes_v2_feishu_sync_outbox'
  ]
  loop
    if not exists (
      select 1
      from pg_trigger
      where tgname = 'trg_' || target_table || '_set_updated_at'
        and tgrelid = target_table::regclass
    ) then
      execute format(
        'create trigger %I before update on %I for each row execute function hermes_v2_set_updated_at()',
        'trg_' || target_table || '_set_updated_at',
        target_table
      );
    end if;
  end loop;
end;
$$;

create table if not exists hermes_v2_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid references hermes_v2_tasks(id),
  canonical_hermes_job_id uuid references hermes_jobs(id) on delete restrict,
  artifact_type text not null,
  name text not null,
  uri text,
  content_sha256 text,
  status text not null default 'candidate',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_artifacts_type_check check (
    artifact_type in ('requirement', 'plan', 'design', 'code', 'test_report', 'review', 'preview', 'release', 'rollback')
  ),
  constraint hermes_v2_artifacts_status_check check (
    status in ('candidate', 'verified', 'approved', 'rejected', 'superseded')
  ),
  constraint hermes_v2_artifacts_sha256_check check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create table if not exists hermes_v2_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid not null references hermes_v2_tasks(id),
  canonical_hermes_job_id uuid references hermes_jobs(id) on delete restrict,
  review_type text not null,
  reviewer_kind text not null default 'agent',
  reviewer_agent_id uuid references hermes_v2_agents(id),
  status text not null default 'pending',
  summary text,
  findings jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_reviews_type_check check (
    review_type in ('scope', 'design', 'code', 'test', 'security', 'preview', 'release')
  ),
  constraint hermes_v2_reviews_reviewer_kind_check check (
    reviewer_kind in ('agent', 'human', 'github_action', 'system')
  ),
  constraint hermes_v2_reviews_status_check check (
    status in ('pending', 'passed', 'changes_requested', 'approved', 'rejected')
  ),
  constraint hermes_v2_reviews_findings_array_check check (jsonb_typeof(findings) = 'array')
);

create table if not exists hermes_v2_project_memory (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  scope text not null,
  memory_key text not null,
  content jsonb not null,
  source_task_id uuid references hermes_v2_tasks(id),
  source_review_id uuid references hermes_v2_reviews(id),
  confidence numeric(4, 3) not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_project_memory_scope_check check (
    scope in ('requirement', 'product', 'design', 'architecture', 'delivery', 'incident', 'retrospective')
  ),
  constraint hermes_v2_project_memory_confidence_check check (confidence between 0 and 1),
  constraint hermes_v2_project_memory_key_unique unique (project_id, scope, memory_key)
);

alter table hermes_v2_human_decisions
  add column if not exists idempotency_key text;

create unique index if not exists idx_hermes_v2_tasks_source_external_id_unique
  on hermes_v2_tasks (source, source_external_id)
  where source_external_id is not null;

create unique index if not exists idx_hermes_v2_human_decisions_idempotency_unique
  on hermes_v2_human_decisions (idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_hermes_v2_artifacts_task_id
  on hermes_v2_artifacts (task_id, created_at);
create index if not exists idx_hermes_v2_artifacts_canonical_job_id
  on hermes_v2_artifacts (canonical_hermes_job_id);
create index if not exists idx_hermes_v2_reviews_task_id
  on hermes_v2_reviews (task_id, created_at);
create index if not exists idx_hermes_v2_reviews_canonical_job_id
  on hermes_v2_reviews (canonical_hermes_job_id);
create index if not exists idx_hermes_v2_reviews_status
  on hermes_v2_reviews (status);
create index if not exists idx_hermes_v2_project_memory_active
  on hermes_v2_project_memory (project_id, scope, is_active);

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'hermes_v2_artifacts',
    'hermes_v2_reviews',
    'hermes_v2_project_memory'
  ]
  loop
    if not exists (
      select 1
      from pg_trigger
      where tgname = 'trg_' || target_table || '_set_updated_at'
        and tgrelid = target_table::regclass
    ) then
      execute format(
        'create trigger %I before update on %I for each row execute function hermes_v2_set_updated_at()',
        'trg_' || target_table || '_set_updated_at',
        target_table
      );
    end if;
  end loop;
end;
$$;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'hermes_v2_projects',
    'hermes_v2_tasks',
    'hermes_v2_agents',
    'hermes_v2_task_checkpoints',
    'hermes_v2_human_decisions',
    'hermes_v2_deployments',
    'hermes_v2_task_events',
    'hermes_v2_feishu_sync_outbox',
    'hermes_v2_artifacts',
    'hermes_v2_reviews',
    'hermes_v2_project_memory'
  ]
  loop
    execute format('alter table public.%I enable row level security', target_table);
  end loop;
end;
$$;

create or replace function public.hermes_v2_create_requirement_v1(
  p_project_key text,
  p_project_name text,
  p_source text,
  p_source_external_id text,
  p_title text,
  p_request_text text,
  p_feishu_event_id text,
  p_feishu_message_id text,
  p_feishu_chat_id text,
  p_feishu_user_id text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project_id uuid;
  v_task_id uuid;
  v_duplicate boolean := false;
begin
  if nullif(pg_catalog.btrim(p_project_key), '') is null
    or nullif(pg_catalog.btrim(p_source_external_id), '') is null
    or nullif(pg_catalog.btrim(p_title), '') is null
    or nullif(pg_catalog.btrim(p_request_text), '') is null then
    raise exception using errcode = '22023', message = 'AUTONOMOUS_FACTORY_REQUIREMENT_INVALID';
  end if;

  insert into public.hermes_v2_projects (
    key,
    name,
    repository_full_name,
    repository_url,
    default_base_branch
  )
  values (
    p_project_key,
    coalesce(nullif(pg_catalog.btrim(p_project_name), ''), p_project_key),
    'chengyu1995/city-partner-platform',
    'https://github.com/chengyu1995/city-partner-platform.git',
    'develop'
  )
  on conflict (key) do update
    set name = excluded.name,
        updated_at = now()
  returning id into v_project_id;

  insert into public.hermes_v2_tasks (
    project_id,
    source,
    source_external_id,
    feishu_event_id,
    feishu_message_id,
    feishu_chat_id,
    feishu_user_id,
    task_type,
    task_level,
    role,
    title,
    request_text,
    repo,
    base_branch,
    status,
    stage,
    need_human_decision,
    metadata
  )
  values (
    v_project_id,
    p_source,
    p_source_external_id,
    p_feishu_event_id,
    p_feishu_message_id,
    p_feishu_chat_id,
    p_feishu_user_id,
    'requirement',
    'project',
    'project_director',
    p_title,
    p_request_text,
    'chengyu1995/city-partner-platform',
    'develop',
    'awaiting_human',
    'intake',
    true,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (source, source_external_id)
    where source_external_id is not null
    do nothing
  returning id into v_task_id;

  if v_task_id is null then
    v_duplicate := true;
    select id
      into v_task_id
      from public.hermes_v2_tasks
     where source = p_source
       and source_external_id = p_source_external_id;
  end if;

  insert into public.hermes_v2_task_events (
    project_id,
    task_id,
    event_type,
    to_status,
    message,
    payload,
    idempotency_key
  )
  values (
    v_project_id,
    v_task_id,
    'task.created',
    'awaiting_human',
    'Requirement captured by the autonomous factory intake.',
    jsonb_build_object('source', p_source),
    'requirement:' || p_source || ':' || p_source_external_id
  )
  on conflict (idempotency_key)
    where idempotency_key is not null
    do nothing;

  return jsonb_build_object(
    'project_id', v_project_id,
    'task_id', v_task_id,
    'duplicate', v_duplicate
  );
end;
$$;

create or replace function public.hermes_v2_store_plan_v1(
  p_project_id uuid,
  p_root_task_id uuid,
  p_plan_id text,
  p_plan jsonb,
  p_tasks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task jsonb;
  v_task_id uuid;
  v_task_key text;
  v_dependency_key text;
  v_dependency_ids jsonb;
  v_task_ids jsonb := '{}'::jsonb;
  v_acceptance text;
  v_inserted_count integer := 0;
  v_duplicate_count integer := 0;
begin
  if nullif(pg_catalog.btrim(p_plan_id), '') is null
    or coalesce(jsonb_typeof(p_tasks), 'null') <> 'array'
    or jsonb_array_length(p_tasks) = 0 then
    raise exception using errcode = '22023', message = 'AUTONOMOUS_FACTORY_PLAN_INVALID';
  end if;

  if not exists (
    select 1
      from public.hermes_v2_tasks
     where id = p_root_task_id
       and project_id = p_project_id
       and task_type = 'requirement'
  ) then
    raise exception using errcode = '22023', message = 'AUTONOMOUS_FACTORY_ROOT_NOT_FOUND';
  end if;

  for v_task in select value from jsonb_array_elements(p_tasks)
  loop
    v_task_id := null;
    v_task_key := nullif(pg_catalog.btrim(v_task ->> 'task_key'), '');
    if v_task_key is null then
      raise exception using errcode = '22023', message = 'AUTONOMOUS_FACTORY_TASK_KEY_REQUIRED';
    end if;

    select string_agg(value, E'\n- ')
      into v_acceptance
      from jsonb_array_elements_text(coalesce(v_task -> 'acceptance_criteria', '[]'::jsonb)) criteria(value);
    if v_acceptance is not null then
      v_acceptance := '- ' || v_acceptance;
    end if;

    insert into public.hermes_v2_tasks (
      project_id,
      parent_task_id,
      source,
      source_external_id,
      task_type,
      task_level,
      role,
      title,
      description,
      acceptance_criteria,
      repo,
      base_branch,
      status,
      stage,
      risk_level,
      need_human_decision,
      dependency_notes,
      metadata
    )
    values (
      p_project_id,
      p_root_task_id,
      'system',
      p_project_id::text || ':' || p_plan_id || ':' || v_task_key,
      'task',
      'task',
      v_task ->> 'agent_role',
      coalesce(nullif(v_task ->> 'title', ''), v_task_key),
      v_task ->> 'phase',
      v_acceptance,
      'chengyu1995/city-partner-platform',
      'develop',
      'draft',
      v_task ->> 'stage',
      coalesce(nullif(v_task ->> 'risk_level', ''), 'low'),
      coalesce((v_task ->> 'requires_boss_approval')::boolean, false),
      coalesce(v_task -> 'dependency_keys', '[]'::jsonb)::text,
      v_task
    )
    on conflict (source, source_external_id)
      where source_external_id is not null
      do nothing
    returning id into v_task_id;

    if v_task_id is null then
      v_duplicate_count := v_duplicate_count + 1;
      select id
        into v_task_id
        from public.hermes_v2_tasks
       where source = 'system'
         and source_external_id = p_project_id::text || ':' || p_plan_id || ':' || v_task_key;
    else
      v_inserted_count := v_inserted_count + 1;
    end if;

    v_task_ids := v_task_ids || jsonb_build_object(v_task_key, v_task_id::text);
  end loop;

  for v_task in select value from jsonb_array_elements(p_tasks)
  loop
    v_task_key := v_task ->> 'task_key';
    v_dependency_ids := '[]'::jsonb;
    for v_dependency_key in
      select value
        from jsonb_array_elements_text(coalesce(v_task -> 'dependency_keys', '[]'::jsonb)) dependencies(value)
    loop
      if not (v_task_ids ? v_dependency_key) then
        raise exception using errcode = '22023', message = 'AUTONOMOUS_FACTORY_DEPENDENCY_NOT_FOUND';
      end if;
      v_dependency_ids := v_dependency_ids || jsonb_build_array(v_task_ids ->> v_dependency_key);
    end loop;

    update public.hermes_v2_tasks
       set dependency_task_ids = v_dependency_ids,
           updated_at = now()
     where id = (v_task_ids ->> v_task_key)::uuid;
  end loop;

  update public.hermes_v2_tasks
     set metadata = metadata || jsonb_build_object('plan_id', p_plan_id, 'plan', coalesce(p_plan, '{}'::jsonb)),
         status_message = 'Plan captured; waiting for explicit human approval.',
         updated_at = now()
   where id = p_root_task_id;

  insert into public.hermes_v2_human_decisions (
    project_id,
    task_id,
    decision_type,
    decision_status,
    question,
    options,
    external_channel,
    idempotency_key,
    metadata
  )
  values (
    p_project_id,
    p_root_task_id,
    'approval',
    'waiting',
    'Approve this implementation plan for autonomous execution?',
    '["approve", "revise", "reject"]'::jsonb,
    'feishu',
    'plan-approval:' || p_project_id::text || ':' || p_plan_id,
    jsonb_build_object('plan_id', p_plan_id)
  )
  on conflict (idempotency_key)
    where idempotency_key is not null
    do nothing;

  insert into public.hermes_v2_task_events (
    project_id,
    task_id,
    event_type,
    from_status,
    to_status,
    message,
    payload,
    idempotency_key
  )
  values (
    p_project_id,
    p_root_task_id,
    'task.plan_stored',
    'awaiting_human',
    'awaiting_human',
    'Implementation plan captured; explicit approval is still required.',
    jsonb_build_object('plan_id', p_plan_id, 'task_count', jsonb_array_length(p_tasks)),
    'plan:' || p_project_id::text || ':' || p_plan_id
  )
  on conflict (idempotency_key)
    where idempotency_key is not null
    do nothing;

  return jsonb_build_object(
    'project_id', p_project_id,
    'root_task_id', p_root_task_id,
    'plan_id', p_plan_id,
    'inserted_tasks', v_inserted_count,
    'duplicate_tasks', v_duplicate_count,
    'task_ids', v_task_ids
  );
end;
$$;

create or replace function public.hermes_v2_capture_requirement_plan_v1(
  p_project_key text,
  p_project_name text,
  p_source text,
  p_source_external_id text,
  p_title text,
  p_request_text text,
  p_feishu_event_id text,
  p_feishu_message_id text,
  p_feishu_chat_id text,
  p_feishu_user_id text,
  p_metadata jsonb,
  p_plan_id text,
  p_plan jsonb,
  p_tasks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requirement jsonb;
  v_plan jsonb;
begin
  v_requirement := public.hermes_v2_create_requirement_v1(
    p_project_key,
    p_project_name,
    p_source,
    p_source_external_id,
    p_title,
    p_request_text,
    p_feishu_event_id,
    p_feishu_message_id,
    p_feishu_chat_id,
    p_feishu_user_id,
    p_metadata
  );

  v_plan := public.hermes_v2_store_plan_v1(
    (v_requirement ->> 'project_id')::uuid,
    (v_requirement ->> 'task_id')::uuid,
    p_plan_id,
    p_plan,
    p_tasks
  );

  return v_requirement || v_plan;
end;
$$;

revoke all on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) from public;
revoke all on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb) from public;
revoke all on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) from public;

grant execute on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) to service_role;
grant execute on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) to service_role;

-- Manual gate before applying this migration:
-- 1. Confirm the exact Supabase project and environment.
-- 2. Confirm V1 `hermes_jobs` remains available for rollback.
-- 3. Apply this migration before enabling HERMES_AUTONOMOUS_FACTORY_MODE.
-- 4. Start with shadow mode and verify task/event counts before authoritative mode.

commit;
