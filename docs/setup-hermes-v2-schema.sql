-- Hermes V2 schema draft.
-- 本 SQL 仅供人工审核，不得由 Agent 自动执行。
-- Scope: create the proposed V2 tables only. This file does not modify V1 tables or runtime behavior.
-- Secret policy: do not place real keys, tokens, app secrets, service-role values, or connection strings in this file.

create table if not exists projects (
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
  constraint projects_key_unique unique (key),
  constraint projects_status_check check (status in ('active', 'paused', 'archived'))
);

comment on table projects is 'Hermes V2 project context, repository defaults, and non-secret integration locators.';
comment on column projects.id is 'Primary project identifier.';
comment on column projects.key is 'Stable short project key used for routing and display.';
comment on column projects.name is 'Human-readable project name.';
comment on column projects.description is 'Business outcome or project summary.';
comment on column projects.repository_full_name is 'Repository in owner/name form when available.';
comment on column projects.repository_url is 'Repository URL for traceability.';
comment on column projects.default_base_branch is 'Default base branch for Worker or PR policy.';
comment on column projects.default_worktree_path is 'Expected local Worker worktree path.';
comment on column projects.production_url is 'Production site URL for display only.';
comment on column projects.preview_url_pattern is 'Optional preview URL pattern or provider metadata.';
comment on column projects.feishu_app_token is 'Non-secret Feishu app locator; app secrets stay outside the database.';
comment on column projects.feishu_task_table_id is 'Non-secret Feishu Bitable task table locator.';
comment on column projects.settings is 'Non-secret project settings and feature flags.';
comment on column projects.status is 'Project lifecycle: active, paused, or archived.';
comment on column projects.created_at is 'Record creation timestamp.';
comment on column projects.updated_at is 'Last project metadata update timestamp.';

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  parent_task_id uuid references tasks(id),
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
  dependency_task_ids uuid[] not null default '{}'::uuid[],
  dependency_notes text,
  max_attempts integer not null default 3,
  attempt_count integer not null default 0,
  last_attempt_id uuid,
  last_error_text text,
  result_summary text,
  result_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_status_check check (status in ('draft', 'queued', 'running', 'awaiting_human', 'awaiting_review', 'retrying', 'succeeded', 'failed', 'cancelled')),
  constraint tasks_task_type_check check (task_type in ('requirement', 'parent_task', 'phase', 'task', 'subtask', 'bugfix', 'review', 'maintenance')),
  constraint tasks_task_level_check check (task_level in ('project', 'phase', 'task', 'subtask', 'checkpoint')),
  constraint tasks_risk_level_check check (risk_level in ('low', 'medium', 'high', 'critical')),
  constraint tasks_progress_percent_check check (progress_percent between 0 and 100),
  constraint tasks_attempt_count_check check (attempt_count >= 0),
  constraint tasks_max_attempts_check check (max_attempts >= 1)
);

comment on table tasks is 'Hermes V2 canonical task tree node for requirements, phases, tasks, and executable subtasks.';
comment on column tasks.id is 'Primary task identifier.';
comment on column tasks.project_id is 'Owning V2 project.';
comment on column tasks.parent_task_id is 'Parent task for task-tree decomposition.';
comment on column tasks.legacy_hermes_job_id is 'Optional V1 hermes_jobs UUID retained for compatibility.';
comment on column tasks.legacy_job_id is 'Optional V1 external job_id retained for compatibility.';
comment on column tasks.source is 'Origin such as feishu_event, feishu_bitable, manual, api, or system.';
comment on column tasks.source_external_id is 'Stable source-side idempotency or traceability identifier.';
comment on column tasks.feishu_event_id is 'Feishu event ID for traceability.';
comment on column tasks.feishu_message_id is 'Feishu message ID when created from chat.';
comment on column tasks.feishu_chat_id is 'Feishu chat ID for reply context.';
comment on column tasks.feishu_user_id is 'Feishu requester or operator ID.';
comment on column tasks.feishu_record_id is 'Primary Feishu Bitable row binding for Task Details.';
comment on column tasks.task_type is 'Work type such as requirement, parent task, task, subtask, bugfix, review, or maintenance.';
comment on column tasks.task_level is 'Logical tree level: project, phase, task, subtask, or checkpoint.';
comment on column tasks.role is 'Responsible role or routing hint for Hermes, Codex, Worker, reviewer, or owner.';
comment on column tasks.title is 'Short task title.';
comment on column tasks.description is 'Full task description.';
comment on column tasks.request_text is 'Original user request text preserved for traceability.';
comment on column tasks.acceptance_criteria is 'Human-readable completion criteria.';
comment on column tasks.prompt is 'Worker or Codex prompt body when separate from description.';
comment on column tasks.repo is 'Repository override when different from project default.';
comment on column tasks.base_branch is 'Base branch override.';
comment on column tasks.target_branch is 'Expected feature or target branch for Worker output.';
comment on column tasks.priority is 'Lower values are higher priority.';
comment on column tasks.status is 'Canonical V2 task status.';
comment on column tasks.stage is 'User-facing stage label such as queued, coding, review, deploying, or done.';
comment on column tasks.progress_percent is 'Current display progress from 0 to 100.';
comment on column tasks.current_step is 'Short current execution or review step.';
comment on column tasks.status_message is 'Latest human-readable task status message.';
comment on column tasks.risk_level is 'Automation risk level: low, medium, high, or critical.';
comment on column tasks.need_human_decision is 'Whether execution is blocked on human approval or clarification.';
comment on column tasks.requires_human_decision is 'Compatibility alias generated from need_human_decision.';
comment on column tasks.blocked_reason is 'Current blocking reason when the task cannot proceed.';
comment on column tasks.dependency_task_ids is 'Task dependency list represented as UUID references.';
comment on column tasks.dependency_notes is 'Human-readable dependency explanation or policy.';
comment on column tasks.max_attempts is 'Maximum allowed execution attempts.';
comment on column tasks.attempt_count is 'Number of attempts created so far.';
comment on column tasks.last_attempt_id is 'Latest attempt id for quick reads.';
comment on column tasks.last_error_text is 'Latest summarized failure text.';
comment on column tasks.result_summary is 'Latest or final human-readable result summary.';
comment on column tasks.result_payload is 'Structured result data such as checks, changed files, PR, or preview links.';
comment on column tasks.metadata is 'Extensible non-secret routing, display, and compatibility metadata.';
comment on column tasks.queued_at is 'When the task entered the runnable queue.';
comment on column tasks.started_at is 'First execution start timestamp.';
comment on column tasks.completed_at is 'Terminal completion timestamp.';
comment on column tasks.created_at is 'Record creation timestamp.';
comment on column tasks.updated_at is 'Last task update timestamp.';

create table if not exists task_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  attempt_id uuid,
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
  created_by_agent_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_checkpoints_status_check check (status in ('pending', 'running', 'passed', 'failed', 'skipped', 'not_checked')),
  constraint task_checkpoints_validation_status_check check (validation_status in ('passed', 'failed', 'not_checked')),
  constraint task_checkpoints_progress_percent_check check (progress_percent between 0 and 100)
);

comment on table task_checkpoints is 'Checkpoint metadata for V2 task proofs, validation gates, and rollback anchors.';
comment on column task_checkpoints.id is 'Primary checkpoint identifier.';
comment on column task_checkpoints.task_id is 'Related task.';
comment on column task_checkpoints.attempt_id is 'Related attempt when checkpoint is attempt-specific.';
comment on column task_checkpoints.checkpoint_order is 'Stable order within a task or attempt.';
comment on column task_checkpoints.checkpoint_type is 'Checkpoint category such as pre_attempt, validation, review, or completion.';
comment on column task_checkpoints.title is 'Short checkpoint title.';
comment on column task_checkpoints.status is 'Checkpoint status for planning and validation display.';
comment on column task_checkpoints.progress_percent is 'Checkpoint-level display progress from 0 to 100.';
comment on column task_checkpoints.git_ref is 'Branch or ref observed at checkpoint time.';
comment on column task_checkpoints.git_sha is 'Commit SHA observed at checkpoint time.';
comment on column task_checkpoints.worktree_path is 'Worker worktree path observed for the checkpoint.';
comment on column task_checkpoints.is_worktree_clean is 'Whether the Worker observed a clean worktree.';
comment on column task_checkpoints.changed_paths is 'JSON array of changed paths observed at checkpoint.';
comment on column task_checkpoints.untracked_paths is 'JSON array of untracked paths observed at checkpoint.';
comment on column task_checkpoints.validation_status is 'Validation result: passed, failed, or not_checked.';
comment on column task_checkpoints.validation_notes is 'Short validation details or blocker notes.';
comment on column task_checkpoints.evidence_ref is 'External evidence reference for logs, screenshots, or reports.';
comment on column task_checkpoints.created_by_agent_id is 'Agent that created the checkpoint metadata.';
comment on column task_checkpoints.created_at is 'Record creation timestamp.';
comment on column task_checkpoints.updated_at is 'Last checkpoint update timestamp.';

create table if not exists task_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  agent_id uuid,
  attempt_number integer not null,
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
  constraint task_attempts_status_check check (status in ('claimed', 'running', 'heartbeat_stale', 'succeeded', 'failed', 'timed_out', 'cancelled', 'superseded')),
  constraint task_attempts_progress_percent_check check (progress_percent between 0 and 100),
  constraint task_attempts_attempt_number_check check (attempt_number >= 1),
  constraint task_attempts_duration_ms_check check (duration_ms is null or duration_ms >= 0)
);

comment on table task_attempts is 'One Worker or Codex execution attempt per V2 task claim.';
comment on column task_attempts.id is 'Primary attempt identifier.';
comment on column task_attempts.task_id is 'Related task.';
comment on column task_attempts.agent_id is 'Worker or agent that owns the attempt.';
comment on column task_attempts.attempt_number is '1-based attempt number per task.';
comment on column task_attempts.status is 'Attempt-local execution status.';
comment on column task_attempts.claim_token is 'Claim ownership token; do not expose in Feishu display.';
comment on column task_attempts.worker_name is 'Worker display name.';
comment on column task_attempts.worker_version is 'Worker version or script revision.';
comment on column task_attempts.worker_host is 'Optional Worker host identifier.';
comment on column task_attempts.lease_expires_at is 'Claim lease expiry timestamp.';
comment on column task_attempts.heartbeat_at is 'Latest Worker heartbeat timestamp.';
comment on column task_attempts.started_at is 'Attempt start timestamp.';
comment on column task_attempts.finished_at is 'Attempt finish timestamp.';
comment on column task_attempts.progress_percent is 'Attempt-local progress from 0 to 100.';
comment on column task_attempts.current_step is 'Attempt-local current step.';
comment on column task_attempts.status_message is 'Latest attempt-local status message.';
comment on column task_attempts.base_git_sha is 'Commit SHA before Worker or Codex execution.';
comment on column task_attempts.result_git_sha is 'Commit SHA produced by the attempt, if any.';
comment on column task_attempts.git_commit_sha is 'Compatibility commit SHA field required by Phase 2A.';
comment on column task_attempts.branch_name is 'Branch or ref used by Worker.';
comment on column task_attempts.commit_message is 'Commit message produced by Worker, if any.';
comment on column task_attempts.exit_code is 'Codex or Worker process exit code.';
comment on column task_attempts.duration_ms is 'Attempt duration in milliseconds.';
comment on column task_attempts.stdout_ref is 'External artifact reference for stdout.';
comment on column task_attempts.stderr_ref is 'External artifact reference for stderr.';
comment on column task_attempts.result_text is 'Short result text.';
comment on column task_attempts.result_payload is 'Structured Worker result report.';
comment on column task_attempts.error_text is 'Short error text.';
comment on column task_attempts.failure_category is 'Failure category such as codex, git, validation, timeout, worker, api, or unknown.';
comment on column task_attempts.created_at is 'Record creation timestamp.';
comment on column task_attempts.updated_at is 'Last attempt update timestamp.';

create table if not exists task_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  task_id uuid not null references tasks(id),
  attempt_id uuid,
  agent_id uuid,
  human_decision_id uuid,
  deployment_id uuid,
  event_type text not null,
  from_status text,
  to_status text,
  severity text not null default 'info',
  message text,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_events_severity_check check (severity in ('debug', 'info', 'warning', 'error'))
);

comment on table task_events is 'Append-oriented audit stream for task, attempt, decision, deployment, and Feishu sync events.';
comment on column task_events.id is 'Primary event identifier.';
comment on column task_events.project_id is 'Project context for filtering.';
comment on column task_events.task_id is 'Related task.';
comment on column task_events.attempt_id is 'Related attempt when applicable.';
comment on column task_events.agent_id is 'Actor that produced the event.';
comment on column task_events.human_decision_id is 'Related human decision when applicable.';
comment on column task_events.deployment_id is 'Related deployment when applicable.';
comment on column task_events.event_type is 'Machine-readable event name such as task.created or attempt.heartbeat.';
comment on column task_events.from_status is 'Previous status when the event records a transition.';
comment on column task_events.to_status is 'New status when the event records a transition.';
comment on column task_events.severity is 'Event severity: debug, info, warning, or error.';
comment on column task_events.message is 'Human-readable event summary.';
comment on column task_events.payload is 'Structured event payload.';
comment on column task_events.idempotency_key is 'Optional event deduplication key.';
comment on column task_events.created_at is 'Record creation timestamp.';
comment on column task_events.updated_at is 'Last event metadata update timestamp.';

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  agent_name text not null,
  role text not null,
  agent_type text not null default 'worker',
  external_id text,
  capabilities jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  heartbeat_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agents_status_check check (status in ('active', 'disabled', 'offline')),
  constraint agents_agent_type_check check (agent_type in ('worker', 'codex', 'hermes', 'human', 'github_action', 'system'))
);

comment on table agents is 'Registered automated and human actors that claim, review, or report V2 task work.';
comment on column agents.id is 'Primary agent identifier.';
comment on column agents.project_id is 'Optional project scope for the agent.';
comment on column agents.agent_name is 'Display name for the agent or human actor.';
comment on column agents.role is 'Role used for routing, review, execution, or ownership.';
comment on column agents.agent_type is 'Actor type: worker, codex, hermes, human, github_action, or system.';
comment on column agents.external_id is 'Worker name, Feishu user ID, GitHub login, or system identifier.';
comment on column agents.capabilities is 'Declared non-secret capabilities.';
comment on column agents.status is 'Agent lifecycle: active, disabled, or offline.';
comment on column agents.heartbeat_at is 'Latest heartbeat timestamp from the agent.';
comment on column agents.last_seen_at is 'Latest observed activity timestamp.';
comment on column agents.metadata is 'Non-secret actor metadata.';
comment on column agents.created_at is 'Record creation timestamp.';
comment on column agents.updated_at is 'Last agent metadata update timestamp.';

create table if not exists human_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  task_id uuid not null references tasks(id),
  attempt_id uuid,
  decision_type text not null default 'clarification',
  decision_status text not null default 'requested',
  question text not null,
  options jsonb not null default '[]'::jsonb,
  selected_option text,
  decision_text text,
  requested_by_agent_id uuid,
  decided_by_agent_id uuid,
  external_channel text,
  external_message_id text,
  expires_at timestamptz,
  decided_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint human_decisions_type_check check (decision_type in ('clarification', 'approval', 'rejection', 'review', 'risk_acceptance', 'production_gate')),
  constraint human_decisions_status_check check (decision_status in ('requested', 'approved', 'rejected', 'answered', 'cancelled', 'expired'))
);

comment on table human_decisions is 'First-class human approval, rejection, clarification, review, and production gate records.';
comment on column human_decisions.id is 'Primary decision identifier.';
comment on column human_decisions.project_id is 'Project context.';
comment on column human_decisions.task_id is 'Related task.';
comment on column human_decisions.attempt_id is 'Related attempt when decision is attempt-specific.';
comment on column human_decisions.decision_type is 'Decision category such as clarification, approval, review, or production gate.';
comment on column human_decisions.decision_status is 'Decision lifecycle status.';
comment on column human_decisions.question is 'Exact question shown to the human.';
comment on column human_decisions.options is 'Structured options presented to the human.';
comment on column human_decisions.selected_option is 'Selected option key or label.';
comment on column human_decisions.decision_text is 'Free-form decision answer or summary.';
comment on column human_decisions.requested_by_agent_id is 'Agent that requested the decision.';
comment on column human_decisions.decided_by_agent_id is 'Human or delegated agent that decided.';
comment on column human_decisions.external_channel is 'Decision channel such as feishu, github, manual, or api.';
comment on column human_decisions.external_message_id is 'External message or comment locator.';
comment on column human_decisions.expires_at is 'Optional decision deadline.';
comment on column human_decisions.decided_at is 'Timestamp when the decision was selected.';
comment on column human_decisions.resolved_at is 'Timestamp when the decision record became resolved.';
comment on column human_decisions.metadata is 'Non-secret decision metadata, risk, evidence, or rollback references.';
comment on column human_decisions.created_at is 'Record creation timestamp.';
comment on column human_decisions.updated_at is 'Last decision update timestamp.';

create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  task_id uuid references tasks(id),
  attempt_id uuid,
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
  constraint deployments_environment_check check (environment in ('preview', 'staging', 'production', 'unknown')),
  constraint deployments_status_check check (deploy_status in ('pending', 'building', 'ready', 'failed', 'cancelled', 'unknown')),
  constraint deployments_provider_check check (provider in ('vercel', 'github', 'manual', 'other'))
);

comment on table deployments is 'Deployment status records linked to task attempts and Git commits.';
comment on column deployments.id is 'Primary deployment identifier.';
comment on column deployments.project_id is 'Project context.';
comment on column deployments.task_id is 'Related task when available.';
comment on column deployments.attempt_id is 'Attempt that produced or observed the deployment.';
comment on column deployments.provider is 'Deployment provider such as vercel, github, manual, or other.';
comment on column deployments.environment is 'Deployment environment: preview, staging, production, or unknown.';
comment on column deployments.deploy_status is 'Deployment lifecycle status.';
comment on column deployments.git_commit_sha is 'Commit SHA associated with this deployment.';
comment on column deployments.git_branch is 'Branch or ref deployed.';
comment on column deployments.preview_url is 'Preview URL when the environment is preview or staging.';
comment on column deployments.production_url is 'Production URL when the environment is production.';
comment on column deployments.deployment_url is 'Provider deployment URL or canonical display URL.';
comment on column deployments.provider_deployment_id is 'Provider-side deployment identifier.';
comment on column deployments.callback_idempotency_key is 'Deduplication key for provider callbacks.';
comment on column deployments.started_at is 'Deployment start timestamp.';
comment on column deployments.finished_at is 'Deployment finish timestamp.';
comment on column deployments.last_callback_at is 'Latest provider callback timestamp.';
comment on column deployments.error_text is 'Short deployment failure summary.';
comment on column deployments.payload is 'Structured provider callback or deployment metadata.';
comment on column deployments.created_at is 'Record creation timestamp.';
comment on column deployments.updated_at is 'Last deployment update timestamp.';

create table if not exists feishu_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  task_id uuid references tasks(id),
  attempt_id uuid,
  deployment_id uuid,
  human_decision_id uuid,
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
  constraint feishu_sync_outbox_status_check check (sync_status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  constraint feishu_sync_outbox_retry_count_check check (retry_count >= 0),
  constraint feishu_sync_outbox_max_attempts_check check (max_attempts >= 1)
);

comment on table feishu_sync_outbox is 'Durable Feishu and Bitable writeback queue with bounded retry metadata.';
comment on column feishu_sync_outbox.id is 'Primary outbox item identifier.';
comment on column feishu_sync_outbox.project_id is 'Project context.';
comment on column feishu_sync_outbox.task_id is 'Related task when applicable.';
comment on column feishu_sync_outbox.attempt_id is 'Related attempt when applicable.';
comment on column feishu_sync_outbox.deployment_id is 'Related deployment when applicable.';
comment on column feishu_sync_outbox.human_decision_id is 'Related human decision when applicable.';
comment on column feishu_sync_outbox.sync_type is 'Logical sync category such as task_status, attempt_progress, deployment_status, decision_request, or message_reply.';
comment on column feishu_sync_outbox.target_type is 'External target type such as bitable_record, chat_message, comment, or unknown.';
comment on column feishu_sync_outbox.target_table is 'Display target table name or logical table purpose.';
comment on column feishu_sync_outbox.target_table_id is 'Feishu Bitable table locator.';
comment on column feishu_sync_outbox.target_record_id is 'Feishu Bitable record locator.';
comment on column feishu_sync_outbox.target_app_token is 'Non-secret Feishu app token locator.';
comment on column feishu_sync_outbox.target_chat_id is 'Feishu chat target for message sync.';
comment on column feishu_sync_outbox.target_message_id is 'Feishu message target for update or reply sync.';
comment on column feishu_sync_outbox.operation is 'Requested external operation such as upsert_record, update_record, or send_message.';
comment on column feishu_sync_outbox.payload is 'Structured sync payload required by Phase 2A.';
comment on column feishu_sync_outbox.desired_payload is 'Desired Feishu field update or message body.';
comment on column feishu_sync_outbox.sync_status is 'Outbox status: pending, processing, succeeded, failed, or cancelled.';
comment on column feishu_sync_outbox.retry_count is 'Number of sync attempts already made.';
comment on column feishu_sync_outbox.max_attempts is 'Retry limit for this sync item.';
comment on column feishu_sync_outbox.next_attempt_at is 'Scheduled retry timestamp.';
comment on column feishu_sync_outbox.last_attempt_at is 'Latest sync attempt timestamp.';
comment on column feishu_sync_outbox.last_success_at is 'Latest successful sync timestamp.';
comment on column feishu_sync_outbox.last_error is 'Short last error field required by Phase 2A.';
comment on column feishu_sync_outbox.last_error_text is 'Longer actionable sync failure summary.';
comment on column feishu_sync_outbox.idempotency_key is 'Deduplication key for repeated desired updates.';
comment on column feishu_sync_outbox.created_at is 'Record creation timestamp.';
comment on column feishu_sync_outbox.updated_at is 'Last outbox update timestamp.';

create index if not exists idx_projects_status on projects (status);
create index if not exists idx_projects_key on projects (key);

create index if not exists idx_tasks_project_id on tasks (project_id);
create index if not exists idx_tasks_parent_task_id on tasks (parent_task_id);
create index if not exists idx_tasks_status_priority on tasks (status, priority, created_at);
create index if not exists idx_tasks_need_human_decision on tasks (need_human_decision) where need_human_decision = true;
create index if not exists idx_tasks_task_level on tasks (task_level);
create index if not exists idx_tasks_risk_level on tasks (risk_level);
create index if not exists idx_tasks_legacy_hermes_job_id on tasks (legacy_hermes_job_id);
create index if not exists idx_tasks_feishu_record_id on tasks (feishu_record_id);
create index if not exists idx_tasks_dependency_task_ids on tasks using gin (dependency_task_ids);

create index if not exists idx_task_checkpoints_task_id on task_checkpoints (task_id, checkpoint_order);
create index if not exists idx_task_checkpoints_attempt_id on task_checkpoints (attempt_id);
create index if not exists idx_task_checkpoints_status on task_checkpoints (status);

create index if not exists idx_task_attempts_task_id on task_attempts (task_id, attempt_number);
create index if not exists idx_task_attempts_agent_id on task_attempts (agent_id);
create index if not exists idx_task_attempts_status on task_attempts (status);
create index if not exists idx_task_attempts_worker_name on task_attempts (worker_name);
create index if not exists idx_task_attempts_heartbeat_at on task_attempts (heartbeat_at);
create index if not exists idx_task_attempts_git_commit_sha on task_attempts (git_commit_sha);

create index if not exists idx_task_events_project_id_created_at on task_events (project_id, created_at);
create index if not exists idx_task_events_task_id_created_at on task_events (task_id, created_at);
create index if not exists idx_task_events_attempt_id on task_events (attempt_id);
create index if not exists idx_task_events_event_type on task_events (event_type);
create index if not exists idx_task_events_idempotency_key on task_events (idempotency_key) where idempotency_key is not null;

create index if not exists idx_agents_project_id on agents (project_id);
create index if not exists idx_agents_agent_name on agents (agent_name);
create index if not exists idx_agents_role_status on agents (role, status);
create index if not exists idx_agents_heartbeat_at on agents (heartbeat_at);

create index if not exists idx_human_decisions_project_id on human_decisions (project_id);
create index if not exists idx_human_decisions_task_id on human_decisions (task_id);
create index if not exists idx_human_decisions_attempt_id on human_decisions (attempt_id);
create index if not exists idx_human_decisions_status on human_decisions (decision_status);
create index if not exists idx_human_decisions_decided_at on human_decisions (decided_at);

create index if not exists idx_deployments_project_id on deployments (project_id);
create index if not exists idx_deployments_task_id on deployments (task_id);
create index if not exists idx_deployments_attempt_id on deployments (attempt_id);
create index if not exists idx_deployments_environment_status on deployments (environment, deploy_status);
create index if not exists idx_deployments_git_commit_sha on deployments (git_commit_sha);
create index if not exists idx_deployments_callback_key on deployments (callback_idempotency_key) where callback_idempotency_key is not null;

create index if not exists idx_feishu_sync_outbox_project_id on feishu_sync_outbox (project_id);
create index if not exists idx_feishu_sync_outbox_task_id on feishu_sync_outbox (task_id);
create index if not exists idx_feishu_sync_outbox_status_next_attempt on feishu_sync_outbox (sync_status, next_attempt_at);
create index if not exists idx_feishu_sync_outbox_target on feishu_sync_outbox (target_table_id, target_record_id);
create index if not exists idx_feishu_sync_outbox_idempotency_key on feishu_sync_outbox (idempotency_key) where idempotency_key is not null;

-- Manual review checklist before any human-run database application:
-- 1. Confirm the target environment is local, staging, or production, and obtain the required owner approval for that environment.
-- 2. Confirm a fresh backup or restore point exists, and document the rollback procedure.
-- 3. Confirm V1 `hermes_jobs` remains untouched and V1 runtime mode remains available.
-- 4. Confirm every new table has an `id` UUID primary key plus `created_at`.
-- 5. Confirm mutable records have `updated_at` and that future application code owns update timestamp behavior.
-- 6. Confirm all status values match the V2 state-machine documents.
-- 7. Confirm no real key, token, app secret, service-role value, or connection string is present.
-- 8. Confirm this script is reviewed by a human before execution and is never run automatically by an Agent.
-- 9. Confirm application, Worker, API, Feishu, and deployment code remain unchanged until separately approved phases.
