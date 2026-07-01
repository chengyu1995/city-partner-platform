# Hermes V2 Schema Phase 2C Change Log

Scope: Phase 2C SQL draft revision only.

This phase did not execute SQL, did not connect to Supabase, did not modify database data, did not modify `hermes_jobs`, and did not change application, Worker, API, Vercel, Feishu sync, `.env`, or `.gitignore` files.

## Modified Files

- `docs/setup-hermes-v2-schema.sql`
- `docs/upgrade/v2-schema-change-log.md`
- `docs/upgrade/v2-schema-execution-plan.md`

## SQL Changes And 2B Risk Mapping

| Change | Phase 2B risk addressed | Detail |
| --- | --- | --- |
| Renamed all V2 tables to `hermes_v2_` prefixed names | Section 23 table name collision risk | Replaced generic names such as `projects`, `tasks`, `agents`, and `deployments` with `hermes_v2_projects`, `hermes_v2_tasks`, `hermes_v2_agents`, `hermes_v2_deployments`, and the other V2 table names. |
| Added explicit safety header | Sections 2, 5, 27, 29 execution safety | Header states the file only creates V2 tables, does not modify `hermes_jobs`, does not remove or clear data, does not add RLS, and must be manually reviewed in Supabase SQL Editor. |
| Added `create extension if not exists pgcrypto;` | Sections 19 and 20 `gen_random_uuid()` dependency | Keeps UUID defaults compatible with Supabase PostgreSQL when `pgcrypto` is not already enabled. |
| Added `hermes_v2_set_updated_at()` trigger function and per-table triggers | Section 7 missing `updated_at` maintenance | All 9 V2 tables keep `updated_at` current through a shared trigger function. Trigger creation uses a repeatable `do` block with existence checks. |
| Added V2-only foreign keys where table order allows | Section 17 foreign key completeness risk | Semantic UUID references now point to V2 tables only: attempts, checkpoints, decisions, deployments, events, outbox, agents, tasks, and projects. No foreign key points to `hermes_jobs` or unknown business tables. |
| Kept `tasks.last_attempt_id` without a foreign key and documented why | Sections 9 and 17 circular dependency risk | Avoids a create-order cycle. Later API/Worker phases must keep this mirror field correct. |
| Changed task dependency storage from `uuid[]` to `jsonb` array and documented no FK enforcement | Sections 9 and 18 dependency integrity risk | The comment states Phase 2C does not enforce per-item foreign keys. Later API/Worker phases must validate referenced task IDs and cycles. |
| Added `(task_id, attempt_number)` unique constraint | Section 11 duplicate attempt number risk | Prevents duplicate attempt numbers for one V2 task. |
| Added `retry_count` to `hermes_v2_task_attempts` | SQL revision requirement 17 | Attempts now explicitly support retry count, exit code, start/finish timestamps, and error text. |
| Renamed `agents.agent_name` to `agents.name` | Sections 13 and 24 field naming drift | Aligns with Phase 1A/1D documents and Feishu display design. |
| Added agent online/current-task health fields | SQL revision requirement 19 | `status`, `current_task_id`, `heartbeat_at`, `last_seen_at`, and `consecutive_failure_count` support online status and failure visibility. |
| Narrowed `human_decisions.decision_status` to `waiting`, `answered`, `cancelled`, `expired` | SQL revision requirement 14 | Matches this phase's requested lifecycle. Approval/rejection semantics remain in `decision_type`, `decision_text`, and later workflow rules. |
| Added constrained `task_events.event_type` values | Sections 12 and 22 event naming drift | Event types cover task status changes, progress, heartbeat, errors, human decisions, retries, deployments, and Feishu sync. |
| Added constrained `feishu_sync_outbox.operation` values | Section 26 operation drift risk | Reduces typo drift for async Feishu operations while preserving non-blocking outbox behavior. |
| Added required deployment fields | SQL revision requirement 18 | `preview_url`, `production_url`, `deploy_status`, and `git_commit_sha` are present. |
| Added required indexes | Section 18 index coverage risk | Indexes cover `project_id`, `parent_task_id`, `status`, `role`, `claimed_by`, `heartbeat_at`, `created_at`, `task_id`, `agent_id`, and `sync_status` across the relevant tables. |
| Kept RLS out of executable SQL | Sections 19 and 31 RLS deferred risk | The SQL only notes that RLS is deferred to a later approved phase. No RLS policy is created in Phase 2C. |

## Table Name Changes

All 9 V2 tables changed from generic names to prefixed names:

| Phase 2B name | Phase 2C name |
| --- | --- |
| `projects` | `hermes_v2_projects` |
| `tasks` | `hermes_v2_tasks` |
| `task_checkpoints` | `hermes_v2_task_checkpoints` |
| `task_attempts` | `hermes_v2_task_attempts` |
| `task_events` | `hermes_v2_task_events` |
| `agents` | `hermes_v2_agents` |
| `human_decisions` | `hermes_v2_human_decisions` |
| `deployments` | `hermes_v2_deployments` |
| `feishu_sync_outbox` | `hermes_v2_feishu_sync_outbox` |

## Field Name Changes

| Old field | New field | Reason |
| --- | --- | --- |
| `agents.agent_name` | `hermes_v2_agents.name` | Align with Phase 1A/1D references to `agents.name`. |
| `tasks.dependency_task_ids uuid[]` | `hermes_v2_tasks.dependency_task_ids jsonb` | Keep dependency list flexible and explicitly non-FK-enforced in the first schema draft. |

Existing status field names remain specific where useful: `decision_status`, `deploy_status`, and `sync_status`. Later API/Feishu layers must map these to any generic display field named `status`.

## Added Indexes, Constraints, And Triggers

- Added clear `hermes_v2_*` check constraint names for statuses, type fields, progress ranges, retry counts, and JSON array fields.
- Added `hermes_v2_task_attempts_task_attempt_unique`.
- Added V2-prefixed indexes for queue, tree, status, role, claim, heartbeat, event, deployment, and outbox access patterns.
- Added one shared `hermes_v2_set_updated_at()` trigger function.
- Added one `before update` trigger per V2 table through a guarded `do` block.

## Remaining Risks

- SQL still requires human review before execution in Supabase SQL Editor.
- `create extension if not exists pgcrypto;` may require privileges that the executing human must confirm in the target Supabase project.
- `tasks.last_attempt_id` remains an application-maintained mirror field without a foreign key.
- Task dependency IDs are stored as a JSONB array and are not database-enforced in Phase 2C.
- `claim_token` remains nullable until Worker V2 claim semantics are approved.
- RLS is intentionally not included; production readiness requires a later approved RLS design.
- No V1 backfill or compatibility data migration is included in this phase.

## Recommendation

The revised draft is suitable for owner review and manual staging execution planning. It should not move to Phase 2D until the owner approves the execution plan and confirms the target environment, backup, and rollback owner.
