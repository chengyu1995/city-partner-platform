# Database Audit

Audit date: 2026-06-29

Environment files were not read. No SQL was executed.

## `hermes_jobs`

Source: `docs/setup-hermes-jobs.sql`

Defined columns:

- `id uuid primary key default gen_random_uuid()`
- Source fields: `source`, `feishu_message_id`, `feishu_event_id`, `feishu_chat_id`, `feishu_user_id`
- Task fields: `job_id`, `title`, `description`, `priority`, `acceptance`, `branch`
- Execution fields: `executor`, `repo`, `prompt`
- Status field: `status`
- Claim fields: `claimed_by`, `claimed_at`, `expires_at`, `attempts`, `max_attempts`
- Result fields: `result`, `error`
- Timestamps: `created_at`, `updated_at`

Defined status values:

- `pending`
- `running`
- `awaiting_review`
- `completed`
- `failed`

Indexes:

- `idx_jobs_status_priority` on `(status, priority, created_at)`
- `idx_jobs_expires` on `expires_at` where `status = 'running'`

Trigger:

- `trg_jobs_updated` updates `updated_at` before update.

RLS:

- RLS is enabled.
- No explicit `hermes_jobs` policies were found in `docs/setup-hermes-jobs.sql`, so current server-side access depends on service-role behavior.

## Runtime Access to `hermes_jobs`

`GET /api/worker/next`:

- Reads table `hermes_jobs`.
- Filters status in `queued`, `pending`.
- Orders by `priority` ascending, then `created_at` ascending.
- Limits to 1 row.
- Updates the row to `running` with `claimed_by`, `claimed_at`, `expires_at`, `progress_percent`, `current_step`, `status_message`, `updated_at`.

`POST /api/worker/progress`:

- Updates `status`, `progress_percent`, `current_step`, `status_message`, `updated_at`.

`POST /api/worker/report`:

- Updates `status`, `progress_percent`, `current_step`, `status_message`, `git_commit_sha`, `error_text`, `result`, `completed_at`, `updated_at`.

`src/lib/worker-jobs.ts`:

- `updateHermesJob()` retries updates while dropping missing columns when PostgREST reports a missing-column error.
- This compatibility behavior masks schema drift and allows runtime to continue with incomplete database shape.

## Schema Drift Observed

The runtime writes or reads fields that are not in `docs/setup-hermes-jobs.sql`:

- `progress_percent`
- `current_step`
- `status_message`
- `git_commit_sha`
- `error_text`
- `completed_at`
- `bitable_record_id` / `feishu_record_id` / `record_id` via payload/result lookup
- `request_text`, used by duplicate Feishu task detection

The runtime also uses status values not allowed by the SQL setup:

- `queued`
- `succeeded`

This means either production schema has out-of-band migrations not captured in docs, or the current routes rely on missing-column skipping and may fail on status check constraints.

## `hermes_queue`

Source: `docs/setup-hermes-queue.sql`

Defined columns:

- `id`
- `event_type`
- `payload`
- `status`
- `attempt_count`
- `last_error`
- `created_at`
- `processed_at`

Defined status values:

- `pending`
- `processing`
- `done`
- `failed`

Usage:

- `/api/feishu/requirement` inserts `event_type = new_requirement`.
- `/api/feishu/codex-task` inserts `event_type = codex_task_ready`.
- `scripts/hermes_decompose_runner.py` reads `pending`, patches `processing`, writes `task_results`, then patches `done` or `failed`.

Risk:

- RLS policies in setup allow anon read/insert/update. That is broad for a production queue unless the only exposed path is service-side.

## `task_results`

Source: `docs/setup-hermes-queue.sql`

Defined columns:

- `id`
- `source_queue_id`
- `summary`
- `subtasks`
- `model`
- `tokens_used`
- `created_at`

Usage:

- `scripts/hermes_decompose_runner.py` writes decomposition results.
- `GET /api/queue/status` reads recent results.

## `hermes_conversations` and `hermes_messages`

Source: `docs/setup-hermes-conversations.sql`

Usage:

- `/api/feishu/event` stores conversational context for `runAgent()`.
- Conversation lookup is by `user_id`, `chat_type`, `is_active`, sorted by `last_msg_at`.

Risk:

- Policies allow public select. Inserts are performed through service-role code, but read exposure should be reviewed before V2 stores sensitive operational prompts or user messages.

## V2 Database Requirements

Before Phase 1:

1. Create a canonical `hermes_jobs` migration matching runtime fields.
2. Define one status enum/state table used by API and Worker.
3. Add atomic claim support, preferably an RPC such as `claim_next_hermes_job(worker_id)`.
4. Add heartbeat fields and stale lease recovery fields.
5. Decide whether `hermes_queue` is an ingest queue only or part of the execution job model.
6. Add uniqueness/idempotency constraints for Feishu event ids and task fingerprints.
