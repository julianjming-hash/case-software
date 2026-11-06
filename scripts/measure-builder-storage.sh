#!/bin/bash
# Measurement-only Builder payload/storage probe. It starts a disposable local PostgreSQL 16
# cluster, uses TEMP tables only, prints aggregate byte measurements, then stops and removes it.
# It does not call Case, Supabase, Cloudflare, or any network endpoint.
set -euo pipefail

CASE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRANSFER="$CASE_ROOT/docs/cards/49-artifacts/builder-diving-transfer.json"
EXPECTED_TRANSFER_SHA=87c5957d8090aad7c0c88b9ab489be3090603a3a1a24a8e57eb8e5c91549b376

find_initdb() {
  command -v initdb 2>/dev/null && return 0
  local c found=""
  for c in /usr/lib/postgresql/*/bin/initdb /opt/homebrew/opt/postgresql@16/bin/initdb \
           /usr/local/opt/postgresql@16/bin/initdb /Applications/Postgres.app/Contents/Versions/16/bin/initdb; do
    [ -x "$c" ] && found="$c"
  done
  [ -n "$found" ] && echo "$found"
  return 0
}

INITDB="$(find_initdb)"
[ -n "$INITDB" ] || { echo "FAILED: PostgreSQL 16 binaries not found" >&2; exit 2; }
BIN="$(dirname "$INITDB")"
VERSION="$("$BIN/postgres" --version)"
case "$VERSION" in "postgres (PostgreSQL) 16."*) ;; *) echo "FAILED: expected PostgreSQL 16, got $VERSION" >&2; exit 2;; esac
for program in initdb postgres pg_ctl psql; do
  [ -x "$BIN/$program" ] || { echo "FAILED: incomplete PostgreSQL 16 installation" >&2; exit 2; }
done
[ -r "$TRANSFER" ] || { echo "FAILED: frozen transfer not found: $TRANSFER" >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/builder-storage-measure.XXXXXX")"
RUN_AS=""
if [ "$(id -u)" = 0 ]; then
  id postgres >/dev/null 2>&1 || { echo "FAILED: root requires a postgres OS user" >&2; exit 2; }
  chown postgres "$TMP"; chmod 755 "$TMP"; RUN_AS=postgres
fi
as_pg() { if [ -n "$RUN_AS" ]; then runuser -u "$RUN_AS" -- "$@"; else "$@"; fi; }
cleanup() {
  as_pg "$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

as_pg "$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
as_pg "$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null

CASE_ROOT="$CASE_ROOT" TRANSFER="$TRANSFER" EXPECTED_TRANSFER_SHA="$EXPECTED_TRANSFER_SHA" \
node --input-type=module - <<'NODE' | as_pg "$BIN/psql" -h "$TMP" -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q -A -t -f -
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = process.env.CASE_ROOT;
const transferBytes = await readFile(process.env.TRANSFER);
const transferSha = createHash('sha256').update(transferBytes).digest('hex');
if (transferSha !== process.env.EXPECTED_TRANSFER_SHA) throw new Error('frozen_transfer_hash_mismatch');
const { inspectBuilderTransfer } = await import(`${root}/src/shared/builder-transfer.mjs`);
const inspected = await inspectBuilderTransfer(JSON.parse(transferBytes), {
  intent: 'copy', mode: 'ready', acknowledgeRedactions: true, acknowledgeRightsWarnings: true,
});
if (!inspected.ok || !inspected.candidate?.document || !inspected.candidate?.authoring_metadata)
  throw new Error('frozen_transfer_inspection_failed');
const document = JSON.stringify(inspected.candidate.document);
const metadata = JSON.stringify(inspected.candidate.authoring_metadata);
const q = value => `'${value.replaceAll("'", "''")}'`;
const documentSql = `${q(document)}::jsonb`;
const metadataSql = `${q(metadata)}::jsonb`;
const source = inspected.candidate.authoring_metadata.sources?.[0];
if (!source || source.sha256 !== '911d7166515dec00fcf8ab069eb443c8f07e6eadef770d257e509719be14eae0' || Buffer.byteLength(source.text, 'utf8') !== 43342)
  throw new Error('source_envelope_mismatch');
const currentId = '00000000-0000-7000-8000-000000000001';
const actorId = '00000000-0000-7000-8000-000000000002';
const workspaceId = '00000000-0000-7000-8000-000000000003';
const rows = [];
rows.push(`\\echo frozen_transfer_sha=${transferSha}`);
rows.push(`\\echo javascript_json_bytes_document=${Buffer.byteLength(document)} metadata=${Buffer.byteLength(metadata)} paired=${Buffer.byteLength(document)+Buffer.byteLength(metadata)} request_draft=${Buffer.byteLength(JSON.stringify({operationId:currentId,document:inspected.candidate.document,authoringMetadata:inspected.candidate.authoring_metadata}))} request_candidate=${Buffer.byteLength(JSON.stringify({requestId:currentId,revision:7,document:inspected.candidate.document,authoringMetadata:inspected.candidate.authoring_metadata}))} request_checkpoint=${Buffer.byteLength(JSON.stringify({name:'Diving source review',expectedRevision:7}))} request_restore=${Buffer.byteLength(JSON.stringify({operationId:currentId}))}`);
rows.push(`BEGIN;`);
rows.push(`CREATE TEMP TABLE bench_draft(case_id uuid primary key,revision bigint not null,schema_version int not null,document jsonb not null,authoring_metadata jsonb,builder_managed boolean not null,updated_by uuid not null,updated_at timestamptz not null);`);
rows.push(`CREATE TEMP TABLE bench_checkpoint(id uuid primary key,case_id uuid not null,workspace_id uuid not null,name text not null,revision bigint not null,schema_version int not null,document jsonb not null,authoring_metadata jsonb,intent_digest bytea not null,created_by uuid not null,created_at timestamptz not null,deleted_at timestamptz);`);
rows.push(`CREATE UNIQUE INDEX bench_checkpoint_live_name_idx ON bench_checkpoint(case_id,lower(name)) WHERE deleted_at IS NULL;`);
rows.push(`CREATE INDEX bench_checkpoint_live_case_idx ON bench_checkpoint(case_id,created_at DESC) WHERE deleted_at IS NULL;`);
rows.push(`CREATE TEMP TABLE bench_candidate(candidate_id uuid primary key,case_id uuid not null,workspace_id uuid not null,submitted_by uuid not null,request_id uuid not null,revision bigint not null,schema_version int not null,document jsonb,authoring_metadata jsonb,intent_digest bytea not null,content_sha256 bytea not null,status text not null,submitted_at timestamptz not null,approved_by uuid,approved_at timestamptz,approved_intent_digest bytea,approved_content_sha256 bytea,ended_at timestamptz,released_version_id uuid,release_digest bytea,released_at timestamptz,body_deleted_at timestamptz);`);
rows.push(`CREATE UNIQUE INDEX bench_candidate_active_idx ON bench_candidate(case_id) WHERE status IN ('pending','approved');`);
rows.push(`CREATE INDEX bench_candidate_case_history_idx ON bench_candidate(case_id,submitted_at DESC,candidate_id);`);
rows.push(`CREATE INDEX bench_candidate_workspace_idx ON bench_candidate(workspace_id,submitted_at DESC);`);
rows.push(`CREATE UNIQUE INDEX bench_candidate_case_request_idx ON bench_candidate(case_id,submitted_by,request_id);`);
rows.push(`CREATE UNIQUE INDEX bench_candidate_release_version_idx ON bench_candidate(released_version_id);`);
rows.push(`INSERT INTO bench_draft VALUES('${currentId}',7,2,${documentSql},${metadataSql},true,'${actorId}',clock_timestamp());`);
for (let i=1;i<=3;i++) rows.push(`INSERT INTO bench_checkpoint VALUES('00000000-0000-7000-8000-${String(i+10).padStart(12,'0')}','${currentId}','${workspaceId}','checkpoint ${i}',7,2,${documentSql},${metadataSql},decode(repeat('a',64),'hex'),'${actorId}',clock_timestamp(),NULL);`);
for (let i=1;i<=4;i++) rows.push(`INSERT INTO bench_candidate(candidate_id,case_id,workspace_id,submitted_by,request_id,revision,schema_version,document,authoring_metadata,intent_digest,content_sha256,status,submitted_at) VALUES('00000000-0000-7000-8000-${String(i+20).padStart(12,'0')}','${currentId}','${workspaceId}','${actorId}','00000000-0000-7000-8000-${String(i+30).padStart(12,'0')}',7,2,${documentSql},${metadataSql},decode(repeat('b',64),'hex'),decode(repeat('c',64),'hex'),'${i===1?'pending':'superseded'}',clock_timestamp());`);
rows.push(`\\echo Representative payload column and relation bytes (PostgreSQL JSONB/TOAST):`);
rows.push(`SELECT json_build_object('document_jsonb_pg_column_bytes',pg_column_size(document),'metadata_jsonb_pg_column_bytes',pg_column_size(authoring_metadata),'document_jsonb_text_bytes',octet_length(document::text),'metadata_jsonb_text_bytes',octet_length(authoring_metadata::text)) FROM bench_draft;`);
rows.push(`SELECT json_build_object('table','draft','rows',(SELECT count(*) FROM bench_draft),'heap_bytes',pg_relation_size('bench_draft'),'index_bytes',pg_indexes_size('bench_draft'),'total_bytes',pg_total_relation_size('bench_draft'),'toast_bytes',coalesce((SELECT pg_total_relation_size(reltoastrelid) FROM pg_class WHERE oid='bench_draft'::regclass AND reltoastrelid<>0),0));`);
for (const table of ['bench_checkpoint','bench_candidate']) rows.push(`SELECT json_build_object('table','${table}','rows',(SELECT count(*) FROM ${table}),'heap_bytes',pg_relation_size('${table}'),'index_bytes',pg_indexes_size('${table}'),'total_bytes',pg_total_relation_size('${table}'),'toast_bytes',coalesce((SELECT pg_total_relation_size(reltoastrelid) FROM pg_class WHERE oid='${table}'::regclass AND reltoastrelid<>0),0));`);
rows.push(`SELECT json_build_object('eight_copy_model','1 current + 3 checkpoints + 4 candidate bodies','builder_usage_bytes_model_pg_column_size_payload_plus_candidate_charge',8*(pg_column_size(d.document)+pg_column_size(d.authoring_metadata))+4*512,'builder_usage_bytes_model_plus_max_workspace_window_receipt_allowances',8*(pg_column_size(d.document)+pg_column_size(d.authoring_metadata))+4*512+38400000) FROM bench_draft d;`);
rows.push(`CREATE TEMP TABLE bench_window(operation_id uuid primary key,case_id uuid not null,actor_id uuid not null,base_revision bigint not null,created_at timestamptz not null,expires_at timestamptz not null,used_at timestamptz,operation_kind text not null,target_id uuid);`);
rows.push(`CREATE INDEX bench_window_case_actor_expiry_idx ON bench_window(case_id,actor_id,expires_at);`);
rows.push(`INSERT INTO bench_window SELECT md5('w'||n)::uuid,md5('wc'||((n+24)/25))::uuid,'${actorId}',7,clock_timestamp(),clock_timestamp()+interval '24 hours',NULL,'save',NULL FROM generate_series(1,100000) n;`);
rows.push(`CREATE TEMP TABLE bench_receipt(operation_id uuid primary key,case_id uuid not null,actor_id uuid not null,base_revision bigint not null,revision bigint not null,intent_digest bytea not null,status text not null,operation_kind text not null,target_id uuid,committed_at timestamptz not null,expires_at timestamptz not null);`);
rows.push(`CREATE INDEX bench_receipt_case_expiry_idx ON bench_receipt(case_id,expires_at);`);
rows.push(`INSERT INTO bench_receipt SELECT md5('r'||n)::uuid,md5('rc'||((n+9999)/10000))::uuid,'${actorId}',7,8,decode(repeat('a',64),'hex'),'saved','save',NULL,clock_timestamp(),clock_timestamp()+interval '7 days' FROM generate_series(1,100000) n;`);
for (const table of ['bench_window','bench_receipt']) rows.push(`SELECT json_build_object('table','${table}','rows',(SELECT count(*) FROM ${table}),'heap_bytes',pg_relation_size('${table}'),'index_bytes',pg_indexes_size('${table}'),'total_bytes',pg_total_relation_size('${table}'),'physical_bytes_per_row',round(pg_total_relation_size('${table}')::numeric/(SELECT count(*) FROM ${table}),2));`);
rows.push(`SELECT json_build_object('bounded_quota_receipt_budget_100k',100000*256,'bounded_quota_window_budget_100k',100000*128,'combined_quota_allowance',100000*(256+128));`);
rows.push(`\\echo Disposable-table cleanup timing only; no VACUUM or post-cleanup shrinkage claim:`);
rows.push(`UPDATE bench_window SET expires_at=clock_timestamp()-interval '1 second';`);
rows.push(`EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT) DELETE FROM bench_window WHERE expires_at<=clock_timestamp();`);
rows.push(`SELECT json_build_object('table','bench_window','expired_rows_remaining',(SELECT count(*) FROM bench_window));`);
rows.push(`UPDATE bench_receipt SET expires_at=clock_timestamp()-interval '1 second';`);
rows.push(`EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT) DELETE FROM bench_receipt WHERE expires_at<=clock_timestamp();`);
rows.push(`SELECT json_build_object('table','bench_receipt','expired_rows_remaining',(SELECT count(*) FROM bench_receipt));`);
rows.push(`ROLLBACK;`);
process.stdout.write(rows.join('\n')+'\n');
NODE
