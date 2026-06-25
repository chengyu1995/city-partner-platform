# Cloudflare Pages 迁移指南

> 从 Vercel Hobby 切到 Cloudflare Pages（永久免费，bot 触发也支持）。
> 预计 15-20 分钟。

## 0. 为什么切

Vercel **Hobby plan** 不支持协作（Blocked hermes 触发的 deploy）。
Cloudflare Pages **免费 plan** 不限团队，bot 触发也能 deploy。

## 1. 注册 / 登录 Cloudflare

1. https://dash.cloudflare.com/sign-up
2. 用 GitHub 账号登录（推荐）
3. 同意条款

## 2. 创建 Pages 项目

1. 左侧 **Workers & Pages** → **Create application** → **Pages** tab → **Connect to Git**
2. 选 **GitHub** → 授权 → 选 `chengyu1995/city-partner-platform`
3. **Production branch**: `main`
4. **Build settings**:
   - **Framework preset**: `Next.js`
   - **Build command**: `npx next build`（默认就是，留空也行）
   - **Build output directory**: `.next`（Next 16 用 `.next`）
   - **Root directory**: `/`（留空）
5. **Environment variables** (重要! 在这里设):
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<your-project-ref>.supabase.co` (从 Supabase Dashboard → Settings → API 复制 Project URL)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `<your-anon-publishable-key>` (从同一页面复制 Publishable key)
   - `SUPABASE_SERVICE_ROLE_KEY` = `<your-service-role-key>` (从同一页面复制 service_role key, **仅服务端用, 不暴露前端**)
   - `FEISHU_BOT_WEBHOOK` = `<your-feishu-bot-webhook-url>` (从飞书群机器人设置里复制)
6. **Save and Deploy** → Cloudflare 自动跑 build → 1-2 分钟 Ready

## 3. 生产域名

Cloudflare Pages 自动给一个：
- `https://city-partner-platform.pages.dev`

**自动带 HTTPS**。生产域名**就是**这个（**不是** vercel.app 那个了）。

## 4. 触发第一次 deploy

**方式 1: Cloudflare 自动**（如果 GitHub 集成配好了）
- 你 push 到 main → Cloudflare 自动 build
- 1-2 分钟看 build 状态

**方式 2: GitHub Action 触发 Cloudflare**
- Cloudflare Pages **自动**监听 GitHub push，不需要额外配

**方式 3: 手动**
- Cloudflare 项目 → **Deployments** tab → **Create deployment** → 选 branch + commit

## 5. 验证

1. 打开 `https://city-partner-platform.pages.dev`
2. 看首页（应该显示"同城搭子"）
3. 打开 `/api/queue/status` → 应该返回 JSON
4. 打开 `/activities` → 应该有 1 条 `e2e test`

## 6. Vercel 旧域名处理

Vercel 域名 `city-partner-platform.vercel.app` 仍然存在（Vercel 项目没删）。
**两步**：

1. **飞书自动化 URL 全部改**：
   - 旧: `https://city-partner-platform.vercel.app/api/feishu/...`
   - 新: `https://city-partner-platform.pages.dev/api/feishu/...`

2. **以后**想删 Vercel 项目（可选）：Settings → 底部 Delete Project

## 7. 已知差异（Vercel → Cloudflare Pages）

| 差异 | Vercel | Cloudflare Pages |
|---|---|---|
| 默认 Next.js 构建 | ✅ | ✅ |
| Edge runtime | ✅ | ✅（但不同 API） |
| ISR | ✅ | ⚠️ 需配 `@cloudflare/next-on-pages` |
| `Image` 优化 | ✅ 自动 | 需配 `next/image` + Cloudflare Images 或 `unoptimized: true` |
| Serverless function timeout | 10s 默认 | 30s 默认（更宽松） |
| 价格 (Hobby/Free) | $0 + Pro 限制 | $0 永久免费 |

**最常见坑**：`next/image` 优化在 Cloudflare 上**默认不工作**。
我们项目里 `next.config.ts` 应该已经有 `images` 配置——**让我先确认**（下一步会改）。

## 8. 项目当前域名

| 域名 | 状态 |
|---|---|
| `https://city-partner-platform.vercel.app` | 旧（Vercel） |
| `https://city-partner-platform.pages.dev` | 新（Cloudflare） |

**推荐**：
- **生产**用 `.pages.dev`
- **或者**你**有自定义域名**（`city-partner.com` 等）→ Cloudflare DNS 配 CNAME
- Vercel 旧域名**保持访问**直到你完成飞书 URL 切换 + 自己确认无流量影响

## 9. 完成度

- [ ] 1. 注册 / 登录 Cloudflare
- [ ] 2. 创建 Pages 项目
- [ ] 3. 配 4 个环境变量
- [ ] 4. 第一次 deploy
- [ ] 5. 验证 4 个 URL 通
- [ ] 6. 改飞书自动化 URL
- [ ] 7. 决定是否删 Vercel 项目
- [ ] 8. 跑 Supabase SQL `docs/setup-hermes-queue.sql`
- [ ] 9. 配 GitHub Secrets (4 个)
- [ ] 10. 手动触发 GitHub Action 测试端到端
