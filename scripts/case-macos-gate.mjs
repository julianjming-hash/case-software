// Root-owned macOS guest admission. No dependencies; uses the pinned runner's protected Node24.
// The native broker supplies kernel peer UID/PID. Client JSON never selects identity or role.
import { createServer, createConnection, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, chmodSync, chownSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = '/usr/local/libexec/case-macos-vm';
const STATE = '/private/var/db/case-macos-vm';
// Persistent and protected: macOS clears /private/var/run at boot, and it is root:daemon 0775 (CASE-300).
const PUBLIC = '/private/var/db/case-macos-vm-run/gate.sock';
const PRIVATE = `${STATE}/gate.sock`;
const PEER = `${LIB}/case-macos-peer`;
const WORKER = '/opt/actions-runner/bin/Runner.Worker';
const LISTENER = '/opt/actions-runner/bin/Runner.Listener';
const REGISTRATION = ['.runner', '.credentials', '.credentials_rsaparams'];
// Until a separate reviewed activation change widens it, only the manual qualification workflow on
// main may run here. The runner sets these from the job message before any step can run.
export const ADMITTED_WORKFLOW = Object.freeze({
  GITHUB_WORKFLOW_REF: 'julianjming-hash/case/.github/workflows/qualify-macos-vm.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main'
});
export const GUEST_DNS = '1.1.1.1,9.9.9.9';
// Only a dropped or unroutable connection is a block. ECONNREFUSED/EACCES mean a packet reached a host.
export const BLOCKED_OUTCOMES = Object.freeze(['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
const nonceOK = n => typeof n === 'string' && /^[a-f0-9]{32}$/.test(n);
const identity = p => `${p.pid}/${p.start}`;
const same = (a, b) => Boolean(a && b && identity(a) === identity(b));
const fail = reason => { throw new Error(reason); };

export class AdmissionGate {
  constructor({ boot, runnerUID, controlUID, generation = randomBytes(16).toString('hex'), processes = [] }) {
    this.boot = boot; this.runnerUID = runnerUID; this.controlUID = controlUID;
    this.generation = generation; this.mode = 'CLOSED'; this.hold = null;
    this.listener = null; this.starting = false; this.leases = new Map(); this.dirty = false; this.fault = null; this.pending = new Set(); this.residual = new Set();
    // Existing Workers after daemon restart are UNKNOWN until exit. Never reconstruct a parked ACK.
    this.unknown = new Set(processes.filter(p => p.uid === runnerUID && p.path === WORKER).map(identity));
    this.reconcile(processes);
  }
  attachListener(listener) {
    if (this.listener || this.leases.size || this.unknown.size || listener.uid !== this.runnerUID || listener.path !== LISTENER) fail('listener cannot be adopted');
    this.listener = listener;
    this.starting = false; this.residual.delete(identity(listener));
  }
  requestStart(peer) {
    if (peer.uid !== 0 && peer.uid !== this.controlUID) fail('management identity required');
    if (this.mode !== 'CLOSED' || this.fault || this.unknown.size || this.leases.size || this.dirty || this.residual.size) fail('closed idle reconciled guest required');
    if (!this.listener) this.starting = true;
    return { ...this.status(), starting: this.starting };
  }
  reconcile(processes) {
    if (processes.some(p => p.uid === this.runnerUID && !p.path)) { this.mode = 'CLOSED'; this.fault = 'runner process cannot be inspected'; }
    const live = new Map(processes.map(p => [identity(p), p]));
    for (const id of this.unknown) if (!live.has(id)) this.unknown.delete(id);
    for (const [id, lease] of this.leases) {
      if (!live.has(id)) { this.leases.delete(id); if (lease.phase === 'ACTIVE') this.dirty = true; }
      // A parked hook disappearing is not proof its Worker stopped executing.
      else if (lease.phase === 'PARKED' && !live.has(identity(lease.hook))) { this.unknown.add(id); this.leases.delete(id); }
    }
    this.pending.clear();
    for (const p of processes.filter(p => p.uid === this.runnerUID && p.path === WORKER)) {
      const id = identity(p);
      if (!this.leases.has(id) && (!this.listener || p.ppid !== this.listener.pid)) this.unknown.add(id);
      else if (!this.leases.has(id) && !this.unknown.has(id)) this.pending.add(id);
    }
    if (this.listener && !live.has(identity(this.listener))) { this.listener = null; this.mode = 'CLOSED'; this.fault = 'listener exited'; }
    const allowed = this.allowedPIDs(processes);
    this.residual = new Set(processes.filter(p => p.uid === this.runnerUID && !allowed.has(p.pid) && !this.unknown.has(identity(p))).map(identity));
  }
  allowedPIDs(processes) {
    const allowed = new Set(this.listener ? [this.listener.pid] : []);
    // Listener siblings/other descendants are NOT automatically allowed. Only managed Workers.
    for (const p of processes) if (this.leases.has(identity(p)) || this.pending.has(identity(p))) allowed.add(p.pid);
    const workerTree = new Set([...allowed].filter(pid => pid !== this.listener?.pid));
    for (let i = 0; i < 32; i++) for (const p of processes) if (workerTree.has(p.ppid)) workerTree.add(p.pid);
    for (const pid of workerTree) allowed.add(pid);
    return allowed;
  }
  workerFor(peer, processes) {
    if (peer.uid !== this.runnerUID) fail('runner identity required');
    const byPID = new Map(processes.map(p => [p.pid, p]));
    let p = byPID.get(peer.pid); const hook = p;
    if (!p || p.uid !== peer.uid || p.start !== peer.start) fail('peer process disappeared or reused');
    for (let depth = 0; depth < 32 && p; depth++, p = byPID.get(p.ppid)) {
      if (p.uid !== this.runnerUID) break;
      if (p.path === WORKER) {
        const parent = byPID.get(p.ppid);
        if (!same(parent, this.listener) || parent.path !== LISTENER || this.unknown.has(identity(p))) fail('untrusted Worker ancestry');
        return { worker: p, hook };
      }
    }
    fail('actual managed Worker ancestor required');
  }
  begin(peer, processes) {
    this.reconcile(processes);
    const { worker, hook } = this.workerFor(peer, processes); const id = identity(worker);
    let lease = this.leases.get(id);
    if (!lease) { lease = { worker, hook, phase: 'PARKED' }; this.leases.set(id, lease); this.pending.delete(id); }
    // An ACTIVE Worker cannot downgrade itself by repeating begin or notifying completion.
    if (lease.phase === 'PARKED' && this.mode === 'OPEN' && !this.dirty && !this.fault && !this.unknown.size && !this.residual.size &&
      ![...this.leases.values()].some(l => l.phase === 'ACTIVE')) lease.phase = 'ACTIVE';
    return { ...this.status(), admission: lease.phase === 'ACTIVE' ? 'GRANTED' : 'PARKED' };
  }
  control(peer, request, processes) {
    this.reconcile(processes);
    if (peer.uid !== 0 && peer.uid !== this.controlUID) fail('management identity required');
    if (request.op === 'status') return this.status();
    if (request.op === 'close') {
      if (!nonceOK(request.nonce) || request.generation !== this.generation) fail('current generation and hold nonce required');
      if (this.hold && this.hold !== request.nonce) fail('another hold owns closure');
      this.mode = 'CLOSED'; this.hold = request.nonce; return this.status();
    }
    if (request.op === 'reopen') {
      if (request.generation !== this.generation || !nonceOK(request.nonce) || request.nonce !== this.hold) fail('hold ownership mismatch');
      if (!this.listener || this.unknown.size || this.residual.size || this.fault || this.dirty) fail('guest not reconciled');
      this.hold = null; this.mode = 'OPEN'; return this.status();
    }
    if (request.op === 'open' && peer.uid === 0) {
      if (this.hold || !this.listener || this.unknown.size || this.residual.size || this.fault || this.dirty) fail('guest not reconciled');
      this.mode = 'OPEN'; return this.status();
    }
    fail('unsupported management operation');
  }
  cleaned(processes) { this.reconcile(processes); if ([...this.leases.values()].some(l => l.phase === 'ACTIVE') || this.unknown.size || this.pending.size || this.residual.size) fail('cleanup not quiescent'); this.dirty = false; }
  status() {
    const active = [...this.leases.values()].filter(l => l.phase === 'ACTIVE').length;
    const parked = this.leases.size - active;
    // Empty string is the wire representation of no hold (macOS plutil cannot extract JSON null).
    return { protocol: 1, generation: this.generation, boot: this.boot, mode: this.mode, hold: this.hold || '',
      listener: Boolean(this.listener), starting: this.starting, active, parked, unknown: this.unknown.size + this.pending.size, residual: this.residual.size, dirty: this.dirty, fault: this.fault,
      drained: this.mode === 'CLOSED' && !this.starting && active === 0 && !this.unknown.size && !this.pending.size && !this.residual.size && !this.dirty && !this.fault };
  }
}

export function protectedPath(path, { file = false } = {}) {
  let current = path;
  for (;;) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('unprotected privileged path');
    if (execFileSync('/bin/ls', ['-ld', current], { encoding: 'utf8', timeout: 5000 }).split(/\s/)[0].includes('+')) fail('ACL on privileged path requires owner review');
    if (current === path && file && !stat.isFile()) fail('regular protected file required');
    if (current === '/') return;
    current = dirname(current);
  }
}
const readJSON = path => { protectedPath(path, { file: true }); return JSON.parse(readFileSync(path, 'utf8')); };
const atomicJSON = (path, value) => {
  const pending = `${path}.pending`;
  writeFileSync(pending, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(pending, path);
};
const native = args => execFileSync(PEER, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }).trim();
const inventory = () => native(['processes']).split('\n').filter(Boolean).map(line => JSON.parse(line));
const errorReply = error => ({ ok: false, error: String(error.message).slice(0, 160) });

export function refuseMaintenance(path) {
  try { lstatSync(path); fail('owner registration maintenance is active'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function clearStaleSocket(path) {
  protectedPath(dirname(path));
  let stat; try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isSocket() || stat.uid !== 0) fail('unexpected socket object');
  await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(500, () => socket.destroy(new Error('socket liveness unknown')));
    socket.on('connect', () => socket.destroy(new Error('existing gate endpoint is live')));
    socket.on('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  });
  const current = lstatSync(path);
  if (current.ino !== stat.ino || !current.isSocket() || current.uid !== 0) fail('socket changed during stale probe');
  unlinkSync(path); // Only a protected root-owned socket with refused connection, never a live endpoint.
}

export function validateRequest(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('object request required');
  const keys = Object.keys(value);
  if (keys.some(k => !['op', 'nonce', 'generation', 'bundle'].includes(k)) || !['begin', 'completed', 'status', 'close', 'reopen', 'open', 'start', 'idle-stop', 'registration-export', 'registration-import'].includes(value.op)) fail('unsupported request');
  if (['begin', 'completed', 'status', 'open'].includes(value.op) && keys.length !== 1) fail('unexpected request fields');
  if (['close', 'reopen'].includes(value.op) && (keys.length !== 3 || !nonceOK(value.nonce) || !nonceOK(value.generation))) fail('invalid hold request');
  if (['start', 'idle-stop', 'registration-export'].includes(value.op) && keys.length !== 1) fail('unexpected request fields');
  if (value.op === 'registration-import' && (keys.length !== 2 || !value.bundle || typeof value.bundle !== 'object' || Array.isArray(value.bundle))) fail('invalid registration bundle');
  return value;
}

export function quiesceResidual({ gate, inventory, signal }) {
  for (let round = 0; round < 20; round++) {
    const seen = inventory(); const keep = gate.allowedPIDs(seen);
    const residual = seen.filter(p => p.uid === gate.runnerUID && !keep.has(p.pid));
    if (residual.some(p => p.path === WORKER)) fail('unknown Worker during cleanup');
    for (const p of residual) signal(p, 'STOP');
    const frozen = inventory(); const allowed = gate.allowedPIDs(frozen);
    const remaining = frozen.filter(p => p.uid === gate.runnerUID && !allowed.has(p.pid));
    if (remaining.some(p => !p.stopped)) continue;
    for (const p of remaining) signal(p, 'KILL');
    const after = inventory(); const preserved = gate.allowedPIDs(after);
    if (!after.some(p => p.uid === gate.runnerUID && !preserved.has(p.pid))) return after;
  }
  fail('runner UID cannot be quiesced');
}

export function freezeIdleListener({ gate, inventory, signal, now = Date.now, sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }) {
  gate.reconcile(inventory());
  if (!gate.status().drained || gate.status().parked || !nonceOK(gate.hold)) fail('owned fully idle hold required');
  const target = gate.listener; if (!target) return;
  signal(target, 'STOP');
  try {
    const deadline = now() + 2000; let stopped;
    do { stopped = inventory().find(p => same(p, target)); if (stopped?.stopped) break; sleep(); } while (now() < deadline);
    if (!stopped?.stopped) fail('listener did not freeze');
    const current = inventory(); gate.reconcile(current);
    if (current.some(p => p.uid === gate.runnerUID && p.path === WORKER) || !gate.status().drained || gate.status().parked) fail('Worker appeared before listener freeze');
    signal(target, 'KILL'); // Frozen listener cannot dispatch between the final inventory and exit.
    gate.listener = null;
  } catch (error) { signal(target, 'CONT'); throw error; }
}

export function requireOwnedIdle(gate, peer, processes) {
  if (peer.uid !== 0 && peer.uid !== gate.controlUID) fail('management identity required');
  gate.reconcile(processes); const status = gate.status();
  if (!status.drained || status.parked || !nonceOK(status.hold)) fail('owned closed hold and fully idle guest required');
}

export function validateRegistration(bundle) {
  if (Object.keys(bundle).sort().join(',') !== REGISTRATION.slice().sort().join(',')) fail('unexpected registration files');
  return REGISTRATION.map(name => {
    const text = bundle[name];
    if (typeof text !== 'string' || text.length > 32768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail('invalid registration encoding');
    const bytes = Buffer.from(text, 'base64'); JSON.parse(bytes.toString('utf8'));
    return [name, bytes];
  });
}

export function validateNetworkTargets(value) {
  const required = ['host-gateway', 'host-lan', 'linux-peer', 'private-routes', 'ipv6-global', 'ipv6-ula', 'ipv6-linklocal'];
  if (!value || !nonceOK(value.witness) || !Array.isArray(value.targets) || value.targets.length < 7 || value.targets.length > 32) fail('bounded known-answer targets required');
  for (const target of value.targets) {
    if (!required.includes(target.label) || typeof target.host !== 'string' || !isIP(target.host) || !Number.isSafeInteger(target.port) || target.port < 1024 || target.port > 65535) fail('invalid canary address/port');
    if (target.host === '127.0.0.1' || target.host === '::1' || target.host === '0.0.0.0' || target.host === '::') fail('guest-local address is not host isolation evidence');
    if (target.label.startsWith('ipv6-') !== (isIP(target.host) === 6)) fail('canary address family mismatch');
  }
  if (!required.every(label => value.targets.some(target => target.label === label))) fail('missing network class');
  return value;
}
export async function probeNetwork(value, connect) {
  const targets = validateNetworkTargets(value); const results = [];
  for (const target of targets.targets) {
    const outcome = await connect(target);
    // A connected TCP socket is failure even if the server payload/protocol is wrong.
    results.push({ ...target, outcome, blocked: BLOCKED_OUTCOMES.includes(outcome) });
  }
  return { witness: targets.witness, results, negativesPassed: results.every(result => result.blocked), positiveControls: 'OWNER_BEFORE_AND_AFTER_REQUIRED' };
}
const tcpProbe = target => new Promise(resolve => {
  const socket = createConnection({ host: target.host, port: target.port });
  socket.setTimeout(1500, () => { socket.destroy(); resolve('ETIMEDOUT'); });
  socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
  socket.on('error', error => resolve(error.code || 'UNKNOWN'));
});
const publicTLS = host => new Promise(resolve => {
  const request = httpsRequest({ hostname: host, path: '/', method: 'HEAD', timeout: 5000 }, response => { response.resume(); resolve(response.statusCode >= 200 && response.statusCode < 500); });
  request.on('error', () => resolve(false)); request.on('timeout', () => { request.destroy(); resolve(false); }); request.end();
});

export function admitWorkflow(env) {
  for (const [name, expected] of Object.entries(ADMITTED_WORKFLOW)) if (env[name] !== expected) fail(`${name} is not admitted on this runner`);
}

// Shared host filesystems in `mount` output. Any entry is isolation failure: the guest has no host shares.
// A parked job waits for a reset or an owner close to end (up to 12 minutes). A latched gate fault
// cannot clear without the owner, so the job fails at once instead of holding the runner (CASE-305).
export async function awaitAdmission({ request, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), limit = 12 * 60 * 1000 }) {
  const deadline = now() + limit;
  do {
    let reply;
    try { reply = await request(); }
    catch (error) {
      // The gate answers nothing while a long cleanup runs; a transport error only keeps the job parked.
      if (!error?.code && error?.message !== 'gate timeout') throw error;
      await sleep(1000); continue;
    }
    if (reply.admission === 'GRANTED') return reply;
    if (reply.admission !== 'PARKED') fail('invalid admission reply');
    if (reply.fault) fail(`guest gate fault: ${reply.fault}; admission refused, owner recovery required`);
    await sleep(1000);
  } while (now() < deadline);
  fail('admission remained closed; job must fail before checkout');
}

export const CLEANUP_TIMEOUT = 15 * 60 * 1000;
// The guest cleanup prints at most one line, `cleanup <reason> <location> <path>` (CASE-306). The gate
// keeps only that fixed vocabulary as its fault, so the owner's status names what failed.
export function cleanupFault(error) {
  // A chatty cleanup overflows maxBuffer; Node then kills it with SIGTERM, which is not a timeout.
  if (error?.code === 'ENOBUFS') return 'cleanup output too large';
  if (error?.signal) return `cleanup killed by ${/^SIG[A-Z0-9]{1,8}$/.test(error.signal) ? error.signal : 'signal'} (timeout ${CLEANUP_TIMEOUT / 60000} min)`;
  const line = String(error?.stdout ?? '').split('\n')[0];
  const found = /^cleanup (leftover|invalid) ([a-z0-9-]{1,16}) ?([A-Za-z0-9._/-]{0,80})$/.exec(line);
  if (found) return `cleanup ${found[1]} ${found[2]}${found[3] ? ` ${found[3]}` : ''}`;
  return `cleanup exited ${Number.isSafeInteger(error?.status) ? error.status : 'abnormally'}`;
}

export function parseSharedMounts(text) {
  return text.split('\n').filter(line => /\((?:virtiofs|nfs|smbfs|afpfs)[,)]/.test(line));
}

// Effective resolvers from `scutil --dns`: sorted, unique, comma-joined.
export function parseResolvers(text) {
  return [...new Set([...text.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gm)].map(m => m[1]))].sort().join(',');
}

export function socketRequest(request, path = PUBLIC, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let response = '';
    socket.setTimeout(timeout, () => socket.destroy(new Error('gate timeout')));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('error', reject);
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (response.length > 1024 * 1024) return socket.destroy(new Error('oversized gate reply'));
      const end = response.indexOf('\n');
      if (end >= 0) {
        try { const result = JSON.parse(response.slice(0, end)); socket.destroy(); result.ok ? resolve(result) : reject(new Error(result.error)); }
        catch (error) { socket.destroy(); reject(error); }
      }
    });
    socket.on('end', () => { if (!response.includes('\n')) reject(new Error('incomplete gate reply')); });
  });
}

async function serve() {
  if (process.platform !== 'darwin' || process.getuid() !== 0) fail('root macOS guest daemon required');
  refuseMaintenance(`${STATE}/registration-maintenance`);
  for (const path of [fileURLToPath(import.meta.url), PEER, process.execPath, STATE, dirname(PUBLIC), WORKER, LISTENER, `${LIB}/job-started.js`, `${LIB}/job-completed.js`, `${LIB}/cleanup`]) protectedPath(path);
  const config = readJSON(`${STATE}/guest.json`);
  if (config.version !== 1 || !Number.isSafeInteger(config.runnerUID) || !Number.isSafeInteger(config.runnerGID) || !Number.isSafeInteger(config.controlUID) || config.runnerUID < 650 || config.runnerGID < 650 || config.controlUID < 650 || config.runnerUID === config.controlUID) fail('invalid installed guest identity');
  const processes = inventory();
  const gate = new AdmissionGate({ boot: native(['boot']), runnerUID: config.runnerUID, controlUID: config.controlUID, processes });
  if (processes.some(p => p.uid === config.runnerUID && p.path === LISTENER)) gate.fault = 'prior listener requires owner recovery';
  let listener = null; let shuttingDown = false; let startRequested = false; let startDeadline = 0;
  const adoptStartup = now => {
    if (!listener || gate.listener) return true;
    const child = now.find(p => p.pid === listener.pid);
    if (child && child.ppid === process.pid && child.uid === config.runnerUID && child.path === LISTENER) { gate.attachListener(child); return true; }
    // The one child just spawned by this root daemon may briefly be the privilege-drop helper.
    // No generic runner process exemption: no cleanup/reconciliation runs through this transition.
    if (Date.now() > startDeadline || (child && (child.ppid !== process.pid || ![0, config.runnerUID].includes(child.uid) || child.path !== PEER))) fail('listener startup identity failed');
    return false;
  };
  const requireIdle = peer => {
    requireOwnedIdle(gate, peer, inventory());
  };
  const stopIdle = peer => {
    requireIdle(peer);
    freezeIdleListener({ gate, inventory, signal: (p, signal) => native(['signal', String(p.pid), p.start, signal]) });
    startRequested = false; listener = null; return { ...gate.status(), stopped: true };
  };
  // Never trust a prior daemon's status/hold/OPEN state. Only dead protected socket objects can go.
  await clearStaleSocket(PRIVATE); await clearStaleSocket(PUBLIC);
  try { const pending = lstatSync(`${STATE}/status.json.pending`); if (pending.uid !== 0 || !pending.isFile()) fail('unexpected pending status'); unlinkSync(`${STATE}/status.json.pending`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  atomicJSON(`${STATE}/status.json`, gate.status());
  const respond = (socket, result) => socket.end(`${JSON.stringify(result)}\n`);
  const server = createServer(socket => {
    let data = ''; socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 131328) return socket.destroy();
      const lines = data.split('\n'); if (lines.length < 3) return;
      socket.removeAllListeners('data');
      try {
        if (!/^\d+ \d+ \d+:\d+$/.test(lines[0]) || lines.length !== 3 || lines[2] !== '') fail('invalid broker envelope');
        const [uid, pid, start] = lines[0].split(' '); const peer = { uid: Number(uid), pid: Number(pid), start };
        const request = validateRequest(JSON.parse(lines[1])); const now = inventory();
        if (!adoptStartup(now)) fail('listener startup pending');
        let value;
        if (request.op === 'start') {
          gate.reconcile(now);
          for (const name of REGISTRATION) protectedPath(`/opt/actions-runner/${name}`, { file: true });
          value = gate.requestStart(peer); startRequested = true;
        }
        else if (request.op === 'idle-stop') value = stopIdle(peer);
        else if (['registration-export', 'registration-import'].includes(request.op)) {
          requireIdle(peer);
          if (gate.listener) fail('stop idle listener before registration transfer');
          if (request.op === 'registration-export') {
            const bundle = {};
            for (const name of REGISTRATION) {
              const path = `/opt/actions-runner/${name}`; protectedPath(path, { file: true });
              const bytes = readFileSync(path); if (bytes.length > 24576) fail('oversized registration file');
              bundle[name] = bytes.toString('base64');
            }
            validateRegistration(bundle); value = { bundle };
          } else {
            const files = validateRegistration(request.bundle);
            for (const [name] of files) {
              const path = `/opt/actions-runner/${name}`;
              // A clean base must contain no registration; no silent overwrite or mixed credentials.
              try { lstatSync(path); fail('registration already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            try { for (const [name, bytes] of files) {
              const path = `/opt/actions-runner/${name}`;
              writeFileSync(`${path}.pending`, bytes, { flag: 'wx', mode: 0o440 });
              chownSync(`${path}.pending`, 0, config.runnerGID); renameSync(`${path}.pending`, path);
            } } catch { gate.fault = 'registration restore incomplete'; fail('registration restore incomplete'); }
            value = { restored: true };
          }
        }
        else if (request.op === 'begin') value = gate.begin(peer, now);
        else if (request.op === 'completed') { gate.workerFor(peer, now); value = gate.status(); }
        else value = gate.control(peer, request, now);
        atomicJSON(`${STATE}/status.json`, gate.status()); respond(socket, { ok: true, ...value });
      } catch (error) { respond(socket, errorReply(error)); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PRIVATE, resolve); });
  chmodSync(PRIVATE, 0o600);
  const broker = spawn(PEER, ['serve'], { stdio: ['ignore', 'ignore', 'inherit'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  broker.once('exit', () => { gate.mode = 'CLOSED'; gate.fault = 'peer broker exited'; });
  const clean = () => {
    const now = inventory(); gate.reconcile(now);
    if ((!gate.dirty && !gate.residual.size) || gate.unknown.size || gate.pending.size || [...gate.leases.values()].some(l => l.phase === 'ACTIVE')) return;
    // Freeze before killing, then repeat inventory: a residual that forked before STOP cannot leave
    // an unobserved child. Continual respawn or an uninspectable process becomes a CLOSED fault.
    quiesceResidual({ gate, inventory, signal: (p, signal) => native(['signal', String(p.pid), p.start, signal]) });
    // A real job leaves a checkout, node_modules and Postgres data; 30 s was too short (CASE-306).
    let result;
    try { result = execFileSync(PEER, ['cleanup'], { encoding: 'utf8', timeout: CLEANUP_TIMEOUT, maxBuffer: 4096 }); }
    catch (error) { throw Object.assign(new Error('cleanup failed'), { fault: cleanupFault(error) }); }
    if (result !== '') fail('unexpected cleanup output');
    gate.cleaned(inventory());
  };
  const tick = () => {
    if (shuttingDown) return;
    try {
      const now = inventory();
      if (!adoptStartup(now)) { atomicJSON(`${STATE}/status.json`, gate.status()); return; }
      gate.reconcile(now); clean();
      // A reviewed owner seal, not registration data or stale status, permits first listener start.
      if (startRequested && !listener && !gate.listener && !gate.unknown.size && !gate.fault) {
        const seal = readJSON(`${STATE}/sealed.json`);
        if (seal.version !== 1 || seal.bootPolicy !== 'closed-until-owner-open' || seal.network !== 'owner-proved') fail('owner guest seal missing');
        gate.starting = true; startDeadline = Date.now() + 5000;
        listener = spawn(PEER, ['listener'], { stdio: ['ignore', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
        listener.once('error', () => { gate.fault = 'listener spawn failed'; });
        const child = listener;
        listener.once('exit', () => { if (listener === child) { gate.mode = 'CLOSED'; gate.fault = 'listener exited'; } });
        // Spawn exec is asynchronous; retry inspector only before any admission is opened.
      }
      if (listener && !gate.listener && !gate.fault) {
        adoptStartup(inventory());
      }
      atomicJSON(`${STATE}/status.json`, gate.status());
    } catch (error) { gate.mode = 'CLOSED'; gate.fault = error?.fault ?? 'inventory, cleanup or seal failed'; }
  };
  const interval = setInterval(tick, 500); tick();
  const shutdown = () => {
    shuttingDown = true; clearInterval(interval); gate.mode = 'CLOSED';
    // Do not kill an active/unknown/parked job on service termination. Owner drains first.
    // The listener is not killed here either: missing gate makes later hooks fail closed.
    broker.kill('SIGTERM'); server.close();
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

// Exported, with the socket path injectable, so tests run the real hook path end to end (the CLI
// always uses PUBLIC). Every branch returns: falling through reaches the usage failure.
export async function main(args, { socket = PUBLIC } = {}) {
  if (args[0] === 'serve' && args.length === 1) return serve();
  if (args[0] === 'probe-network' && args.length === 1) {
    if (process.platform !== 'darwin') fail('macOS guest required');
    const marker = '/Library/Application Support/Case CI/vm-role'; protectedPath(marker, { file: true });
    if (readFileSync(marker, 'utf8') !== 'case-macos-vm\n') fail('guest role required');
    const path = '/Library/Application Support/Case CI/network-targets.json';
    const value = readJSON(path); const report = await probeNetwork(value, tcpProbe);
    report.publicTLS = {};
    for (const host of ['github.com', 'registry.npmjs.org']) report.publicTLS[host] = await publicTLS(host);
    report.dnsServers = parseResolvers(execFileSync('/usr/sbin/scutil', ['--dns'], { encoding: 'utf8', timeout: 5000 }));
    report.sharedMounts = parseSharedMounts(execFileSync('/sbin/mount', { encoding: 'utf8', timeout: 5000 }));
    report.uid = process.getuid(); report.guestVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    report.guestBuild = execFileSync('/usr/bin/sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.negativesPassed || !Object.values(report.publicTLS).every(Boolean) || report.dnsServers !== GUEST_DNS || report.sharedMounts.length) process.exitCode = 78;
    return;
  }
  if (args[0] === 'hook' && args.length === 2 && ['started', 'completed'].includes(args[1])) {
    if (args[1] === 'completed') { await socketRequest({ op: 'completed' }, socket); return; }
    // Refused before begin: the Worker never gets a lease and the job fails before checkout.
    admitWorkflow(process.env);
    await awaitAdmission({ request: () => socketRequest({ op: 'begin' }, socket) });
    return;
  }
  if (args[0] === 'control' && args.length === 1) {
    // Forced SSH management reads a bounded JSON request on stdin, never credentials/nonce in argv.
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 131072) fail('oversized control request'); }
    const request = validateRequest(JSON.parse(input));
    if (['begin', 'completed'].includes(request.op)) fail('management cannot impersonate job');
    process.stdout.write(`${JSON.stringify(await socketRequest(request))}\n`); return;
  }
  fail('usage: case-macos-gate.mjs serve | hook started|completed | control');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('STOPPED: macOS gate failed closed\n'); process.exitCode = 78; });
}
