# Agent Dispatch Architecture

## Flow

1. Feishu receives a boss request.
2. Project director classifies the request.
3. Ordinary website requests enter `planning_only`; they do not go directly to Codex.
4. The task tree generator records a planning tree in `hermes_messages`.
5. The boss reviews or modifies the plan.
6. The boss replies `总管 批准执行`.
7. The dispatch plan creates concrete Agent execution jobs.
8. Workers keep using `request_text` as the source of truth.

## Sources

- `project_director`: planning and project director records.
- `agent_dispatch`: concrete Agent execution tasks.
- `feishu_feedback`: feedback and acceptance routes when available.

## Queue Strategy

- Planning stage writes one project director planning job only.
- Approved execution writes one job per concrete Agent task.
- The worker reads `request_text` as the canonical task prompt.
- `source`, `workflow_stage`, and `plan_status` use existing compatible strings.
- Missing optional columns are removed from the insert payload and retried.

## Backward Compatibility

No database migration is required. The job builder first writes rich rows, then removes missing optional columns reported by Supabase and retries.

## Boss-Facing Reply

The boss sees only the demand understanding, Agent subtasks, execution order, approval items, automatic items, and next reply options. Internal logs, SQL, shell commands, stack traces, and secrets are not included.

## Worker Guard

The Windows Worker wraps Agent tasks with a guard that forbids Codex from committing, pushing,
starting a dev server, opening a browser, or modifying files outside the task scope. Local preview
smoke is disabled by default for system-upgrade jobs; static validation remains the accepted path.

## BATCH-19 Production Mode

BATCH-19 marks the upgrade complete. The dispatcher can be used for real 同城搭子网站 product
planning, but execution remains approval-gated:

- `新需求：状态`, `新需求：查看计划`, `新需求：帮助`, `新需求：系统自检`, and `新需求：Agent 状态/看板` are boss-facing control commands.
- `新需求：我要做一个 xxx 功能` enters planning first.
- `总管 批准执行` is required before Worker/Codex tasks are created.
- `总管 暂停` blocks new dispatch.
- `验收反馈：xxx` is routed back to the project director for diagnosis and follow-up.

## BATCH-20 Console Priority

Boss console commands are parsed in `src/app/api/feishu/event/route.ts` before demand
classification and before duplicate Worker job checks. The only exception is `总管 批准执行`,
which is normalized to the existing approval phrase and continues through the guarded approval
path:

- paused dispatch blocks approval.
- missing task tree blocks approval.
- previously dispatched task trees are not duplicated.
- dispatched Worker prompts include the attempt contract.
