-- Card 05: own-profile paging and workspace-scoped, intact version reads.
\set QUIET on

-- [AS-078] Me never returns a different profile or an unbounded membership list.
do $$
declare
  v_owner uuid := '0199a000-0000-7000-8000-000000000001';
  v_outsider uuid := '0199a000-0000-7000-8000-000000000002';
  v_after uuid;
  v_row record;
  v_member jsonb;
  v_seen uuid[] := '{}';
  v_count integer := 0;
  v_pages integer := 0;
  v_invalid_cursor boolean := false;
begin
  insert into case_app.workspaces (slug, name)
  select 'c05-' || lpad(g::text, 3, '0'), 'Card 05 ' || g from generate_series(1, 105) g;
  insert into case_app.workspace_members (workspace_id, user_id, role)
  select id, v_owner, 'facilitator' from case_app.workspaces where slug like 'c05-%';

  loop
    v_pages := v_pages + 1;
    if v_pages > 10 then raise exception 'get_me paging did not terminate'; end if;
    select * into v_row from case_api.get_me(v_owner, 40, v_after, null);
    if v_row.user_id <> v_owner or v_row.display_name is distinct from (select display_name from case_app.profiles where id = v_owner) then
      raise exception 'get_me returned another profile'; end if;
    if jsonb_array_length(v_row.memberships) > 40 then raise exception 'get_me exceeded page limit'; end if;
    for v_member in select * from jsonb_array_elements(v_row.memberships) loop
      if (v_member ->> 'workspace_id')::uuid = any(v_seen) then
        raise exception 'duplicate get_me membership'; end if;
      v_seen := array_append(v_seen, (v_member ->> 'workspace_id')::uuid);
      v_count := v_count + 1;
    end loop;
    exit when v_row.next_after is null;
    v_after := v_row.next_after;
  end loop;
  if v_count <> 107 then raise exception 'get_me lost memberships: %', v_count; end if;
  select * into v_row from case_api.get_me(v_owner, 1000, null,
    '0199a000-0000-7000-8000-00000000000a');
  if jsonb_array_length(v_row.memberships) <> 1 or v_row.next_after is not null then
    raise exception 'workspace-targeted get_me was not bounded'; end if;
  select * into v_row from case_api.get_me(v_outsider, 10, null,
    '0199a000-0000-7000-8000-00000000000a');
  if v_row.user_id <> v_outsider or jsonb_array_length(v_row.memberships) <> 0 then
    raise exception 'non-member received a membership'; end if;
  begin
    perform * from case_api.get_me(v_owner, 10, v_outsider,
      '0199a000-0000-7000-8000-00000000000a');
  exception when invalid_parameter_value then v_invalid_cursor := true; end;
  if not v_invalid_cursor then raise exception 'get_me accepted a foreign page cursor'; end if;
  raise notice 'ok get_me profile and membership keyset paging: % rows', v_count;
end $$;

-- [AS-078] A version in another workspace returns no row even to a user who belongs to both.
do $$
declare
  v_owner uuid := '0199a000-0000-7000-8000-000000000001';
  v_outsider uuid := '0199a000-0000-7000-8000-000000000002';
  v_workspace uuid := '0199a000-0000-7000-8000-00000000000a';
  v_other_workspace uuid;
  v_version uuid;
  v_row record;
  v_denied boolean := false;
begin
  select workspace_id into v_other_workspace from case_app.workspace_members m
    join case_app.workspaces w on w.id = m.workspace_id
    where m.user_id = v_owner and w.slug = 'c05-001';
  select id into v_version from case_app.case_versions where case_id =
    '0199a000-0000-7000-8000-0000000000c1' order by version_no limit 1;
  select * into v_row from case_api.get_case_version_for_workspace(v_version, v_workspace, v_owner);
  if v_row.case_id is null or v_row.document_text is null or
     sha256(convert_to(v_row.document_text, 'UTF8')) <> v_row.content_sha256 then
    raise exception 'workspace version did not return exact hashed text'; end if;
  if exists (select 1 from case_api.get_case_version_for_workspace(v_version, v_other_workspace, v_owner)) then
    raise exception 'cross-workspace version was returned'; end if;
  begin
    perform * from case_api.get_case_version_for_workspace(v_version, v_workspace, v_outsider);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'non-member read a version'; end if;
  raise notice 'ok workspace version integrity and tenancy';
end $$;

-- [AS-078] Authoring preflight exposes case/workspace ids only to owners or authors.
-- Supabase Auth subjects need not be UUIDv7; Case-created resource ids remain UUIDv7.
do $$
declare
  v_case uuid := '0199a000-0000-7000-8000-0000000000c1';
  v_workspace uuid := '0199a000-0000-7000-8000-00000000000a';
  v_owner uuid := '0199a000-0000-7000-8000-000000000001';
  v_outsider uuid := '0199a000-0000-7000-8000-000000000002';
  v_author uuid := '550e8400-e29b-41d4-a716-446655440000';
  v_facilitator uuid := '550e8400-e29b-41d4-a716-446655440001';
begin
  insert into auth.users values (v_author), (v_facilitator);
  perform case_api.ensure_profile(v_author, 'Author');
  perform case_api.ensure_profile(v_facilitator, 'Facilitator');
  insert into case_app.workspace_members (workspace_id, user_id, role)
    values (v_workspace, v_author, 'author'), (v_workspace, v_facilitator, 'facilitator');
  if not exists (select 1 from case_api.get_case_authoring_access(v_case, v_owner)
                 where case_id = v_case and workspace_id = v_workspace) then
    raise exception 'owner lost case authoring access'; end if;
  if not exists (select 1 from case_api.get_case_authoring_access(v_case, v_author)
                 where case_id = v_case and workspace_id = v_workspace) then
    raise exception 'UUIDv4 author lost case authoring access'; end if;
  if exists (select 1 from case_api.get_case_authoring_access(v_case, v_facilitator)) or
     exists (select 1 from case_api.get_case_authoring_access(v_case, v_outsider)) or
     exists (select 1 from case_api.get_case_authoring_access(
       '0199a000-0000-7000-8000-0000000000ff', v_owner)) then
    raise exception 'denied or missing case leaked authoring metadata'; end if;
  raise notice 'ok owner/author preflight and denied case metadata';
end $$;

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'case_api.get_me(uuid,integer,uuid,uuid,boolean,text)',
    'case_api.get_case_version_for_workspace(uuid,uuid,uuid,boolean,text)',
    'case_api.get_case_authoring_access(uuid,uuid,boolean,text)'
  ] loop
    if not has_function_privilege('service_role', v_signature, 'execute') then
      raise exception 'service_role cannot execute %', v_signature; end if;
    if has_function_privilege('anon', v_signature, 'execute') or
       has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception 'public role can execute %', v_signature; end if;
  end loop;
  raise notice 'ok Card 05 RPC privileges';
end $$;
