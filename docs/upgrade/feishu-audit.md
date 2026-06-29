# Feishu Audit

Audit scope: Feishu event receiver, Bitable automations, Bitable sync, and Feishu-related environment variable names. No real env values were read or printed.

## Feishu Event Flow

Entry: `POST /api/feishu/event`

Steps:

1. Receives Feishu event JSON or encrypted payload.
2. Decrypts with `FEISHU_ENCRYPT_KEY` when payload has `encrypt`.
3. Verifies `FEISHU_VERIFICATION_TOKEN` if configured.
4. Handles URL verification challenge.
5. Filters event type to `im.message.receive_v1`.
6. Extracts text message content.
7. For group chats, requires an `@` mention or `Hermes` keyword, then removes mention.
8. Uses Supabase service role client.
9. Inserts `feishu_event_receipts` row with `processing` status.
10. Checks duplicate Feishu jobs in `hermes_jobs`.
11. Loads/creates Hermes conversation and history.
12. Calls `runAgent`.
13. Stores conversation messages.
14. Sends Feishu reply.
15. Marks receipt `completed` or `failed`.

ENV variable names:

- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Risks:

- Feishu event processing does substantial work inline.
- `feishu_event_receipts` table/migration was not found in audited SQL.
- Duplicate task detection depends on `hermes_jobs.request_text`, not present in audited SQL setup.

## Bitable Automation Ingress

Routes:

- `POST /api/feishu/requirement`
- `POST /api/feishu/codex-task`

Configured in docs:

- `docs/feishu-automation.md` describes Bitable automation rules pointing at Vercel routes.

`requirement` route:

- Inserts `{ event_type: "new_requirement", payload, status: "pending" }` into `hermes_queue`.
- Uses UTF-8 `arrayBuffer` decoding.

`codex-task` route:

- Inserts `{ event_type: "codex_task_ready", payload, status: "pending" }` into `hermes_queue`.

ENV variable names:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Risks:

- Neither route verifies a Feishu/Bitable shared secret.
- They enqueue raw payloads without schema validation.

## Decomposition and Bitable Task Sync

GitHub Action:

- `.github/workflows/hermes-decompose.yml`
- Runs every 5 minutes and manually via `workflow_dispatch`.
- Runs `scripts/hermes_decompose_runner.py`.

Runner:

- Reads up to 5 `hermes_queue` pending rows.
- Marks each `processing`.
- Calls MiniMax LLM.
- Writes `task_results`.
- Marks queue row `done` or `failed`.
- Optionally calls `DECOMPOSE_CALLBACK_URL` with `FEISHU_API_TOKEN`.
- Sends group notification via `FEISHU_BOT_WEBHOOK`.

ENV variable names used by runner:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MINIMAX_CN_API_KEY`
- `FEISHU_BOT_WEBHOOK`
- `DECOMPOSE_CALLBACK_URL`
- `FEISHU_API_TOKEN`

Decompose callback:

- `POST /api/feishu/decompose-callback`
- Writes Bitable task records.

ENV variable names:

- `FEISHU_API_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`
- `BITABLE_TABLE_ID`

Risks:

- If `FEISHU_API_TOKEN` is missing, auth is disabled.
- Field matching is dynamic but still tied to expected human field names.
- Failures are returned/logged but not stored in a retryable outbox.

## Worker Status to Feishu Sync

Implementation: `src/lib/feishu-worker-sync.ts`.

Called by:

- `/api/worker/next`
- `/api/worker/progress`
- `/api/worker/report`

Record ID sources:

- API body: `bitable_record_id`, `feishu_record_id`, `record_id`
- Job row direct fields
- Job `payload`
- Job `result`

ENV variable names:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`
- `FEISHU_BITABLE_APP_TOKEN`
- `BITABLE_WORKER_TABLE_ID`
- `BITABLE_TASK_TABLE_ID`
- `BITABLE_TABLE_ID`
- `FEISHU_BITABLE_TABLE_ID`

Fields attempted:

- Task status
- Stage
- Progress percent
- Current step
- Status message
- Git commit
- Error text
- Completed time
- Updated time

Risk:

- Sync is non-blocking and only logs errors.
- No durable retry or last-sync status exists.
- Missing record ID silently skips sync.

## Feishu Table Creation

Route: `POST /api/feishu/create-tables`.

ENV variable names:

- `FEISHU_API_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`

Risk:

- Infrastructure-changing route should not be generally reachable in production.
- If `FEISHU_API_TOKEN` is absent, auth is disabled.

## V2 Feishu Requirements

1. Add explicit auth to all Feishu/Bitable write routes.
2. Move all Bitable writes to a sync outbox with retry and last error.
3. Store Feishu record IDs on canonical requirement/task/subtask rows.
4. Keep event receipts with unique event/message constraints.
5. Avoid long-running LLM work inside Feishu event callbacks.
6. Add field mapping configuration rather than scattered hard-coded names.
