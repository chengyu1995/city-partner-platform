# 权限边界 (PERMISSIONS)

> 来源: `docs/PERMISSIONS.md` (你 2026-06-14 定)
> 生效: city-partner-platform 全项目 + Hermes Agent + Codex 自动化

---

## 角色

| 角色 | 身份 | 范围 |
|---|---|---|
| **你 (老板 / chengyu1995)** | GitHub repo owner + Vercel owner + Supabase owner | 全权限 |
| **Hermes Agent** | 飞书 + GitHub + Vercel + Supabase 的**只读**客户端 | 中等权限 |
| **Codex (OpenAI)** | 跑在你账号下的开发 agent | 受限权限 |

---

## ✅ Hermes 可以做

- 读取飞书需求 (Bitable 查询)
- 创建任务 (Hermes 任务队列 / GitHub Issue)
- 修改任务状态 (`hermes_queue.status`)
- 调用 Codex (通过 `/api/feishu/codex-task` 入队, Codex 跑 GitHub PR)
- 创建 GitHub Issue (Codex 任务)
- 读取 PR 状态 (`gh pr list`)
- 读取 Vercel 预览链接 (`vercel inspect`)
- 发送日报 (飞书 Bot 1 / 群消息)
- 生成老板选择题 (多选题 + 选 A/B/C)

## ❌ Hermes 不可以做

- 正式上线 (走 PR 流程 + 你确认)
- 删除数据库 (任何 DROP / DELETE FROM)
- 删除 GitHub 仓库
- 修改生产环境变量 (Vercel Production env)
- 购买付费服务
- 群发用户消息 (Bot 1 群发走 `notify.py`, 单次可; 批量自动发 → 拒绝)
- 修改商业模式

## ✅ Codex 可以做

- 写代码 (新增 / 修改文件)
- 修 bug
- 写测试 (`*.test.ts` 等)
- 新建分支 (`feature/*` / `fix/*`)
- 提交 PR (target = dev)
- 评论 PR (`gh pr comment`)
- 做 review (Codex Cloud review)

## ❌ Codex 不可以做

- 直接合并 main (受 main 分支保护, 即使有 PR 也不行)
- 直接操作生产数据库
- 删除用户数据
- 修改支付逻辑
- 绕过老板上线 (没有 review 不能合)
- 引入高风险依赖 (`crypto`, `ssh2`, `node-cmd`, `shelljs`, child_process exec, 等等)
- 提交密钥 (.env / .env.local / *.pem / *.key / id_rsa / 任何疑似 token 的字符串)

## 🛑 老板必须亲自确认 (Hermes + Codex + 任何 agent 都不可代劳)

- 正式上线 (生产 deploy)
- 绑定域名
- 开启登录 (Supabase Auth / OAuth)
- 开启支付 (Stripe / 微信支付 / 支付宝)
- 开启短信 (Twilio / 阿里云)
- 开启微信登录
- 修改隐私政策
- 删除数据 (任何 DELETE 触到用户数据的)
- 大规模推广 (SEO / 广告 / 群发 / KOL)
- 商业模式变化 (免费→付费 / 新增收费 / 价格调整)

---

## 强制执行

### 1. GitHub 分支保护 (`docs/GITHUB_SETUP.md`)

- main: 必须 PR + 1 review + status check + include admin + 禁 force push + 禁 delete
- staging: 必须 PR + include admin + 禁 force push
- dev: 必须 PR + include admin + 禁 force push

### 2. Codex 权限 (PR + reviewer)

- Codex 只能在 `dev` / `feature/*` 上提交
- Codex 不能合 main
- PR 模板 (`/.github/pull_request_template.md`) 强制 review + 测试方式

### 3. 生产数据库只读 (Supabase RLS)

```sql
-- 服务角色 key 只能在 server-only context
-- 任何 client bundle 看不到 SUPABASE_SERVICE_ROLE_KEY
-- Hermes + Codex 拿到的 service_role key 不暴露给前端
```

### 4. Vercel env 分离

- `NEXT_PUBLIC_*` → Vercel 公开, 客户端可见
- `SUPABASE_SERVICE_ROLE_KEY` → 仅 Vercel server (production)
- **不**加到 GitHub Actions secrets (防止 PR 检查 log 暴露)

### 5. .gitignore 强制

```
.env
.env.local
.env.development.local
.env.test.local
.env.production.local
*.pem
*.key
id_rsa*
```

### 6. 防止密钥泄露 (Hermes 端)

- Hermes agent **不**主动提交任何 key / token 到 git
- 老板 (你) 贴到聊天里的 token, 助手**立刻**建议撤销 + 重发
- 助手**不**把完整 token 写进文件 (避免 token 化截断)
- 助手**不** echo 任何疑似 secret 的字符串

### 7. 老板选择题格式 (Hermes 输出)

每次需要老板决策必须用此格式:
```
【需要你确认】
问题: <一句话描述>
背景: <为什么需要决策, 2-3 句话>
A: <选项 A>
B: <选项 B>
C: <选项 C> (可选)
Hermes 建议: <A/B/C 之一>
理由: <为什么这个建议最合理>
请回复 A/B/C
```

---

## 越权处理 (audit log)

任何越权行为 (例如 Hermes 试图改 prod env vars), Hermes 立刻停下 + 给你发"需要确认"消息, 等待你点头.

---

**最后更新**: 2026-06-14
