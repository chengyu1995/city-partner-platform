begin;

-- Existing installations keep the narrower draft constraints because
-- CREATE TABLE IF NOT EXISTS does not reconcile constraint definitions.
-- Replace only those three checks; no table rows are rewritten.
alter table public.hermes_v2_tasks
  drop constraint if exists hermes_v2_tasks_status_check;

alter table public.hermes_v2_tasks
  add constraint hermes_v2_tasks_status_check check (status in (
    'draft',
    'queued',
    'running',
    'awaiting_human',
    'ready',
    'dispatched',
    'awaiting_review',
    'retrying',
    'approved',
    'rejected',
    'succeeded',
    'failed',
    'cancelled'
  )) not valid;

alter table public.hermes_v2_tasks
  validate constraint hermes_v2_tasks_status_check;

alter table public.hermes_v2_task_events
  drop constraint if exists hermes_v2_task_events_type_check;

alter table public.hermes_v2_task_events
  add constraint hermes_v2_task_events_type_check check (event_type in (
    'task.created',
    'task.queued',
    'task.claimed',
    'task.progressed',
    'task.plan_stored',
    'task.awaiting_human',
    'task.dispatched',
    'task.review_requested',
    'task.reviewed',
    'task.succeeded',
    'task.failed',
    'task.cancelled',
    'attempt.heartbeat',
    'attempt.progressed',
    'attempt.failed',
    'attempt.timed_out',
    'canonical_job.observed',
    'human_decision.requested',
    'human_decision.resolved',
    'deployment.updated',
    'feishu.sync_queued',
    'feishu.sync_failed',
    'feishu.sync_succeeded',
    'retry.scheduled',
    'memory.updated',
    'error.recorded'
  )) not valid;

alter table public.hermes_v2_task_events
  validate constraint hermes_v2_task_events_type_check;

alter table public.hermes_v2_feishu_sync_outbox
  drop constraint if exists hermes_v2_feishu_sync_outbox_sync_type_check;

alter table public.hermes_v2_feishu_sync_outbox
  add constraint hermes_v2_feishu_sync_outbox_sync_type_check check (sync_type in (
    'task_status',
    'attempt_progress',
    'deployment_status',
    'decision_request',
    'message_reply',
    'heartbeat_health',
    'review_packet'
  )) not valid;

alter table public.hermes_v2_feishu_sync_outbox
  validate constraint hermes_v2_feishu_sync_outbox_sync_type_check;

commit;
