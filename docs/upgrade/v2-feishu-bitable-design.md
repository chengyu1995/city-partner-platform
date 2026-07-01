# Hermes V2 Feishu Bitable Design

Scope: Phase 1D design document only.

This document designs Feishu Bitable fields, views, and synchronization behavior for Hermes V2. It depends on Phase 1A data model design, Phase 1B task state machine design, and Phase 1C task breakdown rules.

This phase only produces documentation. It does not execute SQL, does not create migration files, does not modify business code, does not modify Worker code, does not modify API routes, and does not modify `.gitignore`.

## 1. Current Feishu Bitable Sync Problems

V1 Feishu sync is useful for visibility, but it is not reliable enough to become the task source of truth.

- One V1 `hermes_jobs` row mixes request intake, Worker execution, progress, result, Feishu locator fields, and retry data. Feishu rows inherit that ambiguity.
- Status words drift between `pending`, `queued`, `running`, `awaiting_review`, `completed`, and `succeeded`, so operators cannot always tell whether a row is runnable, active, blocked, or done.
- Bitable updates are best effort. If a Feishu API call fails, the failure can be lost and the visible row can remain stale.
- Progress, current step, commit SHA, preview URL, deployment status, and human review state are not separated into stable display areas.
- A single flat task row cannot show V2 project, phase, task package, subtask, checkpoint, attempt, decision, and deployment relationships clearly.
- Feishu `record_id` values are external locators, but V1 does not define one binding rule per canonical Supabase record.
- Manual edits in Feishu can accidentally look like canonical state changes when they should be treated as operator input or decision replies.
- Worker heartbeat and stale attempts are not visible as first-class operational signals.

Phase 1D fixes this at the design level by making Supabase the canonical system and Feishu Bitable the operator-facing cockpit.

## 2. Source-Of-Truth Principle

Supabase is the primary database. Feishu Bitable is a display, triage, and lightweight operation surface.

Principles:

- Canonical state lives in Supabase V2 tables: `projects`, `tasks`, `task_attempts`, `agents`, `human_decisions`, `deployments`, and `feishu_sync_outbox`.
- Feishu rows mirror selected canonical fields and expose safe manual-input fields.
- Feishu manual edits must not directly overwrite canonical state unless a later approved Worker/API phase explicitly consumes those edits.
- Feishu status fields are display copies. Internal status values remain the Phase 1B canonical values.
- Feishu sync failures must not block task execution, Worker heartbeats, Git operations, or deployment callbacks.
- Feishu should show enough context for the boss or operator to decide, approve, reject, or ask a follow-up question without exposing secrets, claim tokens, raw large logs, or sensitive prompts.
- Feishu should favor separate tables for different operating questions instead of one overloaded table.

Recommended Bitable tables:

| Bitable table | Canonical source | Purpose |
| --- | --- | --- |
| Project Overview | `projects`, rollups from `tasks` and `deployments` | Portfolio and milestone cockpit. |
| Task Details | `tasks`, latest `task_attempts`, related decisions | Tree-friendly execution board. |
| Agent Status | `agents`, latest active `task_attempts` | Worker and actor health. |
| Issues And Decisions | `human_decisions`, blocked `tasks` | Human gates, questions, approvals, rejections. |
| Deployments And Releases | `deployments`, related tasks and attempts | Commit, preview, deployment, and release status. |

## 3. Project Overview Table Field Design

Purpose: one row per Hermes V2 project or major initiative. It gives the boss a high-level view of project status, progress, blockers, and latest delivery links.

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Project ID | Text | `projects.id` | Yes | No | Hidden or narrow technical identifier. |
| Project Key | Text | `projects.key` | Yes | No | Stable display key such as `city-partner-platform`. |
| Project Name | Text | `projects.name` | Yes | No | Human-readable project title. |
| Business Outcome | Long text | `projects.description` or metadata outcome | Yes | No | Owner-visible goal summary. |
| Repository | URL or text | `projects.repository_url` / `repository_full_name` | Yes | No | Links to GitHub repository when available. |
| Default Branch | Text | `projects.default_base_branch` | Yes | No | Display only, not editable from Feishu. |
| Project Status | Single select | `projects.status` | Yes | No | `active`, `paused`, or `archived`. |
| Display Stage | Single select | Rollup from child tasks | Yes | No | Planning, executing, review, blocked, done. |
| Progress | Percent | Weighted rollup from phases/tasks | Yes | No | Follows Phase 1C progress rollup. |
| Total Tasks | Number | Count of child tasks | Yes | No | Includes task packages and executable subtasks. |
| Done Tasks | Number | Count of `succeeded` required child tasks | Yes | No | Used for progress explanation. |
| Running Tasks | Number | Count of `running` child tasks | Yes | No | Operational signal. |
| Blocked Tasks | Number | Count of `awaiting_human`, terminal blocking failures, or unresolved decisions | Yes | No | Drives blocked views. |
| Awaiting Review | Number | Count of `awaiting_review` child tasks | Yes | No | Shows review workload. |
| Latest Summary | Long text | Latest `tasks.result_summary` or project event summary | Yes | No | Short current project note. |
| Current Blocker | Long text | Highest-priority child `blocked_reason` or decision question | Yes | No | Empty when not blocked. |
| Latest Preview URL | URL | Latest related `deployments.deployment_url` | Yes | No | Preview or staging link. |
| Latest Commit | Text | Latest related `deployments.git_commit_sha` or attempt result SHA | Yes | No | Short SHA in display copy. |
| Owner Note | Long text | Feishu-only operator note | No | Yes | Does not change canonical status. |
| Priority Override Request | Single select | Feishu-only requested priority | No | Yes | Consumed only by a later approved workflow. |
| Created At | Date time | `projects.created_at` | Yes | No | Audit display. |
| Updated At | Date time | `projects.updated_at` | Yes | No | Last canonical update. |
| Supabase Link | Text or URL | Admin/app deep link built from `projects.id` | Yes | No | Optional internal locator. |
| Feishu Record ID | Text | Stored binding for this Bitable row | Yes | No | See binding rules in chapter 16. |

Recommended views:

| View | Type | Filter/grouping | Purpose |
| --- | --- | --- | --- |
| Active Projects | Table | `Project Status = active` | Default boss dashboard. |
| Project Kanban | Kanban | Group by `Display Stage` | See planning, executing, blocked, review, done. |
| Project Timeline | Gantt | Created or planned milestone dates if later added | Shows phase-level schedule when dates exist. |
| Blocked Projects | Filtered table | `Blocked Tasks > 0` | Escalation queue. |
| Review Queue | Filtered table | `Awaiting Review > 0` | Owner validation workload. |

## 4. Task Details Table Field Design

Purpose: one row per V2 task-tree node that should be visible in Feishu. It can display project, phase, task package, subtask, and checkpoint-like rows, while executable work still maps to canonical `tasks` and attempts in Supabase.

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Task ID | Text | `tasks.id` | Yes | No | Canonical task identifier. |
| Project ID | Text | `tasks.project_id` | Yes | No | Used for linking and filtering. |
| Project Key | Text | `projects.key` | Yes | No | Display-friendly project grouping. |
| Parent Task ID | Text | `tasks.parent_task_id` | Yes | No | Enables tree grouping. |
| Parent Title | Linked record or text | Parent `tasks.title` | Yes | No | Feishu link if table relation is configured. |
| Node Level | Single select | `tasks.task_type` plus tree metadata | Yes | No | Project, phase, task, subtask, checkpoint. |
| Sort Order | Number | `tasks.metadata.sort_order` | Yes | No | Stable display order inside parent. |
| Title | Text | `tasks.title` | Yes | No | Main row label. |
| Description | Long text | `tasks.description` | Yes | No | Condensed for display. |
| Acceptance Criteria | Long text | `tasks.acceptance_criteria` | Yes | No | Review basis. |
| Allowed Scope | Long text | `tasks.metadata.allowed_scope` | Yes | No | Paths or boundaries from breakdown rules. |
| Forbidden Scope | Long text | `tasks.metadata.forbidden_scope` | Yes | No | High-risk files or operations. |
| Source | Single select | `tasks.source` | Yes | No | Feishu, manual, API, system. |
| Source Message | URL or text | `tasks.feishu_message_id` / metadata link | Yes | No | Traceability to request. |
| Priority | Number | `tasks.priority` | Yes | No | Canonical priority. |
| Priority Request | Single select | Feishu-only operator input | No | Yes | A later approved workflow may consume this. |
| Task Status | Single select | `tasks.status` | Yes | No | Phase 1B canonical status. |
| Display Status | Single select | Derived display copy | Yes | No | User-friendly wording for Feishu. |
| Stage | Single select | `tasks.stage` | Yes | No | Queued, coding, review, deploying, done. |
| Progress | Percent | `tasks.progress_percent` | Yes | No | Latest mirrored task progress. |
| Current Step | Text | `tasks.current_step` | Yes | No | Short action line. |
| Status Message | Long text | `tasks.status_message` | Yes | No | Latest human-readable status. |
| Requires Human | Checkbox | `tasks.requires_human_decision` | Yes | No | Drives decision views. |
| Blocking Reason | Long text | `tasks.blocked_reason` / unresolved decision | Yes | No | Visible if blocked. |
| Dependency Summary | Long text | `tasks.metadata.dependencies` | Yes | No | Human-readable dependency list. |
| Attempt Count | Number | `tasks.attempt_count` | Yes | No | Retry visibility. |
| Max Attempts | Number | `tasks.max_attempts` | Yes | No | Policy visibility. |
| Latest Attempt ID | Text | `tasks.last_attempt_id` | Yes | No | Link to execution record if needed. |
| Worker | Text | Latest `task_attempts.worker_name` / `agents.name` | Yes | No | Current or latest actor. |
| Heartbeat At | Date time | Latest `task_attempts.heartbeat_at` | Yes | No | Empty when not running. |
| Heartbeat Status | Single select | Derived from heartbeat freshness | Yes | No | Healthy, stale, expired, inactive. |
| Branch | Text | `task_attempts.branch_name` or `tasks.target_branch` | Yes | No | Worker branch/ref. |
| Commit SHA | Text | Latest `task_attempts.result_git_sha` | Yes | No | Short or full SHA. |
| PR URL | URL | `tasks.result_payload.pr_url` or metadata | Yes | No | Optional GitHub link. |
| Preview URL | URL | Latest related `deployments.deployment_url` | Yes | No | Preview when available. |
| Deployment Status | Single select | Latest related `deployments.status` | Yes | No | Pending, building, ready, failed. |
| Latest Result | Long text | `tasks.result_summary` | Yes | No | Completion or review summary. |
| Last Error | Long text | `tasks.last_error_text` | Yes | No | Short failure summary. |
| Decision Reply | Long text | Feishu-only operator reply | No | Yes | Human answer draft/input, not direct canonical status. |
| Decision Action | Single select | Feishu-only operator action | No | Yes | Approve, reject, clarify, cancel request. |
| Operator Note | Long text | Feishu-only note | No | Yes | Local note for team coordination. |
| Queued At | Date time | `tasks.queued_at` | Yes | No | Queue age. |
| Started At | Date time | `tasks.started_at` | Yes | No | Execution start. |
| Completed At | Date time | `tasks.completed_at` | Yes | No | Terminal time. |
| Updated At | Date time | `tasks.updated_at` | Yes | No | Last canonical update. |
| Feishu Record ID | Text | Stored binding for this Bitable row | Yes | No | See chapter 16. |

Recommended views:

| View | Type | Filter/grouping | Purpose |
| --- | --- | --- | --- |
| Task Tree | Table | Group by `Project Key`, `Parent Title`, sort by `Sort Order` | Tree-like full task structure. |
| Execution Kanban | Kanban | Group by `Display Status` | Operational board for queued, running, blocked, review, done. |
| Current Sprint | Filtered table | Active project and non-terminal statuses | Daily execution view. |
| Task Timeline | Gantt | `Queued At`, `Started At`, `Completed At` | Rough flow timing, not canonical scheduling. |
| Blocked Tasks | Filtered table | `Requires Human` or `Blocking Reason` not empty | Escalation queue. |
| Review Ready | Filtered table | `Task Status = awaiting_review` | Results needing validation. |
| Stale Heartbeat | Filtered table | `Heartbeat Status` in stale or expired | Worker recovery queue. |

## 5. Agent Status Table Field Design

Purpose: show Worker, Codex, Hermes, human, GitHub Action, and system actors with their latest activity and health.

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Agent ID | Text | `agents.id` | Yes | No | Canonical actor ID. |
| Project ID | Text | `agents.project_id` | Yes | No | Optional project scope. |
| Agent Name | Text | `agents.name` | Yes | No | Display name. |
| Agent Type | Single select | `agents.agent_type` | Yes | No | Worker, Codex, Hermes, human, GitHub Action, system. |
| External ID | Text | `agents.external_id` | Yes | No | Worker name, Feishu user, GitHub login, or system identifier. |
| Agent Status | Single select | `agents.status` | Yes | No | Active, disabled, offline. |
| Last Seen At | Date time | `agents.last_seen_at` | Yes | No | Latest actor activity. |
| Latest Attempt ID | Text | Latest non-terminal or latest `task_attempts.id` | Yes | No | Execution context. |
| Current Task | Linked record or text | Latest `task_attempts.task_id` / task title | Yes | No | Current assignment. |
| Attempt Status | Single select | Latest `task_attempts.status` | Yes | No | Attempt-local state. |
| Heartbeat At | Date time | Latest `task_attempts.heartbeat_at` | Yes | No | Worker heartbeat signal. |
| Lease Expires At | Date time | Latest `task_attempts.lease_expires_at` | Yes | No | Claim expiry display. |
| Heartbeat Health | Single select | Derived from heartbeat and lease | Yes | No | Healthy, stale, expired, idle. |
| Current Step | Text | Latest `task_attempts.current_step` | Yes | No | What the agent is doing. |
| Progress | Percent | Latest `task_attempts.progress_percent` | Yes | No | Attempt-local progress. |
| Failure Category | Single select | Latest `task_attempts.failure_category` | Yes | No | Codex, git, validation, timeout, worker, API, unknown. |
| Last Error | Long text | Latest `task_attempts.error_text` | Yes | No | Short operator-facing error. |
| Capabilities | Long text | `agents.capabilities` summarized | Yes | No | Display only; not secret. |
| Operator Note | Long text | Feishu-only note | No | Yes | Human note, does not disable agent. |
| Disable Request | Checkbox | Feishu-only request | No | Yes | A later approved workflow may consume it. |
| Updated At | Date time | `agents.updated_at` | Yes | No | Last canonical update. |
| Feishu Record ID | Text | Stored binding for this Bitable row | Yes | No | See chapter 16. |

Recommended views:

| View | Type | Filter/grouping | Purpose |
| --- | --- | --- | --- |
| Worker Health | Table | Agent type in Worker/Codex/Hermes | Daily operations. |
| Heartbeat Board | Kanban | Group by `Heartbeat Health` | Detect stale or expired workers. |
| Active Attempts | Filtered table | `Attempt Status` in claimed/running/heartbeat stale | See live execution. |
| Failure Queue | Filtered table | `Last Error` not empty or failure category set | Debug recent agent failures. |

## 6. Issues And Decisions Table Field Design

Purpose: one row per human decision, review gate, clarification, blocker, or owner question. This is the primary table for manual responses.

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Decision ID | Text | `human_decisions.id` | Yes | No | Canonical decision identifier. |
| Project ID | Text | `human_decisions.project_id` | Yes | No | Project context. |
| Project Key | Text | `projects.key` | Yes | No | Display grouping. |
| Task ID | Text | `human_decisions.task_id` | Yes | No | Related task. |
| Task Title | Linked record or text | `tasks.title` | Yes | No | Link to Task Details row. |
| Attempt ID | Text | `human_decisions.attempt_id` | Yes | No | Attempt-specific decision if present. |
| Decision Type | Single select | `human_decisions.decision_type` | Yes | No | Clarification, approval, rejection, review, risk acceptance, production gate. |
| Decision Status | Single select | `human_decisions.status` | Yes | No | Requested, approved, rejected, answered, cancelled, expired. |
| Severity | Single select | Derived from task/blocker metadata | Yes | No | Info, warning, blocking, urgent. |
| Question | Long text | `human_decisions.question` | Yes | No | Exact prompt to human. |
| Options | Long text | `human_decisions.options` summarized | Yes | No | Allowed choices if structured. |
| Recommended Option | Text | `human_decisions.metadata.recommended_option` | Yes | No | Optional safe default. |
| Response Text | Long text | Feishu manual input | No | Yes | Human reply text. |
| Response Choice | Single select | Feishu manual input | No | Yes | Approve, reject, answer, need more info, cancel. |
| Response Submitted | Checkbox | Feishu manual input | No | Yes | A later approved sync reader can consume this. |
| Decided By | Text | `human_decisions.decided_by_agent_id` resolved | Yes | No | Filled after canonical resolution. |
| Requested By | Text | `human_decisions.requested_by_agent_id` resolved | Yes | No | Requesting agent. |
| External Channel | Single select | `human_decisions.external_channel` | Yes | No | Feishu, GitHub, manual, API. |
| External Message | URL or text | `human_decisions.external_message_id` | Yes | No | Trace to message/comment. |
| Blocks Task Status | Single select | Related `tasks.status` | Yes | No | Shows whether decision blocks execution. |
| Blocking Reason | Long text | Related `tasks.blocked_reason` | Yes | No | Context for escalation. |
| Expires At | Date time | `human_decisions.expires_at` | Yes | No | Optional deadline. |
| Resolved At | Date time | `human_decisions.resolved_at` | Yes | No | Resolution timestamp. |
| Created At | Date time | `human_decisions.created_at` | Yes | No | Request timestamp. |
| Updated At | Date time | `human_decisions.updated_at` | Yes | No | Last canonical update. |
| Feishu Record ID | Text | Stored binding for this Bitable row | Yes | No | See chapter 16. |

Recommended views:

| View | Type | Filter/grouping | Purpose |
| --- | --- | --- | --- |
| Awaiting Boss | Table | `Decision Status = requested` | Default human action queue. |
| Decision Kanban | Kanban | Group by `Decision Status` | Track request lifecycle. |
| Blocking Issues | Filtered table | Severity in blocking/urgent and unresolved | Escalation view. |
| Review Decisions | Filtered table | `Decision Type = review` | Approve/reject completed work. |
| Expiring Soon | Filtered table | `Expires At` within operator-defined window | Prevent stale gates. |

## 7. Deployments And Releases Table Field Design

Purpose: display Git commit, branch, preview URL, provider deployment status, release gates, and rollout history separately from task execution.

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Deployment ID | Text | `deployments.id` | Yes | No | Canonical deployment identifier. |
| Project ID | Text | `deployments.project_id` | Yes | No | Project context. |
| Project Key | Text | `projects.key` | Yes | No | Display grouping. |
| Task ID | Text | `deployments.task_id` | Yes | No | Related task when present. |
| Task Title | Linked record or text | Related `tasks.title` | Yes | No | Link to work item. |
| Attempt ID | Text | `deployments.attempt_id` | Yes | No | Attempt that produced the commit. |
| Provider | Single select | `deployments.provider` | Yes | No | Vercel, GitHub, manual, other. |
| Environment | Single select | `deployments.environment` | Yes | No | Preview, staging, production, unknown. |
| Deployment Status | Single select | `deployments.status` | Yes | No | Pending, building, ready, failed, cancelled, unknown. |
| Git Commit SHA | Text | `deployments.git_commit_sha` | Yes | No | Full SHA or short display copy. |
| Git Branch | Text | `deployments.git_branch` | Yes | No | Feature or target branch. |
| Commit Message | Text | Related `task_attempts.commit_message` | Yes | No | Worker-produced message if available. |
| Deployment URL | URL | `deployments.deployment_url` | Yes | No | Preview or environment URL. |
| Provider Deployment ID | Text | `deployments.provider_deployment_id` | Yes | No | External provider locator. |
| Started At | Date time | `deployments.started_at` | Yes | No | Build start. |
| Finished At | Date time | `deployments.finished_at` | Yes | No | Build finish. |
| Last Callback At | Date time | `deployments.last_callback_at` | Yes | No | Latest provider callback. |
| Duration | Formula or number | Derived from start/finish | Yes | No | Display-only build duration. |
| Error Text | Long text | `deployments.error_text` | Yes | No | Short failure reason. |
| Release Gate | Single select | Related `human_decisions.status` or metadata | Yes | No | Required, approved, rejected, not required. |
| Release Note | Long text | `deployments.payload.release_note` or result summary | Yes | No | User-facing summary. |
| Manual Verification Note | Long text | Feishu-only note | No | Yes | Operator verification, not canonical deploy status. |
| Promote Request | Checkbox | Feishu-only request | No | Yes | Does not trigger production deploy in Phase 1D. |
| Created At | Date time | `deployments.created_at` | Yes | No | Record creation. |
| Updated At | Date time | `deployments.updated_at` | Yes | No | Last canonical update. |
| Feishu Record ID | Text | Stored binding for this Bitable row | Yes | No | See chapter 16. |

Recommended views:

| View | Type | Filter/grouping | Purpose |
| --- | --- | --- | --- |
| Latest Deployments | Table | Sort by `Updated At` descending | Most recent preview/build status. |
| Deployment Kanban | Kanban | Group by `Deployment Status` | See building, ready, failed, cancelled. |
| Release Timeline | Gantt | `Started At` to `Finished At` | Build and rollout history. |
| Preview Ready | Filtered table | `Environment = preview` and `Deployment Status = ready` | Links for review. |
| Failed Deployments | Filtered table | `Deployment Status = failed` | Debug queue. |
| Release Gates | Filtered table | `Release Gate = required` or `approved` | Human rollout decisions. |

## 8. Field Design Rules For All Tables

Every Feishu table should make field ownership explicit.

Rules:

- Fields sourced from Supabase are read-only in Feishu design. They may be displayed, filtered, grouped, linked, and sorted, but manual edits are not authoritative.
- Manual fields must be clearly named as requests, notes, or replies. They should not have the same name as canonical fields.
- Any manual field that needs to affect canonical state must be consumed by a later approved sync-reader workflow and converted into a `human_decisions`, `task_events`, or task update with audit history.
- Feishu `record_id` is stored as a binding locator. Supabase `id` remains the canonical identity.
- Computed display fields can be formulas or sync-generated text, but they must be reproducible from canonical data.
- Sensitive fields are excluded: claim tokens, service-role keys, Feishu app secrets, Worker tokens, raw large logs, and secret environment values.
- Large JSON payloads should be summarized for Feishu. Raw structured payloads stay in Supabase or external artifacts.
- Status fields should use controlled single-select options aligned to Phase 1B canonical status values and display labels.
- Date-time fields should use one timezone display convention in Feishu, preferably the workspace default with exact timestamps.

Recommended common fields:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Canonical ID | Text | Source table `id` | Yes | No | Hidden or narrow technical field. |
| Display Title | Text | Source title/name field | Yes | No | Primary row label. |
| Status | Single select | Canonical status | Yes | No | Machine-compatible option set. |
| Display Status | Single select | Derived from canonical status | Yes | No | Operator-friendly text. |
| Updated At | Date time | Source `updated_at` | Yes | No | Sort and stale checks. |
| Feishu Record ID | Text | Binding locator | Yes | No | Filled after row creation. |
| Operator Note | Long text | Feishu-only field | No | Yes | Local note only. |

## 9. Recommended View Design Across Tables

Each Bitable table should include four view families where useful: table, kanban, gantt, and filtered operational views.

Table views:

- Use table views for complete record inspection, exact fields, audit-friendly sorting, and export.
- Default table views should sort by priority, blocking state, and updated time.
- Tree-like display should group by project and parent task where Feishu relation fields make this workable.

Kanban views:

- Use kanban for status flow: planning, queued, running, awaiting human, awaiting review, retrying, succeeded, failed, cancelled.
- Keep canonical status as the grouping source when operators need exact state.
- Use display stage when the boss needs simpler categories.

Gantt views:

- Use gantt for planned or observed time windows, not as the source of scheduling truth.
- Project and task gantt views can use created, queued, started, completed, deployment start, and deployment finish times.
- Missing dates should not imply a schedule failure; they mean the canonical workflow has not recorded that point yet.

Filtered views:

- Blocked views show unresolved decisions, blocked tasks, stale heartbeats, failed deployments, and retry exhaustion.
- Review views show `awaiting_review` tasks, ready previews, and requested review decisions.
- Worker views show active attempts, stale leases, and recent failures.
- Release views show ready preview URLs, failed builds, and gates waiting for owner action.

Minimum view set:

| Table | Table view | Kanban view | Gantt view | Filtered views |
| --- | --- | --- | --- | --- |
| Project Overview | Active Projects | Project Kanban | Project Timeline | Blocked Projects, Review Queue |
| Task Details | Task Tree | Execution Kanban | Task Timeline | Blocked Tasks, Review Ready, Stale Heartbeat |
| Agent Status | Worker Health | Heartbeat Board | Not required | Active Attempts, Failure Queue |
| Issues And Decisions | Awaiting Boss | Decision Kanban | Optional by expiry | Blocking Issues, Review Decisions, Expiring Soon |
| Deployments And Releases | Latest Deployments | Deployment Kanban | Release Timeline | Preview Ready, Failed Deployments, Release Gates |

## 10. Project Progress Display

Project progress should be a rollup, not a manually edited number.

Display rules:

- Project progress is derived from child phases or top-level task packages, following Phase 1C weighted rollup rules.
- A project reaches 100 percent only when all required child work is `succeeded` and final review gates are closed.
- A project with unresolved human decisions should display the blocking state even if its numeric progress is high.
- A project with failed required child work should display blocked or failed according to owner policy, not just the average progress.
- Optional or cancelled child tasks should be excluded from blocking completion only when a human decision or task policy says they are optional.

Recommended Project Overview fields for progress explanation:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Progress | Percent | Weighted child rollup | Yes | No | Primary progress indicator. |
| Progress Formula Text | Text | Generated summary | Yes | No | Example: `7/10 required tasks done, 1 blocked, 2 in review`. |
| Current Phase | Text | Highest-priority active child phase | Yes | No | Helps boss understand where work is. |
| Next Milestone | Text | Next incomplete phase or task | Yes | No | Optional display summary. |
| Project Risk | Single select | Derived from blockers/failures/stale attempts | Yes | No | Normal, attention, blocked, failed. |

Recommended views:

- Active Projects table should place `Progress`, `Progress Formula Text`, `Current Phase`, and `Project Risk` near the title.
- Project Kanban should group by `Display Stage`, with blocked and review columns visible without horizontal scrolling.
- Project Timeline should show phase or task package dates only when those dates are available from canonical records.

## 11. Task Progress Display

Task progress should explain both execution percentage and lifecycle status.

Display rules:

- `tasks.progress_percent` is the display number for the task row.
- During one active attempt, progress should not decrease.
- A new attempt can restart attempt-local progress, while the task row should clearly show retry context.
- `queued` tasks usually display 0 to 5 percent.
- `running` tasks usually display 5 to 90 percent.
- `awaiting_review` tasks usually display 90 to 99 percent.
- `succeeded` tasks display 100 percent.
- `failed` and `cancelled` tasks keep the last meaningful progress but must show terminal status and reason.
- Parent task progress is a child rollup. Executable subtask progress mirrors the latest attempt.

Recommended Task Details fields for progress explanation:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Progress | Percent | `tasks.progress_percent` | Yes | No | Numeric display. |
| Current Step | Text | `tasks.current_step` | Yes | No | Short current action. |
| Status Message | Long text | `tasks.status_message` | Yes | No | Human-readable detail. |
| Attempt Count | Number | `tasks.attempt_count` | Yes | No | Retry context. |
| Latest Attempt Progress | Percent | Latest `task_attempts.progress_percent` | Yes | No | Useful when task is a parent or retrying. |
| Progress Detail | Text | Generated summary | Yes | No | Example: `Attempt 2/3, validation running`. |

Recommended views:

- Execution Kanban should show progress and current step on cards.
- Task Tree should show parent and child progress together so rollups are understandable.
- Review Ready should show progress near 90 to 99 percent plus result links.

## 12. Worker Heartbeat Display

Worker heartbeat should answer whether a running attempt is alive, stale, expired, or idle.

Display rules:

- Heartbeat display comes from latest `task_attempts.heartbeat_at`, `lease_expires_at`, and `status`.
- A running attempt with recent heartbeat and valid lease displays `healthy`.
- A running attempt with late heartbeat but recoverable lease displays `stale`.
- A running or claimed attempt past lease recovery policy displays `expired`.
- An agent with no active attempt displays `idle`.
- Heartbeat health is operational display. It should not directly mark a task failed without the state machine transition policy.

Recommended Agent Status fields:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Heartbeat At | Date time | `task_attempts.heartbeat_at` | Yes | No | Latest active attempt heartbeat. |
| Lease Expires At | Date time | `task_attempts.lease_expires_at` | Yes | No | Claim lease boundary. |
| Heartbeat Age | Formula or number | Derived from current time and heartbeat | Yes | No | Feishu display helper. |
| Heartbeat Health | Single select | Derived status | Yes | No | Healthy, stale, expired, idle. |
| Current Task | Linked record or text | Latest active attempt task | Yes | No | Direct link to affected work. |
| Recovery Needed | Checkbox | Derived from stale/expired state | Yes | No | Drives filtered view. |

Recommended views:

- Heartbeat Board groups agents by `Heartbeat Health`.
- Stale Heartbeat in Task Details filters tasks whose latest active attempt has stale or expired heartbeat.
- Active Attempts filters `Attempt Status` in claimed, running, or heartbeat stale and sorts by `Lease Expires At`.

## 13. Blocked Task Display

Blocked work should be visible from both task and decision angles.

Blocked sources:

- `tasks.status = awaiting_human`.
- `tasks.requires_human_decision = true`.
- Unresolved `human_decisions` rows.
- Required child task terminal failure that blocks parent completion.
- Stale or expired Worker heartbeat that requires recovery policy.
- Failed deployment that blocks review or release.
- Dependency not satisfied, such as review-before-start or decision-before-start.

Task Details blocked fields:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Blocked | Checkbox | Derived from status, decision, dependency, or failure | Yes | No | Fast filter field. |
| Blocking Category | Single select | Derived classification | Yes | No | Human, dependency, failure, heartbeat, deployment, policy. |
| Blocking Reason | Long text | `tasks.blocked_reason` or generated summary | Yes | No | Human-readable explanation. |
| Blocking Decision | Linked record or text | Active `human_decisions.id` | Yes | No | Link to action row. |
| Blocked Since | Date time | First unresolved blocker event time | Yes | No | Aging and escalation. |
| Retry Eligible | Checkbox | Derived from attempt budget and policy | Yes | No | Whether automation may continue after blocker clears. |

Recommended blocked views:

- Blocked Tasks in Task Details filters `Blocked = true` and sorts by `Blocked Since`.
- Blocking Issues in Issues And Decisions filters unresolved decisions and urgent severity.
- Failed Deployments in Deployments And Releases catches deployment blockers.
- Stale Heartbeat catches Worker recovery blockers.

Display rule: a blocked parent row should identify the smallest child node that actually blocked, so operators do not need to inspect every descendant.

## 14. Human Decision Display And Reply Flow

Human decisions should be represented as explicit rows, not hidden comments.

Display rules:

- Every task that enters `awaiting_human` or review-gated `awaiting_review` should have one or more related decision rows.
- The Issues And Decisions table is the primary reply surface.
- `Question`, `Options`, `Recommended Option`, and `Blocking Reason` are read-only display fields.
- `Response Text`, `Response Choice`, and `Response Submitted` are manual input fields.
- Manual input does not directly mutate canonical state in Phase 1D. A later approved process may read submitted replies and write canonical decision resolution.
- Once a decision is resolved canonically, `Decision Status`, `Decision Text`, `Decided By`, and `Resolved At` should update from Supabase.

Recommended reply fields:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Response Choice | Single select | Feishu manual input | No | Yes | Approve, reject, answer, need more info, cancel. |
| Response Text | Long text | Feishu manual input | No | Yes | Free-form answer. |
| Response Submitted | Checkbox | Feishu manual input | No | Yes | Explicit operator submit marker. |
| Response Submitted At | Date time | Feishu automation or later sync reader | No | Yes | Optional manual timestamp. |
| Canonical Decision Text | Long text | `human_decisions.decision_text` | Yes | No | Filled after accepted into Supabase. |
| Canonical Decision Status | Single select | `human_decisions.status` | Yes | No | Final source-of-truth status. |

Reply handling rules for later implementation:

- Ignore rows where `Response Submitted` is not checked.
- Validate that the decision is still unresolved before consuming a reply.
- Record the reply as a canonical decision update and append an event.
- Clear or mark consumed manual fields only after canonical update succeeds.
- If the reply is invalid or stale, write a visible validation message instead of changing task state.

## 15. Git Commit, Preview URL, And Deployment Status Display

Git and deployment information should be visible where operators review output, but canonical state remains in attempt and deployment records.

Display locations:

- Task Details shows latest commit, PR URL, preview URL, and deployment status for the task.
- Deployments And Releases shows one row per deployment record.
- Project Overview shows the latest ready preview and latest commit for quick access.
- Issues And Decisions review rows should include commit and preview references when a review depends on them.

Recommended fields:

| Field name | Field type | Source field | Read-only | Manual edit allowed | Notes |
| --- | --- | --- | --- | --- | --- |
| Commit SHA | Text | `task_attempts.result_git_sha` or `deployments.git_commit_sha` | Yes | No | Use short display while preserving full value if possible. |
| Commit Message | Text | `task_attempts.commit_message` | Yes | No | Worker-produced commit title. |
| Branch | Text | `task_attempts.branch_name` or `deployments.git_branch` | Yes | No | Feature or target branch. |
| PR URL | URL | Attempt result payload or task metadata | Yes | No | Review link when available. |
| Preview URL | URL | `deployments.deployment_url` | Yes | No | Main validation link. |
| Deployment Status | Single select | `deployments.status` | Yes | No | Pending, building, ready, failed, cancelled, unknown. |
| Deployment Environment | Single select | `deployments.environment` | Yes | No | Preview, staging, production, unknown. |
| Deployment Error | Long text | `deployments.error_text` | Yes | No | Short failure summary. |
| Last Callback At | Date time | `deployments.last_callback_at` | Yes | No | Provider callback freshness. |

Display rules:

- Do not infer task success from a commit SHA alone.
- Do not infer deployment readiness from a URL alone; use `deployments.status`.
- A ready preview can support review, but final success still depends on the task state machine and human gates.
- Production deployment is not triggered from Feishu in this phase.
- Failed deployment should create or update visible blocker context when it blocks task review or release.

## 16. Feishu `record_id` And Supabase ID Binding Rules

Binding rule: one visible Feishu Bitable row should bind to one canonical Supabase record for the same table purpose.

Identity principles:

- Supabase `id` is canonical.
- Feishu `record_id` is an external locator.
- The binding must be durable and idempotent.
- A sync worker should search by canonical ID before creating a new Feishu row.
- If a Feishu row is deleted manually, the sync worker may recreate it from canonical data rather than deleting Supabase data.

Recommended binding locations:

| Bitable table | Supabase record | Binding key | Feishu locator |
| --- | --- | --- | --- |
| Project Overview | `projects.id` | Project ID | Project table `record_id`. |
| Task Details | `tasks.id` | Task ID | Task table `record_id`. |
| Agent Status | `agents.id` | Agent ID | Agent table `record_id`. |
| Issues And Decisions | `human_decisions.id` | Decision ID | Decision table `record_id`. |
| Deployments And Releases | `deployments.id` | Deployment ID | Deployment table `record_id`. |

Rules:

- The Bitable row must include the canonical ID field as read-only display or hidden technical field.
- Supabase should store the Feishu `record_id` either in the canonical record when it is the primary display row or in a dedicated sync mapping structure in a later approved design.
- For V2 task rows, `tasks.feishu_record_id` can bind the primary Task Details row.
- For non-task tables, binding may be stored in metadata or a later mapping table design, but Phase 1D does not create schema.
- If the same canonical record appears in multiple Bitable tables, each table needs its own binding locator.
- Idempotency keys should include table purpose and canonical ID, for example `task_details:tasks.id`.

Conflict handling:

- If two Feishu rows contain the same canonical ID, the sync worker should mark one as duplicate for operator cleanup and keep one canonical binding.
- If a Feishu row exists with no canonical ID, it is treated as manual intake or orphaned display data, not canonical truth.
- If canonical state changes while a sync retry is pending, the newest desired payload should supersede older pending payloads when safe.

## 17. `feishu_sync_outbox` Queue Design

Feishu writes should be queued as durable sync work. Main task execution writes canonical state first, then enqueues display updates.

Outbox purpose:

- Persist desired Feishu writes.
- Retry failures without losing state changes.
- Decouple Feishu availability from Worker execution.
- Deduplicate repeated progress and status updates.
- Provide audit visibility for sync health.

Recommended outbox fields for design:

| Field name | Source field | Purpose |
| --- | --- | --- |
| Outbox ID | `feishu_sync_outbox.id` | Durable sync item. |
| Project ID | `project_id` | Project context. |
| Task ID | `task_id` | Related task when applicable. |
| Attempt ID | `attempt_id` | Related attempt when applicable. |
| Deployment ID | `deployment_id` | Related deployment when applicable. |
| Human Decision ID | `human_decision_id` | Related decision when applicable. |
| Sync Type | `sync_type` | Task status, attempt progress, deployment status, decision request, message reply. |
| Target Type | `target_type` | Bitable record, chat message, comment, unknown. |
| Target App Token | `target_app_token` | Non-secret app locator. |
| Target Table ID | `target_table_id` | Bitable table locator. |
| Target Record ID | `target_record_id` | Existing row locator when known. |
| Target Chat ID | `target_chat_id` | Chat reply target when needed. |
| Target Message ID | `target_message_id` | Message update or reply target. |
| Desired Payload | `desired_payload` | Field update or message payload. |
| Status | `status` | Pending, processing, succeeded, failed, cancelled. |
| Attempt Count | `attempt_count` | Number of sync attempts. |
| Max Attempts | `max_attempts` | Retry limit. |
| Next Attempt At | `next_attempt_at` | Backoff schedule. |
| Last Attempt At | `last_attempt_at` | Latest try. |
| Last Success At | `last_success_at` | Latest success. |
| Last Error Text | `last_error_text` | Visible failure reason. |
| Idempotency Key | `idempotency_key` | Deduplication key. |

Queue rules:

- Enqueue after canonical state changes, not before.
- Use one idempotency key for each logical display target and state category.
- Collapse noisy progress updates when a newer pending update supersedes an older one.
- Preserve important terminal updates even if earlier progress updates are skipped.
- Do not store secrets in outbox payloads.
- Do not store full logs; store short summaries and external references.

## 18. Feishu Sync Failure Retry Rules

Failure retry should be visible, bounded, and non-blocking.

Retry states:

| Outbox status | Meaning | Operator display |
| --- | --- | --- |
| `pending` | Waiting for first attempt or scheduled retry. | Normal queue. |
| `processing` | Sync worker has claimed the item. | In progress. |
| `succeeded` | Feishu update completed. | Usually hidden from operations views. |
| `failed` | Retry limit reached. | Needs attention. |
| `cancelled` | No longer needed or superseded. | Historical only. |

Retry rules:

- Use bounded exponential backoff for transient Feishu errors.
- Retry immediately only for safe network or rate-limit recovery paths that respect provider limits.
- Do not retry validation errors forever, such as invalid table ID, missing field, or permission mismatch.
- Set `last_error_text` to a short actionable reason.
- Set `next_attempt_at` for scheduled retries.
- Stop at `max_attempts` and mark `failed`.
- Allow a later operator or maintenance process to requeue failed sync items after fixing configuration.
- Terminal task state remains canonical even when Feishu display update fails.

Recommended operational views:

- Feishu Sync Failed filters outbox items with `status = failed`.
- Feishu Sync Pending filters `pending` items where `next_attempt_at` is due.
- Feishu Sync Delayed filters `pending` items with old `created_at` or repeated attempts.

Phase 1D does not create a Feishu Sync Bitable table as a required boss-facing table, but an internal operator table can be added later if sync failures need direct Feishu visibility.

## 19. Rules To Prevent Feishu Sync From Blocking Main Execution

Feishu display is important, but it must not block canonical task execution.

Non-blocking rules:

- Worker claim, heartbeat, progress, validation, Git operation reporting, task terminal state, and deployment callbacks write canonical Supabase state first.
- Feishu updates are queued through outbox after canonical writes.
- If Feishu is unavailable, canonical task state still advances.
- If Bitable field schema is misconfigured, the sync item fails visibly but task execution does not roll back.
- If a Feishu row cannot be found, sync should attempt idempotent row creation or mark a recoverable sync failure according to target type.
- If a manual Feishu edit conflicts with canonical state, canonical state wins until a later approved workflow converts the manual edit into a valid decision or request.
- High-frequency heartbeat updates should not enqueue full Bitable writes unless the visible heartbeat health changes.
- High-frequency progress updates should be coalesced.
- Terminal status, human decision request, deployment failure, and review-ready updates should be prioritized over routine progress updates.

Recommended priority order:

| Priority | Sync category | Reason |
| --- | --- | --- |
| 1 | Human decision request or resolution | Directly affects blocked work. |
| 2 | Terminal task state | Boss-facing outcome. |
| 3 | Deployment ready or failed | Review and release dependency. |
| 4 | Blocked task update | Escalation visibility. |
| 5 | Meaningful progress or stage change | Normal transparency. |
| 6 | Routine heartbeat display | Health visibility, low business urgency. |

Operational rule: Feishu sync failure can create an operational issue, but it must not mutate task status to failed unless the task itself is specifically about Feishu sync.

## 20. V1 `hermes_jobs` To V2 Feishu Table Compatibility Mapping

During compatibility, V1 `hermes_jobs` can still be shown in V2-style Feishu tables. The mapping should preserve identifiers and status meaning without changing production behavior.

Primary mapping:

| V1 `hermes_jobs` field | V2 canonical location | Feishu table | Feishu field |
| --- | --- | --- | --- |
| `id` | `tasks.legacy_hermes_job_id` | Task Details | Task ID or Legacy Job ID |
| `job_id` | `tasks.legacy_job_id` | Task Details | Legacy External Job ID |
| `source` | `tasks.source` | Task Details | Source |
| `feishu_message_id` | `tasks.feishu_message_id` | Task Details / Issues And Decisions | Source Message |
| `feishu_event_id` | `tasks.feishu_event_id` | Task Details | Source Event |
| `feishu_chat_id` | `tasks.feishu_chat_id` | Task Details | Source Chat |
| `feishu_user_id` | `tasks.feishu_user_id` | Task Details | Requester |
| `bitable_record_id` / `feishu_record_id` / `record_id` | `tasks.feishu_record_id` | Task Details | Feishu Record ID |
| `title` | `tasks.title` | Task Details | Title |
| `description` | `tasks.description` | Task Details | Description |
| `request_text` | `tasks.request_text` | Task Details | Source Request |
| `acceptance` | `tasks.acceptance_criteria` | Task Details | Acceptance Criteria |
| `priority` | `tasks.priority` | Task Details | Priority |
| `executor` | `agents.external_id` or task metadata | Agent Status / Task Details | Worker |
| `repo` | `tasks.repo` or `projects.repository_full_name` | Project Overview / Task Details | Repository |
| `branch` | `tasks.target_branch` or attempt branch | Task Details | Branch |
| `prompt` | `tasks.prompt` | Not displayed by default | Hidden or omitted |
| `status` | `tasks.status` after mapping | Task Details | Task Status |
| `claimed_by` | `task_attempts.worker_name` | Agent Status / Task Details | Worker |
| `claimed_at` | `task_attempts.started_at` | Task Details | Started At |
| `expires_at` | `task_attempts.lease_expires_at` | Agent Status | Lease Expires At |
| `attempts` | `tasks.attempt_count` | Task Details | Attempt Count |
| `max_attempts` | `tasks.max_attempts` | Task Details | Max Attempts |
| `progress_percent` | `tasks.progress_percent` and latest attempt progress | Task Details | Progress |
| `current_step` | `tasks.current_step` | Task Details | Current Step |
| `status_message` | `tasks.status_message` | Task Details | Status Message |
| `result` | `tasks.result_summary` or result payload summary | Task Details | Latest Result |
| `error` / `error_text` | `tasks.last_error_text` | Task Details | Last Error |
| `git_commit_sha` | `task_attempts.result_git_sha` and `deployments.git_commit_sha` | Task Details / Deployments And Releases | Commit SHA |
| `completed_at` | `tasks.completed_at` | Task Details | Completed At |
| `created_at` | `tasks.created_at` | Task Details | Created At |
| `updated_at` | `tasks.updated_at` | Task Details | Updated At |

Status compatibility:

| V1 status | V2 display in Feishu |
| --- | --- |
| `pending` | Queued |
| `queued` | Queued |
| `running` | Running |
| `awaiting_review` | Awaiting Review |
| `waiting_review` | Awaiting Review |
| `completed` | Succeeded |
| `succeeded` | Succeeded |
| `failed` | Failed |
| `cancelled` | Cancelled |
| `retrying` | Retrying |
| blank or unknown | Draft |

Compatibility rules:

- A V1 row can appear as one leaf row in Task Details until it is decomposed.
- A broad V1 request can be displayed as a task package with generated child rows only after a later approved decomposition workflow.
- Preserve the original V1 status text in a legacy field when the mapping is uncertain.
- Do not expose raw prompt text by default.
- Do not make V1 Feishu manual edits authoritative without a later approved reader workflow.

## 21. Example: City Partner Website MVP In Feishu Bitable

Example project: `city-partner-platform`, a mobile-first MVP for city activity partners.

Project Overview row:

| Field | Example value |
| --- | --- |
| Project Key | `city-partner-platform` |
| Project Name | 同城搭子网站 MVP |
| Business Outcome | 用户可以浏览活动、查看详情、发起报名，并为后续 Supabase 与飞书流程接入预留边界。 |
| Repository | `city-partner-platform` |
| Project Status | `active` |
| Display Stage | `executing` |
| Progress | `45%` |
| Progress Formula Text | `2/6 required task packages done, 1 running, 1 awaiting review, 1 blocked` |
| Current Blocker | `需要确认 MVP 首版是否包含活动发布表单` |
| Latest Preview URL | Preview deployment URL when ready |
| Latest Commit | Latest Worker-produced commit SHA |

Task Details example rows:

| Node Level | Title | Status | Progress | Current Step | Blocking Reason | Commit / Preview |
| --- | --- | --- | --- | --- | --- | --- |
| Project | 同城搭子网站 MVP | running | 45% | 前端 MVP 页面执行中 | 首版范围待确认 | Latest preview |
| Phase | 需求与设计 | succeeded | 100% | 范围文档已完成 |  |  |
| Task | 定义 MVP 页面结构 | succeeded | 100% | 已通过 review |  | Commit SHA |
| Subtask | 编写活动列表与详情信息流说明 | succeeded | 100% | 文档完成 |  | Commit SHA |
| Phase | 数据与接口基础 | awaiting_review | 95% | 等待技术 review |  | PR URL |
| Task | 设计活动数据模型 | awaiting_review | 95% | 等待确认 mock/Supabase 字段 |  | PR URL |
| Phase | 前端 MVP 页面 | running | 35% | 活动卡片列表实现中 |  | Preview pending |
| Task | 首页与活动列表 | running | 55% | 移动端卡片布局验证 |  | Branch name |
| Subtask | 实现移动端活动卡片列表 | running | 70% | 运行本地验证 |  |  |
| Task | 活动发布表单 | awaiting_human | 10% | 等待范围确认 | 首版是否包含发布入口 |  |
| Phase | 验证与验收 | queued | 0% | 等待前端任务完成 |  |  |

Issues And Decisions example row:

| Field | Example value |
| --- | --- |
| Decision Type | `clarification` |
| Decision Status | `requested` |
| Question | 首版 MVP 是否包含用户发起活动表单，还是只展示 mock 活动和报名入口？ |
| Options | `A: 包含发布表单`, `B: 只展示和报名`, `C: 暂停该功能` |
| Recommended Option | `B: 只展示和报名` |
| Response Choice | Boss fills in Feishu |
| Response Text | Boss reply |
| Response Submitted | Boss checks when ready |

Agent Status example row:

| Field | Example value |
| --- | --- |
| Agent Name | `windows-worker-01` |
| Agent Type | `worker` |
| Agent Status | `active` |
| Current Task | `实现移动端活动卡片列表` |
| Attempt Status | `running` |
| Heartbeat Health | `healthy` |
| Current Step | `运行本地验证` |
| Progress | `70%` |

Deployments And Releases example row:

| Field | Example value |
| --- | --- |
| Provider | `vercel` |
| Environment | `preview` |
| Deployment Status | `building` |
| Git Commit SHA | Worker-produced SHA |
| Git Branch | `codex/city-mvp-list` |
| Deployment URL | Preview URL when provider reports ready |
| Release Gate | `required` |

This example keeps production deployment, production environment changes, and real database migration outside the Feishu operation surface until separate human approval exists.

## 22. Explicit Non-Goals For Phase 1D

This phase does not:

- Execute SQL.
- Create migration files.
- Modify business code.
- Modify Worker code.
- Modify API routes.
- Modify `.gitignore`.
- Change production data.
- Change Supabase RLS policies.
- Change Feishu table schemas directly.
- Trigger Feishu API writes.
- Trigger Vercel production deployment.
- Commit changes from Codex.
- Push changes from Codex.
- Open or merge a pull request from Codex.

The output of Phase 1D is only `docs/upgrade/v2-feishu-bitable-design.md`. Later phases can separately review and approve schema changes, API contracts, Worker sync processing, Feishu field creation, Bitable view creation, and manual reply ingestion.
