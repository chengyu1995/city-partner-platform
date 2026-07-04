# BATCH-15 Agent Dispatcher

## Scope

BATCH-15 upgrades the project director into a multi Agent dispatcher. It is a system upgrade only. Business page development remains frozen.

## Roles

- project_director: classifies boss requests, builds task trees, controls approvals, and summarizes results.
- product_manager: writes product scope, page lists, user flows, and acceptance criteria.
- ui_designer: defines visual direction and component states.
- interaction_designer: defines user paths, states, and edge cases.
- frontend_developer: implements approved frontend changes.
- backend_developer: implements approved API and data access changes.
- testing_engineer: verifies static checks, acceptance paths, and regressions.
- operations_engineer: handles preview, worker, release, and production risk checks.

Each role is defined in `src/lib/project-director-agents.ts` with `role`, `display_name`,
`responsibility`, `allowed_task_types`, `allowed_file_scopes`, `forbidden_actions`, and
`output_format`.

## Request Types

The dispatcher recognizes these boss request types:

- system_upgrade
- product_planning
- ui_design
- interaction_design
- frontend_development
- backend_development
- testing_acceptance
- operations_release
- acceptance_feedback

## Dispatch Modes

- planning_only: create exactly one project director planning job and wait for boss approval.
- approved_execution: after boss replies `批准执行`, create concrete Agent jobs from the latest task tree.

## Dispatch Rules

- Product requests start with `product_manager`.
- Visual and page-state requests go to `ui_designer` or `interaction_designer`.
- Code changes go to `frontend_developer` or `backend_developer` only after scope is explicit.
- Bug fixes and acceptance feedback first go through `project_director` diagnosis, then development or testing.
- Release, deploy, production, env, database schema, SQL, and delete-data tasks require boss approval.

## Compatibility

The dispatcher stores task content in `hermes_jobs.request_text` and uses compatible values for `source`, `workflow_stage`, and `plan_status`. Optional columns are removed and retried when Supabase reports that the column does not exist.

## Freeze

The following pages stay frozen during this batch:

- `app/page.tsx`
- `app/post/page.tsx`
- `app/partners/page.tsx`
- `src/app/page.tsx`
- `src/app/post/page.tsx`
- `src/app/partners/page.tsx`
