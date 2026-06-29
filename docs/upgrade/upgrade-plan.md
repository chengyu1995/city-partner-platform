# Hermes V2 Upgrade Plan

This is an audit-derived plan only. Phase 1 should not start until approved.

## Phase 0: Completed Audit

Deliverables:

- Current architecture audit.
- Database audit.
- API audit.
- Worker audit.
- Feishu audit.
- Security/risk audit.
- Upgrade plan.
- Rollback plan.

Status: waiting_review.

## Phase 1: Data Model and State Machine

Goal: define one source of truth for requirements, tasks, subtasks, and execution attempts.

Work:

1. Design V2 tables:
   - requirements
   - tasks
   - subtasks
   - execution attempts
   - Feishu sync outbox
   - deployment records
2. Define status enums:
   - requirement status
   - task status
   - subtask status
   - attempt status
   - deployment status
3. Map legacy `hermes_queue`, `task_results`, and `hermes_jobs` to V2.
4. Add migrations only after human approval.

Acceptance:

- Runtime status names match database constraints.
- Every executable unit has a parent task and attempt history.
- No production data migration is run without approval.

## Phase 2: Atomic Claim and Lease Recovery

Goal: prevent duplicate claim and stuck jobs.

Work:

1. Add atomic claim RPC or conditional update:
   - eligible statuses
   - lease expiry predicate
   - priority order
   - worker identity
   - attempt creation
2. Add stale lease recovery:
   - `lease_expires_at`
   - `heartbeat_at`
   - attempt timeout
   - max attempts
3. Update `GET /api/worker/next` to call atomic claim.

Acceptance:

- Two simultaneous Workers cannot receive the same attempt.
- Expired attempts are requeued or failed according to policy.

## Phase 3: Heartbeat and Worker Health

Goal: make Worker liveness observable.

Work:

1. Add `POST /api/worker/heartbeat`.
2. Store `heartbeat_at`, `worker_name`, optional Worker version/base commit.
3. Make heartbeat interval configurable or align docs with fixed 60 seconds.
4. Show stale heartbeat in job status and Feishu sync.

Acceptance:

- Worker heartbeat succeeds.
- Heartbeat failures have server-side signal.
- Dead Worker can be detected without reading local logs.

## Phase 4: API Auth and Contract Alignment

Goal: fail closed and stabilize payloads.

Work:

1. Require auth for all external write routes in production.
2. Standardize Worker identity field.
3. Standardize progress/report body:
   - `attempt_id`
   - `job_id`
   - `status`
   - `progress_percent`
   - `current_step`
   - `status_message`
   - `output`
   - `git_commit_sha`
   - `deploy_status`
4. Enforce Worker ownership on progress/report.
5. Add schema validation.

Acceptance:

- Missing auth env does not open write endpoints.
- Worker payload fields are persisted or intentionally ignored with tests.

## Phase 5: Feishu Sync Outbox

Goal: avoid blocking main job state on Feishu and avoid silent divergence.

Work:

1. Store Feishu record IDs on V2 rows.
2. Add `feishu_sync_events` table.
3. Write desired sync events transactionally with job changes.
4. Process outbox with retry/backoff.
5. Store last error and last successful sync time.
6. Centralize field mapping.

Acceptance:

- Feishu failures are visible and retryable.
- Main Worker report is not blocked by Feishu API availability.

## Phase 6: Deployment Status Writeback

Goal: close Git push -> Vercel deploy -> Hermes state loop.

Work:

1. Add authenticated deployment callback route for `.github/workflows/sync-vercel-deployment.yml`, or remove the workflow.
2. Store deployment status by commit SHA.
3. Link deployment status to the corresponding attempt.
4. Sync deployment URL/status to Feishu through outbox.

Acceptance:

- A pushed commit can be traced to deployment status.
- Missing callback secret fails closed.

## Phase 7: Worker Hardening

Goal: make local Worker safer under interruption.

Work:

1. Keep Codex Git prohibition guard.
2. Make rollback cover tracked and untracked task-created files.
3. Persist concise execution artifacts.
4. Add tests for Worker/API contract.
5. Reconcile README, deployment script, and runtime env names.

Acceptance:

- Failed task leaves clean worktree or explicit quarantine.
- Worker verification covers API payload contract.

## Recommended Phase 1 Start Criteria

Start only after owner approval of:

- V2 schema.
- Status enum names.
- Whether `hermes_queue` remains or is replaced.
- Worker branch/commit/push policy.
- Feishu table mapping.
- Deployment callback behavior.
