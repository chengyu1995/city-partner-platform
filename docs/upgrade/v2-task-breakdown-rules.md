# Hermes V2 Task Breakdown Rules

Scope: Phase 1C design document only.

This document defines how Hermes V2 decomposes natural-language requests into a task tree for the Hermes multi-role task management system. It depends on Phase 1A data model design in `docs/upgrade/v2-data-model.md` and Phase 1B state machine design in `docs/upgrade/v2-task-state-machine.md`.

This phase does not execute SQL, does not create migration files, does not modify business code, does not modify Worker code, does not modify API routes, and does not modify `.gitignore`.

## 1. Current Single-Task Mode Problems

V1 `hermes_jobs` treats one owner request as one job row. That is enough for small, isolated tasks, but it becomes fragile when a request is actually a product initiative, multi-step rollout, or cross-role workflow.

Main problems:

- Scope is ambiguous. A single row can contain a whole project, a phase, a feature, a bugfix, or one file edit.
- Progress is misleading. One percentage value cannot explain which parts are planned, running, blocked, reviewed, or done.
- Retry is too coarse. A failure in one small part can make the whole job look failed even when most work is valid.
- Human review is hard to place. V1 can mark a job awaiting review, but cannot show which exact layer or deliverable needs review.
- Parallel work is invisible. Independent work streams are serialized into one job even when multiple Workers or agents could handle them safely.
- Dependencies are implicit. The Worker prompt may mention order, but the data model does not represent dependency edges.
- Feishu display is flat. Bitable users see rows, not a clear project tree with phase, task package, subtask, and checkpoint rollups.
- Codex prompts can become too large. One overbroad job asks Codex to plan, implement, test, review, and summarize too much at once.

V2 fixes this by making decomposition explicit and by using the task tree as the planning, execution, review, and reporting structure.

## 2. V2 Task Tree Level Definitions

V2 uses five logical levels:

| Level | Purpose | Executed by Worker | Typical owner |
| --- | --- | --- | --- |
| `project` | A complete business or product initiative. | No | Boss, product owner, Hermes |
| `phase` | A milestone or delivery stage inside a project. | No, except as coordination | Product owner, Hermes |
| `task` | A task package that can be assigned, reviewed, and reported as one deliverable. | Sometimes | Hermes, lead agent |
| `subtask` | The smallest normal Codex/Worker implementation unit. | Yes | Codex/Worker |
| `checkpoint` | A validation, review, or state snapshot inside or after a subtask. | No direct code execution | Worker, reviewer, Hermes |

Recommended semantics:

- A `project` answers "what outcome are we delivering?"
- A `phase` answers "which milestone is this?"
- A `task` answers "what package of work can be planned and reviewed together?"
- A `subtask` answers "what exactly should one Worker/Codex run do?"
- A `checkpoint` answers "how do we prove this work is ready to continue?"

The physical implementation can store executable levels in V2 `tasks` and represent checkpoints through the Phase 1A checkpoint design. The logical tree still needs all five levels for planning and display.

## 3. Breaking Boss Natural-Language Requests Into Projects

Boss requests often arrive as short natural-language messages such as "upgrade Hermes to V2" or "build the city partner website". Hermes should first decide whether the request creates a new project, updates an existing project, or adds a task to an active project.

Project creation rules:

- Create a new `project` when the request names a new product, system, major upgrade, or long-running initiative.
- Reuse an existing `project` when the request clearly belongs to a known repository, product, or active V2 project key.
- Ask for clarification when the target product, repository, or success outcome is unclear.
- Keep the original request text unchanged for traceability.
- Extract the expected outcome, constraints, target repository, forbidden actions, deadline if present, and required human gates.

A project title should be short and stable. A project description should preserve the business intent, not only the technical task. Acceptance criteria at project level should describe user-visible or owner-visible completion, not implementation details.

## 4. Breaking Projects Into Phases

A `phase` is a milestone that groups related work and creates a natural review boundary. Phases should be sequential by default unless the project owner or dependency rules allow parallelism.

Common phase patterns:

- Discovery and design: read existing docs, define model, define state, define breakdown rules.
- Foundation: create data structures, API contracts, permissions, and compatibility behavior.
- Implementation: build Worker, API, UI, and integration behavior.
- Migration or compatibility: backfill, dual-read, dual-write, and rollout planning.
- Validation: local checks, CI, Feishu display verification, owner acceptance.
- Release: merge, deploy, monitor, and closeout.

Phase rules:

- A phase must have a clear exit condition.
- A phase must not mix design-only work with production-changing execution unless explicitly approved.
- A phase can contain multiple task packages, but should not contain unrelated business outcomes.
- A phase can be marked blocked when any required task package is blocked by unresolved dependency or human decision.

## 5. Breaking Phases Into Task Packages

A `task` package is the unit Hermes can assign, sequence, and review as a meaningful deliverable. It is larger than one file edit but smaller than a phase.

Task package rules:

- Group work by ownership boundary, not by arbitrary file count.
- Keep database, API, Worker, frontend, Feishu, and documentation packages separate when risk or review ownership differs.
- Make a task package independently reviewable.
- Include allowed files, forbidden files, validation commands, and expected output.
- State whether the package is design-only, implementation, test-only, review, or rollout.
- Prefer one package per PR when code changes are involved.

Examples:

- "Design V2 data model" is one design task package.
- "Implement task claim API" is one backend task package.
- "Add Feishu Bitable tree view fields" is one integration task package.
- "Validate V2 task state transitions" is one test/review task package.

## 6. Breaking Task Packages Into Subtasks

A `subtask` is the normal Codex execution unit. It should be small enough that one Worker run can complete it, validate it, and produce a concise result without needing broad judgment.

Subtask rules:

- One subtask should have one primary objective.
- One subtask should list exact allowed files or allowed directories.
- One subtask should include a clear done condition and validation command when applicable.
- One subtask should avoid crossing infrastructure, business logic, frontend, and messaging boundaries unless the change is intentionally end-to-end and small.
- If a subtask requires new dependencies, production config, data deletion, or unclear product choices, it should stop at a human decision checkpoint instead of executing.
- If a subtask is mostly investigation, its output should be a document, issue comment, or decision record rather than code.

Sizing guidance:

- Good subtask: "Create the V2 breakdown rules document only."
- Too broad: "Upgrade Hermes to V2."
- Too mixed: "Change database schema, Worker claim logic, Feishu display, and deploy."

## 7. Breaking Subtasks Into Checkpoints

A `checkpoint` is a proof point, review gate, or state snapshot. Checkpoints prevent hidden drift and make retry safer.

Checkpoint types:

- Intake checkpoint: confirms the request, allowed files, forbidden actions, and branch/worktree assumptions.
- Pre-execution checkpoint: records clean worktree, current branch, relevant docs read, and task constraints.
- Draft checkpoint: confirms the first complete output exists before validation.
- Validation checkpoint: records lint, build, typecheck, tests, search checks, or document policy checks.
- Human review checkpoint: records an approval, rejection, clarification, or risk acceptance requirement.
- Completion checkpoint: records changed files, final summary, residual risks, and external links.

Checkpoint rules:

- Every executable subtask should have at least pre-execution, validation, and completion checkpoints.
- Design-only subtasks can use document existence, content coverage, forbidden keyword search, and changed-file checks as validation.
- Checkpoints should store concise metadata and references, not large logs.
- Failed checkpoints should write back to the nearest owning subtask and roll up to parent levels.

## 8. Field Requirements For Each Level

Each level needs enough fields for planning, execution, display, and audit.

`project` required fields:

- Stable key
- Title
- Original request text
- Business outcome
- Repository or system scope when known
- Owner or requester
- Status
- Priority
- Created time
- Updated time

`phase` required fields:

- Parent project
- Phase order
- Title
- Goal
- Entry conditions
- Exit conditions
- Status
- Progress percent
- Dependency list
- Review requirement

`task` package required fields:

- Parent phase
- Title
- Description
- Task type
- Acceptance criteria
- Allowed scope
- Forbidden scope
- Expected output
- Status
- Priority
- Dependency list
- Human gate policy
- Validation policy

`subtask` required fields:

- Parent task package
- Runnable prompt
- Allowed files or directories
- Forbidden files or directories
- Base branch or worktree assumption
- Validation commands or document checks
- Expected result summary
- Status
- Attempt budget
- Current attempt reference when running

`checkpoint` required fields:

- Parent subtask or task package
- Checkpoint type
- Required condition
- Observed result
- Pass or fail status
- Evidence reference
- Actor
- Timestamp
- Notes or blocking reason

## 9. Status Inheritance Rules

Status inheritance is a rollup rule, not a replacement for the child status. Parents summarize children while each child keeps its own canonical status from Phase 1B.

General rules:

- A parent is `succeeded` only when all required children are `succeeded` or explicitly skipped by approved policy.
- A parent is `running` when any required child is `running` and no higher-priority blocking state exists.
- A parent is `awaiting_human` when any required child is blocked on an unresolved human decision.
- A parent is `awaiting_review` when required child work is complete but at least one review gate remains open.
- A parent is `retrying` when a required child is being prepared for retry and parent policy allows retry.
- A parent is `failed` when a required child fails terminally and no policy allows partial success.
- A parent is `cancelled` only when the owner cancels it or all required remaining children are cancelled by approved policy.
- A parent can remain `queued` when children exist but none has started and all required dependencies are satisfied.
- A parent can remain `draft` when decomposition is incomplete or required fields are missing.

Blocking priority for rollup display:

1. Terminal cancellation by owner
2. Unresolved human decision
3. Terminal required child failure
4. Active running child
5. Review gate
6. Retry preparation
7. Queued runnable work
8. Draft planning
9. Full success

## 10. Progress Rollup Rules

Progress should be understandable, monotonic within a stable plan, and resilient to retries.

Recommended default weights:

- Project progress is the weighted average of phase progress.
- Phase progress is the weighted average of task package progress.
- Task package progress is the weighted average of required subtask progress.
- Subtask progress mirrors the latest active or completed attempt, following Phase 1B progress rules.
- Checkpoints contribute progress only through their owning subtask.

Weighting rules:

- Default child weight is `1`.
- A child can have a higher weight only when planned effort or risk is clearly larger.
- Optional children should not block 100 percent completion when cancelled by policy.
- Failed children keep their last meaningful progress but parent display must show failure or blocked state.
- Review checkpoints can hold a parent at 90 to 99 percent until approval.
- A project reaches 100 percent only when all required phases are complete and final review gates are closed.

Progress must not be used as the source of truth for status. Status is canonical; progress is display metadata.

## 11. Task Dependency Relationship Design

Dependencies connect nodes that must be completed or decided before another node can proceed.

Dependency types:

- `finish_to_start`: downstream work starts only after upstream success.
- `review_before_start`: downstream work starts only after human review approval.
- `decision_before_start`: downstream work starts only after clarification or owner choice.
- `soft_dependency`: downstream work can start, but should display risk if upstream is incomplete.
- `blocks_completion`: downstream work may run, but parent cannot complete until upstream finishes.

Dependency rules:

- Dependencies should normally connect nodes at the same level.
- Cross-level dependencies are allowed only when they are clearer than introducing an intermediate task package.
- Cycles are invalid and must be rejected during planning.
- A task cannot be runnable when any required blocking dependency is unresolved.
- Dependency changes after execution starts should create an event and may require human approval.

## 12. Parallel And Serial Task Rules

Hermes should prefer safe parallelism for independent work, but serial execution when shared state or review ordering matters.

Parallel task rules:

- Tasks can run in parallel when they touch different ownership boundaries and have no blocking dependency.
- Design-only documents can usually run in parallel if each has a separate target file and shared terminology is already defined.
- Frontend and backend tasks can run in parallel only when the API contract is stable.
- Multiple Codex subtasks must not edit the same file in parallel unless a coordinator explicitly owns merge resolution.

Serial task rules:

- Run data model design before migrations or API implementation.
- Run state machine design before Worker transition changes.
- Run API contract work before frontend integration that depends on the contract.
- Run validation and review after implementation tasks.
- Run production rollout only after owner approval.

Conflict rules:

- If two runnable subtasks include the same allowed file, mark them serial unless the file edit is read-only or one subtask is documentation-only.
- If a task changes foundational behavior, dependent tasks should wait for review.
- If dependency confidence is low, choose serial execution and ask for human confirmation.

## 13. Human Review Node Insertion Rules

Human review nodes should be inserted where automation cannot safely decide product, security, data, or rollout tradeoffs.

Insert a human review checkpoint when:

- The task affects production data, production environment variables, deployment, permissions, or security.
- The task requires a new dependency or infrastructure change.
- The task changes the V2 data model, state machine, compatibility policy, or Worker Git behavior.
- The task modifies payment, messaging fan-out, or other high-risk business behavior.
- The task has multiple valid product interpretations.
- A validation failure is not purely mechanical.
- A parent task would otherwise fail even though partial success might be acceptable.

Review node fields:

- Decision type
- Question
- Options or expected answer format
- Default safe behavior
- Expiry policy if any
- Affected node
- Downstream nodes blocked by the decision

Human review should be represented as an explicit node or checkpoint, not hidden in free-text notes.

## 14. Generating A Task Tree From Feishu Messages

Feishu messages can create or update task trees. Hermes should preserve the message as source evidence and convert it into structured nodes.

Parsing steps:

- Identify requester, chat, message ID, timestamp, and original text.
- Detect project name, repository, deadline, priority, and explicit constraints.
- Classify the request as new project, new phase, new task package, follow-up, review answer, or cancellation.
- Extract deliverables, forbidden actions, validation requirements, and expected output.
- Ask for clarification when target scope or acceptance criteria are missing.
- Create draft tree nodes first when the request is broad or risky.
- Queue only the smallest safe executable subtasks after required fields and gates are satisfied.

Idempotency rules:

- The same Feishu event or message should not create duplicate project roots.
- Edits or follow-up messages should append events or update draft nodes, not silently replace history.
- A review answer should resolve the matching human decision node before unblocking downstream work.

## 15. Displaying The Task Tree In Feishu Bitable

Feishu Bitable should show both a flat table view and a tree-friendly grouping view.

Recommended display columns:

- Project key
- Node level
- Parent node
- Sort order
- Title
- Status
- Progress percent
- Owner or agent
- Priority
- Dependencies
- Current step
- Blocking reason
- Review required
- Latest result summary
- Source message link
- Related commit or PR
- Updated time

Display rules:

- Use indentation, level labels, or grouped views to show project to checkpoint hierarchy.
- Keep status text user-friendly while preserving canonical internal status.
- Show parent rollup rows even when only child subtasks are executable.
- Show blocked nodes near the top of operational views.
- Show `awaiting_review` nodes in a dedicated review view.
- Avoid exposing internal claim tokens, secrets, raw prompts with sensitive content, or large logs.

Writeback rules:

- Feishu updates should be generated through durable sync work, not best-effort hidden writes.
- A failed Feishu sync should not mutate canonical task status.
- Bitable display should include enough context for the boss to approve, reject, or ask for clarification.

## 16. Codex Task Granularity Control Rules

Codex work should be scoped so one run can finish safely and produce a reviewable diff or document.

Codex-ready subtask criteria:

- The target files are explicitly allowed.
- The forbidden files are explicit.
- The expected output is measurable.
- The task can be validated locally or through a document check.
- The task does not require a product decision unless the decision is already provided.
- The task can be summarized in a concise final report.
- The task has a clear stop condition when constraints are violated.

Codex should not receive:

- Whole-project mandates without decomposition.
- Tasks that require changing production credentials or external systems.
- Multiple independent features in one prompt.
- Ambiguous product choices where Hermes has not inserted a human decision node.
- Broad refactors mixed with feature work.

If a Codex subtask grows during execution, the correct behavior is to stop, report the scope expansion, and write a follow-up child task instead of continuing indefinitely.

## 17. Rules To Prevent Tasks From Becoming Too Large, Too Long, Or Too Wide

Hermes should split tasks before execution when any size limit is exceeded.

Too large:

- More than one major ownership boundary is involved.
- More than one independent deliverable is present.
- The expected diff would be hard to review in one PR.
- The task mixes design, implementation, validation, and rollout.

Too long:

- The task requires multiple sessions, days, or external waiting periods.
- The task depends on owner feedback before meaningful progress can continue.
- The task has a long investigation phase and a separate implementation phase.

Too wide:

- The task touches many unrelated files or directories.
- The task fans out across database, Worker, API, frontend, Feishu, and deployment at once.
- The task creates many downstream branches without clear dependency order.

Splitting rules:

- Split by phase when the outcome is milestone-sized.
- Split by task package when ownership or review boundary differs.
- Split by subtask when one Codex run would need unrelated edits.
- Split by checkpoint when the work cannot continue safely without proof or approval.

## 18. Writing Failed Tasks Back To The Task Tree

Failures must be attached to the smallest node that actually failed, then rolled up to parents.

Failure writeback rules:

- A validation failure in one subtask updates that subtask and its latest attempt, not the whole project directly.
- A failed checkpoint updates the owning subtask or task package with the blocking reason.
- Parent nodes inherit blocked or failed display according to status inheritance rules.
- Failure summaries should be short, actionable, and visible in Feishu.
- Raw logs should be referenced, not copied into every parent node.
- Retry eligibility should be recorded separately from failure text.
- If retry is allowed, create or queue the retry plan under the same parent.
- If retry is not allowed, request human decision or mark the required node failed according to policy.

Failure categories:

- Planning failure
- Constraint violation
- Validation failure
- Worker or Codex execution failure
- Git or workspace failure
- External integration failure
- Human rejection
- Timeout or stale heartbeat

## 19. V1 `hermes_jobs` And V2 Task Tree Compatibility

During compatibility, each V1 job can map to a V2 tree at different levels depending on its scope.

Compatibility mapping:

| V1 job shape | V2 interpretation |
| --- | --- |
| Small executable job | One `subtask` under a generated task package |
| Feature request | One `task` package with child subtasks |
| Multi-step initiative | One `project` with phases and tasks |
| Review or approval request | Human review checkpoint or decision node |
| Failed Worker run | Attempt failure attached to the matching subtask |

Rules:

- Preserve V1 identifiers using the legacy fields described in Phase 1A.
- Preserve V1 status text when it does not map confidently to Phase 1B canonical status.
- Do not change production behavior during design-only phases.
- A V1 flat row can be displayed as a leaf node until decomposition is available.
- Backfilled V2 trees should be idempotent and traceable to the original V1 row.
- V2 should not require every historical V1 job to be perfectly decomposed before new V2 tasks can run.

## 20. Example: Breaking "开发同城搭子网站" Into A Complete Task Tree

Example boss request:

> 开发同城搭子网站，支持用户发布活动、浏览活动、查看详情、发起报名，先做 MVP，移动端舒服，后续接 Supabase 和飞书流程。

Example task tree:

| Level | Title | Dependencies | Review |
| --- | --- | --- | --- |
| `project` | 同城搭子网站 MVP | none | Final owner acceptance |
| `phase` | 需求与设计 | none | Product review |
| `task` | 定义 MVP 范围与页面结构 | none | Required |
| `subtask` | 编写 MVP 页面与数据流说明 | none | Required |
| `checkpoint` | 范围确认 | subtask done | Boss approves MVP scope |
| `phase` | 数据与接口基础 | 需求与设计 | Technical review |
| `task` | 设计活动数据模型 | MVP scope confirmed | Required |
| `subtask` | 定义活动字段、mock 数据与 Supabase 兼容关系 | none | Required |
| `checkpoint` | 数据模型设计检查 | subtask done | No migration in design phase |
| `task` | 实现活动数据访问入口 | 数据模型 approved | Optional depending on phase |
| `subtask` | 创建或更新活动列表读取逻辑 | data access contract | Code review |
| `checkpoint` | 本地 mock 模式验证 | subtask done | Validation passes |
| `phase` | 前端 MVP 页面 | 数据与接口基础 | UI review |
| `task` | 首页与活动列表 | API/mock access ready | Required |
| `subtask` | 实现移动端首页活动卡片列表 | none | Code review |
| `checkpoint` | 375px 移动端检查 | subtask done | Visual pass |
| `task` | 活动详情页 | activity list ready | Required |
| `subtask` | 实现详情信息、发起人、报名入口展示 | none | Code review |
| `checkpoint` | 路由与空状态检查 | subtask done | Validation passes |
| `task` | 发起活动表单 | data write path ready | Required |
| `subtask` | 实现活动创建表单和基础校验 | none | Code review |
| `checkpoint` | 表单提交验证 | subtask done | Local validation |
| `phase` | 验证与上线准备 | 前端 MVP 页面 | Owner review |
| `task` | 本地质量检查 | all required frontend tasks | Required |
| `subtask` | 运行 lint、build、typecheck 并记录结果 | none | Required |
| `checkpoint` | 质量门禁 | checks complete | All required checks pass |
| `task` | Feishu 汇报与验收 | quality gate passed | Required |
| `subtask` | 生成老板可读验收摘要 | none | Required |
| `checkpoint` | 老板验收 | summary delivered | Boss approves |

This example intentionally keeps production deployment and real Supabase migration outside the initial MVP execution until separate review gates approve them.

## 21. Explicit Non-Goals For Phase 1C

This phase does not:

- Execute SQL.
- Create migration files.
- Modify application code.
- Modify Worker code.
- Modify API routes.
- Modify `.gitignore`.
- Change production data.
- Change Supabase RLS policies.
- Change Feishu table schemas.
- Commit changes from Codex.
- Push changes from Codex.
- Open or merge a pull request from Codex.

The output of Phase 1C is only this task breakdown rules document. Later phases can separately review implementation plans for schema changes, Worker behavior, API contracts, Feishu sync, and UI display.
