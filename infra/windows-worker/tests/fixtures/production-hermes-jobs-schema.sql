-- Exact public.hermes_jobs catalog snapshot observed through production_audit on 2026-08-11.
-- This fixture contains schema metadata only and no Production business rows.

create table public.hermes_jobs (
  id uuid not null default gen_random_uuid(),
  source text not null default 'feishu'::text,
  request_text text not null,
  status text not null default 'queued'::text,
  result_text text null,
  error_text text null,
  claimed_by text null,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  updated_at timestamptz not null default now(),
  source_event_id text null,
  source_message_id text null,
  source_chat_id text null,
  requester_id text null,
  reply_sent_at timestamptz null,
  reply_error text null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  heartbeat_at timestamptz null,
  last_requeued_at timestamptz null,
  workflow_stage text not null default 'execution'::text,
  plan_text text null,
  plan_status text null,
  approved_at timestamptz null,
  approved_by text null,
  risk_level text null,
  risk_reasons jsonb not null default '[]'::jsonb,
  approval_comment text null,
  bitable_record_id text null,
  bitable_synced_at timestamptz null,
  git_commit_sha text null,
  deploy_status text null,
  deploy_url text null,
  deploy_environment text null,
  deploy_description text null,
  deployed_at timestamptz null,
  approval_note text null,
  claimed_at timestamptz null,
  dedupe_key text null,
  feishu_event_id text null,
  feishu_message_id text null,
  progress_percent integer not null default 0,
  current_step text null,
  status_message text null,
  last_progress_at timestamptz null,
  result jsonb null,
  canonical_job_state text null,
  canonical_revision bigint null,
  requested_mode text null,
  plan_id text null,
  subtask_id text null,
  terminal_at timestamptz null,
  constraint hermes_jobs_pkey primary key (id),
  constraint hermes_jobs_attempt_count_check check (attempt_count >= 0),
  constraint hermes_jobs_max_attempts_check check (max_attempts >= 1),
  constraint hermes_jobs_progress_percent_check check (progress_percent >= 0 and progress_percent <= 100),
  constraint hermes_jobs_workflow_stage_check check (workflow_stage = any (array['planning'::text, 'awaiting_approval'::text, 'execution'::text, 'completed'::text])),
  constraint hermes_jobs_plan_status_check check (plan_status is null or plan_status = any (array['pending'::text, 'running'::text, 'ready'::text, 'approved'::text, 'rejected'::text, 'failed'::text])),
  constraint hermes_jobs_risk_level_check check (risk_level is null or risk_level = any (array['low'::text, 'medium'::text, 'high'::text, 'critical'::text])),
  constraint hermes_jobs_status_check check (status = any (array['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])),
  constraint hermes_jobs_canonical_job_state_check check (canonical_job_state = any (array['created'::text, 'queued'::text, 'claimed'::text, 'running'::text, 'terminal_success'::text, 'terminal_failed'::text, 'terminal_cancelled'::text])),
  constraint hermes_jobs_canonical_revision_check check (canonical_revision >= 0)
);

create index hermes_jobs_canonical_selectable
  on public.hermes_jobs (canonical_job_state, canonical_revision, created_at)
  where canonical_job_state = 'queued'::text and terminal_at is null;
create unique index hermes_jobs_dedupe_key_unique
  on public.hermes_jobs (dedupe_key) where dedupe_key is not null;
create index hermes_jobs_feishu_event_id_idx
  on public.hermes_jobs (feishu_event_id) where feishu_event_id is not null;
create index hermes_jobs_feishu_message_id_idx
  on public.hermes_jobs (feishu_message_id) where feishu_message_id is not null;
create index hermes_jobs_git_commit_sha_idx on public.hermes_jobs (git_commit_sha);
create index hermes_jobs_progress_status_idx
  on public.hermes_jobs (status, progress_percent, updated_at desc);
create unique index hermes_jobs_source_event_id_unique
  on public.hermes_jobs (source_event_id) where source_event_id is not null;
create index hermes_jobs_status_created_idx on public.hermes_jobs (status, created_at);
create index hermes_jobs_workflow_stage_idx
  on public.hermes_jobs (workflow_stage, plan_status, created_at);

alter table public.hermes_jobs enable row level security;
