-- Card 62 contract step (CASE-285 R1, MEDIA-03): drop the unfenced six-argument case_api.admin_review_asset that
-- 20261103000000_asset_review_fence.sql kept for the Worker deployed before it. Every Worker now calls the fenced
-- eight-argument overload, which names the state the admin was shown and acknowledges each open warning.
-- Apply only once every deployed Worker serves eaadd02 or later (production and staging did on 2026-10-18). Rolling a
-- Worker back past eaadd02 after this leaves image approval failing (the old Worker's call finds no function): fix forward.
begin;
drop function case_api.admin_review_asset(uuid, uuid, text, uuid, boolean, text);
commit;
