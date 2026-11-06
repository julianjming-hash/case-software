-- db/tests/case-catalogue.test.sql
-- Assertions for migrations/20261007000000_case_catalogue.sql (card 29, CASE-166): the catalogue page is
-- bounded, sorted and filtered over the whole set (paging never misorders), returns only public library
-- fields, and is authorised by workspace membership; case detail never answers outside the caller's
-- workspaces; nobody but service_role executes anything.
-- Since the card 35b contract migration only the card 30 13-argument catalogue exists: calls pass no group
-- filter (null, false) and the non-admin flag (false, null).
\set QUIET on
-- One transaction, rolled back at the end: later files (case-init) assume they own the only version 1 rows.
begin;

-- fixtures: a member and an outsider; workspace W (the member's) and workspace X (someone else's)
insert into auth.users values ('0199a000-0000-7000-8000-00000000c901'), ('0199a000-0000-7000-8000-00000000c902'),
  ('0199a000-0000-7000-8000-00000000c903');
insert into case_app.profiles (id, display_name) values
  ('0199a000-0000-7000-8000-00000000c901', 'Catalogue member'),
  ('0199a000-0000-7000-8000-00000000c902', 'Catalogue outsider'),
  ('0199a000-0000-7000-8000-00000000c903', 'Catalogue disabled');
insert into case_app.workspaces (id, slug, name) values
  ('0199a000-0000-7000-8000-00000000c90a', 'c29-teaching', 'Card 29 teaching'),
  ('0199a000-0000-7000-8000-00000000c90b', 'c29-elsewhere', 'Card 29 elsewhere');
insert into case_app.workspace_members (workspace_id, user_id, role) values
  ('0199a000-0000-7000-8000-00000000c90a', '0199a000-0000-7000-8000-00000000c901', 'facilitator'),
  ('0199a000-0000-7000-8000-00000000c90b', '0199a000-0000-7000-8000-00000000c902', 'owner'),
  ('0199a000-0000-7000-8000-00000000c90a', '0199a000-0000-7000-8000-00000000c903', 'author');
update case_app.profiles set disabled_at = now() where id = '0199a000-0000-7000-8000-00000000c903';

-- Twelve cases in W (one version each, two with a second version), one archived, one withdrawn, one in X.
-- Every document carries a private beat text the catalogue must never return.
create temp table c29_cases (n integer, id uuid, title text, doc jsonb, ws uuid);
insert into c29_cases
select n, ('0199a000-0000-7000-8000-0000000c91' || lpad(to_hex(n), 2, '0'))::uuid,
       (array['Sepsis on the ward','anaphylaxis in theatre','Bradycardia','Cardiac arrest','DKA','Eclampsia',
              'Fever 100% sure','GI bleed','Head injury','Ischaemic stroke','Jaundice','Kounis','Archived case',
              'Withdrawn case','Elsewhere case'])[n],
       jsonb_build_object('schema_version', 1, 'title', 'ignored', 'start_beat_id', 'b1',
         'beats', jsonb_build_array(jsonb_build_object('id', 'b1', 'kind', 'surface', 'text', 'PRIVATE-BEAT-TEXT')),
         'decisions', jsonb_build_array(jsonb_build_object('id', 'D1', 'facilitator_notes', 'PRIVATE-NOTE')))
       || case when n % 4 = 0 then '{}'::jsonb else jsonb_build_object('summary', 'Summary for case ' || n ||
            case when n = 2 then ' with sepsis mimic' else '' end) end
       || case when n % 3 = 0 then jsonb_build_object('audience', 42) else jsonb_build_object('audience',
            (array['Junior doctors', 'Nurses', 'Paramedics'])[1 + n % 3]) end
       || case when n % 5 = 0 then jsonb_build_object('duration_min', 30) else jsonb_build_object('duration_min',
            (array[15, 45])[1 + n % 2]) end
       || jsonb_build_object('setting', 'Emergency department',
            'learning_objectives', jsonb_build_array('Recognise it', 7, '', 'Treat it', 'a', 'b', 'c', 'd', 'e', 'f')),
       case when n = 15 then '0199a000-0000-7000-8000-00000000c90b'::uuid else '0199a000-0000-7000-8000-00000000c90a'::uuid end
  from generate_series(1, 15) n;
-- Published fixtures normally match their case title; the separate metadata test covers renames.
update c29_cases set doc=jsonb_set(doc,'{title}',to_jsonb(title));
insert into case_app.cases (id, workspace_id, owner_id, title, archived_at)
select id, ws, case when n = 15 then '0199a000-0000-7000-8000-00000000c902'::uuid else '0199a000-0000-7000-8000-00000000c901'::uuid end,
       title, case when n = 13 then now() end from c29_cases;
-- Published times: case n at base + n minutes, so 'published' order is known; two cases share a time.
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by, published_at)
select ('0199a000-0000-7000-8000-0000000c92' || lpad(to_hex(n), 2, '0'))::uuid, id, 1, 1, doc, sha256(convert_to(doc::text, 'UTF8')),
       case when n = 15 then '0199a000-0000-7000-8000-00000000c902'::uuid else '0199a000-0000-7000-8000-00000000c901'::uuid end,
       timestamptz '2026-10-01 00:00:00+00' + make_interval(mins => case when n = 7 then 6 else n end)
  from c29_cases;
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by, published_at)
select ('0199a000-0000-7000-8000-0000000c93' || lpad(to_hex(n), 2, '0'))::uuid, id, 2, 1, doc || '{"summary":"Second version"}',
       sha256(convert_to(doc::text || 'v2', 'UTF8')), '0199a000-0000-7000-8000-00000000c901',
       timestamptz '2026-10-02 00:00:00+00' + make_interval(mins => n)
  from c29_cases where n in (3, 8);
insert into case_app.admin_version_state (case_version_id, status) values ('0199a000-0000-7000-8000-0000000c920e', 'withdrawn');
-- Case 3's latest version (v2) is withdrawn: the case stays listed through its v1.
insert into case_app.admin_version_state (case_version_id, status) values ('0199a000-0000-7000-8000-0000000c9303', 'withdrawn');

-- The independent expectation (Julian, 2026-10-06): one row per case in W, its latest published version.
-- Cases 3 and 8 have a second version (12 rows, not 14). Case 3's v2 is withdrawn, so case 3 lists v1; case 8
-- lists v2 and its v1 is never a card.
create temp table c29_expected as
select distinct on (c.n) v.id, c.title, v.published_at,
       case when jsonb_typeof(v.document -> 'duration_min') = 'number' and (v.document ->> 'duration_min') in ('15', '45')
            then (v.document ->> 'duration_min')::integer end as duration_min,
       case when jsonb_typeof(v.document -> 'audience') = 'string' then v.document ->> 'audience' end as audience
  from case_app.case_versions v join c29_cases c on c.id = v.case_id
 where c.n <= 12 and not exists (select 1 from case_app.admin_version_state av
       where av.case_version_id = v.id and av.status = 'withdrawn')
 order by c.n, v.version_no desc;

-- [AS-101] The page is bounded: never more than 50 rows, never fewer than one when rows exist.
do $$
declare v_member uuid := '0199a000-0000-7000-8000-00000000c901'; v_ws uuid := '0199a000-0000-7000-8000-00000000c90a';
  v_count integer; v_total bigint;
begin
  select count(*), max(total_count) into v_count, v_total
    from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 1000, 0, null, false, false, null);
  if v_count <> 12 or v_total <> 12 then raise exception 'one row per case: % rows, total %', v_count, v_total; end if;
  select count(*) into v_count from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 0, 0, null, false, false, null);
  if v_count <> 1 then raise exception 'limit 0 must clamp to one row, got %', v_count; end if;
  select count(*) into v_count from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 3, 0, null, false, false, null);
  if v_count <> 3 then raise exception 'limit 3 returned %', v_count; end if;
  -- The upper clamp is 50: seed 60 scratch cases (one version each) and read with a huge limit.
  insert into case_app.cases (id, workspace_id, owner_id, title)
  select ('0199a000-0000-7000-8000-0000000ca' || lpad(to_hex(g), 3, '0'))::uuid, v_ws, v_member, 'Bulk case ' || g
    from generate_series(1, 60) g;
  insert into case_app.case_versions (case_id, version_no, schema_version, document, content_sha256, published_by)
  select ('0199a000-0000-7000-8000-0000000ca' || lpad(to_hex(g), 3, '0'))::uuid, 1, 1, '{}', sha256(convert_to('bulk' || g, 'UTF8')), v_member
    from generate_series(1, 60) g;
  select count(*), max(total_count) into v_count, v_total
    from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 1000, 0, null, false, false, null);
  if v_count <> 50 or v_total <> 72 then raise exception 'upper clamp: % rows, total %', v_count, v_total; end if;
  update case_app.cases set archived_at = now() where title like 'Bulk case %';
  raise notice 'ok catalogue page bounded';
end $$;

-- [AS-101] Sort runs over the whole set: the pages of every sort key and direction, read two rows at a
-- time, concatenate to exactly the one-page order, which matches an independent ordering of the full
-- set; total_count is the whole set on every page. Missing values sort last in both directions.
do $$
declare v_member uuid := '0199a000-0000-7000-8000-00000000c901'; v_ws uuid := '0199a000-0000-7000-8000-00000000c90a';
  v_sort text; v_desc boolean; v_paged uuid[]; v_whole uuid[]; v_expected uuid[]; v_page uuid[]; v_offset integer;
  v_bad bigint;
begin
  foreach v_sort in array array['title', 'published', 'length', 'audience'] loop
    foreach v_desc in array array[false, true] loop
      v_paged := '{}'; v_offset := 0;
      loop
        select array_agg(version_id order by ord), count(*) filter (where total_count <> 12)
          into v_page, v_bad
          from (select version_id, total_count, row_number() over () as ord
                  from case_api.list_case_catalogue(v_member, v_ws, v_sort, v_desc, null, null, null, 2, v_offset, null, false, false, null)) p;
        exit when v_page is null;
        v_bad := coalesce(v_bad, 0);
        if v_bad > 0 then raise exception '% % page at % has a partial total', v_sort, v_desc, v_offset; end if;
        v_paged := v_paged || v_page; v_offset := v_offset + 2;
      end loop;
      select array_agg(version_id order by ord) into v_whole
        from (select version_id, row_number() over () as ord
                from case_api.list_case_catalogue(v_member, v_ws, v_sort, v_desc, null, null, null, 50, 0, null, false, false, null)) w;
      select array_agg(id order by
          case when v_sort = 'title' and not v_desc then lower(title) end asc nulls last,
          case when v_sort = 'title' and v_desc then lower(title) end desc nulls last,
          case when v_sort = 'length' and not v_desc then duration_min end asc nulls last,
          case when v_sort = 'length' and v_desc then duration_min end desc nulls last,
          case when v_sort = 'audience' and not v_desc then lower(audience) end asc nulls last,
          case when v_sort = 'audience' and v_desc then lower(audience) end desc nulls last,
          case when v_sort = 'published' and not v_desc then published_at end asc,
          case when v_sort = 'published' and v_desc then published_at end desc,
          published_at desc, id desc) into v_expected from c29_expected;
      if v_paged <> v_whole then raise exception '% desc=% paging misorders: % vs %', v_sort, v_desc, v_paged, v_whole; end if;
      if v_whole <> v_expected then raise exception '% desc=% order % expected %', v_sort, v_desc, v_whole, v_expected; end if;
    end loop;
  end loop;
  -- A missing duration (30 is not an allowed value) is last whichever way length is sorted.
  if (select duration_min from case_api.list_case_catalogue(v_member, v_ws, 'length', true, null, null, null, 50, 0, null, false, false, null)
       offset 11 limit 1) is not null then raise exception 'missing length not last when descending'; end if;
  -- Older published versions are never catalogue rows; they are reached through case detail.
  if exists (select 1 from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 50, 0, null, false, false, null)
              where version_id in ('0199a000-0000-7000-8000-0000000c9208', '0199a000-0000-7000-8000-0000000c9303'))
    then raise exception 'an older or withdrawn version was listed as a card'; end if;
  -- A withdrawn latest version falls back to the newest published one.
  if not exists (select 1 from case_api.list_case_catalogue(v_member, v_ws, 'title', false, 'Bradycardia', null, null, 50, 0, null, false, false, null)
                  where version_id = '0199a000-0000-7000-8000-0000000c9203' and version_no = 1)
    then raise exception 'case 3 must list its v1 when v2 is withdrawn'; end if;
  raise notice 'ok catalogue sort spans pages, one row per case';
end $$;

-- [AS-101] Filters run over the whole set before paging, and the query is a literal substring.
do $$
declare v_member uuid := '0199a000-0000-7000-8000-00000000c901'; v_ws uuid := '0199a000-0000-7000-8000-00000000c90a';
  v_titles text[]; v_total bigint; v_count integer;
begin
  -- 'sepsis' matches one title and one summary (case-insensitive), across the whole set.
  select array_agg(title order by title), max(total_count) into v_titles, v_total
    from case_api.list_case_catalogue(v_member, v_ws, 'title', false, 'SEPSIS', null, null, 1, 0, null, false, false, null);
  if v_total <> 2 or cardinality(v_titles) <> 1 then raise exception 'sepsis filter: % total %', v_titles, v_total; end if;
  -- '%' and '_' are literal: only the title containing "100%" matches.
  select max(total_count) into v_total from case_api.list_case_catalogue(v_member, v_ws, 'title', false, '100%', null, null, 50, 0, null, false, false, null);
  if v_total <> 1 then raise exception 'percent was interpreted as a wildcard: %', v_total; end if;
  select count(*) into v_count from case_api.list_case_catalogue(v_member, v_ws, 'title', false, '_', null, null, 50, 0, null, false, false, null);
  if v_count <> 0 then raise exception 'underscore was interpreted as a wildcard: %', v_count; end if;
  select max(total_count) into v_total from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, 15, null, 50, 0, null, false, false, null);
  if v_total <> (select count(*) from c29_expected where duration_min = 15) then raise exception 'length 15 total %', v_total; end if;
  select count(*) into v_count from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, 45, 'Nurses', 50, 0, null, false, false, null)
   where duration_min <> 45 or audience <> 'Nurses';
  if v_count <> 0 then raise exception 'length and audience filters leaked % rows', v_count; end if;
  select max(total_count) into v_total from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, 'Nurses', 1, 0, null, false, false, null);
  if v_total <> (select count(*) from c29_expected where audience = 'Nurses') then raise exception 'audience total %', v_total; end if;
  -- Facets: string audiences only, counted over the whole workspace.
  if (select array_agg(audience || ':' || case_count order by audience) from case_api.list_case_catalogue_audiences(v_member, v_ws)) <>
     (select array_agg(audience || ':' || n order by audience) from (select audience, count(*) n from c29_expected where audience is not null group by audience) f)
    then raise exception 'audience facets wrong'; end if;
  raise notice 'ok catalogue filters span the set';
end $$;

-- [AS-101] Only public library fields leave: the exact column set, no private beat or note text, and
-- a wrong-typed field reads as null (shown as "not set").
do $$
declare v_member uuid := '0199a000-0000-7000-8000-00000000c901'; v_ws uuid := '0199a000-0000-7000-8000-00000000c90a';
  v_text text; v_keys text[]; v_row record;
begin
  select string_agg(row_to_json(r)::text, ',') into v_text
    from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 50, 0, null, false, false, null) r;
  if v_text ~ 'PRIVATE-' or v_text ~ '"beats"' or v_text ~ '"decisions":\[\{"id"' then raise exception 'catalogue leaked pack fields'; end if;
  select array_agg(k order by k) into v_keys
    from (select row_to_json(r) j from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 1, 0, null, false, false, null) r) x,
         json_object_keys(x.j) k;
  -- group_id, group_name and tint are card 30's columns (db/tests/case-groups.test.sql G-9).
  if v_keys <> array['art','audience','case_id','content_sha256','duration_min','group_id','group_name','published_at','setting','summary','tint','title','total_count','version_id','version_no']
    then raise exception 'catalogue columns %', v_keys; end if;
  select * into v_row from case_api.list_case_catalogue(v_member, v_ws, 'title', false, 'Bradycardia', null, null, 1, 0, null, false, false, null);
  if v_row.audience is not null then raise exception 'numeric audience must read as not set'; end if;
  select * into v_row from case_api.list_case_catalogue(v_member, v_ws, 'title', false, 'DKA', null, null, 1, 0, null, false, false, null);
  if v_row.duration_min is not null then raise exception 'unknown duration must read as not set'; end if;
  select * into v_row from case_api.list_case_catalogue(v_member, v_ws, 'title', false, 'Cardiac arrest', null, null, 1, 0, null, false, false, null);
  if v_row.summary is not null then raise exception 'absent summary must read as not set'; end if;
  -- Detail adds only the learning objectives: strings only, blanks dropped, at most the first eight entries.
  select string_agg(row_to_json(r)::text, ',') into v_text
    from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c9101', 1) r;
  if v_text is null or v_text ~ 'PRIVATE-' then raise exception 'detail leaked or missing: %', v_text; end if;
  select * into v_row from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c9101', 1);
  if v_row.learning_objectives <> '["Recognise it","Treat it","a","b","c","d"]'::jsonb or v_row.role <> 'facilitator' or
     v_row.workspace_id <> v_ws then raise exception 'detail fields %', row_to_json(v_row); end if;
  -- Detail lists every published, non-withdrawn version of the case, newest first, and each stays readable
  -- (startable) by its number; the list carries version metadata only.
  select * into v_row from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c9103', 1);
  if v_row.version_no <> 1 or v_row.versions <> jsonb_build_array(jsonb_build_object('version_id', '0199a000-0000-7000-8000-0000000c9203',
       'version_no', 1, 'published_at', v_row.published_at, 'content_sha256', v_row.content_sha256))
    then raise exception 'withdrawn v2 must not appear in detail versions: %', v_row.versions; end if;
  select count(*) into v_text from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c9103', 2);
  if v_text::integer <> 0 then raise exception 'detail answered a withdrawn version'; end if;
  select * into v_row from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c9108', 1);
  if v_row.version_no <> 1 or jsonb_array_length(v_row.versions) <> 2 or
     (select array_agg((x ->> 'version_no')::integer order by n) from jsonb_array_elements(v_row.versions) with ordinality as e(x, n)) <> array[2, 1] or
     (select array_agg(k order by k) from jsonb_object_keys(v_row.versions -> 0) k) <> array['content_sha256','published_at','version_id','version_no']
    then raise exception 'detail versions %', v_row.versions; end if;
  if v_row.versions::text ~ 'PRIVATE-' then raise exception 'versions leaked pack fields'; end if;
  raise notice 'ok catalogue returns public fields only';
end $$;

-- [AS-101] Authorization: another workspace's cases never come back; archived, withdrawn and disabled
-- accounts are refused; malformed queries are refused before any read.
do $$
declare v_member uuid := '0199a000-0000-7000-8000-00000000c901'; v_ws uuid := '0199a000-0000-7000-8000-00000000c90a';
  v_other uuid := '0199a000-0000-7000-8000-00000000c90b'; v_refused integer := 0; v_count integer;
begin
  begin perform * from case_api.list_case_catalogue(v_member, v_other, 'title', false, null, null, null, 50, 0, null, false, false, null);
  exception when sqlstate '42501' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue_audiences(v_member, v_other);
  exception when sqlstate '42501' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue('0199a000-0000-7000-8000-00000000c903', v_ws, 'title', false, null, null, null, 50, 0, null, false, false, null);
  exception when sqlstate '42501' then v_refused := v_refused + 1; end;
  begin perform * from case_api.get_catalogue_case('0199a000-0000-7000-8000-00000000c903', '0199a000-0000-7000-8000-0000000c9101', 1);
  exception when sqlstate '42501' then v_refused := v_refused + 1; end;
  if v_refused <> 4 then raise exception 'only % of 4 foreign or disabled reads refused', v_refused; end if;
  select count(*) into v_count from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c910f', 1);
  if v_count <> 0 then raise exception 'detail answered for another workspace'; end if;
  select count(*) into v_count from case_api.get_catalogue_case('0199a000-0000-7000-8000-00000000c902', '0199a000-0000-7000-8000-0000000c9101', 1);
  if v_count <> 0 then raise exception 'detail answered an outsider'; end if;
  select count(*) into v_count from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c910d', 1);
  if v_count <> 0 then raise exception 'detail answered an archived case'; end if;
  select count(*) into v_count from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c910e', 1);
  if v_count <> 0 then raise exception 'detail answered a withdrawn version'; end if;
  select count(*) into v_count from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 50, 0, null, false, false, null)
   where title in ('Archived case', 'Withdrawn case', 'Elsewhere case');
  if v_count <> 0 then raise exception 'catalogue listed archived, withdrawn or foreign cases'; end if;
  v_refused := 0;
  begin perform * from case_api.list_case_catalogue(v_member, v_ws, 'beats', false, null, null, null, 50, 0, null, false, false, null);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue(v_member, v_ws, 'title', null, null, null, null, 50, 0, null, false, false, null);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue(v_member, v_ws, 'title', false, repeat('x', 81), null, null, 50, 0, null, false, false, null);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, 30, null, 50, 0, null, false, false, null);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 50, -1, null, false, false, null);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  begin perform * from case_api.list_case_catalogue(v_member, v_ws, 'title', false, null, null, null, 50, 10001, null, false, false, null);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  begin perform * from case_api.get_catalogue_case(v_member, '0199a000-0000-7000-8000-0000000c9101', 0);
  exception when sqlstate '22023' then v_refused := v_refused + 1; end;
  if v_refused <> 7 then raise exception 'only % of 7 malformed queries refused', v_refused; end if;
  raise notice 'ok catalogue authorised by workspace membership';
end $$;

-- Only service_role executes the catalogue RPCs; the helpers execute for nobody but their definer.
do $$
declare sig text;
begin
  foreach sig in array array['case_api.list_case_catalogue(uuid,uuid,text,boolean,text,integer,text,integer,integer,uuid,boolean,boolean,text)',
    'case_api.list_case_catalogue_audiences(uuid,uuid,boolean,text)', 'case_api.get_catalogue_case(uuid,uuid,integer,boolean,text)'] loop
    if not has_function_privilege('service_role', sig, 'execute') then raise exception 'service_role cannot execute %', sig; end if;
    if has_function_privilege('anon', sig, 'execute') then raise exception 'anon can execute %', sig; end if;
    if has_function_privilege('authenticated', sig, 'execute') then raise exception 'authenticated can execute %', sig; end if;
  end loop;
  foreach sig in array array['case_app.catalogue_text(jsonb,text,integer)', 'case_app.catalogue_duration(jsonb)', 'case_app.catalogue_versions(uuid)'] loop
    if has_function_privilege('anon', sig, 'execute') or has_function_privilege('authenticated', sig, 'execute') then
      raise exception 'public role can execute %', sig; end if;
  end loop;
  raise notice 'ok catalogue privileges';
end $$;

rollback;
