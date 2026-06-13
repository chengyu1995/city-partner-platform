# Vercel 配置指南 (city-partner-platform)

> 预计 10-15 分钟. 跑通后: 推 GitHub → Vercel 自动 build, PR 自动 preview, main 自动 deploy production.

## 当前状态 (2026-06-13)

✅ **已配**:
- Vercel 装了 GitHub App, 监听 `chengyu1995/city-partner-platform`
- main 分支 push → Production 自动部署 (city-partner-platform.vercel.app)
- PR 创建 → Preview 自动部署
- 3 个 env vars 配齐 (URL + anon + service_role)

🟡 **可优化** (按本指南做):
- env vars 区分 Preview / Production
- service_role key 限制只 Production
- 自定义 Preview domain (子域名规则)
- 团队成员权限 (邀请协作者)

## 1. Vercel Dashboard 入口

- https://vercel.com/dashboard
- 找到 `city-partner-platform-tfpf` 项目 (主项目, 跟生产域名 `city-partner-platform.vercel.app` 关联)
- ⚠️ **注意**: 你现在有 2 个项目 — `city-partner-platform` (17h 旧, 删) + `city-partner-platform-tfpf` (新, 主)

## 2. 环境变量配置 (按环境分开)

### 推荐的 env vars 分层

| Env var | 暴露范围 | Preview | Production | 备注 |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 前端 | ✅ | ✅ | **必须**两边配 (否则 preview 跟生产不一致) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 前端 | ✅ | ✅ | **必须**两边配 |
| `SUPABASE_SERVICE_ROLE_KEY` | **后端 only** | ❌ | ✅ | **只** Production 配, Preview 禁用 |

### 配置步骤

1. Vercel → `city-partner-platform-tfpf` → Settings → **Environment Variables**
2. 删旧 3 个 env vars (URL / anon / service_role 全部 3 选 Production 的)
3. 重新添加, **分别选环境**:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://qfubesklrqoqvuufefvq.supabase.co`
     - 勾 ☑ Production
     - 勾 ☑ Preview
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `sb_publishable_***`
     - 勾 ☑ Production
     - 勾 ☑ Preview
   - `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_***`
     - ☑ Production
     - ☐ Preview (不勾)
4. Save
5. (可选) 4 个 Dev 环境变量, **不要**勾 Vercel 默认的 (Dev 是本地 .env.local, 不用配 Vercel)

### 验证

```bash
# 在本地跑, 跟生产环境一致
# Vercel Preview URL 也可以用同一个 anon key 测
```

## 3. Production vs Preview 行为

### Production (main 分支部署)
- **URL**: https://city-partner-platform.vercel.app
- **Env vars**: 3 个全有 (URL + anon + service_role)
- **后端 server actions**: 能用 service_role (有 admin 权限)
- **前端**: 只能用 anon key (走 RLS)

### Preview (PR / feature 分支部署)
- **URL**: 形如 `city-partner-platform-tfpf-git-feature-name-chengyu1995.vercel.app`
- **Env vars**: URL + anon 有, **service_role 没有** (← 关键)
- **后端 server actions**: 用 anon key + 严格 RLS
- **前端**: 跟生产同 (anon key 是公开的)

### Development (本地)
- **URL**: http://localhost:3000
- **Env vars**: 走 `.env.local` (本地文件, 不进 Vercel)
- **跟生产同步**: 配同 3 个 key (但**只用** anon + URL, service_role 给服务端用)

## 4. PR Preview 链接自动生成

Vercel 监听 `pull_request` 事件, PR 创建后:
1. **Vercel bot 评论 PR** 写"Preview ready" + Preview URL
2. **CI check** 标绿
3. **你** 点 Preview URL 看效果

### 看 PR #5 实际效果

PR #5 已经触发了 Preview:
- `targetUrl: https://vercel.com/chengyu1995s-projects/city-partner-platform-tfpf/6AvrKQ8NDq6yPuBe6uxzuR6GRTQX`
- `state: SUCCESS`

## 5. 关键安全原则

### ❌ 绝对不要

1. **NEXT_PUBLIC_** 后面跟 service_role / 任何"服务器 only" 的 key
   - 因为带 `NEXT_PUBLIC_` 前缀的 env var 会被 Next.js **打包进 client JS bundle**
   - 任何用户在浏览器 F12 都能看到

2. **service_role key** 出现在:
   - 任何 PR 的 Preview URL 路由响应里
   - 任何 client component (`'use client'`) 的代码里
   - 任何 `console.log(process.env.XXX)` 没加 server-only check 的

3. **3 个 env var 全部勾** 3 个环境 (Production / Preview / Development)
   - service_role 应该**只**勾 Production

### ✅ 正确范式

1. **client component** 只用 `NEXT_PUBLIC_*`
2. **server component / server action** 才有权用 `SUPABASE_SERVICE_ROLE_KEY`
3. **code 走** `process.env.SUPABASE_SERVICE_ROLE_KEY` 直接, Next.js **自动**只在 server side 暴露

```typescript
// src/lib/supabase.ts (server only)
import "server-only";
import { createClient } from "@supabase/supabase-js";

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY 缺失 (需要 Production 环境)");
}
export const adminClient = createClient(url, serviceKey);
```

`import "server-only"` 是 Next.js 内置, 任何 client component 引用这个文件会**编译错**。

## 6. Branch 部署规则

Vercel 默认行为:
| 分支 | 部署到 | URL 模式 |
|---|---|---|
| `main` | Production | `https://<project-name>.vercel.app` |
| 其他 | Preview (不自动) | 需 PR 触发 |

如果你**想要** staging / dev 分支也自动部署:
- Vercel → Settings → Git → Production Branch
- 默认 `main`
- 改 "Preview Branch" 选 "All branches" 或具体列表

⚠️ **不建议** staging / dev 分支也自动部署 (Vercel 免费层有部署次数限制, dev 分支频繁 push 会爆)
- 改成: staging 分支也自动 deploy (作为 staging 环境), dev 分支**只**走 PR preview

## 7. 自定义域名 (可选)

如果你想用 `tieban.citypartner.com` 这种:
1. Vercel → Settings → Domains
2. Add `tieban.citypartner.com`
3. 配置 DNS: `tieban` CNAME `cname.vercel-dns.com`
4. 等 DNS 生效 (5-30 分钟)

## 8. 团队成员 / 协作者 (可选)

- Vercel → Settings → Members
- 邀请协作者 (用 email)
- 角色: Owner / Developer / Viewer

## 9. 监控 / Analytics

Vercel 提供:
- Real-time Analytics (访问量 / 性能)
- Speed Insights (Core Web Vitals)
- Logs (function logs / build logs)

`city-partner-platform-tfpf` → Analytics tab

## 10. 环境变量管理 CLI (高级)

如果你**不想**每次都在 Dashboard 改, 可以用 Vercel CLI:

```bash
# 装 Vercel CLI
npm install -g vercel

# 登录
vercel login

# 拉项目
cd city-partner-platform
vercel link

# 批量配 env
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_URL preview
# (输入值)

# 拉 env 到本地
vercel env pull .env.local
```

⚠️ **不要** `vercel env pull` 在 CI 跑 — 会把 production env 写到 CI logs。

## 11. 排查

### Preview 部署失败
- Vercel → Project → Deployments → 失败的 deployment → Logs
- 常见原因:
  - `npm install` 失败 (package.json 错)
  - `npm run build` 失败 (TS / lint 错)
  - Env var 缺失 (运行时错)

### Production 部署失败
- 同上
- **额外**检查: 是不是 main 分支保护规则挡了 push

### Env var 不生效
- 加完后**需要 redeploy** (Vercel 不会自动 re-deploy)
- Settings → Deployments → 最新 production → 菜单 → Redeploy

## 12. Codex 集成要点

**Codex 写的代码**怎么跟 Vercel env 配合:

- **client component** 只能引用 `NEXT_PUBLIC_*`, 不要碰 service_role
- **server component / server action** 用 `process.env.SUPABASE_SERVICE_ROLE_KEY`, 但**仅在 Production 有值**
- Preview 部署时, server action 调 `process.env.SUPABASE_SERVICE_ROLE_KEY` 会**拿不到** → 应该用 fallback:
  ```typescript
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // 拿不到就降级用 anon (Preview)
  // Production 有 service_role, 自动用 admin
  ```

详见 `AGENTS.md` 13 禁止事项 + 5 灰区。

---

**Last updated**: 2026-06-13
