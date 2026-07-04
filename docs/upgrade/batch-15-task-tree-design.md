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

## Approval Rules

The task tree marks `requires_boss_approval = true` for tasks that touch release, production, env files, package files, database structure, SQL, Supabase, or explicitly non-automatic tasks.

