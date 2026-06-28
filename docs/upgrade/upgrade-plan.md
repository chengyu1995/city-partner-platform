# Upgrade plan

This plan starts after phase 0 approval. Do not begin phase 1 without owner approval.

## Phase 1: Stabilize schema and state machine

Goal: make `hermes_jobs` status and fields match actual Worker/API behavior.

Minimal tasks:

1. Define canonical job statuses: suggested set `queued`, `claimed`, `running`, `waiting_review`, `succeeded`, `failed`, `cancelled`.
2. Add or confirm required `hermes_jobs` columns: progress, current step, status message, commit SHA, error text, completed timestamp, heartbeat timestamp, lease expiry, record id.
3. Add a SQL migration for the canonical status check constraint.
4. Replace string literals in Worker API with shared constants.
5. Add tests for allowed transitions.

Exit criteria:

- API, SQL, Worker, and Feishu sync use one status vocabulary.
- Existing jobs can be migrated without losing history.

## Phase 2: Atomic job claim and lease recovery

Goal: remove duplicate claiming and stuck running jobs.

Minimal tasks:

1. Create SQL RPC `claim_next_hermes_job(worker_id)` that atomically selects and updates one queued/expired job.
2. Include attempt increment and lease expiry in the atomic claim.
3. Update `/api/worker/next` to call the RPC.
4. Add expired job requeue logic with max attempts.
5. Add tests for concurrent claims.

Exit criteria:

- Two Workers cannot claim the same job.
- Expired jobs are recoverable or marked failed with reason.

## Phase 3: Heartbeat and Worker health

Goal: make Worker liveness explicit and reliable.

Minimal tasks:

1. Add `/api/worker/heartbeat`.
2. Store `heartbeat_at`, `worker_name`, and optional `pid` or runtime metadata.
3. Make heartbeat interval configurable or update docs to fixed value.
4. Add server-side stale heartbeat detection.
5. Update Worker report flow to distinguish alive-but-running from stalled.

Exit criteria:

- Dashboard can show active Worker and stale jobs.
- Heartbeat failures produce actionable status.

## Phase 4: Decouple Feishu sync from critical path

Goal: avoid Feishu API latency blocking Worker claim/progress/report.

Minimal tasks:

1. Add a `feishu_sync_events` table or reuse a queue with event type.
2. Worker API writes sync events instead of awaiting Feishu API.
3. Add a sync processor with retries and sanitized errors.
4. Keep immediate best-effort sync only if bounded by short timeout.

Exit criteria:

- Worker API remains responsive when Feishu is slow.
- Failed Feishu sync is retryable and visible.

## Phase 5: Secure public mutation routes

Goal: make all external mutation endpoints explicitly authenticated.

Minimal tasks:

1. Require `FEISHU_API_TOKEN` or Feishu signature/token validation for `/api/feishu/requirement`.
2. Require auth for `/api/feishu/codex-task`.
3. Make `/api/feishu/create-tables` admin-only and disabled in production unless explicitly enabled.
4. Add rate limiting or idempotency keys for Feishu event and Bitable automation routes.

Exit criteria:

- Missing auth config fails closed.
- Unauthorized mutation requests return 401.

## Phase 6: Deployment status writeback

Goal: close the GitHub/Vercel status loop.

Minimal tasks:

1. Add authenticated deployment callback route or remove the workflow if no longer needed.
2. Validate `X-Deploy-Secret`.
3. Store deployment status by `git_commit_sha`.
4. Sync deployment URL/status to Bitable via queue.
5. Add tests for callback payloads.

Exit criteria:

- Vercel deployment statuses are visible on the corresponding Worker job.

## Phase 7: Multi-layer task model

Goal: support phases, subtasks, dependencies, and review gates.

Minimal tasks:

1. Decide whether `hermes_queue` should feed `hermes_jobs` directly or whether a new parent-child job model is needed.
2. Add parent job id, phase, dependency, and role fields.
3. Add smallest scheduling rule: executable only when dependencies succeeded and owner approval not required.
4. Add Feishu Bitable sync mapping for phase/task hierarchy.

Exit criteria:

- One requirement can produce multiple independently tracked Worker jobs.

## Phase 8: Source health and operational hardening

Goal: make the current codebase verifiably buildable and operable.

Minimal tasks:

1. Run syntax checks and TypeScript build in a dedicated code-health task.
2. Fix mojibake or malformed string literals in source files.
3. Add CI checks for Worker `node --check`, Worker tests, and route typecheck.
4. Add centralized external-error sanitizer.

Exit criteria:

- CI catches syntax, type, Worker safety, and secret leak regressions.
