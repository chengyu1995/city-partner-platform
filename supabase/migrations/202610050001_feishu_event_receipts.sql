begin;

create table if not exists public.feishu_event_receipts (
  event_id text primary key,
  message_id text,
  event_type text not null,
  chat_id text not null,
  sender_open_id text not null,
  status text not null default 'processing',
  error_text text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feishu_event_receipts_event_id_not_blank
    check (length(btrim(event_id)) > 0),
  constraint feishu_event_receipts_status_check
    check (status in ('processing', 'completed', 'failed'))
);

alter table public.feishu_event_receipts
  add column if not exists message_id text,
  add column if not exists event_type text,
  add column if not exists chat_id text,
  add column if not exists sender_open_id text,
  add column if not exists status text default 'processing',
  add column if not exists error_text text,
  add column if not exists completed_at timestamptz,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.feishu_event_receipts
  alter column event_id set not null,
  alter column event_type set not null,
  alter column chat_id set not null,
  alter column sender_open_id set not null,
  alter column status set default 'processing',
  alter column status set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

create unique index if not exists idx_feishu_event_receipts_event_id_unique
  on public.feishu_event_receipts (event_id);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.feishu_event_receipts'::regclass
       and conname = 'feishu_event_receipts_event_id_not_blank'
  ) then
    alter table public.feishu_event_receipts
      add constraint feishu_event_receipts_event_id_not_blank
      check (length(btrim(event_id)) > 0);
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.feishu_event_receipts'::regclass
       and conname = 'feishu_event_receipts_status_check'
  ) then
    alter table public.feishu_event_receipts
      add constraint feishu_event_receipts_status_check
      check (status in ('processing', 'completed', 'failed'));
  end if;
end;
$$;

create index if not exists idx_feishu_event_receipts_status_created_at
  on public.feishu_event_receipts (status, created_at);

alter table public.feishu_event_receipts enable row level security;

comment on table public.feishu_event_receipts is
  'Durable idempotency and completion receipt for authenticated Feishu callback events.';

comment on column public.feishu_event_receipts.error_text is
  'Sanitized operational failure summary. Secrets and message bodies must not be stored here.';

commit;
