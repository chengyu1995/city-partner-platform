# API audit

## Route inventory

Current `src/app/api` routes:

- `/api/admin/list`
- `/api/feishu/codex-task`
- `/api/feishu/create-tables`
- `/api/feishu/decompose-callback`
- `/api/feishu/event`
- `/api/feishu/requirement`
- `/api/partners/[id]/moderate`
- `/api/partners`
- `/api/queue/status`
- `/api/reports`
- `/api/worker/next`
- `/api/worker/progress`
- `/api/worker/report`

All inspected route files use Next.js route handlers and set `runtime = "nodejs"` where relevant.

## Worker API

### `GET /api/worker/next`

File: `src/app/api/worker/next/route.ts`

Auth:

- Uses `assertWorkerAuthorized(req)` from `src/lib/worker-jobs.ts`.
- Accepts `Authorization: Bearer <token>` when one of these env names is configured: `WORKER_TOKEN`, `WORKER_API_TOKEN`, `HERMES_WORKER_TOKEN`.
- If no expected token is configured, auth is effectively disabled.

Request:

- Worker id from `x-worker-id` header, or `worker_id` query param, or fallback `unknown-worker`.

Behavior:

- Gets Supabase service client.
- Selects first `hermes_jobs` row with status in `queued` or `pending`, ordered by priority then created time.
- If no job: returns `{ ok: true, job: null }`.
- Updates selected job to `running` with claim metadata and 5-minute expiry.
- Calls Feishu status sync if a Bitable record id is available.

Response:

- Success with job: `{ ok: true, job, feishu_sync }`
- Success without job: `{ ok: true, job: null }`
- Auth failure: `{ ok: false, error: "unauthorized" }` with 401.
- Supabase failure: `{ ok: false, error }` with 500.

### `POST /api/worker/next`

Same implementation as GET.

### `POST /api/worker/progress`

File: `src/app/api/worker/progress/route.ts`

Auth:

- Same Worker bearer auth helper.

Request body:

- `id` or `job_id`
- `status`
- `progress_percent`
- `current_step`
- `status_message`
- `bitable_record_id`, `feishu_record_id`, or `record_id`

Behavior:

- Requires `job_id`.
- Normalizes status for Feishu sync.
- Updates `hermes_jobs` with progress fields.
- Calls Feishu status sync.

Response:

- `{ ok: true, job, feishu_sync }`
- `{ ok: false, error: "job_id is required" }` with 400.
- `{ ok: false, error }` with 500.

### `POST /api/worker/report`

File: `src/app/api/worker/report/route.ts`

Auth:

- Same Worker bearer auth helper.

Request body:

- `id` or `job_id`
- `status`
- `progress_percent`
- `current_step`
- `status_message`
- `git_commit_sha`
- `error_text` or `error`
- `output`
- `pr_url`
- `files_changed`
- `build_passed`
- `test_passed`
- `duration_ms`
- record id aliases

Behavior:

- Requires `job_id`.
- Normalizes final statuses to `succeeded` or `failed` when applicable.
- Builds `result` JSON with output, PR URL, changed files, test/build status, duration, and commit SHA.
- Writes completion timestamp for terminal states.
- Calls Feishu status sync.

Response:

- `{ ok: true, job, feishu_sync }`
- `{ ok: false, error: "job_id is required" }` with 400.
- `{ ok: false, error }` with 500.

### `GET /api/worker/report`

Returns `{ ok: true, route: "worker-report" }`.

## Feishu API

### `POST /api/feishu/event`

File: `src/app/api/feishu/event/route.ts`

Auth and verification:

- Optional decrypt using `FEISHU_ENCRYPT_KEY`.
- Optional token check using `FEISHU_VERIFICATION_TOKEN`.
- Feishu app token call uses `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.

Request:

- Feishu event payload, encrypted or plain.
- Handles URL verification challenge.
- Handles `im.message.receive_v1`.

Behavior:

- For group chat, requires text mention containing `Hermes` or any `@\S+`.
- Inserts `feishu_event_receipts` with status `processing`.
- Duplicate `event_id` returns `{ code: 0, duplicate: true }`.
- Loads conversation history from `hermes_messages`.
- Calls `runAgent()`.
- Inserts user and assistant/tool messages.
- Sends Feishu reply.
- Marks receipt completed or failed.

Response:

- Feishu-style `{ code: 0 }` on success or ignored events.
- `{ code: 500, msg }` on failure.

### `POST /api/feishu/requirement`

File: `src/app/api/feishu/requirement/route.ts`

Auth:

- No route-level bearer auth found.
- Uses Supabase service role env variables.

Request:

- JSON payload from Feishu Bitable automation.

Behavior:

- Inserts into `hermes_queue` with `event_type = "new_requirement"`, `payload`, `status = "pending"`.

Response:

- `{ ok: true, queue_id }`
- `{ ok: false, error }`

### `POST /api/feishu/codex-task`

File: `src/app/api/feishu/codex-task/route.ts`

Auth:

- No route-level bearer auth found.

Behavior:

- Inserts into `hermes_queue` with `event_type = "codex_task_ready"`, `payload`, `status = "pending"`.

### `POST /api/feishu/decompose-callback`

File: `src/app/api/feishu/decompose-callback/route.ts`

Auth:

- If `FEISHU_API_TOKEN` exists, requires `Authorization: Bearer <token>`.
- If `FEISHU_API_TOKEN` is missing, auth is disabled.

Request:

- `{ tasks: [{ title, status?, assignee? }], parentTaskId? }`

Behavior:

- Gets Feishu tenant token.
- Lists Bitable fields.
- Inserts task records into Bitable.
- Processes tasks serially.
- Returns debug field names and per-task results.

### `POST /api/feishu/create-tables`

File: `src/app/api/feishu/create-tables/route.ts`

Auth:

- If `FEISHU_API_TOKEN` exists, requires `Authorization: Bearer <token>`.
- If missing, auth is disabled.

Behavior:

- Creates 8 Bitable tables and fields using `BITABLE_APP_TOKEN`, `FEISHU_APP_ID`, and `FEISHU_APP_SECRET`.

## Other API routes

- `/api/queue/status`: reads `hermes_queue` stats, recent queue rows, and recent `task_results`.
- `/api/admin/list`: service role fetch of `partner_posts`, optional `status` filter.
- `/api/partners`: GET approved partner posts; POST creates pending partner post.
- `/api/reports`: creates report rows.
- `/api/partners/[id]/moderate`: file path exists in route inventory, but literal path read failed with PowerShell wildcard brackets; not further audited in this pass.

## Not found

- `/api/worker/heartbeat`: Worker calls this endpoint, but no route file was found.
- Deployment callback receiver for `.github/workflows/sync-vercel-deployment.yml`: not found.
- Dedicated auth middleware: not found.
- Rate limiting for public Feishu routes: not found.
