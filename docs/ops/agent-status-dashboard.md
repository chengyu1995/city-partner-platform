# Agent Status Dashboard

## 命令

- `新需求：Agent 状态`
- `新需求：Agent 看板`
- `总管 Agent 状态`
- `总管 Agent 看板`

## 展示规则

当前看板从 `src/lib/project-director-agents.ts` 静态配置生成。没有实时 per-agent 任务表时，所有 Agent 标记为 `ready`，并说明 `status_source: static_config_only`。

每个 Agent 展示：

- 角色名称。
- 工作职责。
- 可处理任务类型。
- 禁止事项。
- 当前状态：`ready`。
- 是否需要老板批准才能执行：`yes`。

## 8 个 Agent

| role | 名称 | 核心职责 |
|---|---|---|
| `project_director` | 项目总管 | 识别需求、拆任务树、控制审批边界、汇总结果。 |
| `product_manager` | 产品经理 | 澄清产品目标、MVP 范围、页面和验收标准。 |
| `ui_designer` | UI 设计师 | 定义视觉风格、组件状态、移动端布局。 |
| `interaction_designer` | 交互设计师 | 设计路径、状态流转、表单和异常状态。 |
| `frontend_developer` | 前端开发 | 在批准范围内实现页面、组件、样式和客户端交互。 |
| `backend_developer` | 后端开发 | 实现 API、数据访问层和 Supabase 双轨边界内逻辑。 |
| `testing_engineer` | 测试工程师 | 做静态验证、功能验收、回归检查和反馈复核。 |
| `operations_engineer` | 运维发布工程师 | 做预览、发布检查、Worker 运行和生产发布风险控制。 |

## 状态枚举

- `ready`
- `waiting_plan`
- `waiting_approval`
- `running`
- `blocked`

当前 BATCH-20 实现只使用静态 `ready`；实时状态可在后续增加 Agent assignment 表后扩展。
