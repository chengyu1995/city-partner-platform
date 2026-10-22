begin;

do $$
declare
  v_problem text;
  v_signature text;
  v_function oid;
begin
  if current_user <> 'postgres' then
    raise exception 'HERMES_V2_RPC_ACL_PRECHECK_FAILED: current_user must be postgres';
  end if;

  select required.role_name
  into v_problem
  from (
    values ('anon'), ('authenticated'), ('authenticator'), ('service_role')
  ) as required(role_name)
  where not exists (
    select 1
    from pg_catalog.pg_roles r
    where r.rolname = required.role_name
  )
  order by required.role_name
  limit 1;

  if v_problem is not null then
    raise exception 'HERMES_V2_RPC_ACL_PRECHECK_FAILED: required role missing: %', v_problem;
  end if;

  for v_signature in
    select signature
    from (
      values
        ('public.hermes_v2_create_requirement_v1(text,text,text,text,text,text,text,text,text,text,jsonb)'),
        ('public.hermes_v2_store_plan_v1(uuid,uuid,text,jsonb,jsonb)'),
        ('public.hermes_v2_capture_requirement_plan_v1(text,text,text,text,text,text,text,text,text,text,jsonb,text,jsonb,jsonb)')
    ) as required(signature)
  loop
    v_function := pg_catalog.to_regprocedure(v_signature);
    if v_function is null then
      raise exception 'HERMES_V2_RPC_ACL_PRECHECK_FAILED: required function missing: %', v_signature;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc p
      where p.oid = v_function
        and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
        and p.prosecdef
    ) then
      raise exception 'HERMES_V2_RPC_ACL_PRECHECK_FAILED: function security contract mismatch: %', v_signature;
    end if;
  end loop;
end
$$;

revoke all on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) from public;
revoke all on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) from anon;
revoke all on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) from authenticated;
revoke all on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) from authenticator;
revoke all on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) from service_role;
grant execute on function public.hermes_v2_create_requirement_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb
) to service_role;

revoke all on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb)
  from public;
revoke all on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb)
  from anon;
revoke all on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb)
  from authenticated;
revoke all on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb)
  from authenticator;
revoke all on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb)
  from service_role;
grant execute on function public.hermes_v2_store_plan_v1(uuid, uuid, text, jsonb, jsonb)
  to service_role;

revoke all on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) from public;
revoke all on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) from anon;
revoke all on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) from authenticated;
revoke all on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) from authenticator;
revoke all on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) from service_role;
grant execute on function public.hermes_v2_capture_requirement_plan_v1(
  text, text, text, text, text, text, text, text, text, text, jsonb, text, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';

do $$
declare
  v_signature text;
  v_function oid;
  v_service_role oid;
begin
  select r.oid
  into v_service_role
  from pg_catalog.pg_roles r
  where r.rolname = 'service_role';

  for v_signature in
    select signature
    from (
      values
        ('public.hermes_v2_create_requirement_v1(text,text,text,text,text,text,text,text,text,text,jsonb)'),
        ('public.hermes_v2_store_plan_v1(uuid,uuid,text,jsonb,jsonb)'),
        ('public.hermes_v2_capture_requirement_plan_v1(text,text,text,text,text,text,text,text,text,text,jsonb,text,jsonb,jsonb)')
    ) as required(signature)
  loop
    v_function := pg_catalog.to_regprocedure(v_signature);

    if v_function is null
      or not pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
      or pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE')
    then
      raise exception 'HERMES_V2_RPC_ACL_POSTCHECK_FAILED: function ACL mismatch: %', v_signature;
    end if;

    if exists (
      select 1
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
      where p.oid = v_function
        and acl.privilege_type = 'EXECUTE'
        and acl.grantee not in (p.proowner, v_service_role)
    ) then
      raise exception 'HERMES_V2_RPC_ACL_POSTCHECK_FAILED: unexpected execute grantee: %', v_signature;
    end if;
  end loop;
end
$$;

commit;
