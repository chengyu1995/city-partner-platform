# Upgrade Plan for Hermes Multi-Role Task System V2

Audit date: 2026-06-29

This plan intentionally stops before Phase 1 implementation. It lists recommended sequencing only.

## Phase 0 Exit Criteria

Before Phase 1 starts:

- Current architecture audit reviewed.
- Database state machine decision approved.
- Worker Git authority and branch policy approved.
- Feishu route authentication policy approved.
- No production database migration run from this audit task.

## Phase 1: Canonical Data Model

Goal: define one source of truth for requirements, tasks, subtasks, and execution attempts.

Recommended work:

1. Decide whether `hermes_queue` remains only an ingest queue or becomes part of job orchestration.
2. Create a canonical V2 schema:
   - parent requirement
   - child tasks
   - execution attempts
   - Feishu Bitable mapping
   - deployment records
3. Normalize status values across SQL, API, Worker, and Feishu.
4. Add required runtime fields currently missing from setup SQL.
5. Add idempotency keys:
   - Feishu event id
   - Feishu message id
   - Bitable record id
   - normalized task fingerprint

Acceptance:

- One documented state machine.
- Runtime code no longer needs missing-column skip behavior for expected fields.

## Phase 2: Atomic Claim and Lease Recovery

Goal: prevent duplicate execution and recover stuck tasks.

Recommended work:

1. Add SQL RPC or conditional update for claiming the next job.
2. Return a claim token or lease id.
3. Require claim ownership on progress/report.
4. Add lease expiry recovery:
   - running with expired lease
   - max attempts
   - terminal failed state
5. Add indexes for claim queries.

Acceptance:

- Two Workers cannot claim the same job.
- Stale running jobs are visible and recoverable.

## Phase 3: Heartbeat and Worker Health

Goal: make Worker liveness observable.

Recommended work:

1. Add `POST /api/worker/heartbeat`.
2. Store `heartbeat_at`, `worker_name`, optional PID/version/base commit.
3. Make heartbeat interval configurable or align docs with fixed 60 seconds.
4. Show stale heartbeat in job status and Feishu sync.

Acceptance:

- Heartbeat failures have a server-side signal.
- A killed Worker leaves evidence for recovery.

## Phase 4: Feishu Security and Sync Reliability

Goal: make Feishu ingress and Bitable sync safe.

Recommended work:

1. Require auth/signature on all Feishu automation routes.
2. Disable or strongly gate `/api/feishu/create-tables` in production.
3. Add durable Feishu sync outbox:
   - target app/table/record
   - payload
   - attempt count
   - last error
4. Move long-running Feishu event work to queue-based processing.

Acceptance:

- Missing auth config fails closed.
- Feishu Bitable can be eventually consistent with retry.

## Phase 5: Worker Git and Codex Guardrails

Goal: keep Git automation useful but bounded.

Recommended work:

1. Require job-level allowed paths.
2. Reject changes outside allowed paths before commit.
3. Add sensitive path and sensitive content checks to server-side audit too.
4. Include Codex version, prompt hash, changed files, and base/head SHA in report.
5. Keep Codex prohibited from Git operations.

Acceptance:

- Worker can prove exactly what it committed and why.
- Sensitive files and infrastructure paths require explicit human approval.

## Phase 6: Deployment Status Writeback

Goal: close GitHub/Vercel feedback loop.

Recommended work:

1. Add authenticated deployment callback route for `.github/workflows/sync-vercel-deployment.yml`, or remove the workflow.
2. Store deployment status by commit SHA.
3. Link deployment status to the corresponding job/attempt.
4. Sync deployment URL/status to Feishu Bitable through the sync outbox.

Acceptance:

- A pushed commit has visible deploy pending/success/failure state on the job.

## Phase 7: Multi-Role Orchestration

Goal: implement Hermes V2 roles after foundation is stable.

Recommended work:

1. Model roles such as product, design, Codex, test, review, owner approval.
2. Add dependencies between tasks.
3. Add approval gates for production-sensitive actions.
4. Add owner-facing decision records.

Acceptance:

- V2 can represent one requirement with multiple role-specific tasks and a clear owner approval path.

## Phase 1 Recommendation

Start Phase 1 with database/state-machine design, not UI or Worker feature work. The current highest-risk gap is not missing functionality; it is inconsistent orchestration state.
