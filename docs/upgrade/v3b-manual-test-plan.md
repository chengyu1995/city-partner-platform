# V3B Manual Test Plan

## Test Case 1

Input:

```text
新需求：做同城搭子网站首页
```

Expected:

- Feishu receives a `【项目总管确认】` reply.
- The reply includes one clear A/B recommendation.
- The reply asks only one key question.
- No executable Codex task is created.

## Test Case 2

Input:

```text
新需求：开发登录页面
```

Expected:

- Feishu receives a `【项目总管确认】` reply.
- The reply recommends MVP-first scope.
- The reply waits for `批准建议`, `选 A`, `选 B`, or additional requirements.

## Test Case 3

Input:

```text
新需求：执行系统升级阶段 3C
```

Expected:

- It does not enter website/product confirmation.
- It continues through the existing Hermes system-upgrade path.
- No V3B Project Director website confirmation reply is generated.

## Test Case 4

Input:

```text
批准建议
```

Expected:

- The message is recognized as `boss_approved`.
- Feishu receives:

```text
已收到批准，下一阶段将进入任务树拆解。
```

- No task tree is generated in V3B.
- No task is dispatched to Worker.

## Check No Queued Website Task

Use a read-only Supabase check after sending test case 1 or 2:

```sql
select id, status, request_text, created_at
from hermes_jobs
where status in ('queued', 'pending')
order by created_at desc
limit 20;
```

Expected:

- There is no new `queued` or `pending` row whose text matches the website/page demand.

## Check Worker Did Not Claim Intake

Use a read-only Supabase check:

```sql
select id, status, claimed_by, claimed_at, started_at, request_text, created_at
from hermes_jobs
order by created_at desc
limit 20;
```

Expected:

- No website/product confirmation demand has `claimed_by` set.
- No website/product confirmation demand has `status = running`.
- No website/product confirmation demand has `started_at` set.

## Notes

- V3B does not execute SQL, migrate schema, deploy, or modify Worker code.
- These SQL snippets are manual read-only verification examples for a human operator.
