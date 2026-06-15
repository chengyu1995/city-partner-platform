# Vercel + GitHub Env Vars 配置指南

> 用途：让 city-partner-platform 接到真 Supabase + 飞书 Bitable + 飞书群通知
> 预计：10 分钟

## 0. 现状盘点

Vercel 项目 = `city-partner-platform-tfpf` (Hobby 计划)
- ✅ Production + Preview 可用
- ❌ Development 锁（**Hobby 计划只支持 2 个 env**，需要 Pro 计划才能用 Development）
- **解决办法**：用 Production（生产 + 本地 dev 都用同一个值）—— **不要钱**

## 1. Vercel env vars 配 5 个

打开 https://vercel.com/city-partner-platform-tfpf → Settings → Environment Variables

**每个 env 都勾 Production + Preview**（别勾 Development，会锁）

### 1.1 已有（你之前可能配了）

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FEISHU_BOT_WEBHOOK`

**确认值是否还在**——`FEISHU_BOT_WEBHOOK` 你截图里有 `https://api.example.com` 占位符？**看起来是 placeholder**——**你必须改成真的飞书 webhook URL** `https://open.feishu.cn/open-apis/bot/v2/hook/42451c46-1977-48cd-a07f-63f1c984a1e9`

### 1.2 新增 4 个（要你提供）

| Name | Value 来源 | Env 勾选 |
|---|---|---|
| `FEISHU_APP_ID` | `cli_aaafc2ed26785ccb` | Production + Preview |
| `FEISHU_APP_SECRET` | `6iryDaXNBh8bPFB7v9mFOgqdXZvCdLpA` | Production + Preview |
| `BITABLE_APP_TOKEN` | 飞书 Bitable URL `base/` 后那串 | Production + Preview |
| `BITABLE_TABLE_ID` | 飞书 Bitable 表 ID（`tblXXX` 开头） | Production + Preview |
| `FEISHU_API_TOKEN` | **你造一个长字符串当密码**（20+ 字符） | Production + Preview |

## 2. GitHub repo secrets 配 6 个

打开 https://github.com/chengyu1995/city-partner-platform/settings/secrets/actions → New repository secret

| Name | Value |
|---|---|
| `MINIMAX_CN_API_KEY` | 你之前的 minimax LLM key |
| `SUPABASE_URL` | `https://qfubesklrqoqvuufefvq.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 你之前的 service_role key |
| `FEISHU_BOT_WEBHOOK` | 飞书机器人 webhook URL |
| `DECOMPOSE_CALLBACK_URL` | `https://city-partner-platform.vercel.app/api/feishu/decompose-callback` |
| `FEISHU_API_TOKEN` | **跟 Vercel 那个一样**（俩边配同一个值才能鉴权通） |

## 3. 验证

### 3.1 Vercel 端

1. 配完 5 个 env 后，Vercel 不会自动 redeploy
2. 打开 **Deployments** → 最新 → 右上 **⋯** → **Redeploy**
3. 等 30s
4. 测 `https://city-partner-platform.vercel.app/api/feishu/decompose-callback`（GET）
   - 应返 `{"ok":true,"env":{"FEISHU_APP_ID":"set","FEISHU_APP_SECRET":"set",...}}`
   - **如果还显示 "missing"** → env 没配对地方（去 Settings 找 env 名字拼写）

### 3.2 GitHub 端

1. 配完 6 个 secrets 后
2. 打开 https://github.com/chengyu1995/city-partner-platform/actions/workflows/hermes-decompose.yml
3. 点 **Run workflow** → 选 main → Run
4. 看 build log：
   - 找 `pending: 1` (有任务待处理)
   - 找 `BITABLE OK: X subtasks synced` (Bitable 写成功)
5. 几秒后：
   - `/api/queue/status` → `pending: 0, done: +1`
   - 飞书群收到 1 条不乱码的【Hermes 拆任务】消息
   - 飞书 Bitable《任务看板》多 1 行（标题 = 子任务标题）

### 3.3 乱码验证

打开 https://github.com/chengyu1995/city-partner-platform/actions/workflows/hermes-decompose.yml → Run workflow

然后从 Bitable 新建一条需求（或直接 POST `https://city-partner-platform.vercel.app/api/feishu/requirement`），title 用中文。

等 5 分钟 cron 跑后：
- 飞书群消息应该是 `需求: 中文标题`（**不是 `需求: ���`**）
- Bitable 任务标题应该是中文

## 4. 故障排查

### 4.1 飞书 Bitable 写入失败

- 报错 `code=99991663` → 应用没权限访问 Bitable，去飞书开放平台 → 应用权限 → 勾 `bitable:app`
- 报错 `code=1254045` → table_id 错
- 报错 `code=99991400` → app_token 错

### 4.2 飞书群收不到消息

- 看 `notify()` 是不是报 `NO BOT_HOOK, skip notify`（`FEISHU_BOT_WEBHOOK` 没传到 GitHub Action）
- 看 飞书群是否勾了 "消息内容包含关键词"（自定义机器人安全设置）

### 4.3 乱码没修好

- 看 `/api/feishu/requirement` route 是不是用 `arrayBuffer + TextDecoder utf-8`（**不是 `req.text()`**）
- 看 GitHub Action log 里的"收到需求" 是不是乱码

## 5. 你必须给我的 3 件事

1. `BITABLE_APP_TOKEN`（飞书 Bitable URL 里 `base/` 后的字符串）
2. `BITABLE_TABLE_ID`（Bitable 表 ID）
3. **确认** `FEISHU_BOT_WEBHOOK` 在 Vercel 上**不是 placeholder**（截图里看到 `https://api.example.com` 占位符，**你必须改成真的**）

## 6. 安全收尾

- 配完建议立即去 https://github.com/settings/tokens 撤销之前所有贴过聊天的 PAT
- 去 https://supabase.com/dashboard/project/qfubesklrqoqvuufefvq/settings/api 重发 publishable + service_role
- 去 飞书开放平台 重发 app_secret
- 飞书群 → 机器人 → 刷新 webhook token
