# Database Audit

Audit scope: Supabase schema as represented by repository SQL/docs and runtime code. No SQL was executed.

## Tables In Scope

- `hermes_jobs`
- `hermes_queue`
- `task_results`
- `hermes_conversations`
- `hermes_messages`
- `feishu_event_receipts` as used by code, although no matching setup SQL was found in the audited files.

## `hermes_jobs`

Schema source: `docs/setup-hermes-jobs.sql`.

Defined columns:

- Identity/source: `id`, `source`, `feishu_message_id`, `feishu_event_id`, `feishu_chat_id`, `feishu_user_id`
- Task fields: `job_id`, `title`, `description`, `priority`, `acceptance`, `branch`
- Execution: `executor`, `repo`, `prompt`
- State: `status`
- Claim/lease: `claimed_by`, `claimed_at`, `expires_at`, `attempts`, `max_attempts`
- Result/error: `result`, `error`
- Timestamps: `created_at`, `updated_at`

Defined statuses:

- `pending`
- `running`
- `awaiting_review`
- `completed`
- `failed`

Indexes:

- `idx_jobs_status_priority` on `(status, priority, created_at)`
- `idx_jobs_expires` on `expires_at` where `status = 'running'`

Runtime expectations not present in this SQL:

- `queued`
- `succeeded`
- `progress_percent`
- `current_step`
- `status_message`
- `git_commit_sha`
- `error_text`
- `completed_at`
- `request_text`
- `bitable_record_id` / `feishu_record_id` / `record_id`

The helper `updateHermesJob` dynamically skips missing columns for updates, which keeps runtime partially tolerant but hides schema drift.

## Claim Query

Source: `src/app/api/worker/next/route.ts`.

Current query:

- Table: `hermes_jobs`
- Filter: `.in("status", ["queued", "pending"])`
- Sort: `priority` ascending, then `created_at` ascending
- Limit: `1`
- Fetch: `.maybeSingle()`

Claim update:

- Sets `status = running`
- Sets `claimed_by`, `claimed_at`, `expires_at`
- Sets progress fields if columns exist
- Attempts Feishu sync after claim

Risk:

- The select and update are two separate operations. There is no `FOR UPDATE SKIP LOCKED`, compare-and-set `status` condition, RPC, or unique claim token, so duplicate claim is possible.

## Report Query

Source: `src/app/api/worker/report/route.ts`.

Input status is normalized:

- `failed` / `error` -> `failed`
- `succeeded` / `success` / `completed` -> `succeeded`
- `queued` / `pending` -> `queued`
- other/missing -> `running`

Report update:

- Updates `status`, progress fields, `git_commit_sha`, `error_text`, `result`, `completed_at`, `updated_at`
- Terminal states are `succeeded` and `failed`

Risk:

- Runtime terminal statuses do not match `docs/setup-hermes-jobs.sql`, which defines `completed` rather than `succeeded`.
- Worker sends `result_text` and `deploy_status`; route does not explicitly persist those keys unless they are covered by `result` construction or tolerated as ignored extras.

## Progress Query

Source: `src/app/api/worker/progress/route.ts`.

Updates:

- `status`
- `progress_percent`
- `current_step`
- `status_message`
- `updated_at`

Risk:

- It writes `body.status ?? "running"` rather than the normalized status in the database update.

## `hermes_queue` and `task_results`

Schema source: `docs/setup-hermes-queue.sql`.

`hermes_queue` columns:

- `id`, `event_type`, `payload`, `status`, `attempt_count`, `last_error`, `created_at`, `processed_at`

Statuses:

- `pending`
- `processing`
- `done`
- `failed`

Producers:

- `POST /api/feishu/requirement`
- `POST /api/feishu/codex-task`

Consumer:

- `.github/workflows/hermes-decompose.yml` runs `scripts/hermes_decompose_runner.py` every 5 minutes.

`task_results` columns:

- `id`, `source_queue_id`, `summary`, `subtasks`, `model`, `tokens_used`, `created_at`

Risk:

- This is a separate queue from `hermes_jobs`. V2 needs one explicit relationship between requirement records, decomposition results, and executable Worker jobs.

## Conversation Tables

Schema source: `docs/setup-hermes-conversations.sql`.

`hermes_conversations`:

- Stores Feishu user/chat session metadata.
- Read policies are public; writes are expected through service role.

`hermes_messages`:

- Stores chat history and tool metadata.
- Has trigger to update `last_msg_at`.

Risk:

- Public read policy may expose conversation data if anon access is enabled in deployed clients. V2 should lock this down unless public read is intentional.

## RLS and Access

The runtime API uses Supabase service-role access through `getSupabaseService()` or direct REST calls with service key. Service role bypasses RLS. This is acceptable for server-only routes if auth is enforced at the route boundary.

High-risk route boundary:

- Worker routes have optional auth if no Worker token env is set.
- Feishu Bitable HTTP queue routes do not implement a route-specific token in `requirement` and `codex-task`.

## V2 Database Requirements

1. Create a normalized V2 schema with parent task and subtask support.
2. Add an atomic claim RPC or conditional update that includes current status and lease expiry.
3. Align status enum across SQL and code.
4. Add heartbeat columns and stale lease recovery fields.
5. Add execution attempt records rather than overwriting the job row.
6. Add Feishu sync outbox with retry/error persistence.
7. Add deployment status records keyed by commit SHA and linked to job attempt.
8. Add migrations for all runtime-used columns before code depends on them.
