-- ============================================================
-- Hermes Worker 任务队列 (hermes_jobs + hermes_job_results)
-- 腾讯云中转 + Windows 本地拉取 模式
-- ============================================================

-- 1. 任务队列
create table if not exists hermes_jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null,                 -- 'feishu_event' / 'cron' / 'manual'
  source_id text,                        -- 飞书 message_id / cron task_id
  chat_id text,                          -- 飞书 chat_id
  user_id text,                          -- 飞书 sender open_id
  job_type text not null,                -- 'decompose' / 'codex_task' / 'query' / 'send_group'
  payload jsonb not null default '{}'::jsonb,
  priority int default 5,                -- 1-10, 越小越优先
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'failed', 'timeout')),
  claimed_by text,                       -- worker ID (hostname-pid)
  claimed_at timestamptz,
  expires_at timestamptz,                -- claim 5 分钟后超时
  attempts int default 0,
  max_attempts int default 3,
  result jsonb,                          -- done 时的结果
  error text,                            -- failed 时的错
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_jobs_status_priority on hermes_jobs(status, priority, created_at);
create index if not exists idx_jobs_expires on hermes_jobs(expires_at) where status = 'claimed';

-- 2. 任务结果
create table if not exists hermes_job_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references hermes_jobs(id) on delete cascade,
  output text,                           -- codex / hermes 输出
  files_changed text[],                  -- 修改的文件列表
  pr_url text,                           -- GitHub PR URL
  venv_preview text,                     -- Vercel preview URL
  duration_ms int,                       -- 执行耗时
  created_at timestamptz default now()
);

create index if not exists idx_results_job on hermes_job_results(job_id);

-- 3. 自动更新 updated_at
create or replace function update_jobs_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_jobs_updated on hermes_jobs;
create trigger trg_jobs_updated
  before update on hermes_jobs
  for each row execute function update_jobs_updated_at();

-- 4. RLS: service_role 读写
alter table hermes_jobs enable row level security;
alter table hermes_job_results enable row level security;

-- service_role bypass RLS automatically; anon 不能读
-- 公开读用于状态查询 (可选)
-- create policy "jobs read" on hermes_jobs for select using (true);
-- create policy "results read" on hermes_job_results for select using (true);
