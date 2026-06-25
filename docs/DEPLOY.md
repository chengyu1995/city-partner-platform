# 部署指南 (Hermes 触发者 vs 你触发者)

> 由于 **Vercel 会屏蔽 hermes 触发的 Production 部署**（这是 Vercel 防 abuse 设计），
> 所有生产部署必须由 **你** (chengyu1995) 触发。

## 两种方式

### 方式 1: Vercel 网页手动 Redeploy (推荐, 1 分钟)

1. 打开 https://vercel.com/chengyu1995/city-partner-platform-tfpf/deployments
2. 找最新 commit (比如 `38400f2`)
3. 右上 `⋯` → **Promote to Production**
4. 等待 build 完成 (~2-3 分钟)
5. 验证: 访问 https://city-partner-platform.vercel.app/api/queue/status

### 方式 2: Vercel CLI 一键部署 (本地)

1. 第一次先登录: `npx vercel login`
2. 双击 `scripts/deploy-vercel.bat` (Windows)
   或运行 `./scripts/deploy-vercel.sh` (macOS/Linux)
3. 等待 1-2 分钟 build + deploy

## 为什么不让 Hermes 触发?

Vercel 把 commit 的 `author` / `committer` 跟 `hermes` 关联时,
**自动 Block Production 部署** (因为是 GitHub bot, 不是人类账号).

你可以看到 Deployments 列表里:
- ✅ chengyu1995 触发的 → Ready
- 🔴 hermes 触发的 → Blocked

**这是设计如此, 不是 bug**.

## 触发后状态检查

| Commit | 触发者 | 状态 |
|---|---|---|
| 38400f2 飞书自动化 4 条 | hermes | 🔴 Blocked |
| 4d8b6c1 Supabase v2 | chengyu1995 | 🟢 Ready (Production) |
| a842e81 test-supabase fix | hermes | 🔴 Blocked |
| ... | | |

## 注意事项

- **CI workflow 不会自动部署**, 只会跑 lint + build 检查
- 部署触发 = Vercel build + 部署到生产环境
- 每次新 commit 需要**手动**触发一次
- 或者: 配置 Vercel **Auto-deploy from main branch** (默认配置), 这样 GitHub push 自动 build
  - 但 hermes 触发仍会被 Block
  - chengyu1995 触发会自动 build
