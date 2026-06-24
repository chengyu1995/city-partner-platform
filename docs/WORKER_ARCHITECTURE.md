# Hermes Worker 架构

> 飞书 / 腾讯云中转 / Windows 本地 Codex 协作 完整方案.

## 架构

```
飞书群/私聊
   ↓ HTTPS 事件
腾讯云轻量 (124.156.165.221)
   ├─ /api/feishu/event - 收飞书事件 (现有)
   ├─ /api/worker/next - 本地拉取任务
   ├─ /api/worker/report - 本地回传
   └─ 推飞书群 webhook
   ↓
Supabase (hermes_jobs + hermes_job_results)
   ↑
Windows 本地 (local_worker.py)
   ├─ 每 10 秒拉取 GET /api/worker/next
   ├─ 调 Codex CLI: codex exec "<prompt>" --cd "<cwd>"
   ├─ 提取 PR URL from codex 输出
   └─ POST /api/worker/report { status, output, pr_url, ... }
```

## 任务粒度

B 方案: 1 个需求 = 3-5 个任务 (Hermes 拆, Codex 跑 1 个)

## 超时

- 任务 claim 后 5 分钟超时
- 超时任务自动回 `pending`, 别的 worker 可重跑
- 本地 worker 跑 1 个任务最多 4.5 分钟 (留 30s 给回传)

## 重试

- 失败重试 3 次 (job.max_attempts=3)
- 3 次都失败 -> status=failed, 推飞书群

## 部署清单

### 1. Supabase 跑 SQL

打开 https://supabase.com/dashboard/project/qfubesklrqoqvuufefvq/sql
粘贴 `docs/setup-hermes-jobs.sql` -> Run

### 2. 腾讯云: 装 + 启 worker_api

```bash
# ssh (OrcaTerm 也行)
cd /home/admin/city-partner-agent
# 上传 worker_api.js (用 WinSCP 或 base64 复制)
npm install @supabase/supabase-js express

# 写 .env
cat > .env <<'ENV'
WORKER_TOKEN=<你自己设, 32+ 字符>
SUPABASE_URL=https://qfubesklrqoqvuufefvq.supabase.co
SUPABASE_SERVICE_KEY=<Vercel 一样的 service_role>
FEISHU_BOT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/<your>
PORT=3001
ENV

# 用 dotenv 加载 (装 dotenv-cli 或改 worker_api.js 用 dotenv)
pm2 start worker_api.js --name worker-api
pm2 save
```

### 3. 腾讯云: nginx 加 location

```nginx
location /api/worker/ {
  proxy_pass http://localhost:3001;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

### 4. Windows 本地: 写 .env

`C:\Users\admin\city-partner-agent\.env`:
```ini
WORKER_API_URL=https://124.156.165.221.nip.io
WORKER_TOKEN=<跟腾讯云 .env 一样>
WORKER_ID=chengyu-windows-01
CODEX_CWD=C:\Users\admin\city-partner-platform
CODEX_TIMEOUT=270
POLL_INTERVAL=10
```

### 5. Windows 本地: 装 Codex CLI

```bash
npm install -g @openai/codex
codex login  # 浏览器登录, 生成 ~/.codex/auth.json
codex --version
```

### 6. Windows 本地: 装 NSSM 服务

下载 NSSM: https://nssm.cc/download

```powershell
# PowerShell (管理员)
nssm install HermesWorker "C:\Python311\python.exe" "C:\Users\admin\city-partner-agent\local_worker.py"
nssm set HermesWorker AppDirectory "C:\Users\admin\city-partner-agent"
nssm set HermesWorker AppStdout "C:\Users\admin\city-partner-agent\logs\worker.log"
nssm set HermesWorker AppStderr "C:\Users\admin\city-partner-agent\logs\worker.err.log"
nssm set HermesWorker AppRotateFiles 1
nssm set HermesWorker AppRotateBytes 10485760
nssm start HermesWorker
nssm status HermesWorker
```

### 7. 验证

```bash
# Windows PowerShell
curl https://124.156.165.221.nip.io/api/worker/next -H "Authorization: Bearer <token>"
# 期望: {"job":null}

# Supabase 手动加个测试 job (SQL Editor)
insert into hermes_jobs (source, job_type, payload) values ('manual', 'codex_task', '{"prompt":"echo hello world"}'::jsonb);
```

几秒后 Windows 本地 logs/worker.log 应见 `📥 job xxx -> codex exec`

## 完整流程 (用户视角)

1. 飞书私聊: "@Hermes 我想做用户登录"
2. 飞书 -> 腾讯云 (event 加密)
3. 腾讯云 -> Vercel /api/feishu/event (中转)
4. Vercel: 解密 -> Hermes agent 拆 3 子任务 -> 写 hermes_jobs (3 pending)
5. Vercel: 回复飞书 "✅ 3 子任务, 等本地 worker"
6. Windows local_worker.py: 拉 task 1
7. local_worker: codex exec "做 TASK-001: 创建登录页"
8. codex: 改代码 + git commit + gh pr create
9. local_worker: 提取 PR URL -> POST /api/worker/report
10. 腾讯云: 写 hermes_job_results + 推飞书群 "✅ TASK-001 PR: https://github.com/.../pull/5"
11. 重复 6-10 for task 2, 3

## 鉴权

- 飞书 -> 腾讯云: FEISHU_ENCRYPT_KEY
- 本地 -> 腾讯云: WORKER_TOKEN (Bearer)
- 腾讯云 -> Supabase: SUPABASE_SERVICE_KEY (bypass RLS)

## 文件清单

| 文件 | 位置 |
|---|---|
| `docs/setup-hermes-jobs.sql` | Supabase 跑 |
| `worker_api.js` | 腾讯云 /home/admin/city-partner-agent/ |
| `local_worker.py` | Windows C:\Users\admin\city-partner-agent\ |
| `.env` | 两边各一份, 内容不同 |

## 监控

```bash
# 腾讯云
pm2 logs worker-api --lines 50
pm2 status

# Windows
Get-Content C:\Users\admin\city-partner-agent\logs\worker.log -Tail 50 -Wait

# Supabase
select status, count(*) from hermes_jobs group by status;
```
