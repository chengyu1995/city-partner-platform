# Vercel + GitHub Env Vars 配置指南

> 用途：让 city-partner-platform 接到真 Supabase + 飞书 Bitable + 飞书群通知
> 预计：10 分钟

## 0. 现状盘点

Vercel 项目 = `city-partner-platform-tfpf` (Hobby 计划)
- ✅ Production + Preview 可用
- ❌ Development 锁（**Hobby 计划只支持 2 个 env**，需要 Pro 计划才能用 Development）
- **解决办法**：用 Production（生产 + 本地 dev 都用同一个值）—— **不要钱**

## 1. Vercel env vars 配置

打开 https://vercel.com/city-partner-platform-tfpf → Settings → Environment Variables

**每个 env 都勾 Production + Preview**（别勾 Development，会锁）

### 1.1 已有（你之前可能配了）

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FEISHU_BOT_WEBHOOK`

**确认值是否还在**。`FEISHU_BOT_WEBHOOK` 必须在 Vercel Dashboard 中设置，禁止把真实 webhook URL 写进仓库、PR、Issue 或日志。

### 1.2 需要配置的变量

| Name | Value 来源 | Env 勾选 |
|---|---|---|
| `FEISHU_APP_ID` | 飞书开放平台中的应用 ID | Production + Preview |
| `FEISHU_APP_SECRET` | `<set-in-vercel-dashboard-do-not-commit>` | Production + Preview |
| `BITABLE_APP_TOKEN` | 飞书 Bitable URL `base/` 后那串 | Production + Preview |
| `BITABLE_TABLE_ID` | 飞书 Bitable 表 ID（`tblXXX` 开头） | Production + Preview |
| `FEISHU_API_TOKEN` | **你造一个长字符串当密码**（20+ 字符） | Production + Preview |

## 2. GitHub repo secrets 配 6 个

打开 https://github.com/chengyu1995/city-partner-platform/settings/secrets/actions → New repository secret

| Name | Value |
|---|---|
| `MINIMAX_CN_API_KEY` | 你之前的 minimax LLM key |
| `SUPABASE_URL` | Vercel/Supabase Dashboard 中的项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 你之前的 service_role key |
| `FEISHU_BOT_WEBHOOK` | 飞书机器人 webhook URL |
| `DECOMPOSE_CALLBACK_URL` | `https://city-partner-platform.vercel.app/api/feishu/decompose-callback` |
| `FEISHU_API_TOKEN` | **跟 Vercel 那个一样**（俩边配同一个值才能鉴权通） |

所有值只在 GitHub/Vercel 的 Secret UI 中填写；不要把值复制到源码、文档、PR、Issue、聊天或构建日志。

## 3. 验证

### 3.1 Vercel 端

1. 配完 env 后，Vercel 不会自动 redeploy
2. 发布操作必须走项目当前的独立 Production 审批流程；不要从本文直接 redeploy
3. Preview 中只检查变量名称是否已配置，不读取或输出变量值
4. 测 `https://city-partner-platform.vercel.app/api/feishu/decompose-callback`（GET）
   - 应返仅含安全布尔状态的响应
   - **如果还显示 missing** → env 没配对地方（去 Settings 找 env 名字拼写）

### 3.2 GitHub 端

1. 配完 secrets 后
2. 通过受保护的开发分支 PR 验证相关 workflow
3. 检查日志中仅出现状态，不出现任何密钥或 webhook 值
4. 验证完成后确认没有触发 Production deployment

### 3.3 乱码验证

在非生产 Preview 中创建一条不含敏感信息的中文合成需求。

验证：
- 飞书群消息应该是正常中文（不是乱码）
- Bitable 任务标题应该是正常中文

## 4. 故障排查

### 4.1 飞书 Bitable 写入失败

- 报错 `code=99991663` → 应用没权限访问 Bitable，去飞书开放平台 → 应用权限 → 勾 `bitable:app`
- 报错 `code=1254045` → table_id 错
- 报错 `code=99991400` → app_token 错

### 4.2 飞书群收不到消息

- 看日志中是否出现 `NO BOT_HOOK, skip notify`（`FEISHU_BOT_WEBHOOK` 没传到运行环境）
- 看飞书群是否勾了“消息内容包含关键词”（自定义机器人安全设置）
- 禁止在排查过程中打印完整 webhook URL

### 4.3 乱码没修好

- 看 `/api/feishu/requirement` route 是不是用 `arrayBuffer + TextDecoder utf-8`（**不是 `req.text()`**）
- 看 GitHub Action log 里的“收到需求”是不是乱码

## 5. 你必须提供的信息

这些值只能填写到对应的 Secret UI，不要发送给 Codex：

1. `BITABLE_APP_TOKEN`
2. `BITABLE_TABLE_ID`
3. 确认 `FEISHU_BOT_WEBHOOK` 在 Vercel 上已配置且不是 placeholder

## 6. 安全收尾

- 仓库历史中曾出现过的 token、secret、webhook 一律视为已泄露，必须在对应平台轮换
- 去 GitHub 撤销之前所有贴过聊天或提交到仓库的 PAT
- 去 Supabase Dashboard 轮换暴露过的 service role key
- 去飞书开放平台重发 app secret
- 飞书群 → 机器人 → 刷新 webhook token
- 轮换后只在 GitHub/Vercel Secret UI 中更新，不要提交到仓库
