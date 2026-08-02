# Canonical Worker Job State Machine

Status: phase-one architecture decision and executable specification

Batch: `BATCH-ARCH-COMPLETE-02-JOB-STATE-MACHINE-SINGLE-SOURCE-OF-TRUTH-REFACTOR`

## Decision

Worker lifecycle state must no longer be inferred independently by API routes, runtime
fallback objects, request text, or in-memory maps. The canonical source is a normalized
database aggregate changed only through transactional state-machine commands.

The aggregate has three persisted parts:

| Concern | Canonical source of truth | Notes |
| --- | --- | --- |
| Job | `hermes_jobs.state` | One canonical job state. Legacy `status` becomes a compatibility projection during migration. |
| Attempt | `hermes_job_attempts.state` | One row per attempt. Rows are never deleted. `attempt_id` is immutable. |
| Lease | `hermes_job_leases.state` plus `expires_at` | One row per lease. Rows are released or expired, never deleted as recovery. |

`hermes_jobs.active_attempt_id` and `active_lease_id` are foreign-key references in the
same aggregate. They are consistency-enforced projections, not alternative state sources.
`request_text` is immutable task input and must never contain runtime attempt or lease state.

All transitions must run through database transactions exposed as narrow commands:

- `enqueue_worker_job`
- `claim_next_worker_job`
- `start_worker_attempt`
- `heartbeat_worker_attempt`
- `finish_worker_job`
- `abandon_stale_attempt`
- `cancel_worker_job`

API routes and the Tencent runtime are adapters. They may request a transition but may not
assemble partial lifecycle updates or silently drop state fields through schema fallback.

## Job States

The canonical job states are:

```text
created -> queued -> claimed -> running
                              |-> terminal_success
                              |-> terminal_failed
                              `-> terminal_cancelled
```

Allowed recovery transition:

```text
claimed|running --abandon stale attempt--> queued
```

Recovery creates a new future attempt. The abandoned attempt ID can never become active
again. A terminal job has no outbound transition.

## Attempt States

```text
attempt_created -> attempt_claimed -> attempt_running
                                      |-> attempt_finished
                                      |-> attempt_failed
                                      `-> attempt_abandoned
```

Attempt rows are permanent history. `attempt_finished`, `attempt_failed`, and
`attempt_abandoned` are terminal attempt states. A stale attempt is atomically marked
`attempt_abandoned`; it is not deleted and is never reused.

## Lease States

```text
lease_created -> lease_active -> lease_released
                            `-> lease_expired
```

Lease rows are permanent history. Only `lease_active` authorizes heartbeat, progress, or
report mutation. Terminal and queued jobs cannot reference an active lease.

## Aggregate Invariants

Every transition validates the complete aggregate under a database lock:

1. `queued` requires `claimed_by IS NULL`, `active_attempt_id IS NULL`, and
   `active_lease_id IS NULL`.
2. `claimed` requires non-null `claimed_by`, an `attempt_claimed` attempt, and an active
   lease owned by the same worker and attempt.
3. `running` requires non-null `claimed_by`, an `attempt_running` attempt, and an active
   unexpired lease owned by the same worker and attempt.
4. Terminal jobs require no claimant, no active attempt, no active lease, no retry request,
   `retryable=false`, and `selectable=false`.
5. An attempt belongs to exactly one job and worker. A lease belongs to exactly one attempt.
6. At most one non-terminal attempt and one active lease may exist for a job.
7. Runtime recovery may requeue only a non-terminal job and must abandon the old attempt and
   release or expire its lease in the same transaction.

Invalid combinations fail closed, including:

- `queued + active_attempt`
- `claimed + claimed_by=null`
- `terminal + retryable=true`
- `terminal + selectable=true`
- `running + no active_attempt`

## Selectable Predicate

`/api/worker/next` must call `claim_next_worker_job(worker_id)` rather than perform a
read-then-update sequence. The locked candidate predicate is:

```sql
state = 'queued'
AND terminal = false
AND claimed_by IS NULL
AND active_attempt_id IS NULL
AND active_lease_id IS NULL
AND NOT EXISTS (
  SELECT 1 FROM hermes_job_leases
  WHERE job_id = hermes_jobs.id AND state = 'lease_active'
)
```

The transaction creates the attempt and lease, updates the job to `claimed`, and returns the
claimed aggregate. If any invariant fails, no row is claimed. Terminal jobs are permanently
excluded and are never repaired as a side effect of selection.

## Report Merge

`POST /api/worker/report` calls `finish_worker_job(job_id, attempt_id, report)` under a row
lock. It first validates attempt ownership and an active lease, then persists three distinct
statuses:

- `worker_execution_status`: whether the worker process completed its execution path.
- `task_goal_status`: whether the approved task goal was achieved.
- `effective_final_status`: canonical job outcome derived from policy and the first two.

Worker success alone never implies job success. Only `effective_final_status` transitions the
job to a terminal state. The same terminal report is idempotent; a conflicting or stale
attempt report is rejected and cannot mutate the terminal aggregate.

## Crash And Stale Recovery

Recovery locks the job, active attempt, and lease. It may proceed only when the lease is
expired and the job is non-terminal. In one transaction it:

1. marks the attempt `attempt_abandoned`;
2. marks the lease `lease_expired` or `lease_released`;
3. clears job claimant and active references;
4. returns the job to `queued` only when retry policy permits it.

The old attempt remains queryable and cannot heartbeat, report, or execute again. A later
claim receives a new attempt ID.

## Current-State Audit

The phase-one audit found these gaps:

- terminal semantics use a shared predicate, but job lifecycle writes remain duplicated;
- both Next.js and Tencent `/next` select on queued status and null claimant only;
- attempt state may fall back to a mutable suffix in `request_text`;
- schema fallback can drop attempt and lease columns while still persisting part of a claim;
- no canonical attempt or lease table exists in the production schema;
- recovery and report handlers reconstruct state from different fields;
- manual terminal IDs remain a compatibility registry rather than persisted migration data.

This explains the observed FIX-51 combination: queued, selectable, no claimant, but with an
attempt marker. SMOKE-50 is terminal and must remain non-selectable throughout migration.

## Migration Plan

1. Add canonical job state, attempt, lease, and transition-event storage with constraints.
2. Backfill existing terminal jobs and convert runtime request suffixes into historical
   abandoned attempts without changing immutable request content.
3. Deploy dual-read audit mode and compare legacy projections with canonical aggregates.
4. Switch `/next`, heartbeat, progress, report, cancellation, and recovery to commands.
5. Remove request-text runtime metadata and legacy write paths after parity verification.

No schema, production state, runtime implementation, SMOKE-50, or FIX-51 is changed in this
phase.

## Phase 02A Compatibility Implementation

Phase 02A implements the canonical transition semantics without changing the production
database schema. Until the table migration above is approved and deployed, the complete
aggregate is persisted atomically in `hermes_jobs.result.job_state_machine`:

- `job_state` is the canonical job state;
- `active_attempt` and append-only `attempt_history` are the attempt source of truth;
- `active_lease` and append-only `lease_history` are the lease source of truth;
- legacy `status`, claim, attempt, lease, payload, and retry fields are compatibility
  projections written in the same compare-and-set update.

Claims compare `id`, legacy `status`, and `updated_at`, then persist the job transition,
attempt, and lease in one row update. A claim is not returned unless the canonical attempt
and lease can be read back from the aggregate. `request_text` is no longer mutated by new
claims; its attempt suffix is accepted only as a read-only migration fallback for historical
records such as FIX-51.

`worker_job_state_machine.js` is the only transition implementation used by the Next.js
adapters and the Tencent Worker API. Terminal cleanup also clears legacy runtime pointers and
retry projections, while preserving canonical attempt and lease history. The future table
migration remains the long-term storage target and is intentionally not part of this
no-deployment batch.
