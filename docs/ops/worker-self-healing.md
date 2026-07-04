# Worker Self-Healing

Windows Worker 的自恢复入口：

- `infra/windows-worker/worker-recovery.js`
- `infra/windows-worker/worker-healthcheck.ps1`
- `infra/windows-worker/start-worker.ps1`

## 启动前自检

`start-worker.ps1` 会先调用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/windows-worker/worker-healthcheck.ps1 -StopExistingWorker
```

自检动作：

- 停止残留 Worker、Next dev、Turbopack、Codex 进程。
- 清理 `.next`、`.turbo`、`node_modules/.cache`。
- 还原 Next 自动生成类型文件。
- 检查 `git status --short`。
- 自动清理已知生成文件。
- 遇到未知业务修改时停止。

## Codex 自动重试

`local_worker.js` 执行 Codex 时有三段：

1. 正常执行原始需求。
2. 第 1 次失败后，携带错误摘要和自动分类重新执行。
3. 第 2 次失败后，执行最小化修复提示词。

仍失败时才向老板回报，并给二选一决策，不要求老板手动查日志。

## 本地预览恢复

恢复流程由 `worker-recovery.js recover-preview` 执行：

1. 停止旧 dev 服务。
2. 清理缓存。
3. 优先执行 `npx next dev --webpack -p 3000`。
4. 如果 3000 被占用，自动切到 3001。
5. 访问 `/`、`/post`、`/partners` 做 smoke test。
6. 写入 `infra/windows-worker/logs/local-preview-recovery-report.json`。

手动执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File infra/windows-worker/worker-healthcheck.ps1 -RecoverPreview
```

## 错误分类

Worker 会把错误摘要归类为：

- `turbopack-cache`
- `port-conflict`
- `runtime-500`
- `route-404`
- `code-syntax`
- `dependency-or-import`
- `unknown`

分类只用于自动选择修复提示词和老板回报摘要，不会输出密钥或完整堆栈。
