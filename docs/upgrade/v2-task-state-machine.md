# Hermes V2 Task State Machine Design

Scope: Phase 1B design document only.

This document defines the V2 task state machine and transition rules for Hermes multi-role task management. It depends on the Phase 1A data model in `docs/upgrade/v2-data-model.md`.

This phase does not execute database migration, does not modify application code, does not modify Worker code, does not modify API routes, and does not modify `.gitignore`.

## 1. Current `hermes_jobs` State Problems

The V1 `hermes_jobs` model mixes durable requirement identity, Worker lease state, execution progress, Feishu writeback, and final result into one row. That made the MVP simple, but it now creates several state problems:

- Status names are inconsistent. Audited setup definitions include `pending`, `running`, `awaiting_review`, `completed`, and `failed`, while runtime behavior also uses `queued` and `succeeded`.
- A job row is both the task and the active attempt. Retry, timeout, and progress updates overwrite previous execution context.
- Worker claim is not clearly separated from task readiness. A row can look runnable and claimed at the same time if lease fields drift.
- Heartbeat, lease expiry, and timeout are represented as transient fields instead of attempt-owned state.
- Human review is represented as a task status only, so the actual review request, reviewer decision, and expiry are not durable first-class records.
- Feishu/Bitable sync is best-effort and not part of the state machine, so UI state can diverge from internal task state.
- Terminal states do not distinguish successful task completion from successful Worker attempt completion.
- Cancellation and retrying are policy outcomes, but V1 does not model them consistently.

V2 solves this by using `tasks.status` for the canonical task lifecycle, `task_attempts.status` for Worker/Codex execution attempts, `task_events` for the audit stream, `human_decisions` for review and clarification gates, and `feishu_sync_outbox` for durable external display updates.

## 2. V2 Project Status Enum

Project status controls whether new tasks can be accepted or executed under a project. It is intentionally smaller than task status.

| Status | Meaning | New task intake | Worker claim |
| --- | --- | --- | --- |
| `active` | Project is operating normally. | Allowed | Allowed |
| `paused` | Project is temporarily stopped by an owner. | Allowed only as `draft` or blocked intake | Not allowed for new claims |
| `archived` | Project is retained for history only. | Not allowed | Not allowed |

Rules:

- `active` projects can create, queue, claim, review, retry, and complete tasks.
- `paused` projects keep existing records readable, but Workers must not claim new queued tasks. In-flight attempts should either finish naturally or be cancelled by owner policy.
- `archived` projects are terminal at the project level. Tasks and events remain readable for audit, but no new task execution should start.
- Project status changes must emit a project-level audit event in the eventual implementation.

## 3. V2 Task Status Enum

`tasks.status` is the canonical lifecycle of a requirement, parent task, or executable subtask.

| Status | Meaning | Terminal |
| --- | --- | --- |
| `draft` | Created but not ready for Worker execution. | No |
| `queued` | Ready to be claimed by a Worker. | No |
| `running` | Has an active Worker/Codex attempt. | No |
| `awaiting_human` | Blocked on clarification, approval, or owner decision. | No |
| `awaiting_review` | Implementation finished and waiting for validation or review. | No |
| `retrying` | Preparing a new attempt after a failed, stale, or rejected attempt. | No |
| `succeeded` | Task completed successfully. | Yes |
| `failed` | Task ended unsuccessfully and will not retry automatically. | Yes |
| `cancelled` | Task was intentionally stopped before success or failure. | Yes |

Rules:

- Only `queued` tasks can be claimed for normal execution.
- `running` requires an active `task_attempts` row.
- `awaiting_human` requires at least one unresolved `human_decisions` row or an equivalent owner gate.
- `awaiting_review` means Codex/Worker has produced a result that needs validation, human review, or external deployment confirmation before the task is final.
- `retrying` is a short-lived coordination state. It should resolve to `queued`, `awaiting_human`, `failed`, or `cancelled`.
- Terminal task states must set `completed_at` and must not be claimed again unless a human explicitly reopens or duplicates the work into a new task.

## 4. V2 Subtask Status Enum

Subtasks use the same physical `tasks.status` enum, but parent-child aggregation needs explicit display rules.

| Subtask Status | Parent rollup meaning |
| --- | --- |
| `draft` | Parent is not fully planned. |
| `queued` | Parent has runnable remaining work. |
| `running` | Parent is actively being worked. |
| `awaiting_human` | Parent is blocked by at least one child decision. |
| `awaiting_review` | Parent has child work ready for review. |
| `retrying` | Parent has child work being rescheduled. |
| `succeeded` | This child is done. |
| `failed` | Parent is blocked or failed unless policy allows partial success. |
| `cancelled` | Child was intentionally skipped or stopped. |

Aggregation rules:

- A parent task is `succeeded` only when all required subtasks are `succeeded` or explicitly marked optional/cancelled by human decision.
- If any required subtask is `failed`, the parent should move to `awaiting_human` or `failed` based on policy.
- If any required subtask is `running`, the parent display stage should show active execution even if the parent row itself is not directly claimed.
- If subtasks mix `awaiting_review` and `succeeded`, the parent should remain `awaiting_review` until review gates are resolved.
- Optional subtasks can be `cancelled` without failing the parent, but the cancellation reason must be recorded.

## 5. Worker Claim Transition

Worker claim is the transition from a runnable task into an owned attempt.

Allowed transition:

| From task status | To task status | New attempt status | Required conditions |
| --- | --- | --- | --- |
| `queued` | `running` | `claimed` then `running` | Project is `active`, task is not terminal, no active non-terminal attempt exists, attempt count is below limit, and Worker owns a claim token. |

Claim rules:

- Claim must be atomic in the eventual implementation. Two Workers must not create active attempts for the same task.
- Claim creates a new `task_attempts` row with a unique claim token, Worker identity, attempt number, lease expiry, and initial progress.
- Claim updates the task mirror fields: `status = running`, `started_at` if absent, `last_attempt_id`, `attempt_count`, `current_step`, `status_message`, and `progress_percent`.
- Claim emits `task.claimed` and an attempt start event.
- If the project is `paused` or `archived`, claim must be rejected without changing task state.
- If the task is `draft`, `awaiting_human`, `awaiting_review`, `retrying`, or terminal, claim must be rejected unless a later approved workflow defines a special manual override.

## 6. Codex Execution Transition

Codex execution is attempt-scoped. Codex does not own the canonical task by itself; the Worker owns the claim and reports Codex progress and result.

Execution states:

| Attempt status | Meaning |
| --- | --- |
| `claimed` | Worker created the attempt and is preparing execution. |
| `running` | Codex or Worker is actively modifying files or validating results. |
| `heartbeat_stale` | Heartbeat or lease is stale and recovery policy has not resolved it yet. |
| `succeeded` | Attempt completed successfully and produced an acceptable result. |
| `failed` | Attempt failed with a captured failure category and error text. |
| `timed_out` | Attempt exceeded heartbeat, lease, or runtime policy. |
| `cancelled` | Attempt was intentionally stopped. |
| `superseded` | A newer attempt replaced this attempt. |

Codex flow:

- Worker starts from `claimed`, verifies the expected clean-state checkpoint, then moves the attempt to `running`.
- Worker calls Codex with the task prompt and allowed-file constraints.
- Codex updates files only through the Worker-controlled workspace and does not directly commit if Worker policy owns Git operations.
- Worker records progress after major execution phases: preparation, file changes, validation, result packaging, and review handoff.
- If Codex finishes with allowed changes and validation passes, attempt becomes `succeeded`.
- If Codex exits with an error, modifies disallowed files, violates task constraints, or validation fails, attempt becomes `failed`.
- A successful attempt does not always make the task `succeeded`. If review is required, task moves to `awaiting_review`.

## 7. Heartbeat Rules

Heartbeat proves that an active Worker still owns an attempt.

Fields:

- `task_attempts.heartbeat_at`: last heartbeat timestamp.
- `task_attempts.lease_expires_at`: latest time until which the Worker claim is valid.
- `task_attempts.status`: attempt-local state.
- `tasks.status`: task-level mirror state.

Rules:

- Active attempts in `claimed` or `running` must heartbeat periodically.
- Each heartbeat must include the claim token. Updates with a missing or mismatched claim token must be rejected.
- A heartbeat may extend `lease_expires_at` when the attempt is still valid and below the maximum runtime policy.
- If heartbeat is stale but recoverable, attempt moves to `heartbeat_stale`; task may remain `running` with a stale warning.
- If lease expiry exceeds the recovery window, attempt moves to `timed_out`; task moves to `retrying`, `failed`, or `awaiting_human` based on retry policy.
- Heartbeat must not mutate terminal attempts.
- Heartbeat events should be rate-limited in the audit stream. The latest timestamp belongs on the attempt row; only meaningful heartbeat changes need events.

## 8. Progress Report Rules

Progress is user-facing and must be monotonic within one attempt except when a new attempt starts.

Progress fields:

- `tasks.progress_percent`: latest display progress for the task.
- `tasks.current_step`: short current action.
- `tasks.status_message`: human-readable status line.
- `task_attempts.progress_percent`: attempt-local progress.
- `task_attempts.current_step`: attempt-local current action.
- `task_attempts.status_message`: attempt-local message.

Rules:

- Progress values must stay between 0 and 100.
- During a single attempt, progress should not decrease. If work needs to restart, create a new attempt or move through `retrying`.
- Task progress mirrors the latest active or latest completed attempt.
- A task in `queued` should usually display 0 to 5.
- A task in `running` should usually display 5 to 90.
- A task in `awaiting_review` should usually display 90 to 99.
- A task in `succeeded` displays 100.
- A task in `failed` or `cancelled` keeps the last meaningful progress but must show terminal status text.
- Progress updates should enqueue Feishu sync through the outbox when the visible stage or message changes meaningfully.

## 9. `waiting_review` Review Wait Rules

V2 canonical task status is `awaiting_review`. The display layer may show it as `waiting_review` for Feishu users if that wording is clearer.

Entry conditions:

- Worker/Codex attempt succeeded but the task requires human validation.
- A Git commit, PR, preview URL, or validation report exists and needs owner review.
- A policy gate requires approval before marking the task done.

Rules:

- Entering `awaiting_review` should create or link a `human_decisions` row with `decision_type = review`.
- The latest successful attempt remains `succeeded`; the task remains `awaiting_review` until the review decision is resolved.
- Reviewer approval moves the task to `succeeded` unless deployment or additional gates remain.
- Reviewer rejection moves the task to `retrying`, `queued`, `awaiting_human`, or `failed` based on the rejection reason and attempt budget.
- Review expiry moves the task to `awaiting_human` or keeps it in `awaiting_review` with an expired decision marker, depending on owner policy.
- Feishu display can label this state as `waiting_review`, but internal storage should use `awaiting_review` for consistency with Phase 1A.

## 10. `failed` / `succeeded` / `cancelled` / `retrying` Rules

`succeeded`:

- Task success means all required work and gates are complete.
- Set `completed_at`, `result_summary`, and final `result_payload`.
- No active attempt may remain non-terminal.
- Enqueue final Feishu sync and emit `task.succeeded`.

`failed`:

- Task failure means execution will not continue automatically.
- Reasons include attempt budget exhausted, validation failure requiring owner decision, unrecoverable Worker error, or explicit human rejection.
- Set `completed_at`, `last_error_text`, and failure category where available.
- Enqueue Feishu sync with an actionable error summary.

`cancelled`:

- Cancellation is intentional and should identify the actor and reason.
- Active attempts must become `cancelled` or `superseded`.
- Cancelled tasks should not retry automatically.
- Optional subtasks may be cancelled without failing the parent if the parent policy allows it.

`retrying`:

- `retrying` is non-terminal and should be short-lived.
- It can follow `failed`, `timed_out`, `heartbeat_stale`, or rejected review when attempt budget remains.
- Retry policy must decide whether to reuse context, create a new attempt, ask for human input, or stop.
- After preparing retry, the task moves to `queued` for a new Worker claim.
- If attempt budget is exhausted, `retrying` must resolve to `failed` or `awaiting_human`.

## 11. State Transition Table

Task-level transitions:

| From | To | Trigger | Notes |
| --- | --- | --- | --- |
| `draft` | `queued` | Task approved or decomposed into runnable work. | Requires enough prompt and acceptance criteria. |
| `draft` | `cancelled` | Intake rejected or duplicate removed. | Terminal. |
| `queued` | `running` | Worker claim succeeds. | Creates attempt. |
| `queued` | `cancelled` | Owner cancels before execution. | Terminal. |
| `running` | `awaiting_review` | Attempt succeeds and review is required. | Latest attempt is `succeeded`. |
| `running` | `succeeded` | Attempt succeeds and no review gate remains. | Terminal. |
| `running` | `retrying` | Attempt fails or times out but retry budget remains. | Creates retry plan. |
| `running` | `failed` | Attempt fails and no retry is allowed. | Terminal. |
| `running` | `cancelled` | Owner or system cancels active work. | Active attempt is cancelled. |
| `running` | `awaiting_human` | Codex/Worker needs clarification or policy approval. | Requires decision row. |
| `awaiting_human` | `queued` | Human answer makes task runnable. | Usually creates or resumes attempt later. |
| `awaiting_human` | `cancelled` | Human cancels or rejects task. | Terminal. |
| `awaiting_human` | `failed` | Human marks task impossible or invalid. | Terminal. |
| `awaiting_review` | `succeeded` | Review approved and all gates passed. | Terminal. |
| `awaiting_review` | `retrying` | Review rejected with retry allowed. | New attempt needed. |
| `awaiting_review` | `awaiting_human` | Reviewer requests clarification. | Requires decision row. |
| `awaiting_review` | `cancelled` | Owner cancels during review. | Terminal. |
| `retrying` | `queued` | Retry prepared. | Await Worker claim. |
| `retrying` | `awaiting_human` | Retry needs owner decision. | Requires decision row. |
| `retrying` | `failed` | Retry budget exhausted or retry setup fails. | Terminal. |
| `retrying` | `cancelled` | Owner cancels retry. | Terminal. |

Attempt-level transitions:

| From | To | Trigger |
| --- | --- | --- |
| `claimed` | `running` | Worker starts execution. |
| `claimed` | `cancelled` | Cancel before execution starts. |
| `claimed` | `timed_out` | Claim never starts before lease expiry. |
| `running` | `succeeded` | Codex/Worker result accepted. |
| `running` | `failed` | Codex/Worker exits with failure or validation fails. |
| `running` | `heartbeat_stale` | Heartbeat is stale but within recovery window. |
| `running` | `timed_out` | Lease or runtime expires. |
| `running` | `cancelled` | Owner/system cancels active attempt. |
| `heartbeat_stale` | `running` | Same Worker heartbeats again with valid token. |
| `heartbeat_stale` | `timed_out` | Recovery window expires. |
| `heartbeat_stale` | `superseded` | New attempt replaces stale one. |

## 12. V1 Status to V2 Status Mapping

The V2 migration and compatibility layer should normalize known V1 statuses without changing production behavior until an approved implementation phase.

| V1 status | V2 task status | V2 attempt hint | Notes |
| --- | --- | --- | --- |
| `pending` | `queued` | none | V2 uses `queued` as the only runnable queue state. |
| `queued` | `queued` | none | Direct mapping. |
| `running` | `running` | `running` or `heartbeat_stale` | Active V1 claim fields should seed an attempt if available. |
| `awaiting_review` | `awaiting_review` | `succeeded` if result exists | Direct semantic mapping. |
| `waiting_review` | `awaiting_review` | `succeeded` if result exists | Treat as display alias only. |
| `completed` | `succeeded` | `succeeded` | V2 uses `succeeded` consistently. |
| `succeeded` | `succeeded` | `succeeded` | Direct mapping. |
| `failed` | `failed` | `failed` | Direct mapping. |
| `cancelled` | `cancelled` | `cancelled` | Direct mapping if present in V1 data. |
| `retrying` | `retrying` | `failed` or `timed_out` | Preserve if runtime already emits it. |
| blank or unknown | `draft` | none | Safer than making an ambiguous row runnable. |

Mapping rules:

- Preserve `hermes_jobs.id` and external `job_id` through legacy fields defined in Phase 1A.
- Preserve old status text in metadata when it does not map confidently.
- Do not infer `succeeded` from a commit SHA alone. A result still needs validation or review policy.
- Do not infer `failed` from stale heartbeat alone until timeout policy has resolved the attempt.

## 13. Feishu Display Copy and Icon Suggestions

Feishu should show user-friendly wording while storing canonical V2 state internally.

| Internal status | Feishu text | Icon suggestion | Display tone |
| --- | --- | --- | --- |
| `draft` | `待补充` | `Edit3` | Task needs more information. |
| `queued` | `排队中` | `Clock3` | Waiting for Worker claim. |
| `running` | `执行中` | `LoaderCircle` | Worker/Codex is active. |
| `awaiting_human` | `等待确认` | `CircleHelp` | Owner or requester needs to answer. |
| `awaiting_review` | `等待审核` | `ClipboardCheck` | Result is ready for review. |
| `retrying` | `准备重试` | `RefreshCw` | System is scheduling another attempt. |
| `succeeded` | `已完成` | `CircleCheck` | Work is done. |
| `failed` | `失败` | `CircleX` | Work stopped with error. |
| `cancelled` | `已取消` | `Ban` | Work was intentionally stopped. |

Display rules:

- Feishu messages should include task title, visible status, current step, progress percent, and the latest actionable note.
- For `awaiting_human`, the message should include the question and available decision options.
- For `awaiting_review`, the message should include PR, commit, preview, or validation references when available.
- For `failed`, the message should include a short failure summary and whether retry is possible.
- For `retrying`, the message should show attempt number and next action instead of presenting it as final failure.
- For `succeeded`, the message should show the result summary and relevant links.
- Icons are suggestions for UI systems that use `lucide-react`; Feishu native messages can map them to emoji or text labels if icon rendering is unavailable.

## Explicit Non-Goals for Phase 1B

This phase does not:

- Run or define database migrations.
- Modify business code.
- Modify Worker code.
- Modify API routes.
- Modify `.gitignore`.
- Change production data.
- Change Supabase RLS policies.
- Change Feishu table schemas.
- Commit, push, or open a pull request from Codex.
