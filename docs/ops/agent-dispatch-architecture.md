# Agent Dispatch Architecture

## Flow

1. Feishu receives a boss request.
2. Project director classifies the request.
3. The task tree generator creates a planning tree.
4. A single planning job is queued in `hermes_jobs`.
5. The boss replies `批准执行`.
6. The dispatch plan creates concrete Agent execution jobs.
7. Workers keep using `request_text` as the source of truth.

## Sources

- `project_director`: planning and project director records.
- `agent_dispatch`: concrete Agent execution tasks.
- `feishu_feedback`: feedback and acceptance routes when available.

## Backward Compatibility

No database migration is required. The job builder first writes rich rows, then removes missing optional columns reported by Supabase and retries.

## Boss-Facing Reply

The boss sees only the demand understanding, Agent subtasks, execution order, approval items, automatic items, and next reply options. Internal logs, SQL, shell commands, stack traces, and secrets are not included.

