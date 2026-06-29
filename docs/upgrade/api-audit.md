# API Audit

Audit date: 2026-06-29

## Feishu Event API

Route: `src/app/api/feishu/event/route.ts`

Methods:

- `POST /api/feishu/event`
- `GET /api/feishu/event`

Runtime:

- `nodejs`
- `force-dynamic`

Behavior:

- Parses JSON body.
- Supports encrypted Feishu events using `FEISHU_ENCRYPT_KEY`.
- Verifies `FEISHU_VERIFICATION_TOKEN` when configured.
- Handles URL verification challenge.
- Processes only `im.message.receive_v1`.
- For group chat, requires text containing `Hermes` or a mention-like token, then strips mentions.
- Inserts a receipt into `feishu_event_receipts` with `status = processing`.
- Uses duplicate event id handling via unique constraint error `23505`.
- Checks recent duplicate Feishu jobs through `findRecentDuplicateFeishuJob()`.
- Creates or loads a conversation in `hermes_conversations`.
- Loads recent `hermes_messages`.
- Calls `runAgent()`.
- Inserts new user/assistant/tool messages.
- Sends a Feishu text reply.
- Marks receipt `completed` or `failed`.

Environment variable names used:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `MINIMAX_CN_API_KEY`
- `HERMES_API_KEY`
- `FEISHU_BOT_WEBHOOK`

Risks:

- Event route performs LLM work inline, which can exceed serverless latency budgets.
- Duplicate job check depends on `hermes_jobs.request_text`, which is not in the audited SQL setup.
- Error handling intentionally returns HTTP 200 for many failures to avoid Feishu retries; operational errors can be hidden unless logs/receipts are monitored.

## Feishu Bitable Ingest APIs

Routes:

- `POST /api/feishu/requirement`
- `POST /api/feishu/codex-task`

Behavior:

- `requirement` decodes request body as UTF-8, logs the first 500 chars, inserts into `hermes_queue` with `event_type = new_requirement`.
- `codex-task` parses JSON text and inserts into `hermes_queue` with `event_type = codex_task_ready`.

Environment variable names used:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Risks:

- No explicit request authentication was found on these two routes.
- Raw payload is accepted and inserted into queue without schema validation.
- These routes feed `hermes_queue`, not directly `hermes_jobs`.

## Feishu Bitable Create Tables API

Route: `POST /api/feishu/create-tables`

Behavior:

- Optional Bearer auth via `FEISHU_API_TOKEN`.
- Uses `BITABLE_APP_TOKEN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`.
- Creates eight Feishu Bitable tables and fields.

Risk:

- If `FEISHU_API_TOKEN` is missing, auth is disabled by code path.
- This is a configuration-changing route and should be disabled or strongly protected in production.

## Feishu Decompose Callback API

Route: `POST /api/feishu/decompose-callback`

Behavior:

- Optional Bearer auth via `FEISHU_API_TOKEN`.
- Reads `tasks` and `parentTaskId`.
- Gets Feishu tenant access token.
- Reads Bitable fields and inserts task records.
- Returns per-task results and debug field names.

Environment variable names used:

- `FEISHU_API_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`
- `BITABLE_TABLE_ID`

Risks:

- If `FEISHU_API_TOKEN` is missing, auth is disabled.
- Bitable sync errors can be included in API response; current code does not print secrets, but error text should remain sanitized in V2.

## Worker Next API

Route: `src/app/api/worker/next/route.ts`

Methods:

- `GET /api/worker/next`
- `POST /api/worker/next`

Authentication:

- `assertWorkerAuthorized()` checks Bearer token when one of these env vars is configured: `WORKER_TOKEN`, `WORKER_API_TOKEN`, `HERMES_WORKER_TOKEN`.
- If no token env is configured, the route allows access.

Behavior:

- Selects one `hermes_jobs` row with status in `queued`, `pending`.
- Orders by `priority` ascending then `created_at` ascending.
- Updates selected row to `running`.
- Sets `claimed_by`, `claimed_at`, `expires_at`, progress fields, and `updated_at`.
- Syncs running status to Feishu Bitable if a record id can be found.

Risks:

- Claim is not atomic. Two Workers can select the same row before either update completes.
- No `expires_at < now()` recovery is applied.
- Status `queued` may conflict with SQL setup.
- Query parameter uses `worker_id` in API helper, while Worker sends `worker_name`; if header `x-worker-id` is absent, claim may become `unknown-worker`.

## Worker Progress API

Route: `POST /api/worker/progress`

Behavior:

- Requires `job_id` or `id`.
- Normalizes progress and status.
- Updates `hermes_jobs`.
- Syncs progress to Feishu Bitable.

Risks:

- Does not verify that the reporting Worker owns the claim.
- Can move status based only on submitted body.

## Worker Report API

Route: `POST /api/worker/report`

Behavior:

- Requires `job_id` or `id`.
- Normalizes status to `running`, `queued`, `succeeded`, or `failed`.
- Terminal statuses set progress to 100 and `completed_at`.
- Stores `git_commit_sha`, error text, and a `result` object.
- Syncs final status to Feishu Bitable.

Risks:

- Worker sends `result_text` and `deploy_status`, but route does not explicitly store those fields.
- Status `succeeded` may conflict with SQL setup.
- Does not verify claim ownership.
- Feishu sync is awaited but internally catches errors; this is good for non-blocking behavior, but failures only appear in logs.

## Missing API Routes

- `/api/worker/heartbeat`: Worker calls it, repository route not found.
- Deployment status callback route for `.github/workflows/sync-vercel-deployment.yml`: not found.

## API Recommendations for V2

1. Add mandatory auth for all Feishu automation and Worker routes.
2. Introduce atomic job claim RPC or conditional update.
3. Add `/api/worker/heartbeat` and stale job recovery.
4. Validate request body schemas.
5. Normalize status names across SQL, API, Worker, and Feishu.
6. Add a deployment callback receiver or remove the workflow.
