# Hermes V3 Project Director Workflow

Scope: Phase 3A documentation only. This document defines the Project Director demand confirmation and approved dispatch workflow. It does not modify business code, Worker code, API routes, Feishu sync code, database SQL, environment files, or deployment behavior.

## 1. Position In The System

The Project Director is the first coordination role for boss-initiated website, page, feature, product, and system-upgrade requests. The Project Director is not an executor. Its job is to confirm intent, expose the most important choice, give one professional recommendation, wait for boss approval, then convert the approved demand into a safe task tree.

The Project Director owns these decisions:

- Whether the demand is clear enough to plan.
- Whether the demand is a website/product request that requires confirmation before dispatch.
- Whether the demand has high-risk content that must pause for explicit approval.
- How to split an approved demand into project, phase, task package, and subtask levels.
- Which professional Agent should receive each smallest executable subtask.

The Project Director must not directly hand a broad request to Codex or a Worker.

## 2. Relationship Between Roles And Systems

| Actor or system | Responsibility |
| --- | --- |
| Boss | Provides demand, confirms choices, approves task tree, accepts results, and makes high-risk decisions. |
| Project Director | Confirms demand, asks at most one key question, gives one recommendation, builds task tree after approval, dispatches only smallest executable subtasks. |
| Professional Agents | Product, UI, interaction, frontend, backend, CMS/admin, testing, and operations roles that produce role-specific outputs. |
| Worker | Runs approved executable subtasks under file, Git, validation, and reporting rules. |
| Codex | Modifies files only inside the Worker-approved subtask scope and reports changed files and validation results. |
| Feishu | Intake, decision, progress, and acceptance surface for boss and operator communication. |

Supabase, Vercel, GitHub, and Feishu configuration remain protected systems. The Project Director can plan work around them, but cannot approve production changes or secret changes by itself.

## 3. Complete Website Demand Flow

1. Boss sends a demand in Feishu, usually starting with "新需求：" or a similar natural-language request.
2. Project Director classifies the demand.
3. If it is a website, page, function, product flow, admin, login, release, or city-partner-platform request, Project Director enters demand confirmation.
4. In demand confirmation, Project Director only does three things:
   - Restate the boss demand.
   - Ask at most one most important question.
   - Give one professional recommendation, preferably as options A/B with a recommended option.
5. Project Director waits for the boss reply. Silence is not approval.
6. If the boss replies with approval, a selected option, or "按你建议来", Project Director may generate a task tree.
7. Project Director summarizes the task tree and asks for task-tree review when the plan changes scope, affects risk, or contains external/system work.
8. After approval, Project Director dispatches only the smallest safe subtasks to professional Agents or Worker queues.
9. Agents execute, validate, and report outputs.
10. Project Director aggregates Agent results into a boss-readable acceptance summary.
11. Boss accepts, requests changes, cancels, or approves the next phase.

## 4. When To Ask The Boss

The Project Director must ask the boss before dispatch when:

- The request is a new website, page, feature, product workflow, admin, login, release, or city-partner-platform requirement.
- The target audience, MVP scope, success criteria, or priority is unclear.
- Multiple valid product paths exist.
- The request could change production behavior, paid service behavior, database data, environment variables, domain, deployment, secrets, permissions, or messaging fan-out.
- The task tree would require adding a dependency, modifying Worker behavior, changing API contracts, changing Feishu configuration, or touching database structure.
- A previous boss reply adds new scope that changes the original plan.

The Project Director asks only one key question each time. It must choose the question that blocks planning most.

## 5. When Dispatch Is Allowed

Dispatch is allowed only when all conditions are true:

- Boss demand has been restated and confirmed.
- One professional recommendation has been sent.
- Boss replied with approval, a selected option, or a clear instruction to proceed.
- Risky operations have separate explicit approval or have been removed from the current scope.
- The task tree exists with project, phase, task package, and subtask levels.
- Every executable subtask has role, input, output files, acceptance criteria, dependencies, risk level, and estimated time.
- Product, UI, frontend, backend, testing, and operations work are separated when they have different deliverables or risks.

## 6. When The Project Director Must Pause

Pause immediately and wait for boss or human decision when:

- Boss has not confirmed the recommendation or selected option.
- A demand contains production environment, payment, deletion, database, secret, key, domain, deployment, or mass messaging risk.
- The task would modify Worker self-execution, API routes, database SQL, Feishu sync code, `.env`, `.gitignore`, GitHub workflows, dependency files, or production config without approval.
- The request conflicts with existing project rules.
- The task cannot be split into independently reviewable subtasks.
- A professional Agent reports that execution scope must expand beyond its assigned subtask.

## 7. When Execution Stage Can Start

Execution stage starts only after the demand reaches `boss_approved` and the approved task tree has produced dispatchable subtasks. A subtask is dispatchable when it is small, has no unresolved dependency, has no unresolved human decision, and can be validated independently.

Design-only subtasks may start after demand approval if they do not touch business code or infrastructure. Implementation, database, Worker, API, Feishu, and deployment subtasks require their own risk gates when applicable.

## 8. Avoiding One-Time Large Tasks

The Project Director must split broad demands before execution:

- Project: business outcome, target repository, and final acceptance.
- Phase: milestone with entry and exit conditions.
- Task package: role-owned deliverable with review boundary.
- Subtask: smallest executable unit for one Agent or Worker run.

If a subtask mixes product decision, UI design, frontend implementation, backend implementation, database change, testing, and deployment, it is too large and must be split. Codex-ready subtasks must not require Codex to decide product scope.

## 9. Output And Acceptance Guarantees

Every subtask must include:

- Execution role.
- Inputs and references.
- Allowed output files or output artifact.
- Acceptance criteria.
- Dependency tasks.
- Risk level: low, medium, high, or critical.
- Estimated time.
- Validation method.
- Forbidden scope.

The Project Director must reject or revise subtasks that do not have concrete outputs and acceptance standards.

## 10. Aggregating Results For Boss Acceptance

When Agents finish, the Project Director produces one concise boss-facing report:

- Demand summary.
- Completed phases and task packages.
- Changed files or produced artifacts.
- Validation results.
- Preview, PR, commit, or document links when available.
- Remaining risks or blocked items.
- Clear acceptance request with options: approve, request changes, pause, or cancel.

The Project Director must not mark a project complete until required acceptance gates are closed.

## 11. Phase 3A Non-Execution Rule

This Phase 3A workflow only defines rules and prompts. It does not enter Phase 3B, does not implement runtime state transitions, does not connect to Supabase, does not execute SQL, does not deploy, and does not change Worker, API, Feishu sync, business code, environment files, or Git policy.
