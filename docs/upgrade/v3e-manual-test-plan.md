# V3E Manual Test Plan

## 测试用例 1：完整流程

步骤：

1. 在飞书向 Hermes 发送网站类需求，例如 `新需求：做同城搭子网站 MVP`。
2. 收到项目总管确认后，回复 `批准建议`。
3. 收到任务树草案后，回复 `批准任务树`。
4. 收到待分发任务清单后，回复 `批准分发第 1 批`。

预期：

- 飞书回复 `【项目总管：第 1 批已分发】`。
- `hermes_messages` 新增 `name = project_director_dispatch_batch` 的 system 记录。
- `hermes_jobs` 新增 BATCH-01 产品规划任务。
- 新增任务的 `status` 为 `queued`。
- 新增任务的 `claimed_by` 为 `null`。
- 新增任务的 `request_text` 包含产品经理角色、输出文件、验收标准和禁止事项。
- 新增任务预计输出：
  - `docs/product/prd.md`
  - `docs/product/page-list.md`
  - `docs/product/user-flow.md`
  - `docs/product/acceptance-criteria.md`

## 测试用例 2：重复回复“批准分发第 1 批”

步骤：

1. 在测试用例 1 成功后，再次回复 `批准分发第 1 批`。

预期：

- 飞书回复 `第 1 批产品规划任务已经分发过，不会重复创建。`
- `hermes_jobs` 不新增重复的 BATCH-01 产品规划任务。
- 不出现相同 `task_code` 或相同 `request_text` 标记的重复 queued 任务。

## 测试用例 3：没有待分发清单时回复“批准分发第 1 批”

步骤：

1. 在一个没有完成任务树审核和待分发清单生成的新会话里，直接回复 `批准分发第 1 批`。

预期：

- 飞书回复 `未找到待分发清单，请先完成任务树审核。`
- 不创建 `hermes_jobs`。
- `hermes_messages` 记录 blocked 状态。

## 测试用例 4：检查 hermes_jobs 中没有 UI/前端/后端任务

步骤：

1. 完成测试用例 1。
2. 检查新创建的 `hermes_jobs.request_text`。

预期：

- 不包含 UI 设计任务。
- 不包含前端开发任务。
- 不包含后端开发任务。
- 不包含测试验收任务。
- 不包含部署上线任务。
- 所有新任务都包含 `批次：BATCH-01 产品规划`。

## 测试用例 5：Worker 领取产品规划任务后，只修改 docs/product/

步骤：

1. 等 Worker 轮询领取 V3E 创建的 `queued` 任务。
2. 观察 Worker/Codex 的修改文件清单。

预期：

- Worker 只领取批准后创建的 BATCH-01 产品规划任务。
- Codex 只创建或修改对应 `docs/product/` 输出文件。
- 不修改业务代码。
- 不修改 Worker。
- 不修改 API。
- 不修改数据库 SQL。
- 不执行 SQL。
- 不部署。

## 测试用例 6：新需求：执行系统升级阶段 3F

步骤：

1. 发送 `新需求：执行系统升级阶段 3F`。

预期：

- 不进入网站任务分发流程。
- 不触发 `isDispatchBatchApprovalReply()` 分发路径。
- 不读取待分发清单。
- 不创建 BATCH-01 产品规划 `hermes_jobs`。
- 继续走原 Hermes 系统升级任务处理路径。

## 建议检查项

可在 Supabase 控制台只读检查，不执行结构变更 SQL：

```sql
select id, status, source, job_id, claimed_by, started_at, request_text, created_at
from hermes_jobs
where source = 'project_director'
order by created_at desc
limit 20;
```

重点确认：

- `status` 是 Worker 可领取的 `queued`。
- `claimed_by` 初始为 `null`。
- `request_text` 只允许产品文档任务。
- 没有 BATCH-02 到 BATCH-06 任务。
