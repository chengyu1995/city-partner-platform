-- ============================================================
-- partner_posts 表 - 搭子需求发布
-- 路径: Supabase 控制台 → SQL Editor → New query → 粘进去运行
-- ============================================================

-- 1. 建表
create table if not exists public.partner_posts (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  city text not null,
  title text not null,
  description text not null,
  contact text not null,
  host_name text not null,
  starts_at timestamptz,
  created_at timestamptz not null default now()
);

-- 2. 索引 (按城市/分类/时间查)
create index if not exists idx_partner_posts_city on public.partner_posts (city);
create index if not exists idx_partner_posts_category on public.partner_posts (category);
create index if not exists idx_partner_posts_created on public.partner_posts (created_at desc);

-- 3. RLS
alter table public.partner_posts enable row level security;

-- 公开读
drop policy if exists "anon read partner_posts" on public.partner_posts;
create policy "anon read partner_posts"
  on public.partner_posts for select
  using (true);

-- 公开写 (MVP 阶段, 不做 owner 限制; 之后改 service role only)
drop policy if exists "anon insert partner_posts" on public.partner_posts;
create policy "anon insert partner_posts"
  on public.partner_posts for insert
  with check (true);

-- 公开改/删 (MVP 简化; 业务层加 auth 检查)
drop policy if exists "anon update partner_posts" on public.partner_posts;
create policy "anon update partner_posts"
  on public.partner_posts for update
  using (true);

drop policy if exists "anon delete partner_posts" on public.partner_posts;
create policy "anon delete partner_posts"
  on public.partner_posts for delete
  using (true);

-- 4. 验证
select count(*) as partner_posts_count from public.partner_posts;
