import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { rpcClient, RPC_ALLOWLIST, RPC_ARGUMENTS, RpcPageError } from '../src/worker/rpc.mjs';
import { fakePostgrest, FAKE_RPC_CONTRACT } from './helpers/fake-postgrest.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { EXPAND_WINDOW } from '../scripts/gen-permissions.mjs';
const env = () => ({ SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: `sb_secret_${uuidv7()}` });
const make = () => { const fake = fakePostgrest(), config = env(); return { fake, config, client: rpcClient(config, { fetchImpl: fake.fetchImpl }) }; };

// Track exact service grants in migration order, including dropped historical overloads.
function serviceGrants(migrations) {
  const known = new Set(), granted = new Set();
  const key = (name, types) => `${name.toLowerCase()}(${types.toLowerCase().replace(/\s/g, '')})`;
  for (const sql of migrations) {
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+case_api\.(\w+)\s*\(([^)]*)\)/gi)) {
      const types = m[2].split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^p_\w+\s+/, '').split(/\s+default\s+/i)[0]);
      known.add(key(m[1], types.join(',')));
    }
    for (const match of sql.matchAll(/(?:grant|revoke)\s+(?:execute|all)\s+on\s+(?:all functions in schema case_api|function[\s\S]*?)\s+(?:to|from)\s+[^;]+;|drop\s+function\s+(?:if exists\s+)?case_api\.\w+\([^)]*\)\s*;/gi)) {
      const statement = match[0], drop = /^drop/i.test(statement);
      if (!drop && !/\bservice_role\b/i.test(statement)) continue;
      const grant = /^grant/i.test(statement);
      if (/all functions in schema case_api/i.test(statement)) {
        if (grant) for (const signature of known) granted.add(signature);
        else granted.clear();
      } else for (const m of statement.matchAll(/case_api\.(\w+)\(([^)]*)\)/gi)) {
        const signature = key(m[1], m[2]);
        if (grant) granted.add(signature); else granted.delete(signature);
        if (drop) known.delete(signature);
      }
    }
  }
  return [...granted].sort();
}

test('service grant audit preserves overload identity, ordered revocation and drop/recreation', () => {
  const old = 'create function case_api.sample(p_id uuid) returns uuid; grant execute on function case_api.sample(uuid) to service_role;';
  const replacement = 'create function case_api.sample(p_id uuid,p_revision bigint) returns uuid; grant execute on function case_api.sample(uuid,bigint) to service_role;';
  assert.deepEqual(serviceGrants([old, replacement]), ['sample(uuid)', 'sample(uuid,bigint)']);
  assert.deepEqual(serviceGrants([old, replacement, 'revoke execute on function case_api.sample(uuid) from service_role;']), ['sample(uuid,bigint)']);
  assert.deepEqual(serviceGrants([old, 'drop function case_api.sample(uuid);', replacement]), ['sample(uuid,bigint)']);
  assert.deepEqual(serviceGrants([old, 'revoke all on all functions in schema case_api from public,service_role;', replacement]), ['sample(uuid,bigint)']);
  assert.deepEqual(serviceGrants([old, 'drop function case_api.sample(uuid);', 'create function case_api.sample(p_id uuid) returns uuid;']), []);
  assert.deepEqual(serviceGrants([old, 'revoke execute on function case_api.sample(uuid) from service_role;', 'grant execute on function case_api.sample(uuid) to service_role;']), ['sample(uuid)']);
});

test('RPC allowlist, arguments and fake row shapes match the latest service-role migration signatures', () => {
  const signatures = new Map();
  const migrationSql = [];
  const normalizeTypes = value => value.toLowerCase().replace(/\s/g, '');
  const dir = new URL('../db/supabase/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    migrationSql.push(sql);
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+case_api\.(\w+)\s*\(([^)]*)\)\s*returns\s+(?:table\s*\(([^)]*)\)|(\w+))/gi)) {
      const parts = m[2].split(',').map(s => s.trim()).filter(Boolean);
      signatures.set(m[1], { types: normalizeTypes(parts.map(s => s.replace(/^p_\w+\s+/, '').split(/\s+default\s+/i)[0]).join(',')), args: parts.map(s => s.match(/^(p_\w+)/)[1]), optional: parts.filter(s => /\bdefault\b/i.test(s)).map(s => s.match(/^(p_\w+)/)[1]), fields: m[3]?.split(',').map(s => s.trim().split(/\s+/)[0]), type: m[4]?.toLowerCase() });
    }
  }
  // Revocation retires an exact overload, not a newer revision-bound function with the same name.
  const retiredOverloads = new Set();
  for (const sql of migrationSql)
    for (const m of sql.matchAll(/revoke execute on function case_api\.(\w+)\(([^)]*)\) from [^;]*\bservice_role\b;/gi))
      retiredOverloads.add(`${m[1]}(${normalizeTypes(m[2])})`);
  const retired = new Set([...signatures].filter(([name, signature]) => retiredOverloads.has(`${name}(${signature.types})`)).map(([name]) => name));
  for (const name of retired) signatures.delete(name);
  assert.ok(retiredOverloads.has('builder_create_checkpoint(uuid,text,uuid,boolean,text)'), 'unbound checkpoint overload is retired');
  assert.ok(!retiredOverloads.has('builder_create_checkpoint(uuid,text,bigint,uuid,boolean,text)'), 'revision-bound checkpoint remains callable');
  assert.ok(retired.has('publish_draft'), 'the art-less publish RPC is retired');
  assert.ok(retired.has('publish_draft_with_art'), 'the legacy first-publication RPC is retired');
  assert.deepEqual([...RPC_ALLOWLIST].sort(), [...signatures.keys()].sort());
  assert.deepEqual(Object.keys(FAKE_RPC_CONTRACT).sort(), [...signatures.keys()].sort());
  for (const [name, signature] of signatures) {
    assert.deepEqual(RPC_ARGUMENTS[name], signature.args, name);
    const fake = FAKE_RPC_CONTRACT[name];
    assert.deepEqual(fake.args, signature.args, name); assert.deepEqual(fake.optional, signature.optional, name);
    if (signature.fields) assert.deepEqual(fake.fields, signature.fields, name);
    else assert.equal(fake.shape, { boolean: 'boolean', bigint: 'number', integer: 'number', uuid: 'uuid', void: 'null', timestamptz: 'timestamp', jsonb: 'object' }[signature.type], name);
  }
  assert.ok(RPC_ARGUMENTS.create_session.includes('p_session_id'));
  const phase = readFileSync(new URL('20261002000000_phase_1b_rpcs.sql', dir), 'utf8');
  assert.match(phase, /revoke all on all functions in schema case_api from public, anon, authenticated, service_role/i);
  const published = readFileSync(new URL('20261002010000_published_rooms.sql', dir), 'utf8');
  const owned = readFileSync(new URL('20261002020000_console_pair_rooms.sql', dir), 'utf8');
  const admin = readFileSync(new URL('20261002040000_admin_server.sql', dir), 'utf8');
  const retention = readFileSync(new URL('20261003000000_retention_status.sql', dir), 'utf8');
  const art = readFileSync(new URL('20261006000000_case_version_art.sql', dir), 'utf8');
  const catalogue = readFileSync(new URL('20261007000000_case_catalogue.sql', dir), 'utf8');
  const permissions = readFileSync(new URL('20261008000000_permissions_core.sql', dir), 'utf8');
  const groups = readFileSync(new URL('20261009000000_case_groups.sql', dir), 'utf8');
  const history = readFileSync(new URL('20261012000000_room_history.sql', dir), 'utf8');
  const builder = readFileSync(new URL('20261013000000_builder_drafts.sql', dir), 'utf8');
  const review = readFileSync(new URL('20261014000000_builder_review.sql', dir), 'utf8');
  const grant = migrationSql.flatMap(sql =>
    [...sql.matchAll(/grant execute on function([\s\S]*?)to service_role;/gi)].map(match => match[1])).join('\n');
  const active = [...grant.matchAll(/case_api\.(\w+)\(([^)]*)\)/g)];
  // A recreated function (the art migration drops and recreates two reads) is granted again by name.
  // An expand step keeps an old signature granted for the deployed Worker (PERMISSIONS §7.1): exactly the signatures on
  // EXPAND_WINDOW, the list the permission matrix uses. The Worker and the fake still name only the newest arguments.
  const expanding = EXPAND_WINDOW.map(signature => signature.replace(/^case_api\./, '').replace(/\s/g, '').toLowerCase());
  assert.deepEqual(serviceGrants(migrationSql), [...[...signatures].map(([name, signature]) => `${name}(${signature.types})`), ...expanding].sort(), 'no stale or ungranted service overload may be hidden');
  for (const signature of expanding) assert.notEqual(`${signature.split('(')[0]}(${signatures.get(signature.split('(')[0])?.types})`, signature, `${signature} is an old overload beside a newer one`);
  assert.ok(active.some(m => m[1] === 'builder_create_checkpoint' && normalizeTypes(m[2]) === 'uuid,text,bigint,uuid,boolean,text'), 'bound checkpoint is explicitly granted');
  assert.equal(active.some(m => m[1] === 'create_session' && m[2] === 'uuid,uuid,uuid,text,interval'), false);
  assert.equal(active.find(m => m[1] === 'create_session')[2], 'uuid,uuid,uuid,uuid,text,interval');
  // Card 35: every recreated RPC is granted again with the admin arguments; none is granted to anon/authenticated.
  assert.ok(active.some(m => m[1] === 'create_session' && m[2].replace(/\s/g, '') === 'uuid,uuid,uuid,uuid,text,interval,boolean,text'));
  assert.doesNotMatch(permissions.replace(/--.*$/gm, ''), /grant[^;]*to\s+(anon|authenticated|public)/i);
  assert.doesNotMatch(history.replace(/--.*$/gm, ''), /grant[^;]*to\s+(anon|authenticated|public)/i);
  assert.doesNotMatch(groups.replace(/--.*$/gm, ''), /grant[^;]*to\s+(anon|authenticated|public)/i);
});
test('the legacy first-publication RPC cannot be called through the Worker allowlist', async () => {
  const { client, fake } = make();
  const result = await client.call('publish_draft_with_art', {});
  assert.deepEqual(result, { ok: false, kind: 'bad_request', status: 400, code: 'invalid_rpc' });
  assert.equal(fake.requests.length, 0);
});
test('[AS-080] owned-room RPC accepts only caller, limit, cursor and the admin arguments and returns the fake row shape', async () => {
  const { client, fake } = make();
  const userId = uuidv7(), sessionId = uuidv7();
  fake.replies.set('list_owned_active_sessions', [{ session_id: sessionId, join_code: 'K90001', expires_at: '2026-10-03T00:00:00Z' }]);
  const args = { p_user_id: userId, p_limit: 20, p_after: null, p_admin: false, p_admin_email: null };
  assert.deepEqual(await client.call('list_owned_active_sessions', args), { ok: true,
    data: [{ session_id: sessionId, join_code: 'K90001', expires_at: '2026-10-03T00:00:00Z' }] });
  assert.deepEqual(fake.requests[0].args, args);
  assert.equal((await client.call('list_owned_active_sessions', { ...args, p_secret: 'private' })).code, 'invalid_arguments');
  assert.equal(fake.requests.length, 1);
});
test('Card 20 retention RPC accepts one session ID and returns only the fixed evidence row', async () => {
  const { client, fake } = make();
  const sessionId = uuidv7();
  const row = {
    session_id: sessionId, status: 'ended', created_at: '2026-10-01T00:00:00Z',
    started_at: '2026-10-01T00:01:00Z', ended_at: '2026-10-01T01:00:00Z',
    expires_at: '2026-10-01T02:00:00Z', personal_data_delete_at: '2026-10-02T01:00:00Z',
    retention_purged_at: '2026-10-02T01:00:01Z', server_time: '2026-10-02T01:01:00Z',
    response_count: 0, participant_count: 0, named_participant_count: 0,
    token_participant_count: 0, archived_event_count: 1,
    archived_room_ended_count: 1, archived_room_ended_at: '2026-10-01T00:59:59Z',
  };
  fake.replies.set('retention_status', [row]);
  assert.deepEqual(await client.call('retention_status', { p_session_id: sessionId }), { ok: true, data: [row] });
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.requests[0].args, { p_session_id: sessionId });
  assert.equal((await client.call('retention_status', { p_session_id: sessionId, p_token: 'private' })).code, 'invalid_arguments');
  assert.equal(fake.requests.length, 1);
});
test('RPC credentials use apikey only, profiles and POST; untrusted names/arguments never reach fetch', async () => {
  const { client, fake, config } = make();
  assert.equal((await client.call('ping', {})).ok, true);
  const request = fake.requests[0];
  assert.equal(request.headers.get('apikey'), config.SUPABASE_SECRET_KEY);
  assert.equal(request.headers.has('authorization'), false);
  assert.equal(request.headers.get('content-profile'), 'case_api'); assert.equal(request.headers.get('accept-profile'), 'case_api');
  assert.equal(request.headers.get('content-type'), 'application/json'); assert.equal(request.redirect, 'manual');
  assert.equal(request.url, 'https://postgrest.test/rest/v1/rpc/ping'); assert.equal(request.url.includes(config.SUPABASE_SECRET_KEY), false);
  assert.equal((await client.call('ping?token=private', {})).code, 'invalid_rpc');
  assert.equal((await client.call('create_session', {})).code, 'invalid_arguments');
  assert.equal((await client.call('ping', { token: 'private' })).code, 'invalid_arguments'); assert.equal(fake.requests.length, 1);
  for (const url of ['http://postgrest.test', 'https://name:password@postgrest.test', 'https://postgrest.test?token=x']) assert.throws(() => rpcClient({ ...config, SUPABASE_URL: url }, { fetchImpl: fake.fetchImpl }), /Invalid RPC configuration/);
});
test('RPC rejects a redirect without forwarding its service key or reading the target', async () => {
  const calls = [];
  const client = rpcClient(env(), { fetchImpl: async (_url, init) => {
    calls.push(init);
    return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
  } });
  assert.deepEqual(await client.call('ping', {}),
    { ok: false, kind: 'unavailable', status: 503, code: 'redirect' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual');
});
test('paired Builder draft RPC has the document response bound, including authoring metadata', async () => {
  const { client, fake } = make();
  const user = uuidv7(), caseId = uuidv7();
  const largeText = 'x'.repeat(1_100_000);
  fake.replies.set('builder_get_draft', [{ revision: 3, schema_version: 2,
    document: { schema_version: 2, payload: largeText }, authoring_metadata: { metadata_version: 1, sources: [], provenance: [] },
    updated_at: '2026-10-09T00:00:00Z', intent_digest: `\\x${'c'.repeat(64)}` }]);
  const result = await client.call('builder_get_draft', { p_case_id: caseId, p_user_id: user, p_admin: false, p_admin_email: null });
  assert.equal(result.ok, true);
  assert.equal(result.data[0].document.payload.length, largeText.length);
});
test('RPC maps every failure kind and paused projects without exposing bodies or retrying', async () => {
  const { client, fake } = make();
  const rows = [[409,'40001','conflict',409],[409,'40P01','conflict',409],[500,'40P01','conflict',409],[403,'42501','forbidden',500],[409,'23505','unique',409],[404,'PGRST202','not_found',404],[400,'22023','bad_request',400],[503,null,'unavailable',503],[540,null,'unavailable',503],[500,null,'unavailable',503]];
  for (const [status, code, kind, mapped] of rows) {
    fake.faults.push({ status, code, message: 'private input echoed' });
    assert.deepEqual(await client.call('ping', {}), { ok: false, kind, status: mapped, code });
  }
  assert.equal(fake.requests.length, rows.length);
  const network = rpcClient(env(), { fetchImpl: async () => { throw new Error('private exception'); } });
  assert.deepEqual(await network.call('ping', {}), { ok: false, kind: 'unavailable', status: 503, code: 'network' });
});
test('RPC timeout covers fetch and response body even if injected fetch ignores abort', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('[')); } }))]) {
    const start = Date.now(); const result = await rpcClient(env(), { fetchImpl, timeoutMs: 15 }).call('ping', {});
    assert.deepEqual(result, { ok: false, kind: 'unavailable', status: 503, code: 'timeout' }); assert.ok(Date.now() - start < 500);
  }
});
test('RPC alert hooks receive sanitized metadata and cannot replace or delay forbidden results', async () => {
  const fake = fakePostgrest(), seen = [];
  const client = rpcClient(env(), { fetchImpl: fake.fetchImpl, timeoutMs: 15, onAlert: meta => { seen.push(meta); throw new Error('private hook error'); } });
  fake.faults.push({ status: 403, code: '42501', message: 'private content' });
  assert.deepEqual(await client.call('ping', {}), { ok: false, kind: 'forbidden', status: 500, code: '42501' });
  assert.deepEqual(seen, [{ kind: 'forbidden', code: '42501', name: 'ping' }]);
  fake.faults.push({ status: 400, code: 'private echoed input' }); assert.equal((await client.call('ping', {})).code, null); assert.equal(seen.length, 1);
  fake.faults.push({ status: 403, code: '42501' });
  const stalled = rpcClient(env(), { fetchImpl: fake.fetchImpl, timeoutMs: 15, onAlert: () => new Promise(() => {}) });
  const start = Date.now(); assert.equal((await stalled.call('ping', {})).kind, 'forbidden'); assert.ok(Date.now() - start < 500);
  fake.faults.push({ status: 403, code: '42501' });
  const rejected = rpcClient(env(), { fetchImpl: fake.fetchImpl, onAlert: async () => { throw new Error('private rejection'); } });
  assert.equal((await rejected.call('ping', {})).kind, 'forbidden');
  await new Promise(resolve => setTimeout(resolve, 0));
});
test('[AS-073] RPC pages 250 published versions and alerts once using their distinct SQL cursor fields', async () => {
  const versions = [], alerts = [], user = uuidv7(), workspace = uuidv7();
  for (let n=0;n<250;n++) {
    const id = uuidv7(), time = new Date(1000 + Math.floor(n/5)*1000).toISOString();
    versions.push({ version_id:id,case_id:uuidv7(),title:'Case',version_no:n+1,published_at:time,content_sha256:'\\x00' });
    alerts.push({ id,at:time,detail:'Privilege removed' });
  }
  const fake = fakePostgrest({ versions, alerts }), client = rpcClient(env(), { fetchImpl: fake.fetchImpl });
  for (const [name,args,field] of [['list_published_versions',{p_user_id:user,p_workspace_id:workspace,p_admin:false,p_admin_email:null},'version_id'],['lockdown_alerts_since',{p_since:new Date(0).toISOString()},'id']]) {
    const rows = []; for await (const row of client.page(name,args,{limit:100})) rows.push(row);
    assert.equal(rows.length,250); assert.equal(new Set(rows.map(row=>row[field])).size,250);
  }
  assert.equal(fake.requests.length,6);
  assert.equal(fake.requests[1].args.p_after,fake.requests[0].name==='list_published_versions' ? [...versions].sort((a,b)=>b.published_at.localeCompare(a.published_at)||b.version_id.localeCompare(a.version_id))[99].version_id : null);
});
test('RPC paging refuses truncation, malformed/repeated cursors and mapped errors without leaking data', async () => {
  const { client,fake }=make();
  fake.replies.set('heartbeats', Array(1000).fill({job:'keepalive',ran_at:'x',rows:0}));
  const drain = async iterator => { const rows=[];for await(const row of iterator)rows.push(row);return rows; };
  await assert.rejects(drain(client.page('heartbeats',{},{})), e => e instanceof RpcPageError && e.code==='cursor_required');
  const args={p_user_id:uuidv7(),p_workspace_id:uuidv7(),p_admin:false,p_admin_email:null};
  fake.replies.set('list_published_versions',[{version_id:uuidv7()}]);
  await assert.rejects(drain(client.page('list_published_versions',args,{limit:1})),e=>e.code==='invalid_page');
  fake.replies.set('list_published_versions',[{id:uuidv7()}]);
  await assert.rejects(drain(client.page('list_published_versions',args,{limit:1})),e=>e.code==='invalid_page');
  fake.faults.push({status:400,code:'22023',message:'private input'});
  await assert.rejects(drain(client.page('list_published_versions',args,{limit:1})),e=>e.kind==='bad_request'&&!e.message.includes('private'));
  fake.replies.set('heartbeats',[{job:'keepalive',ran_at:'x',rows:0}]);assert.equal((await drain(client.page('heartbeats',{},{}))).length,1);
});
test('contract fake refuses every non-fake host and missing/extra SQL argument names', async () => {
  const fake=fakePostgrest();
  const headers={'content-profile':'case_api','accept-profile':'case_api'};
  await assert.rejects(fake.fetchImpl('https://forbidden.test/rest/v1/rpc/ping',{method:'POST',headers,body:'{}'}),/Non-fake host refused/);
  assert.equal((await fake.fetchImpl('https://postgrest.test/rest/v1/rpc/create_session',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fake.fetchImpl('https://postgrest.test/rest/v1/rpc/ping',{method:'POST',headers,body:'{"private":1}'})).status,404);
  for (const name of ['toString', '__proto__', 'constructor']) {
    assert.equal((await fake.fetchImpl(`https://postgrest.test/rest/v1/rpc/${name}`,{method:'POST',headers,body:'{}'})).status,404);
  }
});
