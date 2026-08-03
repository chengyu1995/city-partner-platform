begin;

alter table public.hermes_jobs
  add column if not exists canonical_job_state text null
    check (canonical_job_state in (
      'created', 'queued', 'claimed', 'running',
      'terminal_success', 'terminal_failed', 'terminal_cancelled'
    )),
  add column if not exists canonical_revision bigint null
    check (canonical_revision >= 0),
  add column if not exists requested_mode text null,
  add column if not exists plan_id text null,
  add column if not exists subtask_id text null,
  add column if not exists terminal_at timestamptz null;

create table if not exists public.hermes_job_attempts (
  attempt_id text primary key,
  job_id uuid not null references public.hermes_jobs(id) on delete restrict,
  attempt_number bigint not null check (attempt_number > 0),
  worker_id text not null,
  attempt_state text not null check (attempt_state in (
    'created', 'claimed', 'running', 'finished', 'failed', 'abandoned', 'superseded'
  )),
  started_at timestamptz null,
  last_activity_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, attempt_id),
  unique (job_id, attempt_number)
);

create table if not exists public.hermes_job_leases (
  lease_id text primary key,
  job_id uuid not null,
  attempt_id text not null,
  worker_id text not null,
  lease_state text not null check (lease_state in ('active', 'expired', 'released')),
  acquired_at timestamptz not null,
  heartbeat_at timestamptz null,
  expires_at timestamptz not null,
  released_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, attempt_id)
    references public.hermes_job_attempts(job_id, attempt_id) on delete restrict
);

create table if not exists public.hermes_job_terminals (
  terminal_id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.hermes_jobs(id) on delete restrict,
  attempt_id text not null,
  worker_id text not null,
  report_identity text not null,
  worker_execution_status text not null,
  task_goal_status text not null,
  effective_final_status text not null,
  failure_code text null,
  failure_stage text null,
  terminal_at timestamptz not null,
  canonical_report jsonb not null,
  created_at timestamptz not null default now(),
  constraint hermes_job_terminals_first_truth_per_job unique (job_id),
  foreign key (job_id, attempt_id)
    references public.hermes_job_attempts(job_id, attempt_id) on delete restrict
);

create unique index if not exists hermes_job_attempts_one_active_per_job
  on public.hermes_job_attempts(job_id)
  where attempt_state in ('claimed', 'running');

create unique index if not exists hermes_job_leases_one_active_per_job
  on public.hermes_job_leases(job_id)
  where lease_state = 'active';

create unique index if not exists hermes_job_leases_one_active_per_attempt
  on public.hermes_job_leases(attempt_id)
  where lease_state = 'active';

create index if not exists hermes_job_leases_history
  on public.hermes_job_leases(job_id, acquired_at);

create index if not exists hermes_job_leases_attempt_history
  on public.hermes_job_leases(attempt_id, created_at);

create index if not exists hermes_jobs_canonical_selectable
  on public.hermes_jobs(canonical_job_state, canonical_revision, created_at)
  where canonical_job_state = 'queued' and terminal_at is null;

alter table public.hermes_job_attempts enable row level security;
alter table public.hermes_job_leases enable row level security;
alter table public.hermes_job_terminals enable row level security;

create or replace function public.canonical_acquire_attempt_lease(
  p_job_id uuid,
  p_worker_id text,
  p_attempt_id text,
  p_lease_id text,
  p_expected_revision bigint,
  p_now timestamptz,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.hermes_jobs%rowtype;
  v_attempt_number bigint;
begin
  if p_expected_revision is null then
    raise exception 'EXPECTED_REVISION_REQUIRED';
  end if;
  if p_worker_id is null or p_attempt_id is null or p_lease_id is null then
    raise exception 'CLAIM_IDENTITY_REQUIRED';
  end if;
  if p_expires_at <= p_now then
    raise exception 'LEASE_EXPIRY_INVALID';
  end if;

  select * into v_job
  from public.hermes_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'JOB_NOT_FOUND';
  end if;
  if v_job.canonical_revision is null or v_job.canonical_job_state is null then
    raise exception 'CANONICAL_JOB_NOT_INITIALIZED';
  end if;
  if v_job.canonical_revision <> p_expected_revision then
    raise exception 'STALE_REVISION';
  end if;
  if v_job.terminal_at is not null or v_job.canonical_job_state like 'terminal_%' then
    raise exception 'TERMINAL_JOB_IMMUTABLE';
  end if;
  if v_job.canonical_job_state <> 'queued' then
    raise exception 'JOB_NOT_QUEUED';
  end if;
  if exists (
    select 1 from public.hermes_job_attempts
    where job_id = p_job_id and attempt_state in ('claimed', 'running')
  ) then
    raise exception 'ACTIVE_ATTEMPT_EXISTS';
  end if;
  if exists (
    select 1 from public.hermes_job_leases
    where job_id = p_job_id and lease_state = 'active'
  ) then
    raise exception 'ACTIVE_LEASE_EXISTS';
  end if;

  select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
  from public.hermes_job_attempts
  where job_id = p_job_id;

  insert into public.hermes_job_attempts (
    attempt_id, job_id, attempt_number, worker_id, attempt_state,
    started_at, last_activity_at, created_at, updated_at
  ) values (
    p_attempt_id, p_job_id, v_attempt_number, p_worker_id, 'claimed',
    p_now, p_now, p_now, p_now
  );

  insert into public.hermes_job_leases (
    lease_id, job_id, attempt_id, worker_id, lease_state,
    acquired_at, heartbeat_at, expires_at, created_at, updated_at
  ) values (
    p_lease_id, p_job_id, p_attempt_id, p_worker_id, 'active',
    p_now, p_now, p_expires_at, p_now, p_now
  );

  update public.hermes_jobs
  set canonical_job_state = 'claimed',
      canonical_revision = p_expected_revision + 1,
      updated_at = p_now
  where id = p_job_id
    and canonical_revision = p_expected_revision
    and canonical_job_state = 'queued'
    and terminal_at is null;

  if not found then
    raise exception 'CLAIM_COMPARE_AND_SET_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'job_id', p_job_id,
    'attempt_id', p_attempt_id,
    'lease_id', p_lease_id,
    'attempt_number', v_attempt_number,
    'revision', p_expected_revision + 1
  );
end;
$$;

revoke all on function public.canonical_acquire_attempt_lease(
  uuid, text, text, text, bigint, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.canonical_acquire_attempt_lease(
  uuid, text, text, text, bigint, timestamptz, timestamptz
) to service_role;

create or replace function public.canonical_record_runtime_signal(
  p_job_id uuid,
  p_attempt_id text,
  p_worker_id text,
  p_expected_revision bigint,
  p_signal text,
  p_now timestamptz,
  p_new_expires_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.hermes_jobs%rowtype;
  v_attempt public.hermes_job_attempts%rowtype;
  v_lease public.hermes_job_leases%rowtype;
begin
  if p_expected_revision is null then
    raise exception 'EXPECTED_REVISION_REQUIRED';
  end if;
  if p_signal not in ('heartbeat', 'progress') then
    raise exception 'RUNTIME_SIGNAL_INVALID';
  end if;

  select * into v_job
  from public.hermes_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'JOB_NOT_FOUND';
  end if;
  if v_job.terminal_at is not null or v_job.canonical_job_state like 'terminal_%' then
    return jsonb_build_object('ok', true, 'terminal_noop', true, 'revision', v_job.canonical_revision);
  end if;
  if v_job.canonical_revision <> p_expected_revision then
    raise exception 'STALE_REVISION';
  end if;
  if v_job.canonical_job_state not in ('claimed', 'running') then
    raise exception 'JOB_NOT_ACTIVE';
  end if;

  select * into v_attempt
  from public.hermes_job_attempts
  where attempt_id = p_attempt_id and job_id = p_job_id
  for update;

  if not found or v_attempt.worker_id <> p_worker_id then
    raise exception 'ATTEMPT_OWNERSHIP_MISMATCH';
  end if;
  if v_attempt.attempt_state not in ('claimed', 'running') then
    raise exception 'ATTEMPT_NOT_ACTIVE';
  end if;

  select * into v_lease
  from public.hermes_job_leases
  where job_id = p_job_id and attempt_id = p_attempt_id and lease_state = 'active'
  for update;

  if not found or v_lease.worker_id <> p_worker_id then
    raise exception 'LEASE_OWNERSHIP_MISMATCH';
  end if;
  if v_lease.expires_at <= p_now then
    raise exception 'LEASE_EXPIRED';
  end if;

  update public.hermes_job_attempts
  set attempt_state = case when attempt_state = 'claimed' then 'running' else attempt_state end,
      last_activity_at = p_now,
      updated_at = p_now
  where attempt_id = p_attempt_id and job_id = p_job_id and worker_id = p_worker_id;

  if p_signal = 'heartbeat' then
    if p_new_expires_at is null or p_new_expires_at <= p_now then
      raise exception 'LEASE_EXTENSION_INVALID';
    end if;
    update public.hermes_job_leases
    set heartbeat_at = p_now,
        expires_at = p_new_expires_at,
        updated_at = p_now
    where lease_id = v_lease.lease_id and lease_state = 'active';
  end if;

  update public.hermes_jobs
  set canonical_job_state = 'running',
      canonical_revision = p_expected_revision + 1,
      updated_at = p_now
  where id = p_job_id
    and canonical_revision = p_expected_revision
    and canonical_job_state in ('claimed', 'running')
    and terminal_at is null;

  if not found then
    raise exception 'RUNTIME_SIGNAL_COMPARE_AND_SET_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'terminal_noop', false,
    'signal', p_signal,
    'revision', p_expected_revision + 1
  );
end;
$$;

revoke all on function public.canonical_record_runtime_signal(
  uuid, text, text, bigint, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.canonical_record_runtime_signal(
  uuid, text, text, bigint, text, timestamptz, timestamptz
) to service_role;

create or replace function public.canonical_finalize_terminal(
  p_job_id uuid,
  p_attempt_id text,
  p_worker_id text,
  p_expected_revision bigint,
  p_report_identity text,
  p_terminal_job_state text,
  p_final_attempt_state text,
  p_worker_execution_status text,
  p_task_goal_status text,
  p_effective_final_status text,
  p_failure_code text,
  p_failure_stage text,
  p_canonical_report jsonb,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.hermes_jobs%rowtype;
  v_attempt public.hermes_job_attempts%rowtype;
  v_lease public.hermes_job_leases%rowtype;
  v_terminal public.hermes_job_terminals%rowtype;
begin
  if p_expected_revision is null then
    raise exception 'EXPECTED_REVISION_REQUIRED';
  end if;
  if p_terminal_job_state not in ('terminal_success', 'terminal_failed', 'terminal_cancelled') then
    raise exception 'TERMINAL_JOB_STATE_INVALID';
  end if;
  if p_final_attempt_state not in ('finished', 'failed', 'abandoned') then
    raise exception 'TERMINAL_ATTEMPT_STATE_INVALID';
  end if;
  if p_task_goal_status = 'failed' and p_effective_final_status = 'succeeded' then
    raise exception 'TASK_FAILURE_CANNOT_SUCCEED';
  end if;

  select * into v_job
  from public.hermes_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'JOB_NOT_FOUND';
  end if;

  select * into v_terminal
  from public.hermes_job_terminals
  where job_id = p_job_id;

  if found then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'first_terminal_truth_preserved', true,
      'terminal_id', v_terminal.terminal_id,
      'report_identity', v_terminal.report_identity,
      'revision', v_job.canonical_revision
    );
  end if;
  if v_job.terminal_at is not null or v_job.canonical_job_state like 'terminal_%' then
    raise exception 'TERMINAL_RECORD_REQUIRED_FOR_TERMINAL_JOB';
  end if;
  if v_job.canonical_revision <> p_expected_revision then
    raise exception 'STALE_REVISION';
  end if;

  select * into v_attempt
  from public.hermes_job_attempts
  where attempt_id = p_attempt_id and job_id = p_job_id
  for update;

  if not found or v_attempt.worker_id <> p_worker_id then
    raise exception 'ATTEMPT_OWNERSHIP_MISMATCH';
  end if;
  if v_attempt.attempt_state not in ('claimed', 'running') then
    raise exception 'ATTEMPT_NOT_ACTIVE';
  end if;

  select * into v_lease
  from public.hermes_job_leases
  where job_id = p_job_id and attempt_id = p_attempt_id and lease_state = 'active'
  for update;

  if not found or v_lease.worker_id <> p_worker_id then
    raise exception 'LEASE_OWNERSHIP_MISMATCH';
  end if;

  insert into public.hermes_job_terminals (
    job_id, attempt_id, worker_id, report_identity,
    worker_execution_status, task_goal_status, effective_final_status,
    failure_code, failure_stage, terminal_at, canonical_report
  ) values (
    p_job_id, p_attempt_id, p_worker_id, p_report_identity,
    p_worker_execution_status, p_task_goal_status, p_effective_final_status,
    p_failure_code, p_failure_stage, p_now, p_canonical_report
  ) returning * into v_terminal;

  update public.hermes_job_attempts
  set attempt_state = p_final_attempt_state,
      last_activity_at = p_now,
      finished_at = p_now,
      updated_at = p_now
  where attempt_id = p_attempt_id and job_id = p_job_id and worker_id = p_worker_id;

  update public.hermes_job_leases
  set lease_state = 'released',
      released_at = p_now,
      updated_at = p_now
  where lease_id = v_lease.lease_id and lease_state = 'active';

  update public.hermes_jobs
  set canonical_job_state = p_terminal_job_state,
      canonical_revision = p_expected_revision + 1,
      terminal_at = p_now,
      updated_at = p_now
  where id = p_job_id
    and canonical_revision = p_expected_revision
    and canonical_job_state in ('claimed', 'running')
    and terminal_at is null;

  if not found then
    raise exception 'TERMINAL_COMPARE_AND_SET_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'first_terminal_truth_preserved', true,
    'terminal_id', v_terminal.terminal_id,
    'report_identity', v_terminal.report_identity,
    'revision', p_expected_revision + 1
  );
end;
$$;

revoke all on function public.canonical_finalize_terminal(
  uuid, text, text, bigint, text, text, text, text, text, text,
  text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.canonical_finalize_terminal(
  uuid, text, text, bigint, text, text, text, text, text, text,
  text, text, jsonb, timestamptz
) to service_role;

create or replace function public.canonical_recover_stale_attempt(
  p_job_id uuid,
  p_attempt_id text,
  p_lease_id text,
  p_worker_id text,
  p_expected_revision bigint,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.hermes_jobs%rowtype;
  v_attempt public.hermes_job_attempts%rowtype;
  v_lease public.hermes_job_leases%rowtype;
begin
  if p_expected_revision is null then
    raise exception 'EXPECTED_REVISION_REQUIRED';
  end if;

  select * into v_job
  from public.hermes_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'JOB_NOT_FOUND';
  end if;
  if v_job.terminal_at is not null or v_job.canonical_job_state like 'terminal_%' then
    raise exception 'TERMINAL_JOB_IMMUTABLE';
  end if;
  if v_job.canonical_revision <> p_expected_revision then
    raise exception 'STALE_REVISION';
  end if;
  if v_job.canonical_job_state not in ('claimed', 'running') then
    raise exception 'JOB_NOT_ACTIVE';
  end if;

  select * into v_attempt
  from public.hermes_job_attempts
  where attempt_id = p_attempt_id and job_id = p_job_id
  for update;

  if not found or v_attempt.worker_id <> p_worker_id then
    raise exception 'ATTEMPT_OWNERSHIP_MISMATCH';
  end if;
  if v_attempt.attempt_state not in ('claimed', 'running') then
    raise exception 'ATTEMPT_NOT_ACTIVE';
  end if;

  select * into v_lease
  from public.hermes_job_leases
  where lease_id = p_lease_id and job_id = p_job_id and attempt_id = p_attempt_id
  for update;

  if not found or v_lease.worker_id <> p_worker_id then
    raise exception 'LEASE_OWNERSHIP_MISMATCH';
  end if;
  if v_lease.lease_state <> 'active' then
    raise exception 'LEASE_NOT_ACTIVE';
  end if;
  if v_lease.expires_at > p_now then
    raise exception 'LEASE_NOT_EXPIRED';
  end if;

  update public.hermes_job_leases
  set lease_state = 'expired',
      released_at = p_now,
      updated_at = p_now
  where lease_id = p_lease_id and lease_state = 'active';

  update public.hermes_job_attempts
  set attempt_state = 'abandoned',
      last_activity_at = p_now,
      finished_at = p_now,
      updated_at = p_now
  where attempt_id = p_attempt_id and job_id = p_job_id and worker_id = p_worker_id;

  update public.hermes_jobs
  set canonical_job_state = 'queued',
      canonical_revision = p_expected_revision + 1,
      updated_at = p_now
  where id = p_job_id
    and canonical_revision = p_expected_revision
    and canonical_job_state in ('claimed', 'running')
    and terminal_at is null;

  if not found then
    raise exception 'STALE_RECOVERY_COMPARE_AND_SET_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'recovered', true,
    'attempt_history_preserved', true,
    'lease_history_preserved', true,
    'closed_attempt_id', p_attempt_id,
    'released_lease_id', p_lease_id,
    'revision', p_expected_revision + 1
  );
end;
$$;

revoke all on function public.canonical_recover_stale_attempt(
  uuid, text, text, text, bigint, timestamptz
) from public, anon, authenticated;
grant execute on function public.canonical_recover_stale_attempt(
  uuid, text, text, text, bigint, timestamptz
) to service_role;

commit;
