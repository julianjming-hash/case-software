-- Card 57 slide rooms (Julian, 2026-10-11): review candidates admit schema 3, so slide drafts can be reviewed and
-- released. Additive: one check widens; schema 1 and 2 behave exactly as before. Published versions already allow >= 1.
alter table case_app.builder_candidates drop constraint builder_candidates_schema_version_check;
alter table case_app.builder_candidates add constraint builder_candidates_schema_version_check check (schema_version in (1,2,3));
