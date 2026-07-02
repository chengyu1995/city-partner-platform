# V3E-P Git 自动推送说明

日期：2026-07-02

## 目标

本阶段为 Windows Worker 增加安全的 GitHub 自动推送能力。Codex 仍然只负责修改文件和汇报结果；Git staging、commit、push 由外层 Worker 执行。

## 当前审计结果

- `git remote -v`：`origin` 已配置为 GitHub 仓库 `chengyu1995/city-partner-platform` 的 fetch/push remote。
- 当前分支：`master`。
- 当前工作区：任务开始前 `git status --porcelain` 为空。
- 最近提交：存在，当前 HEAD 为 `e1b332cdfcb9cdb0b277ffc29cc06087ab629ef1`。
- Git 凭据：本机配置了 Git credential helper；未读取、未输出任何 token 或密钥值。
- Worker 自动备份逻辑：`infra/windows-worker/deploy-worker.ps1`，部署时会备份 Worker 文件到 `C:\city-partner-worker-backups`。
- Worker 自动提交/推送逻辑：`infra/windows-worker/local_worker.js`。
- 自动推送开关来源：环境变量 `GIT_AUTO_PUSH`，此前默认值为 `false`，未配置时自动推送关闭。

## 开关

沿用现有变量名：

```env
GIT_AUTO_PUSH=true
```

关闭：

```env
GIT_AUTO_PUSH=false
```

生产 Worker 的真实 `.env` 只允许保存在运行机器本地，不得提交到仓库。

## 推送目标

本阶段固定只允许：

```powershell
git push origin master
```

即使配置中存在 `GIT_REMOTE_NAME` 和 `GIT_PUSH_BRANCH`，安全检查也要求它们分别为：

```env
GIT_REMOTE_NAME=origin
GIT_PUSH_BRANCH=master
```

如果配置成其他 remote 或 branch，Worker 会拒绝推送。

## 推送前安全检查

`local_worker.js` 在自动推送前必须全部通过以下检查：

- `GIT_AUTO_PUSH=true`。
- `GIT_REMOTE_NAME=origin`。
- `GIT_PUSH_BRANCH=master`。
- `git rev-parse --verify HEAD` 成功。
- 待推送提交必须等于当前 `HEAD`。
- 当前分支必须是 `master`。
- `git status --porcelain` 必须为空。
- `origin` remote 必须存在。

任一检查失败，Worker 不执行 push，并把失败原因写入任务结果。

## 推送失败处理

推送失败时，Worker 不会误报成功，也不会自动 `pull --rebase` 后重试。失败结果会包含：

- 固定失败动作：`git push origin master`。
- 提示老板检查本机 GitHub 凭据和仓库写权限。
- Git 返回的错误摘要。

错误摘要会脱敏常见 GitHub token 和带凭据的 HTTPS URL，避免泄露密钥。

## 如何开启

在生产 Worker 运行目录的本地 `.env` 中设置：

```env
GIT_AUTO_COMMIT=true
GIT_AUTO_PUSH=true
GIT_REMOTE_NAME=origin
GIT_PUSH_BRANCH=master
```

然后重启 Windows Worker 计划任务或 Worker 进程。

## 如何验证

建议先保持 `GIT_AUTO_PUSH=false` 跑一次任务，确认自动提交和结果上报正常。然后设置 `GIT_AUTO_PUSH=true`，用只修改文档或测试文本的小任务验证：

1. Worker 启动前确认工作区干净。
2. 确认当前分支为 `master`。
3. 确认 `origin` remote 存在。
4. 让 Codex 只修改允许文件。
5. Worker 自动提交后执行 `git push origin master`。
6. 在 GitHub 上确认新提交出现。
7. 在 Worker 结果中确认 `GitHub 自动推送：推送成功：origin/master`。

## 当前是否已开启

代码能力已开启，但当前仓库没有可读取的 Worker 本地 `infra/windows-worker/.env`，根目录 `.env` 中也未声明 `GIT_AUTO_PUSH`。因此本地检查结论是：还需要老板在生产 Worker 本地 `.env` 手动设置 `GIT_AUTO_PUSH=true` 并重启 Worker。
