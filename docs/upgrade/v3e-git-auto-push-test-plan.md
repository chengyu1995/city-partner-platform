# V3E-P Git 自动推送测试计划

日期：2026-07-02

## 范围

验证 Windows Worker 已具备安全自动推送能力，但本阶段不执行真实 `git push`。真实推送应在老板确认 Worker 本地凭据和环境变量后，由外层 Worker 在一次新的最小任务中完成。

## 本阶段已执行检查

- `git remote -v`：已确认 `origin` 存在并指向 GitHub。
- `git branch --show-current`：当前分支是 `master`。
- `git status --porcelain`：任务开始前为空。
- `git rev-parse --verify HEAD`：最近提交存在。
- `git config --get credential.helper`：本机配置了 credential helper，未读取或输出密钥。
- `node -e "require('./infra/windows-worker/local_worker.js')"`：Worker 源码语法加载通过。

## 不执行真实 push 的原因

本阶段目标是“开启能力和文档”，不是推送历史所有提交。根据任务要求，除非已经明确检测到配置允许并且本阶段只推送本次提交，否则不执行真实 `git push`。

当前本地检查结果：

- `infra/windows-worker/.env` 不存在。
- 根目录 `.env` 存在，但未声明 `GIT_AUTO_PUSH`。
- 因此本阶段不满足自动推送配置条件。

## 安全用例

### 1. 默认关闭

配置：

```env
GIT_AUTO_PUSH=false
```

预期：

- Worker 自动提交后不推送。
- 结果显示 `Git 自动推送已关闭`。

### 2. 正常开启

配置：

```env
GIT_AUTO_PUSH=true
GIT_REMOTE_NAME=origin
GIT_PUSH_BRANCH=master
```

前置条件：

- 当前分支是 `master`。
- `git status --porcelain` 为空。
- `origin` remote 存在。
- 最近提交存在。
- 本机 GitHub 凭据具备仓库写权限。

预期：

- Worker 自动提交后执行且只执行 `git push origin master`。
- 推送成功后结果显示 `推送成功：origin/master`。

### 3. 工作区不干净

前置条件：

- `git status --porcelain` 非空。

预期：

- Worker 拒绝推送。
- 结果包含 `工作区不干净，禁止推送`。

### 4. 当前分支不是 master

前置条件：

- 当前分支不是 `master`。

预期：

- Worker 拒绝推送。
- 结果包含 `当前分支必须是 master`。

### 5. remote 配置不安全

配置：

```env
GIT_REMOTE_NAME=upstream
```

预期：

- Worker 拒绝推送。
- 结果包含 `GIT_REMOTE_NAME 必须是 origin`。

### 6. branch 配置不安全

配置：

```env
GIT_PUSH_BRANCH=main
```

预期：

- Worker 拒绝推送。
- 结果包含 `GIT_PUSH_BRANCH 必须是 master`。

### 7. 未配置凭据或权限不足

前置条件：

- 本机 GitHub 凭据不存在、过期或无写权限。

预期：

- Worker 执行 `git push origin master` 失败。
- 任务结果为失败，不误报成功。
- 结果提示老板手工配置 GitHub 凭据。
- 结果不输出 token、密钥或 env 值。

## 建议的下一步人工验证

1. 老板在生产 Worker 本地 `.env` 设置 `GIT_AUTO_PUSH=true`、`GIT_REMOTE_NAME=origin`、`GIT_PUSH_BRANCH=master`。
2. 重启 Worker。
3. 下发一个只改文档或测试文本的小任务。
4. 观察 Worker 自动提交后是否执行 `git push origin master`。
5. 在 GitHub 确认只出现本次任务的新提交。
6. 若推送失败，先配置本机 GitHub 凭据，再重跑最小任务。
