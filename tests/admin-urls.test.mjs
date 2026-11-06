import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAuthUrl } from '../src/shared/urls.mjs';

const auth = 'https://auth.invalid';
const caseOrigin = 'https://case.invalid';

test('Card 21a fixed GoTrue URLs use supported paths and numeric-only paging', () => {
  assert.equal(adminAuthUrl(auth, 'users', { page: 2, perPage: 1000 }),
    'https://auth.invalid/auth/v1/admin/users?page=2&per_page=1000');
  assert.equal(adminAuthUrl(auth, 'invite', { redirectOrigin: caseOrigin }),
    'https://auth.invalid/auth/v1/invite?redirect_to=https%3A%2F%2Fcase.invalid%2F');
  assert.equal(adminAuthUrl(auth, 'otp'), 'https://auth.invalid/auth/v1/otp');
  assert.equal(adminAuthUrl(auth, 'verify'), 'https://auth.invalid/auth/v1/verify');
});

test('Card 21a fixed GoTrue URLs reject untrusted origins, operation and personal query fields', () => {
  assert.throws(() => adminAuthUrl('http://auth.invalid', 'users', { page: 1 }), TypeError);
  assert.throws(() => adminAuthUrl('https://person@auth.invalid', 'users', { page: 1 }), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'admin/invite'), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'users', { page: 1, email: 'private@example.test' }), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'users', { page: 0 }), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'users', { page: 1, perPage: 1001 }), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'invite', { redirectOrigin: 'https://evil.invalid/path' }), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'invite', { redirectOrigin: 'https://person@case.invalid' }), TypeError);
});

test('Card 21a user operations bind one canonical UUID to a fixed GoTrue path', () => {
  const userId = '019a0000-0000-7000-8000-000000000001';
  for (const operation of ['user_read', 'user_update', 'user_delete']) {
    assert.equal(adminAuthUrl(auth, operation, { userId }),
      `https://auth.invalid/auth/v1/admin/users/${userId}`);
    for (const invalid of ['../users', `${userId}?email=private@example.test`, '', userId.toUpperCase()]) {
      assert.throws(() => adminAuthUrl(auth, operation, { userId: invalid }), TypeError);
    }
    assert.throws(() => adminAuthUrl(auth, operation, { userId, email: 'private@example.test' }), TypeError);
  }
});

test('Card 21a invitation resend uses supported invite path and own-origin redirect only', () => {
  assert.equal(adminAuthUrl(auth, 'invite_resend', { redirectOrigin: caseOrigin }),
    'https://auth.invalid/auth/v1/invite?redirect_to=https%3A%2F%2Fcase.invalid%2F');
  assert.throws(() => adminAuthUrl(auth, 'invite_resend', { redirectOrigin: `${caseOrigin}/other` }), TypeError);
  assert.throws(() => adminAuthUrl(auth, 'invite_resend', { redirectOrigin: caseOrigin, email: 'private@example.test' }), TypeError);
});

test('Card 21a admin room cursor accepts only bounded canonical shard and matching code',async()=>{
 const {parseAdminRoomsCursor}=await import('../src/shared/urls.mjs');
 assert.deepEqual(parseAdminRoomsCursor(null),{shard:'0',afterCode:null});
 assert.deepEqual(parseAdminRoomsCursor('A'),{shard:'A',afterCode:null});
 assert.deepEqual(parseAdminRoomsCursor('A:A00001'),{shard:'A',afterCode:'A00001'});
 for(const value of ['I','A:B00001','A:A00001\n','a:a00001','A:person@example.test','A:A00001:extra'])assert.throws(()=>parseAdminRoomsCursor(value),TypeError);
});
