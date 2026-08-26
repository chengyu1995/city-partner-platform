-- ============================================================
-- Hermes 多轮对话表 (hermes_conversations + hermes_messages)
-- 飞书私聊/群聊消息上下文
-- ============================================================

-- 1. 会话表: 每个 (user + chat_type) 1 个 session
create table if not exists hermes_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,            -- 飞书 open_id 或 user_id
  chat_id text not null,            -- 飞书 chat_id (私聊就是 user_id)
  chat_type text not null,          -- 'p2p' 私聊 / 'group' 群聊
  title text,                        -- 第一条消息摘录
  created_at timestamptz default now(),
  last_msg_at timestamptz default now(),
  is_active boolean default true,
  metadata jsonb default '{}'::jsonb
);

create index if not exists idx_conv_user on hermes_conversations(user_id, last_msg_at desc);
create index if not exists idx_conv_chat on hermes_conversations(chat_id) where is_active = true;

-- 2. 消息表: 每条消息 1 行
create table if not exists hermes_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references hermes_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  name text,
  content text not null,
  tool_calls jsonb,                  -- assistant 调的工具
  tool_call_id text,                 -- tool 结果的 id
  feishu_message_id text,            -- 飞书消息 ID (用于回复/撤回)
  created_at timestamptz default now()
);

create index if not exists idx_msg_conv on hermes_messages(conversation_id, created_at);

-- 3. RLS: 全开 (service_role bypass; anon 不允许)
alter table hermes_conversations enable row level security;
alter table hermes_messages enable row level security;

-- 公开读 + service_role 写 (Vercel 用 service_role)
create policy "conv read" on hermes_conversations for select using (true);
create policy "msg read" on hermes_messages for select using (true);

-- 4. 自动更新 last_msg_at 触发器
create or replace function update_conv_last_msg() returns trigger as $$
begin
  update hermes_conversations
  set last_msg_at = now()
  where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_msg_update_conv on hermes_messages;
create trigger trg_msg_update_conv
  after insert on hermes_messages
  for each row execute function update_conv_last_msg();
