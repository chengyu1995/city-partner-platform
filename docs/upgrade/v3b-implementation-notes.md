# V3B Implementation Notes

## 1. Modified Files

- `src/lib/project-director-intake.ts`
- `src/app/api/feishu/event/route.ts`
- `docs/upgrade/v3b-implementation-notes.md`
- `docs/upgrade/v3b-manual-test-plan.md`

## 2. Feishu Entry Path

The runtime Feishu message entry is:

- `src/app/api/feishu/event/route.ts`
- HTTP path: `POST /api/feishu/event`

This route receives Feishu `im.message.receive_v1` events, handles URL verification, normalizes text, persists conversation messages, and sends Feishu replies.

The Bitable automation entry remains:

- `src/app/api/feishu/requirement/route.ts`
- HTTP path: `POST /api/feishu/requirement`

V3B did not change the Bitable automation route.

## 3. New Demand Parsing Path

V3B adds a focused helper:

- `src/lib/project-director-intake.ts`

The Feishu event route calls this helper after duplicate-job normalization and after creating/loading the Hermes conversation, but before loading LLM history and before calling `runAgent`.

This means website/product demands are handled by deterministic Project Director intake logic instead of being sent to the general Hermes agent loop.

## 4. Website/Product Demand Recognition

A message is treated as `website_product_request` only when:

1. It starts with `新需求：`.
2. It contains one of the configured website/product keywords.
3. It is not excluded as a system-upgrade demand.

Recognized keywords include:

- `网站`
- `页面`
- `首页`
- `功能`
- `产品`
- `登录`
- `注册`
- `后台`
- `CMS`
- `发布`
- `同城搭子`
- `搭子`
- `列表页`
- `详情页`
- `个人中心`
- `支付`
- `聊天`
- `搜索`
- `筛选`
- `用户流程`
- `UI`
- `前端`
- `后端`
- `部署`

## 5. System-Upgrade Exclusion

V3B excludes system-upgrade demands from website/product confirmation when the demand contains system-operation terms such as:

- `系统升级`
- `阶段 3`
- `阶段3`
- `3A`
- `3B`
- `3C`
- `Worker`
- `数据库`
- `SQL`
- `Supabase`
- `飞书接口`
- `Vercel API`
- `Hermes`

Example:

- `新需求：做同城搭子首页` enters Project Director confirmation.
- `新需求：执行系统升级阶段 3C` does not enter website confirmation and continues through the existing Hermes agent path.

## 6. Project Director Reply Template

The runtime reply starts with:

```text
【项目总管确认】
```

It includes:

- A short restatement of the boss demand.
- One clear A/B recommendation.
- A recommended first-version scope with at most 5 items.
- One key question.
- Reply options: `批准建议`, `选 A`, `选 B`, or additional requirements.

The default recommendation is MVP first: pages and core flow before complex recommendation, payment, chat, or admin scope.

## 7. Boss Approval Recognition

V3B recognizes these approval phrases:

- `批准`
- `开始`
- `可以`
- `按你建议来`
- `同意`
- `选 A`
- `选 B`
- `批准建议`
- `就按这个做`

When recognized, the Feishu event route replies:

```text
已收到批准，下一阶段将进入任务树拆解。
```

V3B does not generate or dispatch the task tree.

## 8. Waiting-State Recording

V3B records intake state through the existing conversation messages:

- User message: original boss text.
- Assistant message: Project Director confirmation reply or boss-approved acknowledgement.

No database schema was changed.

V3B intentionally does not write a waiting website demand into `hermes_jobs`.

## 9. Why Worker Will Not Claim It

The Worker claim route is:

- `src/app/api/worker/next/route.ts`

Current claim filter:

```ts
.from("hermes_jobs")
.select("*")
.in("status", ["queued", "pending"])
```

Because the V3B website/product confirmation flow does not insert a `hermes_jobs` row, there is no `queued` or `pending` task for the Worker to claim.

This is safer than writing `status = pending`, because the current Worker would treat that as executable. Existing docs show the historical `hermes_jobs` schema only supports `pending`, `running`, `awaiting_review`, `completed`, and `failed`, and runtime has schema drift around newer columns such as `request_text`, `plan_status`, and `workflow_stage`.

## 10. Not Completed In V3B

- No task-tree generation.
- No task dispatch.
- No Worker changes.
- No Codex invocation changes.
- No database migration.
- No SQL execution.
- No Bitable schema changes.
- No production deployment.

## 11. Phase 3C Recommendation

Phase 3C should add a durable V2/V3 demand-intake table or approved state model before dispatch. Recommended next step:

1. Add a dedicated demand record with `waiting_boss_reply`, `boss_approved`, and task-tree states.
2. Link Feishu message IDs and boss replies to that demand record.
3. Generate a task tree only after `boss_approved`.
4. Dispatch only smallest executable subtasks into Worker-visible queues.
5. Keep `hermes_jobs` limited to executable work, not broad owner demands.
