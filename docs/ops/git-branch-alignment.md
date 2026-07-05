# Git Branch Alignment

## 本次静态检查结论

在当前工作区执行静态检查得到：

- 当前本地分支：`master`
- `origin/HEAD`：`refs/remotes/origin/main`
- GitHub 远程：`https://github.com/chengyu1995/city-partner-platform.git`

这说明本地 Worker 历史推送 `master` 与远程默认分支 `main` 存在不一致风险。

## 建议统一方案

推荐生产分支使用 `main`，原因：

- `origin/HEAD` 已指向 `origin/main`。
- 项目文档和 GitHub 保护规则主要围绕 `main`。
- Vercel 生产部署通常应绑定 GitHub 默认生产分支，建议人工确认 Vercel Project Settings 中 Production Branch 为 `main`。

## Worker 推送规则

Worker 自动提交推送时不应硬编码 `master`。安全顺序：

1. 优先使用当前领取任务所在分支。
2. 如果需要默认分支，读取 `git symbolic-ref refs/remotes/origin/HEAD`。
3. 如果 `origin/HEAD` 不存在，再读取 GitHub API 的 default_branch 或要求老板确认。
4. 不允许在不确认的情况下把 `main` 和 `master` 混用。

## 项目总管提示

项目总管 `状态` 和 `系统自检` 需要提示：

- 当前推送分支存在 `master` 历史风险。
- 推荐生产分支为 `main`。
- 需要老板确认是否把 Worker 和 Vercel 统一到 `main`。

## 老板选择题

- A. 统一使用 `main`，人工调整 Worker 推送目标和 Vercel Production Branch。
- B. 暂时保持现状，但 Worker 每次推送前输出当前分支和 `origin/HEAD`。
- C. 暂停自动推送，先人工清理 `main/master` 分支关系。
