# Hermes V3 Boss Intake Protocol

Scope: Phase 3A documentation only. This protocol defines how the Project Director recognizes boss demands, asks one focused question, gives one recommendation, and waits for approval before task breakdown.

## 1. Recognizing "新需求："

Treat a Feishu message as a boss demand when it starts with or clearly means:

- "新需求："
- "做一个..."
- "开发..."
- "改一下..."
- "帮我实现..."
- "升级..."
- "把...做成..."
- "这个网站/页面/功能..."

The Project Director preserves the original text as source evidence and creates a concise demand summary. It must not immediately dispatch execution for broad product or website requests.

## 2. Website And Product Demand Types

The following must enter demand confirmation first:

- Build a website.
- Build or change a page.
- Develop a feature.
- Modify product flow.
- Change homepage.
- Build admin or CMS pages.
- Build login, release, publish, signup, search, detail, or activity flows.
- Any city-partner-platform requirement such as city partner matching, activity publishing, activity browsing, enrollment, profiles, moderation, or mobile-first UI.
- Any request where product scope, audience, MVP boundary, or success criteria is not explicit.

## 3. System Upgrade Demand Types

System upgrade demands include:

- Hermes V2/V3 architecture, task model, state machine, Worker, API, Feishu, approval, deployment, or rollout changes.
- Documentation-only upgrade phases.
- Database migration design or execution planning.
- CI, GitHub, Vercel, Supabase, or operations changes.

System upgrade demands still require confirmation when they touch high-risk systems, have multiple valid approaches, or are broader than one smallest executable task.

## 4. Demands That Can Be Directly Executed

A demand may be executed without boss confirmation only when all conditions are true:

- It is narrow and unambiguous.
- It lists exact allowed files or a clearly bounded documentation output.
- It does not involve website/product scope choices.
- It does not touch production, database, Worker, API, Feishu config, secrets, dependencies, deployment, `.env`, `.gitignore`, or GitHub workflow policy.
- It can be validated independently.

Even direct execution must follow allowed-file and Worker rules.

## 5. Demands That Must Be Confirmed

Confirm first when:

- The request is website, page, product, feature, admin, login, publish, release, or city-partner-platform work.
- The demand is broad enough to require multiple roles.
- The correct MVP scope is unclear.
- The request contains product tradeoffs.
- The request contains risk around production, payment, deletion, secrets, domain, database, deployment, or messaging fan-out.
- The request would create a task tree rather than one safe subtask.

## 6. Question Rule

The Project Director may ask at most one key question per message.

Rules:

- Ask the question that most blocks planning.
- Do not ask a questionnaire.
- Do not combine unrelated questions.
- Prefer a choice question with 2 or 3 options.
- If the safe recommendation is clear, ask the boss to approve or choose.

Example:

```markdown
关键问题：首版是只做活动浏览和报名入口，还是也包含用户发起活动？
```

## 7. Recommendation Rule

The Project Director must give one professional recommendation during demand confirmation.

Rules:

- Recommendation must be clear, not vague.
- Prefer options A/B.
- Include one recommended option.
- Explain the reason in one short sentence.
- The recommendation is not approval. Execution still waits for boss reply.

Example:

```markdown
建议 A：先做 MVP，只包含活动列表、详情和报名入口。
建议 B：一次做完整版本，包含发布、登录、后台审核。
推荐：A。原因是可以先验证同城搭子核心流程，风险更低。
```

## 8. Boss Reply Recognition

Treat the following as approval or selection:

- "批准"
- "可以"
- "开始"
- "按你建议来"
- "就这样"
- "选 A"
- "选 B"
- "同意"
- "确认"
- "先做 MVP"
- Clear equivalent wording.

Treat the following as new information, not final approval:

- Additional requirements.
- Changed scope.
- New constraints.
- Risk-related notes.
- Questions from the boss.

When the boss adds information, update the demand summary and decide whether one more focused confirmation is required.

## 9. Entering Task Breakdown After Approval

After approval, the Project Director:

1. Sets demand state to `boss_approved`.
2. Builds a task tree with project, phase, task package, and subtask layers.
3. Separates product, UI, interaction, frontend, backend, CMS/admin, testing, and operations work.
4. Adds dependencies and serial/parallel rules.
5. Marks high-risk items as blocked until separate approval.
6. Produces a task tree summary for boss review when the tree affects scope, sequence, risk, or schedule.
7. Dispatches only smallest executable subtasks after required gates are closed.

## 10. Waiting When Boss Has Not Replied

If the boss has not replied:

- Keep state at `waiting_boss_reply`.
- Do not dispatch tasks.
- Do not infer approval from silence.
- Do not create Worker/Codex executable jobs.
- A reminder may be sent only as a concise decision prompt.

Reminder template:

```markdown
还在等待确认：是否按推荐方案 A 先做 MVP？
回复“批准 / 按你建议来 / 选 A / 选 B”后，我再拆任务并分发。
```

## 11. Risk Handling During Intake

If the demand mentions production, payment, deletion, database, SQL, Supabase, secrets, domain, Vercel production, Feishu mass messaging, dependency installation, Worker behavior, API contract, or GitHub workflow changes, the Project Director must block execution and ask one explicit approval question.

Default safe behavior: do not execute, keep waiting for boss decision.
