-- ============================================================
-- Hermes Worker 任务队列 (1 需求 = 1 任务, 不拆)
-- ============================================================

create table if not exists hermes_jobs (
  id uuid primary key default gen_random_uuid(),

  -- 来源
  source text not null default 'feishu',
  feishu_message_id text,
  feishu_event_id text,
  feishu_chat_id text,
  feishu_user_id text,

  -- 任务字段 (固定: 1 需求 = 1 任务, 不拆分)
  job_id text,                          -- 自动编号如 TASK-001 (可选, 给老板看的)
  title text not null,                  -- 需求名称
  description text,                     -- 需求描述
  priority text default 'P1' check (priority in ('P0', 'P1', 'P2')),
  acceptance text,                      -- 验收标准
  branch text default 'agent/TASK-001', -- agent/<job_id> 形式

  -- 执行
  executor text default 'local_codex',
  repo text default 'C:\Users\admin\city-partner-platform',
  prompt text,                          -- 完整 prompt (拼装给 codex exec)

  -- 状态枚举 (简化)
  status text not null default 'pending' check (status in (
    'pending',          -- 待本地执行
    'running',          -- 执行中
    'awaiting_review',  -- 待验收
    'completed',        -- 已完成
    'failed'            -- 执行失败
  )),

  -- 抢占/超时 (跟 status 配套)
  claimed_by text,
  claimed_at timestamptz,
  expires_at timestamptz,               -- 5 分钟超时
  attempts int default 0,
  max_attempts int default 2,           -- 失败最多重试 2 次

  -- 结果
  result jsonb,                         -- { pr_url, output, files_changed, build_passed, test_passed, duration_ms }
  error text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_jobs_status_priority on hermes_jobs(status, priority, created_at);
create index if not exists idx_jobs_expires on hermes_jobs(expires_at) where status = 'running';

-- 自动更新 updated_at
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

-- RLS
alter table hermes_jobs enable row level security;
