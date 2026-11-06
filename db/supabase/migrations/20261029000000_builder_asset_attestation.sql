-- CASE-273: the author may correct the soft de-identification tick before admin approval.
-- Lock the same asset row as review; an approved or closed record stays immutable.
begin;
create function case_api.builder_set_asset_attestation(p_workspace_id uuid,p_asset_id uuid,p_expected boolean,p_attested boolean,
  p_user_id uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare a case_app.assets; current_tick boolean;
begin
  perform case_app.authorize(p_user_id,p_workspace_id,'P-14',p_admin,p_admin_email);
  if p_expected is null or p_attested is null then raise exception 'invalid_attestation' using errcode='22023'; end if;
  select * into a from case_app.assets where id=p_asset_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode='42501'; end if;
  if a.status<>'quarantined' or a.kind not in ('image','video') then raise exception 'asset_details_changed' using errcode='40001'; end if;
  current_tick:=a.deidentified_attested_at is not null and (a.deidentified_attested_by is not null or a.deidentified_attestation_anonymized);
  -- A repeated identical request never changes its author or timestamp.
  if current_tick=p_attested then return case_app.asset_row(a); end if;
  if current_tick<>p_expected then raise exception 'asset_details_changed' using errcode='40001'; end if;
  if p_admin then perform case_app.ensure_admin_profile(p_user_id); end if;
  update case_app.assets set deidentified_attested_by=case when p_attested then p_user_id end,
    deidentified_attested_at=case when p_attested then clock_timestamp() end,deidentified_attestation_anonymized=false
    where id=a.id returning * into a;
  return case_app.asset_row(a);
end; $$;
revoke all on function case_api.builder_set_asset_attestation(uuid,uuid,boolean,boolean,uuid,boolean,text) from public,anon,authenticated;
grant execute on function case_api.builder_set_asset_attestation(uuid,uuid,boolean,boolean,uuid,boolean,text) to service_role;
commit;
