# BATCH-15 Agent Dispatcher Notes

## Product Behavior

The boss can send a single Feishu demand. The project director replies with a concise plan:

- demand understanding
- Agent subtasks
- execution order
- items requiring boss approval
- items that can run automatically
- next reply options

## Supported Replies

- `批准执行`
- `修改计划：...`
- `暂停`

## Automatic vs Approval

Automatic execution is allowed only for low-risk planning, documentation, diagnosis, and static
verification tasks. Boss approval is required for production, deployment, env, database schema,
SQL, data deletion, package changes, or any task marked non-automatic by the project director.

## Non-Goals

BATCH-15 does not develop website pages, change database structure, deploy production, or modify env files.
