# BATCH-13 Worker Preview Nonblocking Notes

## Goal

Prevent Windows Worker and Codex tasks from blocking on local Next.js preview startup.

## Behavior Change

Codex prompts now explicitly forbid blocking preview startup:

- `npm run dev`
- `next dev`
- `npx next dev`
- `Start-Process` for a dev server
- `cmd start /b npm run dev`

Page validation is static-only:

- Check required files and route files.
- Run ESLint.
- Run TypeScript with `npx tsc --noEmit`.
- Do not launch a browser.
- Do not start a local dev server.

## Failure Policy

Local preview recovery is diagnostic only. If static diagnostics fail or the recovery helper throws, Worker logs a warning and continues the task flow. The job should fail only for the actual Codex/task/Git failure path, not because local preview could not start.

## Windows PATH Fix

Worker child processes normalize environment variables before `execFile` or `spawn`. Only one case variant of the Windows path key is passed to child processes, avoiding `Path` / `PATH` dictionary collisions and `spawn EINVAL`.

## Cleanup Policy

Temporary cleanup distinguishes Git state:

- Tracked generated files: `git restore`.
- Untracked generated files: direct deletion or targeted `git clean -f -- <path>`.

Broad destructive cleanup is not part of this batch.

## Scope

No business pages were changed.
No database files were changed.
No `.env` files were changed.
No production deployment behavior was changed.
