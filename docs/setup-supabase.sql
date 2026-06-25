-- ============================================================
-- 同城搭子平台 · Supabase 建表 SQL
-- 路径: Supabase 控制台 → SQL Editor → New query → 粘进去运行
-- ============================================================

-- 启用 uuid 生成（如果还没启用）
create extension if not exists "pgcrypto";

-- 活动表
create table if not exists public.activities (
  id          uuid default gen_random_uuid() primary key,
  title       text not null,
  starts_at   timestamptz not null,
  location    text not null,
  capacity    int not null default 10 check (capacity > 0 and capacity <= 1000),
  host_name   text not null,
  created_at  timestamptz not null default now()
);

-- 索引：按时间排序常用
create index if not exists activities_starts_at_idx on public.activities (starts_at asc);

-- 启用 RLS（行级安全）—— 业务上加这一步一定要做
alter table public.activities enable row level security;

-- Policy 1: 任何人都能读活动（公开浏览）
drop policy if exists "activities read all" on public.activities;
create policy "activities read all"
  on public.activities
  for select
  using (true);

-- Policy 2: 任何人都能创建活动（MVP 暂不做登录校验）
drop policy if exists "activities insert all" on public.activities;
create policy "activities insert all"
  on public.activities
  for insert
  with check (true);

-- Policy 3: 只有 host_name 匹配的人能改/删自己的活动
drop policy if exists "activities update own" on public.activities;
create policy "activities update own"
  on public.activities
  for update
  using (host_name = current_setting('request.jwt.claims', true)::json->>'sub')
  with check (host_name = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "activities delete own" on public.activities;
create policy "activities delete own"
  on public.activities
  for delete
  using (host_name = current_setting('request.jwt.claims', true)::json->>'sub');
