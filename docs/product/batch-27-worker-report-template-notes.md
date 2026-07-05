# BATCH-27 Worker Report Template Notes

## Scope

This batch upgrades the Worker final report path only. It does not change business pages, UI code, database schema, env files, deployment config, or production deployment behavior.

## Problem

Before BATCH-27, a terminal Worker task could sync only short status text to Feishu. That made it hard for the project director and boss to know what finished, what changed, how it was validated, and which commit was generated.

## Implementation

- `local_worker.js` now sends structured final-report fields for succeeded and failed tasks:
  - `project_name`
  - `project_dir`
  - `files_changed`
  - `validation_results`
  - `github_push_status`
  - `git_commit_sha`
- `/api/worker/report` builds one BATCH-27 project director report for terminal statuses and sends that full text to Feishu.
- `worker-jobs.ts` owns the final report template, placeholder behavior, safety-boundary summary, truncation, and secret redaction.

## Success Report Behavior

Succeeded tasks report:

- ✅ status header
- job id and attempt id
- original demand
- project name and directory
- result summary
- changed files
- completion items
- validation results
- safety boundary
- commit SHA
- GitHub push status
- next-step recommendation

## Failure Report Behavior

Failed tasks use the same report structure and include:

- ❌ status header
- job id and attempt id
- original demand
- changed files captured before rollback when available
- failure reason in validation/results
- commit SHA as `未生成` when no commit exists
- GitHub push status as failed/not pushed
- next-step recommendation requiring owner decision

## Safety

- No homepage, `/partners`, or `/post` code changed.
- No database schema changed.
- No `.env` file changed.
- No deployment was triggered.
- No dev server or browser preview is required by this batch.
- Report text redacts common token, app secret, service key, and bearer-token patterns.
- Existing attempt ownership and terminal idempotency checks remain in `/api/worker/report`.

## Tencent Cloud Sync

If a Tencent Cloud `worker_api.js` mirrors this Worker API, sync the same terminal report contract there:

1. Accept and preserve `files_changed`, `validation_results`, `git_commit_sha`, and `github_push_status`.
2. Generate the same succeeded/failed final report before writing Feishu.
3. Keep attempt_id ownership checks and terminal idempotency protection.
4. Redact secrets before logging or writing report text.

Validation on Tencent Cloud should use one succeeded payload, one failed payload, one duplicate terminal report, and one wrong-attempt report.

## Validation

Required local validation for this batch:

- `node --check infra/windows-worker/local_worker.js`
- `npx tsc --noEmit`
- Static check that succeeded and failed terminal reports call the BATCH-27 final report builder.
- Static check that report text contains job id, demand, changed files, validation result, and commit SHA.
- `git diff --name-only`
- `git status --short`
