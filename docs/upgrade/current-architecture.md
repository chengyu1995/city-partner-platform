# Current Architecture Audit

Audit date: 2026-06-29
Repository: `C:\city-partner`
Scope: Phase 0 audit only. No business code, database migration, Feishu configuration, deployment, Git staging, Git commit, or Git push was performed.

## Preflight

- `git status --short`: clean.
- `git branch --show-current`: `master`.
- `git rev-parse HEAD`: `1209360ea7396cd729fd66cf94e4ed8f7bd67646`.
- Git safe-directory warning was bypassed with a one-shot `git -c safe.directory=C:/city-partner ...`; no Git configuration was changed.
- No `.env` file contents or real environment variable values were read or printed.

## Audited Flow

Current automation is a single-layer task execution prototype:

1. Feishu sends either event callbacks or Bitable automation HTTP calls.
2. Vercel Next.js API routes receive the calls.
3. Some routes write to Supabase `hermes_queue`; Feishu event chat flow can also interact with Hermes conversation tables and `hermes_jobs`.
4. Windows Worker polls Vercel `GET /api/worker/next`.
5. `/api/worker/next` reads one queued/pending row from Supabase `hermes_jobs`, marks it `running`, and returns it.
6. Windows Worker runs Codex CLI in `PROJECT_DIR`.
7. Outer Worker performs Git synchronization, optional commit, optional push, and rollback on failure.
8. Worker reports progress to `POST /api/worker/progress` and final result to `POST /api/worker/report`.
9. Worker status updates attempt non-blocking Feishu Bitable sync.
10. GitHub deployment status workflow posts deployment status to a configured callback URL, but no matching receiver route was found in this repository.

## Main Entry Points

- Feishu event receiver: `src/app/api/feishu/event/route.ts`
- Feishu Bitable requirement queue: `src/app/api/feishu/requirement/route.ts`
- Feishu Bitable Codex-task queue: `src/app/api/feishu/codex-task/route.ts`
- Feishu decompose callback: `src/app/api/feishu/decompose-callback/route.ts`
- Feishu table creator: `src/app/api/feishu/create-tables/route.ts`
- Worker claim: `src/app/api/worker/next/route.ts`
- Worker progress: `src/app/api/worker/progress/route.ts`
- Worker report: `src/app/api/worker/report/route.ts`
- Worker shared helpers: `src/lib/worker-jobs.ts`
- Feishu Worker status sync: `src/lib/feishu-worker-sync.ts`
- Windows Worker: `infra/windows-worker/local_worker.js`
- Worker deployment scripts: `infra/windows-worker/*.ps1`
- Legacy/architecture docs: `docs/WORKER_ARCHITECTURE.md`, `docs/feishu-automation.md`
- Deployment status workflow: `.github/workflows/sync-vercel-deployment.yml`

## Observed Gaps

- `/api/worker/heartbeat` is called by `local_worker.js`, but no route exists under `src/app/api/worker`.
- `expires_at` is written on claim, but no audited route or scheduled process requeues expired running jobs.
- Claim is not atomic: `/api/worker/next` selects a row and then updates by `id`, so concurrent Workers can race.
- Worker sends `result_text` and `deploy_status`, but `/api/worker/report` mainly stores `output`, `pr_url`, `files_changed`, `build_passed`, `test_passed`, `duration_ms`, and `git_commit_sha`.
- Deployment callback receiver is missing for `.github/workflows/sync-vercel-deployment.yml`.
- SQL setup for `hermes_jobs` is older than runtime expectations: runtime uses columns such as `progress_percent`, `current_step`, `status_message`, `git_commit_sha`, `error_text`, `completed_at`, and `request_text`, while audited SQL does not define all of them.
- Feishu sync is best-effort and non-blocking. Failures are logged but not persisted as retryable sync jobs.

## V2 Direction

Hermes V2 should first normalize one durable state machine before feature work:

- Requirement -> parent task -> subtask -> execution attempt.
- Atomic claim with lease and heartbeat.
- Explicit retry/requeue policy.
- Separate Feishu sync outbox.
- Separate Git commit/push/deployment state.
- Clear human approval gates before production operations.
