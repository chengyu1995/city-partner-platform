# 项目索引

## 文档状态

- 整理批次：BATCH-22 项目文件分类和项目档案
- Routing version：BATCH-21-GM-MODE
- 整理日期：2026-07-07
- 本批性质：项目治理、文件分类、项目档案、下一步任务卡
- 本批不做：业务代码、首页设计、产品规划模板、数据库、环境变量、部署

## 使用规则

- 本索引只用于查找当前项目资料和判断执行边界。
- 涉及旧方案、备份、历史模板的内容必须按归档处理，不得作为当前执行依据。
- 运维配置只记录变量名称和用途，不记录真实 token、secret、service key。
- 同城搭子网站继续开发必须从 `docs/NEXT_TASK_CARD.md` 领取下一步，不得跳过老板批准。

## 项目分类总览

| 分类 | 项目 | 当前入口 | 说明 |
| --- | --- | --- | --- |
| 产品项目 | 同城搭子网站 | `docs/projects/city-partner-website.md` | 产品目标、页面结构、P1/P2/P3 文档、继续开发任务卡 |
| 自动化系统项目 | 飞书总经理 / 腾讯云中转 / Worker / Codex / Hermes | `docs/projects/feishu-gm-automation.md` | 飞书总经理模式、Worker 执行链路、Agent 调度、安全检查、回报模板 |
| 运维配置项目 | 腾讯云、PM2、飞书 Webhook、Vercel、Supabase、环境变量 | `docs/projects/ops-config.md` | 只记录配置职责和变量名，不记录真实值 |
| 验收反馈项目 | 批次验收和反馈闭环 | `docs/BATCH_LOG.md`、`docs/ACCEPTANCE_LOG.md` | BATCH-P1/P2/17/18/20/21/22/23/24/27/28 状态归档 |
| 归档项目 | 旧方案、旧模板、旧解析逻辑、备份文件 | `docs/projects/archive.md` | 标记为归档/废弃，不作为当前执行依据 |

## 当前权威文档

| 主题 | 文档 |
| --- | --- |
| 当前状态 | `docs/CURRENT_STATE.md` |
| 决策记录 | `docs/DECISIONS.md` |
| 批次日志 | `docs/BATCH_LOG.md` |
| 验收日志 | `docs/ACCEPTANCE_LOG.md` |
| 故障排查 | `docs/TROUBLESHOOTING.md` |
| 同城搭子网站下一步 | `docs/NEXT_TASK_CARD.md` |

## 产品项目资料

同城搭子网站当前资料集中在 `docs/product/`：

- BATCH-P1：产品范围、页面结构、字段、Agent 分工、批次建议、验收标准。
- BATCH-P2：信息架构、页面文案、状态文案、移动端优先级、验收标准。
- BATCH-P3：已有静态实现说明，记录首页、列表页、发布页和本地草稿流程的完成内容。
- 旧首页 MVP 文档和早期批次文档仅作历史参考，不得直接当作当前执行计划。

## 自动化系统资料

当前自动化系统资料主要分布在：

- `docs/WORKER_ARCHITECTURE.md`
- `docs/ops/`
- `docs/upgrade/`
- `infra/windows-worker/`
- `src/app/api/feishu/*`
- `src/app/api/worker/*`
- `src/lib/project-director-*`
- `src/lib/worker-jobs.ts`

自动化系统当前规则是：需求先进入项目总管 planning，只有老板明确 `总管 批准执行` 后才分发 Worker/Codex 任务。

## 运维配置资料

运维配置资料主要分布在：

- `docs/VERCEL_SETUP.md`
- `docs/VERCEL_ENV_VARS.md`
- `docs/setup-supabase.md`
- `docs/setup-supabase-v2.md`
- `docs/WORKER_ARCHITECTURE.md`
- `infra/windows-worker/README.md`
- `infra/windows-worker/.env.example`

这些文件中如果出现历史示例值或占位值，当前整理只采用变量名和用途。真实值必须从对应平台控制台或本地安全环境读取，不能写入新文档。

## 归档规则

以下内容统一视为归档或历史参考：

- 旧 Vercel 飞书入口方案。
- 旧首页 MVP 模板。
- 旧错误解析逻辑。
- 旧 feishu gateway 备份文件。
- `.bak` 文件和已废弃方案。

归档内容不得继续作为当前执行依据；如需恢复或复用，必须重新开任务并由老板批准。
