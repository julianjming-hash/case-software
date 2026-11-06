import {canonicalAppUrl} from '../src/shared/urls.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import {
  joinUrl, displayPairUrl, devicePairUrl, qrPayload, isQrAlphanumeric, parseRoute,
  caseUrl, caseNewUrl, caseEditUrl, caseEditViewUrl, caseEditSourceUrl, caseEditSourceViewUrl, caseMapUrl, caseVersionUrl, sessionUrl, apiPath, apiUrl, authApiUrl,
  httpsHref,
} from '../src/shared/urls.mjs';

// QR version 2, error-correction M holds 38 alphanumeric characters (ISO/IEC 18004 Table 7).
const QR_V2_M_ALNUM = 38;

test('join URL QR payload is alphanumeric and fits a version-2 QR at level M', () => {
  const p = qrPayload(joinUrl('7k3-qx9'));
  assert.equal(p, 'HTTPS://CASE.IATROGENIC.APP/J/7K3QX9');
  assert.ok(isQrAlphanumeric(p));
  assert.ok(p.length <= QR_V2_M_ALNUM, `${p.length} chars`);
});

test('pairing URL QR payloads are alphanumeric', () => {
  for (const u of [displayPairUrl('abcd2345'), devicePairUrl('ABCD-2345')]) {
    assert.ok(isQrAlphanumeric(qrPayload(u)));
  }
});

test('invalid codes are rejected when building', () => {
  assert.throws(() => joinUrl('7K3QX'));
  assert.throws(() => displayPairUrl('7K3QX9'));
});

test('short routes parse case-insensitively and normalise codes', () => {
  assert.deepEqual(parseRoute('HTTPS://CASE.IATROGENIC.APP/J/7K3QX9'), { route: 'join', code: '7K3QX9' });
  assert.deepEqual(parseRoute('/j/7k3-qx9'), { route: 'join', code: '7K3QX9' });
  assert.deepEqual(parseRoute('/d/abcd2345'), { route: 'display-pair', code: 'ABCD2345' });
  assert.deepEqual(parseRoute('/P/ABCD2345'), { route: 'device-pair', code: 'ABCD2345' });
  assert.equal(parseRoute('/J/BAD'), null);
});

test('app routes round-trip with UUIDs', () => {
  const c = uuidv7();
  const s = uuidv7();
  assert.deepEqual(parseRoute(caseNewUrl()), { route: 'case-new' });
  assert.deepEqual(parseRoute(caseUrl(c)), { route: 'case', caseId: c });
  assert.deepEqual(parseRoute(caseEditUrl(c)), { route: 'case-edit', caseId: c });
  assert.equal(caseEditViewUrl(c, 'editor'), caseEditUrl(c));
  for (const view of ['workflows', 'preview']) assert.deepEqual(parseRoute(caseEditViewUrl(c, view)), { route: 'case-edit', caseId: c, view });
  const source = { versionId: uuidv7(), versionNo: 4 };
  assert.deepEqual(parseRoute(caseEditSourceUrl(c, source)), { route: 'case-edit', caseId: c, sourceVersion: source });
  for (const view of ['workflows', 'preview']) assert.deepEqual(parseRoute(caseEditSourceViewUrl(c, source, view)), { route: 'case-edit', caseId: c, sourceVersion: source, view });
  assert.throws(() => caseEditViewUrl(c, 'unknown'), TypeError);
  assert.deepEqual(parseRoute(caseMapUrl(c)), { route: 'case-map', caseId: c });
  assert.deepEqual(parseRoute(caseVersionUrl(c, 3)), { route: 'case-version', caseId: c, versionNo: 3 });
  for (const role of ['facilitate', 'display', 'play', 'recap']) {
    assert.deepEqual(parseRoute(sessionUrl(s, role)), { route: role, sessionId: s });
  }
  assert.equal(parseRoute('/cases/not-a-uuid'), null);
  assert.throws(() => sessionUrl(s, 'admin'));
});

test('no URL builder accepts a token-shaped argument', () => {
  assert.throws(() => caseUrl('eyJhbGciOiJIUzI1NiJ9'));
});

test('api paths are versioned and encoded', () => {
  assert.equal(apiPath('sessions', 'a b'), '/api/v1/sessions/a%20b');
});

test('[AS-079] Auth URLs use only fixed HTTPS GoTrue paths and a clean Case redirect', () => {
  assert.equal(apiUrl('https://case.test', 'config'), 'https://case.test/api/v1/config');
  assert.equal(authApiUrl('https://auth.test/', 'otp'), 'https://auth.test/auth/v1/otp');
  assert.equal(authApiUrl('https://auth.test/', 'refresh'), 'https://auth.test/auth/v1/token?grant_type=refresh_token');
  assert.equal(authApiUrl('https://auth.test/', 'otp', 'https://case.test/'),
    'https://auth.test/auth/v1/otp?redirect_to=https%3A%2F%2Fcase.test%2F');
  for (const origin of ['http://auth.test/', 'https://user:pass@auth.test/',
    'https://auth.test/rest/v1/', 'https://auth.test/?token=secret']) {
    assert.throws(() => authApiUrl(origin, 'otp'));
  }
  assert.throws(() => authApiUrl('https://auth.test/', 'rest'));
  assert.throws(() => authApiUrl('https://auth.test/', 'otp', 'https://case.test/?code=secret'));
  assert.throws(() => authApiUrl('https://auth.test/', 'verify', 'https://case.test/'));
});

// Julian's ruling (2026-10-17, briefing 3): authored URLs become links only when https, validated here.
test('authored links: https only, with a host and no credentials; anything else is refused', () => {
  assert.equal(httpsHref('https://example.org/a?b=1#c'), 'https://example.org/a?b=1#c');
  assert.equal(httpsHref('HTTPS://Example.org'), 'https://example.org/', 'the canonical href');
  for (const bad of ['http://example.org/', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@example.org/', 'https://user@example.org/', 'https:///x',
    'https://exa mple.org/', 'https://example.org/\nx', ' https://example.org/', 'ftp://example.org/', '//example.org/', '', null, 7, `https://e.org/${'x'.repeat(2000)}`])
    assert.equal(httpsHref(bad), null, String(bad));
});

// Participant feedback (CASE-284, D8): a short /F/<code> page that fits the same QR as Join and carries only the code.
test('feedback URL is a short /F path whose QR payload fits version 2 at level M', async () => {
  const { feedbackUrl } = await import('../src/shared/urls.mjs');
  assert.equal(feedbackUrl('7k3-qx9'), 'https://case.iatrogenic.app/F/7K3QX9');
  const payload = qrPayload(feedbackUrl('7K3QX9'));
  assert.equal(payload, 'HTTPS://CASE.IATROGENIC.APP/F/7K3QX9');
  assert.ok(isQrAlphanumeric(payload) && payload.length <= QR_V2_M_ALNUM);
  assert.throws(() => feedbackUrl('7K3QX'));
  assert.throws(() => feedbackUrl('not a code at all'));
  assert.equal(apiPath('feedback', '7K3QX9', 'mine'), '/api/v1/feedback/7K3QX9/mine'); // the code is the only path datum
  assert.equal(parseRoute('/F/7K3QX9'), null); // deliberately not a shared route: no other surface's bundle grows
});

test('legacy Admin HTML enters the canonical shared shell and strips former query/fragment state',()=>{assert.equal(canonicalAppUrl('https://case.iatrogenic.app/admin.html?legacy=1#old'),'https://case.iatrogenic.app/admin');assert.equal(canonicalAppUrl('https://case.iatrogenic.app/admin?legacy=1#old'),'https://case.iatrogenic.app/admin');});
