# Feishu audit

## Event callback

File: `src/app/api/feishu/event/route.ts`

Endpoint:

- `POST /api/feishu/event`
- `GET /api/feishu/event` health response

Environment variable names:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`

Flow:

1. Reads raw request text and parses JSON.
2. If payload has `encrypt` and `FEISHU_ENCRYPT_KEY` is present, decrypts using `decryptFeishuEvent()`.
3. If `FEISHU_VERIFICATION_TOKEN` is set and payload token mismatches, returns 401.
4. Handles Feishu URL verification challenge.
5. Filters to `im.message.receive_v1`.
6. Ignores events without message payload.
7. Parses text message content.
8. For group chat, requires text containing `Hermes` or an `@...` mention and strips mention text.
9. Creates a row in `feishu_event_receipts`.
10. Treats duplicate receipt error code `23505` as a duplicate event and returns success.
11. Creates or loads a Hermes conversation.
12. Loads recent conversation history.
13. Calls `runAgent()` from `src/lib/hermes-agent.ts`.
14. Inserts new messages into `hermes_messages`.
15. Sends a Feishu reply.
16. Marks the Feishu receipt completed or failed.

Risk:

- Main Feishu event path runs LLM and Feishu reply inline in the request lifecycle, so slow LLM or Feishu network failures can block the callback.
- If event id is missing, receipt idempotency may weaken.

## Bitable requirement ingestion

File: `src/app/api/feishu/requirement/route.ts`

Endpoint:

- `POST /api/feishu/requirement`

Environment variable names:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Flow:

- Reads UTF-8 request body via `arrayBuffer`.
- Parses JSON.
- Inserts into `hermes_queue` with `event_type = "new_requirement"` and `status = "pending"`.

Auth:

- No explicit bearer or Feishu token auth found in the route.

## Codex task ingestion

File: `src/app/api/feishu/codex-task/route.ts`

Endpoint:

- `POST /api/feishu/codex-task`

Environment variable names:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Flow:

- Parses JSON request.
- Inserts into `hermes_queue` with `event_type = "codex_task_ready"` and `status = "pending"`.

Auth:

- No explicit bearer or Feishu token auth found in the route.

## Decomposition callback and Bitable sync

File: `src/app/api/feishu/decompose-callback/route.ts`

Endpoint:

- `POST /api/feishu/decompose-callback`
- `GET /api/feishu/decompose-callback` returns env presence only, not values.

Environment variable names:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`
- `BITABLE_TABLE_ID`
- `FEISHU_API_TOKEN`

Flow:

1. If `FEISHU_API_TOKEN` is set, checks `Authorization: Bearer <token>`.
2. Parses JSON body with `tasks`.
3. Gets Feishu tenant access token.
4. Lists actual Bitable fields.
5. Builds field map from real fields.
6. Inserts each task record serially.
7. Returns per-task results and debug field metadata.

Risk:

- If `FEISHU_API_TOKEN` is missing, auth is disabled.
- Task insert loop is serial and can block until every task is processed.

## Worker status to Bitable sync

File: `src/lib/feishu-worker-sync.ts`

Environment variable names:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `BITABLE_APP_TOKEN`
- `FEISHU_BITABLE_APP_TOKEN`
- `BITABLE_WORKER_TABLE_ID`
- `BITABLE_TASK_TABLE_ID`
- `BITABLE_TABLE_ID`
- `FEISHU_BITABLE_TABLE_ID`

Flow:

1. Skips if no Bitable record id is supplied.
2. Reads app token and table id from env name fallbacks.
3. Gets tenant access token with in-memory cache.
4. Lists Bitable fields.
5. Maps known Chinese and English field names to Worker status fields.
6. Sends `PUT /bitable/v1/apps/{appToken}/tables/{tableId}/records/{recordId}`.
7. Catches and logs sanitized errors without blocking main Worker API response.

Good:

- Sync is non-blocking from a failure perspective.
- Error sanitizer redacts bearer tokens, app secret patterns, and app token URL path.

Risk:

- The API route still awaits the sync call, so slow Feishu API latency can delay Worker API responses even though failures are swallowed.

## Bitable table creation

File: `src/app/api/feishu/create-tables/route.ts`

Endpoint:

- `POST /api/feishu/create-tables`

Environment variable names:

- `FEISHU_API_TOKEN`
- `BITABLE_APP_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

Behavior:

- Creates 8 Bitable tables and fields.
- If `FEISHU_API_TOKEN` is missing, auth is disabled.

Risk:

- This route can create external Bitable structure and should be treated as an admin-only route.

## GitHub Action Feishu notification

File: `scripts/hermes_decompose_runner.py`

Environment variable names:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MINIMAX_CN_API_KEY`
- `FEISHU_BOT_WEBHOOK`
- `DECOMPOSE_CALLBACK_URL`
- `FEISHU_API_TOKEN`

Behavior:

- Reads up to 5 pending `hermes_queue` items.
- Calls MiniMax.
- Writes `task_results`.
- Marks queue done or failed.
- Optionally calls decomposition callback with subtasks.
- Sends Feishu bot notification.

Security note:

- The script prints `SUPABASE_URL` and the length of `SUPABASE_SERVICE_ROLE_KEY`, not the key value. Avoid increasing this log detail.

## Not found

- Dedicated Feishu signature verification beyond token check and optional decrypt: not found.
- Rate limiting for Feishu ingestion endpoints: not found.
- Queue-first handling for `/api/feishu/event`: not found; it processes LLM inline.
