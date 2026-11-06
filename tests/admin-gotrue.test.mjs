import test from 'node:test';
import assert from 'node:assert/strict';
import { gotrueAdminClient } from '../src/worker/admin/gotrue.mjs';
import { newCapabilityToken, uuidv7 } from '../src/shared/ids.mjs';

const origin = 'https://auth.invalid';
const config = { SUPABASE_URL: origin, SUPABASE_SECRET_KEY: `sb_secret_${newCapabilityToken()}` };
const fixedUrl = ({ operation, page, perPage }) => {
  if (operation !== 'users') throw Error('unexpected operation');
  const url = new URL('/auth/v1/admin/users', origin);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  return url.href;
};
const user = i => ({ id: uuidv7(),
  email: `u${i}@example.test`, invited_at: '2026-01-01T00:00:00Z',
  user_metadata: { private: 'never forwarded' } });

test('Card 21a GoTrue list reaches user 1001 through explicit bounded pages', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ users: page === 1 ? Array.from({ length: 1000 }, (_, i) => user(i + 1)) : [user(1001)] });
  };
  const client = gotrueAdminClient(config, { endpointUrl: fixedUrl, fetchImpl });
  const first = await client.listUsers({ page: 1, perPage: 1000 });
  const second = await client.listUsers({ page: first.nextPage, perPage: 1000 });
  assert.equal(first.users.length, 1000);
  assert.equal(second.users[0].email, 'u1001@example.test');
  assert.equal(second.nextPage, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.apikey, config.SUPABASE_SECRET_KEY);
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(JSON.stringify(first).includes('private'), false);
});

test('Card 21a GoTrue adapter uses the fixed shared Auth URL builder by default', async () => {
  const requests = [];
  const client = gotrueAdminClient(config, { fetchImpl: async url => {
    requests.push(url);
    return Response.json({ users: [] });
  } });
  assert.deepEqual(await client.listUsers({ page: 2, perPage: 17 }),
    { ok: true, users: [], nextPage: null });
  assert.deepEqual(requests,
    ['https://auth.invalid/auth/v1/admin/users?page=2&per_page=17']);
});

test('Card 21a GoTrue adapter refuses cross-origin URL and redirects without following secrets', async () => {
  let calls = 0;
  const crossOrigin = gotrueAdminClient(config, { endpointUrl: () => 'https://evil.invalid/auth/v1/admin/users',
    fetchImpl: async () => { calls++; return Response.json({ users: [] }); } });
  assert.equal((await crossOrigin.listUsers({ page: 1 })).kind, 'invalid_endpoint');
  assert.equal(calls, 0);
  let redirectMode;
  const redirect = gotrueAdminClient(config, { endpointUrl: fixedUrl,
    fetchImpl: async (_url, options) => { calls++; redirectMode = options.redirect;
      return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }); } });
  assert.deepEqual(await redirect.listUsers({ page: 1 }), { ok: false, kind: 'unavailable' });
  assert.equal(calls, 1);
  assert.equal(redirectMode, 'manual');
});

test('Card 21a GoTrue adapter bounds a stalled body and oversize private response', async () => {
  const stalled = gotrueAdminClient(config, { endpointUrl: fixedUrl, timeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })) });
  assert.deepEqual(await stalled.listUsers({ page: 1 }), { ok: false, kind: 'unavailable' });
  const huge = gotrueAdminClient(config, { endpointUrl: fixedUrl, maxBytes: 256,
    fetchImpl: async () => Response.json({ users: [user(1), user(2)] }) });
  assert.deepEqual(await huge.listUsers({ page: 1 }), { ok: false, kind: 'unavailable' });
});

test('Card 21a GoTrue adapter validates bounded page arguments before network', async () => {
  let calls = 0;
  const client = gotrueAdminClient(config, { endpointUrl: fixedUrl,
    fetchImpl: async () => { calls++; return Response.json({ users: [] }); } });
  assert.deepEqual(await client.listUsers({ page: 0 }), { ok: false, kind: 'bad_request' });
  assert.deepEqual(await client.listUsers({ page: 1, perPage: 1001 }), { ok: false, kind: 'bad_request' });
  assert.equal(calls, 0);
});

test('Card 21a GoTrue adapter discards private upstream error bodies', async () => {
  const privateMessage = 'internal user email and token must stay upstream';
  const client = gotrueAdminClient(config, { endpointUrl: fixedUrl,
    fetchImpl: async () => Response.json({ error: privateMessage }, { status: 400 }) });
  const result = await client.listUsers({ page: 1 });
  assert.deepEqual(result, { ok: false, kind: 'unavailable' });
  assert.equal(JSON.stringify(result).includes(privateMessage), false);
});

test('Card 21a GoTrue list cancels hostile error and redirect bodies without waiting', async () => {
  for (const status of [302, 503]) {
    let cancelled = 0;
    const client = gotrueAdminClient(config, { endpointUrl: fixedUrl, fetchImpl: async () =>
      new Response(new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { cancelled++; return new Promise(() => {}); },
      }), { status }) });
    assert.deepEqual(await client.listUsers({ page: 1 }), { ok: false, kind: 'unavailable' });
    await Promise.resolve();
    assert.equal(cancelled, 1);
  }
});

test('Card 21a GoTrue user read binds target and strips provider sessions and metadata', async () => {
  const target = user(12);
  const calls = [];
  const client = gotrueAdminClient(config, { fetchImpl: async (url, options) => {
    calls.push({url, options}); return Response.json({...target, access_token: 'private-access'});
  } });
  const result = await client.getUser(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, target.id);
  assert.equal(result.user.email, target.email);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(calls[0].url, `${origin}/auth/v1/admin/users/${target.id}`);
  assert.equal(calls[0].options.redirect, 'manual');
  const mismatch = gotrueAdminClient(config, { fetchImpl: async () => Response.json(user(13)) });
  assert.deepEqual(await mismatch.getUser(target.id), {ok:false, kind:'unavailable'});
});

test('Card 21a GoTrue hard delete treats 404 as completed and never retries ambiguous writes', async () => {
  const id = uuidv7();
  for (const [status, expected] of [[204, {ok:true}], [404, {ok:true}], [500, {ok:false, kind:'unknown_outcome'}], [302, {ok:false, kind:'unknown_outcome'}]]) {
    const calls = [];
    const client = gotrueAdminClient(config, { fetchImpl: async (url, options) => {
      calls.push({url, options});return new Response(null, {status});
    } });
    assert.deepEqual(await client.deleteUser(id), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${origin}/auth/v1/admin/users/${id}`);
    assert.equal(calls[0].options.method, 'DELETE');
    assert.equal(calls[0].options.redirect, 'manual');
  }
  let calls = 0;
  const stalled = gotrueAdminClient(config, {timeoutMs:20, fetchImpl: async () => {
    calls++;return new Promise(() => {});
  }});
  assert.deepEqual(await stalled.deleteUser(id), {ok:false, kind:'unknown_outcome'});
  assert.equal(calls, 1);
  assert.deepEqual(await stalled.deleteUser('../users'), {ok:false, kind:'bad_request'});
  assert.equal(calls, 1);
});

test('Card 21a invitation resend refuses confirmed targets and binds one-shot provider identity', async () => {
  const target = {id:uuidv7(), email:'invited@example.test', invitedAt:'2026-10-01T00:00:00Z', confirmedAt:null};
  const calls=[];
  let returnedId=target.id;
  const client=gotrueAdminClient(config,{caseOrigin:'https://case.invalid',fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json({id:returnedId,email:target.email,access_token:'private'});
  }});
  assert.deepEqual(await client.resendInvite({...target,confirmedAt:'2026-10-02T00:00:00Z'}),{ok:false,kind:'bad_request'});
  assert.equal(calls.length,0);
  assert.deepEqual(await client.resendInvite(target),{ok:true,userId:target.id});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://auth.invalid/auth/v1/invite?redirect_to=https%3A%2F%2Fcase.invalid%2F');
  assert.deepEqual(JSON.parse(calls[0].options.body),{email:target.email});
  returnedId=uuidv7();
  assert.deepEqual(await client.resendInvite(target),{ok:false,kind:'unknown_outcome'});
  assert.equal(calls.length,2);
});

test('Card 21a GoTrue ban update sends only bounded ban duration and binds provider target', async () => {
  const id=uuidv7();const calls=[];let returnedId=id;
  const client=gotrueAdminClient(config,{fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json({id:returnedId,email:'target@example.test',user_metadata:{private:'never'}});
  }});
  for(const banDuration of ['876000h','none']) {
    assert.equal((await client.updateUser(id,{banDuration})).ok,true);
    assert.equal(calls.at(-1).options.method,'PUT');
    assert.equal(calls.at(-1).options.redirect,'manual');
    assert.equal(calls.at(-1).url,`${origin}/auth/v1/admin/users/${id}`);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body),{ban_duration:banDuration});
  }
  for(const attributes of [{banDuration:'none',email:'other@example.test'},{banDuration:'876001h'},{banDuration:'-1h'},{banDuration:'none\n'}])
    assert.deepEqual(await client.updateUser(id,attributes),{ok:false,kind:'bad_request'});
  assert.equal(calls.length,2);
  returnedId=uuidv7();
  assert.deepEqual(await client.updateUser(id,{banDuration:'none'}),{ok:false,kind:'unknown_outcome'});
});

test('Card 21a invite lookup reaches existing user beyond first1000 without personal URL query',async()=>{
  const target=user(1001);const pages=[];
  const client=gotrueAdminClient(config,{fetchImpl:async url=>{
    const parsed=new URL(url);pages.push(parsed);
    return Response.json({users:Number(parsed.searchParams.get('page'))===1?Array.from({length:1000},(_,i)=>user(i)):[target]});
  }});
  const result=await client.findUserByEmail(target.email);
  assert.equal(result.ok,true);assert.equal(result.user.id,target.id);
  assert.deepEqual(pages.map(url=>url.searchParams.get('page')),['1','2']);
  assert.ok(pages.every(url=>[...url.searchParams.keys()].every(key=>['page','per_page'].includes(key))));
});

test('Card 21a invite lookup has finite page cap and whole-operation timeout without false absence',async()=>{
  const rows=Array.from({length:1000},(_,i)=>user(i));let calls=0;
  const capped=gotrueAdminClient(config,{fetchImpl:async()=>{calls++;return Response.json({users:rows});}});
  assert.deepEqual(await capped.findUserByEmail('absent@example.test'),{ok:false,kind:'inventory_incomplete'});
  assert.equal(calls,100);
  let stalledCalls=0;
  const stalled=gotrueAdminClient(config,{timeoutMs:20,fetchImpl:async()=>{stalledCalls++;return new Promise(()=>{});}});
  assert.deepEqual(await stalled.findUserByEmail('absent@example.test'),{ok:false,kind:'unavailable'});
  assert.equal(stalledCalls,1);
});

test('Card 21a ban compensation accepts exact bounded milliseconds without rounding or excess',async()=>{
 const id=uuidv7(),calls=[];
 const client=gotrueAdminClient(config,{fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({id,email:'target@example.test'});}});
 assert.equal((await client.updateUser(id,{banDuration:'1501ms'})).ok,true);
 assert.deepEqual(calls,[{ban_duration:'1501ms'}]);
 for(const banDuration of ['3153600000001ms','0ms','1ms\n','1.5ms','-1ms'])
  assert.deepEqual(await client.updateUser(id,{banDuration}),{ok:false,kind:'bad_request'});
 assert.equal(calls.length,1);
});
