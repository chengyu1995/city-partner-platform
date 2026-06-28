# Rollback plan

## General rules

- Roll back one phase at a time.
- Do not roll back production data by deleting rows unless the owner explicitly approves.
- Prefer additive migrations with feature flags so rollback can disable new paths while preserving data.
- Keep Worker production directory backups under the existing backup pattern `C:\city-partner-worker-backups`.
- Do not print or copy real `.env` values during rollback.

## Phase 1 rollback: schema and state machine

Rollback method:

1. Disable new API code paths that write new statuses.
2. Restore previous status mapping in API/Worker if no data migration is required.
3. If SQL constraint changed, apply a rollback migration that accepts both old and new statuses temporarily.
4. Keep new columns; stop writing them rather than dropping immediately.

Verification:

- `/api/worker/next` can still claim legacy pending jobs.
- `/api/worker/report` can still mark failed jobs.

## Phase 2 rollback: atomic claim and recovery

Rollback method:

1. Switch `/api/worker/next` back to old select/update implementation.
2. Keep the SQL RPC in place but unused.
3. Disable scheduled requeue/reaper job.

Verification:

- Worker can claim one pending job in a single-Worker environment.
- No job is repeatedly requeued.

## Phase 3 rollback: heartbeat

Rollback method:

1. Leave heartbeat columns in DB.
2. Disable stale-heartbeat enforcement.
3. Make Worker heartbeat failures non-fatal, matching current behavior.

Verification:

- Long-running jobs are not failed only because heartbeat is absent.
- Worker report still finalizes jobs.

## Phase 4 rollback: Feishu sync decoupling

Rollback method:

1. Disable async sync worker or queue consumer.
2. Re-enable current inline `syncWorkerStatusToFeishu()` calls if needed.
3. Keep pending sync events for later replay; do not delete them by default.

Verification:

- Worker progress/report routes still return success.
- Feishu sync failures do not block job finalization.

## Phase 5 rollback: external route auth

Rollback method:

1. Re-enable previous auth behavior only for a short emergency window.
2. Prefer adding the missing token/env over disabling auth.
3. Keep logs of rejected requests for owner review.

Verification:

- Feishu automation can still create legitimate queue rows.
- Unauthorized requests remain blocked unless owner explicitly approved temporary compatibility mode.

## Phase 6 rollback: deployment status writeback

Rollback method:

1. Disable `.github/workflows/sync-vercel-deployment.yml` callback step or point it to a no-op endpoint.
2. Keep existing deployment status columns/events.
3. Stop Bitable deployment sync if it creates noisy or wrong updates.

Verification:

- Vercel deployments continue independently.
- Worker job completion no longer waits for deployment status.

## Phase 7 rollback: multi-layer task model

Rollback method:

1. Stop creating child jobs from new requirements.
2. Continue showing existing child jobs read-only.
3. Route new requirements back to the single-job model.
4. Preserve parent-child records for later migration; do not delete them.

Verification:

- New Feishu requirements still create executable work.
- Existing single-layer Worker jobs remain claimable.

## Phase 8 rollback: source health and hardening

Rollback method:

1. Revert only the code-health changes that caused regression.
2. Keep CI checks that passed; disable only the failing new check with owner approval.
3. If Worker deployment changed, use `deploy-worker.ps1` backup restore behavior or manually restore from `C:\city-partner-worker-backups`.

Verification:

- `npm run build` and Worker verification return to the last known good baseline.
- Production Worker process can start and poll.

## Emergency Worker rollback

Use existing deployment design:

1. Stop `CityPartnerCodexWorker` scheduled task.
2. Stop `node.exe` processes whose command line contains `local_worker.js`.
3. Restore files from the latest timestamped backup under `C:\city-partner-worker-backups`.
4. Do not overwrite or print production env file contents.
5. Start the scheduled task.
6. Confirm Worker process exists and logs do not contain secret values.

Repository evidence:

- `infra/windows-worker/deploy-worker.ps1` already contains backup, restore, process stop, and scheduled task restart logic.
