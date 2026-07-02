# Hermes V2 Schema Final Approval

Scope: Phase 2D final approval package only.

This document does not execute SQL, does not connect to Supabase, does not modify the database, and does not authorize Codex or Worker to run database changes.

## 1. Final Approval Conclusion

Final status: `waiting_review`.

The Phase 2C SQL in `docs/setup-hermes-v2-schema.sql` is ready for boss review as a manual execution candidate. It is additive, V2-prefixed, and designed to preserve the existing V1 `hermes_jobs` system.

Recommendation: approve manual execution only after the boss confirms the target Supabase project, backup or restore point, and execution owner.

## 2. Should This SQL Be Manually Executed

Yes, conditionally.

The SQL may be manually executed by the boss or another explicitly approved human operator in Supabase SQL Editor after this package is reviewed. It should not be executed by Codex, Worker, CI, scripts, or any automated database client.

## 3. Codex SQL Execution Boundary

Codex remains forbidden from executing SQL.

Codex must not:

- Connect to Supabase.
- Open a database session.
- Run the V2 schema SQL.
- Run the verification SQL.
- Apply rollback SQL.
- Modify `docs/setup-hermes-v2-schema.sql` in this phase.

## 4. Tables Created By This SQL

The SQL creates 9 new Hermes V2 tables, all with the `hermes_v2_` prefix:

- `hermes_v2_projects`
- `hermes_v2_tasks`
- `hermes_v2_task_checkpoints`
- `hermes_v2_task_attempts`
- `hermes_v2_task_events`
- `hermes_v2_agents`
- `hermes_v2_human_decisions`
- `hermes_v2_deployments`
- `hermes_v2_feishu_sync_outbox`

It also creates or updates one helper function:

- `hermes_v2_set_updated_at()`

It creates one `updated_at` trigger per V2 table and V2-prefixed indexes and constraints needed for the schema draft.

## 5. What This SQL Does Not Do

The SQL does not:

- Delete tables.
- Truncate or clear data.
- Delete rows.
- Modify `hermes_jobs`.
- Rename `hermes_jobs`.
- Add a foreign key to `hermes_jobs`.
- Modify existing business tables.
- Backfill V1 data into V2.
- Enable V2 runtime behavior.
- Change API, Worker, Feishu, Vercel, or application code.
- Create RLS policies.
- Store secrets, service-role keys, app secrets, or connection strings.

## 6. Main Safety Points

- All new tables use the `hermes_v2_` prefix, reducing collision risk with existing business tables.
- The SQL uses `create table if not exists` and `create index if not exists`.
- V1 `hermes_jobs` is intentionally preserved as the rollback and compatibility anchor.
- No destructive statements are expected: no `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, or `ALTER TABLE hermes_jobs`.
- V2 rows are initially expected to be empty because this phase does not backfill or enable writers.
- `updated_at` maintenance is handled by a shared trigger function and per-table triggers.
- Key status and type fields have check constraints.
- V2 relationships use V2-only foreign keys where the table order permits.
- RLS is intentionally deferred to a later separately approved phase.
- Feishu app/table fields are documented as non-secret locators only.

## 7. Remaining Risks

- `create extension if not exists pgcrypto;` may require permissions in the target Supabase project.
- If a partial V2 schema already exists with incompatible columns, `if not exists` may not repair it and later statements may fail.
- `hermes_v2_tasks.last_attempt_id` is intentionally not protected by a foreign key to avoid circular create-order complexity.
- `hermes_v2_tasks.dependency_task_ids` is a JSONB array and must be validated later by API or Worker logic.
- `claim_token` remains nullable until Worker V2 claim semantics are approved.
- RLS is not included, so production use requires a later RLS approval and implementation phase.
- This phase does not prove application compatibility because API, Worker, Feishu sync, and deployment code remain unchanged.

## 8. Boss Must Confirm Before Execution

Before executing any SQL, the boss must confirm:

- The target Supabase project is correct.
- The target environment is clearly named: local, staging, or production.
- The operator is not accidentally using another project.
- A fresh backup, restore point, or equivalent recovery option exists.
- The rollback owner and communication channel are known.
- Existing `hermes_jobs` must remain untouched.
- Runtime mode stays V1 after schema creation.
- No API, Worker, Feishu, Vercel, or business code will switch to V2 in this phase.
- The SQL contains no `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, or `ALTER TABLE hermes_jobs`.
- No real key, token, app secret, service-role key, or connection string appears in the SQL.
- The verification SQL in `docs/upgrade/v2-schema-verification-sql.md` is ready to run manually after execution.

## 9. Recommendation On Phase 2E

Recommendation: enter Phase 2E only after boss approval.

Phase 2E may be the manual database execution phase, but only under this boundary:

- The boss or approved human operator manually opens Supabase SQL Editor.
- The human manually copies reviewed SQL from `docs/setup-hermes-v2-schema.sql`.
- The human manually executes it in the approved project.
- The human manually runs the verification SQL.
- Codex must not connect to Supabase.
- Codex must not run SQL.
- Codex must not automate database execution or rollback.

Until that approval is given, the correct state is `waiting_review`.
