# V3D Implementation Notes

## 1. 本阶段实际修改文件

- `src/lib/project-director-intake.ts`
- `src/lib/project-director-task-tree.ts`
- `src/lib/project-director-dispatch-plan.ts`
- `src/app/api/feishu/event/route.ts`
- `docs/upgrade/v3d-implementation-notes.md`
- `docs/upgrade/v3d-manual-test-plan.md`

## 2. 任务树审核识别路径

飞书入口仍是：

- `src/app/api/feishu/event/route.ts`
- HTTP path: `POST /api/feishu/event`

识别逻辑在：

- `src/lib/project-director-intake.ts`

本阶段新增或细化：

- `isTaskTreeApprovalReply(text)`：识别 `批准任务树`、`同意任务树`、`按这个拆`、`开始分发`、`任务树可以`、`就按这个任务树`。
- `isTaskTreeChangeReply(text)`：识别 `修改任务树：`、`调整任务树：`、`先不要做...`、`增加...`、`删除...`、`改成...`。
- `isDispatchPlanChangeReply(text)`：识别 `修改分发清单：...`。
- `isDispatchBatchApprovalReply(text)`：识别 `批准分发第 1 批` / `批准分发第1批`，但本阶段只记录，不真正分发。

`新需求：执行系统升级阶段 3D/3E` 仍会被 `isSystemUpgradeDemand()` 排除出网站项目总管流程，继续走原 Hermes 系统升级路径。

## 3. 待分发清单生成逻辑

新增纯函数模块：

- `src/lib/project-director-dispatch-plan.ts`

流程：

1. 老板回复任务树批准短语。
2. `event/route.ts` 调用 `findRecentTaskTreeDraft()`，从当前 conversation 最近的 `hermes_messages` 中读取：
   - `role = system`
   - `name = project_director_task_tree_draft`
   - content 包含 `PROJECT_DIRECTOR_TASK_TREE_DRAFT`
   - content 包含 `state: waiting_task_tree_review`
3. 从草案记录的 `json:` 后解析任务树草案 JSON。
4. 调用 `buildProjectDirectorDispatchPlanDraft(taskTreeDraft)` 生成待分发清单。
5. 调用 `buildDispatchPlanSummary(plan)` 生成飞书摘要。
6. 调用 `buildDispatchPlanDraftRecord(...)` 保存完整内部记录。

本阶段不会调用 Codex，不会调用 Worker，不会写 `hermes_jobs`。

## 4. 分发批次规则

待分发清单固定生成 6 个批次：

1. `BATCH-01` 产品规划：`PRODUCT`
2. `BATCH-02` 设计与交互：`UI`、`IXD`
3. `BATCH-03` 技术设计：`BACKEND`
4. `BATCH-04` 开发实现：`FRONTEND`
5. `BATCH-05` 测试验收：`TEST`
6. `BATCH-06` 部署上线：`RELEASE`

每个任务从任务树草案的 stage/group/task 转换而来，并补充：

- `stage`
- `task_group`
- `dispatch_batch`
- `requires_boss_approval`
- `blocked_reason`

`src/lib/project-director-task-tree.ts` 的产品规划阶段补充了 `输出用户流程` 和 `输出验收标准`，使新生成的任务树能覆盖首批产品规划默认建议。

## 5. 待分发清单 JSON 结构

内部结构为：

```json
{
  "project": {
    "title": "",
    "goal": ""
  },
  "dispatch_plan": {
    "status": "waiting_dispatch_approval",
    "recommended_first_batch": "BATCH-01",
    "batches": [
      {
        "batch_code": "BATCH-01",
        "title": "产品规划",
        "roles": ["product_manager"],
        "tasks": [
          {
            "task_code": "",
            "task_title": "",
            "role": "product_manager",
            "stage": "",
            "task_group": "",
            "input": [],
            "output_files": [],
            "acceptance_criteria": [],
            "dependency_task_codes": [],
            "risk_level": "low",
            "estimated_minutes": 30,
            "can_auto_execute": true,
            "dispatch_batch": "BATCH-01",
            "requires_boss_approval": false,
            "blocked_reason": ""
          }
        ]
      }
    ]
  }
}
```

## 6. 飞书摘要回复模板

飞书只回复摘要，不发送完整 JSON：

```text
【项目总管：待分发任务清单】
任务树已审核通过，我已生成待分发清单。

项目： {项目名称}

分发批次：
1. 产品规划：x 个任务
2. 设计与交互：x 个任务
3. 技术设计：x 个任务
4. 开发实现：x 个任务
5. 测试验收：x 个任务
6. 部署上线：x 个任务

首批建议执行：
1. 产品经理：输出 PRD
2. 产品经理：输出页面清单
3. 产品经理：输出用户流程
4. 产品经理：输出验收标准
5. UI 设计师：输出设计规范
6. 前端工程师：检查现有页面结构

我建议：
先只批准第 1 批“产品规划”，不要一次让全部 Agent 同时开工。这样可以先把需求、页面和验收标准定清楚，避免后面返工。

关键确认：
是否批准分发第 1 批产品规划任务？
请回复：
* 批准分发第 1 批
* 修改分发清单：{你的要求}
* 暂停
```

## 7. 草案保存方式

继续使用现有安全消息记录机制 `hermes_messages`。

任务树批准后新增 3 条消息：

- user：老板回复，例如 `批准任务树`
- assistant：飞书摘要
- system：完整记录，`name = project_director_dispatch_plan_draft`

system content 包含：

- `PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT`
- `state: waiting_dispatch_approval`
- 原始需求
- 老板确认内容
- 任务树草案 JSON
- 待分发任务清单 JSON
- 飞书摘要

修改任务树或修改分发清单时，也只写 `hermes_messages` 记录修改意见。

## 8. 为什么不会被 Worker 直接领取

Worker 领取路径仍是：

- `src/app/api/worker/next/route.ts`

领取查询仍只查：

```ts
.from("hermes_jobs")
.select("*")
.in("status", ["queued", "pending"])
```

本阶段没有新增任何 `hermes_jobs` insert，也没有创建 `status = queued` 或 `status = pending` 的网站执行任务。待分发清单只保存在 `hermes_messages`，Worker 不会读取。

## 9. 本阶段没有真正分发任务

即使老板回复：

- `开始分发`
- `批准任务树`
- `批准分发第 1 批`

本阶段也只会生成或记录确认，不会：

- 分配给产品、UI、前端、后端、测试、运维 Agent
- 创建 Worker 可领取任务
- 调用 Codex 执行开发任务
- 修改数据库结构
- 执行 SQL
- 部署

## 10. 阶段 3E 建议

阶段 3E 应实现“批准分发第 1 批”后的真正安全分发，但仍建议：

1. 只允许分发 `BATCH-01` 产品规划任务。
2. 分发前再次读取 `PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT`。
3. 只把最小可执行任务写入 Worker 可见队列。
4. 明确区分 `waiting_dispatch_approval`、`dispatch_approved`、`dispatched`。
5. 对后端、数据库、部署、依赖、生产风险任务保留老板二次批准。
6. 写入 `hermes_jobs` 前增加幂等键，避免重复分发。
