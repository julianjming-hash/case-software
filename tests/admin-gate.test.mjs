import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ROUTES, matchAdminRoute } from '../src/worker/admin/routes.mjs';
import { adminAuditPrefix, authorizeAdmin, checkAdminWrite } from '../src/worker/admin/gate.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const env = { ADMIN_EMAILS: 'admin@example.test, second@example.test' };
const request = (path, method = 'GET', headers = {}) => new Request(`https://case.invalid${path}`, {
  method, headers: { authorization: 'Bearer fake-jwt', ...headers },
});

test('Card 21a route table tags every recognised admin route and refuses unknown paths', () => {
  assert.ok(ADMIN_ROUTES.length >= 12);
  for (const route of ADMIN_ROUTES) {
    assert.equal(route.auth, 'admin');
    assert.equal(typeof route.template, 'string');
    assert.equal(matchAdminRoute(route.template.replace(':id', uuidv7()), route.method)?.key, route.key);
  }
  assert.equal(matchAdminRoute('/api/v1/admin/other', 'GET'), null);
  assert.equal(matchAdminRoute('/api/v1/admin/facilitators', 'DELETE'), null);
});

test('Card 21a admin gate requires a verified exact lowercase allowlisted email', async () => {
  const allowed = await authorizeAdmin(request('/api/v1/admin/audit'), { env,
    verifyUser: async () => ({ userId: 'caller', email: 'admin@example.test' }) });
  assert.equal(allowed.ok, true);
  for (const email of ['Admin@example.test', 'outsider@example.test', null]) {
    const denied = await authorizeAdmin(request('/api/v1/admin/audit'), { env,
      verifyUser: async () => ({ userId: 'caller', email }) });
    assert.deepEqual({ status: denied.status, error: denied.error }, { status: 403, error: 'forbidden' });
  }
  const absent = await authorizeAdmin(new Request('https://case.invalid/api/v1/admin/audit'), {
    env, verifyUser: async () => null });
  assert.deepEqual({ status: absent.status, error: absent.error }, { status: 401, error: 'unauthorised' });
});

test('Card 21a admin gate fails closed on malformed allowlist or unavailable verifier', async () => {
  const malformed = await authorizeAdmin(request('/api/v1/admin/audit'), {
    env: { ADMIN_EMAILS: 'Admin@example.test' },
    verifyUser: async () => ({ userId: 'caller', email: 'admin@example.test' }),
  });
  assert.equal(malformed.status, 403);
  const unavailable = await authorizeAdmin(request('/api/v1/admin/audit'), {
    env, verifyUser: async () => { throw new Error('upstream detail'); },
  });
  assert.deepEqual({ status: unavailable.status, error: unavailable.error },
    { status: 503, error: 'auth_unavailable' });
});

test('Card 21a admin writes require exact selected Origin and JSON content type', () => {
  const good = request('/api/v1/admin/facilitators/invite', 'POST', {
    origin: 'https://case.invalid', 'content-type': 'application/json; charset=utf-8',
  });
  assert.equal(checkAdminWrite(good, 'https://case.invalid').ok, true);
  assert.equal(checkAdminWrite(request('/api/v1/admin/facilitators/invite', 'POST', {
    origin: 'https://evil.invalid', 'content-type': 'application/json',
  }), 'https://case.invalid').status, 403);
  assert.equal(checkAdminWrite(request('/api/v1/admin/facilitators/invite', 'POST', {
    'content-type': 'application/json',
  }), 'https://case.invalid').status, 403);
  assert.equal(checkAdminWrite(request('/api/v1/admin/facilitators/invite', 'POST', {
    origin: 'https://case.invalid', 'content-type': 'text/plain',
  }), 'https://case.invalid').status, 415);
});

test('Card 21a audit prefixes retain only IPv4 /24 or IPv6 /64 and omit invalid input', () => {
  assert.equal(adminAuditPrefix('192.0.2.159'), '192.0.2.0/24');
  assert.equal(adminAuditPrefix('2001:0db8:abcd:1234:9876:5432:1000:0001'), '2001:db8:abcd:1234::/64');
  assert.equal(adminAuditPrefix('2001:db8::1'), '2001:db8:0:0::/64');
  for (const value of ['192.0.2.999', '192.0.2.1, 10.0.0.1', 'fe80::1%eth0',
    '::ffff:192.0.2.1', 'not-an-ip', null]) assert.equal(adminAuditPrefix(value), null);
});


test('Card 21a personal facilitator search is tagged POST JSON and never a GET URL query', () => {
  const route = matchAdminRoute('/api/v1/admin/facilitators/search', 'POST');
  assert.equal(route?.key, 'facilitators_search');
  assert.equal(route.auth, 'admin');
  assert.equal(matchAdminRoute('/api/v1/admin/facilitators/search', 'GET'), null);
});

test('Card 21a admin write refuses noncanonical configured origins even when header matches', () => {
  for (const origin of ['https://person@case.invalid', 'https://case.invalid:443', 'https://case.invalid\\evil']) {
    const request = new Request('https://case.invalid/api/v1/admin/stepup', {
      method:'POST',headers:{origin,'content-type':'application/json'},body:'{}',
    });
    assert.deepEqual(checkAdminWrite(request,origin),{ok:false,status:403,error:'forbidden'});
  }
  const origin='https://case.invalid';
  assert.deepEqual(checkAdminWrite(new Request(origin,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}),origin),{ok:true});
});
