# Canonical Canary Scope Control

Canonical production routing requires all of the following server-controlled conditions:

1. `HERMES_CANONICAL_ORCHESTRATION_ENABLED=true`
2. `CANONICAL_DATABASE_PERSISTENCE_ENABLED=true`
3. `HERMES_CANONICAL_CANARY_SCOPE_ENABLED=true`
4. `HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED=true`
5. An exact trusted Feishu `open_id` match
6. An exact server allowlisted batch code
7. The exact mode `worker_read_only`
8. A valid `HERMES_CANONICAL_CANARY_POLICY_ID`
9. A matching enabled persistence policy rule
10. An unconsumed durable one-shot scope

Message text supplies candidate batch and mode metadata only. It is never the authorization source. Missing, malformed, whitespace-normalized, wildcard, prefix, suffix, or case-varied configuration fails closed.

The Application evaluator runs after Feishu signature verification and before orchestration. The cutover guard and orchestration boundary require the resulting admission decision. `canonicalCreateJob` then calls the service-role-only `canonical_admit_canary_job` RPC, which validates the same policy tuple and atomically consumes the one-shot scope while creating one queued Canonical job.

Canonical job persistence uses the explicit `canonical_canary_job_insert_v1` contract. The validated Hermes subtask title is folded into `request_text`; Production has no separate `title` column. The full execution context is stored under the existing `result.canonical_context` JSON envelope and projected back to `payload` at the Worker boundary. The SQL insert names only columns observed in the Production catalog, uses `status=queued`, and never converts arbitrary JSON into a complete `hermes_jobs` row or adds compatibility columns.

The durable key is `(policy_id, owner_open_id, batch_code, requested_mode)`. A retry with the same `event_id` returns the existing job. A second distinct event for that scope is denied with `CANARY_ALREADY_CONSUMED`. The database transaction and unique constraint select at most one winner under concurrency.

This ledger is admission control only. It does not implement job, attempt, lease, or terminal state transitions. Existing Canonical state-machine tables and RPCs remain authoritative.

The migration artifact must not be applied to Production in the implementation batch. A later approved migration and deployment batch must provision one exact policy rule and matching environment metadata before Canonical can be enabled.
