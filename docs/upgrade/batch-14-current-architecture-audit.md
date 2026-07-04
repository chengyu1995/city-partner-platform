# BATCH-14 Current Architecture Audit

Audit date: 2026-07-05
Scope: system upgrade only. No website page development, `/post` work, `/partners` work, UI optimization, database execution, local preview server, Git commit, or Git push was performed.

## Current Runtime Flow

1. Feishu or manual intake creates a Hermes job.
2. Worker API exposes `/api/worker/next`, `/api/worker/progress`, `/api/worker/heartbeat`, and `/api/worker/report`.
3. Windows Worker polls the next-job route with a Worker identity.
4. The API marks an eligible job as `running`, sets `claimed_by`, and returns the job.
5. Windows Worker runs Codex under the forced no-Git/no-dev-server prompt guard.
6. Windows Worker sends progress and heartbeat updates while Codex runs.
7. Windows Worker reports a terminal result.
8. The outer Worker, not Codex, owns Git staging, commit, and push when enabled by its environment.

## Architecture Boundaries

- Business pages are frozen during the system upgrade period.
- Codex tasks inside the Worker may edit only files required by the task.
- Git operations are owned by the outer Windows Worker, not by Codex.
- Feishu sync remains best-effort and must not block canonical job state updates.
- Production deployment remains a human-controlled operation.

## BATCH-14 Findings

- Worker identity was split between `worker_id`, `worker_name`, headers, and query parameters.
- `/api/worker/heartbeat` was called by `local_worker.js` but did not exist in the Next.js app.
- Progress and final report updates did not enforce that the reporting Worker owned the claimed job.
- Final report updates were not idempotent for already terminal jobs.
- The existing audit docs describe the target V2 architecture, but there was no explicit system-upgrade freeze marker for BATCH-14 through BATCH-19.

## BATCH-14 Changes

- Centralized Worker identity parsing in `src/lib/worker-jobs.ts`.
- Added job ownership checks for progress, heartbeat, and report.
- Added terminal-state idempotency for progress, heartbeat, and report.
- Added a heartbeat route.
- Updated Windows Worker payloads and headers to send both canonical `worker_id` and legacy-compatible `worker_name`.
- Added upgrade freeze and roadmap documents.

## Remaining Risks

- The V1 claim path still depends on Supabase/PostgREST conditional update behavior; a future BATCH should replace it with an approved database RPC for stronger atomicity.
- Feishu sync failures are still non-blocking logs, not a durable retry outbox.
- Attempt-level IDs are still future work; BATCH-14 keeps compatibility with existing `hermes_jobs`.

