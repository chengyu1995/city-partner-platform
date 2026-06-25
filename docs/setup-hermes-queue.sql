-- ============================================================
-- Hermes 异步任务队列 + 拆解结果表
-- 路径: Supabase 控制台 → SQL Editor → New query → 粘进去运行
-- ============================================================

create extension if not exists "pgcrypto";

-- ============= 1. 队列表 =============
create table if not exists public.hermes_queue (
  id            uuid default gen_random_uuid() primary key,
  event_type    text not null,        -- 'new_requirement' / 'codex_task_ready'
  payload       jsonb not null,       -- 飞书发的原始 JSON
  status        text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'failed')),
  attempt_count int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists hermes_queue_pending_idx
  on public.hermes_queue (status, created_at)
  where status = 'pending';

-- ============= 2. 拆解结果表 =============
create table if not exists public.task_results (
  id              uuid default gen_random_uuid() primary key,
  source_queue_id uuid references public.hermes_queue(id) on delete cascade,
  summary         text not null,       -- LLM 拆任务的总结
  subtasks        jsonb not null,      -- [{title, action, needs, eta, ...}]
  model           text,                -- 用的 LLM model
  tokens_used     int,
  created_at      timestamptz not null default now()
);

create index if not exists task_results_source_idx
  on public.task_results (source_queue_id);

-- ============= RLS =============
alter table public.hermes_queue enable row level security;
alter table public.task_results enable row level security;

-- 读: anon (前端) 可读
drop policy if exists "queue read all" on public.hermes_queue;
create policy "queue read all"
  on public.hermes_queue
  for select
  using (true);

drop policy if exists "queue insert all" on public.hermes_queue;
create policy "queue insert all"
  on public.hermes_queue
  for insert
  with check (true);

drop policy if exists "queue update all" on public.hermes_queue;
create policy "queue update all"
  on public.hermes_queue
  for update
  using (true)
  with check (true);

drop policy if exists "results read all" on public.task_results;
create policy "results read all"
  on public.task_results
  for select
  using (true);

drop policy if exists "results insert all" on public.task_results;
create policy "results insert all"
  on public.task_results
  for insert
  with check (true);
