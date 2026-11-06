// scripts/case-network-canary.mjs: owner-run known-answer TCP canaries for the macOS VM isolation proof.
// Runs on the HOST as the owner, never in CI or a job. Zero dependencies. The guest runs
// `case-macos-gate.mjs probe-network` against the same targets file; this tool serves those targets,
// checks them from the host before and after (positive controls), and turns the four results into the
// owner evidence that seal-guest and install-host-lifecycle read.
import { createServer, createConnection, isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateNetworkTargets, BLOCKED_OUTCOMES, GUEST_DNS } from './case-macos-gate.mjs';

// Pinned in scripts/setup-case-macos-vm.sh; tests/case-network-canary.test.mjs checks they agree.
export const APPROVED = Object.freeze({
  guestVersion: '27.0.1',
  guestBuild: '26A434',
  ipswSHA256: '2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1',
  hostedReference: '39100396720/117595552764'
});
const PUBLIC_TLS = ['github.com', 'registry.npmjs.org'];
const fail = reason => { throw new Error(reason); };
export const answerLine = witness => `case-canary ${witness}\n`;

// Address classes, so a target cannot claim a label its address does not belong to.
const v4 = address => address.split('.').map(Number);
const privateV4 = address => {
  const [a, b] = v4(address);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
const v6Head = address => parseInt(address.split('%')[0].split(':')[0] || '0', 16);
const CLASSES = {
  'host-gateway': address => isIP(address) === 4 && privateV4(address),
  'host-lan': address => isIP(address) === 4 && privateV4(address),
  'private-routes': address => isIP(address) === 4 && privateV4(address),
  'linux-peer': address => isIP(address) === 4 && privateV4(address),
  'ipv6-linklocal': address => isIP(address) === 6 && (v6Head(address) & 0xffc0) === 0xfe80 && address.includes('%'),
  'ipv6-ula': address => isIP(address) === 6 && (v6Head(address) & 0xfe00) === 0xfc00 && !address.includes('%'),
  'ipv6-global': address => isIP(address) === 6 && (v6Head(address) & 0xe000) === 0x2000 && !address.includes('%')
};

// specs are `label=host-side address`. The link-local target is reached from the guest on its own
// interface, so the guest-facing host keeps the address with the guest's scope; bind keeps the host's.
export function buildTargets({ specs, port, guestInterface, witness = randomBytes(16).toString('hex') }) {
  if (!/^[a-z][a-z0-9]{0,14}$/.test(guestInterface)) fail('invalid guest interface');
  if (!Number.isSafeInteger(port)) fail('invalid canary port');
  const targets = specs.map(spec => {
    const at = spec.indexOf('=');
    if (at < 1) fail('a target is label=address');
    const label = spec.slice(0, at), bind = spec.slice(at + 1);
    if (!Object.hasOwn(CLASSES, label)) fail(`unknown canary label ${label}`);
    if (!CLASSES[label](bind)) fail(`${label} address is not in its class`);
    const host = label === 'ipv6-linklocal' ? `${bind.split('%')[0]}%${guestInterface}` : bind;
    return { label, host, port, bind };
  });
  return validateNetworkTargets({ witness, targets });
}

const endpoint = target => `${target.bind ?? target.host}|${target.port}`;
const uniqueBinds = targets => [...new Map(targets.targets.map(target => [endpoint(target), target])).values()];

// One listener per distinct host address. Every accepted connection is logged, so a guest connection
// that got through shows up even if the guest's own probe misreported it.
export function serveCanaries(targets, log) {
  const servers = [];
  const listen = target => new Promise((resolve, reject) => {
    const server = createServer(socket => {
      appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), bind: target.bind ?? target.host, port: target.port, peer: socket.remoteAddress })}\n`);
      socket.on('error', () => {});
      socket.end(answerLine(targets.witness));
    });
    server.once('error', reject);
    server.listen({ host: target.bind ?? target.host, port: target.port, exclusive: true }, () => { servers.push(server); resolve(); });
  });
  // Settle every listen first, so a listener that starts after another fails is closed too.
  return Promise.allSettled(uniqueBinds(targets).map(listen)).then(outcomes => {
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (!failed) return servers;
    for (const server of servers) server.close();
    throw failed.reason;
  });
}

export function knownAnswer(target, witness, timeout = 3000) {
  return new Promise(resolve => {
    let data = '', settled = false;
    const done = detail => { if (settled) return; settled = true; socket.destroy(); resolve({ label: target.label, bind: target.bind ?? target.host, port: target.port, answered: data === answerLine(witness), detail }); };
    const socket = createConnection({ host: target.bind ?? target.host, port: target.port });
    socket.setTimeout(timeout, () => done('ETIMEDOUT'));
    socket.on('data', chunk => { data += chunk.toString('utf8'); if (data.length > 256) done('oversized'); });
    socket.on('end', () => done('answer'));
    socket.on('error', error => done(error.code || 'UNKNOWN'));
  });
}

// Positive control: every canary answers the host with this run's witness, so a guest timeout means
// blocked rather than a dead listener.
export async function positiveControls(targets) {
  const results = [];
  for (const target of targets.targets) results.push(await knownAnswer(target, targets.witness));
  return { witness: targets.witness, at: new Date().toISOString(), results, allAnswered: results.every(result => result.answered) };
}

const key = result => `${result.label}|${result.host}|${result.port}`;
// Recomputes "blocked" from the raw outcome: a report's own flag is not trusted.
const blocked = result => BLOCKED_OUTCOMES.includes(result.outcome);

export function verifyEvidence({ targets, before, after, root, runner, log, routerPublicIP, attestCleanBase = false }) {
  const failures = [];
  const expect = (condition, reason) => { if (!condition) failures.push(reason); };
  validateNetworkTargets(targets);
  for (const [name, report] of Object.entries({ before, after, root, runner })) expect(report?.witness === targets.witness, `${name}: witness differs from this run's targets`);
  const binds = new Set(targets.targets.map(endpoint));
  for (const [name, control] of Object.entries({ before, after })) {
    const answered = new Set((control?.results ?? []).filter(result => result.answered).map(result => `${result.bind}|${result.port}`));
    expect(control?.results?.length === targets.targets.length && [...binds].every(bind => answered.has(bind)), `${name}: not every canary answered the host`);
  }
  // Exactly the host's own positive-control connections: anything else reached a canary.
  const entries = log.split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(entries.length === (before?.results?.length ?? 0) + (after?.results?.length ?? 0), `canary log: ${entries.length} connections, expected only the host's positive controls`);
  expect(entries.every(entry => binds.has(`${entry.bind}|${entry.port}`)), 'canary log: connection at an unknown address');
  const wanted = targets.targets.map(key).sort().join('\n');
  for (const [name, report] of Object.entries({ root, runner })) {
    const results = report?.results ?? [];
    expect(results.map(key).sort().join('\n') === wanted, `${name}: probe did not test exactly this run's targets`);
    for (const result of results) expect(blocked(result), `${name}: ${result.label} ${result.host} was ${result.outcome}, not blocked`);
    expect(PUBLIC_TLS.every(host => report?.publicTLS?.[host] === true), `${name}: public TLS control failed`);
    expect(report?.dnsServers === GUEST_DNS, `${name}: DNS ${report?.dnsServers} is not ${GUEST_DNS}`);
    expect(Array.isArray(report?.sharedMounts) && report.sharedMounts.length === 0, `${name}: shared mount present or unreported`);
    expect(report?.guestVersion === APPROVED.guestVersion && report?.guestBuild === APPROVED.guestBuild, `${name}: guest is not the approved ${APPROVED.guestVersion}/${APPROVED.guestBuild}`);
  }
  expect(root?.uid === 0, 'root: probe did not run as root');
  expect(Number.isSafeInteger(runner?.uid) && runner.uid !== 0, 'runner: probe did not run as the runner');
  expect(isIP(routerPublicIP ?? '') === 4, 'routerPublicIP must be an IPv4 address');
  if (failures.length) return { failures };
  const guest = {
    root: 'passed', runner: 'passed', positiveControls: 'passed', ipv6: 'passed', mounts: 'passed',
    guestVersion: APPROVED.guestVersion, guestBuild: APPROVED.guestBuild, ipswSHA256: APPROVED.ipswSHA256,
    dnsServers: GUEST_DNS, routerPublicIP, witness: targets.witness
  };
  const host = attestCleanBase ? { ...guest, cleanBaseUnregistered: true, hostedReference: APPROVED.hostedReference } : null;
  return { failures, guest, host };
}

function options(args, repeatable = []) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--attest-clean-base-unregistered') { parsed.attest = true; continue; }
    if (!name.startsWith('--') || i + 1 >= args.length) fail(`unexpected argument ${name}`);
    const value = args[++i], field = name.slice(2);
    if (repeatable.includes(field)) (parsed[field] ??= []).push(value);
    else if (Object.hasOwn(parsed, field)) fail(`duplicate ${name}`);
    else parsed[field] = value;
  }
  return parsed;
}
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJSON = (path, value, flag = 'w') => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o644 });

async function main([command, ...rest]) {
  if (command === 'targets') {
    const o = options(rest, ['target']);
    const targets = buildTargets({ specs: o.target ?? [], port: Number(o.port), guestInterface: o['guest-interface'] ?? '' });
    writeJSON(o.out, targets, 'wx');
    process.stdout.write(`${JSON.stringify(targets, null, 2)}\n`);
    return;
  }
  if (command === 'serve') {
    const o = options(rest);
    const targets = validateNetworkTargets(readJSON(o.targets));
    await serveCanaries(targets, o.log);
    process.stdout.write(`serving ${uniqueBinds(targets).length} canaries; Ctrl-C or canary-down stops them\n`);
    return;
  }
  if (command === 'check') {
    const o = options(rest);
    const report = await positiveControls(validateNetworkTargets(readJSON(o.targets)));
    writeJSON(o.out, report);
    for (const result of report.results) process.stdout.write(`${result.answered ? 'ok  ' : 'FAIL'} ${result.label} ${result.bind}:${result.port} ${result.detail}\n`);
    if (!report.allAnswered) process.exitCode = 78;
    return;
  }
  if (command === 'verify') {
    const o = options(rest);
    const result = verifyEvidence({
      targets: readJSON(o.targets), before: readJSON(o.before), after: readJSON(o.after), root: readJSON(o.root), runner: readJSON(o.runner),
      log: readFileSync(o.log, 'utf8'), routerPublicIP: o['router-ip'], attestCleanBase: o.attest === true
    });
    if (result.failures.length) {
      for (const reason of result.failures) process.stderr.write(`FAIL ${reason}\n`);
      process.exitCode = 78;
      return;
    }
    writeJSON(o['guest-out'], result.guest);
    if (result.host) writeJSON(o['host-out'], result.host);
    process.stdout.write('ISOLATION EVIDENCE PASSED: every canary answered the host before and after, and refused root and runner in the guest.\n');
    return;
  }
  fail('usage: case-network-canary.mjs targets|serve|check|verify');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`STOPPED: ${error.message}\n`); process.exitCode = 78; });
}
