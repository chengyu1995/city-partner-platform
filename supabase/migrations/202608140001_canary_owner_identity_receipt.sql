begin;

do $$
declare
  v_digest oid;
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: owner session must be postgres';
  end if;

  if pg_catalog.to_regnamespace('public') is null then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: public schema is missing';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(
      coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
    ) a
    where n.nspname = 'public'
      and a.grantee = 0
      and a.privilege_type = 'CREATE'
  ) then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: PUBLIC CREATE on public schema must be false';
  end if;

  if pg_catalog.to_regclass('public.hermes_canary_owner_identity_receipts') is not null then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: target table already exists';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'capture_canary_owner_identity_receipt',
        'audit_canary_owner_identity_receipt'
      )
  ) then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: target function name already exists';
  end if;

  v_digest := pg_catalog.to_regprocedure('extensions.digest(text,text)');
  if v_digest is null or not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = v_digest
      and p.prokind = 'f'
      and pg_catalog.pg_get_function_result(p.oid) = 'bytea'
  ) then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: extensions.digest(text, text) missing';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
    or not exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'production_schema_audit_reader'
        and not rolsuper
        and not rolbypassrls
        and not rolcreatedb
        and not rolcreaterole
    )
  then
    raise exception 'IDENTITY_RECEIPT_PRECHECK_FAILED: required hardened roles missing';
  end if;
end
$$;

create table public.hermes_canary_owner_identity_receipts (
  receipt_id uuid primary key default pg_catalog.gen_random_uuid(),
  purpose text not null,
  nonce_sha256 text not null,
  status text not null,
  challenge_created_at timestamptz not null,
  challenge_expires_at timestamptz not null,
  owner_open_id text null,
  owner_open_id_sha256 text null,
  verified_event_id_sha256 text null,
  captured_at timestamptz null,
  receipt_expires_at timestamptz null,
  consumed_at timestamptz null,
  consumed_policy_id text null,
  constraint hermes_canary_owner_identity_receipt_purpose_check
    check (purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'),
  constraint hermes_canary_owner_identity_receipt_nonce_hash_check
    check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  constraint hermes_canary_owner_identity_receipt_owner_hash_check
    check (owner_open_id_sha256 is null or owner_open_id_sha256 ~ '^[0-9a-f]{64}$'),
  constraint hermes_canary_owner_identity_receipt_event_hash_check
    check (verified_event_id_sha256 is null or verified_event_id_sha256 ~ '^[0-9a-f]{64}$'),
  constraint hermes_canary_owner_identity_receipt_status_check
    check (status in ('PENDING', 'CAPTURED', 'CONSUMED', 'RETIRED')),
  constraint hermes_canary_owner_identity_receipt_challenge_time_check
    check (challenge_expires_at > challenge_created_at),
  constraint hermes_canary_owner_identity_receipt_capture_time_check
    check (
      (captured_at is null and receipt_expires_at is null)
      or (captured_at is not null and receipt_expires_at > captured_at)
    ),
  constraint hermes_canary_owner_identity_receipt_state_shape_check
    check (
      (
        status = 'PENDING'
        and owner_open_id is null
        and owner_open_id_sha256 is null
        and verified_event_id_sha256 is null
        and captured_at is null
        and receipt_expires_at is null
        and consumed_at is null
        and consumed_policy_id is null
      )
      or (
        status = 'CAPTURED'
        and owner_open_id is not null
        and owner_open_id_sha256 is not null
        and verified_event_id_sha256 is not null
        and captured_at is not null
        and receipt_expires_at is not null
        and consumed_at is null
        and consumed_policy_id is null
      )
      or (
        status = 'CONSUMED'
        and owner_open_id is null
        and owner_open_id_sha256 is not null
        and verified_event_id_sha256 is not null
        and captured_at is not null
        and receipt_expires_at is not null
        and consumed_at is not null
        and consumed_policy_id is not null
      )
      or (
        status = 'RETIRED'
        and owner_open_id is null
        and consumed_at is null
        and consumed_policy_id is null
        and (
          (
            owner_open_id_sha256 is null
            and verified_event_id_sha256 is null
            and captured_at is null
            and receipt_expires_at is null
          )
          or (
            owner_open_id_sha256 is not null
            and verified_event_id_sha256 is not null
            and captured_at is not null
            and receipt_expires_at is not null
          )
        )
      )
    )
);

create unique index hermes_canary_owner_identity_receipts_nonce_sha256_key
  on public.hermes_canary_owner_identity_receipts (nonce_sha256);

create unique index hermes_canary_owner_identity_receipts_verified_event_key
  on public.hermes_canary_owner_identity_receipts (verified_event_id_sha256)
  where verified_event_id_sha256 is not null;

create unique index hermes_canary_owner_identity_receipts_one_active_key
  on public.hermes_canary_owner_identity_receipts (purpose)
  where status in ('PENDING', 'CAPTURED');

alter table public.hermes_canary_owner_identity_receipts enable row level security;

revoke all on table public.hermes_canary_owner_identity_receipts
  from public, anon, authenticated, authenticator, service_role, production_schema_audit_reader;

create function public.capture_canary_owner_identity_receipt(
  p_nonce_sha256 text,
  p_verified_owner_open_id text,
  p_verified_event_id text
) returns table (
  receipt_id uuid,
  capture_outcome text,
  owner_open_id_sha256 text,
  verified_event_id_sha256 text,
  receipt_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  v_now timestamptz;
  v_owner_sha256 text;
  v_event_sha256 text;
  v_receipt public.hermes_canary_owner_identity_receipts%rowtype;
begin
  if p_nonce_sha256 is null
    or p_nonce_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(pg_catalog.btrim(p_verified_owner_open_id), '') is null
    or nullif(pg_catalog.btrim(p_verified_event_id), '') is null
  then
    return query select null::uuid, 'DENIED'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_owner_sha256 := pg_catalog.encode(
    extensions.digest(p_verified_owner_open_id, 'sha256'),
    'hex'
  );
  v_event_sha256 := pg_catalog.encode(
    extensions.digest(p_verified_event_id, 'sha256'),
    'hex'
  );

  update public.hermes_canary_owner_identity_receipts r
  set
    status = 'CAPTURED',
    owner_open_id = p_verified_owner_open_id,
    owner_open_id_sha256 = v_owner_sha256,
    verified_event_id_sha256 = v_event_sha256,
    captured_at = v_now,
    receipt_expires_at = v_now + interval '900 seconds'
  where r.purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'
    and r.nonce_sha256 = p_nonce_sha256
    and r.status = 'PENDING'
    and r.challenge_expires_at > v_now
    and r.owner_open_id is null
    and r.owner_open_id_sha256 is null
    and r.verified_event_id_sha256 is null
    and r.captured_at is null
    and r.receipt_expires_at is null
    and r.consumed_at is null
    and r.consumed_policy_id is null
  returning r.* into v_receipt;

  if v_receipt.receipt_id is not null then
    return query select
      v_receipt.receipt_id,
      'CAPTURED'::text,
      v_receipt.owner_open_id_sha256,
      v_receipt.verified_event_id_sha256,
      v_receipt.receipt_expires_at;
    return;
  end if;

  select r.* into v_receipt
  from public.hermes_canary_owner_identity_receipts r
  where r.purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'
    and r.nonce_sha256 = p_nonce_sha256;

  if v_receipt.status = 'CAPTURED'
    and v_receipt.owner_open_id_sha256 = v_owner_sha256
    and v_receipt.verified_event_id_sha256 = v_event_sha256
  then
    return query select
      v_receipt.receipt_id,
      'IDEMPOTENT_ALREADY_CAPTURED'::text,
      v_receipt.owner_open_id_sha256,
      v_receipt.verified_event_id_sha256,
      v_receipt.receipt_expires_at;
    return;
  end if;

  return query select null::uuid, 'DENIED'::text, null::text, null::text, null::timestamptz;
exception
  when unique_violation then
    return query select null::uuid, 'DENIED'::text, null::text, null::text, null::timestamptz;
end
$function$;

alter function public.capture_canary_owner_identity_receipt(text, text, text) owner to postgres;

revoke all on function public.capture_canary_owner_identity_receipt(text, text, text)
  from public, anon, authenticated, authenticator, service_role, production_schema_audit_reader;
grant execute on function public.capture_canary_owner_identity_receipt(text, text, text)
  to service_role;

create function public.audit_canary_owner_identity_receipt(
  p_receipt_id uuid,
  p_purpose text,
  p_nonce_sha256 text
) returns table (
  receipt_id uuid,
  purpose text,
  status text,
  nonce_sha256 text,
  owner_open_id_sha256 text,
  verified_event_id_sha256 text,
  challenge_created_at timestamptz,
  challenge_expires_at timestamptz,
  captured_at timestamptz,
  receipt_expires_at timestamptz,
  consumed_at timestamptz,
  consumed_policy_id text,
  raw_owner_present boolean,
  challenge_expired boolean,
  receipt_expired boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select
    r.receipt_id,
    r.purpose,
    r.status,
    r.nonce_sha256,
    r.owner_open_id_sha256,
    r.verified_event_id_sha256,
    r.challenge_created_at,
    r.challenge_expires_at,
    r.captured_at,
    r.receipt_expires_at,
    r.consumed_at,
    r.consumed_policy_id,
    r.owner_open_id is not null as raw_owner_present,
    r.challenge_expires_at <= pg_catalog.statement_timestamp() as challenge_expired,
    coalesce(r.receipt_expires_at <= pg_catalog.statement_timestamp(), false) as receipt_expired
  from public.hermes_canary_owner_identity_receipts r
  where p_receipt_id is not null
    and p_purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'
    and p_nonce_sha256 ~ '^[0-9a-f]{64}$'
    and r.receipt_id = p_receipt_id
    and r.purpose = p_purpose
    and r.nonce_sha256 = p_nonce_sha256;
$function$;

alter function public.audit_canary_owner_identity_receipt(uuid, text, text) owner to postgres;

revoke all on function public.audit_canary_owner_identity_receipt(uuid, text, text)
  from public, anon, authenticated, authenticator, service_role, production_schema_audit_reader;
grant execute on function public.audit_canary_owner_identity_receipt(uuid, text, text)
  to production_schema_audit_reader;

do $$
declare
  v_capture oid := pg_catalog.to_regprocedure(
    'public.capture_canary_owner_identity_receipt(text,text,text)'
  );
  v_audit oid := pg_catalog.to_regprocedure(
    'public.audit_canary_owner_identity_receipt(uuid,text,text)'
  );
begin
  if pg_catalog.to_regclass('public.hermes_canary_owner_identity_receipts') is null
    or v_capture is null
    or v_audit is null
  then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: target object missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'hermes_canary_owner_identity_receipts'
      and c.relkind = 'r'
      and c.relrowsecurity
      and not c.relforcerowsecurity
  ) or exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = 'public.hermes_canary_owner_identity_receipts'::regclass
  ) then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: RLS contract mismatch';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles r
    where r.rolname in (
      'anon', 'authenticated', 'authenticator', 'service_role',
      'production_schema_audit_reader'
    )
      and pg_catalog.has_table_privilege(
        r.rolname,
        'public.hermes_canary_owner_identity_receipts',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
  ) then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: direct table ACL mismatch';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(
      coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) a
    where c.oid = 'public.hermes_canary_owner_identity_receipts'::regclass
      and a.grantee = 0
  ) then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: PUBLIC table ACL mismatch';
  end if;

  if exists (
    select 1 from pg_catalog.aclexplode((select proacl from pg_catalog.pg_proc where oid = v_capture)) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  )
    or not pg_catalog.has_function_privilege('service_role', v_capture, 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', v_capture, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', v_capture, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticator', v_capture, 'EXECUTE')
    or pg_catalog.has_function_privilege('production_schema_audit_reader', v_capture, 'EXECUTE')
  then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: capture function ACL mismatch';
  end if;

  if exists (
    select 1 from pg_catalog.aclexplode((select proacl from pg_catalog.pg_proc where oid = v_audit)) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  )
    or pg_catalog.has_function_privilege('service_role', v_audit, 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', v_audit, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', v_audit, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticator', v_audit, 'EXECUTE')
    or not pg_catalog.has_function_privilege('production_schema_audit_reader', v_audit, 'EXECUTE')
  then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: audit function ACL mismatch';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid = v_capture
      and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      and l.lanname = 'plpgsql'
      and p.provolatile = 'v'
      and p.prosecdef
      and p.proconfig = array['search_path=pg_catalog']
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid = v_audit
      and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      and l.lanname = 'sql'
      and p.provolatile = 's'
      and p.prosecdef
      and p.proconfig = array['search_path=pg_catalog']
  ) then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: function security contract mismatch';
  end if;

  if exists (select 1 from public.hermes_canary_owner_identity_receipts) then
    raise exception 'IDENTITY_RECEIPT_POSTCHECK_FAILED: migration seeded receipt data';
  end if;
end
$$;

commit;
