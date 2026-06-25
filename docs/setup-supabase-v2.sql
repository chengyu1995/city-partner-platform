-- Supabase 配置: 3 张新表 + RLS + seed
-- 时间: 2026-06-13
-- 执行位置: Supabase Dashboard → SQL Editor
-- 目标: chengyu1995/city-partner-platform 项目

-- ===== 1. profiles (用户表) =====
-- 用 auth.users.id 当 FK, 1 对 1
-- 不存密码 (Supabase Auth 管)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text,
  avatar_url text,
  city text,
  gender text check (gender in ('male', 'female', 'other') or gender is null),
  bio text,
  created_at timestamp with time zone default now()
);

alter table public.profiles enable row level security;

-- profiles RLS: 公开读, 只能改自己的
create policy "profiles_read_all"
  on public.profiles for select
  using (true);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 自动建 profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, coalesce(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1)));
  return new;
end;
$$;

-- 触发器 (新用户注册时自动建 profile)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ===== 2. categories (分类表) =====
-- 项目目标: 旅游搭子 / K 歌搭子 / 学习搭子 / 摩友 / 钓友
-- 预置 5 个分类
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  sort_order int default 0,
  created_at timestamp with time zone default now()
);

alter table public.categories enable row level security;

-- categories RLS: 公开读, 不允许写 (admin 才能改)
create policy "categories_read_all"
  on public.categories for select
  using (true);

-- 预置 5 个分类
insert into public.categories (name, slug, sort_order) values
  ('旅游搭子', 'travel', 1),
  ('K 歌搭子', 'karaoke', 2),
  ('学习搭子', 'study', 3),
  ('摩友', 'motorcycle', 4),
  ('钓友', 'fishing', 5)
on conflict (slug) do nothing;


-- ===== 3. reports (举报表) =====
-- 用户举报 partner_posts
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid,  -- 暂不强 FK, 后期可加
  reporter_id uuid references auth.users(id) on delete set null,
  reason text not null,
  description text,
  status text default 'pending' check (status in ('pending', 'reviewed', 'resolved', 'dismissed')),
  created_at timestamp with time zone default now()
);

alter table public.reports enable row level security;

-- reports RLS: 用户能创 (自己), admin 看
create policy "reports_insert_own"
  on public.reports for insert
  with check (auth.uid() = reporter_id or reporter_id is null);

create policy "reports_read_own"
  on public.reports for select
  using (auth.uid() = reporter_id);


-- ===== 4. (可选) partner_posts 不重建, 用现有的 activities =====
-- 如果你想 rename: (执行这个会改表名, 业务代码要跟着改)
-- alter table public.activities rename to partner_posts;
-- alter table public.partner_posts add column if not exists category text;
-- alter table public.partner_posts add column if not exists city text;
-- alter table public.partner_posts add column if not exists description text;
-- alter table public.partner_posts add column if not exists contact_method text;
-- alter table public.partner_posts add column if not exists contact_value text;
-- alter table public.partner_posts add column if not exists status text default 'pending';
-- alter table public.partner_posts add column if not exists user_id uuid references auth.users(id) on delete set null;
-- 不建议, 先保留 activities, 后期一起迁移

-- ===== 验证 =====
select 'profiles' as table_name, count(*) as rows from public.profiles
union all
select 'categories', count(*) from public.categories
union all
select 'reports', count(*) from public.reports
union all
select 'activities (existing)', count(*) from public.activities;
