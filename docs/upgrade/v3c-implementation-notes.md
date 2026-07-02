# V3C Implementation Notes

## 1. Modified Files

- `src/lib/project-director-intake.ts`
- `src/lib/project-director-task-tree.ts`
- `src/app/api/feishu/event/route.ts`
- `docs/upgrade/v3c-implementation-notes.md`
- `docs/upgrade/v3c-manual-test-plan.md`

## 2. Boss Approval Recognition Path

Runtime entry remains:

- `src/app/api/feishu/event/route.ts`
- HTTP path: `POST /api/feishu/event`

The Feishu event route normalizes message text, creates or loads the Hermes conversation, then checks Project Director states before calling the generic `runAgent` loop.

Boss approval phrases are recognized in:

- `src/lib/project-director-intake.ts`
- `isBossApprovalReply(text)`

Recognized approval examples include:

- `批准`
- `开始`
- `可以`
- `按你建议来`
- `同意`
- `选 A`
- `选 B`
- `批准建议`
- `就按这个做`

For approval replies, the route calls `findRecentProjectDirectorDemand()` to confirm that the current conversation recently contains a Project Director confirmation assistant message and a matching website/product user demand. Only then does V3C generate a task tree draft.

## 3. Task Tree Draft Generation Logic

The generator is:

- `src/lib/project-director-task-tree.ts`
- `buildProjectDirectorTaskTreeDraft(originalDemand, bossConfirmation)`

It builds a deterministic draft from:

- original website/product demand
- boss confirmation text
- default city-partner MVP scope
- default out-of-scope list
- seven required stages

The generator does not call LLMs, does not write `hermes_jobs`, does not connect to Supabase directly, and does not dispatch tasks.

## 4. Task Tree Draft JSON Structure

The internal draft uses this stable structure:

```json
{
  "project": {
    "title": "",
    "goal": "",
    "mvp_scope": [],
    "out_of_scope": [],
    "estimated_stages": []
  },
  "stages": [
    {
      "code": "PRODUCT",
      "title": "产品规划",
      "role": "product_manager",
      "task_groups": [
        {
          "code": "PRODUCT-01",
          "title": "PRD 与页面清单",
          "tasks": [
            {
              "task_code": "PRODUCT-01-01",
              "task_title": "",
              "role": "product_manager",
              "input": [],
              "output_files": [],
              "acceptance_criteria": [],
              "dependency_task_codes": [],
              "risk_level": "low",
              "estimated_minutes": 30,
              "can_auto_execute": true
            }
          ]
        }
      ]
    }
  ]
}
```

Stages currently included:

- 产品规划
- UI/视觉设计
- 交互设计
- 前端开发
- 后端开发
- 测试验收
- 部署上线

## 5. Feishu Summary Reply Template

Feishu receives only a compact summary:

```text
【项目总管：任务树草案】
项目：{项目名称}

我建议的 MVP 范围：
1. ...

暂不建议首版做：
1. ...

阶段拆解：
1. 产品规划：x 个子任务
...

首批建议执行任务：
1. 产品经理：输出 PRD
...

关键确认：
是否批准这个任务树草案？
请回复：
* 批准任务树
* 修改任务树：{你的要求}
* 暂停
```

The complete JSON is not sent to Feishu to avoid a long message.

## 6. Draft Persistence

V3C stores the draft through the existing `hermes_messages` mechanism without changing database schema:

- user message: boss approval text
- assistant message: Feishu summary reply
- system message: `PROJECT_DIRECTOR_TASK_TREE_DRAFT`

The system message includes:

- `state: waiting_task_tree_review`
- original demand
- boss confirmation
- Feishu summary
- complete task tree JSON

No new table, column, migration, or SQL execution was added.

## 7. Why Worker Cannot Claim It

The Worker claim route remains unchanged:

- `src/app/api/worker/next/route.ts`

It queries:

```ts
.from("hermes_jobs")
.select("*")
.in("status", ["queued", "pending"])
```

V3C never inserts a website task tree draft into `hermes_jobs`, and never creates `status = queued` or `status = pending` rows for the draft. The draft is stored only as `hermes_messages`, so the Worker has nothing to claim.

## 8. No Dispatch In This Phase

V3C recognizes task tree review replies:

- `批准任务树`
- `同意任务树`
- `按这个拆`
- `开始分发`
- `修改任务树：...`

The route replies:

```text
已收到任务树审核意见。下一阶段将进入任务分发准备。
```

It does not distribute tasks to product, UI, frontend, backend, testing, operations, Codex, or Worker queues.

## 9. Not Completed In V3C

- No task dispatch.
- No role-agent assignment.
- No Worker changes.
- No `hermes_jobs` executable task creation.
- No database schema changes.
- No SQL execution.
- No deployment.
- No task tree revision engine beyond recording the review reply.

## 10. Phase 3D Recommendations

Phase 3D should implement dispatch preparation after task tree approval:

1. Load the latest `PROJECT_DIRECTOR_TASK_TREE_DRAFT` message for the conversation.
2. Validate every subtask has role, input, output, acceptance criteria, dependencies, risk, estimate, and auto-execute flag.
3. Apply boss modification requests before dispatch.
4. Convert only approved smallest subtasks into Worker-visible rows.
5. Keep broad project, phase, and task package nodes out of `hermes_jobs`.
6. Add explicit human gates for backend, deployment, database, Worker, API, dependency, and production-risk subtasks.
