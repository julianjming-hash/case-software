-- db/tests/supabase-stub.sql
-- Minimal stand-in for what a Supabase project already provides, so the migration can
-- be tested on a plain local Postgres (scripts/test-db.sh). Never run on Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
