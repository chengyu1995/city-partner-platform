-- Hermes V2 schema draft for human review.
--
-- Safety scope:
-- - This file only creates new Hermes V2 tables with the `hermes_v2_` prefix.
-- - This file does not modify `hermes_jobs`.
-- - This file does not remove, rename, or clear any table or data.
-- - This file does not enable RLS or add RLS policies.
-- - A human must review this file in Supabase SQL Editor before manually running it.
-- - Codex, Worker, and other agents must not execute this SQL automatically.
--
-- Secret policy:
-- - Do not place real keys, tokens, app secrets, service-role values, or connection strings in this file.
-- - Feishu app/table identifiers in this schema are locators only, not secrets.

create extension if not exists pgcrypto;

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
  default_base_branch text not null default 'master',
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
  legacy_hermes_job_id uuid,
  legacy_job_id text,
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
  progress_percent integer not null default 0,
  current_step text,
  status_message text,
  risk_level text not null default 'low',
  need_human_decision boolean not null default false,
  requires_human_decision boolean generated always as (need_human_decision) stored,
  blocked_reason text,
  dependency_task_ids jsonb not null default '[]'::jsonb,
  dependency_notes text,
  max_attempts integer not null default 3,
  attempt_count integer not null default 0,
  last_attempt_id uuid,
  claimed_by text,
  last_error_text text,
  result_summary text,
  result_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_tasks_source_check check (source in ('feishu_event', 'feishu_bitable', 'manual', 'api', 'system')),
  constraint hermes_v2_tasks_status_check check (status in ('draft', 'queued', 'running', 'awaiting_human', 'awaiting_review', 'retrying', 'succeeded', 'failed', 'cancelled')),
  constraint hermes_v2_tasks_task_type_check check (task_type in ('requirement', 'parent_task', 'phase', 'task', 'subtask', 'bugfix', 'review', 'maintenance')),
  constraint hermes_v2_tasks_task_level_check check (task_level in ('project', 'phase', 'task', 'subtask', 'checkpoint')),
  constraint hermes_v2_tasks_risk_level_check check (risk_level in ('low', 'medium', 'high', 'critical')),
  constraint hermes_v2_tasks_progress_percent_check check (progress_percent between 0 and 100),
  constraint hermes_v2_tasks_attempt_count_check check (attempt_count >= 0),
  constraint hermes_v2_tasks_max_attempts_check check (max_attempts >= 1),
  constraint hermes_v2_tasks_dependency_task_ids_array_check check (jsonb_typeof(dependency_task_ids) = 'array')
);

comment on table hermes_v2_tasks is 'Hermes V2 canonical task tree node for requirements, phases, tasks, and executable subtasks.';
comment on column hermes_v2_tasks.legacy_hermes_job_id is 'Optional V1 hermes_jobs UUID retained for compatibility only; this script does not add a foreign key to hermes_jobs.';
comment on column hermes_v2_tasks.dependency_task_ids is 'JSONB array of V2 task UUID strings. Phase 2C intentionally does not enforce per-item foreign keys; API/Worker must validate existence and acyclicity in later phases.';
comment on column hermes_v2_tasks.last_attempt_id is 'Latest V2 attempt id for quick reads. No foreign key is enforced in this draft to avoid a circular create-table dependency.';
comment on column hermes_v2_tasks.claimed_by is 'Latest worker or agent external identifier mirrored for queue filtering; canonical ownership belongs to hermes_v2_task_attempts.';

create table if not exists hermes_v2_agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references hermes_v2_projects(id),
  current_task_id uuid references hermes_v2_tasks(id),
  name text not null,
  role text not null,
  agent_type text not null default 'worker',
  external_id text,
  capabilities jsonb not null default '[]'::jsonb,
  status text not null default 'offline',
  heartbeat_at timestamptz,
  last_seen_at timestamptz,
  consecutive_failure_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_agents_status_check check (status in ('active', 'disabled', 'offline')),
  constraint hermes_v2_agents_agent_type_check check (agent_type in ('worker', 'codex', 'hermes', 'human', 'github_action', 'system')),
  constraint hermes_v2_agents_consecutive_failure_count_check check (consecutive_failure_count >= 0),
  constraint hermes_v2_agents_capabilities_array_check check (jsonb_typeof(capabilities) = 'array')
);

comment on table hermes_v2_agents is 'Registered automated and human actors that claim, review, or report V2 task work.';
comment on column hermes_v2_agents.current_task_id is 'Current V2 task assignment when the agent is online or running.';
comment on column hermes_v2_agents.heartbeat_at is 'Latest online heartbeat timestamp.';
comment on column hermes_v2_agents.consecutive_failure_count is 'Number of consecutive failed attempts or health checks for operational visibility.';

create table if not exists hermes_v2_task_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references hermes_v2_tasks(id),
  agent_id uuid references hermes_v2_agents(id),
  attempt_number integer not null,
  retry_count integer not null default 0,
  status text not null default 'claimed',
  claim_token text,
  worker_name text,
  worker_version text,
  worker_host text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  progress_percent integer not null default 0,
  current_step text,
  status_message text,
  base_git_sha text,
  result_git_sha text,
  git_commit_sha text,
  branch_name text,
  commit_message text,
  exit_code integer,
  duration_ms integer,
  stdout_ref text,
  stderr_ref text,
  result_text text,
  result_payload jsonb not null default '{}'::jsonb,
  error_text text,
  failure_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hermes_v2_task_attempts_task_attempt_unique unique (task_id, attempt_number),
  constraint hermes_v2_task_attempts_status_check check (status in ('claimed', 'running', 'heartbeat_stale', 'succeeded', 'failed', 'timed_out', 'cancelled', 'superseded')),
  constraint hermes_v2_task_attempts_progress_percent_check check (progress_percent between 0 and 100),
  constraint hermes_v2_task_attempts_attempt_number_check check (attempt_number >= 1),
  constraint hermes_v2_task_attempts_retry_count_check check (retry_count >= 0),
  constraint hermes_v2_task_attempts_duration_ms_check check (duration_ms is null or duration_ms >= 0)
);

comment on table hermes_v2_task_attempts is 'One Worker or Codex execution attempt per V2 task claim.';
comment on column hermes_v2_task_attempts.claim_token is 'Claim ownership token. Later Worker/API phases must decide whether this becomes mandatory for all runnable attempts.';
comment on column hermes_v2_task_attempts.retry_count is 'Retry count observed for this attempt or retry cycle.';
comment on column hermes_v2_task_attempts.exit_code is 'Codex or Worker process exit code.';
comment on column hermes_v2_task_attempts.error_text is 'Short actionable error text.';

create table if not exists hermes_v2_task_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references hermes_v2_tasks(id),
  attempt_id uuid references hermes_v2_task_attempts(id),
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
  attempt_id uuid references hermes_v2_task_attempts(id),
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
  attempt_id uuid references hermes_v2_task_attempts(id),
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

comment on table hermes_v2_deployments is 'Deployment status records linked to task attempts and Git commits.';
comment on column hermes_v2_deployments.preview_url is 'Preview URL when the environment is preview or staging.';
comment on column hermes_v2_deployments.production_url is 'Production URL when the environment is production.';
comment on column hermes_v2_deployments.git_commit_sha is 'Commit SHA associated with this deployment.';

create table if not exists hermes_v2_task_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid not null references hermes_v2_tasks(id),
  attempt_id uuid references hermes_v2_task_attempts(id),
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
    'task.queued',
    'task.claimed',
    'task.progressed',
    'task.awaiting_human',
    'task.review_requested',
    'task.succeeded',
    'task.failed',
    'task.cancelled',
    'attempt.heartbeat',
    'attempt.progressed',
    'attempt.failed',
    'attempt.timed_out',
    'human_decision.requested',
    'human_decision.resolved',
    'deployment.updated',
    'feishu.sync_queued',
    'feishu.sync_failed',
    'feishu.sync_succeeded',
    'retry.scheduled',
    'error.recorded'
  )),
  constraint hermes_v2_task_events_severity_check check (severity in ('debug', 'info', 'warning', 'error'))
);

comment on table hermes_v2_task_events is 'Append-oriented audit stream for task, attempt, progress, heartbeat, error, retry, decision, deployment, and Feishu sync events.';

create table if not exists hermes_v2_feishu_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references hermes_v2_projects(id),
  task_id uuid references hermes_v2_tasks(id),
  attempt_id uuid references hermes_v2_task_attempts(id),
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
  constraint hermes_v2_feishu_sync_outbox_sync_type_check check (sync_type in ('task_status', 'attempt_progress', 'deployment_status', 'decision_request', 'message_reply', 'heartbeat_health')),
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
create index if not exists idx_hermes_v2_tasks_claimed_by on hermes_v2_tasks (claimed_by);
create index if not exists idx_hermes_v2_tasks_created_at on hermes_v2_tasks (created_at);
create index if not exists idx_hermes_v2_tasks_need_human_decision on hermes_v2_tasks (need_human_decision) where need_human_decision = true;
create index if not exists idx_hermes_v2_tasks_task_level on hermes_v2_tasks (task_level);
create index if not exists idx_hermes_v2_tasks_risk_level on hermes_v2_tasks (risk_level);
create index if not exists idx_hermes_v2_tasks_legacy_hermes_job_id on hermes_v2_tasks (legacy_hermes_job_id);
create index if not exists idx_hermes_v2_tasks_feishu_record_id on hermes_v2_tasks (feishu_record_id);
create index if not exists idx_hermes_v2_tasks_dependency_task_ids on hermes_v2_tasks using gin (dependency_task_ids);

create index if not exists idx_hermes_v2_agents_project_id on hermes_v2_agents (project_id);
create index if not exists idx_hermes_v2_agents_current_task_id on hermes_v2_agents (current_task_id);
create index if not exists idx_hermes_v2_agents_name on hermes_v2_agents (name);
create index if not exists idx_hermes_v2_agents_role on hermes_v2_agents (role);
create index if not exists idx_hermes_v2_agents_role_status on hermes_v2_agents (role, status);
create index if not exists idx_hermes_v2_agents_heartbeat_at on hermes_v2_agents (heartbeat_at);
create index if not exists idx_hermes_v2_agents_status on hermes_v2_agents (status);

create index if not exists idx_hermes_v2_task_attempts_task_id on hermes_v2_task_attempts (task_id, attempt_number);
create index if not exists idx_hermes_v2_task_attempts_agent_id on hermes_v2_task_attempts (agent_id);
create index if not exists idx_hermes_v2_task_attempts_status on hermes_v2_task_attempts (status);
create index if not exists idx_hermes_v2_task_attempts_worker_name on hermes_v2_task_attempts (worker_name);
create index if not exists idx_hermes_v2_task_attempts_heartbeat_at on hermes_v2_task_attempts (heartbeat_at);
create index if not exists idx_hermes_v2_task_attempts_created_at on hermes_v2_task_attempts (created_at);
create index if not exists idx_hermes_v2_task_attempts_git_commit_sha on hermes_v2_task_attempts (git_commit_sha);

create index if not exists idx_hermes_v2_task_checkpoints_task_id on hermes_v2_task_checkpoints (task_id, checkpoint_order);
create index if not exists idx_hermes_v2_task_checkpoints_attempt_id on hermes_v2_task_checkpoints (attempt_id);
create index if not exists idx_hermes_v2_task_checkpoints_status on hermes_v2_task_checkpoints (status);
create index if not exists idx_hermes_v2_task_checkpoints_created_at on hermes_v2_task_checkpoints (created_at);

create index if not exists idx_hermes_v2_human_decisions_project_id on hermes_v2_human_decisions (project_id);
create index if not exists idx_hermes_v2_human_decisions_task_id on hermes_v2_human_decisions (task_id);
create index if not exists idx_hermes_v2_human_decisions_attempt_id on hermes_v2_human_decisions (attempt_id);
create index if not exists idx_hermes_v2_human_decisions_status on hermes_v2_human_decisions (decision_status);
create index if not exists idx_hermes_v2_human_decisions_created_at on hermes_v2_human_decisions (created_at);
create index if not exists idx_hermes_v2_human_decisions_decided_at on hermes_v2_human_decisions (decided_at);

create index if not exists idx_hermes_v2_deployments_project_id on hermes_v2_deployments (project_id);
create index if not exists idx_hermes_v2_deployments_task_id on hermes_v2_deployments (task_id);
create index if not exists idx_hermes_v2_deployments_attempt_id on hermes_v2_deployments (attempt_id);
create index if not exists idx_hermes_v2_deployments_environment_status on hermes_v2_deployments (environment, deploy_status);
create index if not exists idx_hermes_v2_deployments_git_commit_sha on hermes_v2_deployments (git_commit_sha);
create index if not exists idx_hermes_v2_deployments_created_at on hermes_v2_deployments (created_at);
create index if not exists idx_hermes_v2_deployments_callback_key on hermes_v2_deployments (callback_idempotency_key) where callback_idempotency_key is not null;

create index if not exists idx_hermes_v2_task_events_project_id_created_at on hermes_v2_task_events (project_id, created_at);
create index if not exists idx_hermes_v2_task_events_task_id_created_at on hermes_v2_task_events (task_id, created_at);
create index if not exists idx_hermes_v2_task_events_attempt_id on hermes_v2_task_events (attempt_id);
create index if not exists idx_hermes_v2_task_events_agent_id on hermes_v2_task_events (agent_id);
create index if not exists idx_hermes_v2_task_events_event_type on hermes_v2_task_events (event_type);
create index if not exists idx_hermes_v2_task_events_created_at on hermes_v2_task_events (created_at);
create index if not exists idx_hermes_v2_task_events_idempotency_key on hermes_v2_task_events (idempotency_key) where idempotency_key is not null;

create index if not exists idx_hermes_v2_feishu_sync_outbox_project_id on hermes_v2_feishu_sync_outbox (project_id);
create index if not exists idx_hermes_v2_feishu_sync_outbox_task_id on hermes_v2_feishu_sync_outbox (task_id);
create index if not exists idx_hermes_v2_feishu_sync_outbox_attempt_id on hermes_v2_feishu_sync_outbox (attempt_id);
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
    'hermes_v2_task_attempts',
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

-- Manual review checklist before any human-run database application:
-- 1. Confirm the target environment is local, staging, or production, and obtain owner approval for that environment.
-- 2. Confirm a fresh backup or restore point exists, and document the rollback owner.
-- 3. Confirm V1 `hermes_jobs` remains untouched and V1 runtime mode remains available.
-- 4. Confirm the 9 new `hermes_v2_` tables do not conflict with existing business tables.
-- 5. Confirm `pgcrypto` and `gen_random_uuid()` are available in the target Supabase project.
-- 6. Confirm all status values match the Phase 1 task state machine documents.
-- 7. Confirm no real key, token, app secret, service-role value, or connection string is present.
-- 8. Confirm RLS is intentionally deferred to a later approved phase.
-- 9. Confirm application, Worker, API, Feishu, and deployment code remain unchanged until separately approved phases.
