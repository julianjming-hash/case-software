// Card 36b: the console and projector parity pass is layout only. These pin the token the projector QR is
// measured against, prove the facilitator-only column's renderer is unreachable from the projector and the
// phone, and prove no payload field was added (CASE-092/093, CASE-164).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { initialState, project } from '../src/shared/room-machine.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const DIR = new URL('../src/client/', import.meta.url);

test('[36b] --projector-qr is clamp(180px, 31vh, 340px) in the client tokens and their prototype mirror (Julian, 2026-10-07)', () => {
  for (const file of ['../src/client/tokens.css', '../prototypes/room/lib/tokens.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(/--projector-qr:\s*clamp\(180px, 31vh, 340px\);/.test(css), `${file}: ${css.match(/--projector-qr:[^;]*;/)?.[0]}`);
  }
});

// Static and literal dynamic imports, every relative specifier resolved against its file (`./`, `../client/`,
// `../shared/`, ...), so no path spelling can hide an edge. Nodes are file URLs under src/.
const SRC = new URL('../src/', import.meta.url);
const specifiers = url => [...readFileSync(url, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)].map(m => m[1]);
const edges = url => specifiers(url).map(spec => new URL(spec, url).href).filter(href => href.startsWith(SRC.href));
const imports = file => edges(new URL(file, DIR)).filter(href => href.startsWith(DIR.href)).map(href => href.slice(DIR.href.length));
function closure(entry) {
  const seen = new Set(); const walk = href => { if (seen.has(href)) return; seen.add(href); edges(new URL(href)).forEach(walk); };
  walk(new URL(entry, DIR).href);
  return new Set([...seen].map(href => href.startsWith(DIR.href) ? href.slice(DIR.href.length) : href.slice(SRC.href.length)));
}
const CONSOLE_ONLY = ['console-room.mjs', 'console-room-tab.mjs', 'teaching-controls.mjs', 'builder-inspection.mjs', 'case-map.mjs'];

test('[36b] the Only you renderer is defined once, in the console room, and the Room tab chunk is console-only', () => {
  const src = readFileSync(new URL('teaching-controls.mjs', DIR), 'utf8');
  assert.match(src, /function renderOnlyYou\(view\)/);
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.mjs') && f !== 'console-room.mjs' && f !== 'builder-inspection.mjs' && f !== 'teaching-controls.mjs'))
    assert.doesNotMatch(readFileSync(new URL(file, DIR), 'utf8'), /function renderOnlyYou|console-only-you/, file);
  // Only console-room.mjs imports the lazy Room tab chunk (CASE-174).
  assert.deepEqual(readdirSync(DIR).filter(f => f.endsWith('.mjs') && imports(f).includes('console-room-tab.mjs')), ['console-room.mjs']);
});

test('[36b] [CASE-092] projector and phone module graphs, lazy chunks included, cannot reach the console room or its Room tab', () => {
  // pair.mjs is excluded on purpose: it hosts the facilitator console on a paired PC.
  for (const entry of ['projector.mjs', 'phone.mjs']) {
    const reach = closure(entry);
    assert.ok(reach.size > 3, `${entry} closure was walked`);
    for (const file of CONSOLE_ONLY) assert.ok(!reach.has(file), `${entry} reaches ${file}`);
  }
});

test('[36b] [CASE-164] initial public keys retain card 30 tint; only the exact private view gains Undo and publicTimeline', () => {
  const state = initialState({ sessionId: '0190a000-0000-7000-8000-000000000000', joinCode: 'ABC123', caseDoc: FIXTURE });
  const keys = role => Object.keys(project(state, role)).sort();
  assert.deepEqual(keys('participant'), ['art', 'caseTitle', 'caseVersionNo', 'decision', 'endedAt', 'epoch', 'lastResult', 'lastRound', 'liveSurface', 'manual', 'phase', 'recap', 'recapExpiresAt', 'revision', 'role', 'sessionId', 'timeline', 'timer', 'tint', 'you']);
  assert.deepEqual(keys('display'), ['arrivalCount', 'art', 'avatars', 'caseTitle', 'caseVersionNo', 'counts', 'decision', 'displayRevision', 'endedAt', 'epoch', 'joinCode', 'joiningClosed', 'lastResult', 'manual', 'music', 'names', 'phase', 'recapExpiresAt', 'replay', 'responseResult', 'resultsPage', 'resultsShown', 'revision', 'role', 'sessionId', 'surface', 'timer', 'tint']);
  assert.deepEqual(keys('facilitator'), ['actions', 'art', 'autoLock', 'beat', 'caseTitle', 'caseVersionNo', 'debrief', 'decision', 'display', 'endedAt', 'epoch', 'flags', 'joinCode', 'joiningClosed', 'liveSurface', 'manual', 'music', 'namesShown', 'nextBeat', 'participants', 'phase', 'presentation', 'publicDisplaySurface', 'publicTimeline', 'rankedColumns', 'rankedPositionSpan', 'rankedPresentation', 'rankedRoundId', 'rankedSelection', 'recapExpiresAt', 'resolutionKind', 'resultsPage', 'resultsPageCount', 'resultsShown', 'resumePhase', 'revision', 'role', 'round', 'rounds', 'selectedPathId', 'sessionId', 'terminal', 'terminalPathId', 'textPresentation', 'timeline', 'timer', 'tint', 'undo']);
  const privateView = project(state, 'facilitator');
  assert.deepEqual(privateView.publicTimeline, []);
  assert.equal(privateView.textPresentation, null);
  assert.deepEqual(privateView.undo, { available: false, reason: 'no_teaching_action' });
  for (const role of ['participant', 'display']) {
    const view = project(state, role);
    assert.equal(Object.hasOwn(view, 'undo'), false);
    assert.equal(Object.hasOwn(view, 'textPresentation'), false);
    assert.equal(Object.hasOwn(view, 'publicTimeline'), false);
  }
});
