# BATCH-19 Final System Acceptance

## 验收结论

BATCH-19 完成。系统升级从 BATCH-14 到 BATCH-19 已收口，项目从“升级冻结期”切换为“正式项目总管模式”。

本阶段不开发任何同城搭子网站业务页面，不恢复 stash 或隔离中的业务页面修改，不修改数据库结构、`.env`、依赖或生产部署配置。

## BATCH-14 到 BATCH-19 完成情况

| Batch | 状态 | 结果 |
|---|---|---|
| BATCH-14 | completed | 完成系统架构冻结、任务归属、上报幂等和 heartbeat 基线。 |
| BATCH-15 | completed | 完成项目总管任务树、多 Agent 角色、调度计划和文件边界。 |
| BATCH-16 | completed | 完成飞书老板控制台命令、attempt_id 模型和 Worker 合约。 |
| BATCH-17 | completed | 完成老板需求、总管拆解、老板批准、Worker 分发、验收回报闭环。 |
| BATCH-18 | completed | 完成全链路假任务静态自测，确认可进入最终验收。 |
| BATCH-19 | completed | 完成最终验收文档、正式运行规则和老板命令清单。 |

## 当前最终架构

```text
Feishu boss message
  -> src/app/api/feishu/event/route.ts
  -> project_director intake and console
  -> task tree draft in hermes_messages
  -> boss approval gate
  -> agent dispatch jobs in hermes_jobs
  -> Worker/Codex execution
  -> /api/worker/report attempt-aware result
  -> Project Director acceptance report
  -> boss acceptance or 验收反馈
```

核心规则：

- 普通网站需求不直接进入 Codex。
- `新需求：xxx` 先进入项目总管 planning。
- 项目总管先输出需求理解、任务拆解、多 Agent 分工、风险和建议。
- 老板发送 `总管 批准执行` 后才分发 Worker/Codex。
- 老板发送 `总管 暂停` 后停止继续分发新任务。
- 老板发送 `验收反馈：xxx` 后由项目总管接管诊断、修复计划和验收回报。

## 老板飞书命令清单

- `新需求：状态`
- `新需求：查看计划`
- `新需求：帮助`
- `新需求：我要做一个 xxx 功能`
- `新需求：修改计划：xxx`
- `总管 批准执行`
- `总管 暂停`
- `总管 恢复`
- `验收反馈：xxx 点不开`
- `验收反馈：xxx 不好看`
- `验收反馈：xxx 报错`

## 多 Agent 正式分工

| Agent | 职责 |
|---|---|
| `project_director` | 总管，负责理解需求、拆任务、控风险、汇总回报。 |
| `product_manager` | 产品规划、用户流程、MVP 范围。 |
| `ui_designer` | 视觉风格、页面结构、组件状态。 |
| `interaction_designer` | 交互流程、空状态、错误状态、反馈。 |
| `frontend_developer` | 页面和前端逻辑。 |
| `backend_developer` | 接口、数据读写、服务端逻辑。 |
| `testing_engineer` | 验收用例、静态检查、回归测试。 |
| `operations_engineer` | 部署、生产发布、环境检查。 |

## Worker/Codex 执行边界

- Worker/Codex 只执行项目总管分发的 approved execution 任务。
- Worker/Codex 只允许修改任务 `allowed_files` 中列出的文件。
- Windows Worker 模式下 Codex 不创建分支、不提交、不推送、不启动 dev server、不打开浏览器。
- Git 提交、推送、PR 和回报由外层 Worker/GitHub 自动链路处理。
- Worker 领取任务时由 `/api/worker/next` 分配 `attempt_id`。
- Worker heartbeat/progress/report 必须回传同一个 `attempt_id`。

## Git/GitHub 自动提交回报规则

- Codex 本体只修改文件和汇报验证结果。
- 外层 Worker 负责 git add、commit、push 和 PR/回报。
- Worker 报告中必须带 `git_commit_sha`，如果尚未提交则标记为 pending outer Worker commit。
- 项目总管回报中汇总改动文件、验证结果、commit hash、风险和是否需要老板验收。

## 验收反馈处理规则

- 老板发送 `验收反馈：xxx` 后，项目总管创建反馈诊断任务。
- 反馈先判断归属：产品、前端、后端、测试或运维。
- 修复只做最小范围，不扩大业务需求。
- 涉及数据库、密钥、生产部署、删除数据时必须再次等待老板确认。
- 修复后由项目总管汇总回报，再等待老板验收。

## 安全规则最终确认

必须保留：

- 不允许绕过老板批准执行复杂任务。
- 不允许绕过 `attempt_id`。
- 不允许 `failed` 覆盖 `succeeded`。
- 不允许旧 Worker 覆盖新 Worker 结果。
- 不允许输出密钥。
- 不允许擅自改 `.env`。
- 不允许擅自改数据库结构。
- 不允许擅自部署生产。
- 不允许删除数据。
- 不允许恢复 stash 中的业务页面修改，除非老板明确批准。

## 仍需老板确认的高风险事项

- 修改数据库结构、RLS、生产 SQL。
- 修改或读取生产密钥、`.env`、Vercel 环境变量。
- 部署 production。
- 删除用户数据或批量修改数据。
- 增加大型依赖或修改基础设施文件。
- 恢复之前 stash 或隔离的业务页面修改。

## 正式开始做网站的推荐第一条飞书需求

```text
新需求：启动同城搭子网站 MVP 第一阶段，请项目总管先给我产品计划、页面结构、多 Agent 分工和执行建议，先不要写代码，等我批准后再执行。
```

## 验收状态

系统已升级完成。业务页面开发可以开始进入规划，但必须先由项目总管拆解并等待老板批准后执行。
