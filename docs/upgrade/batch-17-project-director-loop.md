# BATCH-17 Project Director Loop

## Scope

BATCH-17 upgrades system orchestration only. It does not build city-partner business pages, login, profile, Supabase schema, deployment config, or environment variables.

## Flow

1. Feishu receives a boss demand.
2. The message is recognized as a project director demand.
3. The project director creates a task tree record in `hermes_messages`.
4. No executable Worker/Codex job is inserted into `hermes_jobs` before boss approval.
5. The boss receives a plan summary with:
   - original demand
   - director understanding
   - prepared execution tasks
   - execution order
   - risk notes
   - possible modified files/modules
   - approval requirement and current status
6. The boss can send `总管 批准执行` to dispatch approved tasks.
7. The boss can send `总管 暂停` to block dispatch.
8. After approval, Worker jobs include `boss_request_id`, `plan_id`, and an attempt contract in `request_text`.
9. `/api/worker/next` assigns `attempt_id` and returns the project-director correlation block.
10. `/api/worker/report` rejects mismatched `attempt_id` and stores a project-director-style completion report.

## Correlation Contract

Approved dispatches carry:

- `boss_request_id`
- `plan_id`
- `task_key`
- `attempt_id: assigned_on_worker_claim`

The actual `attempt_id` is still generated only when `/api/worker/next` claims a job. This preserves the BATCH-16 protection: heartbeat, progress, and report calls must echo the active attempt id.

## Local Static Validation

Simulated boss demand:

```text
新需求：执行系统升级阶段 BATCH-17：建立项目总管任务分发与老板验收闭环
```

Expected static result:

- `buildProjectDirectorTaskTreeDraft(demand)` returns `current_status = waiting_boss_approval`.
- The draft includes `boss_request_id`, `plan_id`, `original_demand`, `director_understanding`, `execution_tasks`, risk notes, and approval flags.
- `buildTaskTreeDraftSummary(draft)` tells the boss to send `总管 批准执行` or `总管 暂停`.
- Before approval, Feishu handling records the plan in `hermes_messages` only.
- After approval, dispatch request text includes the correlation header and attempt contract.

## Attempt Verification

Static check:

- `/api/worker/next` still calls `createWorkerAttemptId`.
- `/api/worker/next` still writes `attempt_id`, `active_attempt_id`, and `payload.active_attempt`.
- `/api/worker/report` still calls `assertWorkerAttemptMatchesJob` before updating terminal status.
- A report with a different `attempt_id` still returns HTTP 409.

## Status Command

`总管 状态` now attempts to show:

- paused state
- recent boss request
- recent plan id
- current running task
- latest completed task
- latest failed task and reason
- latest Worker heartbeat if available in payload

Query failures degrade to `none` or `query_failed`; they should not block the command.

## Report Format

Worker report results now include `project_director_report` with:

- what changed
- changed files
- validation result
- commit hash
- whether boss confirmation is needed
- next-step suggestion

No Supabase schema change is required for BATCH-17. The report is stored inside the existing `result` payload and returned from the API response.
