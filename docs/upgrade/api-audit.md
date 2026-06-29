# API Audit

Audit scope: Vercel/Next.js API routes involved in Feishu, Worker, queue, and deployment status flow.

## Feishu Event Receiver

Route: `POST /api/feishu/event`
File: `src/app/api/feishu/event/route.ts`

Responsibilities:

- Reads raw request body.
- Supports encrypted Feishu payloads through `FEISHU_ENCRYPT_KEY`.
- Verifies Feishu token if `FEISHU_VERIFICATION_TOKEN` is configured.
- Handles URL verification challenge.
- Filters for `im.message.receive_v1`.
- For group chat, requires an `@` mention or text containing `Hermes`.
- Persists event receipt to `feishu_event_receipts`.
- Checks recent duplicate Feishu tasks through `hermes_jobs`.
- Loads/stores Hermes conversation messages.
- Calls `runAgent`.
- Replies to Feishu through `im/v1/messages`.

ENV variable names used:

- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Risks:

- `feishu_event_receipts` setup SQL was not found in audited schema files.
- Duplicate task detection depends on `hermes_jobs.request_text`, which is not in the audited `hermes_jobs` SQL.
- Receipt idempotency depends on database unique constraints that were not found in audited SQL.
- Agent execution happens inline in the webhook route, which can be slow for Feishu/Vercel callback time budgets.

## Feishu Requirement Queue

Route: `POST /api/feishu/requirement`
File: `src/app/api/feishu/requirement/route.ts`

Responsibilities:

- Decodes request as UTF-8 array buffer.
- Parses JSON payload.
- Inserts into `hermes_queue` with `event_type = new_requirement`, `status = pending`.

ENV variable names used:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Risks:

- No route-specific auth token is checked.
- Raw payload head can be returned in invalid JSON responses; this should not include secrets but is still user-provided data.

## Feishu Codex Task Queue

Route: `POST /api/feishu/codex-task`
File: `src/app/api/feishu/codex-task/route.ts`

Responsibilities:

- Parses JSON payload.
- Inserts into `hermes_queue` with `event_type = codex_task_ready`, `status = pending`.

ENV variable names used:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Risks:

- No route-specific auth token is checked.
- Uses `req.text()` rather than the UTF-8 array-buffer approach used in `requirement`.

## Feishu Decompose Callback

Route: `POST /api/feishu/decompose-callback`
File: `src/app/api/feishu/decompose-callback/route.ts`

Responsibilities:

- Optionally verifies Bearer token with `FEISHU_API_TOKEN`.
- Gets Feishu tenant token.
- Lists Bitable fields.
- Creates one Bitable record per decomposed task.

ENV variable names used:

- `FEISHU_API_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`
- `BITABLE_TABLE_ID`

Risks:

- If `FEISHU_API_TOKEN` is absent, auth is disabled.
- Writes records serially and returns mixed per-task results.
- Field names are partly hard-coded and vulnerable to Bitable schema drift.

## Feishu Table Creation

Route: `POST /api/feishu/create-tables`
File: `src/app/api/feishu/create-tables/route.ts`

Responsibilities:

- Optionally verifies Bearer token with `FEISHU_API_TOKEN`.
- Creates 8 Bitable tables and fields using Feishu API.

ENV variable names used:

- `FEISHU_API_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`

Risks:

- If `FEISHU_API_TOKEN` is absent, auth is disabled.
- This is an infrastructure-changing route exposed in the application. V2 should disable or restrict it outside manual bootstrap.

## Worker Claim

Route: `GET|POST /api/worker/next`
File: `src/app/api/worker/next/route.ts`

Responsibilities:

- Verifies Worker Bearer token if configured.
- Selects first `hermes_jobs` row with status `queued` or `pending`.
- Orders by priority and created time.
- Updates selected row to `running`.
- Sets a 5-minute `expires_at`.
- Attempts Feishu sync.
- Returns claimed job.

ENV variable names used through helpers:

- `WORKER_TOKEN`
- `WORKER_API_TOKEN`
- `HERMES_WORKER_TOKEN`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Feishu sync env names listed in `feishu-audit.md`

Risks:

- Claim is non-atomic.
- No stale lease recovery.
- Does not increment `attempts`.
- Worker sends `worker_name` query param, but server reads `x-worker-id` or `worker_id`; it may record `unknown-worker`.

## Worker Progress

Route: `POST /api/worker/progress`
File: `src/app/api/worker/progress/route.ts`

Responsibilities:

- Verifies Worker token if configured.
- Updates job progress fields.
- Attempts Feishu status sync.

Risks:

- Uses `body.status ?? "running"` in DB update, while Feishu sync uses normalized status.
- No ownership check against `claimed_by`.

## Worker Report

Route: `POST /api/worker/report`
File: `src/app/api/worker/report/route.ts`

Responsibilities:

- Verifies Worker token if configured.
- Updates terminal/non-terminal status.
- Stores result object.
- Sets `completed_at` for terminal states.
- Attempts Feishu status sync.

Risks:

- No ownership check against `claimed_by`.
- Does not explicitly store `result_text` or `deploy_status`, which the Worker sends.
- Status mismatch with audited SQL (`succeeded` vs `completed`).

## Missing API Routes

- `POST /api/worker/heartbeat`: Worker calls it, repository route not found.
- Deployment status callback route for `.github/workflows/sync-vercel-deployment.yml`: workflow posts to `DEPLOY_CALLBACK_URL`, but no receiver route was found.

## V2 API Requirements

1. Make every external-write route explicitly authenticated.
2. Move long-running Feishu event work to queue/background flow.
3. Add atomic claim endpoint or RPC.
4. Add heartbeat endpoint.
5. Add stale lease recovery endpoint/job.
6. Add deployment callback receiver or remove the workflow.
7. Enforce Worker ownership for progress/report.
8. Align request/response payloads between Worker and routes.
