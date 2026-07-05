# 同城搭子网站 MVP 第一阶段 Agent 分工

## 文档状态

- 阶段：BATCH-P1
- 性质：多 Agent 分工规划
- 约束：本批只写文档，不派生代码实现任务

## 总体协作原则

- 所有 Agent 必须遵守 BATCH-P1 边界。
- 本批只能修改允许的产品规划文档。
- 不允许修改 `/`、`/partners`、`/post` 页面代码。
- 不允许写 UI 代码、改数据库、执行 SQL、修改 `.env`、部署或启动本地 dev server。
- 后续 BATCH-P2 到 BATCH-P5 必须由老板单独批准后才能执行。

## Agent 分工

| Agent | 职责 | BATCH-P1 交付 | 禁止事项 |
| --- | --- | --- | --- |
| `project_director` | 控制范围、拆分批次、定义验收边界 | 最终范围、批次建议、风险边界 | 不直接实现页面或数据库 |
| `product_manager` | 明确用户角色、MVP 功能、页面目标 | 产品范围、页面清单、核心流程 | 不新增未经批准的功能 |
| `information_architect` | 定义页面结构和字段关系 | 页面结构、字段清单、状态概念 | 不写 UI 组件代码 |
| `ui_designer` | 后续负责视觉规范和移动端体验 | 本批只可记录设计输入，不产出 UI 代码 | 不修改页面文件 |
| `interaction_designer` | 后续负责发布、浏览、筛选流程 | 本批只定义流程和状态 | 不实现交互逻辑 |
| `frontend_developer` | 后续负责 Next.js 页面实现 | 本批只阅读文档，不编码 | 不修改 `src/app` 页面 |
| `backend_developer` | 后续负责数据库/API/审核流 | 本批只评估字段可扩展性 | 不改 schema、不执行 SQL |
| `testing_engineer` | 定义验收标准和静态检查项 | BATCH-P1 验收标准 | 不启动 dev server |
| `operations_engineer` | 后续负责预览、部署和环境检查 | 本批只记录部署禁令 | 不部署、不改 env |

## BATCH-P1 协作流程

1. `project_director` 根据老板批准范围锁定本批边界。
2. `product_manager` 输出最终 MVP 范围和页面清单。
3. `information_architect` 输出字段清单和状态字段。
4. `testing_engineer` 输出验收标准。
5. 所有 Agent 共同确认：本批没有业务页面、数据库、环境变量、部署和 dev server 行为。

## 后续批次交接要求

后续任一 Agent 接 BATCH-P2 到 BATCH-P5 时，必须先读取本批 6 份文档，并确认老板单独批准了对应批次。没有批准时，只能做规划或风险说明，不能实现代码。

## 风险控制

- 如果后续任务要求修改 `src/lib/env.ts`、数据库、RLS、`package.json`、`.github/workflows/` 或生产环境变量，必须停下并要求老板单独批准。
- 如果后续出现“联系方式如何公开”“是否强制登录”“是否真实审核”等问题，不能由 Agent 自行拍板。
- 如果本地预览、静态诊断或路由检查失败，只能记录 warning，不能擅自扩大本批修改范围。
