import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, testLifecycle, credentialKey } from '../src/client/transport.mjs';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';
const canonicalJoinCapability = value => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const client = fetchImpl => connect({role:'participant',api:'https://case.test',storage:null,persistentStorage:null,lifecycle:testLifecycle(),telemetryImpl:()=>{},fetchImpl});

test('participant join sends an optional challenge token only in JSON without changing the ordinary payload', async()=>{
 const requests=[];const link=client(async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return Response.json({error:'unknown_code'},{status:404});});
 try{
  const token=newCapabilityToken();await link.join('ABCDEF','Sam','shadows-01',token);await link.join('ABCDEF','Sam','shadows-01');
  const joinTokens=requests.map(row=>row.body.joinToken);
  assert.ok(joinTokens.every(canonicalJoinCapability));
  assert.equal(joinTokens[0]!==joinTokens[1],true,'independent invocations have distinct private retry capabilities');
  assert.ok(requests.every(row=>joinTokens.every(secret=>!row.url.includes(secret))));
  assert.deepEqual(requests.map(({body})=>{const {joinToken,...ordinary}=body;return ordinary;}),[{v:1,code:'ABCDEF',displayName:'Sam',avatarId:'shadows-01',turnstileToken:token},{v:1,code:'ABCDEF',displayName:'Sam',avatarId:'shadows-01'}]);
  assert.ok(requests.every(row=>!row.url.includes(token)&&!row.options.headers.authorization));
 }finally{link.close();}
});

test('participant join refuses malformed optional challenge tokens before fetching',async()=>{
 let fetched=0;const link=client(async()=>{fetched++;return Response.json({error:'unknown_code'},{status:404});});
 try{for(const token of ['',null,1,'x'.repeat(2049),'a\nb'])assert.deepEqual(await link.join('ABCDEF','Sam','shadows-01',token),{ok:false,error:'bad_turnstile_token'});assert.equal(fetched,0);}finally{link.close();}
});

test('participant join exposes only a bounded public key on challenge required and preserves fixed failure shapes',async()=>{
 let response;const link=client(async()=>Response.json(response.body,{status:response.status}));
 try{
  const key=newCapabilityToken();response={status:428,body:{error:'challenge_required',siteKey:key}};assert.deepEqual(await link.join('ABCDEF','Sam','shadows-01'),{ok:false,error:'challenge_required',siteKey:key});
  for(const siteKey of ['',null,'<invalid>','x'.repeat(129),'key\n']){response={status:428,body:{error:'challenge_required',siteKey}};assert.deepEqual(await link.join('ABCDEF','Sam','shadows-01'),{ok:false,error:'challenge_required'});}
  response={status:403,body:{error:'challenge_failed',siteKey:key}};assert.deepEqual(await link.join('ABCDEF','Sam','shadows-01'),{ok:false,error:'challenge_failed'});
 }finally{link.close();}
});

// Private caller capabilities use only finite local fetch/socket/storage fakes.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
function finiteClient(joinReply) {
  const storage = new MemoryStorage();
  const requests = [], urls = [], events = [];
  class Socket extends EventTarget {
    constructor(url) { super(); urls.push(String(url)); this.readyState = 0; }
    send() {}
    close() { this.readyState = 3; }
  }
  const link = connect({ role: 'participant', slot: 'join-proof', api: 'http://127.0.0.1:4197',
    persistentStorage: storage, storage: new MemoryStorage(), WebSocketImpl: Socket, lifecycle: testLifecycle(),
    telemetryImpl: event => { events.push(event); },
    fetchImpl: async (url, init = {}) => {
      urls.push(String(url));
      assert.equal(new URL(String(url)).pathname === '/api/v1/join', true, 'the finite fake handles only the public join request');
      assert.equal(init.method === 'POST', true, 'join remains a POST');
      const body = JSON.parse(init.body);
      requests.push({ body, headers: init.headers });
      return joinReply(body, requests.length);
    } });
  return { link, storage, requests, urls, events };
}
function accepted(body) {
  return new Response(JSON.stringify({ sessionId: uuidv7(), participantId: uuidv7(),
    token: body.joinToken ?? newCapabilityToken() }), { status: 201, headers: { 'content-type': 'application/json' } });
}
function assertPrivateBoundary(client, secrets) {
  assert.equal(client.urls.every(url => secrets.every(secret => typeof secret !== 'string' || !url.includes(secret))), true,
    'join capabilities stay out of every fetch and socket URL');
  assert.equal(JSON.stringify(client.events).includes('joinToken'), false, 'no join body enters telemetry');
  assert.equal(secrets.every(secret => typeof secret !== 'string' || !JSON.stringify(client.events).includes(secret)), true,
    'private join capabilities never enter telemetry');
  assert.equal(client.requests.every(row => !Object.hasOwn(row.headers, 'authorization')), true,
    'the public join route does not acquire an authorization header');
}

test('public join reuses one canonical private capability across its original network and server retries', async () => {
  const client = finiteClient((body, attempt) => {
    if (attempt === 1) throw new TypeError('finite_network_loss');
    if (attempt === 2) return new Response('{"error":"unavailable"}', { status: 503 });
    return accepted(body);
  });
  try {
    const result = await client.link.join('7K3QX9', 'Test Person', AVATAR_IDS[0], 'local-challenge');
    assert.equal(result.ok, true);
    assert.equal(client.requests.length, 3, 'all three existing attempts execute');
    const token = client.requests[0].body.joinToken;
    assert.equal(canonicalJoinCapability(token), true, 'a logical join has private retry authority before its first request');
    assert.equal(client.requests.every(row => row.body.joinToken === token), true, 'network and503 retries preserve identity');
    assert.equal(client.requests.every(row => row.body.turnstileToken === 'local-challenge'), true);
    assert.equal(client.requests.every(row => row.body.code === '7K3QX9' && row.body.displayName === 'Test Person' && row.body.avatarId === AVATAR_IDS[0]), true);
    assertPrivateBoundary(client, [token]);
    const saved = JSON.parse(client.storage.getItem(credentialKey('participant', 'join-proof')));
    assert.equal(saved.token === token, true, 'only normal admitted participant credential persistence begins after success');
    assert.equal(client.storage.length, 1, 'no extra retry-secret storage record is introduced');
  } finally { client.link.close(); }
});

test('independent public join invocations use fresh private capabilities even for the same name and avatar', async () => {
  const client = finiteClient(body => accepted(body));
  try {
    const first = await client.link.join('7K3QX9', 'Test Person', AVATAR_IDS[0]);
    client.link.forget();
    const second = await client.link.join('7K3QX9', 'Test Person', AVATAR_IDS[0]);
    assert.equal(first.ok && second.ok, true);
    assert.equal(client.requests.length, 2);
    const tokens = client.requests.map(row => row.body.joinToken);
    assert.equal(tokens.every(canonicalJoinCapability), true);
    assert.equal(tokens[0] !== tokens[1], true, 'separate people never share retry authority merely through matching labels');
    assert.equal(first.participantId !== second.participantId, true);
    assertPrivateBoundary(client, tokens);
  } finally { client.link.close(); }
});

test('public join refuses a successful response with a different capability before adopting or storing it', async () => {
  const client = finiteClient(() => accepted({ joinToken: newCapabilityToken() }));
  try {
    const result = await client.link.join('7K3QX9', 'Test Person', AVATAR_IDS[0]);
    assert.equal(result.ok, false, 'a201 cannot substitute a different authority');
    assert.equal(result.error === 'join_identity_mismatch', true);
    assert.equal(client.requests.length, 1, 'identity mismatch is terminal rather than a new join attempt');
    assert.equal(client.link.hasToken, false);
    assert.equal(client.link.sessionId, null);
    assert.equal(client.link.participantId, null);
    assert.equal(client.storage.length, 0, 'rejected authority never reaches persistent credential storage');
    assertPrivateBoundary(client, client.requests.map(row => row.body.joinToken));
  } finally { client.link.close(); }
});
