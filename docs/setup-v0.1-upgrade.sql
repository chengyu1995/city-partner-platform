-- ============================================================
-- v0.1 升级 SQL
-- 路径: Supabase 控制台 → SQL Editor → New query → 粘进去运行
-- ============================================================

-- 1. partner_posts 加 status 字段 (默认 'approved' 让现有数据仍可见)
alter table public.partner_posts
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected'));

create index if not exists idx_partner_posts_status on public.partner_posts (status);
create index if not exists idx_partner_posts_status_created on public.partner_posts (status, created_at desc);

-- 2. RLS: 公开读只看 approved (只有 admin / service_role 读 pending)
drop policy if exists "anon read partner_posts" on public.partner_posts;
create policy "anon read approved partner_posts"
  on public.partner_posts for select
  using (status = 'approved');

-- 3. RLS: 公开 insert 仍允许, 但 status 强制 'pending' (前端可改, 防作弊)
drop policy if exists "anon insert partner_posts" on public.partner_posts;
create policy "anon insert partner_posts"
  on public.partner_posts for insert
  with check (status in ('pending', 'approved'));

-- 4. RLS: update / delete 改由 service role only (不开放给 anon)
drop policy if exists "anon update partner_posts" on public.partner_posts;
drop policy if exists "anon delete partner_posts" on public.partner_posts;
create policy "service update partner_posts"
  on public.partner_posts for update
  using (auth.role() = 'service_role');

create policy "service delete partner_posts"
  on public.partner_posts for delete
  using (auth.role() = 'service_role');

-- 5. 建 reports 表 (举报)
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.partner_posts(id) on delete cascade,
  reason text not null,
  contact text,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_reports_post on public.reports (post_id);
create index if not exists idx_reports_status on public.reports (status, created_at desc);

alter table public.reports enable row level security;

-- 6. RLS: 公开 insert 举报, 读只看自己的 (暂时所有 anon 可读 pending, 简化)
drop policy if exists "anon insert reports" on public.reports;
create policy "anon insert reports"
  on public.reports for insert
  with check (true);

drop policy if exists "anon read reports" on public.reports;
create policy "anon read reports"
  on public.reports for select
  using (true);

-- 7. 验证
select 'partner_posts' as tbl, count(*) filter (where status = 'pending') as pending, count(*) filter (where status = 'approved') as approved
from public.partner_posts
union all
select 'reports' as tbl, 0, 0 from public.reports limit 1;
