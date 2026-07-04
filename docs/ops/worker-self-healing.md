# Worker Self-Healing

Windows Worker self-healing entry points:

- `infra/windows-worker/worker-recovery.js`
- `infra/windows-worker/worker-healthcheck.ps1`
- `infra/windows-worker/start-worker.ps1`

## Preflight

`start-worker.ps1` runs the health check before starting the scheduled worker:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/windows-worker/worker-healthcheck.ps1 -StopExistingWorker
```

Preflight actions:

- Stop residual Worker, `next dev`, `next-server`, Turbopack, `npm run dev`, and Codex processes.
- Clean `.next`, `.turbo`, and `node_modules/.cache`.
- Restore generated Next type files.
- Check `git status --short`.
- Clean known generated changes only.
- Stop when unknown business changes exist.

## Codex Retry

`local_worker.js` runs Codex in three attempts:

1. Execute the original task.
2. On first failure, retry with a local error summary and automatic category.
3. On second failure, retry with a minimum-change repair prompt.

If all attempts fail, Worker reports the failure and asks for a human decision instead of looping forever.

## Local Preview Policy

Codex must not start local preview servers during Worker tasks.

Forbidden commands and flows:

- `npm run dev`
- `next dev`
- `npx next dev`
- `Start-Process` for a dev server
- `cmd start /b npm run dev`
- Browser-based preview verification

`worker-recovery.js recover-preview` is now static-only. It does not start `next dev`, does not open a browser, and does not wait for HTTP readiness.

Static diagnostics:

- Confirm route files exist for `/`, `/post`, and `/partners`.
- Run `npm run lint`.
- Run `npx tsc --noEmit`.
- Write `infra/windows-worker/logs/local-preview-recovery-report.json`.

When static preview diagnostics fail, Worker records a warning and continues to commit/report flow. Local preview recovery failure must not mark the whole job as failed.

The `recover-preview` CLI follows the same policy: failed static diagnostics are reported as warning output with exit code `0`. The command is a diagnostic artifact producer, not a job gate.

## Windows PATH Handling

All Worker child processes normalize environment variables before spawn/exec. On Windows, `Path` and `PATH` are the same key for process creation, so Worker emits only one canonical `Path` entry to avoid:

```text
spawn EINVAL
Item has already been added. Key in dictionary: 'Path' Key being added: 'PATH'
```

## Temporary File Cleanup

Worker cleanup distinguishes Git status classes:

- Tracked files are restored with `git restore`.
- Untracked generated or temporary files are removed directly or with targeted `git clean -f -- <path>`.

Worker must not use broad destructive cleanup such as `git reset --hard` or unrestricted `git clean`.

## Error Categories

Worker classifies local errors into:

- `turbopack-cache`
- `port-conflict`
- `runtime-500`
- `route-404`
- `code-syntax`
- `dependency-or-import`
- `windows-env-path-conflict`
- `unknown`

The category is used only for repair prompts and summaries. Worker must not print secrets or full sensitive logs.
