# BATCH-15 Task Tree Design

## Task Tree Shape

The project director task tree includes:

- `project_goal`
- `task_tree_id`
- `execution_mode`
- `root_task`
- `child_tasks`
- `agent_role`
- `task_type`
- `dependency_keys`
- `acceptance_criteria`
- `allowed_files`
- `forbidden_files`
- `requires_boss_approval`

The legacy `stages -> task_groups -> tasks` shape is kept so existing dispatch code can continue to consume the tree.

## Dependency Rules

Product planning precedes design and implementation. UI and interaction work precede frontend work. Backend work is separated from database schema changes. Testing follows implementation. Operations and release tasks require boss approval.

Bug fixes and acceptance feedback start with a `project_director` diagnosis task. The diagnosis records the
smallest safe fix path and decides whether follow-up work belongs to frontend, backend, testing, or operations.

## Approval Rules

The task tree marks `requires_boss_approval = true` for tasks that touch release, production, env files, package files, database structure, SQL, Supabase, or explicitly non-automatic tasks.

## Execution Modes

- `planning_only`: the task tree may be stored and summarized, but concrete Agent execution tasks are not queued.
- `approved_execution`: concrete Agent jobs can be built from the latest task tree and written to `hermes_jobs.request_text`.

## File Scope Guard

Every child task carries `allowed_files` and `forbidden_files`. During BATCH-15 the frozen business pages stay in
`forbidden_files` unless a later human-approved task explicitly changes the freeze rule.
