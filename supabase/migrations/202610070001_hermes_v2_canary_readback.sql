begin;

do $$
declare
  v_problem text;
begin
  if current_user <> 'postgres' then
    raise exception 'HERMES_V2_CANARY_READBACK_PRECHECK_FAILED: current_user must be postgres';
  end if;

  if pg_catalog.to_regprocedure(
    'public.hermes_v2_read_preview_shadow_canary_v1(text)'
  ) is not null then
    raise exception 'HERMES_V2_CANARY_READBACK_PRECHECK_FAILED: target function already exists';
  end if;

  select required.object_name
  into v_problem
  from (
    values
      ('public.hermes_v2_tasks'),
      ('public.hermes_v2_human_decisions'),
      ('public.hermes_v2_task_events')
  ) as required(object_name)
  where pg_catalog.to_regclass(required.object_name) is null
  order by required.object_name
  limit 1;

  if v_problem is not null then
    raise exception 'HERMES_V2_CANARY_READBACK_PRECHECK_FAILED: required table missing: %', v_problem;
  end if;

  select pg_catalog.format('public.%I', c.relname)
  into v_problem
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'hermes_v2_tasks',
      'hermes_v2_human_decisions',
      'hermes_v2_task_events'
    )
    and c.relkind <> 'r'
  order by c.relname
  limit 1;

  if v_problem is not null then
    raise exception 'HERMES_V2_CANARY_READBACK_PRECHECK_FAILED: required object must be an ordinary table: %', v_problem;
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
    raise exception 'HERMES_V2_CANARY_READBACK_PRECHECK_FAILED: required role missing: %', v_problem;
  end if;
end
$$;

create function public.hermes_v2_read_preview_shadow_canary_v1(
  p_source_external_id text
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  with input_scope as (
    select
      p_source_external_id as source_external_id,
      p_source_external_id ~ '^preview-shadow-planning-canary-v1:[0-9a-f]{40}$'
        as scope_input_valid
  ),
  selected_root as (
    select
      t.id,
      t.parent_task_id,
      t.task_type,
      t.role,
      t.status,
      t.stage,
      t.metadata
    from public.hermes_v2_tasks t
    cross join input_scope i
    where i.scope_input_valid
      and t.source = 'feishu_event'
      and t.source_external_id = i.source_external_id
      and t.task_type = 'requirement'
    order by t.created_at, t.id
    limit 1
  )
  select pg_catalog.jsonb_build_object(
    'scope_input_valid', i.scope_input_valid,
    'root', (
      select pg_catalog.jsonb_build_object(
        'id', r.id,
        'parent_task_id', r.parent_task_id,
        'task_type', r.task_type,
        'role', r.role,
        'status', r.status,
        'stage', r.stage,
        'metadata', r.metadata
      )
      from selected_root r
    ),
    'tasks', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', t.id,
          'parent_task_id', t.parent_task_id,
          'task_type', t.task_type,
          'role', t.role,
          'title', t.title,
          'status', t.status,
          'stage', t.stage,
          'risk_level', t.risk_level,
          'need_human_decision', t.need_human_decision,
          'dependency_task_ids', t.dependency_task_ids,
          'metadata', t.metadata
        ) order by t.created_at, t.id
      )
      from public.hermes_v2_tasks t
      where t.parent_task_id = (select r.id from selected_root r)
    ), '[]'::jsonb),
    'decisions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'decision_type', d.decision_type,
          'decision_status', d.decision_status,
          'external_channel', d.external_channel,
          'metadata', d.metadata
        ) order by d.created_at, d.id
      )
      from public.hermes_v2_human_decisions d
      where d.task_id = (select r.id from selected_root r)
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'event_type', e.event_type,
          'from_status', e.from_status,
          'to_status', e.to_status,
          'payload', e.payload
        ) order by e.created_at, e.id
      )
      from public.hermes_v2_task_events e
      where e.task_id = (select r.id from selected_root r)
    ), '[]'::jsonb)
  )
  from input_scope i;
$function$;

alter function public.hermes_v2_read_preview_shadow_canary_v1(text)
  owner to postgres;

revoke all on function public.hermes_v2_read_preview_shadow_canary_v1(text)
  from public;
revoke all on function public.hermes_v2_read_preview_shadow_canary_v1(text)
  from anon;
revoke all on function public.hermes_v2_read_preview_shadow_canary_v1(text)
  from authenticated;
revoke all on function public.hermes_v2_read_preview_shadow_canary_v1(text)
  from authenticator;
revoke all on function public.hermes_v2_read_preview_shadow_canary_v1(text)
  from service_role;

grant execute on function public.hermes_v2_read_preview_shadow_canary_v1(text)
  to service_role;

do $$
declare
  v_function oid := pg_catalog.to_regprocedure(
    'public.hermes_v2_read_preview_shadow_canary_v1(text)'
  );
begin
  if v_function is null then
    raise exception 'HERMES_V2_CANARY_READBACK_POSTCHECK_FAILED: function missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = v_function
      and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef
      and p.provolatile = 's'
      and p.prolang = (
        select l.oid
        from pg_catalog.pg_language l
        where l.lanname = 'sql'
      )
      and p.proconfig = array['search_path=pg_catalog']
  ) then
    raise exception 'HERMES_V2_CANARY_READBACK_POSTCHECK_FAILED: function security contract mismatch';
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
    or not pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
  then
    raise exception 'HERMES_V2_CANARY_READBACK_POSTCHECK_FAILED: function ACL mismatch';
  end if;
end
$$;

-- Controlled rollback (execute separately only after an approved rollback audit):
-- drop function if exists public.hermes_v2_read_preview_shadow_canary_v1(text);

commit;
