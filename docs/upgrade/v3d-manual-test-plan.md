# V3D Manual Test Plan

## 测试用例 1：网站需求到批准任务树

步骤：

1. 飞书发送网站需求，例如：

```text
新需求：做同城搭子网站首页和发布入口
```

2. 回复：

```text
批准建议
```

3. 系统生成任务树草案后，回复：

```text
批准任务树
```

预期：

- 飞书收到 `【项目总管：待分发任务清单】` 摘要。
- 摘要包含 6 个分发批次及各批任务数量。
- 摘要最多列 6 个首批建议执行任务。
- 摘要要求继续确认：`批准分发第 1 批` / `修改分发清单：{你的要求}` / `暂停`。
- `hermes_messages` 新增 `name = project_director_dispatch_plan_draft` 的 system 记录。
- system 记录包含 `state: waiting_dispatch_approval`。
- 不进入 Codex 执行队列。
- 不创建网站类 `hermes_jobs` queued/pending 执行任务。

## 测试用例 2：修改分发清单

输入：

```text
修改分发清单：先只做产品和 UI
```

预期：

- 飞书回复已记录分发清单修改意见。
- `hermes_messages` 新增 `name = project_director_dispatch_plan_change` 的 system 记录。
- 不分发任务。
- 不写入 `hermes_jobs` queued/pending。
- Worker 不会领取网站任务。

## 测试用例 3：批准分发第 1 批

输入：

```text
批准分发第 1 批
```

预期：

- 本阶段只识别并提示下一阶段处理。
- 飞书回复说明真正分发将在下一阶段处理。
- 不创建 `status = queued` 的网站任务。
- 不调用 Codex。
- 不让 Worker 领取。

## 测试用例 4：系统升级类新需求

输入：

```text
新需求：执行系统升级阶段 3E
```

预期：

- 不进入网站项目总管分发流程。
- 不生成 `【项目总管：待分发任务清单】`。
- 继续走既有 Hermes 系统升级处理路径。

## 如何检查 hermes_jobs 没有新增网站类 queued 执行任务

由人类在 Supabase 控制台执行只读检查：

```sql
select id, status, request_text, created_at
from hermes_jobs
where status in ('queued', 'pending')
order by created_at desc
limit 20;
```

预期：

- 没有新增包含网站需求、任务树草案、待分发清单摘要的 `queued` 或 `pending` 记录。
- 没有 `PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT` 进入 `hermes_jobs`。

## 如何检查 Worker 没有领取网站任务

由人类执行只读检查：

```sql
select id, status, claimed_by, claimed_at, started_at, request_text, created_at
from hermes_jobs
order by created_at desc
limit 20;
```

预期：

- 没有网站待分发清单相关任务被设置为 `running`。
- 没有网站待分发清单相关任务出现 `claimed_by`。
- 没有网站待分发清单相关任务出现 `claimed_at` 或 `started_at`。

## 如何检查待分发清单保存

由人类执行只读检查：

```sql
select role, name, content, created_at
from hermes_messages
where name = 'project_director_dispatch_plan_draft'
order by created_at desc
limit 5;
```

预期：

- 存在 `role = system` 的记录。
- content 包含 `PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT`。
- content 包含 `state: waiting_dispatch_approval`。
- content 包含任务树草案 JSON、待分发清单 JSON 和飞书摘要。

## 注意事项

- Codex 本阶段不执行 SQL。
- Codex 本阶段不连接 Supabase 做结构变更。
- Codex 本阶段不修改 Worker。
- Codex 本阶段不部署。
