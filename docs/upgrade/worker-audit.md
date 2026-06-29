# Worker Audit

Audit scope: `infra/windows-worker` implementation and related docs/scripts.

## Runtime Entry

Main file: `infra/windows-worker/local_worker.js`

Startup options:

- Manual: `node local_worker.js`
- Scheduled task wrapper: `infra/windows-worker/start-worker.ps1`
- Production directory described in docs: `C:\city-partner-worker`
- Scheduled task name: `CityPartnerCodexWorker`

Deployment helper:

- `infra/windows-worker/deploy-worker.ps1`
- Default mode is dry-run.
- `-Apply` copies allowed Worker files to `C:\city-partner-worker`, backs up files, verifies syntax/tests, restarts scheduled task unless `-SkipRestart`.
- It refuses source `.env` and avoids printing production env contents.

Watchdog:

- `infra/windows-worker/worker-watchdog.ps1`
- Checks scheduled task, Worker file, env file presence, node process, and log tail.
- Default mode is dry-run.

## Required Runtime ENV Names

`local_worker.js` requires:

- `WORKER_API_URL`
- `WORKER_TOKEN`
- `PROJECT_DIR`

Other supported names:

- `WORKER_NAME`
- `POLL_INTERVAL_MS`
- `CODEX_TIMEOUT_MS`
- `CODEX_IDLE_TIMEOUT_MS`
- `CODEX_EXE`
- `GIT_AUTO_COMMIT`
- `GIT_ROLLBACK_ON_FAILURE`
- `GIT_AUTO_PUSH`
- `GIT_REMOTE_NAME`
- `GIT_PUSH_BRANCH`

No real values were read or printed.

## Polling Logic

Flow in `pollOnce()`:

1. Skip if already `working` or stopping.
2. Request `GET /api/worker/next?worker_name=<WORKER_NAME>`.
3. If no job, return.
4. Mark `working = true`.
5. Report 5 percent progress.
6. Start heartbeat.
7. Prepare Git task.
8. Run Codex.
9. Commit changes if configured.
10. Push changes if configured.
11. Report final result.
12. Stop heartbeat and clear `working`.

Poll interval:

- `POLL_INTERVAL_MS`, default `5000`.

## Codex CLI Invocation

Source: `runCodex(prompt, job)`.

Executable:

- `CODEX_EXE`, default `C:/Users/admin/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe`

Arguments:

```text
exec
-C
<PROJECT_DIR>
--sandbox
workspace-write
--skip-git-repo-check
<guarded prompt>
```

Environment additions:

- `CI=1`
- `NO_COLOR=1`

Timeouts:

- Hard timeout: `CODEX_TIMEOUT_MS`, default `900000`.
- Idle timeout: `CODEX_IDLE_TIMEOUT_MS`, default `60000`.
- Kills process tree with `taskkill /T /F` on timeout.

Prompt guard:

- Prepends and appends Windows Worker rules forbidding Codex from running Git add/commit/push, creating branches, changing Git config, GitHub writes, or cloning to submit.
- Original task text is included between guard blocks.

## Git Handling

The outer Worker, not Codex, owns Git operations.

Before Codex:

- Verifies inside Git worktree.
- Requires clean worktree.
- Fetches remote with prune.
- Switches to target branch.
- Pulls with rebase.
- Records base commit.

After Codex:

- Reads changed paths from `git status --porcelain=v1 -z`.
- Validates paths.
- Stages only task-changed paths via explicit `git add -- <paths>`.
- Validates staged paths with `git diff --cached --name-only`.
- Scans for sensitive paths/content.
- Commits with message `worker: <job.id> <summary>`.
- Optionally pushes `HEAD:<branch>`.
- On failure, optionally restores tracked changes to checkpoint.

Safety helper:

- `infra/windows-worker/git-safety.js`

Risks:

- `git switch` and `git pull --rebase` are performed by Worker automatically. This is intentional for Worker but must remain outside Codex.
- Commit message is generated from `job.request_text`, so it should be sanitized/limited. Current code truncates and normalizes whitespace.
- Untracked files are not restored by rollback because rollback restores tracked paths only.

## Heartbeat

Worker implements two liveness mechanisms:

- `sendHeartbeat(jobId)` posts to `/api/worker/heartbeat`.
- `startHeartbeat(jobId)` sends immediately and every 60 seconds.
- `startCodexHeartbeat(job)` sends progress updates every 30 seconds while Codex runs.

Gaps:

- No `/api/worker/heartbeat` route exists in the audited repository.
- README mentions `HEARTBEAT_INTERVAL_MS`, but code uses a fixed 60 seconds for heartbeat.
- Heartbeat failures are logged and do not stop Codex.

## Result Reporting

Success report sends:

- `job_id`
- `status = succeeded`
- `result_text`
- `git_commit_sha`
- `deploy_status = pending` when push occurred

Failure report sends:

- `job_id`
- `status = failed`
- `error_text`

Mismatch:

- `/api/worker/report` does not explicitly consume `result_text` or `deploy_status`.

## V2 Worker Requirements

1. Align Worker query parameter with API claim identity (`worker_id` or header).
2. Add heartbeat route and configurable heartbeat interval.
3. Add attempt IDs; report progress and final result against attempt, not only job.
4. Make rollback behavior explicit for untracked files.
5. Store Codex stdout/stderr artifacts outside primary DB row or truncate consistently.
6. Make deployment status a separate state after push.
7. Keep Codex Git prohibition guard.
