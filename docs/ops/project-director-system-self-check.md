# Project Director System Self Check

## 命令

- `新需求：系统自检`
- `总管 系统自检`

## 回报内容

系统自检必须返回：

1. 飞书入口是否可用。
2. 项目总管模式是否启用。
3. 是否处于暂停状态。
4. 最近一个老板需求。
5. 最近一个 planning 计划。
6. 最近一个 running 任务。
7. 最近一个 succeeded 任务。
8. 最近一个 failed 任务和失败原因摘要。
9. Worker 最近心跳或 claimed_by 信息，如果当前数据结构支持。
10. Git 分支检查结果。
11. attempt_id 防护是否存在。
12. report 幂等防护是否存在。
13. 当前是否可以开始正式网站规划。
14. 如果发现问题，给老板选择题，不要求老板查底层日志。

## 当前实现

`src/lib/project-director-console.ts` 的 `system_self_check` 分支复用现有 Supabase 查询：

- `hermes_messages`：读取最近计划、分发记录和控制台暂停状态。
- `hermes_jobs`：读取 running/succeeded/failed 任务摘要、claimed_by 和 payload heartbeat。
- 静态安全项：attempt_id、report 幂等、终态防覆盖、旧 Worker 防覆盖。

## 安全边界

系统自检只读查询，不创建 Worker/Codex 任务，不修改业务页面，不修改数据库结构，不部署生产。
