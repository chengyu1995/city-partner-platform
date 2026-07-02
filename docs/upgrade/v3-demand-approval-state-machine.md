# Hermes V3 Demand Approval State Machine

Scope: Phase 3A documentation only. This state machine governs demand intake, approval, task-tree generation, dispatch, execution visibility, acceptance, completion, blocking, and cancellation. It does not implement runtime code.

## State Summary

| State | Meaning |
| --- | --- |
| `demand_received` | Demand has been received from boss or intake channel. |
| `needs_clarification` | Demand needs confirmation before planning or execution. |
| `suggestion_sent` | Project Director has sent one key question and one recommendation. |
| `waiting_boss_reply` | System is waiting for boss reply; no dispatch allowed. |
| `boss_approved` | Boss has approved, selected an option, or accepted the recommendation. |
| `task_tree_generating` | Project Director is generating project, phase, task package, and subtask tree. |
| `waiting_task_tree_review` | Task tree is waiting for boss or human review before dispatch. |
| `dispatching` | Approved smallest subtasks are being assigned to roles or Worker queues. |
| `in_progress` | Dispatched subtasks are executing. |
| `waiting_acceptance` | Results are ready for boss acceptance or review. |
| `completed` | Demand is accepted and closed. |
| `blocked` | Demand cannot proceed without decision, evidence, or risk approval. |
| `cancelled` | Demand has been intentionally stopped. |

## 1. `demand_received`

Entry conditions:

- Boss sends a new demand.
- Follow-up message clearly creates new scope.
- Existing demand is reopened.

Exit conditions:

- Move to `needs_clarification` for website/product/broad/risky demands.
- Move to `boss_approved` only for narrow direct tasks with explicit approval and no product choice.
- Move to `blocked` if the demand contains forbidden or high-risk action without approval.
- Move to `cancelled` if boss cancels immediately.

Allowed actions:

- Preserve original demand text.
- Classify demand type.
- Identify risk and likely role boundaries.

Forbidden actions:

- Dispatch to Codex or Worker.
- Generate executable subtasks for broad demands.
- Infer product choices.

## 2. `needs_clarification`

Entry conditions:

- Demand is website/product/system-broad.
- MVP scope, target user, success criteria, or risk is unclear.
- Multiple valid options exist.

Exit conditions:

- Move to `suggestion_sent` after restating demand, asking one key question, and giving one recommendation.
- Move to `blocked` if the demand contains critical risk requiring explicit approval.
- Move to `cancelled` if boss cancels.

Allowed actions:

- Restate demand.
- Ask one key question.
- Prepare one professional recommendation.

Forbidden actions:

- Ask multiple unrelated questions.
- Dispatch tasks.
- Start implementation.

## 3. `suggestion_sent`

Entry conditions:

- Project Director has sent demand summary, one key question, and one recommendation.

Exit conditions:

- Move to `waiting_boss_reply` immediately after sending.
- Move to `blocked` if the suggestion exposes an unresolved high-risk gate.

Allowed actions:

- Send Feishu confirmation message.
- Record recommended option.

Forbidden actions:

- Treat suggestion as approval.
- Dispatch tasks.

## 4. `waiting_boss_reply`

Entry conditions:

- Confirmation or approval request has been sent.

Exit conditions:

- Move to `boss_approved` when boss replies with approval or option selection.
- Move to `needs_clarification` when boss adds new scope that still needs one more key confirmation.
- Move to `blocked` when boss reply introduces high or critical risk.
- Move to `cancelled` when boss rejects or cancels.

Allowed actions:

- Wait.
- Send concise reminder when appropriate.
- Update demand summary from boss reply.

Forbidden actions:

- Infer approval from silence.
- Create executable tasks.
- Dispatch to Agents or Worker.

## 5. `boss_approved`

Entry conditions:

- Boss replies "批准", "可以", "开始", "按你建议来", "选 A", "选 B", or equivalent.

Exit conditions:

- Move to `task_tree_generating`.
- Move to `blocked` if approval is partial and a critical risk remains.
- Move to `cancelled` if boss cancels before planning.

Allowed actions:

- Lock approved scope for planning.
- Identify phases, task packages, subtasks, dependencies, and role split.

Forbidden actions:

- Expand scope beyond approved demand.
- Dispatch before task tree exists.

## 6. `task_tree_generating`

Entry conditions:

- Approved demand is ready for planning.

Exit conditions:

- Move to `waiting_task_tree_review` when task tree needs boss review.
- Move to `dispatching` only when the tree is low-risk, fully within approved scope, and contains dispatchable smallest subtasks.
- Move to `blocked` if task tree reveals unresolved risk or unclear scope.

Allowed actions:

- Create project, phase, task package, and subtask structure.
- Add role, input, output files, acceptance criteria, dependencies, risk level, estimated time, validation, and forbidden scope.
- Mark serial and parallel tasks.

Forbidden actions:

- Create one giant task.
- Assign product, UI, frontend, backend, testing, and operations work to the same executable subtask when separable.

## 7. `waiting_task_tree_review`

Entry conditions:

- Task tree includes meaningful scope, sequence, risk, schedule, or human approval decisions.

Exit conditions:

- Move to `dispatching` after approval.
- Move to `task_tree_generating` when boss requests changes.
- Move to `blocked` when review finds high-risk unresolved items.
- Move to `cancelled` when boss cancels.

Allowed actions:

- Present task tree summary.
- Ask boss to approve task tree or choose a plan.

Forbidden actions:

- Dispatch unapproved high-risk tasks.
- Hide blocked tasks.

## 8. `dispatching`

Entry conditions:

- Task tree is approved or low-risk and already within approved scope.
- Dispatchable subtasks have no unresolved blockers.

Exit conditions:

- Move to `in_progress` when subtasks are claimed or assigned.
- Move to `blocked` if dispatch detects conflict, missing required fields, or risk.

Allowed actions:

- Assign smallest subtasks by role.
- Keep dependencies and serial/parallel constraints.
- Queue only Codex-ready subtasks.

Forbidden actions:

- Dispatch parent project or phase as one executable job.
- Dispatch a task missing output or acceptance criteria.

## 9. `in_progress`

Entry conditions:

- One or more subtasks are executing.

Exit conditions:

- Move to `waiting_acceptance` when required subtasks complete and need boss review.
- Move to `blocked` when execution hits risk, validation failure requiring decision, or dependency block.
- Move to `completed` only if no acceptance gate is required and all required tasks are done.
- Move to `cancelled` if boss cancels.

Allowed actions:

- Track Agent outputs and validation.
- Report progress.
- Request decisions for blockers.

Forbidden actions:

- Mark complete without required review.
- Let a subtask expand beyond its approved scope.

## 10. `waiting_acceptance`

Entry conditions:

- Required deliverables are ready for boss acceptance.

Exit conditions:

- Move to `completed` after boss accepts.
- Move to `task_tree_generating` or `dispatching` when boss requests changes.
- Move to `blocked` if acceptance depends on missing evidence or risk approval.
- Move to `cancelled` if boss rejects and stops work.

Allowed actions:

- Send acceptance summary.
- Provide validation results and links.

Forbidden actions:

- Treat preview readiness or commit existence as final acceptance.

## 11. `completed`

Entry conditions:

- Boss accepted the result or all required gates are closed.

Exit conditions:

- Reopen only through a new demand or explicit boss instruction.

Allowed actions:

- Record final summary.
- Recommend next phase only as a suggestion.

Forbidden actions:

- Continue into Phase 3B without boss approval.
- Start follow-up work automatically.

## 12. `blocked`

Entry conditions:

- Missing boss decision.
- High or critical risk.
- Scope conflict.
- Validation failure requiring human choice.
- Missing evidence.
- Forbidden action requested.

Exit conditions:

- Move to prior planning or execution state after decision resolves the blocker.
- Move to `cancelled` if boss rejects or cancels.

Allowed actions:

- Ask one focused decision question.
- Explain blocker, risk, options, recommendation, and safe default.

Forbidden actions:

- Execute blocked work.
- Treat expired or silent decision as approval.

## 13. `cancelled`

Entry conditions:

- Boss cancels.
- Demand is rejected.
- Safe policy requires stopping permanently.

Exit conditions:

- Reopen only through explicit new boss demand.

Allowed actions:

- Record cancellation reason.
- Summarize any completed safe outputs.

Forbidden actions:

- Dispatch or continue subtasks.

## Transition Principles

- Broad website/product demands must pass through `needs_clarification`, `suggestion_sent`, and `waiting_boss_reply` before task breakdown.
- Only `boss_approved`, approved `waiting_task_tree_review`, or low-risk direct tasks can lead to `dispatching`.
- `blocked` can be entered from any non-terminal state.
- `completed` and `cancelled` are terminal unless boss explicitly reopens.
