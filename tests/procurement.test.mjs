import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PRIVACY_SECTIONS, ANALYTICS_NOTICE, TURNSTILE_NOTICE, RETENTION_NOTICE } from '../src/client/privacy.mjs';
import { TEARDOWN_KEYS } from '../src/client/teardown.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public privacy contract collection notice equals SCREENS and the phone notice byte for byte', () => {
  const doc = read('docs/PRIVACY-COLLECTION-NOTICE.md');
  const policy = read('docs/PRIVACY-PRIVACY-POLICY.md');
  const expected = PRIVACY_SECTIONS.flatMap(section => section.paragraphs);
  for (const [name, text] of [['collection notice', doc], ['privacy policy', policy]]) {
    const paragraphs = [...text.matchAll(/^> ([^\n]+)$/gm)].map(match => match[1]);
    assert.deepEqual(paragraphs, expected, `${name} must preserve every served paragraph exactly, without extra notice copy`);
  }
  const visibility = PRIVACY_SECTIONS.find(section => section.id === 'sees').paragraphs[0];
  for (const notice of [visibility, RETENTION_NOTICE, ANALYTICS_NOTICE, TURNSTILE_NOTICE])
    assert.ok(read('docs/SCREENS.md').includes(notice), 'canonical screen disclosure missing');
});

function columns(table) {
  const migrations = new URL('../db/supabase/migrations/', import.meta.url);
  const sql = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort().map((name) => read(`db/supabase/migrations/${name}`)).join('\n');
  const match = sql.match(new RegExp(`create table case_app\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `migration table ${table} exists`);
  const initial = [...match[1].matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+(?:uuid|text|timestamptz|bigint|integer|jsonb|cidr|case_app\.sha256)\b/gm)].map((m) => m[1]);
  const added = [...sql.matchAll(new RegExp(`alter table case_app\\.${table}\\s+add column(?: if not exists)?\\s+([a-z][a-z0-9_]*)\\s`, 'gi'))].map((m) => m[1]);
  return [...new Set([...initial, ...added])];
}

test('public privacy contract inventory lists every participant, response and event archive column', () => {
  const inventory = read('docs/PRIVACY-DATA-INVENTORY.md');
  for (const table of ['session_participants', 'session_responses', 'session_events']) {
    for (const column of columns(table)) {
      assert.ok(inventory.includes(`| \`case_app.${table}\` | \`${column}\` |`), `${table}.${column} is missing an inventory row`);
    }
  }
});

test('public privacy contract inventory lists every currently implemented browser storage key family', () => {
  const inventory = read('docs/PRIVACY-DATA-INVENTORY.md');
  const transport = read('src/client/transport.mjs');
  const labBus = read('prototypes/room/lib/bus.mjs');
  const manual = read('prototypes/room/lib/local-authority.mjs');
  assert.match(transport, /export const PIN_KEY = 'case:transport:pin'/);
  assert.match(transport, /`case:\$\{role\}:\$\{slot \?\? 'main'\}:token`/);
  assert.match(labBus, /`case-lab:\$\{role\}:\$\{slot \?\? 'main'\}:token`/);
  assert.match(manual, /`case-lab:segment:\$\{mirror\.sessionId\}`/);
  for (const key of [...TEARDOWN_KEYS.knownExact, ...TEARDOWN_KEYS.knownKeyPrefixes, ...TEARDOWN_KEYS.knownDatabases, TEARDOWN_KEYS.shellCachePrefix, 'case:<role>:<slot>:token', 'case-lab:<role>:<slot>:token', 'case-lab:segment:<sessionId>']) {
    assert.ok(inventory.includes(`\`${key}\``), `browser key family ${key} is missing`);
  }
  for (const pattern of TEARDOWN_KEYS.knownPatterns)
    assert.ok(inventory.includes(`\`${pattern.source}\``), `teardown pattern ${pattern.source} is missing`);
  for (const phrase of ['pending PKCE', '10 minutes', 'persists until Sign out', 'same-room recovery', 'original expiry', 'sign-out', 'room end'])
    assert.ok(inventory.includes(phrase), `browser cleanup exception ${phrase} is missing`);
});


test('public privacy contract inventory includes every administrative audit column and new profile lifecycle field', () => {
  const inventory = read('docs/PRIVACY-DATA-INVENTORY.md');
  const auditColumns = columns('admin_audit_log');
  assert.ok(auditColumns.includes('from_prefix'), 'the actual CIDR audit column is included in schema discovery');
  for (const column of auditColumns)
    assert.ok(inventory.includes(`| \`case_app.admin_audit_log\` | \`${column}\` |`), `administrative audit ${column} is missing an inventory row`);
  const sql = read('db/supabase/migrations/20261002040000_admin_server.sql');
  const block = sql.match(/alter table case_app\.profiles\s+([\s\S]*?);/);
  assert.ok(block, 'reviewed administrative profile migration exists');
  const fields = [...block[1].matchAll(/add column ([a-z][a-z0-9_]*)\s/g)].map(match => match[1]);
  assert.ok(fields.length > 0, 'actual lifecycle columns were found');
  for (const field of fields)
    assert.ok(inventory.includes(`\`case_app.profiles.${field}\``), `administrative profile ${field} is missing`);
});

test('public privacy contract policy distinguishes indefinite administrative audit from participant purge and operational copies', () => {
  for (const path of ['docs/BRIEF.md', 'docs/PRIVACY-DATA-INVENTORY.md',
    'docs/PRIVACY-PRIVACY-POLICY.md', 'docs/PRIVACY-THRESHOLD-PIA.md',
    'docs/PRIVACY-DATA-FLOW.md', 'docs/PRIVACY-SUB-PROCESSORS.md',
    'docs/PRIVACY-VERIFICATION-CHECKLIST.md']) {
    const doc = read(path);
    assert.match(doc, /administrative audit[^\n]*indefinit|indefinit[^\n]*administrative audit/i, `${path} must distinguish the approved audit retention`);
  }
  const inventory = read('docs/PRIVACY-DATA-INVENTORY.md');
  assert.match(inventory, /Auth-first/i, 'account deletion is Auth-first');
  assert.match(inventory, /thirty-day|30-day/i, 'account restore window is distinct');
  assert.match(inventory, /unresolved[^\n]*claim[^\n]*reconciliation|claim[^\n]*manual reconciliation/i, 'unknown account deletion is not promised complete');
  assert.doesNotMatch(inventory, /account lifetime and deletion process are not specified|broader deletion policy not specified|deletion policy not specified/i, 'reviewed lifecycle is no longer unknown policy');
});


test('public privacy contract distinguishes current room erasure from unverified provider recovery history', () => {
  const inventory = read('docs/PRIVACY-DATA-INVENTORY.md');
  assert.match(inventory, /Cloudflare Durable Object PITR[^\n]*30 days/, 'provider recovery window is inventoried');
  assert.match(inventory, /deleteAll\(\)[^\n]*current store/, 'live-store erasure is not presented as recovery-history erasure');
  assert.match(inventory, /post-deletion recovery-history erasure is unverified/, 'provider erasure must not be presented as confirmed');
  const security = read('docs/PRIVACY-SECURITY-SUMMARY.md');
  assert.match(security, /PITR[^\n]*unavailable in local development/, 'local gates cannot verify provider history');
  const checklist = read('docs/PRIVACY-VERIFICATION-CHECKLIST.md');
  assert.match(checklist, /DO recovery-history erasure after deleteAll[^\n]*seven-day contract[^\n]*Not verified/, 'owner recovery-history compatibility evidence remains open');
  const pia = read('docs/PRIVACY-THRESHOLD-PIA.md');
  assert.match(pia, /recovery-history[^\n]*unresolved[^\n]*pilot/, 'unresolved recovery retention is a pre-pilot risk');
  const index = read('docs/PRIVACY-README.md');
  assert.match(index, /recovery-history compatibility[^\n]*unverified/, 'approval summary discloses the unverified boundary');
});
