# Project Director System Complete

## 状态

项目总管多 Agent 系统已完成最终验收，正式进入 production project director mode。

## 最终架构

| 层级 | 组件 | 责任 |
|---|---|---|
| 入口 | 飞书老板消息 | 接收 `新需求：`、`总管`、`验收反馈：` 命令。 |
| 总管 | `project_director` | 理解需求、拆任务、生成任务树、控风险、汇总回报。 |
| 规划 | task tree draft | 记录 planning_only 任务树，不直接创建 Codex 执行任务。 |
| 审批 | boss approval gate | 只有 `总管 批准执行` 才能进入 approved execution。 |
| 分发 | agent dispatch | 按多 Agent 分工写入 Worker 兼容队列。 |
| 执行 | Worker/Codex | 按 allowed_files 修改文件并回报验证。 |
| 回报 | worker report | 带 attempt_id、commit hash、验证结果和项目总管汇总。 |
| 反馈 | acceptance feedback | 项目总管接管反馈、诊断、修复计划、复验回报。 |

## 正式模式规则

- 系统升级已完成，业务需求可以进入规划。
- 普通网站需求仍不能直接进入 Codex。
- 项目总管必须先输出需求理解、MVP 范围、任务拆解、Agent 分工、风险和建议。
- 老板批准前不分发 Worker/Codex 执行任务。
- 老板暂停后不继续分发新任务。
- 已运行中的 Worker 不被强制中断，但后续新分发会被阻塞。

## Agent 分工

- `project_director`：总管，负责理解需求、拆任务、控风险、汇总回报。
- `product_manager`：产品规划、用户流程、MVP 范围。
- `ui_designer`：视觉风格、页面结构、组件状态。
- `interaction_designer`：交互流程、空状态、错误状态、反馈。
- `frontend_developer`：页面和前端逻辑。
- `backend_developer`：接口、数据读写、服务端逻辑。
- `testing_engineer`：验收用例、静态检查、回归测试。
- `operations_engineer`：部署、生产发布、环境检查。

## 审批边界

自动规划可以做：

- 需求理解。
- 产品计划。
- 页面结构建议。
- 多 Agent 分工建议。
- 验收用例建议。

必须老板批准后才能做：

- 写业务代码。
- 修改 API、数据读写或服务端逻辑。
- 修改 UI 页面和组件。
- 分发 Worker/Codex 执行任务。

必须老板额外确认：

- 数据库结构、生产 SQL、RLS。
- `.env`、密钥、生产环境变量。
- production deploy。
- 删除数据。
- 恢复 stash 或隔离的业务页面修改。

## Worker/Codex 边界

- Worker/Codex 只处理 approved execution。
- Worker/Codex 必须遵守 `allowed_files`。
- Worker/Codex 不绕过 `attempt_id`。
- Worker/Codex 不让 `failed` 覆盖 `succeeded`。
- Worker/Codex 不让旧 Worker 覆盖新 Worker 结果。

## 验收反馈闭环

`验收反馈：xxx` 会进入项目总管反馈流程：

1. 总管诊断反馈类型和责任 Agent。
2. 输出最小修复范围和风险。
3. 必要时等待老板确认。
4. 分发 Worker/Codex 修复。
5. Testing Engineer 复验。
6. 总管汇总回报给老板。

## 推荐启动命令

```text
新需求：启动同城搭子网站 MVP 第一阶段，请项目总管先给我产品计划、页面结构、多 Agent 分工和执行建议，先不要写代码，等我批准后再执行。
```
