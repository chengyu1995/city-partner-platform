# V3E Live Test Script

## 1. 测试前提

本脚本用于人工推送并完成 Vercel 部署后的飞书线上验证。执行前必须确认：

- 当前代码已由人工推送到正确 GitHub 仓库和目标分支。
- Vercel 自动部署已完成。
- Vercel Logs 无启动错误。
- 飞书事件入口实际指向最新 Vercel 部署。
- 本测试会在“批准分发第 1 批”时创建真实 `hermes_jobs` 产品规划任务，因此只应在老板确认后执行。

## 2. 飞书线上主流程

### Step 1：发送网站新需求

发送：

```text
新需求：做同城搭子网站首页
```

预期：

- 项目总管回复需求确认和建议。
- 回复内容应说明这是网站/产品类需求。
- 回复内容应要求老板确认建议。
- 此阶段不应写入 `hermes_jobs queued`。

### Step 2：批准建议

回复：

```text
批准建议
```

预期：

- 项目总管回复任务树草案。
- 任务树草案应包含产品规划、UI、交互、前端、后端、测试、部署等阶段拆分。
- 系统应将任务树草案保存到 `hermes_messages`。
- 此阶段不应写入 `hermes_jobs queued`。

### Step 3：批准任务树

回复：

```text
批准任务树
```

预期：

- 项目总管回复待分发清单。
- 待分发清单应显示第 1 批为产品规划。
- 系统应将待分发清单保存到 `hermes_messages`。
- 此阶段不应写入 `hermes_jobs queued`。

### Step 4：批准分发第 1 批

回复：

```text
批准分发第 1 批
```

预期：

- 系统写入 `hermes_jobs` 产品规划任务，Worker 后续领取。
- 飞书回复第 1 批已分发。
- 返回状态应进入等待 review / 后续验收状态。
- 只允许新增 BATCH-01 产品规划任务。

## 3. Supabase 检查

在 Supabase 控制台只读检查，不执行结构变更 SQL，不修改数据。

建议只读查询：

```sql
select id, status, source, job_type, job_id, executor, dispatch_batch, request_text, created_at
from hermes_jobs
where source = 'project_director'
order by created_at desc
limit 20;
```

必须确认：

- 只新增产品规划任务。
- `status` 为 `queued`，或被 Worker 领取后变为后续运行状态。
- `source` 为 `project_director`。
- `job_type` 为 `product_planning`。
- `executor` 为 `product_manager`。
- `dispatch_batch` 为 `BATCH-01`。
- `request_text` 只允许修改 `docs/product/`。
- `request_text` 明确禁止修改业务代码、Worker、API、SQL、`.env`、`.gitignore`。
- `request_text` 明确禁止执行 SQL、连接 Supabase、部署。
- 不应新增 UI、前端、后端、测试、部署任务。

## 4. Worker 检查

Worker 后续领取任务后，必须确认：

- Worker 只领取 BATCH-01 产品规划文档任务。
- Worker 只应执行 `docs/product/` 文档任务。
- Worker 不应修改业务代码。
- Worker 不应修改 Worker 自身。
- Worker 不应修改 API。
- Worker 不应修改数据库 SQL。
- Worker 不应执行 SQL。
- Worker 不应连接 Supabase 修改数据。
- Worker 不应部署。

## 5. 重复批准检查

在 Step 4 成功后，再次回复：

```text
批准分发第 1 批
```

预期：

- 飞书应提示第 1 批产品规划任务已经分发过，不会重复创建。
- `hermes_jobs` 不应新增重复的 BATCH-01 任务。
- `hermes_messages` 可以新增 duplicate / skipped 记录，用于审计。

## 6. 系统升级排除检查

另起一条新需求或在合适测试会话中发送：

```text
新需求：执行系统升级阶段 3F
```

预期：

- 不进入网站项目总管确认流程。
- 不生成网站任务树。
- 不生成待分发清单。
- 不创建 BATCH-01 产品规划 `hermes_jobs`。
- 继续走原 Hermes 系统升级处理路径。

## 7. 通过标准

满足以下条件才视为线上测试通过：

- 飞书四步主流程全部符合预期。
- `hermes_jobs` 只新增产品规划任务。
- 未新增 UI、前端、后端、测试、部署任务。
- 重复批准不会重复创建任务。
- 系统升级类新需求不会误进入网站项目总管流程。
- Worker 只执行 `docs/product/` 文档任务。
