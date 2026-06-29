# Security and Reliability Risks

Audit date: 2026-06-29

## High Priority Risks

1. Non-atomic task claim

- Evidence: `/api/worker/next` selects one `hermes_jobs` row, then updates it.
- Impact: two Workers can claim the same task under concurrency.
- V2 need: atomic claim RPC or conditional update with status/lease predicate.

2. Missing heartbeat receiver

- Evidence: `local_worker.js` posts to `/api/worker/heartbeat`; no route exists in `src/app/api/worker`.
- Impact: Worker liveness is not stored. Stalled jobs cannot be detected reliably.
- V2 need: heartbeat route, `heartbeat_at`, stale detection, and recovery policy.

3. Status/schema drift

- Evidence: SQL setup allows `pending/running/awaiting_review/completed/failed`; runtime uses `queued/succeeded` and writes fields missing from audited SQL.
- Impact: jobs may fail to update, or missing-column fallback may silently skip important state.
- V2 need: one canonical schema migration.

4. Public or optionally unauthenticated Feishu routes

- Evidence: `/api/feishu/requirement` and `/api/feishu/codex-task` have no auth check; create/callback routes disable auth when `FEISHU_API_TOKEN` is missing.
- Impact: external callers could enqueue tasks or mutate Bitable if deployment is public and env auth is absent.
- V2 need: mandatory shared secret/signature verification.

5. Deployment status loop incomplete

- Evidence: GitHub workflow posts deployment status to `DEPLOY_CALLBACK_URL`; no receiver route found.
- Impact: pushed commits may deploy but job/Bitable status will not reflect real Vercel outcome.
- V2 need: authenticated deployment callback or remove workflow.

## Medium Priority Risks

6. Single-layer task model

- Evidence: `docs/setup-hermes-jobs.sql` documents one requirement equals one task. `hermes_queue` decomposition exists separately.
- Impact: V2 multi-role work cannot represent parent requirement, subtasks, dependencies, approvals, and per-role status cleanly.
- V2 need: parent-child job model or requirement/task tables.

7. Worker interruption handling is incomplete

- Evidence: Worker has hard/idle timeout and rollback, but server lease recovery is missing.
- Impact: a killed Worker can leave job `running`.
- V2 need: lease expiry scan and retry/requeue rules.

8. Feishu sync is best-effort inline work

- Evidence: `syncWorkerStatusToFeishu()` catches errors and logs them; GitHub Action Bitable callback is non-fatal.
- Impact: backend truth and Bitable view can diverge.
- V2 need: durable sync attempts with retry and last error.

9. Worker Git automation has high blast radius

- Evidence: Worker can fetch, switch, pull, commit, and push based on env settings.
- Impact: a bad task or prompt can still lead to committed changes after Codex exits successfully.
- V2 need: per-job allowed file scopes, branch policy, and human approval gates for sensitive paths.

10. Claim/report ownership not enforced

- Evidence: progress/report routes require job id but do not validate claim owner or lease token.
- Impact: one Worker or caller with token can update another Worker's job.
- V2 need: claim token or worker id ownership check.

## Lower Priority Risks

11. Inline LLM in Feishu event route

- Evidence: `POST /api/feishu/event` calls `runAgent()`.
- Impact: serverless timeout or slow Feishu response.
- V2 need: enqueue long-running work and immediately acknowledge Feishu.

12. Logs can include operational payload text

- Evidence: `requirement` route logs first 500 chars of raw payload; Worker logs task content.
- Impact: user data or task details can appear in logs.
- V2 need: structured logging with redaction and log-level controls.

13. Env names are spread across modules

- Evidence: Worker auth accepts three token env names; Bitable table env has several aliases.
- Impact: misconfiguration can disable auth or sync.
- V2 need: central config validation at startup.

14. RLS policies in setup docs are broad

- Evidence: `hermes_queue` setup allows anon read/insert/update.
- Impact: if anon access is exposed, queue data can be read or modified.
- V2 need: service-only writes and minimal read policies.

## Specific Required Risk Checklist

- Single-layer tasks: present.
- Duplicate claim: possible.
- Heartbeat: client exists, server route missing.
- State machine: inconsistent.
- Worker interruption: not fully recovered server-side.
- Feishu sync blocking: mostly non-blocking, but inline Feishu event route still does long work.
- Secret leakage: no env contents read in this audit; route/log redaction should still be strengthened.
- Production misoperation: Worker auto-push and Feishu create-table route are high-impact operations requiring stricter gates.
