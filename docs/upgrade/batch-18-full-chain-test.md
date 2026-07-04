# BATCH-18 Full Chain Test

## Test Goal

BATCH-18 is a system acceptance test for the Project Director and multi-agent loop. It does not develop website business pages.

The goal is to verify that a boss request from Feishu goes through:

1. Project Director intake.
2. Task tree and plan generation.
3. Boss approval gate.
4. Worker dispatch only after approval.
5. Worker claim with `worker_id`, `worker_name`, and `attempt_id`.
6. Worker report guarded by `attempt_id`.
7. Project Director style acceptance report.
8. Status, pause, and resume control.

## Test Scope

In scope:

- Feishu Project Director command recognition.
- Planning-only behavior before approval.
- Approved Worker queue creation after `总管 批准执行`.
- Pause and resume guardrails.
- Worker claim ownership and attempt contract.
- Worker progress, heartbeat, and report idempotency.
- Acceptance feedback freeze behavior.
- Static validation that frozen business pages are unchanged.

Out of scope:

- Website homepage, `/post`, `/partners`, login, register, or profile development.
- Database schema changes.
- Production deploy.
- Environment variable changes.
- Browser or dev-server testing.

## Local Static Simulation

Run:

```bash
node scripts/batch-18-full-chain-static-check.js
```

This script reads local files only. It does not start Next.js, open a browser, call Feishu, write Supabase data, create commits, or push.

## Feishu Command Checklist

| Message | Expected behavior | Worker queue |
| --- | --- | --- |
| `新需求：状态` | Project Director should reply with status or normal console routing when command form is used. | No executable Worker task. |
| `新需求：查看计划` | Should be treated as planning/clarification, not Codex execution. | No executable Worker task. |
| `新需求：帮助` | Help/status style reply only when recognized as command intent. | No executable Worker task. |
| `新需求：暂停` | Should record pause state. | No executable Worker task. |
| `新需求：恢复` | Should record resume state. | No executable Worker task. |
| `新需求：做一个假的测试需求，不要改任何业务页面，只验证总管拆解流程` | Generate planning/task tree only. | No executable Worker task before approval. |
| `总管 批准执行` | Dispatch approved agent jobs only when a recent plan exists and dispatch is not paused. | Yes, after approval only. |
| `验收反馈：这是 BATCH-18 假反馈，不要修改业务页面` | Record or queue diagnosis under upgrade freeze; business pages stay frozen. | No direct business-page execution. |

## Project Director Planning Test

Expected planning properties:

- The original boss demand is recorded.
- The plan contains `boss_request_id` and `plan_id`.
- Planning state is `waiting_execution_approval`.
- A note equivalent to `planning_job: not_inserted_before_boss_approval` exists.
- The plan lists allowed and forbidden files.
- Frozen business pages remain forbidden.

## Boss Approval Test

Before approval:

- The system stores the task tree in `hermes_messages`.
- It must not insert executable `agent_dispatch` rows into `hermes_jobs`.

After `总管 批准执行`:

- The route checks pause state first.
- It loads the latest task tree draft.
- It builds approved dispatch jobs.
- It attaches `boss_request_id`, `plan_id`, `task_key`, and attempt contract metadata.
- It inserts Worker-compatible queued jobs only once.

## Pause And Resume Test

Expected behavior:

- `总管 暂停` records `agent_dispatch_paused: true`.
- While paused, `总管 批准执行` returns blocked state and does not insert jobs.
- `总管 恢复` records `agent_dispatch_paused: false`.
- Approved dispatch may continue only after resume.

## Worker Claim Test

`/api/worker/next` must:

- Select only `queued` or `pending` jobs.
- Claim the job for the requesting Worker.
- Return `attempt_id`.
- Return Project Director correlation data when available.
- Tell the Worker to echo `attempt_id` in heartbeat, progress, and report.

## Attempt Guard Test

Expected behavior:

- Missing `attempt_id` on an active attempted job is rejected.
- Mismatched `attempt_id` is rejected.
- Wrong `worker_id` is rejected.
- Matching owner and matching `attempt_id` may update progress/report.

## Report Idempotency Test

Expected behavior:

- A terminal `succeeded` report cannot be overwritten by a later `failed` report.
- A terminal `failed` report cannot be overwritten by a later `succeeded` report.
- Duplicate terminal reports are returned as idempotent skipped updates.
- `running_job_not_found_or_not_owned` style failures must not create a second execution attempt; claims are constrained by queued/pending state and ownership.

## Acceptance Feedback Freeze Test

Until the system upgrade is complete:

- Acceptance feedback can be recorded or queued for diagnosis.
- It must not modify frozen business pages.
- It must not bypass the Project Director approval flow.

Frozen pages:

- `app/page.tsx`
- `app/post/page.tsx`
- `app/partners/page.tsx`
- `src/app/page.tsx`
- `src/app/post/page.tsx`
- `src/app/partners/page.tsx`

## Failure Scenarios

- No recent plan exists when approving execution: return blocked state.
- Dispatch is paused when approving execution: return paused blocked state.
- Duplicate approved dispatch: skip duplicate job creation.
- Worker reports missing `attempt_id`: reject.
- Worker reports mismatched `attempt_id`: reject.
- Worker reports after terminal status: idempotent skip.
- Static validation cannot run: record warning, do not start dev server.

## Pass Standard

BATCH-18 passes when:

- The three BATCH-18 docs exist.
- The static script passes.
- `npx tsc --noEmit` passes or any failure is reported.
- ESLint passes for modified TS files or any failure is reported.
- No forbidden business page is modified.
- No database, `.env`, production deploy, or dependency changes are made.
