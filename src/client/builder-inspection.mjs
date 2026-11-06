// Run preview (preview overhaul, CASE-226; replaces the Live/Rehearse window of cards 52 and 57). The Builder opens one
// same-origin child synchronously from the click; this lazy module mounts into it and runs the draft like a live room:
// - Stage: the real projector renderer, fed the display projection, inside a frame of the real target size (1280×720
//   or 1920×1080, scaled to fit).
// - Phone: the real participant renderer for one simulated learner at a time, at 390×844. Its answers go to that learner.
// - Facilitator: the console's own teaching controls and dock, plus Jump to stage, Simulate answers and Restart.
// The engine is the memory-only room machine (preview-room.mjs). Edits are followed live: each runnable edit rebuilds
// the run from the newest draft and replays it to where it was. Nothing here saves, reaches a room, or holds authority.
import { adoptStyles } from './adopt-styles.mjs';
import { standardsPage } from './shell.mjs';
import { PreviewRoom, MAX_LEARNERS } from './preview-room.mjs';
import { buildScreen, createProjectorRenderer } from './projector-render.mjs';
import { buildPhoneScreen, createPhoneRenderer, PHONE_COPY } from './phone-render.mjs';
import { prepareBuilderPreviewSnapshot } from './builder-preview-snapshot.mjs';
import { validateRuntimeDocument } from '../shared/runtime-document.mjs';
import { dockControl, refusedCommandNotice, armedRoute, armsFirst } from './console-actions.mjs';
import { phaseModel } from './console-view.mjs';
import { renderAggregate, renderRoutes, renderTeachingDock, renderTeachingSecondary, renderOnlyYou } from './teaching-controls.mjs';
import { patchChildren } from './console-focus.mjs';
import { presentationNav } from './presentation-nav.mjs';
import { facilitatorKey, confirmAction } from './keymap.mjs';
import { enhanceSelect } from './accessible-select.mjs';
import { caseWords } from './builder-issue-words.mjs';
import { uuidv7 } from '../shared/ids.mjs';

const PHONE = [390, 844];
const VIEWS = Object.freeze({ 'projector-720': ['720p', 1280, 720], 'projector-1080': ['1080p', 1920, 1080] });
// CASE-249 (Julian, 2026-10-14): the projector and a phone side by side, controls and notes below. The phone is drawn at
// .9 (about 14 px text) with its own scroll; the projector fills the rest at true 16:9, leaving the controls' first
// lines and the dock on screen. Where that would draw the projector under PROJECTOR_MIN px wide, the phone is shown on
// demand in the projector's place instead (the board's fallback).
const PHONE_SCALE = .9, PROJECTOR_MIN = 720, BELOW = 200;
/** The library's check for a published pack: the runtime validator, with the slide check for slide cases. */
async function validatePublished(document) {
  const options = document?.schema_version === 3 ? { validateSlides: (await import('./builder-slide-check.mjs')).validateSlideParts } : {};
  const checked = validateRuntimeDocument(document, options);
  return checked.ok ? { ok: true, document } : { ok: false, issues: checked.errors };
}
const el = (doc, tag, text, cls) => { const node = doc.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
const BLOCK_KINDS = Object.freeze({ text: 'Text', list: 'List', quote: 'Quote', callout: 'Callout', values: 'Values', table: 'Table', timeline: 'Timeline', trend: 'Trend chart', gas: 'Blood gas', question: 'Question' });
const stageName = (document, beatId, pathId) => {
  const beat = (document.beats ?? []).find(item => item.id === beatId);
  const path = pathId && (document.decisions ?? []).flatMap(item => item.paths ?? []).find(item => item.id === pathId);
  return path ? `${beat?.title || 'Untitled stage'} · ${path.label || 'Untitled consequence'}` : beat?.title || 'Untitled stage';
};
// The editor's selection as a Jump to value: a stage, `stage|consequence`, or `stage#clarification` (D15).
const editorTarget = s => !s?.beatId ? null : s.clarificationId ? `${s.beatId}#${s.clarificationId}` : s.pathId ? `${s.beatId}|${s.pathId}` : s.beatId;

/**
 * Mount the Run preview into an already-open child window. `validate(document, metadata)` admits a runnable document
 * (a Builder draft by default; the library passes 'published', the published-pack check) and `label` replaces the edit-following
 * status for a document that never changes. `update` takes the newest committed pair and selection; a
 * burst is taken once. The child closing or navigating, the Builder page hiding, an account change or `close` stop it
 * once; a stopped controller never renders again.
 */
export function mountInspection(child, { ownerWindow, sourceDocument, auth, inline = false, onRetired = () => {},
  validate = (document, metadata) => prepareBuilderPreviewSnapshot(document, metadata), label = null }) {
  if (validate === 'published') validate = validatePublished;
  // R10: a standards-mode page before anything is drawn, as the room's own pages are (CASE-249).
  const doc = standardsPage(child.document), generation = auth?.sessionGeneration?.() ?? 0;
  let retired = false, pending = null, scheduled = false, revision = 0, shown = 0, taken = 0, ticket = 0;
  let room = null, mode = 'online', learners = 4, size = 'projector-720', learnerIndex = 0, last = null, notice = '', feedback = '', dirty = false;
  // A phone shown on demand (narrow windows); private notes opened for this run; whether routes were on screen.
  let phoneOpen = false, notesOpen = false, routesShown = false, armedUntil = 0, armTimer;
  // Run-level news (jumps, rebuilds) goes in the header status; the result of a control goes in the dock, once.
  const routeNotes = new Set();
  doc.title = label ? 'Preview · Case' : 'Preview · Create';
  const windowStyled = adoptStyles(doc, sourceDocument);
  const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; doc.head.append(viewport);
  const button = (label, onClick, cls = 'btn quiet') => { const b = el(doc, 'button', label, cls); b.type = 'button'; b.addEventListener('click', onClick); return b; };

  // ── chrome: title and status, then one control row in three groups (R1) ──
  const root = el(doc, 'div', null, 'run-preview'); if (inline) root.dataset.inline = 'true';
  const header = el(doc, 'header', null, 'run-preview-head');
  const titles = el(doc, 'div', null, 'run-preview-titles');
  const caseTitle = el(doc, 'h1', inline ? 'Preview · shown here' : 'Preview');
  const status = el(doc, 'p', 'Preparing preview…', 'run-preview-status'); status.setAttribute('role', 'status');
  titles.append(caseTitle, status);
  const tools = el(doc, 'div', null, 'run-preview-tools');
  const group = (cls, label) => { const box = el(doc, 'div', null, `run-preview-group ${cls}`); if (label) { box.setAttribute('role', 'group'); box.setAttribute('aria-label', label); } tools.append(box); return box; };
  const where = group('run-preview-where'), setup = group('run-preview-setup');
  // Case's own dropdown (Julian, 2026-10-12: no device-default dropdowns); the hidden native select keeps the value.
  const enhanced = [];
  const select = (label, text, onChange) => {
    const box = el(doc, 'label', null, 'run-preview-field'), input = el(doc, 'select');
    input.setAttribute('aria-label', label); input.addEventListener('change', () => onChange(input.value));
    box.append(el(doc, 'span', text), input); where.append(box);
    // A document that cannot host the enhanced control keeps the working native select.
    try { const api = enhanceSelect(input, { label }); enhanced.push(api); doc.getElementById(api.trigger.getAttribute('aria-controls'))?.classList.add('run-preview-options'); } catch { /* native select */ }
    return input;
  };
  // Options are rebuilt only when the choices change, so an open list is never redrawn under the pointer.
  const fill = (input, list, value) => { const key = JSON.stringify(list); if (input.dataset.choices === key) { if (input.value !== value) input.value = value; return; } input.dataset.choices = key; input.replaceChildren(...list.map(([key, name]) => { const option = el(doc, 'option', name); option.value = key; return option; })); input.value = value; };
  const jump = select('Jump to stage', 'Jump to', value => jumpTo(value));
  // Shown only while the run is elsewhere; the stage's name is its tooltip (R1c).
  const editorJump = button('', () => jumpTo(editorTarget(last?.selection)), 'btn quiet run-preview-editor-jump');
  editorJump.append(el(doc, 'span', "Go to editor's stage", 'run-preview-long'), el(doc, 'span', "Editor's stage", 'run-preview-short'));
  editorJump.hidden = true; where.append(editorJump);
  // Learners is a stepper (R1a); room mode and projector size are segmented controls (R1b).
  const stepper = el(doc, 'div', null, 'run-preview-stepper'); stepper.setAttribute('role', 'group'); stepper.setAttribute('aria-label', 'Learners');
  const fewer = button('−', () => { if (learners > 0) { learners--; remake(); } }), more = button('+', () => { if (learners < MAX_LEARNERS) { learners++; remake(); } });
  fewer.setAttribute('aria-label', 'Fewer learners'); more.setAttribute('aria-label', 'More learners');
  const learnerText = el(doc, 'span', '', 'run-preview-count'); learnerText.setAttribute('aria-live', 'polite');
  stepper.append(fewer, learnerText, more); setup.append(stepper);
  const segmented = (label, choices, pick) => {
    const box = el(doc, 'div', null, 'run-preview-segments'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', label);
    for (const [value, text] of choices) { const b = button(text, () => pick(value)); b.dataset.value = value; box.append(b); }
    setup.append(box); return box;
  };
  const modeGroup = segmented('Session mode', [['online', 'Online'], ['manual', 'Manual']], value => { if (mode !== value) { mode = value; remake(); } });
  const sizeGroup = segmented('Projector', Object.entries(VIEWS).map(([key, [name]]) => [key, name]), value => { if (size !== value) { size = value; draw(); } });
  // Restart is an action, not a third mode (round 18): it sits apart at the row's end.
  const restartRun = () => { if (room) { room.restart(); accepted.clear(); notice = 'Restarted in the lobby.'; feedback = ''; draw(); } };
  const restart = button('↺ Restart preview', restartRun, 'btn quiet run-preview-restart');
  restart.setAttribute('aria-label', 'Restart preview'); restart.setAttribute('aria-keyshortcuts', 'Escape'); tools.append(restart);
  header.append(titles, tools);

  // ── body: projector and phone side by side; learner chips; controls and private notes below ──
  const body = el(doc, 'div', null, 'run-preview-body');
  const stage = el(doc, 'section', null, 'run-preview-stage'); stage.setAttribute('aria-label', 'Projector');
  const stageHost = el(doc, 'div', null, 'run-preview-frame'), stageFrame = doc.createElement('iframe'); stageFrame.title = 'Projector'; stageFrame.tabIndex = -1; // nothing to press on a projector (CASE-251)
  // While the draft cannot run, the projector's place says why in words, not as an empty frame (round 21).
  const blocked = el(doc, 'p', '', 'run-preview-blocked'); blocked.hidden = true;
  stageHost.append(stageFrame); stage.append(blocked, stageHost);
  const phones = el(doc, 'section', null, 'run-preview-phones'); phones.setAttribute('aria-label', 'Phone');
  const phoneHost = el(doc, 'div', null, 'run-preview-frame run-preview-phone'), phoneFrame = doc.createElement('iframe'); phoneFrame.title = 'Phone';
  const closePhone = button('Back to the projector', () => { phoneOpen = false; draw(); }, 'btn quiet run-preview-close-phone');
  phoneHost.append(phoneFrame); phones.append(closePhone, phoneHost);
  // One chip per simulated learner (R3): their name and whether they have answered; a chip shows that learner's phone.
  const learnerTabs = el(doc, 'div', null, 'run-preview-learners'); learnerTabs.setAttribute('role', 'group'); learnerTabs.setAttribute('aria-label', 'Phone of');
  const rail = el(doc, 'section', null, 'run-preview-rail'); rail.setAttribute('aria-label', 'Facilitator');
  const railBody = el(doc, 'div', null, 'console-col console-only-you'), dockSlot = el(doc, 'div', null, 'run-preview-dock');
  rail.append(railBody, dockSlot);
  const notesSlot = el(doc, 'section', null, 'run-preview-notes'); notesSlot.setAttribute('aria-label', 'Private notes');
  body.append(stage, phones, learnerTabs, rail, notesSlot);
  root.append(header, body);
  doc.body.replaceChildren(root);

  // ── frames: styles adopted without network; the renderers draw into them ──
  let framesReady = false, projector = null, phone = null, phoneFor = null, roomArt = null;
  // D28: the Builder's images (its canvas resolver, `media` in each update), in the preview room's image map under
  // handles minted here, so the room's reveal gate decides when each shows. Quarantined images show, as on the canvas.
  let pictures = null, roomImages = null;
  const handles = new Map(), assets = new Map();
  function imageMap(document) {
    if (!pictures) return null;
    const out = {}, size = value => Number.isSafeInteger(value) && value >= 16 && value <= 4096;
    for (const block of document.blocks ?? []) {
      if (block?.type !== 'image' || !block.asset_id || Object.hasOwn(out, block.asset_id) || Object.keys(out).length >= 64) continue;
      const found = pictures.resolve(block);
      if (found?.state === 'withdrawn') { out[block.asset_id] = { state: 'withdrawn' }; continue; }
      if (!size(found?.width) || !size(found?.height)) continue;
      if (!handles.has(block.asset_id)) { const handle = uuidv7(); handles.set(block.asset_id, handle); assets.set(handle, block.asset_id); }
      // A video is drawn as the canvas draws it, by its poster; only a room plays media.
      out[block.asset_id] = { handle: handles.get(block.asset_id), width: found.width, height: found.height, credit: found.attribution ? String(found.attribution).slice(0, 300) : null, type: 'image/jpeg', durationMs: null };
    }
    return out;
  }
  const resolveImage = block => block.media?.state === 'withdrawn' ? { state: 'withdrawn' } : assets.has(block.media?.handle) ? pictures?.resolve({ asset_id: assets.get(block.media.handle) }) ?? null : null;
  const phoneMedia = { resolve: resolveImage, get generation() { return pictures?.generation ?? 0; } };
  const accepted = new Map(); // learner id → { roundId, response }: the answer that phone saved
  // A phone shows "saved" only while the room still holds that answer in the open round (a rebuild can drop it).
  const savedFor = id => { const saved = accepted.get(id), round = room?.state?.round; return saved && round?.id === saved.roundId && round.responses?.[id] ? saved : null; };
  Promise.all([windowStyled, stageFrame.contentDocument && adoptStyles(stageFrame.contentDocument, sourceDocument),
    phoneFrame.contentDocument && adoptStyles(phoneFrame.contentDocument, sourceDocument)].map(step => Promise.resolve(step).catch(() => null)))
    .then(() => { framesReady = true; draw(); });
  function stageRenderer() {
    if (projector || !stageFrame.contentDocument) return projector;
    const fdoc = stageFrame.contentDocument, { root: screen, parts } = buildScreen(fdoc);
    fdoc.body.className = 'projector'; fdoc.body.replaceChildren(screen);
    projector = { screen, ...createProjectorRenderer({ doc: fdoc, parts, origin: ownerWindow.location.origin, preview: true, onReady: () => draw(), media: resolveImage }) };
    return projector;
  }
  // The phone renderer uses fixed ids, so one phone frame shows one learner at a time; switching learners redraws it.
  function phoneRenderer(learner) {
    if (phone && phoneFor === learner.id) return phone;
    phone?.dispose(); phone = null; phoneFor = learner.id;
    const fdoc = phoneFrame.contentDocument;
    if (!fdoc) return null;
    fdoc.documentElement.classList.add('phone-page'); fdoc.body.className = 'phone-page';
    const { root: screen, parts } = buildPhoneScreen(fdoc);
    fdoc.body.replaceChildren(screen);
    // The preview's phone never moves focus: the facilitator's keys belong to the page around it (CASE-251).
    phone = createPhoneRenderer({ doc: fdoc, parts, manageFocus: false, media: phoneMedia,
      onAnswer: response => answer(learner, response),
      delivery: { state: () => ({ online: true, enqueuing: 0, pending: null, accepted: savedFor(learner.id),
        message: savedFor(learner.id) ? { kind: 'ok', text: PHONE_COPY.saved } : null, queueFailed: false, locked: false }),
        round: () => {}, reconcile: () => {} } });
    phone.mount();
    return phone;
  }
  // Nested blank frames do not reliably load their own images (as with fonts in adoptStyles): each avatar is fetched
  // once by this page and handed to the frames as a data URL, which the page's img-src allows. A slide image is already
  // a blob: handle, which img-src allows and connect-src would refuse to fetch, so it is left as it is.
  const images = new Map();
  function inlineImages(fdoc) {
    for (const image of fdoc?.querySelectorAll('img') ?? []) {
      const url = image.getAttribute('src');
      if (!url || /^(data|blob):/.test(url)) continue;
      const cached = images.get(url);
      if (typeof cached === 'string') { image.src = cached; continue; }
      if (cached) continue;
      images.set(url, ownerWindow.fetch(url).then(response => response.ok ? response.blob() : null).then(blob => blob && new Promise(resolve => {
        const reader = new ownerWindow.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(blob);
      })).then(data => { if (data) { images.set(url, data); if (alive()) draw(); } }, () => {}));
    }
  }
  function answer(learner, response) {
    if (!alive() || !room) return;
    if (room.vote(learner.id, response)) {
      // As on the live phone's receipt: the saved answer ends the card's editing state.
      accepted.set(learner.id, { roundId: room.state.round.id, response }); phone?.decision.accepted(room.view('participant', learner.id).decision, response);
      feedback = `${learner.name} answered from the phone.`;
    }
    else feedback = `${learner.name}'s answer was not accepted. ${refusedCommandNotice(room.reason)}`;
    draw();
  }

  // ── lifecycle ──
  const mounted = () => { try { return !child.closed && child.document === doc; } catch { return false; } };
  const alive = () => !retired && mounted() && (auth?.sessionGeneration?.() ?? 0) === generation;
  const retire = () => {
    if (retired) return; retired = true; pending = null; last = null;
    // The room art runs timers and observers in this (the Builder's) realm: stop it as the projector does on close.
    if (projector && roomArt?.projectorArt) { try { roomArt.projectorArt(projector.screen, null); } catch { /* decorative */ } }
    room?.close(); room = null; phone?.dispose(); phone = null; accepted.clear(); routeNotes.clear();
    for (const api of enhanced.splice(0)) api.dispose();
    child.removeEventListener?.('pagehide', retire); child.removeEventListener?.('resize', onResize); doc.removeEventListener?.('keydown', onKey); ownerWindow.clearTimeout?.(armTimer); ownerWindow.removeEventListener?.('pagehide', closeChild); ownerWindow.removeEventListener?.('pageshow', onShow);
    if (timer !== undefined) ownerWindow.clearInterval?.(timer);
    onRetired();
  };
  const closeChild = () => { retire(); if (!inline) try { if (!child.closed) child.close(); } catch { /* already gone */ } };
  const onResize = () => { if (alive() && room && framesReady) scaleFrames(); };
  child.addEventListener?.('pagehide', retire, { once: true });
  child.addEventListener?.('resize', onResize);
  // The shared keymap (CASE-249): the live console's keys, because the Run preview behaves as the live console does.
  const onKey = event => {
    if (!alive() || !room) return;
    const view = room.view(), nav = presentationNav(view);
    const action = facilitatorKey(event, { hasMoreGroup: view.actions.includes('advance') && Boolean(view.presentation?.nextGroup),
      replaying: nav.replaying, canReplayForward: nav.canForward, canReplayBack: nav.canBack });
    if (!action) return;
    event.preventDefault();
    if (action === 'advance') pressPrimary({ fromKey: true });
    else if (action === 'reveal_group') roomCommand('advance');
    else if (action === 'replay_back') roomCommand('replay', { entryIndex: nav.backTarget });
    else if (action === 'replay_forward') roomCommand('replay', { entryIndex: nav.forwardTarget });
    else if (action === 'undo') { const undo = rail.querySelector('.console-undo'); if (undo && undo.getAttribute('aria-disabled') !== 'true') undo.click(); }
    // Escape closes the topmost open panel (a phone shown on demand, then opened notes); with none, it asks to Restart.
    else if (action === 'escape') {
      if (phoneOpen && root.dataset.layout !== 'side') { phoneOpen = false; draw(); }
      else if (notesOpen) { notesOpen = false; draw(); }
      else confirmAction(doc, { title: 'Restart preview?', body: 'Preview goes back to Lobby with simulated participants. Your draft is unchanged.', action: 'Restart preview', onConfirm: restartRun });
    } else if (action === 'help') import('./keymap-sheet.mjs').then(sheet => { if (alive()) sheet.shortcutSheet(doc, 'preview'); }, () => {});
  };
  doc.addEventListener?.('keydown', onKey);
  ownerWindow.addEventListener?.('pagehide', closeChild, { once: true });
  // A page restored from the back/forward cache revalidates before anything renders again (BWR11).
  const onShow = event => { if (event.persisted && (auth?.sessionGeneration?.() ?? 0) !== generation) closeChild(); };
  ownerWindow.addEventListener?.('pageshow', onShow);
  // Liveness, and the countdown: an account change closes the window; a running timer redraws its seconds.
  let ticks = 0;
  const timer = ownerWindow.setInterval?.(() => {
    if ((auth?.sessionGeneration?.() ?? 0) !== generation) { closeChild(); return; }
    if (!mounted()) { retire(); return; }
    if (++ticks % 4 === 0 && room?.state?.timer) { phone?.tick(); projector?.renderTop(room.view('display'), 'server'); }
  }, 250);

  // ── the run ──
  /** A new engine for a mode or learner count, replayed to the stage the run was on. */
  function remake() {
    if (!last?.runnable) { draw(); return; }
    const at = room?.state && room.state.phase !== 'lobby' ? { beatId: room.state.beatId, pathId: room.state.revealed.at(-1)?.pathId ?? null } : null;
    room?.close(); accepted.clear(); phone?.dispose(); phone = null;
    room = new PreviewRoom(last.runnable, { mode, learners, media: roomImages });
    learnerIndex = Math.min(learnerIndex, Math.max(0, learners - 1));
    notice = at && !room.jumpTo(at) ? 'Started again in the lobby: that stage cannot be reached in this mode.' : '';
    draw();
  }
  function jumpTo(value) {
    if (!room || !value) return;
    accepted.clear(); feedback = '';
    if (value === 'lobby') { room.restart(); notice = 'Restarted in the lobby.'; draw(); return; }
    const [stage, clarificationId = null] = value.split('#'), [beatId, pathId = null] = stage.split('|'), name = stageName(room.doc, beatId, pathId);
    notice = room.jumpTo({ beatId, pathId }) ? replayed({ beatId, pathId, clarificationId })
      : room.reason === 'search_limit' ? `No route to ${name} was found within the search limit; the run is unchanged. Step there with the dock.`
      : `${name} cannot be reached from the start along any route; the run is unchanged.`;
    draw();
  }
  /** What a replay says; a clarification open in the editor (D15) is shared there too, once responses open. */
  function replayed({ beatId, pathId, clarificationId }) {
    const name = `“${room.doc.clarifications?.find(item => item.id === clarificationId)?.label || 'Untitled clarification'}”`;
    return `Replayed the route to ${stageName(room.doc, beatId, pathId)}.${!clarificationId ? '' : room.showClarification(clarificationId) ? ` Shared ${name}.` : ` ${name} is shared once responses open.`}`;
  }
  /** A refusal in the Builder's words (round 12): records by name, schema words as authors know them. */
  function issueText(document, issue) {
    if (!issue?.message) return 'The draft needs repair; Readiness lists what to fix.';
    // A case-wide field is named as Readiness names it (round 29 P1-2), never "Length must be 1–1200" alone.
    const named = caseWords(issue, document, null);
    if (named) return `${named} (in Case details)`;
    const cap = issue.at === '/beats' ? /1[–-](\d+) items/.exec(issue.message)?.[1] : null;
    if (cap) return `this case has ${(document?.beats ?? []).length} stages; a room runs at most ${cap}`;
    const names = new Map((document?.beats ?? []).map(beat => [beat.id, `“${beat.title || 'Untitled stage'}”`]));
    for (const decision of document?.decisions ?? []) for (const path of decision?.paths ?? []) names.set(path.id, `“${path.label || 'Untitled consequence'}”`);
    for (const clarification of document?.clarifications ?? []) names.set(clarification.id, `“${clarification.label || 'Untitled clarification'}”`);
    // A block's problem names its slide and kind (round 21), so the author knows where to go: “D7” · Table block: …
    const index = /^\/blocks\/(\d+)/.exec(issue.at ?? '')?.[1], block = index === undefined ? null : document?.blocks?.[Number(index)];
    const slide = block && (document?.compositions ?? []).find(item => item.reading_order?.includes(block.id));
    // A slide-level problem (an unplaced block, a missing placement) names its slide too (round 22).
    const slideIndex = /^\/compositions\/(\d+)/.exec(issue.at ?? '')?.[1], owned = slideIndex === undefined ? null : document?.compositions?.[Number(slideIndex)];
    // A stage's own field, or its learner content's, names the stage (round 23): “Untitled stage”: name this stage.
    const [, kind, at] = /^\/(beats|surfaces)\/(\d+)/.exec(issue.at ?? '') ?? [], record = kind && document?.[kind]?.[Number(at)];
    const stage = record && (kind === 'beats' ? record : (document?.beats ?? []).find(beat => beat.surface_id === record.id));
    // A decision's field names its stage, and a consequence's field the consequence (r24 P2-1).
    const [, ask, route] = /^\/decisions\/(\d+)(?:\/paths\/(\d+))?/.exec(issue.at ?? '') ?? [], decision = ask && document?.decisions?.[Number(ask)];
    const owner = route ? decision?.paths?.[Number(route)]?.id : decision && (document?.beats ?? []).find(beat => beat.decision_id === decision.id)?.id;
    const where = block ? `${slide ? `${names.get(slide.owner?.id) ?? 'A slide'} · ` : ''}${BLOCK_KINDS[block.type] ?? 'A'} block: ` : owned ? `${names.get(owned.owner?.id) ?? 'A slide'}: ` : stage ? `${names.get(stage.id)}: ` : names.has(owner) ? `${names.get(owner)}: ` : '';
    return where + issue.message.replace(/\b(?:beat|path) ([0-9a-f]{8}-[0-9a-f-]{27})\b/g, (whole, id) => names.get(id) ?? whole)
      .replace(/\bstart_beat_id\b/g, 'the first stage').replace(/\bpaths\b/g, 'consequences').replace(/\bpath\b/g, 'consequence').replace(/\bbeats\b/g, 'stages').replace(/\bbeat\b/g, 'stage');
  }
  /** Take the newest pair: a runnable draft rebuilds the run and replays it; anything else keeps the last run. */
  async function take(next, at) {
    const mine = ++ticket;
    const checked = await Promise.resolve().then(() => validate(next.document, next.metadata ?? { metadata_version: 1 })).catch(() => ({ ok: false, issues: [] }));
    if (!alive() || mine !== ticket) return;
    last = { selection: { beatId: null, pathId: null, clarificationId: null, ...next.selection }, runnable: checked.ok ? checked.document : last?.runnable ?? null,
      issue: checked.ok ? null : issueText(next.document, checked.issues?.[0]) };
    dirty = Boolean(next.dirty); pictures = next.media ?? null;
    if (checked.ok) roomImages = imageMap(checked.document);
    if (checked.ok && !room) {
      room = new PreviewRoom(checked.document, { mode, learners, media: roomImages });
      // The first run starts where the author is: the selected stage, replayed from the start.
      if (last.selection.beatId && room.jumpTo(last.selection)) notice = replayed(last.selection);
    } else if (checked.ok) {
      room.media = roomImages;
      const result = room.rebuild(checked.document);
      if (result.stopped) notice = 'Your edit removed the stage this run was on, so it went back to the last stage that still applies.';
      else if (result.moved) notice = 'Your edit changed earlier stages, so the run was replayed to where you were.';
    }
    taken = at;
    draw();
  }

  // ── drawing ──
  /** Side by side when the projector keeps PROJECTOR_MIN px beside a .9 phone; else the phone takes the projector's place on demand. */
  function scaleFrames() {
    const [, width, height] = VIEWS[size], wide = header.clientWidth || width, gap = 16, phoneWidth = PHONE[0] * PHONE_SCALE;
    // The pair leaves the chips, the controls' first lines and the dock on screen (R2, R8).
    const tall = Math.max(180, (child.innerHeight || 800) - header.offsetHeight - 40 - BELOW);
    const side = room.learners.length > 0 && wide - phoneWidth - gap >= PROJECTOR_MIN;
    if (side) phoneOpen = false;
    const stageWidth = Math.floor(Math.min(side ? wide - phoneWidth - gap : wide, tall * width / height));
    const set = (frame, host, w, h, scale) => {
      frame.width = String(w); frame.height = String(h);
      frame.style.transform = `scale(${scale})`; frame.style.transformOrigin = 'top left';
      host.style.width = `${Math.round(w * scale)}px`; host.style.height = `${Math.round(h * scale)}px`;
    };
    set(stageFrame, stageHost, width, height, stageWidth / width);
    const scale = Math.min(PHONE_SCALE, wide / PHONE[0]), shown = side ? stageWidth * height / width : Math.max(stageWidth * height / width, Math.min(tall, PHONE[1] * scale));
    set(phoneFrame, phoneHost, PHONE[0], Math.round(shown / scale), scale);
    root.dataset.layout = side ? 'side' : 'stack';
    root.style.setProperty('--run-stage', `${stageWidth}px`); root.style.setProperty('--run-phone', `${Math.round(PHONE[0] * scale)}px`);
    stage.hidden = !side && phoneOpen; phones.hidden = !side && !phoneOpen; closePhone.hidden = side;
  }
  function drawStage() {
    const renderer = stageRenderer();
    if (!renderer) return;
    const view = room.view('display');
    renderer.renderTop(view, 'server');
    renderer.renderMain(view, renderer.placements(view)[0]);
    renderer.renderFooter(view);
    renderer.fit(view);
    renderer.fitNames();
    // The room art is decorative and lazy, as on the projector; a failed load leaves the plain ground.
    if (roomArt?.projectorArt) { try { roomArt.projectorArt(renderer.screen, view); } catch { /* decorative */ } }
    else roomArt ||= import('./splash.mjs').then(chunk => { roomArt = chunk; if (alive()) draw(); }, () => { roomArt = {}; });
  }
  function drawPhone() {
    const list = room.learners, round = room.state.round, chips = el(doc, 'div');
    list.forEach((learner, index) => {
      const answered = Boolean(round?.responses?.[learner.id]);
      const b = button('', () => { learnerIndex = index; phoneOpen = true; draw(); }, 'btn quiet run-preview-chip'); b.dataset.focusKey = `learner-${index}`;
      b.setAttribute('aria-pressed', String(index === learnerIndex && (root.dataset.layout === 'side' || phoneOpen)));
      b.append(el(doc, 'span', learner.name), ...(round && room.state.phase === 'responses_open' ? [doc.createTextNode(' '), el(doc, 'small', answered ? 'answered' : 'waiting')] : []));
      chips.append(b);
    });
    patchChildren(learnerTabs, chips);
    learnerTabs.hidden = !list.length;
    if (!list.length) { phones.hidden = true; return; }
    const learner = list[learnerIndex] ?? list[0], renderer = phoneRenderer(learner);
    if (!renderer) return;
    const view = room.view('participant', learner.id);
    renderer.header('room', view); renderer.update(view); renderer.refreshDecision();
  }
  function roomCommand(type, payload) {
    if (!alive() || !room) return;
    if (!room.command(type, payload)) feedback = refusedCommandNotice(room.reason);
    else { notice = ''; feedback = ''; }
    draw();
  }
  /** The dock's control; a route reveal from Space asks twice, as on the live console: the first Space arms it for 3 s. */
  function dockFor(view) {
    return armedRoute(dockControl(view, { pickedPathId: room.selection }), armedUntil);
  }
  /** A click is one press, a route reveal included; only Space arms first (Julian, 2026-10-14, CASE-251). */
  function pressPrimary({ fromKey = false } = {}) {
    const action = dockFor(room.view());
    if (!action || action.disabled) return;
    // As on the console: the routes take focus and come into view, so a click on "Choose a route" is never silent.
    if (action.local === 'focus_resolution') { const route = rail.querySelector('.console-routes button'); route?.focus({ preventScroll: true }); route?.scrollIntoView?.({ block: 'nearest' }); return; }
    if (fromKey && armsFirst(action) && !action.armed) {
      armedUntil = Date.now() + 3_000; ownerWindow.clearTimeout?.(armTimer);
      armTimer = ownerWindow.setTimeout?.(() => { armedUntil = 0; if (alive()) draw(); }, 3_000); draw(); return;
    }
    armedUntil = 0;
    if (action.command) roomCommand(action.command, action.payload);
  }
  function drawRail() {
    const view = room.view(), control = dockFor(view), phase = phaseModel(view), command = roomCommand;
    const context = { root: rail, currentView: () => room.view(), render: draw, roomCommand: command, send: command,
      get pickedPathId() { return room.selection; }, set pickedPathId(value) {}, get routeSelection() { return room.routes; }, openRouteNotes: routeNotes, busy: false, confirm: message => child.confirm(message), recovery: null,
      get manual() { return mode === 'manual' ? { command } : null; } };
    // R4: the phase and its count on one line, with at most one secondary action. R5: the projector beside it shows
    // the prompt, so it is not repeated here.
    const fresh = el(doc, 'div'), line = el(doc, 'div', null, 'run-preview-phase');
    line.dataset.tone = view.phase === 'responses_open' ? 'open' : view.phase === 'responses_locked' ? 'locked' : '';
    line.append(el(doc, 'h2', phase.heading || 'Facilitator'));
    if (phase.count) line.append(el(doc, 'p', phase.count));
    fresh.append(line);
    // Simulate answers and the replay row share the phase line, so both stay above the dock at every width (CASE-251).
    if (view.actions.includes('lock') && !view.manual && room.learners.length) {
      const waiting = room.learners.filter(learner => !room.state.round?.responses?.[learner.id]).length;
      if (!waiting) line.append(el(doc, 'p', 'Everyone has answered', 'run-preview-done'));
      else { const simulate = button(`Simulate answers (${waiting} waiting)`, () => { if (room.simulateVotes()) feedback = 'The simulated learners answered.'; draw(); }); simulate.dataset.focusKey = 'simulate-answers'; line.append(simulate); }
    }
    // The live console's presentation replay (Back · Live surface · Forward), with ← and → (CASE-249). Phones stay live.
    if (view.actions.includes('replay')) {
      const nav = presentationNav(view), replay = el(doc, 'div', null, 'run-preview-replay'); replay.setAttribute('role', 'group'); replay.setAttribute('aria-label', 'Presentation');
      for (const [label, target, available, keys] of [['Back', nav.backTarget, nav.canBack, 'ArrowLeft'], ['Live surface', null, nav.replaying, null], ['Forward', nav.forwardTarget, nav.canForward, 'ArrowRight']]) {
        const b = el(doc, 'button', label, 'btn quiet'); b.type = 'button'; b.disabled = !available; b.dataset.focusKey = `replay-${label}`;
        if (keys) b.setAttribute('aria-keyshortcuts', keys);
        b.onclick = () => roomCommand('replay', { entryIndex: target }); replay.append(b);
      }
      line.append(replay);
    }
    const aggregate = renderAggregate(view, phase); if (aggregate) fresh.append(aggregate);
    renderRoutes(view, fresh, context);
    // R6: every other action is a quiet list; a long one keeps a short verb and puts its object on a muted line.
    const others = renderTeachingSecondary(view, control, context);
    if (view.actions.includes('show_clarification')) for (const card of view.clarifications ?? []) {
      const share = button('', () => command('show_clarification', { clarificationId: card.id }));
      share.append(el(doc, 'span', card.shared ? 'Share again' : 'Share'), doc.createTextNode(' '), el(doc, 'small', card.label)); share.dataset.focusKey = `clarification-${card.id}`;
      others.append(share);
    }
    if (others.children.length) { others.classList.add('run-preview-actions'); fresh.append(el(doc, 'h3', 'Other actions', 'run-preview-actions-head'), others); }
    patchChildren(railBody, fresh);
    // R5a and Q3: private notes start folded to two lines; opening them lasts for the run, and they fold again when
    // route choices appear, so the routes and the dock stay in reach.
    const routes = Boolean(view.decision?.paths?.length && view.actions.includes('reveal_path'));
    if (routes && !routesShown) notesOpen = false;
    routesShown = routes;
    const notes = renderOnlyYou(view), holder = el(doc, 'div');
    if (notes) {
      const head = el(doc, 'div', null, 'run-preview-notes-head'), toggle = button(notesOpen ? 'Show less' : 'Show all', () => { notesOpen = !notesOpen; draw(); }, 'btn quiet');
      toggle.setAttribute('aria-expanded', String(notesOpen)); toggle.dataset.focusKey = 'notes-toggle';
      head.append(el(doc, 'h2', 'Private notes'), toggle);
      if (!notesOpen) notes.dataset.folded = 'true';
      holder.append(head, notes);
    }
    patchChildren(notesSlot, holder); notesSlot.hidden = !notes;
    const primary = () => pressPrimary();
    const undo = () => { const v = room.view(); if (room.undoChoice()) { draw(); return; } if (v.undo?.available && v.actions.includes('undo')) command('undo', { targetEventId: v.undo.targetEventId }); };
    const dock = el(doc, 'div');
    // R7: the dock holds the main action and, only when there is something to undo, Undo named for it.
    dock.append(renderTeachingDock(view, control, { onPrimary: primary, onUndo: undo, currentView: () => room.view(), routeSelection: room.routes, feedback, omitUnavailable: true }));
    patchChildren(dockSlot, dock);
  }
  function drawChrome() {
    for (const b of modeGroup.children) b.setAttribute('aria-pressed', String(b.dataset.value === mode));
    for (const b of sizeGroup.children) b.setAttribute('aria-pressed', String(b.dataset.value === size));
    learnerText.textContent = `${learners} ${learners === 1 ? 'learner' : 'learners'}`;
    // While the draft cannot run, nothing acts on a run: its controls are disabled and the empty panels are not drawn
    // (round 29 P1-2).
    fewer.disabled = !room || learners <= 0; more.disabled = !room || learners >= MAX_LEARNERS; restart.disabled = !room;
    for (const b of [...modeGroup.children, ...sizeGroup.children]) b.disabled = !room;
    if (!room) { notesSlot.hidden = true; rail.hidden = true; learnerTabs.hidden = true; } else rail.hidden = false;
    const document = room?.doc;
    if (document) {
      caseTitle.textContent = `${inline ? 'Preview · shown here' : 'Preview'} · ${document.title || 'Untitled case'}`;
      const choices = [['lobby', 'Lobby (start)'], ...(document.beats ?? []).flatMap(beat => [[beat.id, beat.title || 'Untitled stage'],
        ...(beat.kind === 'decision' ? ((document.decisions ?? []).find(item => item.id === beat.decision_id)?.paths ?? []).map(path => [`${beat.id}|${path.id}`, `${beat.title || 'Untitled stage'} · ${path.label || 'Untitled consequence'}`]) : [])])];
      const state = room.state, entry = state.revealed.at(-1);
      const here = state.phase === 'lobby' ? 'lobby' : entry?.pathId ? `${state.beatId}|${entry.pathId}` : state.beatId;
      fill(jump, choices, choices.some(([key]) => key === here) ? here : 'lobby');
      // A clarification open in the editor is "here" while the run shows it on its stage (D15).
      const s = last?.selection, target = editorTarget(s);
      editorJump.hidden = !target || target === (state.clarification ? `${state.beatId}#${state.clarification.id}` : here) || !choices.some(([key]) => key === target.split('#')[0]);
      if (!editorJump.hidden) editorJump.title = `Jump to ${stageName(document, s.beatId, s.pathId)}, open in the editor`;
    }
    const followed = label ?? (last?.issue ? `Paused on your last runnable edit · ${last.issue}` : `Following your edits · ${dirty ? 'unsaved' : 'saved'}`);
    // While the draft cannot run, the reason is said once, in the projector's place; the status line only says the run
    // waits, so "cannot run" is never read twice (round 22, r23 P3).
    status.textContent = !room ? (last?.issue ? `${label ? 'Not running' : 'Waiting for a runnable draft'}.` : 'Preparing preview…') : `${followed}.${notice ? ` ${notice}` : ''}`;
    blocked.hidden = Boolean(room) || !last?.issue; stageHost.hidden = phones.hidden = !blocked.hidden;
    if (!blocked.hidden) blocked.textContent = `${label ? 'This version cannot run.' : 'This draft cannot run yet.'} ${last.issue[0].toUpperCase()}${last.issue.slice(1)}. Fix it in Create; the run starts as soon as it can.`;
  }
  function draw() {
    if (!alive()) return;
    const focused = doc.activeElement?.dataset?.focusKey;
    try {
      drawChrome();
      if (!room || !framesReady) return;
      scaleFrames(); drawStage(); drawPhone(); drawRail();
      inlineImages(stageFrame.contentDocument); inlineImages(phoneFrame.contentDocument);
      shown = taken;
    } catch { if (alive()) status.textContent = 'This step could not be shown. The run and your draft are unchanged.'; }
    if (focused && doc.activeElement?.dataset?.focusKey !== focused) [...root.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }

  return Object.freeze({
    get alive() { return alive(); },
    get shownRevision() { return shown; },
    get mode() { return mode; },
    /** Newest-only: a burst of edits is taken once, from the last pair. */
    update(next) {
      if (!alive()) { retire(); return false; }
      pending = { next, at: ++revision };
      if (!scheduled) {
        scheduled = true;
        ownerWindow.setTimeout(() => {
          scheduled = false;
          if (!alive()) { retire(); return; }
          const queued = pending; pending = null;
          if (queued) void take(queued.next, queued.at);
        }, 150); // typing settles before the run is rebuilt and replayed
      }
      return true;
    },
    /** A rebuild only ever takes a committed pair, so text still being composed never enters the run. */
    noteInput() {},
    focus() { if (alive()) { try { child.focus(); } catch { /* the browser may refuse focus */ } return true; } return false; },
    close: closeChild,
  });
}
