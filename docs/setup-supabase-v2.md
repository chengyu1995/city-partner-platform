# Supabase 配置指南 (v2 - 4 张表 + 触发器)

> 预计 10 分钟. 跑通后: 3 张新表 + 自动 profile 创建 + 5 个预置分类.

## 当前状态 (2026-06-13)

✅ **已配**:
- 项目 `qfubesklrqoqvuufefvq` 在 chengyu1995 名下
- `activities` 表 (你之前建的, MVP 临时表, 1 行 `e2e test` 数据)
- 4 RLS policy 在 activities 上
- Vercel env 配齐 3 个 key (URL + anon + service_role)

🆕 **这次加**:
- `profiles` 表 (用户扩展, 跟 auth.users 1:1)
- `categories` 表 (5 个预置分类: 旅游/K歌/学习/摩友/钓友)
- `reports` 表 (举报)
- 触发器: 新用户注册时自动建 profile

⏸️ **暂不做** (你确认产品方向再迁移):
- `activities` → `partner_posts` rename
- 加新字段 (category / city / description / contact_* / user_id)

## 表结构 (跑通后)

```
auth.users (Supabase 自带)
  ↓ 1:1 (触发器自动建)
public.profiles
  ├── id (FK → auth.users.id)
  ├── nickname
  ├── avatar_url
  ├── city
  ├── gender (male/female/other)
  ├── bio
  └── created_at

public.categories (5 行 seed)
  ├── id
  ├── name (旅游搭子)
  ├── slug (travel)
  └── sort_order

public.activities (现有)
  └── ... (MVP 临时)

public.reports
  ├── id
  ├── post_id (待 FK, 后期可加)
  ├── reporter_id (FK → auth.users.id)
  ├── reason
  ├── description
  └── status (pending/reviewed/resolved/dismissed)
```

## 执行步骤

### 1. 打开 Supabase SQL Editor
- https://supabase.com/dashboard/project/qfubesklrqoqvuufefvq/sql
- 点 "New query"

### 2. 复制 `docs/setup-supabase-v2.sql` 全文粘进去
- 全文 ~4400 字符
- 3 张表 + RLS + 触发器 + seed

### 3. Run (Ctrl+Enter)
- 期望输出: "Success. No rows returned"
- 末尾的 SELECT 会返回 4 行 (profiles=0, categories=5, reports=0, activities=1)

### 4. 验证表已建
- 左侧 "Table Editor"
- 应该看到 4 张表: profiles / categories / reports / activities

### 5. 验证 RLS 已开
- 任意表 → 点 "..." → "View policies"
- profiles: 3 policies (read_all / insert_own / update_own)
- categories: 1 policy (read_all)
- reports: 2 policies (insert_own / read_own)

## 业务代码适配 (后话)

### 当前 activities.ts

```typescript
// src/lib/db/activities.ts 当前逻辑
// - IS_MOCK_MODE: 用 src/lib/db/mock.ts (3 行假数据)
// - 真实模式: 从 activities 表读
```

### 等 partner_posts 重建后

```typescript
// 改名 activities.ts → partner-posts.ts
// 表 activities → partner_posts
// 字段: id, user_id, category, city, title, description, contact_method, contact_value, status, created_at
```

### Supabase 类型自动生成

业务代码里 `src/types/supabase.ts` 手动维护, 后期可用:
```bash
npx supabase gen types typescript --project-id qfubesklrqoqvuufefvq > src/types/supabase-generated.ts
```

但这需要装 supabase CLI (npm install -g supabase + login).

## 接下来的业务流 (按你的"网站第一版"目标)

### 能发搭子 (create post)
- 用户登录 (Supabase Auth) → form 填表 → insert partner_posts
- MVP 阶段: 不要求登录, anonymous 也能发 (跟 activities 表现状一致)

### 能浏览 (list posts)
- 首页 /activities 列所有 partner_posts
- 按 created_at 倒序

### 能筛选城市和分类 (filter)
- 顶部加 2 个 dropdown: city + category
- 调 listPosts({ city, category })
- 早期: client-side filter (数据 < 100 条), 后期 server-side

### 能联系 (contact)
- 每条 post 显示 contact_method (微信/手机/Discord 等) + contact_value
- 跳到详情页 (/partner_posts/[id]) 看完整信息
- 后期: 加站内信系统

### 能审核 (moderation)
- 用户看到违规 → 点"举报"
- 填 reason + description → insert reports
- admin 看 reports 表 (MVP 不做 admin 后台, 你看 SQL)

## 当前 SQL 脚本里**没**做的事

1. ❌ **partner_posts 还没建** (用 activities 当临时表)
2. ❌ **reports.post_id 没强 FK** (后期可加 `references partner_posts(id) on delete cascade`)
3. ❌ **没有触发器阻止**非活跃 category 出现在 partner_posts
4. ❌ **没有 admin role** (reports admin 看需要用 service_role)

## 怎么测 (跑完 SQL 后)

```bash
# 在 Supabase Dashboard → Table Editor → categories
# 期望看到 5 行: 旅游搭子 / K 歌搭子 / 学习搭子 / 摩友 / 钓友

# 测试: 创一个 profile (用 service_role)
curl -X POST "https://qfubesklrqoqvuufefvq.supabase.co/rest/v1/profiles" \
  -H "apikey: sb_publishable_*** " \
  -H "Authorization: Bearer sb_secret_*** " \
  -H "Content-Type: application/json" \
  -d '{"id":"00000000-0000-0000-0000-000000000001","nickname":"测试用户","city":"北京"}'
# 期望: 201 Created

# 然后查 public.profiles
# 期望: 1 行

# 验 RLS: 用 anon key 查 profiles
curl "https://qfubesklrqoqvuufefvq.supabase.co/rest/v1/profiles?select=*" \
  -H "apikey: sb_publishable_*** "
# 期望: 公开读 OK
```

## 跟之前 docs/setup-supabase.sql 的关系

| 旧 `setup-supabase.sql` | 新 `setup-supabase-v2.sql` |
|---|---|
| 只建 activities + 4 RLS | 建 profiles + categories + reports + 触发器 |
| 1 张表 | 3 张新表 (activities 保留) |
| 没触发器 | 触发器自动建 profile |
| 没 seed | 5 个预置分类 |

**新 SQL 脚本不冲突** (用 `if not exists` / `on conflict do nothing`), **可以安全** 跑 2 次.

---

**Last updated**: 2026-06-13
