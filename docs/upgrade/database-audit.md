# Database audit

## SQL sources inspected

- `docs/setup-hermes-jobs.sql`
- `docs/setup-hermes-queue.sql`
- `docs/setup-hermes-conversations.sql`

No database was queried and no migration was executed.

## `hermes_jobs`

Defined in `docs/setup-hermes-jobs.sql`.

Fields:

- `id uuid primary key default gen_random_uuid()`
- `source text not null default 'feishu'`
- `feishu_message_id text`
- `feishu_event_id text`
- `feishu_chat_id text`
- `feishu_user_id text`
- `job_id text`
- `title text not null`
- `description text`
- `priority text default 'P1' check (priority in ('P0', 'P1', 'P2'))`
- `acceptance text`
- `branch text default 'agent/TASK-001'`
- `executor text default 'local_codex'`
- `repo text default 'C:\Users\admin\city-partner-platform'`
- `prompt text`
- `status text not null default 'pending' check (...)`
- `claimed_by text`
- `claimed_at timestamptz`
- `expires_at timestamptz`
- `attempts int default 0`
- `max_attempts int default 2`
- `result jsonb`
- `error text`
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

SQL status values:

- `pending`
- `running`
- `awaiting_review`
- `completed`
- `failed`

Indexes:

- `idx_jobs_status_priority on hermes_jobs(status, priority, created_at)`
- `idx_jobs_expires on hermes_jobs(expires_at) where status = 'running'`

Trigger:

- `update_jobs_updated_at()` sets `new.updated_at = now()`.
- `trg_jobs_updated` runs before update on `hermes_jobs`.

RLS:

- `alter table hermes_jobs enable row level security`.
- No policy for `hermes_jobs` was found in the inspected SQL. Service role access is therefore required for current server-side updates.

## Runtime schema expectations

The Worker API code expects additional fields that are not declared in `docs/setup-hermes-jobs.sql`:

- `progress_percent`
- `current_step`
- `status_message`
- `git_commit_sha`
- `error_text`
- `completed_at`
- `bitable_record_id` or equivalent record id fields

`src/lib/worker-jobs.ts` handles missing columns by retrying updates after removing missing fields. This prevents immediate failure but means status sync can partially succeed without storing all intended data.

## Status mismatch

Current API code:

- `src/app/api/worker/next/route.ts` reads statuses `queued` and `pending`.
- `src/app/api/worker/next/route.ts` writes `running`.
- `src/app/api/worker/progress/route.ts` normalizes `queued`, `pending`, `running`, `succeeded`, `failed`.
- `src/app/api/worker/report/route.ts` writes terminal status `succeeded` or `failed`.

SQL allows:

- `pending`
- `running`
- `awaiting_review`
- `completed`
- `failed`

Risk: writes of `queued` or `succeeded` can violate the SQL check constraint unless the live database has a newer schema not represented by this SQL file.

## Claim query

`src/app/api/worker/next/route.ts` query:

- table: `hermes_jobs`
- select: `*`
- filter: `status in ("queued", "pending")`
- order: `priority` ascending
- order: `created_at` ascending
- limit: `1`
- result: `maybeSingle()`

Then it updates by `id` to:

- `status = running`
- `claimed_by = worker id`
- `claimed_at = now`
- `expires_at = now + 5 minutes`
- progress fields if present

There is no single atomic SQL claim operation in the repository.

## Related tables

`docs/setup-hermes-queue.sql` defines `hermes_queue`:

- `id uuid primary key`
- `event_type text not null`
- `payload jsonb not null`
- `status text not null default 'pending' check in ('pending', 'processing', 'done', 'failed')`
- `attempt_count int not null default 0`
- `last_error text`
- `created_at timestamptz not null default now()`
- `processed_at timestamptz`

Indexes:

- `hermes_queue_pending_idx on public.hermes_queue(status, created_at) where status = 'pending'`

`docs/setup-hermes-queue.sql` defines `task_results`:

- stores LLM decomposition result rows linked to `hermes_queue`.

`docs/setup-hermes-conversations.sql` defines:

- `hermes_conversations`
- `hermes_messages`

## Not found

- SQL migration adding Worker progress columns to `hermes_jobs`: not found.
- SQL migration adding deployment callback fields to `hermes_jobs`: not found.
- SQL RPC for atomic job claim: not found.
- SQL function for expired job requeue: not found.
- SQL policy allowing limited Worker token access without service role: not found.
