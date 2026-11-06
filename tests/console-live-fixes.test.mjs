// Card 37: console live fixes. The dock is never empty (item 1), background updates patch only what changed
// and never re-render on an unchanged projector hello (item 2), and the option styling adds nothing to any
// public projection (item 3). The room machine is walked as gen-spec walks it (tests/helpers/room-walk.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { project, reduce } from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { dockControl, primaryAction, refusedCommandNotice } from '../src/client/console-actions.mjs';
import { patchChildren, sameNode, helloNeedsRender } from '../src/client/console-focus.mjs';
import { projectorFrame } from '../src/client/console-projection.mjs';
import { walkRoom, WALK_AT } from './helpers/room-walk.mjs';

let cached = null;
const facilitatorViews = () => cached ??= (() => {
  const walk = walkRoom({
    extra: (state, base) => [{ ...base, type: 'show_lobby', on: true }, { ...base, type: 'show_lobby', on: false }],
    keyExtra: state => state.display.lobby === true,
  });
  return { ...walk, views: walk.states.map(state => ({ state, view: project(state, 'facilitator') })) };
})();

test('[card 37] item 1: every reachable facilitator view except ended has a dock control, and it never offers an omitted command', () => {
  const { views } = facilitatorViews();
  assert.ok(views.length > 500, `walked ${views.length} states`);
  const phases = new Set();
  for (const { view } of views) {
    const control = dockControl(view, { now: 0, armedUntil: 0 });
    if (view.phase === 'ended') { assert.equal(control, null); continue; }
    phases.add(view.phase);
    assert.ok(control, `${view.phase}${view.manual ? ' (manual)' : ''} results=${view.resultsShown}: empty dock`);
    assert.equal(typeof control.label, 'string');
    if (control.command) assert.ok(view.actions.includes(control.command), `${view.phase}: dock offers ${control.command} the authority omitted`);
    if (control.disabled) assert.equal(control.command, undefined, 'a disabled dock control sends nothing');
  }
  for (const phase of ['lobby', 'surface_live', 'responses_open', 'responses_locked', 'path_selected', 'consequence_revealed', 'terminal_teaching', 'discussion_paused'])
    assert.ok(phases.has(phase), `walk reached ${phase}`);
});

test('[card 37] item 1: current Reveal atomically dismisses the chart and lobby; legacy capabilities keep Hide then two-step Reveal', () => {
  const { views } = facilitatorViews();
  const hit = views.find(({ state, view }) => !state.manual && state.round?.status === 'locked'
    && view.phase === 'path_selected' && view.resultsShown && !view.actions.includes('reveal')
    && view.actions.includes('show_results') && view.actions.includes('reveal_path') && view.display?.lobby !== true);
  assert.ok(hit, 'a current authoritative locked path_selected view with the chart up is reachable');
  const path = hit.view.decision.paths.find(p => p.id === hit.view.selectedPathId);
  assert.ok(path && !path.explored, 'the selected authored path is eligible');
  assert.deepEqual(dockControl(hit.view), { command: 'reveal_path', payload: { pathId: path.id, expectRevision: hit.view.revision },
    label: `Reveal: ${path.revealPreview ?? path.label}`, pathId: path.id });
  // The compatibility shape explicitly lacks atomic capability; it is not current authority.
  const legacy = view => ({ ...view, actions: view.actions.filter(action => action !== 'reveal_path') });
  assert.equal(primaryAction(legacy(hit.view)), null, 'the legacy CASE-143 gate leaves no primary action');
  assert.deepEqual(dockControl(legacy(hit.view)), { command: 'show_results', payload: { on: false },
    label: 'Hide responses on projector', note: 'Hide the responses to continue' });
  const hidden = reduce(hit.state, { type: 'show_results', on: false, epoch: hit.state.epoch, actor: { role: 'facilitator', id: 'fac' }, at: WALK_AT });
  const view = legacy(project(hidden.state, 'facilitator'));
  assert.ok(view.actions.includes('reveal'));
  const first = dockControl(view, { now: 0, armedUntil: 0 });
  assert.equal(first.local, 'arm_reveal', 'legacy Hide is never fused with reveal; legacy reveal keeps its two steps');
  assert.match(first.label, /^Reveal: /);
  assert.equal(dockControl(view, { now: 0, armedUntil: 3000 }).command, 'reveal');
  for (const phase of ['consequence_revealed', 'terminal_teaching']) {
    const gated = views.find(({ view: v }) => v.phase === phase && primaryAction(legacy(v)) === null && v.actions.includes('show_results') && v.resultsShown);
    if (gated) assert.equal(dockControl(legacy(gated.view)).command, 'show_results', `${phase}: legacy Hide is the dock step`);
  }
  const overlay = reduce(hit.state, { type: 'show_lobby', on: true, epoch: hit.state.epoch, actor: { role: 'facilitator', id: 'fac' }, at: WALK_AT }).state;
  const current = project(overlay, 'facilitator');
  assert.equal(current.display.lobby, true); assert.equal(current.resultsShown, true);
  const control = dockControl(current);
  assert.equal(control.command, 'reveal_path');
  assert.deepEqual(control.payload, { pathId: path.id, expectRevision: overlay.revision });
  const clientEventId = uuidv7();
  const event = { type: control.command, ...control.payload, clientEventId, epoch: overlay.epoch,
    actor: { role: 'facilitator', id: 'fac' }, at: WALK_AT };
  const stale = reduce(overlay, { ...event, expectRevision: overlay.revision - 1 });
  assert.equal(stale.state, overlay, 'a stale revision cannot publish or dismiss overlays');
  assert.equal(stale.effects.find(effect => effect.type === 'receipt')?.receipt, 'rejected');
  const revealed = reduce(overlay, event);
  assert.deepEqual(revealed.effects.find(effect => effect.type === 'receipt'), { type: 'receipt', clientEventId, receipt: 'accepted' });
  assert.equal(revealed.state.phase, 'consequence_revealed');
  assert.equal(revealed.state.revision, overlay.revision + 2, 'one command journals the closed round and its consequence');
  assert.equal(revealed.state.display.lobby, false); assert.equal(revealed.state.display.cursor, null);
  assert.equal(revealed.state.resultsShown, false); assert.equal(revealed.state.namesShown, false);
  assert.equal(revealed.state.round, null); assert.equal(revealed.state.selectedPathId, null);
  assert.equal(revealed.state.revealed.length, overlay.revealed.length + 1);
  const publication = revealed.state.revealed.at(-1), closed = revealed.state.rounds.at(-1);
  const authoredPath = overlay.caseDoc.decisions.find(decision => decision.id === overlay.decisionId).paths.find(p => p.id === path.id);
  assert.equal(publication.pathId, path.id); assert.equal(publication.surfaceId, authoredPath.reveal_surface_id);
  assert.equal(publication.groupsShown, 1); assert.equal(publication.occurrenceId, clientEventId);
  assert.equal(closed.id, overlay.round.id); assert.equal(closed.status, 'resolved');
  assert.equal(closed.selectedPathId, path.id); assert.equal(closed.consequenceOccurrenceId, clientEventId);
});

test('[card 37] item 1: a pending manual upload and an empty action list show a disabled reason, never a blank bar', () => {
  assert.deepEqual(dockControl({ phase: 'surface_live', actions: ['advance'], presentation: { nextGroup: 'findings' } }, { pending: true }),
    { disabled: true, label: 'Upload pending' });
  const idle = dockControl({ phase: 'consequence_revealed', actions: ['end'] });
  assert.equal(idle.disabled, true); assert.equal(idle.command, undefined); assert.ok(idle.label.length > 0);
  assert.equal(dockControl({ phase: 'ended', actions: [] }), null);
});

test('[card 37] item 1: a hide_responses_first refusal says what to do, in plain text', () => {
  assert.equal(refusedCommandNotice('hide_responses_first'), 'Hide the responses on the projector first.');
  assert.equal(refusedCommandNotice('lobby_shown'), 'Return to the case on the projector first.');
  // A stale tab's lobby toggle is answered silently: the resync shows the projector's actual state (red team L3).
  assert.equal(refusedCommandNotice('no_change'), '');
});

test('[card 37] item 4: the join screen toggles from the rail; legacy capabilities keep the dock fallback (console layout v2)', () => {
  const { views } = facilitatorViews();
  const shown = views.filter(({ view }) => view.display?.lobby === true && view.phase !== 'ended');
  assert.ok(shown.length > 20, 'lobby-overlay states are reachable');
  let atomic = 0;
  for (const { view } of shown) {
    const legacy = { ...view, actions: view.actions.filter(action => action !== 'reveal_path') };
    assert.deepEqual(dockControl(legacy), { command: 'show_lobby', payload: { on: false }, label: 'Return to case' });
    if (view.actions.includes('reveal_path')) {
      atomic++;
      assert.deepEqual(dockControl(view), primaryAction(view), 'current lobby overlay preserves the clinical primary action');
    }
  }
  assert.ok(atomic > 20, 'atomic-capability lobby states exercise the current dock contract');
  // The rail's People card holds the one join-screen toggle: offered only with show_lobby, one authorised command,
  // labelled by what the projector shows now, pressed state exposed, inert while a command is pending. The menu no
  // longer repeats it (or End case): it keeps the sound actions only.
  const source = readFileSync(new URL('../src/client/console-room.mjs', import.meta.url), 'utf8');
  const people = source.slice(source.indexOf('function renderPeopleCard('), source.indexOf('function renderRail('));
  assert.ok(people.length > 400, 'renderPeopleCard was sliced');
  assert.match(people, /if \(view\.actions\?\.includes\('show_lobby'\)\)/);
  assert.match(people, /roomCommand\('show_lobby', \{ on: !lobbyShown \}\)/);
  assert.match(people, /lobbyShown \? 'Hide join screen' : 'Show join screen'/);
  assert.match(people, /setAttribute\('aria-pressed', String\(lobbyShown\)\)/);
  assert.match(people, /if \(busy\) toggle\.setAttribute\('aria-disabled', 'true'\)/);
  const menu = source.slice(source.indexOf('roomMenu.setRoomActions('), source.indexOf('const beat = el('));
  assert.doesNotMatch(menu, /show_lobby|End case|End room/);
});

test('[card 37] item 2: a projector hello with an unchanged display state does not re-render', () => {
  assert.equal(helloNeedsRender({ needsCheck: false, fallback: false }, { needsCheck: false, fallback: false }), false);
  assert.equal(helloNeedsRender({ needsCheck: true, fallback: false }, { needsCheck: true, fallback: false }), false);
  assert.equal(helloNeedsRender({ needsCheck: false, fallback: false }, { needsCheck: true, fallback: false }), true);
  assert.equal(helloNeedsRender({ needsCheck: false, fallback: true }, { needsCheck: false, fallback: false }), true);
  // The console's hello handler publishes, then renders only through this check.
  const source = ["console-room.mjs","teaching-controls.mjs"].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
  const handler = source.slice(source.indexOf('if (hello.accept(data, Date.now()))'), source.indexOf('function muteProjector'));
  assert.match(handler, /publish\(\);/);
  assert.match(handler, /if \(firstHello \|\| helloNeedsRender\(before, displayState\(\)\)\) render\(\);/);
  assert.doesNotMatch(handler, /publish\(\); render\(\);/);
});

test('[card 37] item 2: programmatic console focus never scrolls, and console cards have no entrance motion', () => {
  const source = ["console-room.mjs","teaching-controls.mjs"].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
  for (const call of source.matchAll(/\.focus\(([^)]*)\)/g)) assert.equal(call[1], '{ preventScroll: true }', `focus(${call[1]})`);
  const css = readFileSync(new URL('../src/client/console.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /console-enter|animation\s*:/);
});

// A minimal element tree, enough for the patcher: the console's own DOM is exercised in e2e/console.spec.mjs.
class FakeNode {
  constructor(tag, attrs = {}, children = [], text = null) {
    this.nodeType = tag ? 1 : 3; this.tagName = tag?.toUpperCase(); this.nodeValue = text; this.parentNode = null; this.childNodes = [];
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value: String(value) }));
    for (const child of children) this.append(child);
  }
  getAttribute(name) { return this.attributes.find(a => a.name === name)?.value ?? null; }
  hasAttribute(name) { return this.attributes.some(a => a.name === name); }
  append(...nodes) { for (const n of nodes) { n.parentNode?.removeChild(n); n.parentNode = this; this.childNodes.push(n); } }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(n) { const p = this.parentNode, i = p.childNodes.indexOf(this); n.parentNode?.removeChild(n); p.childNodes[i] = n; n.parentNode = p; this.parentNode = null; }
  replaceChildren(...nodes) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...nodes); }
}
const e = (tag, attrs, ...children) => new FakeNode(tag, attrs, children);
const t = text => new FakeNode(null, {}, [], text);
const tree = (count, keep = 'a') => e('section', { class: 'console-room' },
  e('header', { class: 'bar' }, e('h1', {}, t('Case'))),
  e('section', { class: 'console-run' },
    e('section', { class: 'console-col sees' }, e('div', { class: 'console-scene' }, e('h3', {}, t('Arrival')))),
    e('section', { class: 'console-col only' }, e('section', { class: 'console-phase' }, e('p', {}, t(`Round 1 · ${count} of 3 responded`))),
      e('div', { 'data-keep': 'shared' }, e('p', {}, t(keep))))),
  e('div', { class: 'console-action-dock' }, e('button', { type: 'button' }, t('Lock responses & review'))));

test('[card 37] item 2: an unchanged update keeps every node; a vote replaces only the count line', () => {
  const live = tree(1), scene = live.childNodes[1].childNodes[0].childNodes[0], dock = live.childNodes[2];
  const header = live.childNodes[0], phase = live.childNodes[1].childNodes[1].childNodes[0];
  assert.equal(sameNode(live, tree(1)), true);
  patchChildren(live, tree(1));
  assert.equal(live.childNodes[0], header); assert.equal(live.childNodes[1].childNodes[0].childNodes[0], scene);
  assert.equal(live.childNodes[2], dock);
  patchChildren(live, tree(2));
  assert.equal(live.childNodes[1].childNodes[0].childNodes[0], scene, 'the scene node survives a vote');
  assert.equal(live.childNodes[2], dock, 'the dock survives a vote');
  assert.equal(live.childNodes[1].childNodes[1].childNodes[0], phase, 'the phase card is patched, not replaced');
  assert.equal(phase.childNodes[0].childNodes[0].nodeValue, 'Round 1 · 2 of 3 responded');
  assert.equal(sameNode(live, tree(2)), true);
});

test('[card 37] item 2: a data-keep slot compares by its own attributes and keeps what it holds', () => {
  const live = tree(1, 'typed code');
  const slot = live.childNodes[1].childNodes[1].childNodes[1];
  patchChildren(live, tree(1, 'fresh'));
  assert.equal(live.childNodes[1].childNodes[1].childNodes[1], slot);
  assert.equal(slot.childNodes[0].childNodes[0].nodeValue, 'typed code');
  const changed = e('section', {}, e('div', { 'data-keep': 'shared', hidden: '' }));
  assert.equal(sameNode(e('section', {}, e('div', { 'data-keep': 'shared' })), changed), false);
});

test('[card 37] item 2: a changed attribute (a disabled control re-enabled) is never kept stale', () => {
  const live = e('div', {}, e('button', { disabled: '' }, t('Next positions')));
  const button = live.childNodes[0];
  patchChildren(live, e('div', {}, e('button', {}, t('Next positions'))));
  assert.notEqual(live.childNodes[0], button);
  assert.equal(live.childNodes[0].hasAttribute('disabled'), false);
  const grow = e('div', {}, e('p', {}, t('a')));
  patchChildren(grow, e('div', {}, e('p', {}, t('a')), e('p', {}, t('b'))));
  assert.deepEqual(grow.childNodes.map(n => n.childNodes[0].nodeValue), ['a', 'b']);
  patchChildren(grow, e('div', {}, e('p', {}, t('a'))));
  assert.equal(grow.childNodes.length, 1);
});

// Synthetic narrative rebaseline proved by 9360 paired projections across 2340 states; no runtime-byte change.
// Original golden computed on origin/main f4c94b7 before card 37: the display and participant projections and the
// same-PC frame for all 2340 walked states. Item 3 is console DOM only; item 4's layer is off in this walk.
const GOLDEN = '62a260b8949ab01a576bfb3427d3e8a70a0b8880ed65410e50ae3e1ba0d1f7bb';
test('[card 37] item 3: public projections retain main bytes apart from the exact legacy recap evidence classification', () => {
  const { pid, states } = walkRoom();
  assert.equal(states.length, 2340);
  const hash = createHash('sha256');
  let classified = 0;
  const legacyRecap = view => {
    if (!view.recap) return view;
    return { ...view, recap: { ...view.recap, rounds: view.recap.rounds.map(row => {
      const { publicationEvidence, ...original } = row;
      if (publicationEvidence !== undefined) {
        assert.equal(publicationEvidence, 'legacy_unique_chronology');
        assert.equal(row.status, 'resolved');
        assert.equal(typeof row.whatHappened, 'string');
        classified++;
      }
      return original;
    }) } };
  };
  // Card 40 (red-team R6): the ended projections gain exactly debrief, feedbackCode and revealIndex. They are stripped here so
  // the original golden still proves every other byte unchanged, and asserted to appear only once ended.
  const CARD40 = new Set(['debrief', 'feedbackCode', 'revealIndex']);
  let card40Keys = 0, roomKeys = 0;
  // Room PDFs v2 (AS-176; #307 red-team P3): `room` is stripped only where it may appear, a participant recap round, so a
  // `room` key anywhere else in any frame still changes the golden.
  const stripRoom = (view, ended) => {
    for (const round of view.recap?.rounds ?? []) if ('room' in round) { assert.ok(ended, 'room appeared before End'); roomKeys++; delete round.room; }
    return view;
  };
  const strip = (value, ended) => JSON.parse(JSON.stringify(value), (key, v) => {
    if (!CARD40.has(key)) return v;
    assert.ok(ended, `${key} appeared before End`);
    card40Keys++;
    return undefined;
  });
  // CASE-313 branch badge: the projector's top-level `decisionBranches` and the phone's `decision.branches` are stripped only
  // where they may appear (true, beside an on-screen question), so the key anywhere else, or false, still changes the golden.
  let branchKeys = 0;
  const stripBranches = view => {
    if ('decisionBranches' in view) { assert.equal(view.decisionBranches, true); assert.ok(view.decision, 'badge without a question'); branchKeys++; delete view.decisionBranches; }
    if (view.decision && 'branches' in view.decision) { assert.equal(view.decision.branches, true); branchKeys++; delete view.decision.branches; }
    return view;
  };
  // CASE-334 room music: the projector's top-level `music` (choice, Build and the decision transport) is stripped from display
  // views only, after checking its public shape, so the key on a phone view or a private field inside it still changes the golden.
  let musicKeys = 0;
  const stripMusic = view => {
    if (!view || !('music' in view)) return view;
    assert.deepEqual(Object.keys(view.music).sort(), ['choice', 'effects', 'intensity', 'playing', 'transport', 'volume']);
    if (view.music.transport) assert.deepEqual(Object.keys(view.music.transport).filter(k => k !== 'closing').sort(), ['atMs', 'draw', 'originMs', 'tier', 'trackId']);
    musicKeys++; delete view.music; return view;
  };
  for (const state of states) {
    const ended = state.phase === 'ended';
    hash.update(JSON.stringify(strip(stripMusic(stripBranches(project(state, 'display'))), ended)));
    hash.update(JSON.stringify(legacyRecap(strip(stripRoom(stripBranches(project(state, 'participant', pid)), ended), ended))));
    const { caseDoc, ...mirror } = state;
    const frame = projectorFrame({ t: 'snapshot', view: project(state, 'facilitator'), mirror,
      epoch: state.epoch, revision: state.revision, displayRevision: state.display.revision }, caseDoc);
    if (frame?.view) stripMusic(stripBranches(frame.view));
    hash.update(JSON.stringify(strip(frame, ended)));
  }
  assert.ok(branchKeys > 0, 'the walk opens a branching question, so the badge keys were exercised');
  assert.ok(musicKeys > 0, 'every display view carries the music key, so the strip was exercised');
  assert.ok(card40Keys > 0, 'the walk reaches End, so the card 40 keys were exercised');
  assert.ok(roomKeys > 0, 'the walk reaches a shown, resolved round after End, so the room split was exercised');
  assert.equal(hash.digest('hex'), GOLDEN);
  assert.equal(classified, 136, 'only the known legacy resolved recap rows gain evidence classification');
});

test('[card 37] item 3: option tiles use the participant marks, and private callouts live only in the console room module', () => {
  const source = ["console-room.mjs","teaching-controls.mjs"].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
  assert.match(source, /import \{ markFor, markSvg \} from '\.\/projector-marks\.mjs';/);
  assert.match(source, /function optionTile\(option, index/);
  assert.match(source, /`opt-tile console-option/);
  assert.match(source, /markSvg\(index, \{ size: 36, decorative: true \}\)/);
  assert.match(source, /markFor\(index\)\.name/);
  for (const file of ['console-focus.mjs', 'console-actions.mjs', 'console-projection.mjs', 'projector.mjs', 'phone.mjs'])
    assert.doesNotMatch(readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'), /console-callout|rationale/, file);
});

test('[card 37] red team H1 (re-check): a kept control takes the fresh render\'s handlers, and keeps its typed value and pick', () => {
  const tree = (handler, pick) => { const root = e('div', {}, e('input', { type: 'text' }), e('button', { type: 'button' }, t('Next results page')),
    e('select', {}, e('option', {}, t('No timer')), e('option', {}, t('2 minutes'))));
    root.childNodes[1].onclick = handler; root.childNodes[2].onchange = handler; root.childNodes[1].onkeydown = handler;
    if (pick) root.childNodes[2].childNodes[1].selected = true; return root; };
  const first = () => 'page 1', second = () => 'page 2';
  const live = tree(first, true), [input, button, select] = live.childNodes;
  input.value = 'ABCD 2345';
  patchChildren(live, tree(second, false));
  assert.equal(live.childNodes[1], button, 'an unchanged button is kept (no re-announcement, focus stays)');
  assert.equal(button.onclick, second, 'and it runs the fresh render\'s handler (red team H1)');
  assert.equal(button.onkeydown, second); assert.equal(select.onchange, second);
  assert.equal(live.childNodes[0], input); assert.equal(input.value, 'ABCD 2345', 'a typed code survives a render');
  assert.equal(live.childNodes[2], select); assert.equal(select.childNodes[1].selected, true, 'a picked option survives a render');
  // A server-driven selection is an attribute, so a changed one still replaces the option.
  assert.equal(sameNode(e('option', { selected: '' }, t('a')), e('option', {}, t('a'))), false);
});

test('[card 37] red team H1 (re-check): console controls take handlers as properties and read the live control at the press', () => {
  const room = ["console-room.mjs","teaching-controls.mjs"].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
  const tab = readFileSync(new URL('../src/client/console-room-tab.mjs', import.meta.url), 'utf8');
  const ranking = readFileSync(new URL('../src/client/console-ranking.mjs', import.meta.url), 'utf8');
  assert.match(room, /item\.onclick = action;/);
  assert.doesNotMatch(room, /item\.addEventListener\('(click|keydown)'/);
  assert.doesNotMatch(ranking, /select\.addEventListener\('change'/);
  assert.match(ranking, /event\.currentTarget\.value/);
  assert.doesNotMatch(tab, /codeInput\.value|timer\.value/, 'Approve and Set timer read the live control, not the render\'s');
  // Focus keys never come from a label alone where labels repeat (two people, several routes).
  assert.match(tab, /armable\(`remove-\$\{person\.id\}`/);
  assert.match(tab, /keyed\(`rename-\$\{person\.id\}`/);
  assert.match(room, /dataset\.focusKey = `route-\$\{path\.id\}`/);
});

test('[card 37] red team L2: a refused show_lobby leaves no pending view to clear (console layout v2: no Lobby tab)', () => {
  const source = readFileSync(new URL('../src/client/console-room.mjs', import.meta.url), 'utf8');
  // The join-screen state is read from the room (view.display.lobby) on every render; nothing local waits on a reply.
  assert.doesNotMatch(source, /wantLobby/);
  assert.match(source, /const lobbyShown = view\.display\?\.lobby === true;/);
});

test('[card 37] re-check b and c: no listener in the patched Room tab or ranked controls; a refused ranked change shows the room\'s choice again', () => {
  const tab = readFileSync(new URL('../src/client/console-room-tab.mjs', import.meta.url), 'utf8');
  const render = tab.slice(tab.indexOf('export function peopleFaces'), tab.indexOf('\nconst BROWSERS'));
  assert.ok(render.length > 500, 'the setup cards were sliced');
  assert.doesNotMatch(render, /addEventListener/, 'setup card nodes are patched: property handlers only');
  assert.doesNotMatch(readFileSync(new URL('../src/client/console-ranking.mjs', import.meta.url), 'utf8'), /addEventListener/);
  const room = ["console-room.mjs","teaching-controls.mjs"].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
  assert.match(room, /function showRankedChoice\(\)/);
  // Both refusal paths, online and manual, put the select back on the authority's selection.
  assert.equal([...room.matchAll(/if \(type === 'ranked_page'\) showRankedChoice\(\);/g)].length, 2);
});


test('[audit] an unconfirmed command timeout describes uncertainty rather than claiming failure', () => {
  assert.equal(refusedCommandNotice(undefined, 'timeout'), 'No confirmation from the session. Check the case before continuing.');
  assert.equal(refusedCommandNotice('stale_revision', 'rejected'), 'The session changed. Refreshing its state.');
});
