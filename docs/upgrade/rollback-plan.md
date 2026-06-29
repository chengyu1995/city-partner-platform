# Rollback Plan

This plan covers future V2 implementation phases. No rollback action was performed during this audit.

## Principles

- Do not run destructive SQL without a reviewed rollback.
- Keep old routes and tables until V2 is verified.
- Make every migration additive first.
- Keep Worker deployment reversible through `infra/windows-worker/deploy-worker.ps1` backups.
- Keep Codex prohibited from Git operations; outer Worker remains responsible for Git.

## Phase 1 Rollback: Data Model

If V2 schema causes issues:

1. Stop writing to V2 tables from API routes.
2. Keep old `hermes_queue`, `task_results`, and `hermes_jobs` paths active.
3. Do not drop V2 tables immediately; mark them unused.
4. Revert code routes to legacy reads/writes.

Data risk:

- Additive tables are low rollback risk.
- Data copied from legacy to V2 may need reconciliation; avoid destructive migration.

## Phase 2 Rollback: Atomic Claim

If atomic claim blocks Workers:

1. Disable V2 claim endpoint.
2. Restore old `/api/worker/next` behavior.
3. Pause multiple Workers to reduce duplicate claim risk.
4. Leave claim RPC in database unused until fixed.

Data risk:

- Attempts created during failed rollout may need manual status cleanup.

## Phase 3 Rollback: Heartbeat

If heartbeat creates false failures:

1. Keep heartbeat storage columns.
2. Disable stale-heartbeat enforcement.
3. Continue logging heartbeat but do not fail jobs based on it.
4. Revert Worker heartbeat interval changes if needed.

Data risk:

- Heartbeat timestamps are diagnostic only and can remain.

## Phase 4 Rollback: API Auth/Contract

If new auth breaks Feishu or Worker:

1. Do not remove auth entirely in production.
2. Add temporary allowlist or compatibility token path.
3. Restore legacy payload parsing while logging missing V2 fields.
4. Rotate any token suspected to have been exposed during troubleshooting.

Data risk:

- Partial reports may need manual reconciliation.

## Phase 5 Rollback: Feishu Sync Outbox

If Feishu sync outbox fails:

1. Disable outbox processor.
2. Keep writing core job state to database.
3. Fall back to manual Feishu board updates.
4. Preserve queued sync rows for replay after fix.

Data risk:

- Feishu board can lag behind database but should not corrupt core job state.

## Phase 6 Rollback: Deployment Status Writeback

If deployment callback is noisy or wrong:

1. Disable `.github/workflows/sync-vercel-deployment.yml` callback step or point it to a no-op endpoint.
2. Keep deployment records already stored.
3. Stop Feishu deployment sync.
4. Continue using GitHub/Vercel native deployment views manually.

Data risk:

- Hermes job status will not reflect deployment state.

## Worker Deployment Rollback

Use existing deployment design:

1. `deploy-worker.ps1 -Apply` creates timestamped backups under `C:\city-partner-worker-backups`.
2. If deployment verification fails, the script restores files and restarts the scheduled task.
3. Use `-SkipRestart` when copy should be separated from process restart.
4. Watch for script markers:
   - `WORKER_DEPLOYMENT_SUCCEEDED`
   - `WORKER_DEPLOYMENT_ROLLED_BACK`

## Emergency Manual Recovery

If jobs are stuck:

1. Stop or pause Worker scheduled task.
2. Inspect database job rows by status and lease time.
3. Requeue only jobs known safe to retry.
4. Do not modify production data without owner approval.
5. Restart Worker after queue state is consistent.
6. Pause Feishu writeback if it is producing bad updates.
7. Pause deployment callback workflow if it is causing bad writes.

## Owner Approval Gates

Rollback-sensitive operations require owner approval:

- Any SQL migration on production.
- Any destructive cleanup.
- Worker production deployment with `-Apply`.
- Feishu table creation or field changes.
- Deployment callback activation.
