# Current Automation Architecture Audit

Audit date: 2026-06-29

Scope: audit only. No business code, database migration, Feishu configuration, deployment, Git staging, Git commit, or Git push was performed.

Environment files: not read. This document lists environment variable names only.

## Repository Evidence

- Feishu event ingress: `src/app/api/feishu/event/route.ts`
- Feishu Bitable automation ingress: `src/app/api/feishu/requirement/route.ts`, `src/app/api/feishu/codex-task/route.ts`
- Feishu Bitable table creation: `src/app/api/feishu/create-tables/route.ts`
- Feishu decomposition callback: `src/app/api/feishu/decompose-callback/route.ts`
- Worker APIs: `src/app/api/worker/next/route.ts`, `src/app/api/worker/progress/route.ts`, `src/app/api/worker/report/route.ts`
- Worker shared helpers: `src/lib/worker-jobs.ts`, `src/lib/feishu-worker-sync.ts`
- Windows Worker: `infra/windows-worker/local_worker.js`, `infra/windows-worker/start-worker.ps1`, `infra/windows-worker/deploy-worker.ps1`
- Decomposition cron: `.github/workflows/hermes-decompose.yml`, `scripts/hermes_decompose_runner.py`
- Deployment status workflow: `.github/workflows/sync-vercel-deployment.yml`
- Database setup docs: `docs/setup-hermes-jobs.sql`, `docs/setup-hermes-queue.sql`, `docs/setup-hermes-conversations.sql`

## Actual End-to-End Flow

1. Feishu message events post to `POST /api/feishu/event`.
2. The event route verifies/decrypts Feishu payloads, filters `im.message.receive_v1`, handles p2p and group mention rules, records `feishu_event_receipts`, loads/creates `hermes_conversations`, calls `runAgent()`, stores `hermes_messages`, and replies to Feishu.
3. Feishu Bitable automations can also post to `POST /api/feishu/requirement` and `POST /api/feishu/codex-task`; these routes insert raw records into `hermes_queue`.
4. `.github/workflows/hermes-decompose.yml` runs every 5 minutes and calls `scripts/hermes_decompose_runner.py`.
5. The runner reads pending `hermes_queue`, calls MiniMax, writes `task_results`, optionally calls `DECOMPOSE_CALLBACK_URL` to sync subtasks to Feishu Bitable, and posts a Feishu bot notification.
6. The Windows Worker polls `GET /api/worker/next`, receives one row from `hermes_jobs`, runs Codex CLI in `PROJECT_DIR`, reports progress to `/api/worker/progress`, and reports final output to `/api/worker/report`.
7. Worker APIs update `hermes_jobs` and call `syncWorkerStatusToFeishu()` to update the Feishu Bitable record when a record id is available.
8. The Worker can automatically commit and push through its own Git pipeline after Codex exits, controlled by Worker environment variables.
9. `.github/workflows/sync-vercel-deployment.yml` listens for GitHub deployment status events and posts commit deployment status to a configured callback URL, but no matching receiver route was found in this repository.

## Important Architecture Split

There are two partially separate queues:

- `hermes_queue`: receives Feishu Bitable automation events and is processed by GitHub Actions decomposition.
- `hermes_jobs`: is polled by the Windows Worker and is the actual Codex execution queue.

The audited code does not show a complete, reliable bridge from `hermes_queue` decomposition results into executable `hermes_jobs` rows. This is the main Phase 0 finding for the V2 upgrade.

## Missing or Incomplete Components

- `POST /api/worker/heartbeat`: called by `local_worker.js`, but no route exists under `src/app/api/worker`.
- Atomic job claim: `/api/worker/next` selects a candidate row and then updates it; there is no single SQL/RPC claim operation.
- Lease recovery: `expires_at` is written, but no audited route or scheduled job requeues expired running jobs.
- Deployment callback receiver: workflow posts `X-Deploy-Secret` to `DEPLOY_CALLBACK_URL`, but no repository API route handles it.
- Status compatibility: SQL setup allows `pending`, `running`, `awaiting_review`, `completed`, `failed`; API/Worker code also uses `queued` and `succeeded`.
- Worker result compatibility: Worker sends `result_text` and `deploy_status`, but `/api/worker/report` mainly consumes `output`, `pr_url`, `files_changed`, `build_passed`, `test_passed`, `duration_ms`, and `git_commit_sha`.

## Phase 0 Conclusion

The current system is usable as a single-layer automation prototype, but V2 should first normalize the execution model around one durable job state machine, one atomic claim path, heartbeat/lease recovery, and a defined parent-child task structure before starting Phase 1 feature work.
