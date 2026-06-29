# Rollback Plan

Audit date: 2026-06-29

This is a planning document only. No rollback was performed.

## General Rollback Rules

- Keep V2 changes behind explicit feature flags where possible.
- Never delete V1 tables during V2 rollout.
- Add nullable columns first, backfill separately, enforce constraints last.
- Keep Worker deployment reversible through `infra/windows-worker/deploy-worker.ps1` backups.
- Keep Feishu Bitable schema changes additive until V2 is accepted.

## Phase 1 Rollback: Data Model

If a V2 schema migration causes issues:

1. Disable V2 routes or feature flag.
2. Keep new tables/columns in place but stop writing to them.
3. Continue using existing `hermes_queue` and `hermes_jobs` behavior.
4. Revert application code through normal Git/Worker pipeline.

Do not drop V2 tables immediately unless data privacy or production safety requires it.

## Phase 2 Rollback: Atomic Claim

If atomic claim RPC fails:

1. Switch Worker API back to old `/api/worker/next` behavior.
2. Disable multi-Worker concurrency.
3. Manually inspect running jobs before requeue.

Residual risk:

- Duplicate claim risk returns until atomic claim is restored.

## Phase 3 Rollback: Heartbeat

If heartbeat creates false failures:

1. Keep heartbeat storage columns.
2. Disable stale-heartbeat enforcement.
3. Continue logging heartbeat but do not fail jobs based on it.
4. Revert Worker heartbeat interval changes if needed.

Residual risk:

- Stalled Worker detection becomes manual again.

## Phase 4 Rollback: Feishu Auth and Sync

If Feishu automation stops working after auth changes:

1. Confirm Feishu automation headers/secrets with a human operator.
2. Temporarily disable only the failing route.
3. Do not open unauthenticated production routes as a permanent fix.
4. Queue failed Bitable sync records for retry after configuration is corrected.

Residual risk:

- Bitable may lag backend truth during rollback.

## Phase 5 Rollback: Worker Git Guardrails

If new path restrictions block valid tasks:

1. Mark affected jobs `waiting_review` or equivalent.
2. Have a human approve expanded allowed paths.
3. Avoid disabling sensitive path checks globally.
4. Re-run only after allowed scope is explicit.

Residual risk:

- Overly broad allowed paths can recreate current production misoperation risk.

## Phase 6 Rollback: Deployment Status Writeback

If deployment callback is noisy or wrong:

1. Disable `.github/workflows/sync-vercel-deployment.yml` callback step or point it to a no-op endpoint.
2. Keep deployment records already stored.
3. Stop Feishu deployment sync.
4. Continue using GitHub/Vercel native deployment views manually.

Residual risk:

- Hermes job status will not reflect deployment state.

## Worker Deployment Rollback

Use existing deployment design:

1. `deploy-worker.ps1` creates timestamped backups under `C:\city-partner-worker-backups`.
2. If deployment verification fails, the script restores files and restarts the scheduled task.
3. For manual rollback, restore the previous backup files to `C:\city-partner-worker`.
4. Do not copy or print production env file contents.

Expected markers:

- Success: `WORKER_DEPLOYMENT_SUCCEEDED`
- Rollback: `WORKER_DEPLOYMENT_ROLLED_BACK`

## Emergency Stop

If automation behaves unexpectedly:

1. Stop the Windows scheduled task `CityPartnerCodexWorker`.
2. Disable or rotate Worker API token with human approval.
3. Disable Feishu automation rules or route traffic at the platform layer.
4. Pause GitHub deployment status callback workflow if it is causing bad writes.
5. Preserve logs and job records for audit.

## Review Gate

After this Phase 0 audit, the recommended status is `waiting_review`. Phase 1 should not begin until the owner approves the V2 state model and rollout order.
