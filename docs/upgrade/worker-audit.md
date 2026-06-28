# Worker audit

## Entry files

- Main Worker: `infra/windows-worker/local_worker.js`
- Startup script: `infra/windows-worker/start-worker.ps1`
- Deployment script: `infra/windows-worker/deploy-worker.ps1`
- Watchdog script: `infra/windows-worker/worker-watchdog.ps1`
- Verification script: `infra/windows-worker/verify-worker.ps1`
- Git safety helper: `infra/windows-worker/git-safety.js`
- Worker package: `infra/windows-worker/package.json`

## Startup command

Documented and implemented startup paths:

- Production Worker directory documented as `C:\city-partner-worker`.
- Manual start: `node local_worker.js`.
- Scheduled task script: `powershell -ExecutionPolicy Bypass -File .\start-worker.ps1`.
- `start-worker.ps1` checks for existing `node.exe` with `local_worker.js`, sets location to `C:\city-partner-worker`, and runs `C:\Program Files\nodejs\node.exe .\local_worker.js`, appending output to `logs/scheduled-worker.log`.

## Required Worker environment variable names

The audit did not read any `.env` values.

Names used by `local_worker.js`:

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

## Polling flow

`main()` loops until stopped:

1. Calls `pollOnce()`.
2. Sleeps `POLL_INTERVAL_MS`, default `5000`.
3. Catches polling errors and continues.

`pollOnce()`:

1. Skips if already `working` or `stopping`.
2. Requests `GET /api/worker/next?worker_name=<WORKER_NAME>`.
3. If no job, returns.
4. Sets `working = true`.
5. Reports progress 5 percent.
6. Starts heartbeat timer.
7. Syncs Git if auto commit enabled.
8. Runs Codex.
9. Commits and optionally pushes through Worker-owned Git logic.
10. Reports final state to `/api/worker/report`.
11. Stops heartbeat and clears `working`.

## Codex CLI invocation

Function: `runCodex(prompt)` in `infra/windows-worker/local_worker.js`.

Executable:

- `CODEX_EXE`, default `C:/Users/admin/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe`.

Arguments:

- `exec`
- `-C`
- `PROJECT_DIR`
- `--sandbox`
- `workspace-write`
- `--skip-git-repo-check`
- guarded prompt text

Process settings:

- `shell: false`
- `windowsHide: true`
- stdio captures stdout and stderr
- env includes `CI=1` and `NO_COLOR=1`

Timeouts:

- Hard timeout: `CODEX_TIMEOUT_MS`, default `900000`.
- Idle timeout: `CODEX_IDLE_TIMEOUT_MS`, default `60000`.
- On timeout, `taskkill /PID <pid> /T /F` kills the process tree.

Prompt guard:

- `buildWorkerGuardedPrompt()` prepends rules forbidding Codex from running `git add`, `git commit`, `git push`, creating branches, changing Git config, calling GitHub writes, or temporary-cloning for submission.

## Git handling

Implemented in `infra/windows-worker/local_worker.js`.

Before Codex:

- If `GIT_AUTO_COMMIT` is true, `prepareGitTask()` verifies Git repo, checks clean worktree, fetches remote, switches to `GIT_PUSH_BRANCH` or current branch, pulls with rebase, checks clean again, records base commit.

After Codex:

- `commitGitTask()` reads changed paths, validates them, stages exact paths with `git add -- <paths>`, verifies staged paths with `git diff --cached --name-only`, commits with message `worker: <job.id> <summary>`, and reads HEAD SHA.
- `pushGitTask()` pushes `HEAD:<branch>` to `GIT_REMOTE_NAME` if `GIT_AUTO_PUSH` is true, retrying once after `git pull --rebase`.
- `rollbackGitTask()` can restore tracked changes to the recorded base commit on failure when enabled.

Codex itself must not run Git writes; the Worker owns those operations.

## Heartbeat

`local_worker.js` implements a heartbeat client:

- `sendHeartbeat(jobId)` posts to `/api/worker/heartbeat`.
- `startHeartbeat(jobId)` sends immediately and every 60 seconds.

Server route status:

- `/api/worker/heartbeat` was not found under `src/app/api`.

Risk:

- Current Worker will log heartbeat failures during every running job unless the endpoint exists outside this repository.
- Missing heartbeat server route makes Worker liveness unavailable to the server.

## Progress and report handling

Progress:

- `updateProgress()` posts `job_id`, `worker_name`, `progress_percent`, `current_step`, and `status_message` to `/api/worker/progress`.
- Non-OK progress reports log warnings but do not stop execution.

Final report:

- `report(jobId, status, payload, extra)` posts final success or failure to `/api/worker/report`.
- Success payload includes `result_text` and optional `git_commit_sha` and `deploy_status`.
- The server route currently ignores `result_text` and does not explicitly type `deploy_status`.

## Verification commands

From `infra/windows-worker/package.json`:

- `npm test`
- `npm run test:integration`
- `npm run verify`
- `npm run watchdog:dry-run`
- `npm run watchdog:apply`
- `npm run deploy:dry-run`
- `npm run deploy:apply`

## Not found

- Server heartbeat route: not found.
- Configurable heartbeat interval use in `local_worker.js`: README mentions `HEARTBEAT_INTERVAL_MS`, but code uses fixed 60 seconds.
- Worker-side PR creation: not found.
- Worker-side deployment trigger: not found.
- Atomic claim protection in Worker API: not found.
