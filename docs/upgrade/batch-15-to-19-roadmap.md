# BATCH-15 to BATCH-19 Upgrade Roadmap

This roadmap continues the system upgrade after BATCH-14. It does not authorize business feature work.

## BATCH-15: Atomic Claim and Lease Recovery

Goal: prevent duplicate task execution and stuck running jobs.

Deliverables:

- Approved Supabase RPC or equivalent conditional claim contract.
- Lease expiry policy for `running` jobs.
- Recovery behavior for expired jobs.
- Static tests or route-level checks proving two Workers cannot claim the same executable unit.

Acceptance:

- Claim writes are atomic.
- Expired jobs can be retried or failed according to policy.
- Ownership remains visible through `claimed_by`.

## BATCH-16: Feishu Boss Console, Attempt Model, and Worker Contract

Goal: let the boss control the project director and multi Agent dispatcher from Feishu, and move from job-only reporting to attempt-aware reporting.

Deliverables:

- Feishu boss console commands for help, status, pause, resume, and approved execution.
- Attempt ID contract for claim, heartbeat, progress, and report.
- Worker payload schema for `attempt_id`, `job_id`, `worker_id`, status, progress, result, and error fields.
- Compatibility notes for existing `hermes_jobs`.

Acceptance:

- Boss can use Feishu commands to inspect and control project director dispatch.
- Every execution has a durable attempt identity.
- Duplicate terminal reports for the same attempt are idempotent.
- Reports from the wrong Worker are rejected.

## BATCH-17: Feishu Sync Outbox

Goal: make Feishu writeback retryable and non-blocking.

Deliverables:

- Outbox table or approved queue contract.
- Idempotency key for each desired Feishu update.
- Retry/backoff policy and operator visibility.
- Central field mapping for Worker status, progress, result, and deployment state.

Acceptance:

- Main task state does not depend on Feishu availability.
- Failed syncs can be retried without duplicating records.
- Last error and last success are inspectable.

## BATCH-18: Deployment Status Loop

Goal: connect Worker Git output to deployment status tracking.

Deliverables:

- Authenticated deployment callback route or documented removal of the existing workflow.
- Commit-SHA to job/attempt linkage.
- Preview status fields synchronized through the outbox.

Acceptance:

- A Worker-produced commit can be traced to deployment status.
- Missing or invalid callback secrets fail closed.
- Deployment sync never triggers production deployment by Codex.

## BATCH-19: Operator Runbook and Freeze Exit Review

Goal: make the upgraded project director system operable.

Deliverables:

- Updated Worker runbook.
- Failure-mode checklist.
- Static verification checklist.
- Freeze-exit review document.

Acceptance:

- Operators can diagnose queued, running, stale, failed, and completed jobs.
- Static verification commands are documented and pass or produce actionable warnings.
- A human owner explicitly approves lifting the business-development freeze.
