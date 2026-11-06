// Known-answer tests for the host isolation canaries. Loopback listeners only; no VM, privilege or network change.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APPROVED, buildTargets, serveCanaries, knownAnswer, positiveControls, verifyEvidence, answerLine } from '../scripts/case-network-canary.mjs';
import { GUEST_DNS } from '../scripts/case-macos-gate.mjs';

const TOOL = new URL('../scripts/case-network-canary.mjs', import.meta.url).pathname;
const SETUP = readFileSync(new URL('../scripts/setup-case-macos-vm.sh', import.meta.url), 'utf8');
const shellValue = name => SETUP.match(new RegExp(`^${name}=(.*)$`, 'm'))[1].replace(/^'|'$/g, '');
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'case-canary-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

const SPECS = [
  'host-gateway=192.168.64.1', 'host-lan=192.168.1.108', 'private-routes=10.250.0.1', 'private-routes=172.31.250.1',
  'linux-peer=192.168.5.2', 'ipv6-linklocal=fe80::1c2b:3cff:fe4d:5e6f%bridge100', 'ipv6-ula=fd00:ca5e::1', 'ipv6-global=2001:db8:ca5e::1'
];
const WITNESS = 'a'.repeat(32);
const targets = () => buildTargets({ specs: SPECS, port: 18443, guestInterface: 'en0', witness: WITNESS });

test('approved image, hosted reference, DNS and canary port agree with the setup script', () => {
  assert.equal(APPROVED.guestVersion, shellValue('APPROVED_GUEST_VERSION'));
  assert.equal(APPROVED.guestBuild, shellValue('APPROVED_GUEST_BUILD'));
  assert.equal(APPROVED.ipswSHA256, shellValue('APPROVED_IPSW_SHA256'));
  assert.equal(APPROVED.hostedReference, shellValue('HOSTED_REFERENCE'));
  assert.equal(GUEST_DNS, shellValue('GUEST_DNS_CSV'));
  assert.equal(shellValue('CANARY_PORT'), '18443');
});

test('targets keep the host bind address and give the guest its own link-local scope', () => {
  const value = targets();
  assert.equal(value.witness, WITNESS);
  assert.equal(value.targets.length, 8);
  assert.deepEqual(value.targets.find(target => target.label === 'ipv6-linklocal'), { label: 'ipv6-linklocal', host: 'fe80::1c2b:3cff:fe4d:5e6f%en0', port: 18443, bind: 'fe80::1c2b:3cff:fe4d:5e6f%bridge100' });
  assert.deepEqual(value.targets.find(target => target.label === 'host-lan'), { label: 'host-lan', host: '192.168.1.108', port: 18443, bind: '192.168.1.108' });
  assert.match(buildTargets({ specs: SPECS, port: 18443, guestInterface: 'en0' }).witness, /^[a-f0-9]{32}$/);
});

test('a target whose address is outside its class, or a missing class, is refused', () => {
  const swap = (label, address) => SPECS.map(spec => spec.startsWith(`${label}=`) ? `${label}=${address}` : spec);
  for (const [label, address] of [
    ['host-lan', '8.8.8.8'], ['host-gateway', '127.0.0.1'], ['private-routes', '192.0.2.1'], ['linux-peer', '100.64.0.1'],
    ['ipv6-ula', '2001:db8::1'], ['ipv6-global', 'fd00::1'], ['ipv6-global', 'fe80::1%bridge100'], ['ipv6-linklocal', 'fe80::1'],
    ['ipv6-linklocal', 'fd00::1%bridge100'], ['ipv6-ula', 'fd00::1%bridge100'], ['host-lan', '192.168.1.108;id']
  ]) assert.throws(() => buildTargets({ specs: swap(label, address), port: 18443, guestInterface: 'en0' }), /class/, `${label}=${address}`);
  assert.throws(() => buildTargets({ specs: SPECS.filter(spec => !spec.startsWith('linux-peer=')), port: 18443, guestInterface: 'en0' }), /missing network class/);
  assert.throws(() => buildTargets({ specs: [...SPECS, 'host-printer=192.168.1.9'], port: 18443, guestInterface: 'en0' }), /unknown canary label/);
  assert.throws(() => buildTargets({ specs: SPECS, port: 80, guestInterface: 'en0' }), /invalid canary address\/port/);
  for (const name of ['', 'en0;id', 'EN0', 'en0%']) assert.throws(() => buildTargets({ specs: SPECS, port: 18443, guestInterface: name }), /guest interface/);
});

test('served canaries answer the host with the witness and log every connection', async t => {
  const dir = tempDir(t); const log = join(dir, 'log.jsonl');
  const port = await freePort();
  // Loopback stands in for the bridge addresses; validation of real classes is tested above.
  const value = { witness: WITNESS, targets: [{ label: 'host-gateway', host: '127.0.0.1', bind: '127.0.0.1', port }, { label: 'host-lan', host: '127.0.0.1', bind: '127.0.0.1', port }] };
  const servers = await serveCanaries(value, log);
  t.after(() => servers.forEach(server => server.close()));
  assert.equal(servers.length, 1, 'one listener per distinct address');
  const report = await positiveControls(value);
  assert.equal(report.allAnswered, true, JSON.stringify(report));
  assert.equal(report.witness, WITNESS);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  const wrong = await knownAnswer(value.targets[0], 'b'.repeat(32));
  assert.equal(wrong.answered, false, 'a different witness is not this run\'s canary');
  const closed = await knownAnswer({ label: 'host-lan', bind: '127.0.0.1', port: await freePort() }, WITNESS);
  assert.equal(closed.answered, false); assert.equal(closed.detail, 'ECONNREFUSED');
  assert.equal(answerLine(WITNESS), `case-canary ${WITNESS}\n`);
});

test('a canary that cannot bind stops the whole set', async t => {
  const dir = tempDir(t);
  const port = await freePort();
  const value = { witness: WITNESS, targets: [{ label: 'host-gateway', host: '127.0.0.1', port }, { label: 'host-lan', host: '192.0.2.1', port }] };
  await assert.rejects(serveCanaries(value, join(dir, 'log.jsonl')), /EADDRNOTAVAIL|EINVAL/);
  // The loopback listener that did start was closed again.
  assert.equal((await knownAnswer(value.targets[0], WITNESS)).detail, 'ECONNREFUSED');
});

const good = () => {
  const value = targets();
  const control = () => ({ witness: WITNESS, results: value.targets.map(target => ({ label: target.label, bind: target.bind, port: target.port, answered: true, detail: 'answer' })), allAnswered: true });
  const probe = (uid, outcome = 'ETIMEDOUT') => ({
    witness: WITNESS, uid, negativesPassed: true, dnsServers: GUEST_DNS, sharedMounts: [], guestVersion: '27.0.1', guestBuild: '26A434',
    publicTLS: { 'github.com': true, 'registry.npmjs.org': true },
    results: value.targets.map(target => ({ ...target, outcome: target.label.startsWith('ipv6-') ? 'ENETUNREACH' : outcome, blocked: true }))
  });
  const log = [...value.targets, ...value.targets].map(target => JSON.stringify({ bind: target.bind, port: target.port, peer: target.bind })).join('\n') + '\n';
  return { targets: value, before: control(), after: control(), root: probe(0), runner: probe(501, 'EHOSTUNREACH'), log, routerPublicIP: '203.0.114.7', attestCleanBase: true };
};

test('verify writes the exact owner evidence only when every control passes', () => {
  const result = verifyEvidence(good());
  assert.deepEqual(result.failures, []);
  const guest = {
    root: 'passed', runner: 'passed', positiveControls: 'passed', ipv6: 'passed', mounts: 'passed',
    guestVersion: '27.0.1', guestBuild: '26A434', ipswSHA256: APPROVED.ipswSHA256, dnsServers: '1.1.1.1,9.9.9.9', routerPublicIP: '203.0.114.7', witness: WITNESS
  };
  assert.deepEqual(result.guest, guest);
  assert.deepEqual(result.host, { ...guest, cleanBaseUnregistered: true, hostedReference: '39100396720/117595552764' });
  assert.equal(verifyEvidence({ ...good(), attestCleanBase: false }).host, null, 'no host attestation unless the owner gives it');
});

test('verify refuses every broken control, trusting raw outcomes rather than a report\'s flag', () => {
  const cases = {
    'a connected guest probe': v => { v.runner.results[0].outcome = 'CONNECTED'; },
    'a refused connection, which reached a host': v => { v.root.results[1].outcome = 'ECONNREFUSED'; },
    'a blocked flag over a connected outcome': v => { v.root.results[2].outcome = 'CONNECTED'; v.root.results[2].blocked = true; },
    'a target the runner skipped': v => { v.runner.results.pop(); },
    'a stale witness': v => { v.root.witness = 'b'.repeat(32); },
    'an extra canary connection': v => { v.log += `${JSON.stringify({ bind: '192.168.64.1', port: 18443, peer: '192.168.64.2' })}\n`; },
    'a connection at an unknown address': v => { v.log = v.log.replace('"bind":"10.250.0.1"', '"bind":"10.9.9.9"'); },
    'a canary that did not answer before': v => { v.before.results[3].answered = false; },
    'a missing after control': v => { v.after.results = v.after.results.slice(1); },
    'a root probe that ran unprivileged': v => { v.root.uid = 501; },
    'a runner probe that ran as root': v => { v.runner.uid = 0; },
    'the gateway resolver': v => { v.runner.dnsServers = '192.168.64.1'; },
    'a shared mount': v => { v.root.sharedMounts = ['host:/x on /mnt (nfs)']; },
    'an unreported mount check': v => { delete v.runner.sharedMounts; },
    'failed public TLS': v => { v.runner.publicTLS['registry.npmjs.org'] = false; },
    'an unapproved guest build': v => { v.root.guestBuild = '25G83'; },
    'no router address': v => { v.routerPublicIP = ''; }
  };
  for (const [name, change] of Object.entries(cases)) {
    const value = good(); change(value);
    const result = verifyEvidence(value);
    assert.ok(result.failures.length > 0, name);
    assert.equal(result.guest, undefined, name);
  }
});

test('the evidence passes the setup script\'s own evidence check', { skip: process.platform !== 'darwin' }, t => {
  const dir = tempDir(t);
  const fn = name => `${name}() {\n${SETUP.split(`\n${name}() {\n`)[1].split('\n}\n')[0]}\n}\n`;
  const constants = SETUP.split('\n').filter(line => /^(APPROVED_[A-Z0-9_]+|GUEST_DNS(_CSV)?|HOSTED_REFERENCE)=/.test(line)).join('\n');
  const { guest, host } = verifyEvidence(good());
  for (const [name, value] of Object.entries({ guest, host })) {
    const path = join(dir, `${name}.json`); writeFileSync(path, JSON.stringify(value));
    const extra = name === 'host' ? `[ "$(plutil -extract cleanBaseUnregistered raw -o - '${path}')" = true ] && [ "$(plutil -extract hostedReference raw -o - '${path}')" = "$HOSTED_REFERENCE" ]` : ':';
    const result = spawnSync('/bin/bash', [], { encoding: 'utf8', input: `set -euo pipefail\n${constants}\ndie(){ echo "$*" >&2; exit 9; }\n${['ipv4_octets', 'public_ipv4', 'check_evidence'].map(fn).join('\n')}\ncheck_evidence '${path}'\n${extra}\necho ok\n` });
    assert.equal(result.stdout, 'ok\n', `${name}: ${result.stderr}`);
  }
});

test('the CLI keeps a run\'s targets and writes no evidence when verification fails', t => {
  const dir = tempDir(t);
  const cli = args => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  const out = join(dir, 'targets.json');
  const made = cli(['targets', '--out', out, '--port', '18443', '--guest-interface', 'en0', ...SPECS.flatMap(spec => ['--target', spec])]);
  assert.equal(made.status, 0, made.stderr);
  const again = cli(['targets', '--out', out, '--port', '18443', '--guest-interface', 'en0', ...SPECS.flatMap(spec => ['--target', spec])]);
  assert.notEqual(again.status, 0, 'a second targets run would replace the witness');
  const value = good(); value.targets = JSON.parse(readFileSync(out, 'utf8'));
  for (const name of ['before', 'after', 'root', 'runner']) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value[name]));
  writeFileSync(join(dir, 'log.jsonl'), value.log);
  const verify = cli(['verify', '--targets', out, ...['before', 'after', 'root', 'runner'].flatMap(name => [`--${name}`, join(dir, `${name}.json`)]), '--log', join(dir, 'log.jsonl'), '--router-ip', '203.0.114.7', '--attest-clean-base-unregistered', '--guest-out', join(dir, 'guest.json'), '--host-out', join(dir, 'host.json')]);
  assert.equal(verify.status, 78, 'fixture probes carry the old witness');
  assert.match(verify.stderr, /^FAIL .*witness/m);
  assert.equal(existsSync(join(dir, 'guest.json')) || existsSync(join(dir, 'host.json')), false);
  assert.notEqual(cli(['serve', '--targets', out, '--targets', out]).status, 0, 'duplicate option');
  assert.notEqual(cli(['unknown']).status, 0);
});
