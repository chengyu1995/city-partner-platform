# BATCH-16 Boss Console and Attempt Contract

## Scope

BATCH-16 lets the boss control the project director and multi Agent dispatcher from Feishu, while upgrading Worker status reporting from job-only to attempt-aware.

This batch does not change business pages, production env, Supabase schema, package files, or deployment behavior.

## Feishu Boss Console Commands

The Feishu event route recognizes these boss-facing commands before normal demand intake:

- `总管 帮助`: show available commands.
- `总管 状态`: show project director and Agent queue counts grouped by status.
- `总管 暂停`: pause creation of new Agent dispatch jobs.
- `总管 恢复`: resume creation of new Agent dispatch jobs.
- `总管 批准执行`: delegate to the existing approved-execution flow.

Accepted prefixes:

- `总管`
- `项目总管`
- `老板控制台`
- `/pd`
- `/director`

Pause is intentionally non-destructive. It blocks new Agent dispatch creation but does not kill a running Worker attempt.

## Attempt ID Contract

`GET|POST /api/worker/next` now creates one durable `attempt_id` when a Worker claims a job.

The attempt is stored through backward-compatible fields:

- `attempt_id`
- `active_attempt_id`
- `payload.attempt_id`
- `payload.active_attempt`

If a column does not exist in `hermes_jobs`, the existing missing-column fallback removes that column and retries. The `payload` copy keeps the attempt identity durable for current schema versions.

## Worker Payload Schema

Worker heartbeat, progress, and report payloads accept:

- `attempt_id`
- `job_id`
- `worker_id`
- `worker_name`
- `status`
- `progress_percent`
- `current_step`
- `status_message`
- `result_text`
- `error_text`
- `git_commit_sha`
- `deploy_status`

The Windows Worker reads `attempt_id` from the claim response and includes it in all follow-up heartbeat, progress, and report calls.

## Safety Rules

- Reports from a different Worker are rejected by the existing `claimed_by` ownership check.
- Reports with a mismatched `attempt_id` are rejected with HTTP 409.
- Duplicate terminal reports for the same job and active attempt are idempotent.
- Legacy callers without `attempt_id` remain compatible if no active attempt is recorded.
- Feishu sync remains best-effort and non-blocking.

## Static Verification

Allowed static checks for this batch:

- `npx tsc --noEmit`
- `npm run lint`
- Route-file existence checks for:
  - `src/app/api/feishu/event/route.ts`
  - `src/app/api/worker/next/route.ts`
  - `src/app/api/worker/heartbeat/route.ts`
  - `src/app/api/worker/progress/route.ts`
  - `src/app/api/worker/report/route.ts`

Do not start a dev server or browser for this batch.
