# V3C Manual Test Plan

## Test Case 1: Approve A Website Demand

Step 1 input:

```text
新需求：做同城搭子网站首页
```

Step 2 input:

```text
批准建议
```

Expected:

- Step 1 receives a Project Director confirmation reply.
- Step 2 receives `【项目总管：任务树草案】`.
- The reply includes MVP scope, out-of-scope items, seven stage counts, first suggested tasks, and the approval prompt.
- The demand state is represented in `hermes_messages` as `waiting_task_tree_review`.
- No Codex executable task is created.
- No website task tree draft enters the Worker queue.

## Test Case 2: Approve The Task Tree

Input:

```text
批准任务树
```

Expected:

- Feishu receives:

```text
已收到任务树审核意见。下一阶段将进入任务分发准备。
```

- No task is dispatched.
- No `hermes_jobs` row is inserted for product, UI, frontend, backend, testing, operations, or Codex execution.

## Test Case 3: Request Task Tree Changes

Input:

```text
修改任务树：先不要做登录
```

Expected:

- Feishu receives:

```text
已收到任务树审核意见。下一阶段将进入任务分发准备。
```

- The current stage only records or acknowledges the review/change request.
- Re-generation or application of the change is reserved for Phase 3D.
- No task is dispatched.

## Test Case 4: System Upgrade Demand

Input:

```text
新需求：执行系统升级阶段 3D
```

Expected:

- The message does not enter the website task tree draft flow.
- It continues through the existing Hermes system-upgrade path.
- No `【项目总管：任务树草案】` reply is generated for this system upgrade demand.

## Check No Queued Website Execution Task

Use a human-operated read-only Supabase check:

```sql
select id, status, request_text, created_at
from hermes_jobs
where status in ('queued', 'pending')
order by created_at desc
limit 20;
```

Expected:

- No new `queued` or `pending` row contains `做同城搭子网站首页`.
- No row contains the task tree summary or `PROJECT_DIRECTOR_TASK_TREE_DRAFT`.

## Check Worker Did Not Claim The Draft

Use a human-operated read-only Supabase check:

```sql
select id, status, claimed_by, claimed_at, started_at, request_text, created_at
from hermes_jobs
order by created_at desc
limit 20;
```

Expected:

- No website/product task tree draft has `claimed_by` set.
- No website/product task tree draft has `status = running`.
- No website/product task tree draft has `started_at` set.

## Check Draft Persistence

Use a human-operated read-only Supabase check:

```sql
select role, name, content, created_at
from hermes_messages
where content like '%PROJECT_DIRECTOR_TASK_TREE_DRAFT%'
order by created_at desc
limit 5;
```

Expected:

- A `system` message exists with `name = project_director_task_tree_draft`.
- The content contains `state: waiting_task_tree_review`.
- The content contains original demand, boss confirmation, Feishu summary, and full task tree JSON.

## Notes

- This plan does not require SQL execution by Codex.
- The SQL snippets are read-only manual checks for a human operator.
- V3C does not deploy, does not modify Worker, does not modify database schema, and does not install dependencies.
