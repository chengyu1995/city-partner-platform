# Security and Reliability Risks

This file lists current risks found in Phase 0. It does not include secret values.

## Critical

1. Non-atomic Worker claim

- Evidence: `/api/worker/next` selects one job and then updates it in a separate call.
- Impact: multiple Workers can claim the same job.
- V2 need: atomic claim RPC or conditional update with status/lease predicate.

2. Missing heartbeat receiver

- Evidence: `local_worker.js` posts to `/api/worker/heartbeat`; no route exists in `src/app/api/worker`.
- Impact: system cannot reliably distinguish long-running work from a dead Worker.
- V2 need: heartbeat route, `heartbeat_at`, stale detection, and recovery policy.

3. Route auth can become disabled by missing env

- Evidence: `assertWorkerAuthorized` returns null when no Worker token env is configured. Feishu decompose/table routes also disable auth when `FEISHU_API_TOKEN` is missing.
- Impact: external callers could claim/report jobs or mutate Bitable if routes are public and env auth is absent.
- V2 need: fail closed for production write routes.

## High

4. Schema drift between SQL and runtime

- Evidence: runtime uses `queued`, `succeeded`, `progress_percent`, `current_step`, `status_message`, `git_commit_sha`, `error_text`, `completed_at`, and `request_text`; audited SQL does not define all of them.
- Impact: updates silently skip missing columns or fail depending on path.
- V2 need: migration-first schema alignment.

5. Deployment status loop incomplete

- Evidence: GitHub workflow posts deployment status to `DEPLOY_CALLBACK_URL`; no receiver route found.
- Impact: Vercel deployment state is not durably linked to jobs.
- V2 need: authenticated deployment callback or remove workflow.

6. Stale running jobs are not recovered

- Evidence: `expires_at` is set, and an index exists, but no recovery code was found.
- Impact: interrupted Worker can leave job stuck in `running`.
- V2 need: lease expiry requeue with attempt limits.

7. Feishu sync is best-effort only

- Evidence: `syncWorkerStatusToFeishu` catches and logs errors without durable retry.
- Impact: database and Feishu board can diverge.
- V2 need: sync outbox with retries and observability.

## Medium

8. Worker ownership is not enforced on progress/report

- Evidence: progress/report update by job ID only; no `claimed_by` check.
- Impact: any authorized Worker token holder can report any job.
- V2 need: include claim token or attempt ID.

9. Queue split creates inconsistent source of truth

- Evidence: `hermes_queue/task_results` and `hermes_jobs` are separate flows.
- Impact: decomposition and execution may drift or duplicate.
- V2 need: parent-child task model.

10. Feishu event route does inline processing

- Evidence: event route runs agent and sends reply in the request.
- Impact: timeout/retry/idempotency pressure.
- V2 need: accept fast, process async.

11. Public read policies on conversation tables

- Evidence: setup SQL creates read policies using `true`.
- Impact: conversation messages may be readable through anon contexts.
- V2 need: private-by-default RLS.

12. Untracked rollback gap

- Evidence: Worker rollback restores tracked files to checkpoint, but untracked files are not removed.
- Impact: failed tasks can leave untracked files behind.
- V2 need: explicit cleanup or quarantine list for task-created untracked files.

## Lower

13. Worker identity mismatch

- Evidence: Worker sends `worker_name` query param; server reads `worker_id` or `x-worker-id`.
- Impact: claimed jobs may show `unknown-worker`.
- V2 need: standardize identity field.

14. Heartbeat interval documentation mismatch

- Evidence: README mentions `HEARTBEAT_INTERVAL_MS`; code uses fixed 60 seconds.
- Impact: operator confusion.
- V2 need: implement env or fix docs.

15. Bitable table-creation route remains available

- Evidence: route exists in app and can create tables.
- Impact: accidental Bitable infrastructure changes.
- V2 need: remove from production or require strong admin-only auth.

## Key Leakage Controls Already Present

- Worker prompt guard forbids Codex from Git operations.
- Worker commit validation blocks sensitive paths and scans sensitive content patterns.
- Worker deployment script refuses source `.env` and redacts command output.
- Feishu sync error sanitizer redacts token-like strings and app token URL fragments.

## Phase 1 Gate

Do not start Phase 1 until these are resolved or explicitly accepted:

- Atomic claim.
- Heartbeat route.
- Fail-closed route auth.
- Schema/status alignment.
- Stale job recovery.
- Feishu sync outbox plan.
