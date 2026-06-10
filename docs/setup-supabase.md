# 接 Supabase 真数据库 · 操作步骤

> 预计 5-10 分钟。

## 1. 建 Supabase 项目

1. 打开 https://supabase.com → 登录
2. **New Project**
   - Name: `city-partner-platform`
   - Database Password: **生成一个并记下来**（别用真常用密码）
   - Region: **`Northeast Asia (Tokyo)`** 或 **`Singapore`**（大陆访问最快的两个）
3. 等 1-2 分钟项目就绪

## 2. 跑建表 SQL

1. 左侧 → **SQL Editor** → **New query**
2. 把 `docs/setup-supabase.sql` 全文粘进去
3. 点 **Run**（或 Ctrl+Enter）
4. 底部应显示 "Success. No rows returned"

## 3. 拿到 3 个 key

左侧 → **Settings** → **API**，记下：

| 字段 | 用途 | 填到 .env.local 哪个变量 |
|---|---|---|
| `Project URL` | 项目 URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon public` 下的 `API Key` | 前端可见的匿名 key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` 下的 `secret` | ⚠️ 高权限，仅服务端 | `SUPABASE_SERVICE_ROLE_KEY` |

## 4. 填到 .env.local

打开 `C:\Users\admin\city-partner-platform\.env.local`，把 3 个值填上：

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6...
SUPABASE_JWT_SECRET=*** *.env 里的 'env vars 缺失，进入 MOCK 模式' 警告消失。
- 日志里应该完全安静。

## 5. 验证

### 5.1 基础连通性

```bash
cd /c/Users/admin/city-partner-platform
npm run dev
```

浏览器打开 http://localhost:3000/test-supabase

- 状态: `ok`
- 详情: "Supabase 端点可达 ✅ (缺 _health_check_probe 表是预期)"

### 5.2 业务连通性

打开 http://localhost:3000/activities

- 默认显示 0 条（真数据库是空的）
- 点 **+ 发起活动** → 填表 → 提交
- 跳回详情页 → 内容正确
- 回列表 → 看到新加的活动

### 5.3 回 Supabase 控制台验证

- 左侧 **Table Editor** → `activities` 表 → 看到你刚加的那一行

## 6. 出问题怎么办

| 现象 | 原因 / 修法 |
|---|---|
| 启动 dev server 时 `MOCK 模式` 警告还在 | env vars 还没读到，重启 dev server 一次 |
| `test-supabase` 显示 "fetch failed" | URL 错了，或者项目还在启动中 |
| 列表显示 0 条 | SQL 没跑成功，去 Table Editor 看 `activities` 表是否存在 |
| 提交活动 500 | RLS policy 拒绝 → 重新跑 setup-supabase.sql 里的 policy 部分 |
| 提交活动 401 | 用了错的 anon key，重新复制 |
| `SUPABASE_SERVICE_ROLE_KEY` 警告 | 没填该项，**先不填也可以**，用到 admin 接口才需要 |

## 7. (可选) 自动生成类型

```bash
npx supabase login
npx supabase gen types typescript --project-id <your-project-id> > src/types/supabase.ts
```

生成后 `src/lib/env.ts` 里 `getSupabaseServer()` 的 `SupabaseClient<Database>` 类型就会自动从 generated types 推断，TS 体验更好。
