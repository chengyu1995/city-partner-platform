# V3E Implementation Notes

## 1. 本阶段实际修改文件

- `src/lib/project-director-intake.ts`
- `src/lib/project-director-job-builder.ts`
- `src/app/api/feishu/event/route.ts`
- `docs/upgrade/v3e-implementation-notes.md`
- `docs/upgrade/v3e-manual-test-plan.md`

## 2. “批准分发第 1 批”的识别路径

飞书入口仍是：

- `src/app/api/feishu/event/route.ts`
- HTTP path: `POST /api/feishu/event`

识别函数仍在：

- `src/lib/project-director-intake.ts`
- `isDispatchBatchApprovalReply(text)`

本阶段支持这些老板回复：

- `批准分发第 1 批`
- `批准第 1 批`
- `开始第 1 批`
- `分发第 1 批`
- `先做产品规划`
- `开始产品规划`

`新需求：执行系统升级阶段 3E` 仍会先被 `isSystemUpgradeDemand()` 排除出网站项目分发流程，继续走原 Hermes 系统升级路径。

## 3. 待分发清单读取方式

读取函数在：

- `src/app/api/feishu/event/route.ts`
- `findRecentDispatchPlanDraft()`

读取条件：

- table: `hermes_messages`
- `conversation_id = 当前会话`
- `name = project_director_dispatch_plan_draft`
- `role = system`
- content 包含 `PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT`
- content 包含 `state: waiting_dispatch_approval`

解析方式：

- 从 system message 的 `dispatch_plan_json:` 到 `summary:` 之间截取 JSON。
- 解析为 `ProjectDirectorDispatchPlanDraft`。
- 只取最近 10 条候选记录中的第一条可解析清单。

## 4. BATCH-01 提取逻辑

提取函数在：

- `src/lib/project-director-job-builder.ts`
- `buildBatch01ProductPlanningJobs(plan)`

筛选规则：

- `dispatch_batch` 必须是 `BATCH-01`。
- `role` 必须是 `product_manager` 或 `project_director`。
- `output_files` 必须全部位于 `docs/product/` 或 `docs/upgrade/`。
- 默认产品规划 4 个任务的输出会归一化为：
  - `docs/product/prd.md`
  - `docs/product/page-list.md`
  - `docs/product/user-flow.md`
  - `docs/product/acceptance-criteria.md`

## 5. hermes_jobs 写入字段

写入函数在：

- `src/lib/project-director-job-builder.ts`
- `insertBatch01ProductPlanningJobs()`

首选写入字段包括：

- `source = project_director`
- `job_type = product_planning`
- `job_id = task_code`
- `title`
- `description`
- `priority = 10`
- `acceptance`
- `executor = product_manager`
- `repo = city-partner-platform`
- `prompt`
- `request_text`
- `status = queued`
- `plan_status = approved`
- `workflow_stage = execution`
- `claimed_by = null`
- `claimed_at = null`
- `started_at = null`
- `project_id`
- `parent_task_id = null`
- `task_code`
- `dispatch_batch = BATCH-01`
- `payload`

由于当前 `hermes_jobs` 存在历史 schema drift，本阶段 insert 使用缺列兼容策略：如果 Supabase 返回缺列错误，则移除该字段后重试同一批 rows。不会新增数据库结构，不执行 SQL。

每条 `request_text` 都包含：

- 项目名称
- 批次
- 任务编号和标题
- 执行角色：产品经理 `product_manager`
- 输入
- 输出文件
- 验收标准
- 明确禁止修改业务代码、Worker、API、数据库 SQL、执行 SQL、连接 Supabase、部署、`.env`、`.gitignore`
- 完成后自查要求

## 6. 去重策略

优先检查：

- `hermes_messages`
- `name = project_director_dispatch_batch`
- content 包含 `PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD`
- content 包含 `state: dispatched`
- content 包含 `batch_code: BATCH-01`

如果已经存在，回复：

```text
第 1 批产品规划任务已经分发过，不会重复创建。
```

补充检查：

- `hermes_jobs`
- `source = project_director`
- `status in (queued, pending, running)`
- `request_text` 包含对应 `任务编号：{task_code}`

如果已存在同批任务，同样不重复插入。

## 7. 为什么只会分发产品规划任务

本阶段只读取 `BATCH-01`。

写入前还会二次过滤：

- 角色必须是产品规划相关角色。
- 输出必须是文档路径。
- request_text 明确只允许产品经理输出产品文档。
- 默认产物限定为 `docs/product/` 下 4 个产品规划文件。

## 8. 为什么不会分发 UI/前端/后端/测试/部署任务

这些任务在待分发清单中分别位于：

- `BATCH-02` 设计与交互
- `BATCH-03` 技术设计
- `BATCH-04` 开发实现
- `BATCH-05` 测试验收
- `BATCH-06` 部署上线

`buildBatch01ProductPlanningJobs()` 只查找 `batch_code = BATCH-01`，并且每个 task 还必须满足 `dispatch_batch = BATCH-01`。其他批次不会进入 `hermes_jobs` insert rows。

## 9. 为什么 Worker 只会领取批准后的产品规划任务

Worker 领取路径仍是：

- `src/app/api/worker/next/route.ts`

领取条件仍是：

```ts
.from("hermes_jobs")
.select("*")
.in("status", ["queued", "pending"])
```

V3E 之前的网站任务树和待分发清单只保存在 `hermes_messages`，Worker 不会读取。V3E 只有在老板回复第 1 批批准短语，并且找到 `waiting_dispatch_approval` 清单后，才写入 `status = queued` 的 BATCH-01 产品规划任务。因此 Worker 只能在批准后轮询领取这些产品规划任务。

## 10. 本阶段未完成内容

- 未分发 BATCH-02 到 BATCH-06。
- 未创建 UI、前端、后端、测试、部署任务。
- 未修改 Worker。
- 未修改 Codex 执行逻辑。
- 未修改数据库结构。
- 未执行 SQL。
- 未部署。
- 未增加数据库级幂等约束。

## 11. 阶段 3F 建议

阶段 3F 建议只在老板验收第 1 批产品规划产物后进行：

1. 汇总 Worker 执行结果和 4 个产品文档。
2. 让老板确认 PRD、页面清单、用户流程、验收标准。
3. 如老板批准，再设计 BATCH-02 分发规则。
4. BATCH-02 仍应保留人工批准，不自动分发后续开发、后端、数据库或部署任务。
5. 在后续阶段考虑数据库级幂等键，减少运行时重复分发风险。
