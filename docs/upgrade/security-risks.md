# Security and reliability risks

## High

1. Duplicate Worker claim risk

- Evidence: `src/app/api/worker/next/route.ts` selects a pending job and then updates it in a separate statement.
- Impact: two Workers can read the same job before either update completes.
- Upgrade need: atomic claim via SQL RPC or conditional update with status guard.

2. Worker heartbeat endpoint missing

- Evidence: `infra/windows-worker/local_worker.js` posts to `/api/worker/heartbeat`; no matching route was found under `src/app/api`.
- Impact: liveness is not stored, heartbeat failures are only logged, and stalled jobs cannot be judged reliably.
- Upgrade need: implement heartbeat route and DB fields before relying on heartbeat decisions.

3. `hermes_jobs` status mismatch

- Evidence: SQL allows `pending`, `running`, `awaiting_review`, `completed`, `failed`; Worker code reads `queued` and reports `succeeded`.
- Impact: live writes can fail check constraints or create inconsistent status semantics if live DB differs from repository SQL.
- Upgrade need: define one canonical state machine and migrate SQL/API/Worker together.

4. Public or optionally unauthenticated Feishu mutation routes

- Evidence: `/api/feishu/requirement` and `/api/feishu/codex-task` have no explicit bearer auth; `/api/feishu/decompose-callback` and `/api/feishu/create-tables` disable auth when `FEISHU_API_TOKEN` is missing.
- Impact: unwanted queue inserts or Bitable table mutations if endpoints are exposed without env configured.
- Upgrade need: make auth mandatory for mutation endpoints.

5. Production environment operation risk in Worker Git flow

- Evidence: `local_worker.js` can fetch, switch, pull, commit, and push based on env configuration.
- Impact: wrong `PROJECT_DIR`, `GIT_PUSH_BRANCH`, or `GIT_AUTO_PUSH` can write to unintended branch or repository.
- Upgrade need: hard allowlist repo path, branch, remote, and task file scope.

## Medium

1. Single-layer task model

- Evidence: `docs/setup-hermes-jobs.sql` says one requirement equals one task; `hermes_queue` decomposition exists separately and is not integrated with `hermes_jobs`.
- Impact: multi-step upgrade work is hard to schedule, retry, or report independently.
- Upgrade need: parent-child job model or explicit phase/task tables.

2. Worker interruption risk

- Evidence: `expires_at` and `attempts` fields exist in SQL, but no requeue route or scheduled recovery was found.
- Impact: interrupted Worker can leave jobs stuck in `running`.
- Upgrade need: reaper job that requeues expired running jobs with attempt limits.

3. State machine incomplete

- Evidence: statuses differ across SQL, API, Worker, and Feishu sync: `pending`, `queued`, `running`, `succeeded`, `completed`, `awaiting_review`, `failed`.
- Impact: dashboards, Bitable sync, retry rules, and reports can disagree.
- Upgrade need: central transition table and typed constants shared across code.

4. Feishu sync latency can delay Worker API responses

- Evidence: Worker routes `await syncWorkerStatusToFeishu(...)`; the sync catches failures but still performs network calls inline.
- Impact: Feishu API slowness can slow claim/progress/report responses.
- Upgrade need: enqueue sync events or call sync asynchronously with timeout.

5. Deployment status callback receiver missing

- Evidence: `.github/workflows/sync-vercel-deployment.yml` posts to `DEPLOY_CALLBACK_URL` with `X-Deploy-Secret`; no receiving route found.
- Impact: Vercel deployment status may not be written back to jobs.
- Upgrade need: add authenticated callback route or remove unused workflow.

6. Schema drift hidden by skipped missing columns

- Evidence: `updateHermesJob()` removes missing columns and retries.
- Impact: deployment may appear successful while progress, commit, or error fields are not stored.
- Upgrade need: fail loudly for required columns after schema migration is complete.

## Low

1. Encoding and syntax health risk

- Evidence: multiple inspected files show mojibake in comments and string literals in this environment; some captured strings appear unterminated.
- Impact: build or runtime failures may occur if source files are actually malformed.
- Upgrade need: run `node --check` or TypeScript build after a controlled code-health phase.

2. README drift

- Evidence: Worker README mentions `HEARTBEAT_INTERVAL_MS`, but `local_worker.js` uses a fixed 60-second interval.
- Impact: operators may believe heartbeat interval is configurable when it is not.
- Upgrade need: align code and docs.

3. Secret exposure via logs is partly mitigated but uneven

- Evidence: `feishu-worker-sync.ts` sanitizes Feishu sync errors; other routes may return raw Supabase or Feishu error text.
- Impact: accidental diagnostic leaks are possible if upstream errors include sensitive context.
- Upgrade need: central error sanitizer for external API failures.

## Required risk labels from task

- Single-layer task limit: present.
- Duplicate claim risk: present.
- Worker interruption risk: present.
- Heartbeat missing or false heartbeat risk: present.
- Incomplete state machine: present.
- Feishu sync blocking main flow: present.
- Secret leakage risk: present as logging/error-surface risk; no real env values were read or output in this audit.
- Production misoperation risk: present in Worker Git push/deploy scripts if env is wrong.
