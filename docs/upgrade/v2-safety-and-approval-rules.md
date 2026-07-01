# Hermes V2 Safety And Approval Rules

Scope: Phase 1E design document only.

This document defines safety execution boundaries, permission rules, and human approval gates for the Hermes multi-role task management system V2. It depends on Phase 1A data model design, Phase 1B task state machine design, Phase 1C task breakdown rules, and Phase 1D Feishu Bitable design.

This phase only produces documentation. It does not run database changes, does not create migration files, does not modify business code, does not modify Worker code, does not modify API routes, and does not modify `.gitignore`.

## 1. Current System Safety Risk Analysis

The current system can execute useful MVP work, but several risks must be controlled before V2 automation becomes broader:

- One task row can mix request text, execution state, Git output, Feishu locators, and error details, so an agent may over-trust incomplete context.
- Worker and Codex responsibilities can blur when Git, validation, file edits, and reporting are all described in the same prompt.
- Feishu rows are visible to operators, but manual edits are not yet a canonical approval workflow.
- Database, API, Worker, and deployment changes have different blast radiuses but are not always separated into different review gates.
- Retry and rollback behavior is not yet fully represented as first-class operational policy.
- Secrets, environment variables, Feishu app credentials, Supabase keys, and production deployment permissions must remain outside automated edits.
- A task that appears small can become risky if it touches foundational files, production state, or self-modifying Worker logic.

V2 safety policy therefore uses explicit allowed scopes, forbidden actions, human decisions, audit events, and Feishu-visible approval surfaces.

## 2. Agent Automated Execution Permission Boundary

An agent may execute only within the task's explicit scope. The permission boundary is defined by:

- Allowed file paths or directories.
- Forbidden file paths or directories.
- Task type, such as design-only, code implementation, validation, review, or rollout planning.
- Risk level.
- Required human decision records.
- Current task status and attempt ownership.
- Worker policy for Git, validation, and result packaging.

Default boundary rules:

- If a task says "documentation only", the agent must not modify source code, Worker code, API routes, migrations, configuration, or environment files.
- If a task lists one allowed file, the agent must treat all other files as read-only.
- If a task needs broader edits than allowed, the agent must stop and request approval instead of expanding scope.
- If a task conflicts with repository rules or Worker rules, the stricter rule wins.
- If a task is ambiguous, the agent must ask a human decision question and move the task into a blocked or human-waiting state.

## 3. Automatically Allowed Operation List

The following operations can be automated when the task explicitly permits them and no higher-risk rule applies:

- Read repository documentation and source files required for context.
- Create or update documentation files inside the allowed path.
- Make small code edits inside explicitly allowed application files.
- Run local read-only inspection commands.
- Run local validation commands such as lint, build, typecheck, tests, or document checks.
- Produce summaries, review notes, and validation results.
- Report changed files and residual risks.
- Update task progress through the Worker-owned reporting channel.
- Queue Feishu display updates through the approved outbox model in later implementation phases.

Automation is allowed only when it is reversible or reviewable, does not touch production state, does not reveal secrets, and stays within the task's allowed scope.

## 4. Forbidden Automated Operation List

Agents must not automatically perform these operations:

- Modify production environment variables.
- Modify local or remote secret files.
- Read, print, copy, or store secret values except when the user explicitly provides a non-secret placeholder for documentation.
- Delete production data or external system resources.
- Trigger production deployment.
- Change Supabase table structure or RLS behavior without an approved migration phase.
- Modify Worker self-execution, queue claiming, retry, or Git behavior without approval.
- Modify API routes when the task is documentation-only or design-only.
- Modify `.gitignore`, GitHub workflow policy, CODEOWNERS, or package dependency files without approval.
- Bypass validation, remove tests, or weaken safety checks.
- Perform broad user messaging fan-out.
- Push to protected branches or merge pull requests.
- Continue after detecting disallowed file modifications.

## 5. Operations That Must Receive Human Approval

The following operations require a `human_decisions` record before execution:

- Any database schema or RLS policy change.
- Any data migration, backfill, data deletion, or bulk update.
- Any production deployment or production rollback.
- Any Git push outside the Worker-approved branch policy.
- Any dependency addition or dependency upgrade with meaningful risk.
- Any Worker self-modification.
- Any API route contract change.
- Any Feishu app token, table, field, view, webhook, or permission change.
- Any Supabase project, table, policy, key, or service-role related change.
- Any deletion of source, config, migration, data, or documentation files.
- Any task where multiple reasonable product choices exist.
- Any task where validation fails but a human might still accept the risk.

Approval must be requested before the risky operation begins, not after the operation is completed.

## 6. Database Change Approval Rules

Database changes are high-risk because they can alter production data, compatibility, and Supabase access behavior.

Rules:

- Design documents may describe intended database concepts without executing changes.
- Migration implementation must be a separate approved task.
- Every database change request must include purpose, affected tables, affected environments, compatibility plan, rollback plan, validation plan, and expected downtime.
- Production data changes require owner approval even if the technical change is small.
- Backfills must be idempotent and bounded.
- Any change that can affect mock or real Supabase dual-mode behavior must be reviewed by a human.
- The agent must not generate or run database execution files in this phase.

## 7. Git Operation Approval Rules

Git operations are split between safe inspection, Worker-owned automation, and human-approved actions.

Allowed without approval:

- Inspect current branch and working tree state.
- View diffs for files in scope.
- Report changed files.

Requires Worker policy or human approval:

- Staging files.
- Creating commits.
- Creating branches.
- Rewriting branch history.
- Resetting, cleaning, or discarding changes.
- Merging, rebasing, cherry-picking, or resolving interrupted Git operations.

Rules:

- The Worker owns commit and push actions when the Worker policy says so.
- Codex must not perform Git write actions when a task explicitly delegates them to the outer Worker.
- If the working tree contains unexpected files, the task must stop or request a human decision before continuing.

## 8. GitHub Push Approval Rules

GitHub push actions can publish code and trigger external automation, so they must be gated.

Rules:

- Push target must match the task policy.
- Protected branches must not be pushed directly.
- Feature branches must have a clear task name and base branch.
- Push must happen only after validation and changed-file checks pass.
- A push that would trigger deployment must follow the deployment approval rules.
- Force push is forbidden unless an approved recovery workflow explicitly permits force-with-lease.
- GitHub writes through app or API tools must follow the same approval policy as command-line Git writes.

When the Worker owns GitHub publishing, Codex reports readiness and does not push.

## 9. Deployment Release Approval Rules

Deployment rules separate preview visibility from production release authority.

Rules:

- Preview deployment may be observed or reported if triggered by normal branch workflow.
- Production deployment requires an explicit production gate decision.
- A release request must include commit, branch, environment, validation results, risk level, rollback plan, and owner approval.
- Failed deployment must create visible blocker context when it blocks review or release.
- A ready preview is not sufficient proof that a task is complete.
- Production release must not be triggered from Feishu manual fields alone in this design phase.

## 10. File Deletion Approval Rules

File deletion is risky because it can silently remove tests, docs, safety rules, or compatibility behavior.

Rules:

- Deleting any tracked file requires human approval unless the task specifically and narrowly authorizes that exact deletion.
- Deleting tests, safety docs, workflows, configuration, migrations, or environment templates requires explicit owner approval.
- Generated artifacts may be removed only when the task allows cleanup and the files are clearly generated.
- Before deletion, the agent must report the path, reason, replacement if any, and validation plan.
- If deletion is discovered after the fact and was not approved, the attempt fails and rollback rules apply.

## 11. Environment, Key, Token, And App Secret Prohibition Rules

Secrets must remain outside the repository and outside Feishu display fields.

Forbidden:

- Writing real secrets into source files, docs, logs, Feishu fields, GitHub comments, or task events.
- Printing full secret values in validation output.
- Committing `.env`, `.env.local`, private key files, access tokens, service-role keys, app secrets, or webhook secrets.
- Changing production environment variables through automation.
- Copying secrets between GitHub, Vercel, Feishu, Supabase, or local files.

Allowed:

- Mentioning variable names.
- Documenting where a human should configure secrets.
- Using obvious placeholders that cannot be mistaken for real credentials.

If a secret appears in a diff or log, the agent must stop, report the exposure, and wait for human remediation.

## 12. Feishu Configuration Change Approval Rules

Feishu is an operator surface, not the canonical source of truth.

Approval required for:

- App token changes.
- Table ID or field ID changes.
- Bitable schema changes.
- Webhook subscription changes.
- Bot permission changes.
- Message fan-out changes.
- Manual reply ingestion behavior.

Rules:

- Read-only display design can be documented without changing Feishu.
- Manual Feishu fields must not directly mutate canonical state unless a later approved reader workflow consumes them.
- Feishu sync failure must not block canonical task execution.
- Feishu rows must not display secrets, claim tokens, raw large logs, or sensitive prompts.

## 13. Supabase Table Structure Change Approval Rules

Supabase structure changes require a separate implementation phase and human approval.

Required approval packet:

- Affected canonical tables or policies.
- Reason for the change.
- Compatibility with V1 `hermes_jobs`.
- Impact on mock mode and real Supabase mode.
- RLS and service-role implications.
- Migration order.
- Rollback strategy.
- Validation commands.
- Production risk level.

Rules:

- Design phases can name target tables and fields.
- Implementation phases must not mix table structure changes with unrelated UI or Worker edits unless approved.
- No production table structure change may run from an ambiguous task.

## 14. Worker Self-Modification Approval Rules

Worker self-modification is critical because it changes the automation that controls future tasks.

Approval required for:

- Claim logic.
- Lease and heartbeat logic.
- Allowed-file enforcement.
- Git staging, commit, push, or branch behavior.
- Validation command execution.
- Rollback behavior.
- Feishu sync processing.
- Prompt construction.
- Secret handling.

Rules:

- Worker changes must be isolated in their own task package.
- The approval request must describe old behavior, new behavior, risk, fallback, and test plan.
- A Worker change must not deploy itself to production execution without a separate release gate.

## 15. API Route Modification Approval Rules

API routes can expose data, mutate state, and change external contracts.

Approval required for:

- New API routes.
- Changes to request or response shape.
- Authentication or authorization changes.
- Routes that write task state, human decisions, deployment state, or Feishu sync state.
- Routes that read or write Supabase with elevated credentials.

Rules:

- API route work must include contract summary, validation plan, and compatibility notes.
- API changes that affect Worker behavior must coordinate with Worker approval.
- API changes that affect Feishu display or manual decisions must coordinate with Feishu approval.

## 16. Production Risk Level Classification

V2 uses four risk levels:

| Level | Meaning | Examples | Default gate |
| --- | --- | --- | --- |
| `low` | Local, reversible, documentation or isolated UI change. | Design docs, copy changes, narrow non-production edits. | Agent may execute within scope. |
| `medium` | Code change with limited blast radius and normal validation. | Isolated component, non-critical helper, test-only change. | Review or validation gate. |
| `high` | Foundational behavior or external integration risk. | Worker logic, API route, Feishu sync, database compatibility, dependency change. | Human approval before execution. |
| `critical` | Production data, secrets, deployment, permissions, or irreversible operation. | Production release, destructive data action, secret handling, RLS change. | Explicit owner approval and rollback plan. |

Risk escalation rules:

- Any secret or production environment touch becomes `critical`.
- Any database structure change is at least `high`.
- Any production deployment is `critical`.
- Any ambiguous task with high blast radius must be treated as `high` or `critical` until clarified.

## 17. Human Decision Question Format

Human decision questions must be concise, specific, and action-oriented.

Required format:

- Task: short task title and ID when available.
- Risk level: `low`, `medium`, `high`, or `critical`.
- Blocking issue: one sentence.
- Proposed action: what the agent wants to do.
- Impact: affected files, tables, services, or users.
- Options: 2 to 4 choices, including a safe default.
- Recommended option: only when the recommendation is clear.
- Expiry: when the decision times out, if applicable.
- Default if no answer: the safe behavior.

Example skeleton:

```markdown
任务：<task title>
风险等级：<level>
问题：<why automation cannot decide>
拟执行操作：<specific operation>
影响范围：<files/services/data/users>
选项：
A. 批准执行
B. 拒绝并停止
C. 修改范围后再执行
建议：<safe recommendation>
超时默认：不执行，保持 blocked
```

## 18. Recording Approvals In `human_decisions`

Approvals are recorded as first-class decision records, not only as chat text.

Recommended fields:

- `decision_type`: approval, rejection, clarification, review, risk acceptance, or production gate.
- `status`: requested, approved, rejected, answered, cancelled, or expired.
- `question`: exact prompt shown to the human.
- `options`: structured choices.
- `decision_text`: final answer or approval summary.
- `requested_by_agent_id`: actor that requested the gate.
- `decided_by_agent_id`: human or delegated approver.
- `external_channel`: Feishu, GitHub, manual, or API.
- `external_message_id`: trace to the visible prompt.
- `expires_at`: optional deadline.
- `resolved_at`: final resolution timestamp.
- `metadata`: risk level, affected resources, validation evidence, and rollback reference.

Rules:

- A task may continue only after the matching unresolved decision becomes approved or answered with enough information.
- Rejections must include whether the task is cancelled, revised, or returned to queue.
- Expired decisions must not be treated as approval.

## 19. Feishu Questions And Decisions Table Display

The Feishu Issues And Decisions table should make approvals visible and safe to answer.

Display fields:

- Decision ID.
- Project key.
- Task title.
- Decision type.
- Decision status.
- Risk level or severity.
- Question.
- Options.
- Recommended option.
- Response choice.
- Response text.
- Response submitted.
- Blocking reason.
- Expires at.
- Resolved at.
- Related commit, PR, preview, or deployment reference when applicable.

Display rules:

- Canonical fields are read-only.
- Manual response fields are input only until a later approved reader consumes them.
- A submitted response must be validated against the unresolved decision.
- Invalid or stale responses should show a validation message instead of changing task state.
- Approval rows should appear in views for awaiting boss, blocking issues, review decisions, and expiring soon.

## 20. `blocked`, `waiting_review`, And `changes_requested` Approval Coordination

V2 uses canonical task states from the Phase 1B state machine and may expose display aliases in Feishu.

Rules:

- `blocked` is a display condition for tasks that cannot proceed. Canonical status should normally be `awaiting_human`, `failed`, or another state with a blocking reason.
- `waiting_review` is a display alias for canonical `awaiting_review`.
- `changes_requested` is a review outcome, not a permanent execution state by itself.
- When review asks for changes, the human decision should record rejection or requested changes, and the task should move to `retrying`, `queued`, `awaiting_human`, or `failed` based on policy.
- A task in `awaiting_human` must not be claimed by a Worker until the required decision is resolved.
- A task in `awaiting_review` must not be marked `succeeded` until review and required gates are closed.

## 21. Default Behavior When An Agent Is Uncertain

When uncertain, the agent must choose the safest non-destructive behavior.

Default rules:

- Stop before making the risky change.
- Preserve current files and state.
- Report the uncertainty clearly.
- Ask one focused human decision question.
- Mark or request the task as blocked through the appropriate Worker/Hermes channel.
- Do not infer approval from silence.
- Do not widen file scope.
- Do not substitute a product decision with an implementation guess.

If uncertainty is about secrets, production data, deployment, Git publishing, or Worker self-modification, treat the task as high or critical risk.

## 22. Automatic Rollback Rules

Rollback is allowed only for changes the current attempt made and only when the rollback operation itself is safe under policy.

Automatic rollback may apply when:

- The agent modified a disallowed file.
- Validation proves the attempt output is unusable.
- A generated file was created outside allowed scope.
- A task is cancelled before commit or publish.

Automatic rollback must not:

- Delete user-authored changes.
- Reset unrelated files.
- Rewrite published history.
- Undo production data or deployment state without human approval.
- Hide the failure from audit logs.

Rollback reporting must include:

- Trigger reason.
- Files affected.
- Whether rollback fully succeeded.
- Remaining manual cleanup if any.
- Follow-up decision needed if rollback is unsafe.

## 23. Approval Timeout Handling Rules

Decision timeouts prevent tasks from waiting forever while avoiding unsafe implied approval.

Rules:

- Each high or critical gate should define `expires_at` when possible.
- Expired approvals become `expired`, not approved.
- On timeout, the task remains blocked, moves to `awaiting_human`, or becomes `cancelled` according to task policy.
- The safe default is no execution.
- Feishu should show expired decisions in a dedicated view.
- Retry after timeout requires a fresh decision or explicit owner policy.
- Timeout handling must emit an audit event in later implementation phases.

## 24. Example: Requesting Boss Approval Before Database Migration

Example decision question:

```markdown
任务：Hermes V2 数据模型迁移准备
风险等级：critical
问题：该操作会改变 Supabase 结构并可能影响 V1/V2 兼容行为，自动化不能自行决定。
拟执行操作：在单独迁移阶段应用已审核的数据模型变更。
影响范围：Supabase 结构、RLS 策略、Worker 读写路径、Feishu 同步展示。
选项：
A. 批准在 staging 环境先执行，并要求回滚方案
B. 暂停迁移，只保留设计文档
C. 修改迁移范围后重新提交审批
建议：A，仅限 staging，且先完成备份和验证清单
超时默认：不执行，保持 blocked
```

Expected record behavior:

- Create a `human_decisions` row with `decision_type = production_gate` or `risk_acceptance`.
- Set task status to `awaiting_human`.
- Show the row in Feishu Issues And Decisions.
- Continue only after approval is recorded.

## 25. Example: Requesting Boss Approval Before Deployment Release

Example decision question:

```markdown
任务：Hermes V2 发布到生产环境
风险等级：critical
问题：生产发布会影响真实用户和线上任务执行，必须由老板确认。
拟执行操作：将已验证的提交发布到 production。
影响范围：线上站点、Worker 可见行为、Feishu 展示、后续任务入口。
验证结果：lint/build/typecheck 通过，预览环境已验收。
选项：
A. 批准生产发布
B. 拒绝发布并保持当前版本
C. 要求补充验证后重新申请
建议：C，若还有未完成验收项；否则 A
超时默认：不发布，保持 waiting_review
```

Expected record behavior:

- Create a `human_decisions` row with `decision_type = production_gate`.
- Keep task in review or human-waiting status until resolved.
- Record deployment decision, approver, time, commit, preview link, and rollback reference.
- Do not treat preview readiness as production approval.

## 26. Non-Execution Rule For This Phase

Phase 1E is documentation-only.

This phase does not:

- Execute database statements.
- Create migration files.
- Modify application code.
- Modify Worker code.
- Modify API routes.
- Modify `.gitignore`.
- Change production data.
- Change Supabase RLS policies.
- Change Feishu table schemas directly.
- Trigger Feishu API writes.
- Trigger production deployment.
- Perform Git staging, commit, push, branch creation, merge, rebase, or cherry-pick operations from Codex.

The output of Phase 1E is only `docs/upgrade/v2-safety-and-approval-rules.md`. Later phases can separately review and approve database changes, API contracts, Worker behavior, Feishu sync readers, Git publishing, deployment gates, and rollback automation.
