# Hermes Canonical Cutover Rollback Plan

## Purpose

This plan prepares a reversible Hermes canonical production cutover without activating it. Production defaults remain Legacy primary, canonical orchestration off, and Shadow off.

## Enable Gate

Canonical execution may be enabled only after the controlled-enable approval verifies the canonical database runtime, Worker attempt/lease/revision protocol, terminal first truth, and production health gates. Shadow and Canonical must never be enabled together.

The runtime switch is controlled by `HERMES_CANONICAL_ORCHESTRATION_ENABLED`. Its default is off. `HERMES_CANONICAL_ROLLBACK_TO_LEGACY` is an independent emergency override and wins over the canonical flag.

## Immediate Rollback

1. Set `HERMES_CANONICAL_ROLLBACK_TO_LEGACY=true`, or disable `HERMES_CANONICAL_ORCHESTRATION_ENABLED`.
2. Verify the resolved cutover state reports `canonical_enabled=false` and `legacy_primary=true`.
3. Keep Legacy as the primary request and reporting path.
4. Preserve all canonical Job, Attempt, Lease, and Terminal records for audit.
5. Do not delete attempts, leases, terminals, or canonical jobs.
6. Do not run a reverse migration or destructive schema rollback.

## Failure Boundary

A canonical planning or validation failure may fall back to Legacy only before any canonical authoritative job write. Once a canonical write is recorded, any later failure must fail closed. This prevents Legacy and Canonical from both becoming authoritative for the same approved request.

## Recovery Verification

After rollback, verify Legacy intake and reporting, confirm no new canonical claims are created, and inspect canonical records read-only. Existing canonical history remains immutable and available for diagnosis. Re-enable Canonical only through a new controlled-enable approval.
