# Windows Worker Audit

Audit date: 2026-06-29

## Files Audited

- `infra/windows-worker/local_worker.js`
- `infra/windows-worker/start-worker.ps1`
- `infra/windows-worker/deploy-worker.ps1`
- `infra/windows-worker/git-safety.js`
- `infra/windows-worker/README.md`

## Startup

`start-worker.ps1`:

- Uses production Worker directory `C:\city-partner-worker`.
- Expects `local_worker.js` under that directory.
- Writes logs to `C:\city-partner-worker\logs\scheduled-worker.log`.
- Refuses duplicate startup when a `node.exe` process command line contains `local_worker.js`.
- Starts `C:\Program Files\nodejs\node.exe .\local_worker.js`.

`deploy-worker.ps1`:

- Default mode is dry-run.
- Copies selected Worker files from repository source to `C:\city-partner-worker` only when `-Apply` is passed.
- Backs up existing files and the production env file without printing env contents.
- Blocks source `.env`.
- Runs verification before apply.
- Can restart scheduled task `CityPartnerCodexWorker`.

## Required Runtime Configuration Names

From `local_worker.js` and README:

- `WORKER_API_URL`
- `WORKER_TOKEN`
- `WORKER_NAME`
- `PROJECT_DIR`
- `POLL_INTERVAL_MS`
- `CODEX_TIMEOUT_MS`
- `CODEX_IDLE_TIMEOUT_MS`
- `CODEX_EXE`
- `GIT_AUTO_COMMIT`
- `GIT_ROLLBACK_ON_FAILURE`
- `GIT_AUTO_PUSH`
- `GIT_REMOTE_NAME`
- `GIT_PUSH_BRANCH`

No env file values were read.

## Polling Logic

`main()` runs forever until `SIGINT` or `SIGTERM`.

Loop behavior:

1. Calls `pollOnce()`.
2. Catches and logs polling errors.
3. Sleeps `POLL_INTERVAL_MS`, default 5000 ms.

`pollOnce()`:

1. Skips if already `working` or stopping.
2. Requests `GET /api/worker/next?worker_name=<WORKER_NAME>`.
3. If no `job.id`, returns.
4. Marks `working = true`.
5. Reports progress at 5%.
6. Starts heartbeat.
7. Runs Git preparation.
8. Runs Codex CLI.
9. Runs Git commit and optional push through Worker-owned logic.
10. Reports success or failure.
11. Stops heartbeat and clears `working`.

## Codex CLI Invocation

The Worker spawns:

```text
codex.exe exec -C <PROJECT_DIR> --sandbox workspace-write --skip-git-repo-check <guarded prompt>
```

Default executable:

```text
C:/Users/admin/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe
```

Runtime environment additions:

- `CI=1`
- `NO_COLOR=1`

The prompt is wrapped by `CODEX_GIT_OPERATION_GUARD`, which tells Codex not to run Git add/commit/push or create branches. Git operations are owned by the outer Worker.

Timeouts:

- Hard timeout: `CODEX_TIMEOUT_MS`, default 900000 ms.
- Idle timeout: `CODEX_IDLE_TIMEOUT_MS`, default 60000 ms.
- During Codex execution, the Worker also posts progress every 30 seconds.

## Git Logic

When `GIT_AUTO_COMMIT=true`:

1. Asserts the worktree is clean before Codex.
2. Fetches remote and switches/pulls the configured branch.
3. Captures base commit.
4. After Codex exits, reads changed paths.
5. Stages only those paths.
6. Validates staged paths match task paths.
7. Scans for sensitive paths/content.
8. Commits with `worker: <job.id> <summary>`.

When `GIT_AUTO_PUSH=true`:

- Pushes `HEAD:<branch>` to configured remote.
- On first push failure, pulls with rebase and retries.

On task failure:

- If enabled, restores tracked files to the pre-task base commit.
- Untracked file rollback is limited; the code unstages changed paths and restores tracked paths.

## Heartbeat

Worker implements a heartbeat client:

- `sendHeartbeat(jobId)` posts to `/api/worker/heartbeat`.
- `startHeartbeat(jobId)` sends immediately and every 60 seconds.

Findings:

- No `/api/worker/heartbeat` route exists in the audited repository.
- README mentions `HEARTBEAT_INTERVAL_MS`, but code uses a fixed 60 seconds.
- Heartbeat failures are logged and do not stop Codex.

## Result Handling

Success report includes:

- `job_id`
- `status = succeeded`
- `result_text`
- `git_commit_sha`
- `deploy_status = pending` when push occurred

Failure report includes:

- `job_id`
- `status = failed`
- `error_text`

Mismatch:

- `/api/worker/report` does not explicitly consume `result_text` or `deploy_status`.

## Worker Risks

- Worker can auto-commit and auto-push even though Codex itself is guarded; this is intentional but high impact.
- Missing heartbeat route makes liveness incomplete.
- Non-atomic server claim means multiple Workers can duplicate work.
- Worker does not appear to check claim owner on progress/report.
- If Codex exits successfully but validation misses a semantic issue, Worker may commit/push automatically.
- If Git push triggers Vercel deployment, deployment state writeback is not closed because callback receiver is missing.

## V2 Worker Recommendations

1. Keep Codex prohibited from Git; keep Worker as the only Git actor.
2. Add explicit allowed path constraints per job, not only post-hoc changed path detection.
3. Add heartbeat route and configurable heartbeat interval.
4. Require server claim ownership token or lease id for progress/report.
5. Store Worker version, hostname, PID, Codex version, and base commit in job metadata.
6. Make deployment status a separate state after push, not a loose report field.
