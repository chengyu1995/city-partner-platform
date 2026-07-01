# Hermes V2 Implementation Plan And Rollback Checklist

Scope: Phase 1F design document only.

This document defines the staged implementation plan and rollback checklist for Hermes multi-role task management system V2. It depends on:

- Phase 1A: `docs/upgrade/v2-data-model.md`
- Phase 1B: `docs/upgrade/v2-task-state-machine.md`
- Phase 1C: `docs/upgrade/v2-task-breakdown-rules.md`
- Phase 1D: `docs/upgrade/v2-feishu-bitable-design.md`
- Phase 1E: `docs/upgrade/v2-safety-and-approval-rules.md`

This phase does not execute database statements, does not create migration files, does not modify business code, does not modify Worker code, does not modify API routes, and does not modify `.gitignore`.

## 1. V2 Upgrade Overall Goal

Hermes V2 upgrades the current single-row task queue into a multi-role task management system that can safely coordinate boss requests, Hermes planning, Codex/Worker execution, human approval, Feishu visibility, Git output, and deployment status.

The target outcome is:

- V2 has a canonical task tree with project, phase, task package, subtask, and checkpoint semantics.
- V2 separates durable task identity from execution attempts, audit events, human decisions, deployment records, and Feishu sync work.
- V2 supports safe compatibility with the current V1 `hermes_jobs` flow while later phases gradually introduce V2 storage and behavior.
- V2 provides explicit stop, review, rollback, and owner approval points before high-risk changes.
- V2 remains reversible at every rollout step until the final owner-approved switch.

## 2. Current V1 System Retention Principles

V1 must remain usable throughout the upgrade unless a later phase receives explicit approval to change production behavior.

Retention principles:

- Keep `hermes_jobs` readable and operational during migration and compatibility phases.
- Do not remove V1 fields or V1 API behavior until V2 has passed gray testing and owner acceptance.
- Preserve V1 status meaning while mapping to V2 canonical states only in compatibility layers.
- Keep existing Worker Git ownership rules intact until the Worker V2 phase is separately approved.
- Keep Feishu display behavior best-effort until durable outbox processing is implemented and validated.
- Preserve mock mode and real Supabase mode compatibility.
- Treat V1 as the rollback target for every pre-switch phase.

## 3. V1, Dual, And V2 Mode Switching Strategy

Hermes should support three runtime modes during rollout.

| Mode | Purpose | Read path | Write path | Owner gate |
| --- | --- | --- | --- | --- |
| `v1` | Current stable behavior. | V1 records only. | V1 records only. | Default before V2 rollout. |
| `dual` | Compatibility and gray testing. | Prefer V2 where available, fall back to V1. | Write V1 and V2 according to phase scope. | Required before enabling per environment. |
| `v2` | Final target behavior. | V2 canonical tables. | V2 canonical tables and outbox. | Required for final switch. |

Switching rules:

- Mode changes must be configuration-driven, not hardcoded in task-specific code.
- `v1` to `dual` requires validated V2 storage, read compatibility, and rollback proof.
- `dual` to `v2` requires successful gray testing, no unresolved critical sync failures, and owner approval.
- `v2` to `dual` is the first rollback step if V2 behavior degrades after switch.
- `dual` to `v1` is the full compatibility rollback if V2 storage or APIs are unreliable.
- No mode switch should run in production without a human decision record.

## 4. Phase 2: Database Migration SQL Design Plan

Goal: prepare reviewed database migration design for V2 storage without running it in Phase 1F.

Input files:

- `docs/upgrade/v2-data-model.md`
- `docs/upgrade/v2-task-state-machine.md`
- `docs/upgrade/v2-safety-and-approval-rules.md`
- Existing database setup and audit documents under `docs/upgrade/`

Output files:

- A later migration design document.
- A later reviewed migration file if approved in Phase 2.
- A rollback checklist specific to database structure.

Allowed file range:

- Documentation under `docs/upgrade/`
- Approved database migration files only after explicit Phase 2 approval.

Forbidden content:

- Business code changes.
- Worker changes.
- API route behavior changes.
- Production data mutation without explicit owner approval.
- Any unreviewed table, policy, or permission change.

Acceptance criteria:

- Migration plan covers all V2 canonical records from Phase 1A.
- Status fields match Phase 1B.
- Compatibility fields preserve V1 identifiers.
- Backfill strategy is idempotent and bounded.
- Rollback path is documented before execution.

Rollback method:

- Stop after database validation failure.
- Keep runtime mode in `v1`.
- Do not enable V2 read or write paths.
- Restore from approved backup only through a separately approved database recovery procedure.

## 5. Phase 3: Cloud API Dual-Write And Dual-Read Refactor Plan

Goal: add API compatibility behavior so cloud routes can operate in `v1`, `dual`, or `v2` mode.

Input files:

- `docs/upgrade/v2-data-model.md`
- `docs/upgrade/v2-task-state-machine.md`
- `docs/upgrade/v2-safety-and-approval-rules.md`
- Phase 2 database output
- Existing API route and data-access code

Output files:

- Updated API routes or service modules in a later implementation phase.
- API contract notes.
- Validation results for all supported modes.

Allowed file range:

- API route files approved for Phase 3.
- Data-access modules approved for Phase 3.
- Tests for API compatibility.
- Documentation for API contracts.

Forbidden content:

- Worker behavior changes.
- Feishu table configuration changes.
- Production mode switch.
- Removing V1 API compatibility.
- Broad refactors unrelated to task read/write behavior.

Acceptance criteria:

- `v1` mode preserves existing behavior.
- `dual` mode can write or read V2 records without breaking V1 clients.
- `v2` mode uses canonical V2 records after explicit gate.
- API responses preserve fields required by current Worker and Feishu flows.
- Validation covers missing environment variables and mock mode.

Rollback method:

- Switch API mode back to `v1`.
- Disable dual writes.
- Keep V2 data for audit but stop using it for live behavior.
- Revert Phase 3 code through Git if configuration rollback is insufficient.

## 6. Phase 4: Worker V2 Claim And Progress Report Refactor Plan

Goal: move Worker execution from V1 row mutation toward V2 task attempt ownership, heartbeat, progress, and result reporting.

Input files:

- `docs/upgrade/v2-data-model.md`
- `docs/upgrade/v2-task-state-machine.md`
- `docs/upgrade/v2-task-breakdown-rules.md`
- `docs/upgrade/v2-safety-and-approval-rules.md`
- Phase 3 API compatibility output
- Existing Worker implementation

Output files:

- Updated Worker implementation in a later phase.
- Worker claim/progress contract notes.
- Validation output proving V1 fallback still works.

Allowed file range:

- Worker files explicitly approved for Phase 4.
- Worker tests or validation scripts approved for Phase 4.
- Documentation for Worker contracts.

Forbidden content:

- Database structure changes.
- API contract expansion not approved in Phase 3.
- Git commit, push, branch, or staging behavior changes unless explicitly included in the Phase 4 approval.
- Production deployment behavior changes.

Acceptance criteria:

- Worker claims tasks atomically through the approved API path.
- Claim token ownership is enforced for progress reports.
- Heartbeat stale and timeout behavior follows Phase 1B.
- Progress reports are monotonic within one attempt.
- Worker can fall back to V1 mode if V2 claim fails during gray testing.

Rollback method:

- Disable V2 Worker mode.
- Return Worker to V1 claim/report path.
- Mark incomplete V2 attempts as cancelled, timed out, or superseded according to approved policy.
- Keep task events for audit.

## 7. Phase 5: Feishu Sync Queue And Bitable Sync Refactor Plan

Goal: replace best-effort Feishu writes with durable, retryable sync work.

Input files:

- `docs/upgrade/v2-feishu-bitable-design.md`
- `docs/upgrade/v2-data-model.md`
- `docs/upgrade/v2-safety-and-approval-rules.md`
- Phase 2 database output
- Phase 3 API output

Output files:

- Feishu sync outbox implementation in a later approved phase.
- Bitable field and view mapping notes.
- Sync retry validation report.

Allowed file range:

- Feishu sync modules approved for Phase 5.
- Outbox processing code approved for Phase 5.
- Tests or scripts that validate sync behavior.
- Documentation for Bitable operations.

Forbidden content:

- Direct Feishu schema changes without owner approval.
- Message fan-out changes.
- Canonical task status mutation caused only by Feishu sync failure.
- Secret or token exposure in logs, docs, or records.

Acceptance criteria:

- Canonical state changes enqueue sync work after successful internal writes.
- Outbox retry is bounded and visible.
- Feishu manual fields do not become canonical without an approved reader flow.
- Sync failure does not block Worker progress or task terminal state.
- V1 Feishu display can continue if V2 sync is disabled.

Rollback method:

- Disable V2 outbox processor.
- Return Feishu writes to V1 best-effort behavior if needed.
- Leave failed outbox items for audit and later requeue.
- Do not roll back canonical task state only because Feishu display failed.

## 8. Phase 6: Task Tree Decomposer Implementation Plan

Goal: implement task decomposition from natural-language boss requests into V2 project, phase, task package, subtask, and checkpoint records.

Input files:

- `docs/upgrade/v2-task-breakdown-rules.md`
- `docs/upgrade/v2-data-model.md`
- `docs/upgrade/v2-task-state-machine.md`
- Phase 2 database output
- Phase 3 API output

Output files:

- Decomposition implementation in a later approved phase.
- Task tree examples and fixtures.
- Validation report for dependency, sizing, and approval node insertion.

Allowed file range:

- Decomposer modules approved for Phase 6.
- Tests and fixtures for decomposition.
- Documentation for prompt and tree generation behavior.

Forbidden content:

- Automatically executing broad tasks before decomposition is reviewed.
- Creating runnable subtasks without allowed scope and forbidden scope.
- Inferring product choices where a human decision is required.
- Modifying Worker claim behavior in this phase.

Acceptance criteria:

- Broad requests become draft trees or blocked decision nodes, not unsafe executable tasks.
- Codex-ready subtasks include allowed files, forbidden files, done conditions, and validation policy.
- Dependencies are acyclic and serial/parallel rules are explicit.
- Parent status and progress rollups follow Phase 1C.

Rollback method:

- Disable automatic decomposition.
- Keep manually created V1 jobs or V2 tasks as the intake path.
- Mark generated draft trees as cancelled or superseded only through approved policy.
- Preserve original source messages for traceability.

## 9. Phase 7: Human Approval And `human_decisions` Implementation Plan

Goal: make approvals, clarifications, review decisions, risk acceptance, and production gates first-class records.

Input files:

- `docs/upgrade/v2-safety-and-approval-rules.md`
- `docs/upgrade/v2-task-state-machine.md`
- `docs/upgrade/v2-feishu-bitable-design.md`
- Phase 2 database output
- Phase 5 Feishu sync output

Output files:

- Human decision API or service implementation in a later phase.
- Feishu decision display and optional reply ingestion implementation after approval.
- Approval validation tests.

Allowed file range:

- Human decision service/API files approved for Phase 7.
- Feishu decision sync files approved for Phase 7.
- Tests for approval state transitions.
- Documentation for approval workflows.

Forbidden content:

- Treating silence or expired decisions as approval.
- Letting Feishu manual fields directly mutate canonical state without validation.
- Bypassing owner gates for high or critical operations.
- Production release actions.

Acceptance criteria:

- `awaiting_human` tasks cannot be claimed until the required decision is resolved.
- Approval, rejection, clarification, review, and production gate decisions are auditable.
- Rejection routes tasks to retrying, cancelled, failed, or blocked according to policy.
- Expired decisions remain non-approving.

Rollback method:

- Disable decision ingestion.
- Keep unresolved tasks blocked or return them to manual V1 handling.
- Preserve decision records as audit data.
- Revert API or Feishu reader changes through Git if needed.

## 10. Phase 8: Gray Testing Plan

Goal: validate V2 behavior with limited scope before production switch.

Input files:

- Outputs from Phases 2 through 7.
- Existing V1 operational records.
- Test task fixtures.
- Owner-approved gray scope.

Output files:

- Gray test report.
- Known issue list.
- Go/no-go recommendation.
- Rollback readiness report.

Allowed file range:

- Test fixtures and validation scripts approved for gray testing.
- Documentation under `docs/upgrade/`.
- Small fixes approved within the gray test scope.

Forbidden content:

- Full production mode switch.
- Unbounded backfill.
- Broad Feishu message fan-out.
- Production deployment without owner gate.

Acceptance criteria:

- V1 mode still works.
- Dual mode handles representative task intake, claim, progress, review, sync, and rollback paths.
- V2 failures stop at the correct phase boundary.
- Feishu display stays consistent enough for owner decisions.
- All high and critical gates are recorded.

Rollback method:

- Switch runtime back to `v1`.
- Disable V2 Worker, API, outbox, decomposer, and decision ingestion toggles.
- Keep V2 records for audit unless separate cleanup is approved.
- Resume V1 operational queue.

## 11. Phase 9: Formal V2 Switch Plan

Goal: move Hermes from compatibility mode to V2 canonical operation.

Input files:

- Phase 8 gray test report.
- Final owner approval.
- Rollback readiness report.
- Production configuration checklist.

Output files:

- V2 switch execution record.
- Final validation report.
- Post-switch monitoring checklist.
- Owner acceptance summary.

Allowed file range:

- Configuration or code files explicitly approved for final switch.
- Documentation of the switch and validation.
- Monitoring or operational checklist files.

Forbidden content:

- Unapproved production deployment.
- Destructive data cleanup.
- Removing V1 fallback before stability window completes.
- Changing secrets or production environment variables through automation.

Acceptance criteria:

- Owner has approved the switch.
- V2 intake, task tree, Worker, API, Feishu sync, approvals, and rollback checks have passed.
- V1 fallback remains available for a defined stability window.
- Monitoring shows no critical task loss, duplicate claims, or approval bypass.

Rollback method:

- Move from `v2` back to `dual`.
- If needed, move from `dual` back to `v1`.
- Stop V2-only Workers and sync processors.
- Preserve V2 records for diagnosis.

## 12. Phase Input Files Summary

| Phase | Input files |
| --- | --- |
| 2 | Phase 1A, Phase 1B, Phase 1E, database audits |
| 3 | Phase 1A, Phase 1B, Phase 1E, Phase 2 output, existing API code |
| 4 | Phase 1A, Phase 1B, Phase 1C, Phase 1E, Phase 3 output, Worker code |
| 5 | Phase 1A, Phase 1D, Phase 1E, Phase 2 output, Phase 3 output |
| 6 | Phase 1A, Phase 1B, Phase 1C, Phase 2 output, Phase 3 output |
| 7 | Phase 1B, Phase 1D, Phase 1E, Phase 2 output, Phase 5 output |
| 8 | Outputs from Phases 2-7, V1 fixtures, owner-approved gray scope |
| 9 | Phase 8 report, owner approval, rollback readiness report |

## 13. Phase Output Files Summary

| Phase | Output files |
| --- | --- |
| 2 | Migration design, approved migration artifact if separately authorized, database rollback notes |
| 3 | API compatibility implementation, API contract notes, validation report |
| 4 | Worker V2 implementation, Worker contract notes, validation report |
| 5 | Feishu outbox implementation, Bitable mapping notes, sync retry report |
| 6 | Task decomposer implementation, fixtures, decomposition validation report |
| 7 | Human decision implementation, approval workflow tests, decision sync notes |
| 8 | Gray test report, issue list, go/no-go recommendation |
| 9 | V2 switch record, final validation report, monitoring checklist |

## 14. Phase Allowed File Ranges Summary

| Phase | Allowed range |
| --- | --- |
| 2 | Approved docs and database migration artifacts only |
| 3 | Approved API routes, data-access modules, API tests, API docs |
| 4 | Approved Worker files, Worker tests, Worker contract docs |
| 5 | Approved Feishu sync modules, outbox processor, sync tests, Bitable docs |
| 6 | Approved decomposer modules, fixtures, decomposition tests, docs |
| 7 | Approved decision services, decision APIs, Feishu decision sync, tests, docs |
| 8 | Approved validation scripts, fixtures, docs, scoped gray fixes |
| 9 | Approved switch configuration, operational docs, monitoring checklist |

## 15. Phase Forbidden Content Summary

| Phase | Forbidden content |
| --- | --- |
| 2 | Business code, Worker code, API behavior, production data changes without approval |
| 3 | Worker changes, Feishu configuration changes, production switch, V1 compatibility removal |
| 4 | Database structure changes, unapproved Git behavior changes, production deployment changes |
| 5 | Direct Feishu schema changes without approval, fan-out changes, secret exposure |
| 6 | Unsafe auto-execution, missing scope, inferred product decisions |
| 7 | Approval bypass, silence-as-approval, unvalidated Feishu manual state mutation |
| 8 | Full production switch, unbounded backfill, broad fan-out, production release |
| 9 | Destructive cleanup, removing V1 fallback too early, automation-managed secrets |

## 16. Phase Acceptance Standards Summary

| Phase | Acceptance standard |
| --- | --- |
| 2 | V2 storage design is reviewed, compatible, reversible, and not yet live by accident |
| 3 | API supports `v1`, `dual`, and `v2` behavior with compatibility tests |
| 4 | Worker claim, heartbeat, progress, timeout, and fallback behavior are validated |
| 5 | Feishu sync is durable, bounded, non-blocking, and secret-safe |
| 6 | Decomposition creates safe task trees with explicit dependencies and gates |
| 7 | Human decisions gate risky work and are auditable |
| 8 | Gray testing proves representative V2 workflows and rollback readiness |
| 9 | Owner-approved switch succeeds with monitoring and V1 fallback retained |

## 17. Phase Rollback Methods Summary

| Phase | Rollback method |
| --- | --- |
| 2 | Keep runtime in `v1`; do not use V2 storage; recover database only through approved recovery |
| 3 | Switch API mode to `v1`; disable dual writes; revert Phase 3 code if needed |
| 4 | Disable V2 Worker mode; return to V1 claim/report path |
| 5 | Disable outbox processor; return to V1 Feishu best-effort display |
| 6 | Disable decomposer; use manual V1 or V2 intake |
| 7 | Disable decision ingestion; keep risky tasks blocked |
| 8 | Return all toggles to `v1`; stop V2 processors |
| 9 | Move from `v2` to `dual`, then to `v1` if needed |

## 18. Database Rollback Checklist

- Confirm whether any database structure change was actually applied in a later phase.
- Confirm the environment: local, staging, or production.
- Stop V2 writers before attempting database recovery.
- Keep application mode in `v1` or move it back to `v1`.
- Preserve V2 records for audit unless owner approves cleanup.
- Restore from approved backup only through a human-approved recovery task.
- Verify V1 `hermes_jobs` read/write behavior after rollback.
- Verify no V2-only code path is required for active Worker execution.

## 19. API Rollback Checklist

- Set runtime mode to `v1`.
- Disable dual-write behavior.
- Disable V2-only response fields if they break current clients.
- Verify existing Worker can claim and report through the V1 path.
- Verify Feishu display still receives the V1-compatible fields it needs.
- Revert Phase 3 code if configuration rollback does not restore behavior.
- Record the API rollback reason and affected requests.

## 20. Worker Rollback Checklist

- Stop V2 Worker processes or disable their V2 claim mode.
- Ensure no active task is claimed by both V1 and V2 paths.
- Mark stale V2 attempts according to approved policy.
- Resume V1 Worker claim behavior.
- Verify Git ownership remains with the Worker policy.
- Verify progress and terminal reporting reaches the V1 system.
- Keep V2 attempt logs and events for diagnosis.

## 21. Feishu Sync Rollback Checklist

- Disable V2 outbox processing.
- Stop consuming Feishu manual reply fields if the reader exists.
- Return display writes to V1 behavior if required.
- Do not change canonical task state only because Feishu sync failed.
- Preserve failed outbox items for diagnosis and possible requeue.
- Notify owner if Feishu display is stale while canonical state remains valid.
- Verify no secrets or claim tokens were written to Bitable.

## 22. Git Rollback Checklist

- Identify the exact phase commit or branch that introduced the problem.
- Prefer configuration rollback before Git rollback when possible.
- Do not rewrite protected branch history.
- Do not discard unrelated user changes.
- Revert only the files or commits from the failing phase after review.
- Keep generated V2 audit records unless cleanup is separately approved.
- If Worker-owned publishing created a bad commit, use the repository's approved revert process rather than force rewriting.

## 23. How To Stop Later Phases After Failure

Failure stop rules:

- Any disallowed file modification stops the current phase immediately.
- Any failed validation that affects production safety stops promotion to the next phase.
- Any unresolved high or critical approval stops execution until a human decision is recorded.
- Any database, API, Worker, or Feishu rollback that is incomplete blocks later phases.
- Any mismatch between V1 and V2 task status mapping blocks mode promotion.
- Any duplicate Worker claim, lost task, or approval bypass blocks the final switch.

Stop procedure:

- Freeze the current phase.
- Keep runtime mode at the safest available setting.
- Record the failing phase, trigger, affected files or systems, and current rollback status.
- Ask for one focused owner decision when automation cannot safely continue.
- Resume only after the failure is fixed, validated, and accepted.

## 24. Boss Human Approval Node Schedule

Required owner approval nodes:

| Approval node | Before phase | Decision purpose |
| --- | --- | --- |
| Database migration approval | 2 | Confirm schema scope, rollback plan, and environment |
| API compatibility approval | 3 | Confirm V1 compatibility and dual-read/write strategy |
| Worker V2 approval | 4 | Confirm claim, heartbeat, progress, and Git ownership policy |
| Feishu sync approval | 5 | Confirm Bitable changes, outbox behavior, and manual field boundaries |
| Decomposer approval | 6 | Confirm task tree sizing, product decision gates, and execution limits |
| Human decision workflow approval | 7 | Confirm approval ingestion and rejection behavior |
| Gray test approval | 8 | Confirm limited rollout scope and stop conditions |
| Formal V2 switch approval | 9 | Confirm production readiness and rollback readiness |

Default behavior when approval is missing:

- Do not execute the risky phase.
- Keep the task in `awaiting_human` or the equivalent blocked state.
- Preserve all design outputs and validation evidence for review.

## 25. Final V2 Acceptance Checklist

V2 is complete only when all items below are satisfied:

- V2 data storage exists and has validated compatibility with V1 identifiers.
- V2 task statuses and attempt statuses follow the Phase 1B state machine.
- Task tree decomposition follows Phase 1C sizing, dependency, rollup, and checkpoint rules.
- Feishu displays canonical state safely and sync failures are durable and non-blocking.
- Human approvals are first-class, auditable, and required for high or critical actions.
- API mode switching between `v1`, `dual`, and `v2` is validated.
- Worker V2 claim and progress reporting are safe under concurrency.
- Gray testing passed with representative tasks.
- Rollback from `v2` to `dual` and from `dual` to `v1` is validated.
- Boss has approved the final switch.
- V1 fallback remains available during the agreed stability window.

## 26. Non-Execution Rule For This Phase

Phase 1F only creates this implementation plan and rollback checklist.

This phase does not:

- Execute database statements.
- Create migration files.
- Modify business code.
- Modify Worker code.
- Modify API routes.
- Modify `.gitignore`.
- Change production data.
- Change Supabase RLS policies.
- Change Feishu table schemas directly.
- Trigger Feishu API writes.
- Trigger production deployment.
- Stage, commit, push, branch, merge, rebase, or cherry-pick from Codex.

Later phases must treat this document as a planning input, not as permission to execute changes automatically.
