
// Text only: every result line is set with textContent.
import { apiOrigin } from './api-origin.mjs';
import { startShell } from './shell.mjs';
import { keepScreenAwake } from './device.mjs';

const params = new URLSearchParams(location.search);
let base;
try { base = `${apiOrigin(params.get('api') || location.origin)}/api/v1/check`; } catch { base = `${location.origin}/api/v1/check`; }
const HOLD_MS = Math.max(5_000, Math.min(60_000, Number(params.get('hold')) || 60_000)); // ?hold= shortens it for tests only
const LONG_WAIT_S = Math.max(1, Math.min(20, Number(params.get('wait')) || 20));
const $ = (id) => document.getElementById(id);

const rows = {};
function row(key, title) {
  const li = document.createElement('li');
  const mark = document.createElement('span'); mark.className = 'mark'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = '…';
  const h = document.createElement('h2'); h.textContent = title;
  const r = document.createElement('p'); r.className = 'result'; r.textContent = 'Waiting…';
  li.append(mark, h, r);
  $('checks').append(li);
  rows[key] = { li, mark, r };
}
function set(key, state, text) {
  const x = rows[key];
  x.li.dataset.state = state;
  x.mark.textContent = { pass: '✓', warn: '!', fail: '✕', run: '…' }[state];
  x.r.textContent = text;
}

async function timed(url, timeoutMs) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0) };
  } catch { return { ok: false, status: 0, ms: Math.round(performance.now() - t0) }; } finally { clearTimeout(timer); }
}

async function latency() {
  set('latency', 'run', 'Measuring…');
  const times = [];
  for (let i = 0; i < 5; i++) { const r = await timed(`${base}/poll?wait=0`, 10_000); if (!r.ok) return set('latency', 'fail', r.status === 429 ? 'Too many checks from this network just now. Wait a minute and run it again.' : 'Case could not be reached from here. Check that case.iatrogenic.app is not blocked.'); times.push(r.ms); }
  times.sort((a, b) => a - b);
  const median = times[2];
  set('latency', median <= 300 ? 'pass' : 'warn', median <= 300 ? `Typical round trip ${median} ms. Good.` : `Typical round trip ${median} ms. Slow, but sessions still work; answers may take a moment to show.`);
  return true;
}

async function longPoll() {
  set('poll', 'run', `Holding one request open for ${LONG_WAIT_S} seconds…`);
  const r = await timed(`${base}/poll?wait=${LONG_WAIT_S}`, (LONG_WAIT_S + 15) * 1000);
  if (r.ok && r.ms >= LONG_WAIT_S * 1000 - 500) {
    set('poll', 'pass', 'Held requests work. This is the fallback Case uses when live updates are blocked.');
    return true;
  }
  set('poll', 'fail', 'A held request was cut off. Case will fall back to checking every few seconds, which works but is slower.');
  return false;
}

function socket() {
  return new Promise((resolve) => {
    set('ws', 'run', `Keeping a live connection open for ${Math.round(HOLD_MS / 1000)} seconds…`);
    let ws;
    try { ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`); } catch { set('ws', 'fail', 'Live updates are blocked here. Case will use the slower fallback, which works.'); resolve(false); return; }
    let opened = 0; let lastEcho = 0; let n = 0; let done = false;
    const finish = (ok, text, state = ok ? 'pass' : 'fail') => { if (done) return; done = true; clearInterval(tick); try { ws.close(1000); } catch { /* gone */ } set('ws', state, text); resolve(ok); };
    const tick = setInterval(() => {
      if (!opened) return;
      const now = Date.now();
      if (now - opened >= HOLD_MS) return finish(true, `Live updates work and stayed connected for ${Math.round((now - opened) / 1000)} seconds.`);
      if (now - lastEcho > 15_000) return finish(false, `Live updates stopped after ${Math.round((now - opened) / 1000)} seconds. Case will notice this and use the slower fallback, which works.`, 'warn');
      try { ws.send(`check-${++n}`); } catch { /* closing */ }
    }, 5_000);
    ws.addEventListener('open', () => { opened = lastEcho = Date.now(); try { ws.send('check-0'); } catch { /* closing */ } });
    ws.addEventListener('message', () => { lastEcho = Date.now(); });
    ws.addEventListener('close', () => {
      if (!opened) finish(false, 'Live updates are blocked here (often a web filter or proxy). Case will use the slower fallback, which works.');
      else finish(false, `Live updates were cut off after ${Math.round((Date.now() - opened) / 1000)} seconds. Case will notice this and use the slower fallback, which works.`, 'warn');
    });
    setTimeout(() => { if (!opened) { finish(false, 'Live updates did not connect. Case will use the slower fallback, which works.'); } }, 10_000);
  });
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  $('checks').replaceChildren();
  $('summary').textContent = 'Checking…';
  row('latency', 'Reaching Case');
  row('ws', 'Live updates (WebSocket)');
  row('poll', 'Fallback updates (held requests)');
  const reach = await latency();
  if (!reach) { set('ws', 'fail', 'Not tried: Case could not be reached.'); set('poll', 'fail', 'Not tried: Case could not be reached.'); $('summary').textContent = 'Case cannot be reached from this network.'; $('run').disabled = false; return; }
  const [ws, lp] = await Promise.all([socket(), longPoll()]);
  $('summary').textContent = ws ? 'Ready: this network supports live updates.' : lp ? 'Ready: Case will use its fallback on this network. It works; updates can lag by a second or two.' : 'Usable, but slow: Case will check for updates every few seconds here. Consider mobile data.';
  $('run').disabled = false;
});
keepScreenAwake();
startShell();
window.caseCheck = { base, HOLD_MS }; // for scripted checks; carries nothing personal
