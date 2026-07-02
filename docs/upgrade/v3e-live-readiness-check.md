# V3E Live Readiness Check

## 1. 当前阶段结论

阶段 3E-V 只做上线前静态验证和部署准备，不修改业务功能、不修改 Worker、不执行 SQL、不连接 Supabase、不部署、不推送 GitHub。

本次检查结论：

- 当前分支：`master`
- 初始工作区：干净
- 未发现 merge / rebase / cherry-pick / revert 中断状态
- 当前 HEAD：`49849b24fe0701528273df7f045bb019c2528467`
- 当前代码历史包含阶段 3B、3C、3D、3E 提交：
  - `df34c76`：阶段 3B，网站需求进入项目总管确认
  - `1af47a3`：阶段 3C，老板批准后生成项目任务树草案
  - `bbdd1cd`：阶段 3D，批准任务树后生成待分发清单
  - `49849b2`：阶段 3E，批准分发第 1 批产品规划任务

结论：本地代码已经具备上线测试准备条件，但如果 GitHub 自动推送关闭，线上飞书入口不会自动使用这些新逻辑。若当前项目依赖 GitHub + Vercel 自动部署，必须由人工确认后执行 `git push origin master`，等待 Vercel 自动部署完成，再做线上飞书测试。

## 2. 3B-3E 功能闭环检查结果

检查范围：

- `src/lib/project-director-intake.ts`
- `src/lib/project-director-task-tree.ts`
- `src/lib/project-director-dispatch-plan.ts`
- `src/lib/project-director-job-builder.ts`
- `src/app/api/feishu/event/route.ts`
- `docs/upgrade/v3e-implementation-notes.md`
- `docs/upgrade/v3e-manual-test-plan.md`

闭环检查：

| 检查项 | 结果 | 依据 |
|---|---|---|
| 新需求网站类识别 | 通过 | `isWebsiteProductDemand()` 要求文本是新需求前缀，并命中网站/产品关键词 |
| 系统升级类需求排除 | 通过 | `isWebsiteProductDemand()` 先调用 `isSystemUpgradeDemand()`，系统升级、Worker、SQL、Supabase、Hermes 等关键词会被排除 |
| 项目总管确认回复生成 | 通过 | 飞书入口命中 `isWebsiteProductDemand(text)` 后调用 `buildProjectDirectorReply()` 并保存到 `hermes_messages` |
| 老板批准建议识别 | 通过 | `isBossApprovalReply()` 识别批准建议类回复 |
| 任务树草案生成 | 通过 | 老板批准后调用 `buildProjectDirectorTaskTreeDraft()` 和 `buildTaskTreeDraftSummary()` |
| 任务树草案保存到 `hermes_messages` | 通过 | `saveTaskTreeDraftReply()` 同时保存 user、assistant 和 `name = project_director_task_tree_draft` 的 system 记录 |
| 老板批准任务树识别 | 通过 | `isTaskTreeApprovalReply()` 在任务树审核路径中识别批准任务树 |
| 待分发清单生成 | 通过 | 批准任务树后调用 `buildProjectDirectorDispatchPlanDraft()` 和 `buildDispatchPlanSummary()` |
| 待分发清单保存到 `hermes_messages` | 通过 | `saveSystemRecordedReply()` 保存 `name = project_director_dispatch_plan_draft` 的 system 记录 |
| 老板批准分发第 1 批识别 | 通过 | `isDispatchBatchApprovalReply()` 识别批准分发第 1 批类回复 |
| 只提取 BATCH-01 | 通过 | `buildBatch01ProductPlanningJobs()` 只查找 `batch_code === BATCH-01` 的 batch，并再次过滤 `task.dispatch_batch === BATCH-01` |
| 只写入产品规划任务到 `hermes_jobs` | 通过 | `buildJobRow()` 写入 `job_type = product_planning`、`executor = product_manager`、`dispatch_batch = BATCH-01` |
| 重复分发保护 | 通过 | 写入前先查 `hasBatch01DispatchRecord()`，再查 `hasExistingBatch01Jobs()`，命中则跳过 |
| 不分发 UI、前端、后端、测试、部署任务 | 通过 | UI/IXD/BACKEND/FRONTEND/TEST/RELEASE 分别位于 BATCH-02 到 BATCH-06，不会被 BATCH-01 提取 |

## 3. 安全检查结果

| 安全项 | 结果 | 说明 |
|---|---|---|
| 网站需求确认阶段不写 `hermes_jobs queued` | 通过 | 该阶段只调用 `saveDirectReply()` 保存消息 |
| 任务树草案阶段不写 `hermes_jobs queued` | 通过 | 该阶段只保存任务树草案到 `hermes_messages` |
| 待分发清单阶段不写 `hermes_jobs queued` | 通过 | 该阶段只保存待分发清单到 `hermes_messages` |
| 只有“批准分发第 1 批”才写 `hermes_jobs queued` | 通过 | 只有 `isDispatchBatchApprovalReply(text)` 分支会调用 `insertBatch01ProductPlanningJobs()` |
| 写入的任务只能是产品规划文档任务 | 通过 | BATCH-01 限制为 `product_manager` / `project_director`，默认输出归一到产品规划文档 |
| `request_text` 明确限制只允许修改 `docs/product/` | 通过 | 构造任务文本中明确写入“只允许写 docs/product/ 下的产品文档” |
| `request_text` 明确禁止修改业务代码、Worker、API、SQL、env、gitignore | 通过 | 构造任务文本列出业务代码、Worker、API、Vercel API、数据库 SQL、`.env`、`.gitignore` 禁止项 |
| `request_text` 明确禁止执行 SQL、连接 Supabase、部署 | 通过 | 构造任务文本列出禁止执行 SQL、禁止连接 Supabase、禁止部署 |
| 重复批准不会重复创建任务 | 通过 | 已有分发记录或已有 queued/pending/running 任务时直接保存 duplicate 记录并返回 |
| 系统升级类新需求不受项目总管网站流程影响 | 通过 | `isSystemUpgradeDemand()` 在网站类需求识别前排除系统升级类文本 |

注意：`project-director-job-builder.ts` 的输出路径过滤允许 `docs/product/` 和 `docs/upgrade/`，但当前默认 BATCH-01 产品规划任务会被归一为 4 个 `docs/product/` 输出文件，并且下发给 Worker 的 `request_text` 明确只允许写 `docs/product/`。上线测试时仍应重点确认实际 `hermes_jobs.request_text` 和 Worker 修改文件范围。

## 4. 是否可以准备上线

可以准备上线测试，但不建议自动上线。

原因：

1. 本地静态闭环通过，`npx tsc --noEmit` 通过。
2. 本阶段没有执行真实飞书接口调用，没有创建 `hermes_jobs` 测试任务。
3. 本阶段没有执行 SQL，没有连接 Supabase 修改数据，没有部署。
4. 若 GitHub 自动推送关闭，线上不会自动生效，必须人工决定是否推送到 GitHub 并等待 Vercel 部署。

建议人工推送命令，仅供人工执行：

```bash
git status
git branch --show-current
git log --oneline -n 5
git push origin master
```

## 5. 上线前仍需人工确认的事项

- 确认 GitHub 自动推送确实关闭，且本次由人工决定是否推送。
- 确认 `master` 是 Vercel 生产或目标环境绑定分支。
- 确认 Vercel 项目绑定的是 `chengyu1995/city-partner-platform` 正确仓库。
- 确认 Vercel 部署完成后，飞书线上入口实际指向最新部署。
- 确认 Supabase 表结构兼容 `insertBatch01ProductPlanningJobs()` 的缺列兼容策略。
- 线上测试时只做一次真实“批准分发第 1 批”，避免无意义创建产品规划任务。

## 6. 不建议进入 3F 的情况

出现任一情况时，不建议进入阶段 3F：

- 当前本地代码尚未人工推送，线上飞书入口仍是旧逻辑。
- Vercel 部署失败或日志存在启动错误。
- 飞书线上测试没有进入项目总管确认流程。
- “批准建议”后没有生成任务树草案。
- “批准任务树”后没有生成待分发清单。
- “批准分发第 1 批”没有创建产品规划任务，或创建了 UI、前端、后端、测试、部署任务。
- 重复批准会重复创建 `hermes_jobs`。
- Worker 领取任务后修改了 `docs/product/` 之外的文件。

## 7. 可以进入 3F 的条件

只有同时满足以下条件，才建议进入阶段 3F：

- 人工确认推送并完成 Vercel 部署。
- Vercel Logs 无启动错误。
- 飞书线上完整测试通过。
- `hermes_jobs` 只新增 BATCH-01 产品规划任务。
- 新增任务的 `request_text` 明确只允许写 `docs/product/`，并禁止业务代码、Worker、API、SQL、env、gitignore、Supabase、部署。
- 重复发送“批准分发第 1 批”不会重复创建任务。
- Worker 后续只执行产品规划文档任务，产物仅限 `docs/product/`。
