#!/usr/bin/env bash
# scripts/test-db.sh — apply every Case migration to a throwaway local Postgres
# and run the SQL assertions. Needs Postgres ≥ 15 binaries (macOS: `brew install postgresql@16`).
# Usage (from the Case root): npm run test:db
# CASE_REQUIRE_DB=1 turns every "SKIPPED" into a failure (CI sets it, so the gate can't pass vacuously).
set -euo pipefail

skip() {
  if [ "${CASE_REQUIRE_DB:-}" = 1 ]; then echo "FAILED: $1 (CASE_REQUIRE_DB=1)"; exit 1; fi
  echo "SKIPPED: $1"; exit 0
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# First initdb on PATH, else the newest of the usual install locations (Linux, Homebrew arm/intel, Postgres.app).
# Hosted ubuntu-24.04 and the Case Linux VM runners both keep Postgres 16 under /usr/lib/postgresql/16/bin.
find_initdb() {
  command -v initdb 2>/dev/null && return 0
  local c found=""
  for c in /usr/lib/postgresql/*/bin/initdb /opt/homebrew/opt/postgresql@*/bin/initdb \
           /usr/local/opt/postgresql@*/bin/initdb /Applications/Postgres.app/Contents/Versions/*/bin/initdb; do
    [ -x "$c" ] && found="$c"
  done
  [ -n "$found" ] && echo "$found"
  return 0
}
INITDB="$(find_initdb)"
[ -n "$INITDB" ] || skip "no Postgres binaries found (install postgresql@16 to run the database tests)"
BIN="$(dirname "$INITDB")"
for program in initdb postgres pg_ctl psql; do
  [ -x "$BIN/$program" ] || skip "incomplete Postgres installation at $BIN (missing $program)"
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/case-db.XXXXXXXX")"
# Postgres refuses to run as root (containers); drop to the postgres OS user there.
# A function, not an array: macOS /bin/bash 3.2 treats an empty "${arr[@]}" as unbound under set -u.
RUN_AS=""
if [ "$(id -u)" = 0 ]; then
  id postgres >/dev/null 2>&1 || skip "running as root with no postgres user"
  chown postgres "$TMP"; chmod 755 "$TMP"
  RUN_AS=postgres
fi
as_pg() {
  if [ -n "$RUN_AS" ]; then runuser -u "$RUN_AS" -- "$@"; else "$@"; fi
}
cleanup() { as_pg "$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

as_pg "$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
as_pg "$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=("$BIN/psql" -h "$TMP" -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q)

# SQL tests read repo fixtures by root-relative path (psql backticks run in the current directory).
cd "$ROOT"
"${PSQL[@]}" -f "$ROOT/db/tests/supabase-stub.sql"
for m in "$ROOT"/db/supabase/migrations/*.sql; do
  echo "migrate $(basename "$m")"
  "${PSQL[@]}" -f "$m"
done
for t in "$ROOT"/db/tests/*.test.sql; do
  echo "test $(basename "$t")"
  "${PSQL[@]}" -f "$t" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: //'
done
CASE_TEST_PSQL_BIN="$BIN/psql" CASE_TEST_PG_SOCKET="$TMP" node --test --test-concurrency=1 "$ROOT/tests/db/"*.test.mjs
echo "database tests passed"
