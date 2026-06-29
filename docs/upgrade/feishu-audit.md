# Feishu Audit

Audit date: 2026-06-29

Environment files were not read. This document lists variable names only.

## Feishu Event Subscription

Route: `POST /api/feishu/event`

Primary purpose:

- Receive Feishu message events.
- Handle challenge verification.
- Decrypt event payload when configured.
- Filter message events.
- Run Hermes agent and reply to Feishu.

Message rules:

- Only `im.message.receive_v1` is processed.
- p2p messages are accepted when text exists.
- group messages require `Hermes` or a mention-like token.
- Text is extracted from `message.content` JSON.

Idempotency:

- Inserts into `feishu_event_receipts`.
- Duplicate event insert error `23505` is treated as already processed.
- A second duplicate check looks for recent `hermes_jobs` with same normalized request text.

Risk:

- If `feishu_event_receipts` does not exist or lacks a unique `event_id`, idempotency can fail.
- Duplicate task detection depends on `hermes_jobs.request_text`, not present in audited SQL setup.

## Feishu Bitable Automation Ingress

Routes:

- `POST /api/feishu/requirement`
- `POST /api/feishu/codex-task`

Expected source:

- Feishu Bitable automation rules.

Behavior:

- Requirement route inserts `event_type = new_requirement` into `hermes_queue`.
- Codex task route inserts `event_type = codex_task_ready` into `hermes_queue`.

Risk:

- No route-level authentication was found for these two routes.
- They insert raw payloads into `hermes_queue`.
- They do not directly create `hermes_jobs`.

## Feishu Bitable Table Creation

Route: `POST /api/feishu/create-tables`

Behavior:

- Creates eight Bitable tables and fields:
  - requirements pool
  - task board
  - boss decision center
  - design/page tracking
  - bug/risk
  - release records
  - daily/weekly reports
  - agent configuration

Authentication:

- Checks `Authorization: Bearer <FEISHU_API_TOKEN>` only when `FEISHU_API_TOKEN` is configured.

Risk:

- This route mutates Feishu schema and should not be publicly reachable without mandatory auth.

## Decomposition Result Sync

Flow:

1. `.github/workflows/hermes-decompose.yml` runs every 5 minutes.
2. `scripts/hermes_decompose_runner.py` reads `hermes_queue`.
3. Runner calls MiniMax and writes `task_results`.
4. Runner optionally posts subtasks to `DECOMPOSE_CALLBACK_URL`.
5. `POST /api/feishu/decompose-callback` writes subtasks into Bitable.

Callback route behavior:

- Lists Bitable fields dynamically.
- Maps task title/status/assignee to matching fields.
- Inserts one Bitable record per task.
- Returns debug field info.

Risk:

- Bitable sync is non-fatal in the GitHub Action runner, so decomposition can be marked done while Bitable task sync failed.
- Callback auth is disabled if `FEISHU_API_TOKEN` is not configured.

## Worker Status Sync to Bitable

Code: `src/lib/feishu-worker-sync.ts`

Behavior:

- Gets Feishu tenant access token with in-process cache.
- Reads Bitable app/table config.
- Lists fields from Bitable.
- Updates an existing Bitable record by `recordId`.
- Maps status/progress/current step/status message/git commit/error/completed/updated fields by trying multiple Chinese and English field names.
- Catches and logs errors without throwing.

Record id sources:

- API body: `bitable_record_id`, `feishu_record_id`, `record_id`
- camelCase variants
- `job.payload`
- `job.result`
- `job.raw`

Risk:

- If `recordId` is missing, sync is skipped.
- If Bitable fields differ, partial update is skipped field by field.
- Status sync is best-effort and not a durable outbox.

## Feishu Environment Variable Names

Used by audited code:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_BOT_WEBHOOK`
- `FEISHU_API_TOKEN`
- `BITABLE_APP_TOKEN`
- `FEISHU_BITABLE_APP_TOKEN`
- `BITABLE_WORKER_TABLE_ID`
- `BITABLE_TASK_TABLE_ID`
- `BITABLE_TABLE_ID`
- `FEISHU_BITABLE_TABLE_ID`
- `DECOMPOSE_CALLBACK_URL`

## V2 Feishu Recommendations

1. Make Feishu automation route auth mandatory.
2. Add a durable Feishu sync outbox instead of only inline best-effort sync.
3. Store Feishu app/table/record ids in canonical job fields.
4. Separate user-facing replies from backend task creation.
5. Avoid inline LLM calls in the Feishu event route for long-running actions.
6. Add explicit idempotency constraints for event ids and Bitable record ids.
