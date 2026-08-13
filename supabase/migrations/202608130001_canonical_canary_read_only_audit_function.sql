begin;

do $$
declare
  v_missing text[];
begin
  if current_user <> 'postgres' then
    raise exception 'AUDIT_FUNCTION_PRECHECK_FAILED: current_user must be postgres';
  end if;

  if pg_catalog.to_regprocedure(
    'public.audit_canonical_canary_scope_state(text,text,text,text,text)'
  ) is not null then
    raise exception 'AUDIT_FUNCTION_PRECHECK_FAILED: target function already exists';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions'
      and p.proname = 'digest'
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'text, text'
  ) then
    raise exception 'AUDIT_FUNCTION_PRECHECK_FAILED: extensions.digest(text, text) missing';
  end if;

  select pg_catalog.array_agg(required.object_name order by required.object_name)
  into v_missing
  from (
    values
      ('public.hermes_canonical_canary_policy_rules'),
      ('public.hermes_canonical_canary_admissions'),
      ('public.hermes_jobs'),
      ('public.hermes_job_attempts'),
      ('public.hermes_job_leases'),
      ('public.hermes_job_terminals'),
      ('public.hermes_job_results')
  ) as required(object_name)
  where pg_catalog.to_regclass(required.object_name) is null;

  if v_missing is not null then
    raise exception 'AUDIT_FUNCTION_PRECHECK_FAILED: required tables missing: %', v_missing;
  end if;

  select pg_catalog.array_agg(named.object_name order by named.object_name)
  into v_missing
  from (
    values
      ('hermes_canonical_canary_policy_rules', 'policy_id'),
      ('hermes_canonical_canary_policy_rules', 'owner_open_id'),
      ('hermes_canonical_canary_policy_rules', 'batch_code'),
      ('hermes_canonical_canary_policy_rules', 'requested_mode'),
      ('hermes_canonical_canary_policy_rules', 'enabled'),
      ('hermes_canonical_canary_admissions', 'admission_id'),
      ('hermes_canonical_canary_admissions', 'policy_id'),
      ('hermes_canonical_canary_admissions', 'owner_open_id'),
      ('hermes_canonical_canary_admissions', 'batch_code'),
      ('hermes_canonical_canary_admissions', 'requested_mode'),
      ('hermes_canonical_canary_admissions', 'event_id'),
      ('hermes_canonical_canary_admissions', 'job_id'),
      ('hermes_canonical_canary_admissions', 'created_at'),
      ('hermes_canonical_canary_admissions', 'consumed_at'),
      ('hermes_jobs', 'id'),
      ('hermes_jobs', 'requester_id'),
      ('hermes_jobs', 'source_event_id'),
      ('hermes_jobs', 'source_message_id'),
      ('hermes_jobs', 'requested_mode'),
      ('hermes_jobs', 'status'),
      ('hermes_jobs', 'canonical_job_state'),
      ('hermes_jobs', 'canonical_revision'),
      ('hermes_jobs', 'created_at'),
      ('hermes_jobs', 'updated_at'),
      ('hermes_job_attempts', 'attempt_id'),
      ('hermes_job_attempts', 'job_id'),
      ('hermes_job_leases', 'lease_id'),
      ('hermes_job_leases', 'job_id'),
      ('hermes_job_terminals', 'terminal_id'),
      ('hermes_job_terminals', 'job_id'),
      ('hermes_job_results', 'id'),
      ('hermes_job_results', 'job_id')
  ) as required(table_name, column_name)
  cross join lateral (
    select pg_catalog.format('public.%I.%I', required.table_name, required.column_name) as object_name
  ) named
  where not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.to_regclass('public.' || required.table_name)
      and a.attname = required.column_name
      and a.attnum > 0
      and not a.attisdropped
  );

  if v_missing is not null then
    raise exception 'AUDIT_FUNCTION_PRECHECK_FAILED: required columns missing: %', v_missing;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'production_schema_audit_reader'
  ) or not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'anon'
  ) or not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'authenticated'
  ) or not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'authenticator'
  ) or not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'service_role'
  ) then
    raise exception 'AUDIT_FUNCTION_PRECHECK_FAILED: required roles missing';
  end if;
end
$$;

create or replace function public.audit_canonical_canary_scope_state(
  p_policy_id text,
  p_owner_open_id_sha256 text,
  p_batch_code_sha256 text,
  p_requested_mode text,
  p_event_id_sha256 text
) returns table (
  policy_id text,
  owner_open_id_sha256 text,
  batch_code_sha256 text,
  requested_mode text,
  event_id_sha256 text,
  scope_input_valid boolean,
  policy_row_count bigint,
  policy_enabled boolean,
  scope_admission_count bigint,
  matching_event_admission_count bigint,
  admission_id uuid,
  admission_created_at timestamptz,
  admission_consumed_at timestamptz,
  scope_job_count bigint,
  event_job_count bigint,
  job_id uuid,
  job_status text,
  canonical_job_state text,
  canonical_revision bigint,
  job_requested_mode text,
  source_event_id_sha256 text,
  source_message_id_sha256 text,
  job_created_at timestamptz,
  job_updated_at timestamptz,
  attempt_count bigint,
  attempt_ids text[],
  lease_count bigint,
  lease_ids text[],
  terminal_count bigint,
  terminal_ids uuid[],
  result_count bigint,
  result_exists boolean,
  duplicate_admission_detected boolean,
  duplicate_job_detected boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  with input_scope as (
    select
      p_policy_id as policy_id,
      p_owner_open_id_sha256 as owner_open_id_sha256,
      p_batch_code_sha256 as batch_code_sha256,
      p_requested_mode as requested_mode,
      p_event_id_sha256 as event_id_sha256,
      nullif(pg_catalog.btrim(p_policy_id), '') is not null
        and p_owner_open_id_sha256 ~ '^[0-9a-f]{64}$'
        and p_batch_code_sha256 ~ '^[0-9a-f]{64}$'
        and p_requested_mode = 'worker_read_only'
        and p_event_id_sha256 ~ '^[0-9a-f]{64}$' as scope_input_valid
  ),
  scope_policy as (
    select p.*
    from public.hermes_canonical_canary_policy_rules p
    cross join input_scope i
    where i.scope_input_valid
      and p.policy_id = i.policy_id
      and p.requested_mode = i.requested_mode
      and pg_catalog.encode(extensions.digest(p.owner_open_id, 'sha256'), 'hex') = i.owner_open_id_sha256
      and pg_catalog.encode(extensions.digest(p.batch_code, 'sha256'), 'hex') = i.batch_code_sha256
  ),
  scope_admissions as (
    select a.*
    from public.hermes_canonical_canary_admissions a
    cross join input_scope i
    where i.scope_input_valid
      and a.policy_id = i.policy_id
      and a.requested_mode = i.requested_mode
      and pg_catalog.encode(extensions.digest(a.owner_open_id, 'sha256'), 'hex') = i.owner_open_id_sha256
      and pg_catalog.encode(extensions.digest(a.batch_code, 'sha256'), 'hex') = i.batch_code_sha256
  ),
  matching_admissions as (
    select a.*
    from scope_admissions a
    cross join input_scope i
    where pg_catalog.encode(extensions.digest(a.event_id, 'sha256'), 'hex') = i.event_id_sha256
  ),
  selected_admission as (
    select a.*
    from matching_admissions a
    order by a.created_at, a.admission_id
    limit 1
  ),
  scope_jobs as (
    select distinct j.*
    from scope_admissions a
    join public.hermes_jobs j on j.id = a.job_id
  ),
  event_jobs as (
    select j.*
    from public.hermes_jobs j
    cross join input_scope i
    where i.scope_input_valid
      and exists (select 1 from scope_policy)
      and j.requested_mode = i.requested_mode
      and pg_catalog.encode(extensions.digest(coalesce(j.requester_id, ''), 'sha256'), 'hex') = i.owner_open_id_sha256
      and pg_catalog.encode(extensions.digest(coalesce(j.source_event_id, ''), 'sha256'), 'hex') = i.event_id_sha256
  ),
  selected_job as (
    select j.*
    from selected_admission a
    join public.hermes_jobs j on j.id = a.job_id
    limit 1
  ),
  attempt_summary as (
    select
      pg_catalog.count(*)::bigint as row_count,
      coalesce(
        pg_catalog.array_agg(a.attempt_id order by a.attempt_id),
        array[]::text[]
      ) as ids
    from public.hermes_job_attempts a
    where a.job_id = (select j.id from selected_job j)
  ),
  lease_summary as (
    select
      pg_catalog.count(*)::bigint as row_count,
      coalesce(
        pg_catalog.array_agg(l.lease_id order by l.lease_id),
        array[]::text[]
      ) as ids
    from public.hermes_job_leases l
    where l.job_id = (select j.id from selected_job j)
  ),
  terminal_summary as (
    select
      pg_catalog.count(*)::bigint as row_count,
      coalesce(
        pg_catalog.array_agg(t.terminal_id order by t.terminal_id),
        array[]::uuid[]
      ) as ids
    from public.hermes_job_terminals t
    where t.job_id = (select j.id from selected_job j)
  ),
  result_summary as (
    select pg_catalog.count(*)::bigint as row_count
    from public.hermes_job_results r
    where r.job_id = (select j.id from selected_job j)
  )
  select
    case when i.scope_input_valid then i.policy_id else null end,
    case when i.scope_input_valid then i.owner_open_id_sha256 else null end,
    case when i.scope_input_valid then i.batch_code_sha256 else null end,
    case when i.scope_input_valid then i.requested_mode else null end,
    case when i.scope_input_valid then i.event_id_sha256 else null end,
    i.scope_input_valid,
    (select pg_catalog.count(*)::bigint from scope_policy),
    coalesce((select pg_catalog.bool_or(p.enabled) from scope_policy p), false),
    (select pg_catalog.count(*)::bigint from scope_admissions),
    (select pg_catalog.count(*)::bigint from matching_admissions),
    (select a.admission_id from selected_admission a),
    (select a.created_at from selected_admission a),
    (select a.consumed_at from selected_admission a),
    (select pg_catalog.count(*)::bigint from scope_jobs),
    (select pg_catalog.count(*)::bigint from event_jobs),
    (select j.id from selected_job j),
    (select j.status from selected_job j),
    (select j.canonical_job_state from selected_job j),
    (select j.canonical_revision from selected_job j),
    (select j.requested_mode from selected_job j),
    (select case when j.source_event_id is null then null else pg_catalog.encode(extensions.digest(j.source_event_id, 'sha256'), 'hex') end from selected_job j),
    (select case when j.source_message_id is null then null else pg_catalog.encode(extensions.digest(j.source_message_id, 'sha256'), 'hex') end from selected_job j),
    (select j.created_at from selected_job j),
    (select j.updated_at from selected_job j),
    (select s.row_count from attempt_summary s),
    (select s.ids from attempt_summary s),
    (select s.row_count from lease_summary s),
    (select s.ids from lease_summary s),
    (select s.row_count from terminal_summary s),
    (select s.ids from terminal_summary s),
    (select s.row_count from result_summary s),
    (select s.row_count > 0 from result_summary s),
    (
      (select pg_catalog.count(*) from scope_admissions) > 1
      or (select pg_catalog.count(*) from matching_admissions) > 1
    ),
    (
      (select pg_catalog.count(*) from scope_jobs) > 1
      or (select pg_catalog.count(*) from event_jobs) > 1
    )
  from input_scope i;
$function$;

alter function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  owner to postgres;

revoke all on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  from public;
revoke all on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  from anon;
revoke all on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  from authenticated;
revoke all on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  from authenticator;
revoke all on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  from service_role;
revoke all on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  from production_schema_audit_reader;

grant execute on function public.audit_canonical_canary_scope_state(text, text, text, text, text)
  to production_schema_audit_reader;

do $$
declare
  v_function oid := pg_catalog.to_regprocedure(
    'public.audit_canonical_canary_scope_state(text,text,text,text,text)'
  );
begin
  if v_function is null then
    raise exception 'AUDIT_FUNCTION_POSTCHECK_FAILED: function missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = v_function
      and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef
      and p.provolatile = 's'
      and p.prolang = (
        select l.oid from pg_catalog.pg_language l where l.lanname = 'sql'
      )
      and p.proconfig = array['search_path=pg_catalog']
  ) then
    raise exception 'AUDIT_FUNCTION_POSTCHECK_FAILED: function security contract mismatch';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    where p.oid = v_function
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
    or pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE')
    or pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
    or not pg_catalog.has_function_privilege(
      'production_schema_audit_reader', v_function, 'EXECUTE'
    )
  then
    raise exception 'AUDIT_FUNCTION_POSTCHECK_FAILED: function ACL mismatch';
  end if;
end
$$;

-- Controlled rollback (execute separately only after an approved rollback audit):
-- drop function if exists public.audit_canonical_canary_scope_state(text, text, text, text, text);

commit;
