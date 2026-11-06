-- db/tests/case-groups-race.test.sql
-- Card 30 red-team: concurrent group writes cannot leave a case in an archived group, and cannot exceed the
-- 100-live-group cap. Two real sessions (dblink to this same database) race each write: session A opens a
-- transaction and writes; session B starts its write while A is still open; then A commits. The fixture is
-- committed (a race needs two transactions to see it) under its own workspace and deleted at the end; its
-- append-only audit rows stay, as audit always does. Every action runs on the admin path (no membership).
\set QUIET on
create extension if not exists dblink;

insert into auth.users values ('0199a000-0000-7000-8000-000000003a01');
insert into case_app.profiles (id, display_name) values ('0199a000-0000-7000-8000-000000003a01', 'Race admin');
insert into case_app.workspaces (id, slug, name) values ('0199a000-0000-7000-8000-000000003a0a', 'c30-race', 'Card 30 race');
select case_api.record_admin_elevation('0199a000-0000-7000-8000-000000003af1', 'race@example.org', 'admin', '0199a000-0000-7000-8000-000000003af0');

create function pg_temp.race_conn(p_name text) returns void language plpgsql as $f$
begin
  perform dblink_connect(p_name, format('host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database(), current_user));
end;
$f$;
-- Fresh fixture for one race: groups by name (tint sage) and cases (by title) in the given groups.
create function pg_temp.race_reset(p_groups text[], p_cases text[][]) returns void language plpgsql as $f$
declare item text[];
begin
  delete from case_app.cases where workspace_id = '0199a000-0000-7000-8000-000000003a0a';
  delete from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-000000003a0a';
  insert into case_app.case_groups (workspace_id, name, tint) select '0199a000-0000-7000-8000-000000003a0a', n, 'sage' from unnest(p_groups) n;
  if cardinality(p_cases) = 0 then return; end if;
  foreach item slice 1 in array p_cases loop
    insert into case_app.cases (workspace_id, owner_id, title, group_id)
    values ('0199a000-0000-7000-8000-000000003a0a', '0199a000-0000-7000-8000-000000003a01', item[1],
            (select id from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-000000003a0a' and name = nullif(item[2], '')));
  end loop;
end;
$f$;
create function pg_temp.gid(p_name text) returns uuid language sql as $f$
  select id from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-000000003a0a' and name = p_name;
$f$;
create function pg_temp.cid(p_title text) returns uuid language sql as $f$
  select id from case_app.cases where workspace_id = '0199a000-0000-7000-8000-000000003a0a' and title = p_title;
$f$;
-- B has started its write while A's transaction is open: B is either finished or waiting on a lock. Bounded.
create function pg_temp.race_wait(p_pid integer) returns void language plpgsql as $f$
declare n integer := 0;
begin
  loop
    exit when dblink_is_busy('b') = 0 or exists (select 1 from pg_stat_activity where pid = p_pid and wait_event_type = 'Lock');
    n := n + 1;
    if n > 500 then raise exception 'race: session B neither finished nor waited on a lock'; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$f$;
-- Run A's statement in an open transaction, start B's whole transaction, commit A, then let B finish. B may
-- fail (that is the refusal under test); the assertions read the committed outcome.
create function pg_temp.race(p_a text, p_b text) returns void language plpgsql as $f$
declare v_pid integer;
begin
  select pid into v_pid from dblink('b', 'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec('a', 'begin');
  perform * from dblink('a', p_a) as t(x text);
  perform dblink_send_query('b', format($q$do $d$ begin %s; end $d$$q$, p_b));
  perform pg_temp.race_wait(v_pid);
  perform dblink_exec('a', 'commit');
  perform * from dblink_get_result('b', false) as t(x text);
  perform * from dblink_get_result('b', false) as t(x text);
end;
$f$;

select pg_temp.race_conn('a'), pg_temp.race_conn('b');

-- [G-race-1] Archive E (to Ungrouped) while a case is assigned into E: the assignment waits for the archive and
-- is then refused; no case is left in an archived group.
select pg_temp.race_reset(array['E'], array[array['Moved', 'E'], array['Joiner', '']]);
do $$
begin
  perform pg_temp.race(
    format($s$select (select 'ok' from case_api.archive_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', %L, 0, 'E', null, true, 'race@example.org', '0199a000-0000-7000-8000-000000003af1') limit 1)$s$, pg_temp.gid('E')),
    format($s$perform case_api.assign_case_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', %L, 0, %L, true, 'race@example.org')$s$, pg_temp.cid('Joiner'), pg_temp.gid('E')));
  if exists (select 1 from case_app.cases c join case_app.case_groups g on g.id = c.group_id
              where c.workspace_id = '0199a000-0000-7000-8000-000000003a0a' and g.archived_at is not null) then
    raise exception 'G-race-1: a case joined a group archived concurrently'; end if;
  raise notice 'ok G-race-1 an assignment racing an archive is refused';
end $$;

-- [G-race-2] Archive D into C while C is archived into D: the second waits and is refused; no case is left in an
-- archived group, and every case survives.
-- D is empty, so A's archive takes no key lock on C through a moved case.
select pg_temp.race_reset(array['C', 'D'], array[array['In C', 'C'], array['Other', '']]);
do $$
begin
  perform pg_temp.race(
    format($s$select (select 'ok' from case_api.archive_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', %L, 0, 'D', %L, true, 'race@example.org', '0199a000-0000-7000-8000-000000003af1') limit 1)$s$, pg_temp.gid('D'), pg_temp.gid('C')),
    format($s$perform case_api.archive_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', %L, 0, 'C', %L, true, 'race@example.org', '0199a000-0000-7000-8000-000000003af1')$s$, pg_temp.gid('C'), pg_temp.gid('D')));
  if exists (select 1 from case_app.cases c join case_app.case_groups g on g.id = c.group_id
              where c.workspace_id = '0199a000-0000-7000-8000-000000003a0a' and g.archived_at is not null) or
     (select count(*) from case_app.cases where workspace_id = '0199a000-0000-7000-8000-000000003a0a') <> 2 then
    raise exception 'G-race-2: crossed archives left a case in an archived group'; end if;
  raise notice 'ok G-race-2 crossed archives cannot strand a case';
end $$;

-- [G-race-3] Two creates at 99 live groups: one succeeds and the other waits and is refused (group_limit);
-- the workspace never holds more than 100 live groups.
select pg_temp.race_reset((select array_agg('G' || lpad(n::text, 3, '0')) from generate_series(1, 99) n), array[]::text[][]);
do $$
begin
  perform pg_temp.race(
    $s$select (select 'ok' from case_api.create_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', 'Race one', null, 'sky', true, 'race@example.org') limit 1)$s$,
    $s$perform case_api.create_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', 'Race two', null, 'sky', true, 'race@example.org')$s$);
  if (select count(*) from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-000000003a0a' and archived_at is null) > 100 then
    raise exception 'G-race-3: concurrent creates passed the 100-group cap'; end if;
  raise notice 'ok G-race-3 the group cap holds under concurrent creates';
end $$;

-- [G-race-4] Crossed archives started together (A: D into C, B: C into D). A third session H holds D, so A
-- queues for D holding nothing while B takes its first lock; when H commits, both archives contend for C and D.
-- Locking both rows in id order means one archive succeeds and the other is refused cleanly: never a deadlock.
select pg_temp.race_conn('h');
select pg_temp.race_reset(array['C', 'D'], array[array['In C', 'C'], array['In D', 'D']]);
create function pg_temp.race_waiting(p_conn text, p_pid integer) returns void language plpgsql as $f$
declare n integer := 0;
begin
  loop
    exit when dblink_is_busy(p_conn) = 0 or exists (select 1 from pg_stat_activity where pid = p_pid and wait_event_type = 'Lock');
    n := n + 1;
    if n > 500 then raise exception 'race: session % neither finished nor waited on a lock', p_conn; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$f$;
do $race4$
declare v_a integer; v_b integer; v_errors text := ''; v_conn text;
begin
  select pid into v_a from dblink('a', 'select pg_backend_pid()') as t(pid integer);
  select pid into v_b from dblink('b', 'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec('h', 'begin');
  perform * from dblink('h', format('select id::text from case_app.case_groups where id = %L for update', pg_temp.gid('D'))) as t(x text);
  perform dblink_send_query('a', format($q$do $d$ begin perform case_api.archive_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', %L, 0, 'D', %L, true, 'race@example.org', '0199a000-0000-7000-8000-000000003af1'); end $d$$q$, pg_temp.gid('D'), pg_temp.gid('C')));
  perform pg_temp.race_waiting('a', v_a);
  perform dblink_send_query('b', format($q$do $d$ begin perform case_api.archive_group('0199a000-0000-7000-8000-000000003a01', '0199a000-0000-7000-8000-000000003a0a', %L, 0, 'C', %L, true, 'race@example.org', '0199a000-0000-7000-8000-000000003af1'); end $d$$q$, pg_temp.gid('C'), pg_temp.gid('D')));
  perform pg_temp.race_waiting('b', v_b);
  perform dblink_exec('h', 'commit');
  foreach v_conn in array array['a', 'b'] loop
    perform * from dblink_get_result(v_conn, false) as t(x text);
    v_errors := v_errors || ' ' || coalesce(dblink_error_message(v_conn), '');
    perform * from dblink_get_result(v_conn, false) as t(x text);
  end loop;
  if v_errors ~* 'deadlock' then raise exception 'G-race-4: crossed archives deadlocked (40P01):%', v_errors; end if;
  if (select count(*) from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-000000003a0a' and archived_at is not null) <> 1 or
     exists (select 1 from case_app.cases c join case_app.case_groups g on g.id = c.group_id
              where c.workspace_id = '0199a000-0000-7000-8000-000000003a0a' and g.archived_at is not null) or
     (select count(*) from case_app.cases where workspace_id = '0199a000-0000-7000-8000-000000003a0a') <> 2 then
    raise exception 'G-race-4: expected one archive and one clean refusal:%', v_errors; end if;
  raise notice 'ok G-race-4 crossed archives at once: one succeeds, one is refused, no deadlock';
end $race4$;
select dblink_disconnect('h');

select dblink_disconnect('a'), dblink_disconnect('b');
delete from case_app.cases where workspace_id = '0199a000-0000-7000-8000-000000003a0a';
delete from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-000000003a0a';
delete from case_app.workspaces where id = '0199a000-0000-7000-8000-000000003a0a';
delete from case_app.profiles where id = '0199a000-0000-7000-8000-000000003a01';
delete from auth.users where id = '0199a000-0000-7000-8000-000000003a01';
drop extension dblink;
