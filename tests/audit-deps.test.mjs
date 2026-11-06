import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { evaluateAudit } from '../scripts/audit-deps.mjs';

// Reduced, recorded shape of npm audit --json from 2026-10-01. The report names
// an advisory at sharp and inherited high severity at miniflare and the pool.
const advisory = 'GHSA-rgj7-g3m4-5g8c';
const path = '@cloudflare/vitest-pool-workers > miniflare > sharp';
const audit = {
  vulnerabilities: {
    '@cloudflare/vitest-pool-workers': {
      severity: 'high', via: ['miniflare'], nodes: ['node_modules/@cloudflare/vitest-pool-workers'],
    },
    miniflare: { severity: 'high', via: ['sharp'], nodes: ['node_modules/miniflare'] },
    sharp: {
      severity: 'high', nodes: ['node_modules/sharp'],
      via: [{ source: 1193725, name: 'sharp', severity: 'high', url: `https://github.com/advisories/${advisory}` }],
    },
  },
};
const lock = {
  packages: {
    '': { devDependencies: { '@cloudflare/vitest-pool-workers': '0.22.0' } },
    'node_modules/@cloudflare/vitest-pool-workers': { version: '0.22.0', dependencies: { miniflare: '5.20260815.0-alpha' } },
    'node_modules/miniflare': { version: '5.20260815.0-alpha', dependencies: { sharp: '0.35.2' } },
    'node_modules/sharp': { version: '0.35.2' },
  },
};
const manifest = { dependencies: {}, devDependencies: { '@cloudflare/vitest-pool-workers': '0.22.0' } };
const entry = {
  advisory, package: 'sharp', path,
  reason: 'dev-only via wrangler/miniflare; bump wrangler when upstream fixes',
  added: '2026-10-01', review_by: '2026-10-31',
};
const assess = (overrides = {}) => evaluateAudit({ audit, packageLock: lock, manifest, allowlist: [entry], today: '2026-10-01', ...overrides });

test('unlisted high advisory fails, while the exact dev-only advisory and path pass', () => {
  assert.equal(assess({ allowlist: [] }).ok, false);
  assert.equal(assess().ok, true);
});

test('expiry and review windows are enforced', () => {
  assert.equal(assess({ today: '2026-11-01' }).ok, false);
  assert.equal(assess({ allowlist: [{ ...entry, review_by: '2026-11-15' }] }).ok, false);
  assert.equal(assess({ allowlist: [{ ...entry, added: '2026-10-02' }] }).ok, false);
});

test('a matching advisory on a runtime dependency path fails', () => {
  const runtime = { dependencies: { '@cloudflare/vitest-pool-workers': '0.22.0' }, devDependencies: {} };
  assert.equal(assess({ manifest: runtime }).ok, false);
});

test('a root peer also reached through dev dependencies is a runtime path', () => {
  const peer = {
    dependencies: {},
    peerDependencies: { sharp: '0.35.2' },
    devDependencies: { '@cloudflare/vitest-pool-workers': '0.22.0' },
  };
  assert.equal(assess({ manifest: peer }).ok, false);
});

test('only explicitly optional missing root peers may be absent', () => {
  const peer = {
    ...manifest,
    peerDependencies: { 'missing-peer': '1.0.0' },
    peerDependenciesMeta: { 'missing-peer': { optional: true } },
  };
  assert.equal(assess({ manifest: peer }).ok, true);
  assert.equal(assess({ manifest: { ...peer, peerDependenciesMeta: {} } }).ok, false);
});

test('a new advisory in the same package or a different path is not covered', () => {
  const next = structuredClone(audit);
  next.vulnerabilities.sharp.via.push({ source: 9999999, name: 'sharp', severity: 'high', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' });
  assert.equal(assess({ audit: next }).ok, false);
  assert.equal(assess({ allowlist: [{ ...entry, path: 'wrangler > miniflare > sharp' }] }).ok, false);
});

const directDev = [
  ['GHSA-rfgv-xxqx-mfg5', 'undici'],
  ['GHSA-w293-vg96-wgc3', 'undici'],
];
// The shipped allowlist is empty since 2026-10-30 (undici fixed by upgrade; GHSA-vfj7 withdrawn). These tests prove the
// exception logic on fixture entries in a valid window, so an expiring live entry can never be what keeps a test green.
const fixtureEntry = (advisory, packageName, path) => ({ advisory, package: packageName, path,
  reason: 'fixture: dev-only path for the exception logic', added: '2026-10-30', review_by: '2026-11-13' });

for (const [advisoryId, packageName] of directDev) {
  test(`direct dev Miniflare exception is exact for ${advisoryId} ${packageName}; other and runtime paths fail`, () => {
    const directPath = `miniflare > ${packageName}`;
    const recordedAudit = { vulnerabilities: {
      miniflare: { severity: 'high', via: [packageName], nodes: ['node_modules/miniflare'] },
      [packageName]: { severity: 'high', nodes: [`node_modules/${packageName}`],
        via: [{ source: 1234567, name: packageName, severity: 'high',
          url: `https://github.com/advisories/${advisoryId}` }] },
    } };
    const directLock = { packages: {
      '': { devDependencies: { miniflare: '5.20260815.0-alpha' } },
      'node_modules/miniflare': { version: '5.20260815.0-alpha', dependencies: { [packageName]: '1.0.0' } },
      [`node_modules/${packageName}`]: { version: '1.0.0' },
    } };
    const directManifest = { dependencies: {}, devDependencies: { miniflare: '5.20260815.0-alpha' } };
    const assessDirect = overrides => evaluateAudit({ audit: recordedAudit, packageLock: directLock,
      manifest: directManifest, allowlist: [fixtureEntry(advisoryId, packageName, directPath)], today: '2026-10-30', ...overrides });
    assert.equal(assessDirect().ok, true, `${directPath} should have only its approved dev exception`);
    assert.equal(assessDirect({ manifest: { dependencies: { miniflare: '5.20260815.0-alpha' }, devDependencies: {} } }).ok, false,
      'the same advisory must fail on a runtime path');
    const otherLock = structuredClone(directLock);
    otherLock.packages[''].devDependencies = { 'new-tool': '1.0.0' };
    otherLock.packages['node_modules/new-tool'] = { version: '1.0.0', dependencies: { miniflare: '5.20260815.0-alpha' } };
    assert.equal(assessDirect({ packageLock: otherLock,
      manifest: { dependencies: {}, devDependencies: { 'new-tool': '1.0.0' } } }).ok, false,
    'a new dev path must not inherit the direct-path exception');
  });
}

// Reduced npm advisory shape recorded on 2026-10-03 (GitHub withdrew the advisory on 2026-10-23); use the real pinned graph
// so adding a new route cannot silently inherit a stylelint exception.
const bracesAdvisory = 'GHSA-vfj7-8cjw-p6xm';
const bracesPaths = [
  'stylelint > fast-glob > micromatch > braces',
  'stylelint > globby > fast-glob > micromatch > braces',
  'stylelint > globby > micromatch > braces',
  'stylelint > micromatch > braces',
];
const pinnedLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const pinnedManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bracesAudit = { vulnerabilities: { braces: {
  severity: 'high', nodes: ['node_modules/braces'],
  via: [{ name: 'braces', severity: 'high', url: `https://github.com/advisories/${bracesAdvisory}` }],
} } };
const bracesAllowlist = bracesPaths.map(path => fixtureEntry(bracesAdvisory, 'braces', path));
const assessBraces = (overrides = {}) => evaluateAudit({ audit: bracesAudit,
  packageLock: pinnedLock, manifest: pinnedManifest, allowlist: bracesAllowlist,
  today: '2026-10-30', ...overrides });

for (const exactPath of bracesPaths) {
  test(`stylelint braces exception is exact, dev-only and expires for ${exactPath}`, () => {
    const accepted = assessBraces();
    assert.equal(accepted.ok, true, accepted.violations.join('\n'));
    assert.ok(accepted.allowed.includes(`${bracesAdvisory} braces at ${exactPath}`));
    const matching = bracesAllowlist.filter(row => row.advisory === bracesAdvisory && row.path === exactPath);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].review_by, '2026-11-13');
    assert.equal(assessBraces({ allowlist: bracesAllowlist.filter(row => !matching.includes(row)) }).ok, false);
    assert.equal(assessBraces({ today: '2026-11-14' }).ok, false);
    const runtime = structuredClone(pinnedManifest);
    runtime.dependencies = { stylelint: runtime.devDependencies.stylelint };
    delete runtime.devDependencies.stylelint;
    assert.equal(assessBraces({ manifest: runtime }).ok, false);
    const next = structuredClone(bracesAudit);
    next.vulnerabilities.braces.via[0].url = 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz';
    assert.equal(assessBraces({ audit: next }).ok, false);
  });
}


test('CLI cannot report a clean advisory audit when npm offline mode suppresses evidence', async () => {
  const {spawnSync} = await import('node:child_process');
  const script = new URL('../scripts/audit-deps.mjs', import.meta.url);
  const {fileURLToPath} = await import('node:url');
  for (const key of ['NPM_CONFIG_OFFLINE', 'npm_config_offline']) {
    const result = spawnSync(process.execPath, [fileURLToPath(script)], {
      env: {...process.env, NPM_CONFIG_OFFLINE: '', npm_config_offline: '', [key]: 'true'},
      encoding: 'utf8', timeout: 10000
    });
    assert.equal(result.status, 1, key + ' must fail closed instead of accepting an empty audit');
    assert.match(result.stderr, /offline.*advisory|advisory.*offline/i);
    assert.doesNotMatch(result.stdout, /Dependency audit passed/);
  }
});
