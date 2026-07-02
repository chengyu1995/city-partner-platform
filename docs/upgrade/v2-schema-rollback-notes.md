# Hermes V2 Schema Rollback Notes

Scope: Phase 2D rollback notes only.

These notes do not authorize Codex, Worker, or any agent to run rollback SQL. Any database rollback must be approved and performed manually by the boss or an explicitly approved human operator.

## 1. Why Rollback Must Be Cautious

Database rollback is a high-risk operation because it can destroy audit evidence, remove partially useful schema state, or accidentally affect V1 production behavior if the wrong object is targeted.

Even though this phase only creates new V2 objects, rollback should be slower than execution. The safer default is to pause, record the failure, keep runtime mode in V1, and wait for boss approval.

## 2. Expected Impact Of This Schema

The V2 schema is additive:

- It creates new `hermes_v2_` tables.
- It does not modify `hermes_jobs`.
- It does not backfill V1 data.
- It does not enable V2 runtime behavior.
- It does not modify existing business tables.

Because the old system should continue to use V1 `hermes_jobs`, unused V2 tables can normally remain in place while the owner investigates.

## 3. If Execution Fails After Partial Creation

If SQL fails after some objects were created:

1. Stop immediately.
2. Keep runtime mode in V1.
3. Save the Supabase SQL Editor error.
4. Screenshot the error and current query position.
5. Record which chunks completed.
6. Run only approved read-only inspection queries if the human operator needs evidence.
7. Do not immediately run `DROP`.
8. Ask the boss whether to keep the partial V2 schema for inspection or approve manual cleanup.

Partial V2 objects are usually less dangerous than a rushed destructive rollback.

## 4. Approval Required Before Deleting V2 Tables

Deleting V2 tables requires explicit boss approval.

The approval must state:

- Target Supabase project.
- Target environment.
- Reason for deletion.
- Confirmation that only `hermes_v2_` objects are in scope.
- Confirmation that `hermes_jobs` must not be touched.
- Confirmation that no business table is in scope.
- Whether V2 rows need export or screenshots before deletion.

Codex must not perform this deletion.

## 5. Reverse Dependency Deletion Order If Approved

If the boss explicitly approves deletion of V2 tables, a human should delete only `hermes_v2_` prefix tables and use dependency reverse order.

Suggested table order:

1. `hermes_v2_feishu_sync_outbox`
2. `hermes_v2_task_events`
3. `hermes_v2_deployments`
4. `hermes_v2_human_decisions`
5. `hermes_v2_task_checkpoints`
6. `hermes_v2_task_attempts`
7. `hermes_v2_agents`
8. `hermes_v2_tasks`
9. `hermes_v2_projects`

Only after the tables are handled should the human consider whether to remove the helper function `hermes_v2_set_updated_at()`. Removing the helper function is not required if tables remain or if future rerun is expected.

## 6. Strict Deletion Boundary

Allowed only with boss approval:

- `hermes_v2_` prefix tables created by this schema.
- V2-only trigger function if confirmed unused.
- V2-only triggers and indexes attached to V2 tables.

Absolutely forbidden:

- Delete `hermes_jobs`.
- Rename `hermes_jobs`.
- Truncate `hermes_jobs`.
- Delete rows from `hermes_jobs`.
- Delete business tables.
- Delete unrelated Supabase objects.
- Drop RLS policies or extensions unrelated to this V2 schema.

## 7. Evidence To Save Before Rollback

Before any cleanup, save:

- Screenshot of the Supabase SQL Editor error.
- Exact failed statement or chunk.
- Timestamp.
- Target project reference.
- List of created `hermes_v2_` objects.
- Row counts for V2 tables, if any table exists.
- Confirmation that runtime mode remained V1.
- Confirmation that `hermes_jobs` still exists.

This evidence is needed for audit and for deciding whether to revise SQL before retrying.

## 8. After Rollback

After any approved manual cleanup:

1. Run the verification SQL again.
2. Confirm `hermes_jobs` still exists.
3. Confirm no business table was removed.
4. Confirm whether any `hermes_v2_` tables remain.
5. Record the result and attach screenshots.
6. Keep runtime mode in V1.
7. Return to `waiting_review` or `blocked` until the boss approves the next attempt.

## 9. Safe Default

If there is any uncertainty, do not roll back destructively.

Safe default:

- Stop.
- Preserve partial V2 state.
- Keep V1 runtime active.
- Report the issue.
- Wait for boss approval.

The V2 schema can be revised and reapplied later after the partial state is understood.
