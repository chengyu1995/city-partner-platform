-- Durable, one-shot admission for the first production Canonical canary.
-- This migration is an artifact only until a separately approved production migration batch.

alter table public.hermes_jobs
  add column if not exists request_text text null,
  add column if not exists payload jsonb null;

create table if not exists public.hermes_canonical_canary_policy_rules (
  policy_id text not null,
  owner_open_id text not null,
  batch_code text not null,
  requested_mode text not null check (requested_mode = 'worker_read_only'),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (policy_id, owner_open_id, batch_code, requested_mode),
  check (policy_id ~ '^[A-Z0-9][A-Z0-9._-]{2,127}$'),
  check (owner_open_id ~ '^ou_[A-Za-z0-9_-]+$'),
  check (batch_code ~ '^BATCH-[A-Z0-9]+(-[A-Z0-9]+)*$')
);

create table if not exists public.hermes_canonical_canary_admissions (
  admission_id uuid primary key default gen_random_uuid(),
  policy_id text not null,
  owner_open_id text not null,
  batch_code text not null,
  requested_mode text not null check (requested_mode = 'worker_read_only'),
  event_id text not null,
  request_id text not null,
  job_id uuid null references public.hermes_jobs(id),
  created_at timestamptz not null default now(),
  consumed_at timestamptz null,
  constraint hermes_canonical_canary_one_scope_once
    unique (policy_id, owner_open_id, batch_code, requested_mode),
  constraint hermes_canonical_canary_same_event_idempotent
    unique (policy_id, event_id)
);

alter table public.hermes_canonical_canary_policy_rules enable row level security;
alter table public.hermes_canonical_canary_admissions enable row level security;

create or replace function public.canonical_admit_canary_job(
  p_policy_id text,
  p_owner_open_id text,
  p_batch_code text,
  p_requested_mode text,
  p_event_id text,
  p_request_id text,
  p_job jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admission public.hermes_canonical_canary_admissions%rowtype;
  v_job_id uuid;
begin
  if nullif(btrim(p_policy_id), '') is null
    or nullif(btrim(p_owner_open_id), '') is null
    or nullif(btrim(p_batch_code), '') is null
    or nullif(btrim(p_event_id), '') is null
    or nullif(btrim(p_request_id), '') is null
  then
    return jsonb_build_object('allowed', false, 'reason_code', 'INVALID_CANARY_ADMISSION_IDENTITY');
  end if;

  if p_requested_mode is distinct from 'worker_read_only' then
    return jsonb_build_object('allowed', false, 'reason_code', 'MODE_NOT_ALLOWED');
  end if;

  if jsonb_typeof(p_job) is distinct from 'object'
    or p_job->>'schema' is distinct from 'canonical_canary_job_insert_v1'
    or p_job->>'source' is distinct from 'hermes_canonical_orchestration'
    or nullif(btrim(p_job->>'title'), '') is null
    or nullif(btrim(p_job->>'request_text'), '') is null
    or p_job->>'requested_mode' is distinct from p_requested_mode
    or nullif(btrim(p_job->>'plan_id'), '') is null
    or nullif(btrim(p_job->>'subtask_id'), '') is null
    or jsonb_typeof(p_job->'payload') is distinct from 'object'
    or p_job#>>'{payload,canonical_runtime}' is distinct from 'true'
    or jsonb_typeof(p_job->'state_snapshot') is distinct from 'object'
  then
    return jsonb_build_object('allowed', false, 'reason_code', 'MALFORMED_CANONICAL_JOB_PAYLOAD');
  end if;

  if p_job#>>'{payload,canonical_canary_admission,policy_id}' is distinct from p_policy_id
    or p_job#>>'{payload,canonical_canary_admission,trusted_owner_id}' is distinct from p_owner_open_id
    or p_job#>>'{payload,canonical_canary_admission,batch_code}' is distinct from p_batch_code
    or p_job#>>'{payload,canonical_canary_admission,requested_mode}' is distinct from p_requested_mode
    or p_job#>>'{payload,canonical_canary_admission,event_id}' is distinct from p_event_id
    or p_job#>>'{payload,canonical_canary_admission,request_id}' is distinct from p_request_id
  then
    return jsonb_build_object('allowed', false, 'reason_code', 'CANARY_JOB_ADMISSION_MISMATCH');
  end if;

  if not exists (
    select 1
    from public.hermes_canonical_canary_policy_rules
    where policy_id = p_policy_id
      and owner_open_id = p_owner_open_id
      and batch_code = p_batch_code
      and requested_mode = p_requested_mode
      and enabled = true
  ) then
    return jsonb_build_object('allowed', false, 'reason_code', 'POLICY_MISMATCH');
  end if;

  insert into public.hermes_canonical_canary_admissions (
    policy_id, owner_open_id, batch_code, requested_mode, event_id, request_id
  ) values (
    p_policy_id, p_owner_open_id, p_batch_code, p_requested_mode, p_event_id, p_request_id
  )
  on conflict on constraint hermes_canonical_canary_one_scope_once do nothing;

  select * into v_admission
  from public.hermes_canonical_canary_admissions
  where policy_id = p_policy_id
    and owner_open_id = p_owner_open_id
    and batch_code = p_batch_code
    and requested_mode = p_requested_mode
  for update;

  if v_admission.admission_id is null then
    return jsonb_build_object('allowed', false, 'reason_code', 'ADMISSION_PERSISTENCE_FAILED');
  end if;
  if v_admission.event_id <> p_event_id then
    return jsonb_build_object('allowed', false, 'reason_code', 'CANARY_ALREADY_CONSUMED');
  end if;
  if v_admission.job_id is not null then
    return jsonb_build_object(
      'allowed', true,
      'reason_code', 'ALLOW_IDEMPOTENT_RETRY',
      'idempotent', true,
      'job_id', v_admission.job_id
    );
  end if;

  v_job_id := gen_random_uuid();
  insert into public.hermes_jobs (
    id,
    source,
    title,
    request_text,
    status,
    payload,
    result,
    canonical_job_state,
    canonical_revision,
    requested_mode,
    plan_id,
    subtask_id,
    terminal_at
  ) values (
    v_job_id,
    p_job->>'source',
    btrim(p_job->>'title'),
    p_job->>'request_text',
    'pending',
    p_job->'payload',
    p_job->'state_snapshot',
    'queued',
    0,
    p_requested_mode,
    p_job->>'plan_id',
    p_job->>'subtask_id',
    null
  );

  update public.hermes_canonical_canary_admissions
  set job_id = v_job_id, consumed_at = now()
  where admission_id = v_admission.admission_id;

  return jsonb_build_object(
    'allowed', true,
    'reason_code', 'ALLOW',
    'idempotent', false,
    'job_id', v_job_id
  );
exception
  when unique_violation then
    return jsonb_build_object('allowed', false, 'reason_code', 'CANARY_ALREADY_CONSUMED');
end;
$$;

revoke all on table public.hermes_canonical_canary_policy_rules from public, anon, authenticated;
revoke all on table public.hermes_canonical_canary_admissions from public, anon, authenticated;
revoke all on function public.canonical_admit_canary_job(text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant select, insert, update on table public.hermes_canonical_canary_policy_rules to service_role;
grant select on table public.hermes_canonical_canary_admissions to service_role;
grant execute on function public.canonical_admit_canary_job(text, text, text, text, text, text, jsonb)
  to service_role;
