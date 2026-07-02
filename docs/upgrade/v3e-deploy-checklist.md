# V3E Deploy Checklist

## 1. 部署前确认

部署前由人工执行以下检查：

```bash
git status
git branch --show-current
git log --oneline -n 5
```

必须确认：

- `git status` 干净。
- 当前分支是 `master`。
- 本地最新 commit 包含阶段 3B、3C、3D、3E 修改。
- 没有 merge、rebase、cherry-pick、revert 中断状态。
- 没有未提交的业务代码、Worker、SQL、env、gitignore 修改。

## 2. GitHub + Vercel 部署步骤

如果当前项目使用 GitHub + Vercel 自动部署，由人工执行：

```bash
git push origin master
```

注意：

- Codex 不执行 push。
- Codex 不部署。
- 如果 GitHub 自动推送关闭，线上飞书入口不会自动使用本地新逻辑。
- 只有人工推送到正确仓库和正确分支后，Vercel 才会触发对应部署。

## 3. Vercel 检查

推送后等待 Vercel 自动部署完成，并检查：

- 部署状态为成功。
- Vercel Logs 无启动错误。
- `/api/feishu/event` 路由可用。
- 环境变量仍由 Vercel 管理，没有在仓库中新增 `.env`。
- 飞书事件订阅入口指向最新部署域名。

如果 Vercel 部署失败，必须停止进入 3F。

## 4. 飞书线上测试

Vercel 部署成功后，再执行：

- `docs/upgrade/v3e-live-test-script.md`

重点检查：

- 网站新需求能进入项目总管确认。
- 批准建议后生成任务树草案。
- 批准任务树后生成待分发清单。
- 批准分发第 1 批后只新增产品规划任务。
- Supabase 中不新增 UI、前端、后端、测试、部署任务。
- Worker 只执行 `docs/product/` 文档任务。

## 5. 常见异常处理

如果飞书行为仍是旧逻辑：

- 检查是否推送到正确仓库。
- 检查是否推送到 Vercel 绑定分支。
- 检查 Vercel 最新部署 commit 是否等于本地目标 commit。
- 检查飞书事件订阅 URL 是否指向当前 Vercel 项目。
- 检查 Vercel 是否仍在使用旧部署。

如果 Vercel 部署失败：

- 停止进入 3F。
- 查看 Vercel build logs。
- 不要修改生产环境变量。
- 不要直接在线上热修。
- 回到本地修复后重新走人工 review 和部署流程。

如果飞书线上测试失败：

- 停止进入 3F。
- 记录失败步骤、飞书原始消息、Vercel Logs、相关 `hermes_messages` / `hermes_jobs` 只读检查结果。
- 不要手工修改 Supabase 数据绕过流程。

## 6. 进入阶段 3F 条件

只有全部满足以下条件，才允许进入阶段 3F：

- `master` 已由人工推送到正确 GitHub 仓库。
- Vercel 自动部署成功。
- Vercel Logs 无启动错误。
- 飞书线上测试通过。
- `hermes_jobs` 只新增 BATCH-01 产品规划任务。
- 重复批准不会重复创建任务。
- Worker 只执行 `docs/product/` 文档任务。

如果任一条件不满足，阶段状态应保持 `waiting_review`，等待老板决定下一步。
