-- Card 62 (CASE-285 R1, MEDIA-03): an admin approves exactly the image they were shown. Warnings stay soft (CASE-268,
-- CASE-273), but approving over any open warning acknowledges each one: the server works out the open warnings itself,
-- refuses an approval whose shown attestation and rights state, or whose acknowledged warnings, differ from what is
-- stored (40001 asset_details_changed), and records the acknowledged warnings on the asset_approve audit row.
-- Expand only: the six-argument admin_review_asset the running Worker calls stays unchanged until a contract migration
-- drops it (scripts/gen-permissions.mjs EXPAND_WINDOW; docs/PERMISSIONS.md §7.1).
begin;

-- The open-warning codes, one per caution the author was shown at upload (src/shared/media.mjs assetDetails):
-- not_deidentified   the author did not tick the de-identification check
-- licence_caution    a non-commercial or no-derivatives Creative Commons licence
-- no_licence         a textbook or journal figure with no licence held
-- source_unknown     the source is not known
-- credit_missing     the source usually needs a credit line and none was given
-- licence_terms_missing  "licensed for this use" without the licence written down
alter table case_app.workspace_audit add column acknowledged text[];
alter table case_app.workspace_audit add constraint workspace_audit_acknowledged check (acknowledged is null or (action = 'asset_approve'
  and array_position(acknowledged, null) is null
  and acknowledged <@ array['not_deidentified','licence_caution','no_licence','source_unknown','credit_missing','licence_terms_missing']::text[]));

-- The open warnings of a stored image, sorted, each once. Mirrors openImageWarnings in src/shared/media.mjs.
create function case_app.asset_open_warnings(a case_app.assets)
returns text[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(w order by w collate "C"), '{}') from unnest(array[
    case when not (a.deidentified_attested_at is not null and (a.deidentified_attested_by is not null or a.deidentified_attestation_anonymized)) then 'not_deidentified' end,
    case when a.licence in ('CC-BY-NC-4.0','CC-BY-NC-SA-4.0','CC-BY-ND-4.0','CC-BY-NC-ND-4.0') then 'licence_caution' end,
    case when a.licence = 'unlicensed' then 'no_licence' end,
    case when a.licence = 'unknown' then 'source_unknown' end,
    case when a.licence in ('CC-BY-4.0','CC-BY-SA-4.0','licensed-other','CC-BY-NC-4.0','CC-BY-NC-SA-4.0','CC-BY-ND-4.0','CC-BY-NC-ND-4.0','unlicensed')
      and nullif(btrim(coalesce(a.attribution, '')), '') is null then 'credit_missing' end,
    case when a.licence = 'licensed-other' and nullif(btrim(coalesce(a.rights_note, '')), '') is null then 'licence_terms_missing' end
  ]) w where w is not null;
$$;

-- The attestation and rights state an admin is shown, as asset_row lists it: these seven keys, nulls included.
create function case_app.asset_review_state(a case_app.assets)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('attested', a.deidentified_attested_at is not null and (a.deidentified_attested_by is not null or a.deidentified_attestation_anonymized),
    'rights_basis', a.rights_basis, 'licence', a.licence, 'creator', a.creator, 'attribution', a.attribution, 'rights_note', a.rights_note, 'source_url', a.source_url);
$$;

-- P-33. An approval names the state the admin saw (p_expected) and the open warnings they acknowledged (p_acknowledged).
-- The row lock is the one builder_set_asset_attestation takes, so an approval and an author's tick change are
-- serialised: whichever commits second sees the other's change and is refused. A rejection needs neither argument.
create function case_api.admin_review_asset(p_workspace_id uuid, p_asset_id uuid, p_decision text, p_expected jsonb, p_acknowledged text[],
  p_user_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_row case_app.assets; v_open text[];
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-33', p_admin, p_admin_email);
  if p_decision is null or p_decision not in ('approve','reject') then raise exception 'invalid_decision' using errcode = '22023'; end if;
  if p_decision = 'approve' and (jsonb_typeof(p_expected) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_expected) k) is distinct from array['attested','attribution','creator','licence','rights_basis','rights_note','source_url']
      or p_acknowledged is null or array_position(p_acknowledged, null) is not null
      or not p_acknowledged <@ array['not_deidentified','licence_caution','no_licence','source_unknown','credit_missing','licence_terms_missing']::text[]) then
    raise exception 'invalid_review' using errcode = '22023';
  end if;
  perform case_app.ensure_admin_profile(p_user_id);
  select * into v_row from case_app.assets a where a.id = p_asset_id and a.workspace_id = p_workspace_id for update;
  if not found then raise exception 'asset_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'quarantined' then raise exception 'asset_not_pending' using errcode = '40001'; end if;
  if p_decision = 'approve' then
    v_open := case_app.asset_open_warnings(v_row);
    if case_app.asset_review_state(v_row) is distinct from p_expected
       or v_open is distinct from (select coalesce(array_agg(distinct c collate "C" order by c collate "C"), '{}') from unnest(p_acknowledged) c) then
      raise exception 'asset_details_changed' using errcode = '40001';
    end if;
  end if;
  update case_app.assets set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      approved_by = case when p_decision = 'approve' then p_user_id end, approved_at = case when p_decision = 'approve' then clock_timestamp() end
    where id = p_asset_id returning * into v_row;
  if p_decision = 'reject' then perform case_app.enqueue_asset_keys(p_asset_id, 'rejected'); end if;
  insert into case_app.workspace_audit (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id, acknowledged)
    values (p_workspace_id, 'admin', p_user_id, p_admin_email, 'asset_' || p_decision, 'asset', p_asset_id, v_open);
  return case_app.asset_row(v_row);
end;
$$;

revoke all on function case_app.asset_open_warnings(case_app.assets), case_app.asset_review_state(case_app.assets) from public, anon, authenticated, service_role;
revoke all on function case_api.admin_review_asset(uuid,uuid,text,jsonb,text[],uuid,boolean,text) from public, anon, authenticated, service_role;
grant execute on function case_api.admin_review_asset(uuid,uuid,text,jsonb,text[],uuid,boolean,text) to service_role;
commit;
