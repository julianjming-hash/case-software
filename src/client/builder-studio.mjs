import { createBuilderSourceDigest } from './builder-source-digest.mjs';
import { createBuilderAutosave } from './builder-autosave.mjs';
import { withOrdinaryMappings, withOrdinaryQuestionSlide, isQuestionOnlySlide } from '../shared/ordinary-question.mjs';
import { mountBuilderOutline, deriveBuilderOutline } from './builder-outline.mjs';
import { caseWords, fieldWords } from './builder-issue-words.mjs';
import { FREE_TEXT_MAX } from '../shared/content-limits.mjs';
import { enhanceSelect } from './accessible-select.mjs';
import { normaliseDraftTerminals } from '../shared/builder-draft-repair.mjs';
import { rerangeWholeSourceTraces } from '../shared/builder-provenance.mjs';

const clone = value => structuredClone(value);
// On a slide stage every non-slide field has one home: private notes, or stage settings (cards 50/51, BWR04).
const PRIVATE_FIELDS = new Set(['cue', 'notes', 'rationale', 'recovery.prompt', 'terminal.debrief_prompt']);
const SETTINGS_FIELDS = new Set(['kind', 'title']);
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
// D21: confirming a trace leaves it pointing at what the removal takes, so the block is cleared by moving or removing it.
const TRACES_BLOCK = 'Removal is refused while these source traces point into what it removes. Move each to the record that now holds its text (Slide or record), or remove it:';
const EMPTY_SOURCE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Name every known reference to an authored record before a structural removal is proposed. */
export function builderDependencyReport(document, target) {
  const references = [];
  if (!record(document) || !target || typeof target.id !== 'string') return { target, references, safeToRemove: false, refusal: 'This item cannot be identified safely.' };
  const add = (kind, ownerId, label, detail = {}) => references.push({ kind, ownerId: ownerId ?? null, label, ...detail });
  if (target.kind === 'beat') {
    for (const beat of document.beats ?? []) if (beat?.id !== target.id && beat?.next_beat_id === target.id) add('beat-successor', beat.id, `Stage “${beat.title || 'Untitled stage'}” continues here.`);
    for (const decision of document.decisions ?? []) for (const path of decision?.paths ?? []) {
      if (path?.next_beat_id === target.id) add('path-destination', path.id, `Consequence “${path.label || 'Untitled consequence'}” continues here.`);
      if (path?.terminal?.checkpoint_beat_id === target.id) add('terminal-checkpoint', path.id, `Consequence “${path.label || 'Untitled consequence'}” uses this checkpoint.`);
    }
    if (document.start_beat_id === target.id) add('case-start', target.id, 'This stage is the case start.');
    for (const card of document.clarifications ?? []) if (card?.beat_ids?.includes(target.id)) add('clarification-beat', card.id, `Clarification “${card.label || 'Untitled clarification'}” is allowed here.`);
    const beat = document.beats?.find(item => item?.id === target.id);
    if (beat?.decision_id) add('owned-decision', beat.decision_id, 'This stage owns a decision and its consequences.');
    if (beat?.surface_id) add('owned-surface', beat.surface_id, 'This stage shows learner content.');
  } else if (target.kind === 'surface') {
    for (const beat of document.beats ?? []) if (beat?.surface_id === target.id) add('stage-surface', beat.id, `Stage “${beat.title || 'Untitled stage'}” shows this content.`);
    for (const decision of document.decisions ?? []) for (const path of decision?.paths ?? []) if (path?.reveal_surface_id === target.id) add('path-surface', path.id, `Consequence “${path.label || 'Untitled consequence'}” reveals this content.`);
    for (const card of document.clarifications ?? []) if (card?.surface_id === target.id) add('clarification-surface', card.id, `Clarification “${card.label || 'Untitled clarification'}” uses this content.`);
  } else if (target.kind === 'path') {
    for (const decision of document.decisions ?? []) {
      if (decision?.paths?.find(item => item?.id === target.id)?.recommended) add('recommended-path', decision.id, 'This is marked as the recommended consequence.');
      if (decision?.fallback_path_id === target.id) add('fallback', decision.id, 'This is the no-response/tie fallback.');
      for (const rule of decision?.rules ?? []) if (rule?.path_id === target.id) add('rule-destination', decision.id, `A response rule selects this consequence: ${formatRule(rule)}.`);
      // Only single choice maps responses to consequences; a ranking or select-all question's leftover mappings bind
      // nothing, so they never stop a removal (D17).
      if (decision?.interaction?.type === 'single_choice') for (const option of decision.interaction.options ?? []) {
        const path = decision.paths?.find(item => item?.id === target.id);
        if (path?.option_ids?.includes(option.id)) add('option-mapping', option.id, `Response “${option.label || 'Untitled response'}” maps to this consequence.`);
      }
    }
  } else if (target.kind === 'option') {
    for (const decision of document.decisions ?? []) {
      const option = decision?.interaction?.options?.find(item => item?.id === target.id);
      if (!option) continue;
      if (decision.interaction.type === 'single_choice') for (const path of decision.paths ?? []) if (path?.option_ids?.includes(target.id)) add('option-path', path.id, `Consequence “${path.label || 'Untitled consequence'}” is mapped to this response.`);
      for (const rule of decision.rules ?? []) for (const [key, values] of Object.entries(rule?.when ?? {})) {
        if (Array.isArray(values) && values.includes(target.id)) add('option-rule', decision.id, `A ${key.replaceAll('_', ' ')} response rule uses this option: ${formatRule(rule)}.`);
      }
    }
  } else if (target.kind === 'flag') {
    const flag = document.flags?.find(item => item?.id === target.id);
    if (flag) {
      const key = flag.key;
      for (const beat of document.beats ?? []) if (beat?.requires_flags?.includes(key)) add('entry-flag', beat.id, `Stage “${beat.title || 'Untitled stage'}” requires this flag.`);
      for (const surface of document.surfaces ?? []) for (const variant of surface?.variants ?? []) if (variant?.when_flags?.includes(key)) add('variant-flag', surface.id, `Content “${surface.title || 'Untitled content'}” has a variant requiring this flag.`);
      for (const decision of document.decisions ?? []) for (const path of decision?.paths ?? []) {
        if (path?.set_flags?.includes(key)) add('set-flag', path.id, `Consequence “${path.label || 'Untitled consequence'}” sets this flag.`);
        if (path?.clear_flags?.includes(key)) add('clear-flag', path.id, `Consequence “${path.label || 'Untitled consequence'}” clears this flag.`);
      }
    }
  }
  return { target: { ...target }, references, safeToRemove: references.length === 0, refusal: references.length ? 'Review or repair every listed dependency before removing this item.' : null };
}

/**
 * Response mappings a question that is not single choice still carries (D20): nothing reads them, and each one's consequence
 * shows a control that clears it (renderPathControls). Pure; the draft passed in is never changed.
 */
export function leftoverMappings(document) {
  const found = [];
  if (!record(document)) return found;
  for (const decision of document.decisions ?? []) {
    if (!record(decision?.interaction) || decision.interaction.type === 'single_choice') continue;
    for (const path of decision.paths ?? []) if (record(path) && Object.hasOwn(path, 'option_ids')) found.push({ decisionId: decision.id, pathId: path.id });
  }
  return found;
}

/** `document` without the response mappings of these consequences (a copy), when their question is not single choice. */
export function withoutMappings(document, pathIds) {
  const next = clone(document), paths = new Set(pathIds);
  for (const decision of next.decisions ?? []) if (decision?.interaction?.type !== 'single_choice') for (const path of decision.paths ?? []) if (paths.has(path?.id)) delete path.option_ids;
  return next;
}

/**
 * Content no stage, consequence or clarification shows (D22): unreachable in a room. Each entry in `surfaces` has its own
 * Remove control in Readiness; content a private source trace points at is listed in `traced` and kept until the trace is
 * moved or removed, never dropped with it.
 */
export function unusedContent(document, metadata) {
  const surfaces = [], traced = [];
  if (!record(document)) return { surfaces, traced };
  const unused = unusedSurfaceIds(document);
  for (const surface of document.surfaces ?? []) if (unused.has(surface?.id)) {
    const traces = (metadata?.provenance ?? []).flatMap((entry, index) => entry?.entity_id === surface.id ? [index] : []);
    (traces.length ? traced : surfaces).push({ id: surface.id, title: surface.title || 'Untitled content', traces });
  }
  return { surfaces, traced };
}

/** Surface ids no stage, consequence or clarification shows (D22): unreachable in a room. Kept here, not imported from
 * the validator, so the Builder chunk does not carry the whole validator. */
function unusedSurfaceIds(document) {
  const used = new Set([...(document?.beats ?? []).map(beat => beat?.surface_id), ...(document?.clarifications ?? []).map(card => card?.surface_id),
    ...(document?.decisions ?? []).flatMap(decision => (decision?.paths ?? []).map(path => path?.reveal_surface_id))]);
  return new Set((document?.surfaces ?? []).map(surface => surface?.id).filter(id => typeof id === 'string' && !used.has(id)));
}

/** The content a change leaves unshown (D22): surfaces `before` showed that `next` still holds but nothing shows. */
export function orphanedSurfaces(before, next) {
  const was = unusedSurfaceIds(before), now = unusedSurfaceIds(next);
  return (next?.surfaces ?? []).filter(surface => now.has(surface?.id) && !was.has(surface.id));
}

function formatRule(rule) {
  const when = rule?.when ?? {};
  const key = Object.keys(when)[0];
  const values = key && Array.isArray(when[key]) ? when[key].join(', ') : key === 'keywords' ? (when[key] ?? []).join(', ') : '';
  return `${key?.replaceAll('_', ' ') ?? 'condition'} ${values}`.trim();
}

function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function button(doc, label, action, className = 'builder-btn') {
  const node = element(doc, 'button', label, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

const dangerButton = (doc, label, action) => button(doc, label, action, 'builder-btn builder-danger');

function fieldKey(ownerId, field) { return `${ownerId}:${field}`; }
const CASE_FIELDS = new Set(['title', 'summary', 'audience', 'setting', 'duration_min', 'learning_objectives', 'preparation_requirements']);
const plainField = ({ key, label, value, type, issues, metadata, placeholder }) => ({ key, label, value, type, issues, metadata, placeholder });

function readPointer(value, pointer) {
  return String(pointer).split('/').filter(Boolean).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((node, part) => node?.[part], value);
}

function writePointer(value, pointer, nextValue) {
  const parts = String(pointer).split('/').filter(Boolean).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (!parts.length) throw new TypeError('cannot replace the whole document through a field control');
  // Only the records on the pointer's path are copied; the rest is shared with `value`, which is never changed in place
  // (round 28: one key in a field no longer copies a draft at the caps).
  const copy = node => Array.isArray(node) ? [...node] : record(node) ? { ...node } : node;
  const candidate = copy(value), key = parts.pop();
  const parent = parts.reduce((node, part) => record(node) || Array.isArray(node) ? node[part] = copy(node[part]) : undefined, candidate);
  if (!record(parent) && !Array.isArray(parent)) throw new RangeError('field no longer exists');
  parent[key] = nextValue;
  return candidate;
}

function findIndexById(items, id) { return Array.isArray(items) ? items.findIndex(item => item?.id === id) : -1; }

/** Mount the standalone authoring sheet. All authority and persistence stay injected. */
export function mountBuilderStudio(container, dependencies = {}) {
  const doc = container?.ownerDocument;
  if (!doc) throw new TypeError('Builder host must belong to a document.');
  const { initial, publicationCheck = null, publicationIssues = () => [], templates = [], createId, validateDocument, validateFormattedText, mountFields, mountFormatEditor,
    renderFormattedText, createSaveState, mountPanels, saveServices, preview, checkpointServices, checkpointPanel = null, createScratch, hashSourceText, slides: slideCheck = null, inspect = null, shell = null, chrome = null, primaryAction = null, menuItems = [], isCurrent = () => true, onView = () => {}, onDirty = () => {}, onStatus = () => {}, onCreate = () => {}, archiveDraft = null, onArchived = () => {} } = dependencies;
  if (!initial || !shell || typeof createId !== 'function' || typeof validateDocument !== 'function' || typeof createSaveState !== 'function' || typeof mountFields !== 'function' || typeof mountPanels !== 'function') {
    throw new TypeError('Builder studio needs an initial paired draft and reviewed injected identity, validation, field and save-state services.');
  }
  let publication = null, publicationChecking = false;
  let destroyed = false;
  let deferRender = false;
  let slides = slideCheck; const slideState = {};
  // D28: the canvas's images, for the fit check and Run preview (builder-slides.mjs once it loads).
  const images = () => slides?.builderMedia;
  // Case-wide fit state (see runCaseFit): declared first, because the first render reads it.
  const caseFit = new Map();
  let caseProbe = null, caseFitTimer, caseFitRun = 0, unfitIssues = [], fitMeasured = false, slidesFailed = false;
  let pendingValid = null, validationTimer = null; // a typed draft awaiting its whole-pair check (round 12)
  let staleView = false, typedTimer = null; // pending catch-up render after plain-field typing (re-audit #9); declared first, as render reads it
  const zones = { private: false, response: false, settings: false, readiness: false };
  let shownSaveText = null, forceSync = false, statusTimer = null, fitView = 'projector-720', fitTimer = null, fitProbe = null, history = null, lastSaveText = null;
  // D15: a clarification's slide is a third kind of selection. `beatId` keeps the stage it is shown during and
  // `clarificationId` names it; choosing any stage or consequence (setting beatId or pathId) clears it, so only
  // selectClarification sets it.
  let selectedBeatId = initial.document?.start_beat_id ?? null, selectedPathId = null;
  let ui = { view: 'path', panel: 'write', fieldKey: null, clarificationId: null,
    get beatId() { return selectedBeatId; }, set beatId(value) { selectedBeatId = value; this.clarificationId = null; },
    get pathId() { return selectedPathId; }, set pathId(value) { selectedPathId = value; this.clarificationId = null; } };
  let historyState = { canUndo: false, canRedo: false };
  let snapshot;
  let formatMount = null;
  let formatKey = null;
  let focusAfterRender = null;
  let activeFieldDescriptors = new Map();
  const rowKeys = new Map();
  // Source bytes change before their digest can be calculated. Keep Save blocked until
  // the digest for the latest text is ready; a failed hash stays blocked until retried.
  const sourceRangeDrafts = new Map();
  const hashText = async text => {
    if (typeof hashSourceText === 'function') return hashSourceText(text);
    if (!globalThis.crypto?.subtle) throw new Error('Source hashing is unavailable in this browser.');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const sourceDigest = createBuilderSourceDigest({
    hash: hashText,
    readCurrentText: id => activeMetadata().sources?.find(source => source.id === id)?.text,
    applyDigest: (id, digest) => {
      const next = clone(activeMetadata());
      const source = next.sources?.find(item => item.id === id);
      if (!source) return false;
      source.sha256 = digest;
      return commit(activeDocument(), next);
    },
    onState: () => syncStatus(),
  });

  const root = element(doc, 'section', undefined, 'builder-studio');
  root.setAttribute('aria-label', 'Create');
  // The case title names the page for assistive technology; sighted authors read it in the app bar.
  const heading = element(doc, 'h1', 'Create', 'builder-sr-only');
  const top = element(doc, 'div', undefined, 'builder-studio-top');
  const status = element(doc, 'p', '', 'builder-studio-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const saveLabel = element(doc, 'span', '', 'builder-save-state');
  saveLabel.setAttribute('role', 'status'); saveLabel.setAttribute('aria-live', 'polite');
  const saveButton = button(doc, 'Save draft', () => void save(), 'builder-btn builder-private');
  const reconcileButton = button(doc, 'Reconcile save', () => void reconcile(), 'builder-btn');
  reconcileButton.hidden = true;
  const checkpointButton = button(doc, 'Manage checkpoints', () => void showCheckpoints(), 'builder-menu-item');
  // CASE-316: owners and admins archive a never-published draft (the route passes archiveDraft only to them).
  const archiveButton = archiveDraft && button(doc, 'Archive draft…', () => requestArchive(), 'builder-menu-item');
  // One draft history (card 58): every committed edit can be undone and redone; typing bursts coalesce.
  // A history button that disables itself hands focus to its partner, so the keyboard stays in the app bar (round 12).
  const undoButton = button(doc, '↶', () => { undo(); if (undoButton.disabled && !redoButton.disabled) redoButton.focus(); }, 'builder-tool builder-icon-tool'); undoButton.setAttribute('aria-label', 'Undo');
  const redoButton = button(doc, '↷', () => { redo(); if (redoButton.disabled && !undoButton.disabled) undoButton.focus(); }, 'builder-tool builder-icon-tool'); redoButton.setAttribute('aria-label', 'Redo');
  // Round arrows drawn as strokes (Julian 2026-10-12); the text glyphs stay where SVG is unavailable.
  const roundArrow = (host, paths) => {
    if (!doc.createElementNS) return;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'builder-icon');
    for (const d of paths) { const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
    host.replaceChildren(svg);
  };
  roundArrow(undoButton, ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5']);
  roundArrow(redoButton, ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5']);
  // Preview opens the Run preview window in this click (CASE-226); if the browser blocks it, the same Run preview is
  // shown inline below the slide and the status says why.
  const previewButton = button(doc, 'Preview ↗', () => openPreviewWindow(), 'builder-btn builder-private');
  // Pop-ups blocked (BWR08): Retry, and the same preview inline beside the editor, which stays mounted and editable.
  const inlinePreview = element(doc, 'section', undefined, 'builder-inline-preview'); inlinePreview.setAttribute('aria-label', 'Private preview shown here'); inlinePreview.hidden = true;
  const inlineFrameHost = element(doc, 'div', undefined, 'builder-inline-preview-host');
  const inlineHead = element(doc, 'div', undefined, 'builder-inline-preview-head');
  const inlineNote = element(doc, 'p', '');
  inlineHead.append(inlineNote, button(doc, 'Retry in a window', () => openPreviewWindow(), 'builder-btn builder-private'), button(doc, 'Leave preview', () => closeInline(), 'builder-btn'));
  inlinePreview.append(inlineHead, inlineFrameHost);
  let inline = null;
  let formatInResponse = false; // the formatted question's editor sits in Response and consequences (see render)
  const closeInline = () => { const was = Boolean(inline); inline?.close(); inline = null; inlinePreview.hidden = true; if (was) preview?.onLeave?.(); };
  function openPreviewWindow() {
    if (!inspect) { setStatus('Preview is unavailable in this authoring view. The draft remains unchanged.'); return; }
    if (inspect.open()) { closeInline(); syncStatus(); return; }
    showInline('The preview window was blocked, so the preview is shown below the slide. Allow pop-ups for this site, then Retry.',
      'Pop-ups are blocked for this site, so the Preview is shown here.');
  }
  /** The Preview inline below the slide; the editor stays mounted and editable beside it. */
  function showInline(message, note) {
    inline ??= inspect?.openInline?.(inlineFrameHost, { onClosed: () => { inline = null; inlinePreview.hidden = true; } }) ?? null;
    if (!inline) { setStatus('The preview could not be shown. Your draft is unchanged.'); return; }
    inlineNote.textContent = note;
    inlinePreview.hidden = false; inlinePreview.scrollIntoView?.({ block: 'nearest' });
    setStatus(message);
  }
  previewButton.setAttribute('aria-label', 'Preview this case');
  const templateButton = element(doc, 'select', undefined, 'builder-template-picker');
  templateButton.setAttribute('aria-label', 'Start from a template');
  const blankOption = element(doc, 'option', 'Start from scratch'); blankOption.value = '';
  templateButton.append(blankOption);
  for (const template of templates) {
    const option = element(doc, 'option', template.label || 'Starter template');
    option.value = template.id;
    templateButton.append(option);
  }
  templateButton.addEventListener('change', () => {
    const template = templates.find(item => item.id === templateButton.value);
    if (template) void createFromTemplate(template);
  });
  const scratchButton = button(doc, 'Start from scratch', () => void beginScratch());
  // Views beside the slide: Case details, Sources and the Overview (CASE-321; the Overview has its own address).
  const showView = view => { const was = ui.view; ui.view = view; render(); sheetHeading.focus(); if ((was === 'overview') !== (view === 'overview')) onView(view === 'overview' ? 'overview' : 'editor'); };
  const detailsItem = button(doc, 'Case details', () => showView('details'), 'builder-menu-item');
  // At phone width Preview leaves the app bar for this menu, so the bar never wraps (re-audit round 11, as the study).
  const previewItem = button(doc, 'Preview this case', () => openPreviewWindow(), 'builder-menu-item builder-narrow-only');
  // The route's own actions read as menu items here, in the menu's ink and alignment (round 18).
  for (const item of menuItems) { item.classList.remove('btn', 'tertiary', 'primary'); item.classList.add('builder-menu-item'); }
  // CASE-344: the ⋯ menu holds Import and export, Checkpoints, Case details and Archive (Sources stays in the Outline's foot).
  const transferItem = button(doc, 'Import and export', () => void openTransfer(), 'builder-menu-item');
  const more = shell.menuButton(doc, { label: 'More', text: '⋯', cls: 'builder-tool builder-icon-tool', items: () => [previewItem, button(doc, 'Save draft', () => saveButton.click(), 'builder-menu-item builder-narrow-only'), button(doc, 'Check', () => void openCheck(), 'builder-menu-item builder-narrow-only'), ...menuItems, transferItem, checkpointButton, detailsItem, ...(archiveButton ? [archiveButton] : [])] });
  // CASE-344: Check gathers every blocker in one list, each with Fix to the field. The count is the blockers; advice is listed apart.
  const checkDot = element(doc, 'span', '0', 'builder-check-dot'); checkDot.setAttribute('aria-hidden', 'true');
  const checkButton = button(doc, 'Check', () => void openCheck(), 'builder-btn builder-check builder-wide-only'); checkButton.prepend(checkDot); checkButton.setAttribute('aria-haspopup', 'dialog'); checkButton.title = 'Everything to fix before publishing, in one list';
  const checkDialog = element(doc, 'dialog', undefined, 'builder-check-dialog'); checkDialog.setAttribute('aria-labelledby', 'builderCheckTitle');
  const transferDialog = element(doc, 'dialog', undefined, 'builder-transfer-dialog'); transferDialog.setAttribute('aria-labelledby', 'builderTransferTitle');

  const history_ = element(doc, 'div', undefined, 'builder-history-tools'); history_.append(undoButton, redoButton);
  const insertTools = element(doc, 'div', undefined, 'builder-insert-tools');
  // Adding blocks and layouts live in the Inspector (CASE-344): the slide's own panel, with nothing selected.
  const endTools = element(doc, 'div', undefined, 'builder-end-tools');
  endTools.append(saveLabel, reconcileButton, checkButton, previewButton, saveButton, ...(primaryAction ? [primaryAction] : []), more.node);
  top.append(history_, insertTools, endTools);
  // In the app the tools join the site bar (wordmark, case breadcrumb, account menu): one bar, as in the Round 4 study.
  const bar = chrome?.bar ?? null;
  const caseDetails = element(doc, 'section', undefined, 'builder-global-details');
  const caseDetailsBody = element(doc, 'div', undefined, 'builder-global-details-body');
  caseDetailsBody.id = `builder-case-details-${createId()}`;
  const globalFieldsHost = element(doc, 'div', undefined, 'builder-global-fields builder-fields');
  const metadataFieldsHost = element(doc, 'div', undefined, 'builder-fields');
  const advancedDetails = element(doc, 'details', undefined, 'builder-case-advanced');
  advancedDetails.append(element(doc, 'summary', 'Advanced settings'));
  const caseToolsHost = element(doc, 'div', undefined, 'builder-case-details');
  // New-case setup is a separate entry flow (§3): it sits after this case's own details, says it creates another case,
  // and never opens the context (gap audit #15).
  const newCase = element(doc, 'section', undefined, 'builder-new-case'); newCase.setAttribute('aria-label', 'Start a new case');
  newCase.append(element(doc, 'h3', 'Start a new case'), element(doc, 'p', 'Creates a separate case. This case is unchanged.', 'builder-slide-note'), scratchButton, templateButton);
  advancedDetails.append(metadataFieldsHost, caseToolsHost, newCase);
  caseDetailsBody.append(globalFieldsHost, button(doc, 'Add learning objective', () => addObjective()), advancedDetails);
  caseDetails.append(caseDetailsBody);
  const workspace = element(doc, 'div', undefined, 'builder-workspace');
  const outlineRegion = element(doc, 'nav', undefined, 'builder-outline');
  outlineRegion.setAttribute('aria-label', 'Outline');
  const outlineScroll = element(doc, 'div', undefined, 'builder-outline-scroll');
  const outlineFoot = element(doc, 'div', undefined, 'builder-outline-footer');
  const overviewButton = button(doc, 'Overview', () => showView('overview'), 'builder-quiet-link');
  const sourcesButton = button(doc, 'Sources', () => openSources(), 'builder-quiet-link builder-private-link');
  outlineFoot.append(overviewButton, sourcesButton);
  const outline = mountBuilderOutline(outlineScroll, { createId, thumbnail: (document, selection) => slides?.slideThumbnail?.(doc, document, selection) ?? null, onSelect: (beatId, pathId, clarificationId = null) => {
    if (!panels.canNavigate()) return;
    const single = panels.layout().single;
    ui.beatId = beatId; ui.pathId = pathId; ui.clarificationId = clarificationId; ui.view = 'path'; panels.showSlide(); render();
    // In one-region mode the chosen stage replaces the Outline, so focus follows it to the slide.
    if (single) sheetHeading.focus();
  } });
  // Moving, deleting and connecting slides (Julian, 2026-10-17) are a lazy chunk, loaded when the pointer or focus first
  // reaches the Outline or the slide menu is asked for.
  let structureLoad = null, structureReady = false;
  const structure = run => (structureLoad ??= import('./builder-structure.mjs').then(module => (structureReady = true) && module.attachSlideStructure({ doc, region: outlineRegion, list: outlineScroll.firstChild, reviewHost, createId,
    projection: () => outline.projection(), document: activeDocument, metadata: activeMetadata, commit, setStatus, notChanged, selection: currentSelection, dropOrphaned, removalTraces,
    addStage, addQuestion: reviewDecisionInsertion, removeClarification: reviewClarificationRemoval,
    select: (beatId, pathId = null, clarificationId = null) => { ui.beatId = beatId; ui.pathId = pathId; ui.clarificationId = clarificationId; ui.view = 'path'; render(); } }))).then(run);
  for (const type of ['pointerover', 'focusin']) outlineRegion.addEventListener(type, () => structure(() => {}), { once: true });
  // A right-click that arrives before the chunk does still opens the slide menu, never the browser's.
  outlineRegion.addEventListener('contextmenu', event => { const key = event.target.closest?.('li')?.firstChild?.dataset?.outlineKey, { clientX: x, clientY: y } = event;
    if (!structureReady && key) { event.preventDefault(); structure(api => api.openMenu(key, { x, y })); } });
  // Stable inspector regions. Composition tools arrive with the versioned slide contract (cards 56/51).
  const inspector = element(doc, 'aside', undefined, 'builder-inspector');
  inspector.setAttribute('aria-label', 'Inspector');
  const inspectorBody = element(doc, 'div', undefined, 'builder-inspector-body');
  const regionNav = element(doc, 'nav', undefined, 'builder-regions');
  regionNav.setAttribute('aria-label', 'Create regions');
  // Panel heads close a side panel with ×; the region's own Show button (bottom bar) reopens it.
  const hide = name => regionNav.querySelector(`[aria-controls="${(name === 'outline' ? outlineRegion : inspector).id}"]`)?.click();
  const inspectorHead = shell.panelHead(doc, 'Inspector', { close: () => hide('tools'), closeLabel: 'Hide Inspector' });
  // Find (the study's ⌕): filters stages and consequences by name; the selected row always stays.
  const outlineHead = shell.panelHead(doc, 'Outline', { close: () => hide('outline'), closeLabel: 'Hide Outline' });
  const find = element(doc, 'input', undefined, 'builder-outline-find'); find.type = 'search'; find.setAttribute('aria-label', 'Find a slide'); find.placeholder = 'Find a slide'; find.hidden = true;
  const findButton = button(doc, '⌕', () => { find.hidden = !find.hidden; findButton.setAttribute('aria-expanded', String(!find.hidden)); if (find.hidden) { find.value = ''; outline.filter(''); } else find.focus(); }, 'builder-panel-close');
  findButton.setAttribute('aria-label', 'Find a slide'); findButton.setAttribute('aria-expanded', 'false');
  find.addEventListener('input', () => outline.filter(find.value));
  find.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); findButton.click(); findButton.focus(); } });
  outlineHead.insertBefore(findButton, outlineHead.lastChild);
  outlineRegion.append(outlineHead, find, outlineScroll, outlineFoot);
  inspector.append(inspectorHead, inspectorBody);
  const sheet = element(doc, 'section', undefined, 'builder-sheet');
  const canvasHead = element(doc, 'div', undefined, 'builder-canvas-head');
  const location = element(doc, 'span', '', 'builder-canvas-location');
  const sheetHeading = element(doc, 'h2', '', 'builder-sheet-heading'); sheetHeading.tabIndex = -1;
  const headFieldsHost = element(doc, 'div', undefined, 'builder-head-fields');
  const backToSlide = button(doc, '← Back to the slide', () => showView('path'), 'builder-quiet-link');
  // The slide menu (Julian, 2026-10-17): the same one the Outline opens with ⋯ or a right-click, for the current slide.
  const stageMenu = button(doc, 'Slide', () => { const box = stageMenu.getBoundingClientRect(), key = ui.clarificationId ? `clarification:${ui.clarificationId}` : ui.pathId ? `path:${ui.beatId}:${ui.pathId}` : `beat:${ui.beatId}`;
    structure(api => api.openMenu(key, { x: box.left, y: box.bottom + 4, back: stageMenu })); });
  stageMenu.classList.add('builder-stage-menu'); stageMenu.setAttribute('aria-label', 'Slide options'); stageMenu.setAttribute('aria-haspopup', 'menu');
  // When a side panel is closed, the canvas head offers it back (the study's ☷), besides the status bar.
  const reopen = (name, text) => { const control = button(doc, text, () => hide(name), 'builder-quiet-link builder-reopen'); control.setAttribute('aria-label', `Open ${name === 'outline' ? 'Outline' : 'Inspector'}`); control.hidden = true; return control; };
  const reopenOutline = reopen('outline', '☰ Outline'), reopenTools = reopen('tools', '☷ Inspector');
  const toolbarDock = element(doc, 'div', undefined, 'builder-toolbar-dock');
  // With Tools hidden (mid widths, one region), adding a block is still one press away (gap audit #13).
  let toolsHidden = false;
  const addBlockHead = button(doc, '+ Add block', () => { slideState.blockId = null; panels.reveal('tools'); render(); inspector.querySelector('.builder-palette button')?.focus(); }, 'builder-btn builder-add-block-head');
  addBlockHead.hidden = true;
  canvasHead.append(reopenOutline, location, sheetHeading, headFieldsHost, toolbarDock, stageMenu, backToSlide, addBlockHead, reopenTools);
  const fieldsHost = element(doc, 'div', undefined, 'builder-fields');
  const formatPicker = element(doc, 'label', undefined, 'builder-select-field');
  formatPicker.append(doc.createTextNode('Formatting'));
  const formatSelect = element(doc, 'select'); formatSelect.setAttribute('aria-label', 'Text with formatting'); formatSelect.dataset.controlKey = 'formatted-field-picker';
  formatPicker.append(formatSelect); formatPicker.hidden = true;
  const formatToggle = button(doc, 'Turn on bold and lists', () => convertSelectedFieldToFormatted(), 'builder-btn builder-format-toggle');
  formatToggle.hidden = true;
  const formatHost = element(doc, 'div', undefined, 'builder-format-field');
  const controls = element(doc, 'section', undefined, 'builder-context-controls');
  const issuesPanel = element(doc, 'aside', undefined, 'builder-issues');
  issuesPanel.setAttribute('aria-label', 'Draft readiness');
  // Under a composed slide: the target, reveal preview and measured fit, then labelled contexts that hold every
  // non-slide field once (private notes, the decision's response and consequences, stage settings) and readiness.
  // Reviews and confirmations (removals, checkpoints, a new draft, a save conflict) appear here in every view.
  const reviewHost = element(doc, 'div', undefined, 'builder-review-host');
  // Escape closes an open review without changing anything (a save conflict stays until it is resolved).
  reviewHost.addEventListener('keydown', event => {
    const panel = event.target.closest?.('.builder-confirm-change, .builder-checkpoints');
    if (event.key !== 'Escape' || event.isComposing || !panel) return;
    event.preventDefault(); panel.remove(); notChanged(); previewButton.focus?.({ preventScroll: true });
  });
  const canvasFoot = element(doc, 'div', undefined, 'builder-canvas-footer');
  const targetSelect = element(doc, 'select'); targetSelect.setAttribute('aria-label', 'Projector size');
  for (const [value, label] of [['projector-720', '1280 × 720'], ['projector-1080', '1920 × 1080']]) { const option = element(doc, 'option', label); option.value = value; targetSelect.append(option); }
  targetSelect.addEventListener('change', () => { fitView = targetSelect.value; scheduleFit(); });
  // Preview reveals steps through the slide on the canvas (Previous, Reveal next, All visible, Done).
  const revealsButton = button(doc, 'Preview reveals', () => { slideState.previewStep = Number.isInteger(slideState.previewStep) ? null : 0; focusAfterRender = Number.isInteger(slideState.previewStep) ? 'reveal:next' : null; render(); }, 'builder-btn builder-private');
  revealsButton.dataset.controlKey = 'reveal:toggle';
  revealsButton.setAttribute('aria-pressed', 'false');
  const fitStatus = element(doc, 'span', '', 'builder-fit-status'); fitStatus.setAttribute('role', 'status');
  // Source review status beneath the slide (BWR19): this stage's traces still to review, opening Readiness.
  // Source review beneath the slide was removed (Julian, CASE-238): traces are background data; Readiness has one line.
  const issuesButton = button(doc, '', () => { issuesOpen = !issuesOpen; renderSlideIssues(); }, 'builder-issues-toggle');
  issuesButton.hidden = true; issuesButton.setAttribute('aria-expanded', 'false');
  const issuesList = element(doc, 'ul', undefined, 'builder-slide-issues'); issuesList.hidden = true;
  let issuesOpen = false;
  // A fixed-layout draft says plainly where slides are (round 28 P2-2): the review lives in Tools → Layout.
  const upgradeButton = button(doc, 'Turn into slides…', () => {
    slideState.blockId = null; panels.reveal('tools'); render();
    focusControl([...root.querySelectorAll('button')].find(node => /^Review turning this draft into slides|^Turn into slides$/.test(node.textContent) && node.offsetParent));
  }, 'builder-btn');
  upgradeButton.hidden = true;
  canvasFoot.append(targetSelect, revealsButton, fitStatus, upgradeButton, issuesButton, issuesList);
  const zone = (key, title, chip) => shell.disclosure(doc, title, { chip, open: zones[key], onToggle: open => { zones[key] = open; }, cls: `builder-zone-${key}` });
  const privateZone = zone('private', 'Facilitator notes', 'Private'), responseZone = zone('response', 'Response and consequences'), settingsZone = zone('settings', 'Stage settings'), readinessZone = zone('readiness', 'Readiness');
  const privateFieldsHost = element(doc, 'div', undefined, 'builder-fields'), settingsFieldsHost = element(doc, 'div', undefined, 'builder-fields');
  privateZone.body.append(privateFieldsHost); settingsZone.body.append(settingsFieldsHost); readinessZone.body.append(issuesPanel);
  // Writing in a private context ends block editing on the slide (its formatting tools no longer apply).
  privateZone.details.addEventListener('focusin', () => { if (slideState.blockId) { slideState.blockId = null; render(); } });
  const slideHost = element(doc, 'div', undefined, 'builder-canvas-stage'); slideHost.tabIndex = -1;
  // "Based on" (CASE-321): the slide's sources as chips beneath it; + Add links a whole source, which counts as reviewed.
  const basedOn = element(doc, 'div', undefined, 'builder-based-on'); basedOn.setAttribute('role', 'group'); basedOn.setAttribute('aria-label', 'Based on');
  // Sources (CASE-321): the simple list and Add form load as a lazy chunk; the detailed trace editor stays here, behind Advanced.
  const sourcesView = element(doc, 'section', undefined, 'builder-sources-view'); sourcesView.setAttribute('aria-label', 'Sources'); sourcesView.hidden = true;
  const sourcesPanelHost = element(doc, 'div', undefined, 'builder-sources-panel');
  const sourcesAdvanced = element(doc, 'details', undefined, 'builder-sources-advanced'), sourcesAdvancedSummary = element(doc, 'summary', 'Advanced · detailed source traces');
  const sourceFieldsHost = element(doc, 'div', undefined, 'builder-fields'), sourceToolsHost = element(doc, 'div');
  sourcesAdvanced.append(sourcesAdvancedSummary, element(doc, 'p', 'Line-by-line traces, mostly from imported cases. Each names the slide and the text it supports, the source and its lines.', 'builder-slide-note'), sourceFieldsHost, sourceToolsHost);
  sourcesView.append(sourcesPanelHost, sourcesAdvanced);
  const overviewHost = element(doc, 'section', undefined, 'builder-overview'); overviewHost.setAttribute('aria-label', 'Case overview'); overviewHost.hidden = true;
  sheet.append(canvasHead, reviewHost, slideHost, canvasFoot, basedOn, inlinePreview, caseDetails, sourcesView, overviewHost, fieldsHost, formatPicker, formatToggle, formatHost, controls, privateZone.details, responseZone.details, settingsZone.details, readinessZone.details);
  const statusBar = element(doc, 'div', undefined, 'builder-statusbar');
  statusBar.append(status, regionNav);
  root.append(heading, ...(bar ? [] : [top]), workspace, statusBar);
  // The dialogs sit on the page, not in the studio, so the ⋯ menu opens them while the publishing view hides the studio.
  doc.body.append(checkDialog, transferDialog);
  container.append(root);
  const panels = mountPanels({ workspace, regions: { outline: outlineRegion, slide: sheet, tools: inspector }, nav: regionNav, createId, onStatus: setStatus,
    onLayout: layout => { reopenOutline.hidden = layout.single || !outlineRegion.hidden; reopenTools.hidden = layout.single || !inspector.hidden;
      toolsHidden = layout.single || inspector.hidden; addBlockHead.hidden = !(toolsHidden && slides && composed(selectionBeat())); } });
  const headFields = mountFields(headFieldsHost, { fields: [], onEdit: (key, value) => typed(key, value) });
  const privateFields = mountFields(privateFieldsHost, { fields: [], onEdit: (key, value) => typed(key, value) });
  const settingsFields = mountFields(settingsFieldsHost, { fields: [], onEdit: (key, value) => typed(key, value) });
  history = shell.createDraftHistory({ onChange: state => { historyState = state; undoButton.disabled = !state.canUndo; redoButton.disabled = !state.canRedo; if (state.message && !/^(Undo|Redo):/.test(state.message)) setStatus(state.message); } });
  undoButton.disabled = redoButton.disabled = true;
  // The app bar lives in the site banner, outside root: its Undo/Redo buttons keep the same shortcuts (round 12, BWR16).
  const unbindHistoryRoot = shell.bindHistoryKeys(root, { undo, redo }), unbindHistoryBar = shell.bindHistoryKeys(top, { undo, redo });
  const unbindHistory = () => { unbindHistoryRoot?.(); unbindHistoryBar?.(); };
  // Power keys (gap audit #24, re-audit #10): Cmd/Ctrl+S saves while the Builder is showing; Delete or Backspace starts the
  // reviewed removal of the selected block only from the slide canvas or Block order with the canvas visible, never while
  // text, a field, a dropdown or an editable region has focus, and never mid-composition.
  const shown = () => root.isConnected && !root.closest('[hidden]') && root.getClientRects().length > 0;
  const onKeys = event => {
    if (destroyed || event.defaultPrevented || event.isComposing || !shown()) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
    // Escape closes the reveal preview from the slide tile or its stepper, as the ? sheet says (CASE-251).
    if (event.key === 'Escape' && !mod && !event.altKey && Number.isInteger(slideState.previewStep) && event.target?.closest?.('.builder-outline-target, .builder-reveal-stepper')) {
      event.preventDefault(); focusAfterRender = event.target.closest('.builder-reveal-stepper') ? 'reveal:toggle' : null; slideState.previewStep = null; render(); return;
    }
    // The shared keymap (CASE-249), in the slides module: the selected slide tile's step keys and the ? sheet.
    if ((event.key === '?' || event.target?.closest?.('.builder-outline-target')) && slides?.builderKeys?.(slideCtx(), event, slideHost.getClientRects().length > 0)) return;
    // With nothing focused (focus fell to the page), Undo and Redo still act on the draft history (BWR16, round 12).
    if (mod && !event.altKey && (event.target === doc.body || event.target === doc.documentElement)) {
      const key = event.key.toLowerCase(), action = key === 'z' ? (event.shiftKey ? redo : undo) : key === 'y' && event.ctrlKey && !event.metaKey ? redo : null;
      if (action) { event.preventDefault(); action(); return; }
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    // After Escape, focus stays on the block's Edit button: Delete there removes that block, as the ? sheet promises
    // (round 28 P2-3), through the same reviewed removal.
    const edited = !mod && !slideState.blockId && event.target?.closest?.('.builder-slide .slide-block > .builder-slide-edit')?.parentElement?.dataset.blockId;
    if (mod || !slides?.requestRemoveBlock || ui.view !== 'path' || !slideHost.getClientRects().length) return;
    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .shared-select-trigger, [role="separator"], [role="listbox"], [role="menu"]')) return;
    if (target !== doc.body && !target?.closest?.('.builder-canvas-stage, .builder-slide-steps')) return;
    // Delete with nothing selected says so, rather than doing nothing (round 28 P2-3).
    if (edited) slideState.blockId = edited;
    if (!slideState.blockId) { if (target?.closest?.('.builder-canvas-stage')) setStatus('No block is selected. Select a block, then press Delete.'); return; }
    if (slides.requestRemoveBlock(slideCtx())) event.preventDefault(); else if (edited) slideState.blockId = null;
  };
  doc.addEventListener('keydown', onKeys);
  formatHost.addEventListener('focusout', event => { if (staleView && !formatHost.contains(event.relatedTarget)) render(); });
  // Owner ruling (CASE-236): pasted hidden characters are cleaned silently — tabs become spaces, invisible controls go.
  // Editors with their own paste (slide text, formatted text, table ranges) handle it first; plain fields land here.
  root.addEventListener('paste', event => {
    const target = event.target;
    if (event.defaultPrevented || !(target instanceof doc.defaultView.HTMLInputElement || target instanceof doc.defaultView.HTMLTextAreaElement)) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const clean = cleanPasted(text, target instanceof doc.defaultView.HTMLTextAreaElement);
    if (clean === text) return;
    event.preventDefault();
    target.setRangeText(clean, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length, 'end');
    target.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  });

  /** Measure the selected stage in the projector frame once edits settle; the footer states the result plainly. */
  // Case-wide fit (gap audit #10): every slide is measured in its own hidden projector frame after edits settle, one
  // slide per task so typing stays smooth; results are cached by content, so only changed slides are measured again.
  function scheduleCaseFit() {
    const view = doc.defaultView;
    if (destroyed || !slides?.slideThumbnail || activeDocument()?.schema_version !== 3) return;
    // A new edit cancels a pass in flight (it re-checks caseFitRun between slides) and starts again once edits settle.
    caseFitRun++; view.clearTimeout(caseFitTimer); caseFitTimer = view.setTimeout(() => void runCaseFit(), 1500);
  }
  async function runCaseFit() {
    const run = ++caseFitRun, document = activeDocument(), view = doc.defaultView, unfit = new Set(), issues = [];
    if (container.closest?.('[hidden]')) return;
    caseProbe ??= shell.createFitProbe(doc);
    const blocks = new Map((document.blocks ?? []).map(block => [block.id, block]));
    for (const composition of document.compositions ?? []) {
      if (destroyed || run !== caseFitRun) return;
      // Re-audit #14: clarification slides are measured too, and the pass always measures the CASE-211 target
      // (1280 × 720) whatever size the footer is showing, so choosing 1080 there never hides a failure here.
      const clarification = composition.owner?.kind === 'clarification';
      const owner = ownerSelection(document, composition.owner);
      if (!owner.beatId) continue;
      if (clarification) owner.compositionId = composition.id;
      // The slide's own content and, for a decision, the question it draws (prompt, options, rank count) — a question
      // block holds only the decision's id, so the decision itself must be in the key (re-audit #1).
      const stage = (document.beats ?? []).find(item => item.id === owner.beatId);
      const asked = stage?.kind === 'decision' && !owner.pathId && !clarification ? (document.decisions ?? []).find(item => item.id === stage.decision_id) : null;
      const key = JSON.stringify([document.theme ?? null, composition, composition.reading_order.map(id => blocks.get(id)), asked ? [asked.prompt, asked.interaction] : null,
        composition.reading_order.some(id => blocks.get(id)?.type === 'image') && images()?.generation]);
      let fits = caseFit.get(key);
      if (fits === undefined) {
        const result = await caseProbe.measure(document, owner, 'projector-720', 'open', images()?.resolve);
        if (destroyed || run !== caseFitRun || !result) return;
        // A decision's slide is also measured with its results in the question slot (every question type).
        const results = asked ? await caseProbe.measure(document, owner, 'projector-720', 'results', images()?.resolve) : null;
        if (destroyed || run !== caseFitRun) return;
        fits = !result.fits ? 'open' : results && !results.fits ? 'results' : true; caseFit.set(key, fits); if (caseFit.size > 600) caseFit.delete(caseFit.keys().next().value);
        await new Promise(done => view.setTimeout(done, 0));
      }
      if (fits !== true) {
        unfit.add(clarification ? `clarification:${composition.owner.id}` : owner.pathId ? `path:${owner.beatId}:${owner.pathId}` : `beat:${owner.beatId}`);
        const size = '1280 × 720';
        // A clarification's slide without the question is drawn beside it, narrowed below the body text floor (D15).
        const beside = clarification && slides?.clarificationDecision?.(document, composition.owner.id) && !composition.reading_order.some(id => blocks.get(id)?.type === 'question');
        // The issue names its slide by id; renderIssues resolves the current index, so links never go stale after edits.
        issues.push({ code: 'slide_overflow', compositionId: composition.id, message: fits === 'results'
          ? `Fits while the room answers, not once its results show at ${size}.` : beside ? `Does not fit the projector at ${size} beside the open question: add the Question block to place it on this slide.` : `Does not fit the projector at ${size}.` });
      }
    }
    if (run !== caseFitRun) return;
    unfitIssues = issues; fitMeasured = true; outline.markUnfit(unfit); renderIssues(activeDocument());
  }

  function scheduleFit() {
    if (destroyed) return;
    const view = doc.defaultView; view.clearTimeout(fitTimer);
    // Fit is measured with slide code, which loads only where the workspace grants slides.
    if (!slides || !selectionBeat() || ui.view !== 'path') { fitStatus.textContent = ''; return; }
    // Only a visible editor measures: the transfer view never loads the projector frame code.
    if (container.closest?.('[hidden]')) return;
    if (!fitStatus.textContent) fitStatus.textContent = shell.fitText(null);
    fitTimer = view.setTimeout(async () => {
      if (destroyed || container.closest?.('[hidden]')) return;
      fitProbe ??= shell.createFitProbe(doc);
      // A clarification's slide is measured as the case-wide pass measures it (D15).
      const document = activeDocument(), selection = currentSelection(), moved = () => JSON.stringify(currentSelection()) !== JSON.stringify(selection);
      const result = await fitProbe.measure(document, selection, fitView, 'open', images()?.resolve);
      if (destroyed || moved()) return;
      // A decision's slide must also fit with its results in the question slot, as the case-wide check measures it.
      const decisionStage = !selection.pathId && !selection.clarificationId && selectionBeat()?.kind === 'decision';
      const results = decisionStage && result?.fits ? await fitProbe.measure(document, selection, fitView, 'results', images()?.resolve) : null;
      if (destroyed || moved()) return;
      // Keep the selected-slide probe inspectable after measuring the separate results screen.
      if (results) await fitProbe.measure(document, selection, fitView, 'open', images()?.resolve);
      if (destroyed || moved()) return;
      fitStatus.textContent = results && !results.fits ? `Fits while the room answers; not once its results show at ${fitView === 'projector-1080' ? '1920 × 1080' : '1280 × 720'}.`
        : `${shell.fitText(result, fitView === 'projector-1080' ? '1920 × 1080' : '1280 × 720').replace(/^All blocks fit/, unplacedHere(document) ? 'Placed blocks fit' : 'All blocks fit')}${unplacedHere(document) ? ` · ${unplacedHere(document)} ${unplacedHere(document) === 1 ? 'block' : 'blocks'} not on the slide` : ''}`;
      // Blocks that overflow their slide area are marked on the canvas too (measured after fonts and edits settle).
      await doc.fonts?.ready;
      // Content only: editor chrome (handles, badges, notes) sits outside the block on purpose and is not overflow.
      const chrome = '.builder-block-handle, .builder-block-resize, .builder-reveal-badge, .builder-slide-edit, .builder-shared-note';
      const overflows = block => { const box = block.getBoundingClientRect(); return [...block.children].filter(child => !child.matches(chrome)).some(child => child.getBoundingClientRect().bottom > box.bottom - (parseFloat(getComputedStyle(block).paddingBottom) || 0) + 1 || child.scrollWidth > child.clientWidth + 1
        // The block being written scrolls inside its text box (round 13): hidden lines there are overflow too.
        || (child.matches('.builder-slide-text, .builder-slide-wrap') && child.scrollHeight > child.clientHeight + 1)
        // A table cell whose text runs past its column overflows too, as the room measures it (round 16).
        || [...(child.querySelectorAll?.('th, td') ?? [])].some(cell => cell.scrollWidth > cell.clientWidth + 1)); };
      // CASE-224/225, as in the room: a block's text shrinks to fit, to the 10 px floor at 1280×720, and only then is it marked.
      // The block being written keeps the size it had, so its text never jumps under the caret.
      // The projector frame's own result is used when it lines up block for block; otherwise the canvas measures itself.
      const scales = slideState.fit ??= {}, nodes = [...slideHost.querySelectorAll('.slide-canvas > .slide-block')];
      const slideId = slideHost.querySelector('.builder-slide')?.dataset.compositionId, key = block => slides.fitKey(slideId, block.dataset.blockId);
      const room = result?.blocks?.length === nodes.length ? result.blocks : null;
      nodes.forEach((block, index) => {
        // The block being written keeps its size; one selected before any measure takes the room's fit once, so it
        // never shows at full size beside its fitted neighbours (re-audit round 11).
        // The block being written keeps the size it was measured at, so its text never jumps under the caret; one
        // selected before its slide was ever measured is measured once now, like its neighbours (re-audit round 12).
        if (block.dataset.selected && Object.hasOwn(scales, key(block))) { block.removeAttribute('data-overflow'); return; }
        let fit = 1; block.style.removeProperty('--fit');
        // A hero block (D23) takes the room's grown fit too; measured here alone, it starts where the room does.
        if (room) { fit = room[index].fit; if (fit !== 1) block.style.setProperty('--fit', String(fit));
          // A hero card takes the room's column span (D23), the same share of the slide at every size.
          const cols = slideState.cols ??= {}; if (block.hasAttribute('data-hero-wide')) { /* written from empty: full span */ } else if (room[index].cols) slides.heroColumns(block, cols[key(block)] = room[index].cols); else delete cols[key(block)]; }
        else if (block.dataset.heroCap) block.style.setProperty('--fit', String(fit = +block.dataset.heroCap));
        // The canvas is the room's slide drawn smaller; a hair of rounding never clips a line here.
        while (overflows(block) && fit > 0.415) block.style.setProperty('--fit', fit = Math.max(0.415, fit - 0.05));
        // Every measured block records its canvas fit, 1 included, so a later selection or history step reuses it.
        scales[key(block)] = fit;
        if (block.dataset.selected) { block.removeAttribute('data-overflow'); return; }
        block.toggleAttribute('data-overflow', room ? room[index].over : overflows(block));
      });
      const editing = slideState.blockId && (slideState.overflow ?? []).includes(slideState.blockId) ? [slideState.blockId] : [];
      const overflow = [...[...slideHost.querySelectorAll('.slide-block[data-overflow]')].map(node => node.dataset.blockId), ...editing];
      if (JSON.stringify(overflow) !== JSON.stringify(slideState.overflow ?? [])) slideState.overflow = overflow;
      renderSlideIssues();
      fitStatus.dataset.fits = String(Boolean(result?.fits) && (results?.fits ?? true));
    }, 400);
  }

  // Routine receipts keep the same local generation: update status/readiness without dismissing reviews or replacing the editor.
  // Loading another pair and uncertain/conflicting saves still need the full view refresh.
  let published = 0, autosave = null;
  const saveState = createSaveState({ initial, services: saveServices, onChange: next => { if (destroyed || !isCurrent()) return; const quiet = snapshot?.localGeneration === next.localGeneration && /^(saved|saving|dirty)$/.test(next.status); snapshot = next; published++; onDirty(Boolean(next?.dirty), { status: next?.status, revision: next?.baseRevision }); if (deferRender || quiet) { syncStatus(); if (quiet) renderIssues(activeDocument()); } else render(); autosave?.changed(); } });
  snapshot = saveState.snapshot();
  autosave = createBuilderAutosave({ getSnapshot: () => isCurrent() ? snapshot : { status: 'retired', dirty: false }, save, scheduler: doc.defaultView ?? globalThis });
  // Re-audit #9 (BWR13): typing in a plain field records the edit and updates the status at once; the rest of the
  // workspace (Outline names, canvas head, readiness) catches up in one render once the keys pause, never per keystroke.
  const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/;
  const typed = (key, value) => {
    // Hidden characters (a tab pasted from a spreadsheet, say) are refused at the key, as on the slide, so a pause
    // never has to undo good typing before them (re-audit round 13).
    if (typeof value === 'string' && HIDDEN.test(value)) { setStatus(refusal('contains unsafe control or bidirectional characters')); return; }
    const wasDeferred = deferRender, before = published; deferRender = true;
    try { updateScalar(key, value); } finally { deferRender = wasDeferred; }
    // A recorded key synced the status as it published; only its new history step is left to show (round 28).
    if (published === before) syncStatus(); else syncHistoryButtons();
    afterTyping();
  };
  function afterTyping() { doc.defaultView?.clearTimeout?.(typedTimer); typedTimer = doc.defaultView?.setTimeout?.(catchUp, 180); }
  // A catch-up skipped for an open review or menu runs when that review is cancelled (a confirm renders anyway).
  function notChanged() { setStatus('Not changed.'); if (staleView) render(); }
  // The catch-up never replaces what the author opened after typing: a pending review or an open menu waits for the
  // render its own Confirm, Cancel or choice makes. Any other render cancels the catch-up (it has caught up already).
  function catchUp() {
    typedTimer = null;
    if (destroyed) return;
    if (reviewHost.childElementCount || root.querySelector('.builder-menu-list:not([hidden]), [aria-haspopup][aria-expanded="true"]')) { staleView = true; return; }
    // A render while the formatted editor has focus would collapse the author's text selection (round 16): the
    // catch-up waits until focus leaves that editor.
    if (formatHost.contains(doc.activeElement)) { staleView = true; return; }
    render();
  }
  const fields = mountFields(fieldsHost, { fields: [], onEdit: typed });
  const globalFields = mountFields(globalFieldsHost, { fields: [], onEdit: typed });
  const metadataFields = mountFields(metadataFieldsHost, { fields: [], onEdit: typed });
  const sourceFields = mountFields(sourceFieldsHost, { fields: [], onEdit: typed });

  // A fresh message is shown in full ink for a few seconds, then settles to the quiet status colour.
  function setStatus(message) { status.textContent = message; onStatus(message); status.classList.add('is-fresh'); doc.defaultView.clearTimeout(statusTimer); statusTimer = doc.defaultView.setTimeout(() => status.classList.remove('is-fresh'), 4500); }
  // Card 51: the slide module (present only with slide_composition) commits through the same validated path.
  function slideCtx() { return { doc, get document() { return activeDocument(); }, get metadata() { return activeMetadata(); }, selection: currentSelection(), state: slideState, createId, status: setStatus, toolbarDock, revealTools: () => panels.reveal('tools'),
    openResponse: () => { zones.response = true; responseZone.details.open = true; panels.showSlide(); responseZone.details.scrollIntoView?.({ block: 'start' }); focusControl([...responseZone.body.querySelectorAll('input, select, textarea, button')].find(node => !node.hidden || node.matches('select'))); }, rerender: key => { focusAfterRender = key ?? null; render(); },
    showSlide: () => panels.showSlide(),
    // A slide of this case by its composition (a synced block's “Also on” links), keeping the block selected when it is there.
    openSlide: (compositionId, blockId = null) => { const document = activeDocument(), composition = document.compositions?.find(item => item.id === compositionId); if (!composition) return false;
      const owner = ownerSelection(document, composition.owner); if (!owner.beatId) return false;
      ui.beatId = owner.beatId; ui.pathId = owner.pathId ?? null; ui.clarificationId = owner.clarificationId ?? null; ui.view = 'path'; slideState.blockId = slideState.keepBlockId = blockId; panels.showSlide(); render(); return true; },
    commit: (next, { metadata = activeMetadata(), quiet, ...options }) => { const was = deferRender; deferRender = deferRender || quiet; try { return commit(next, metadata, { ...options, coalesce: quiet ? `slide:${slideState.blockId}` : null }); } finally { deferRender = was; } } }; }
  function composed(beat) { return Boolean(slides?.isComposed(activeDocument(), beat?.id)); }
  function activeDocument() { return snapshot?.document ?? initial.document; }
  function activeMetadata() { return snapshot?.authoringMetadata ?? initial.authoringMetadata; }
  function selectionBeat() { return activeDocument()?.beats?.find(beat => beat?.id === ui.beatId) ?? null; }
  function currentSelection() { return { beatId: ui.beatId ?? null, pathId: ui.pathId ?? null, clarificationId: ui.clarificationId ?? null }; }
  /** The selected early clarification (D15), or null. */
  function selectedClarification() { return ui.clarificationId ? (activeDocument()?.clarifications ?? []).find(item => item.id === ui.clarificationId) ?? null : null; }
  /** Open a clarification's slide: it is shown during its first stage, so that stage stays the context. */
  function selectClarification(id) {
    const card = (activeDocument()?.clarifications ?? []).find(item => item.id === id);
    if (!card?.beat_ids?.[0]) { setStatus('Choose a stage this clarification is available during, then open its slide.'); return false; }
    ui.beatId = card.beat_ids[0]; ui.pathId = null; ui.clarificationId = id; ui.view = 'path';
    return true;
  }
  // A clarification selection follows its record: gone (Undo, a removal) or no longer shown during any stage, the
  // selection falls back to the stage; moved to another first stage, the context follows it.
  function settleSelection() {
    if (!ui.clarificationId) return;
    const document = activeDocument(), card = selectedClarification(), stage = card?.beat_ids?.[0];
    if (document?.schema_version !== 3 || !stage || !document.beats?.some(beat => beat.id === stage)) { ui.clarificationId = null; return; }
    if (stage !== selectedBeatId || selectedPathId) { selectedBeatId = stage; selectedPathId = null; }
  }
  function selectionPath() {
    const beat = selectionBeat();
    const decision = activeDocument()?.decisions?.find(item => item?.id === beat?.decision_id);
    return decision?.paths?.find(path => path?.id === ui.pathId) ?? null;
  }

  // Case's own dropdowns replace the device's (Julian 2026-10-12): each native select keeps its value and change
  // contract, and a select that has left the page takes its popup with it.
  const enhanced = new Map();
  function enhanceSelects() {
    for (const [native, api] of enhanced) if (!native.isConnected) { api.dispose(); enhanced.delete(native); }
    for (const native of root.querySelectorAll?.('select') ?? []) {
      if (enhanced.has(native) || native.hidden || native.multiple || native.size > 1) continue;
      const api = enhanceSelect(native);
      if (native.dataset.controlKey) api.trigger.dataset.controlKey = native.dataset.controlKey;
      // Its options open in a popup on the page body; the class keeps them as compact as the Builder's controls.
      doc.getElementById(api.trigger.getAttribute('aria-controls'))?.classList.add('builder-options');
      // A text-style select keeps the slide selection it acts on (the canvas toolbar).
      if (native.dataset.keepSelection) api.trigger.addEventListener('pointerdown', () => native.dispatchEvent(new doc.defaultView.MouseEvent('mousedown')));
      enhanced.set(native, api);
    }
  }

  let renderedSelection = null; // the selection last shown, recorded with each change for Undo (see commit)
  function render() {
    if (destroyed) return;
    staleView = false; if (typedTimer !== null) { doc.defaultView?.clearTimeout?.(typedTimer); typedTimer = null; }
    // A different stage or consequence shows its slide from the top (re-audit round 12, BWR07); a navigation to a
    // field then scrolls to that field when it takes focus.
    settleSelection();
    const movedTo = renderedSelection && (renderedSelection.beatId !== (ui.beatId ?? null) || renderedSelection.pathId !== (ui.pathId ?? null) || renderedSelection.clarificationId !== (ui.clarificationId ?? null));
    renderedSelection = { ...currentSelection(), blockId: slideState.blockId ?? null };
    const active = doc.activeElement;
    const activeControl = active?.dataset?.controlKey ? {
      key: active.dataset.controlKey,
      start: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
      end: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null,
    } : null;
    const activePath = active && root.contains?.(active) ? childPath(root, active) : null;
    // On-slide text is contenteditable: its caret is kept as character offsets across the rebuild.
    const caret = active?.isContentEditable && root.contains?.(active) ? slides?.caretOf?.(active) : null;
    const document = activeDocument();
    const beat = selectionBeat();
    syncStatus();
    heading.textContent = document?.title || 'Untitled case';
    chrome?.setTitle?.(document?.title || 'Untitled case');
    renderInspector();
    const details = ui.view === 'details', overview = ui.view === 'overview', sourcesShown = ui.view === 'sources', slideView = !details && !overview && !sourcesShown;
    sheet.dataset.view = ui.view;
    const card = selectedClarification();
    sheetHeading.textContent = details ? 'Case details' : overview ? 'Overview' : sourcesShown ? 'Sources' : card ? card.label || 'Untitled clarification' : (beat ? beat.title || 'Untitled stage' : document?.start_beat_id ? 'Select a stage' : 'Start from scratch');
    backToSlide.hidden = slideView; stageMenu.hidden = !slideView; caseDetails.hidden = !details; sourcesView.hidden = !sourcesShown; overviewHost.hidden = !overview;
    reviewHost.replaceChildren();
    if (slideView) { renderSheet(document, beat); renderBasedOn(document); } else { hideStageParts(); if (overview) renderOverview(document); if (details || sourcesShown) renderCaseFields(document); if (sourcesShown) renderSourcesView(document); }
    if (!sourcesShown && sourceToolsHost.firstChild) sourceToolsHost.replaceChildren();
    scheduleIssues();
    renderConflict();
    // Case tools (sources, traces, flags, clarifications) live in Case details only; building them while hidden cost
    // ~100 ms a render on a draft at the caps (re-audit P1), so they are built when shown and released otherwise.
    if (details) renderCaseTools(document, beat); else if (caseToolsHost.firstChild) caseToolsHost.replaceChildren();
    enhanceSelects();
    if (movedTo) sheet.scrollTop = 0;
    if (focusAfterRender) {
      const key = focusAfterRender;
      focusAfterRender = null;
      const fieldFocused = fields.focusField(key) || globalFields.focusField(key) || headFields.focusField(key);
      if (!fieldFocused && formatKey === key) formatMount?.focus?.();
      else if (!fieldFocused) root.querySelector?.(`[data-control-key="${cssEscape(key)}"]`)?.focus?.();
    } else if (activeControl) {
      const replacement = root.querySelector?.(`[data-control-key="${cssEscape(activeControl.key)}"]`) ?? followChildPath(root, activePath);
      replacement?.focus?.();
      if (caret && replacement?.isContentEditable) slides.setCaret(replacement, caret);
      if (activeControl.start !== null && typeof replacement?.setSelectionRange === 'function') {
        try { replacement.setSelectionRange(activeControl.start, activeControl.end); } catch { /* non-text controls have no selection range */ }
      }
    } else if (activePath && !active?.dataset?.outlineKey) followChildPath(root, activePath)?.focus?.();
  }

  function syncHistoryButtons() {
    undoButton.disabled = !historyState.canUndo; redoButton.disabled = !historyState.canRedo;
    const mac = /Mac|iP(hone|ad)/.test(doc.defaultView?.navigator?.platform ?? ''), key = mac ? '⌘' : 'Ctrl+';
    undoButton.title = `${historyState.undoLabel ? `Undo ${historyState.undoLabel}` : 'Nothing to undo'} (${key}Z)`; redoButton.title = `${historyState.redoLabel ? `Redo ${historyState.redoLabel}` : 'Nothing to redo'} (${mac ? '⌘⇧Z' : 'Ctrl+Y'})`;
  }
  function syncStatus() {
    const hashing = sourceDigest.hasPending();
    const hashFailed = sourceDigest.hasFailed();
    // The status line announces the save state when it changes; between changes it keeps the last action's message
    // (the app bar shows the save state at all times).
    const saveText = hashing ? 'Updating source digest… Save is unavailable until it finishes.'
      : hashFailed ? 'A source digest could not be updated. Edit that source again before saving.'
      : `${saveStatus(snapshot)}${snapshot?.dirty && snapshot.status !== 'dirty' ? ' Unsaved changes.' : ''}`; // said once (round 28)
    // CASE-223: a routine save state lives in the app bar only; a problem (conflict, uncertain save, digest) is also
    // put in the status line until it clears.
    const routine = !hashing && !hashFailed && ['saved', 'saving'].includes(snapshot?.status);
    if (saveText !== lastSaveText) {
      lastSaveText = saveText;
      if (!routine) { status.textContent = saveText; shownSaveText = saveText; }
      else if (shownSaveText && status.textContent === shownSaveText) { status.textContent = ''; shownSaveText = null; }
    }
    // "Saved" is what an author needs; the revision stays in the tooltip for anyone comparing saves (round 17).
    saveLabel.textContent = snapshot?.status === 'saving' ? 'Saving…' : snapshot?.dirty ? 'Unsaved changes' : snapshot?.status === 'saved' ? 'Saved' : '';
    saveLabel.title = snapshot?.status === 'saved' ? `Saved as revision ${snapshot.baseRevision}` : '';
    saveButton.disabled = !snapshot?.dirty || hashing || hashFailed || ['saving', 'uncertain', 'conflict', 'conflict_read_failed'].includes(snapshot?.status);
    reconcileButton.hidden = !['uncertain', 'conflict_read_failed'].includes(snapshot?.status);
    syncHistoryButtons();
    checkpointButton.disabled = snapshot?.status !== 'saved';
    // Deferred commits (inline names) skip the full render; the Outline still reflects the latest canonical pair.
    outline.update(activeDocument(), ui);
    inspect?.update({ document: activeDocument(), metadata: activeMetadata(), selection: currentSelection(), dirty: snapshot?.dirty, revealStep: Number.isInteger(slideState.previewStep) ? slideState.previewStep : null, media: images() });
    scheduleFit(); scheduleCaseFit();
  }

  // Readiness and the slide's issue list re-validate the whole case; they follow one frame after a change paints, so
  // Undo, Redo, selection and the typing catch-up show the change first (polish round 17, BWR13).
  let issuesFrame = 0;
  function scheduleIssues() {
    if (issuesFrame || destroyed) return;
    const view = doc.defaultView;
    issuesFrame = view.requestAnimationFrame(() => view.setTimeout(() => { issuesFrame = 0; if (destroyed) return; renderSlideIssues(); renderIssues(activeDocument()); }, 0));
  }
  /** The slide's issues under the canvas: a count that opens the list; a block issue selects its block. */
  function renderSlideIssues() {
    const issues = slides?.slideIssues?.(slideCtx()) ?? [];
    issuesButton.hidden = !issues.length;
    issuesButton.textContent = `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`;
    issuesButton.setAttribute('aria-expanded', String(issuesOpen && Boolean(issues.length)));
    issuesList.hidden = !issuesOpen || !issues.length;
    issuesList.replaceChildren(...issues.map(item => {
      const row = element(doc, 'li');
      if (item.blockId) row.append(button(doc, item.text, () => { slideState.blockId = item.blockId; focusAfterRender = `slide-block:${item.blockId}`; render(); }, 'builder-issue-link'));
      else row.append(doc.createTextNode(item.text));
      return row;
    }));
  }

  function renderInspector() { renderInspectorBody(); enhanceSelects(); }
  function renderInspectorBody() {
    scheduleIssues();
    const document = activeDocument(), beat = selectionBeat(), path = selectionPath(), nodes = [];
    // CASE-344: one contextual inspector. Nothing selected shows the slide's (Add a block, reveal order, layout and fill);
    // a selected block shows that block's.
    const slideNodes = slides?.slideInspector?.(slideCtx());
    if (slideNodes) return inspectorBody.replaceChildren(...slideNodes);
    // A fixed-layout draft in a slide-enabled workspace offers the reviewed, measured upgrade.
    if (slides && beat && document?.schema_version === 2) return inspectorBody.replaceChildren(...shell.upgradePanel(slideCtx(), { probe: () => (fitProbe ??= shell.createFitProbe(doc)), button, element }));
    const kind = path ? 'Consequence' : beat?.kind === 'decision' ? 'Decision' : beat?.kind === 'debrief' ? 'Debrief' : 'Teaching stage';
    if (!beat) nodes.push(element(doc, 'p', 'Select a stage or consequence in the Outline.'));
    else nodes.push(element(doc, 'h3', path ? path.label || 'Untitled consequence' : beat.title || 'Untitled stage'), element(doc, 'p', kind), element(doc, 'p', 'This stage keeps its fixed layout. Slide templates are not available yet.'));
    inspectorBody.replaceChildren(...nodes);
  }

  /** Everything that belongs to one stage is hidden while the case details or the overview are shown. */
  function hideStageParts() {
    for (const node of [slideHost, canvasFoot, basedOn, headFieldsHost, fieldsHost, formatPicker, formatToggle, formatHost, controls, privateZone.details, responseZone.details, settingsZone.details]) node.hidden = true;
    location.textContent = '';
    headFields.sync([], { force: forceSync });
  }

  /** Each field's own problems, in plain words: an empty required field says Required (round 28 P2-1). */
  function attachFieldIssues(document, models) {
    const validation = checked(document, activeMetadata(), 'preserve'), all = [...(validation.errors ?? []), ...(validation.warnings ?? [])];
    for (const field of models) field.issues = all.filter(issue => issue.at === field.pointer).map(issue => ({ ...issue, message: fieldWords(issue.message, field.value) }));
  }

  function syncCaseFields(plainFields) {
    globalFields.sync(plainFields.filter(field => field.key.startsWith('case:')).map(plainField), { force: forceSync });
    const source = field => field.pointer?.startsWith('/sources/');
    metadataFields.sync(plainFields.filter(field => field.metadata && !source(field)).map(plainField), { force: forceSync });
    sourceFields.sync(plainFields.filter(source).map(plainField), { force: forceSync });
  }
  /** Case details shown: its fields follow the draft, so an added objective appears and a fixed field clears (round 28). */
  function renderCaseFields(document) {
    const models = shell.describeFields(document, activeMetadata(), null, null, rowKeys, false);
    attachFieldIssues(document, models);
    for (const field of models) activeFieldDescriptors.set(field.key, field);
    syncCaseFields(models.filter(field => field.type === 'text' || field.type === 'textarea'));
  }
  function renderSheet(document, beat) {
    const selectedSurface = document?.surfaces?.find(surface => surface?.id === beat?.surface_id);
    for (const group of ['points', 'investigations', 'observations']) for (let index = 0; index < (selectedSurface?.[group]?.length ?? 0); index++) getRowKey(selectedSurface.id, group, index);
    const canvas = slides?.slideCanvas?.(slideCtx());
    if (slideHost.firstChild !== canvas) slideHost.replaceChildren(...(canvas ? [canvas] : []));
    const isSlide = Boolean(canvas);
    addBlockHead.hidden = !(toolsHidden && isSlide);
    // The canvas head names where you are: slide n of N for a composed slide, otherwise the stage.
    // Numbered as the Outline numbers the authored spine (gap audit #17); a consequence names its stage's slide.
    const numbered = beat ? (outline.projection?.() ?? deriveBuilderOutline(document)).rows.filter(row => row.kind === 'stage' && Number.isInteger(row.number)) : [];
    const here = numbered.find(row => row.beatId === beat?.id), noun = isSlide ? 'Slide' : 'Stage';
    const card = selectedClarification();
    location.textContent = !beat ? '' : card ? `Clarification during ${here ? `${noun.toLowerCase()} ${here.number}` : 'a stage off the main path'}` : !here ? `${noun} off the main path` : ui.pathId ? `Consequence of ${noun.toLowerCase()} ${here.number}` : `${noun} ${here.number} / ${numbered.length}`;
    // A consequence or clarification names its stage (a link back) and itself; the stage's own name is edited on the stage.
    const path = selectionPath();
    if ((path || card) && beat) location.append(' · ', button(doc, beat.title || 'Untitled stage', () => { ui.pathId = null; render(); }, 'builder-quiet-link builder-crumb'), ` / ${path ? path.label || 'Untitled consequence' : card.label || 'Untitled clarification'}`);
    slideHost.hidden = !isSlide; canvasFoot.hidden = !slides || (!isSlide && !beat);
    upgradeButton.hidden = isSlide || document?.schema_version !== 2 || !beat;
    revealsButton.setAttribute('aria-pressed', String(Number.isInteger(slideState.previewStep)));
    revealsButton.hidden = !isSlide;
    const fieldModels = shell.describeFields(document, activeMetadata(), beat, ui.pathId, rowKeys, composed(beat));
    // D15: a clarification's slide is named in the canvas head, as a stage is; its stage's fields stay on the stage.
    const cardIndex = card ? (document.clarifications ?? []).indexOf(card) : -1;
    if (card) fieldModels.push({ key: fieldKey(card.id, 'label'), label: 'Clarification name', value: card.label ?? '', type: 'text', pointer: `/clarifications/${cardIndex}/label`, ownerId: card.id, provenanceField: 'label', placeholder: 'Name this clarification' });
    // D16: a consequence's or clarification's own reveal content keeps a heading and private notes the facilitator sees;
    // they are edited on its slide. Content its stage shows too stays with the stage.
    const revealId = card ? card.surface_id : path?.reveal_surface_id, revealIndex = revealId && revealId !== beat?.surface_id ? (document.surfaces ?? []).findIndex(item => item.id === revealId) : -1;
    const reveal = revealIndex >= 0 ? document.surfaces[revealIndex] : null;
    if (reveal) fieldModels.push({ key: fieldKey(reveal.id, 'title'), label: 'Learner content heading', value: reveal.title ?? '', type: 'text', pointer: `/surfaces/${revealIndex}/title`, ownerId: reveal.id, provenanceField: 'title' },
      { key: fieldKey(reveal.id, 'notes'), label: 'Private facilitator notes', value: reveal.notes ?? '', type: reveal.notes && typeof reveal.notes === 'object' ? 'formatted' : 'textarea', formatAvailable: true, pointer: `/surfaces/${revealIndex}/notes`, ownerId: reveal.id, provenanceField: 'notes' });
    attachFieldIssues(document, fieldModels);
    activeFieldDescriptors = new Map(fieldModels.map(field => [field.key, field]));
    const plainFields = fieldModels.filter(field => field.type === 'text' || field.type === 'textarea');
    // Case-wide fields live in Case details; the stage name sits in the canvas head.
    syncCaseFields(plainFields);
    const stageFields = plainFields.filter(field => !field.key.startsWith('case:') && !field.metadata);
    const titleKey = card ? fieldKey(card.id, 'label') : path && isSlide ? fieldKey(path.reveal_surface_id, 'title') : beat ? fieldKey(beat.id, 'title') : null;
    const ordinary = !path && !card && isQuestionOnlySlide(document, beat?.id);
    headFields.sync(ordinary ? [] : stageFields.filter(field => field.key === titleKey).map(field => plainField({ ...field, label: 'Slide title', placeholder: 'Name this slide' })), { force: forceSync });
    headFieldsHost.hidden = ordinary || !beat || Boolean(ui.pathId && !isSlide);
    // A selected consequence shows only its own fields (§3, re-audit #5); its stage's notes and settings are one step
    // away through Question settings. A clarification's slide has no fields beyond its name (D15).
    const rest = card ? stageFields.filter(field => reveal && field.ownerId === reveal.id)
      : stageFields.filter(field => field.key !== titleKey && (!ui.pathId || field.key.startsWith(`${ui.pathId}:`) || (reveal && field.ownerId === reveal.id)));
    if (isSlide) {
      // One editor per field: learner text is on the slide; private notes, settings and the decision each have one home.
      const privateKeys = rest.filter(field => PRIVATE_FIELDS.has(field.provenanceField) || /private/i.test(field.label));
      privateFields.sync(privateKeys.map(plainField), { force: forceSync });
      // The collapsed summary shows when private notes exist, so nothing private is hidden by accident.
      privateZone.summary.toggleAttribute('data-filled', fieldModels.some(field => (!card || field.ownerId === reveal?.id) && (PRIVATE_FIELDS.has(field.provenanceField) || /private/i.test(field.label)) && (typeof field.value === 'string' ? field.value.trim() : field.value)));
      settingsFields.sync(rest.filter(field => SETTINGS_FIELDS.has(field.provenanceField) && field.provenanceField !== 'title').map(plainField), { force: forceSync });
      fields.sync([], { force: forceSync });
    } else { privateFields.sync([], { force: forceSync }); settingsFields.sync([], { force: forceSync }); fields.sync(rest.map(plainField), { force: forceSync }); }
    fieldsHost.hidden = isSlide;
    for (const zone of [privateZone, responseZone, settingsZone]) zone.details.hidden = !isSlide || Boolean(card && (zone === responseZone || (!reveal && !(zone === settingsZone && sharedRevealOwner(beat)))));
    formatInResponse = false;
    const formatFields = (card ? fieldModels.filter(field => reveal && field.ownerId === reveal.id) : fieldModels).filter(field => field.type === 'formatted' || (field.formatAvailable && !(isSlide && field.provenanceField === 'prompt')));
    // On a slide stage formatted notes are private context and their editor lives in Facilitator notes; the formatted
    // question is learner text, so its editor moves to Response and consequences (never under the private chip).
    if (isSlide) privateZone.body.append(formatPicker, formatToggle, formatHost); else sheet.insertBefore(formatHost, controls), sheet.insertBefore(formatToggle, formatHost), sheet.insertBefore(formatPicker, formatToggle);
    formatPicker.hidden = !formatFields.length;
    if (formatFields.length) {
      formatSelect.replaceChildren(...formatFields.map(field => {
        const option = element(doc, 'option', field.label); option.value = field.key; return option; // field names only (round 17)
      }));
      const selected = formatFields.find(field => field.key === ui.fieldKey) ?? formatFields[0];
      ui.fieldKey = selected.key; formatSelect.value = selected.key;
      formatInResponse = isSlide && selected.provenanceField === 'prompt';
      formatToggle.hidden = selected.type === 'formatted';
      formatToggle.textContent = 'Turn on bold and lists'; formatToggle.setAttribute('aria-label', `Turn on bold and lists for ${selected.label}`);
      formatHost.hidden = false;
      if (selected.type === 'formatted') renderFormatted(selected);
      else { destroyFormat(); formatHost.replaceChildren(); }
    }
    else { destroyFormat(); formatHost.replaceChildren(); formatToggle.hidden = true; }
    renderContextControls(document, beat, isSlide);
  }

  formatSelect.addEventListener('change', () => { ui.fieldKey = formatSelect.value; destroyFormat(); render(); });

  function convertSelectedFieldToFormatted() {
    const field = activeFieldDescriptors.get(ui.fieldKey);
    if (!field?.formatAvailable || typeof field.value !== 'string') { setStatus('Choose a supported plain-text field first.'); return; }
    if (activeDocument().schema_version < 2) { setStatus('Convert this draft to schema 2 before enabling formatted text. Plain text remains unchanged.'); return; }
    const nextDocument = writePointer(activeDocument(), field.pointer, { blocks: [{ type: 'paragraph', runs: [{ text: field.value }] }] });
    nextDocument.required_capabilities ??= [];
    if (!nextDocument.required_capabilities.includes('formatted_text')) nextDocument.required_capabilities.push('formatted_text');
    commit(nextDocument, activeMetadata(), { structural: true, focusKey: field.key, label: 'Formatting enabled. Existing text was preserved exactly in one paragraph.' });
  }

  function renderFormatted(field) {
    if (typeof mountFormatEditor !== 'function') {
      formatHost.replaceChildren();
      if (typeof renderFormattedText === 'function') formatHost.append(renderFormattedText(doc, field.value, { validateFormattedText }));
      else formatHost.append(element(doc, 'p', 'Formatted editing is unavailable for this field. Current content is preserved.'));
      return;
    }
    if (formatKey !== field.key) {
      destroyFormat();
      formatKey = field.key;
      formatMount = mountFormatEditor(formatHost, {
        value: field.value,
        label: field.label,
        validateFormattedText,
        renderFormattedText,
        onChange: value => {
          const wasDeferred = deferRender; deferRender = true;
          try { updateScalar(field.key, value); } finally { deferRender = wasDeferred; }
          syncStatus(); afterTyping();
        },
        onStatus: setStatus,
      });
    }
  }

  function renderContextControls(document, beat, isSlide = false) {
    const nodes = [];
    const path = selectionPath();
    const surface = document?.surfaces?.find(item => item?.id === beat?.surface_id);
    controls.hidden = false;
    if (!beat) {
      nodes.push(element(doc, 'h3', 'Teaching content'), element(doc, 'p', 'Create a scratch draft or choose a starter template. Add a teaching stage to begin writing.'));
      nodes.push(button(doc, 'Add learning objective', () => addObjective()));
      nodes.push(button(doc, 'Add private preparation requirements', () => addPreparationRequirements()));
      nodes.push(button(doc, 'Add the first teaching stage', () => addStage(null)));
      controls.replaceChildren(...nodes);
      return;
    }
    // On a slide stage every structural command lives in the Stage menu (one place, BWR06); the fixed-layout editor
    // keeps its in-page buttons.
    const structure = isSlide ? [] : [button(doc, 'Add next teaching stage', () => addStage({ beatId: beat.id, pathId: ui.pathId })),
      button(doc, 'Insert a decision here', () => reviewDecisionInsertion({ beatId: beat.id, pathId: ui.pathId })),
      dangerButton(doc, 'Delete slide', () => structure(api => api.reviewRemoval(beat.id)))];
    const decision = [];
    // A selected consequence has its own context; the question's settings are one step away, not repeated above it (§3).
    // A clarification's slide is not the question either (D15): its stage's controls stay on the stage.
    if (beat.kind === 'decision' && !path && !ui.clarificationId) renderDecisionControls(decision, document, beat);
    // D25: a consequence or clarification that shows its stage's own content (added before CASE-265) has no heading or
    // notes of its own, and Reveal names the stage; this gives it its own, the heading first set to its slide's heading.
    const sharing = sharedRevealOwner(beat);
    if (sharing) structure.push(button(doc, `Give this ${sharing.kind === 'path' ? 'consequence' : 'clarification'} its own heading and notes`, () => separateRevealContent(beat, sharing)));
    if (path) {
      decision.push(button(doc, 'Question settings', () => { ui.pathId = null; render(); }, 'builder-btn builder-back-link'));
      renderPathControls(decision, document, beat, path, isSlide);
    }
    if (isSlide) {
      // A slide stage: the decision's response and consequences, and the stage's structure, each in its own context.
      responseZone.details.hidden = !decision.length;
      responseZone.body.replaceChildren(...decision);
      if (formatInResponse) responseZone.body.prepend(formatPicker, formatToggle, formatHost);
      const actions = element(doc, 'div', undefined, 'builder-row-actions'); actions.append(...structure);
      settingsZone.body.replaceChildren(settingsFieldsHost, actions);
      controls.replaceChildren(); controls.hidden = true;
      return;
    }
    nodes.push(element(doc, 'h3', beat.kind === 'decision' ? 'Decision & consequences' : 'Teaching content'));
    // A composed stage's learner content lives in its slide blocks; legacy row controls would write a second copy.
    if (!composed(beat)) nodes.push(button(doc, 'Add finding', () => addContent(surface?.id, 'points')), button(doc, 'Add investigation result', () => addContent(surface?.id, 'investigations')), button(doc, 'Add observation', () => addContent(surface?.id, 'observations')));
    nodes.push(...structure);
    if (surface && !composed(beat)) renderRows(nodes, surface);
    nodes.push(...decision);
    controls.replaceChildren(...nodes);
  }

  function renderRows(nodes, surface) {
    for (const group of ['points', 'investigations', 'observations']) {
      const values = Array.isArray(surface[group]) ? surface[group] : [];
      if (!values.length) continue;
      const list = element(doc, 'section', undefined, `builder-content-group builder-${group}`);
      list.append(element(doc, 'h4', group === 'points' ? 'Findings' : group === 'investigations' ? 'Investigation results' : 'Observations'));
      for (let index = 0; index < values.length; index++) {
        const row = element(doc, 'div', undefined, 'builder-content-row');
        const label = group === 'observations' ? `Observation ${index + 1}` : `${group === 'points' ? 'Finding' : 'Investigation'} ${index + 1}`;
        getRowKey(surface.id, group, index);
        row.append(element(doc, 'strong', label));
        const actions = element(doc, 'div', undefined, 'builder-row-actions');
        actions.append(button(doc, 'Move earlier', () => moveContent(surface.id, group, index, index - 1)), button(doc, 'Move later', () => moveContent(surface.id, group, index, index + 1)));
        const remove = dangerButton(doc, `Remove ${label.toLowerCase()}`, () => removeContent(surface.id, group, index));
        actions.append(remove);
        row.append(actions); list.append(row);
      }
      nodes.push(list);
    }
  }

  function renderDecisionControls(nodes, document, beat) {
    const decisionIndex = findIndexById(document.decisions, beat.decision_id);
    const decision = document.decisions?.[decisionIndex];
    if (!decision) return;
    const panel = element(doc, 'section', undefined, 'builder-decision-panel');
    panel.append(element(doc, 'h4', 'Response'));
    const ordinary = decision.paths?.length === 1 && decision.paths[0].continue_to_next === true;
    panel.append(makeSelect('Response type', ['single_choice', 'multi_select', 'ranking', 'free_text'].map(type => [type, interactionLabel(type)]), decision.interaction?.type, next => reviewInteractionType(decision, next), `/decisions/${decisionIndex}/interaction/type`));
    if (!ordinary && document.schema_version >= 2) panel.append(makeSelect('Interpretation', [['rules', 'Use authored response rules'], ['facilitator', 'Facilitator chooses the consequence']], decision.interpretation || 'rules', next => reviewInterpretationChange(decision, next), `/decisions/${decisionIndex}/interpretation`));
    const paths = Array.isArray(decision.paths) ? decision.paths : [];
    if (!ordinary) panel.append(makeSelect('No response, tie or no matching rule', paths.map(item => [item.id, item.label || 'Untitled consequence']), decision.fallback_path_id, next => updateDecision(decision.id, 'fallback_path_id', next), `/decisions/${decisionIndex}/fallback_path_id`));
    const response = decision.interaction ?? {};
    panel.append(makeNumberInput(`${decision.id}:timer_s`, 'Response timer in seconds (10–600)', decision.timer_s ?? '', 10, 600, value => updateDecision(decision.id, 'timer_s', value ?? null), true));
    if (response.type === 'free_text') panel.append(makeNumberInput(`${decision.id}:max_length`, 'Free-text response limit', response.max_length ?? FREE_TEXT_MAX, 1, FREE_TEXT_MAX, value => updateDecision(decision.id, 'interaction/max_length', value)));
    if (response.type === 'ranking') {
      panel.append(makeSelect('Ranking means', [['priority', 'Priority'], ['action', 'Action sequence']], response.order_meaning ?? 'priority', value => updateDecision(decision.id, 'interaction/order_meaning', value)));
      panel.append(makeNumberInput(`${decision.id}:rank_count`, 'Number of options to rank', response.rank_count ?? '', 2, response.options?.length ?? 8, value => updateDecision(decision.id, 'interaction/rank_count', value), true));
    }
    if (response.type !== 'free_text') renderOptions(panel, decision);
    if (ordinary) {
      panel.append(element(doc, 'p', 'Discuss responses, then Continue to the next story slide.'), button(doc, 'Add branches', () => addPath(decision.id)));
      nodes.push(panel); return;
    }
    if (decision.interaction?.type !== 'single_choice' && decision.interpretation !== 'facilitator') renderRules(panel, decision);
    // Every consequence once: recommendation, named destination or terminal checkpoint, and required recovery.
    if (paths.length) {
      const list = element(doc, 'table', undefined, 'builder-consequences'), head = element(doc, 'tr');
      list.append(element(doc, 'caption', 'Consequences'));
      for (const label of ['Consequence', 'Leads to', 'Notes', 'Order']) { const th = element(doc, 'th', label); th.scope = 'col'; head.append(th); }
      const thead = element(doc, 'thead'); thead.append(head); list.append(thead);
      const body = element(doc, 'tbody');
      for (const path of paths) {
        const row = element(doc, 'tr'), name = element(doc, 'th'); name.scope = 'row';
        name.append(button(doc, path.label || 'Untitled consequence', () => { ui.pathId = path.id; render(); }, 'builder-issue-link'));
        const target = document.beats?.find(item => item.id === (path.terminal ? path.terminal.checkpoint_beat_id : path.next_beat_id));
        const to = path.terminal ? `Ends · checkpoint ${target?.title || 'needs repair'}` : target ? target.title || 'Untitled stage' : 'Destination needs repair';
        const notes = [path.recommended && 'Recommended', path.recovery && 'Required recovery', decision.fallback_path_id === path.id && 'No response or tie'].filter(Boolean).join(' · ');
        // The order consequences are listed in (Outline, Response, the room's options); routes and rules are unchanged.
        const order = element(doc, 'td', undefined, 'builder-path-order'), at = paths.indexOf(path), named = path.label || 'Untitled consequence';
        for (const [glyph, delta, word] of [['↑', -1, 'earlier'], ['↓', 1, 'later']]) {
          const move = button(doc, glyph, () => moveWithin(decision.id, item => item.paths, at, at + delta, `Consequence moved ${word}.`), 'builder-btn builder-icon-tool');
          move.setAttribute('aria-label', `Move “${named}” ${word}`); move.disabled = at + delta < 0 || at + delta >= paths.length; order.append(move);
        }
        // Each cell names its column, so at phone width a consequence reads as a labelled card (round 19).
        const cell = (text, label) => { const td = element(doc, 'td', text); td.dataset.label = label; return td; };
        order.dataset.label = 'Order'; row.append(name, cell(to, 'Leads to'), cell(notes || '—', 'Notes'), order);
        body.append(row);
      }
      list.append(body);
      const scroller = element(doc, 'div', undefined, 'builder-matrix'); scroller.tabIndex = 0; scroller.setAttribute('role', 'region'); scroller.setAttribute('aria-label', 'Consequences');
      scroller.append(list); panel.append(scroller);
    }
    panel.append(button(doc, 'Add consequence', () => addPath(decision.id)));
    nodes.push(panel);
  }

  function renderOptions(panel, decision) {
    panel.append(element(doc, 'h5', 'Responses'));
    for (const [index, option] of (decision.interaction?.options ?? []).entries()) {
      const row = element(doc, 'div', undefined, 'builder-option-row');
      const decisionIndex = findIndexById(activeDocument().decisions, decision.id);
      row.append(makeInlineInput(`${option.id}:label`, `Response ${index + 1}`, option.label ?? '', value => updateById('decisions', decision.id, d => { d.interaction.options[index].label = value; }), `/decisions/${decisionIndex}/interaction/options/${index}/label`));
      // Compact order arrows beside the field, as in the Consequences table; their full names are their labels (round 12).
      const count = decision.interaction.options.length, tools = element(doc, 'div', undefined, 'builder-row-tools');
      for (const [glyph, delta, word] of [['↑', -1, 'earlier'], ['↓', 1, 'later']]) {
        const move = button(doc, glyph, () => moveWithin(decision.id, item => item.interaction?.options, index, index + delta, `Response moved ${word}.`), 'builder-btn builder-icon-tool');
        move.setAttribute('aria-label', `Move response ${index + 1} ${word}`); move.disabled = index + delta < 0 || index + delta >= count; tools.append(move);
      }
      const report = builderDependencyReport(activeDocument(), { kind: 'option', id: option.id });
      // A remove glyph, no text (Julian, 2026-10-13); its full name is its accessible label and tooltip.
      const remove = button(doc, '×', () => requestRemove('option', option.id, report), 'builder-btn builder-icon-tool builder-danger');
      remove.setAttribute('aria-label', `Remove response ${index + 1}`); remove.title = `Remove response ${index + 1}`; tools.append(remove);
      row.append(tools);
      panel.append(row);
    }
    panel.append(button(doc, 'Add response option', () => addOption(decision.id)));
    if (decision.interaction?.type === 'single_choice' && (decision.paths ?? []).length && (decision.interaction.options ?? []).length) {
      // BWR05: a compact matrix references each response and consequence once; overflow scrolls inside it only.
      panel.append(element(doc, 'p', 'Map each authored response to one consequence. The facilitator still selects the path.'));
      const scroller = element(doc, 'div', undefined, 'builder-matrix'); scroller.tabIndex = 0; scroller.setAttribute('role', 'region'); scroller.setAttribute('aria-label', 'Response mapping');
      const table = element(doc, 'table'), head = element(doc, 'tr');
      table.append(element(doc, 'caption', 'Response mapping', 'builder-sr-only'));
      head.append(element(doc, 'th', 'Response'));
      for (const path of decision.paths) { const th = element(doc, 'th', path.label || 'Untitled consequence'); th.scope = 'col'; head.append(th); }
      const thead = element(doc, 'thead'); thead.append(head); table.append(thead);
      const body = element(doc, 'tbody');
      for (const option of decision.interaction.options) {
        const row = element(doc, 'tr'), name = element(doc, 'th', option.label || 'Untitled response'); name.scope = 'row'; row.append(name);
        for (const path of decision.paths) {
          const cell = element(doc, 'td'), input = element(doc, 'input'); input.type = 'checkbox'; input.checked = Boolean(path.option_ids?.includes(option.id));
          input.setAttribute('aria-label', `${option.label || 'Untitled response'} leads to ${path.label || 'Untitled consequence'}`);
          input.dataset.controlKey = `matrix:${option.id}:${path.id}`;
          input.addEventListener('change', () => toggleOptionMapping(decision.id, path.id, option.id, input.checked));
          cell.append(input); row.append(cell);
        }
        body.append(row);
      }
      table.append(body); scroller.append(table); panel.append(scroller);
    }
  }

  function reviewInteractionType(decision, nextType) {
    const current = decision.interaction?.type;
    if (!['single_choice', 'multi_select', 'ranking', 'free_text'].includes(nextType) || nextType === current) return;
    const drops = [];
    if (nextType === 'free_text') for (const option of decision.interaction?.options ?? []) drops.push(`Response “${option.label || 'Untitled response'}”`);
    // Only single choice maps responses to consequences (D20): leaving it drops every mapping, listed here when it
    // maps anything, so a branching single-choice question never changes unreviewed.
    if (nextType !== 'single_choice') for (const path of decision.paths ?? []) if (path.option_ids?.length) drops.push(`Response mappings on “${path.label || 'Untitled consequence'}”`);
    const allowed = nextType === 'multi_select' ? ['includes_all', 'includes_any', 'excludes']
      : nextType === 'ranking' ? ['top', 'before'] : nextType === 'free_text' ? ['keywords'] : [];
    for (const rule of decision.rules ?? []) {
      const key = Object.keys(rule.when ?? {})[0];
      if (!allowed.includes(key)) drops.push(`Rule “${rule.reason || rule.when?.keywords?.join(', ') || key || 'Untitled rule'}”`);
    }
    const panel = element(doc, 'section', undefined, 'builder-confirm-change');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Review response type change');
    panel.append(element(doc, 'h4', `Change response type to ${interactionLabel(nextType)}?`));
    panel.append(element(doc, 'p', drops.length
      ? `This change removes these incompatible authored items: ${drops.join('; ')}. Other compatible options, routes and settings stay as authored.`
      : 'This keeps current options and compatible authored rules. Ranking settings will be initialized to Priority if needed.'));
    panel.append(button(doc, 'Apply response type change', () => {
      const next = clone(activeDocument());
      const target = next.decisions.find(item => item.id === decision.id);
      const options = target.interaction?.options ?? [];
      target.interaction = nextType === 'free_text'
        ? { type: nextType, max_length: FREE_TEXT_MAX }
        : { type: nextType, options: clone(options), ...(nextType === 'ranking' ? { order_meaning: 'priority' } : {}) };
      if (nextType !== 'single_choice') for (const path of target.paths ?? []) delete path.option_ids;
      target.rules = (target.rules ?? []).filter(rule => allowed.includes(Object.keys(rule.when ?? {})[0]));
      if (target.interpretation === 'facilitator') target.rules = [];
      panel.remove();
      commit(next, activeMetadata(), { structural: true, label: `Response type changed to ${interactionLabel(nextType)}. Review the updated response settings.` });
    }));
    panel.append(button(doc, 'Cancel', () => panel.remove()));
    reviewHost.append(panel);
  }

  function reviewInterpretationChange(decision, nextValue) {
    if (nextValue === (decision.interpretation || 'rules')) return;
    const rules = decision.rules ?? [];
    if (nextValue !== 'facilitator' || !rules.length) { updateDecision(decision.id, 'interpretation', nextValue); return; }
    const panel = element(doc, 'section', undefined, 'builder-confirm-change');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Review interpretation change');
    panel.append(element(doc, 'h4', 'Use facilitator interpretation?'));
    panel.append(element(doc, 'p', `This removes ${rules.length} authored response ${rules.length === 1 ? 'rule' : 'rules'}: ${rules.map((rule, index) => `${index + 1}. ${rule.reason || formatRule(rule)}`).join('; ')}. Votes remain context; the facilitator selects an authored consequence.`));
    panel.append(dangerButton(doc, 'Remove listed rules and use facilitator interpretation', () => {
      panel.remove(); updateById('decisions', decision.id, item => { item.interpretation = 'facilitator'; delete item.rules; });
    }));
    panel.append(button(doc, 'Cancel', () => { panel.remove(); render(); }));
    reviewHost.append(panel);
  }

  function renderRules(panel, decision) {
    panel.append(element(doc, 'h5', 'Response rules'));
    if (decision.interpretation === 'facilitator') {
      panel.append(element(doc, 'p', 'Votes provide context. They do not select a consequence; the facilitator chooses an authored path.'));
      return;
    }
    for (const [index, rule] of (decision.rules ?? []).entries()) {
      const row = element(doc, 'section', undefined, 'builder-rule-row');
      row.append(element(doc, 'h6', `Rule ${index + 1}`));
      row.append(makeSelect('When this condition matches, use', (decision.paths ?? []).map(path => [path.id, path.label || 'Untitled consequence']), rule.path_id, value => updateRule(decision.id, index, 'path_id', value)));
      const decisionIndex = findIndexById(activeDocument().decisions, decision.id);
      row.append(makeInlineInput(`${decision.id}:rule:${index}:reason`, 'Why this rule applies (private)', rule.reason ?? '', value => updateRule(decision.id, index, 'reason', value), `/decisions/${decisionIndex}/rules/${index}/reason`));
      const condition = Object.entries(rule.when ?? {})[0] ?? [decision.interaction?.type === 'free_text' ? 'keywords' : decision.interaction?.type === 'ranking' ? 'top' : 'includes_all', []];
      row.append(makeSelect('Condition', ruleKeys(decision.interaction?.type).map(key => [key, key.replaceAll('_', ' ')]), condition[0], key => updateRule(decision.id, index, 'when', { [key]: condition[1] })));
      if (condition[0] === 'keywords') row.append(makeInlineInput(`${decision.id}:rule:${index}:keywords`, 'Matching phrases, separated by commas', condition[1].join(', '), text => updateRule(decision.id, index, 'when', { keywords: text.split(',').map(value => value.trim()).filter(Boolean) }), `/decisions/${decisionIndex}/rules/${index}/when/keywords`));
      else if (condition[0] === 'before') {
        const options = decision.interaction?.options ?? [];
        const list = options.map(option => [option.id, option.label || 'Untitled response']);
        const pair = Array.isArray(condition[1]) ? condition[1] : [];
        const choosePair = (higher, lower) => {
          const ordered = rankingBeforePair(higher, lower);
          if (!ordered) { setStatus('Choose two different ranked responses.'); return; }
          updateRule(decision.id, index, 'when', { before: ordered });
        };
        row.append(makeSelect('Ranked above', list, pair[0] ?? '', value => choosePair(value, value === pair[1] ? options.find(option => option.id !== value)?.id : pair[1])));
        row.append(makeSelect('Ranked below', list, pair[1] ?? '', value => choosePair(value === pair[0] ? options.find(option => option.id !== value)?.id : pair[0], value)));
      }
      else {
        const optionIds = condition[1];
        for (const option of decision.interaction?.options ?? []) {
          const label = element(doc, 'label', undefined, 'builder-check-row');
          const input = element(doc, 'input'); input.type = 'checkbox'; input.checked = optionIds.includes(option.id);
          input.addEventListener('change', () => {
            const selected = new Set(optionIds);
            if (input.checked) selected.add(option.id); else selected.delete(option.id);
            updateRule(decision.id, index, 'when', { [condition[0]]: [...selected] });
          });
          label.append(input, doc.createTextNode(option.label || 'Untitled response')); row.append(label);
        }
      }
      row.append(dangerButton(doc, `Remove rule ${index + 1}`, () => updateDecision(decision.id, 'rules', (decision.rules ?? []).filter((_, i) => i !== index))));
      panel.append(row);
    }
    panel.append(button(doc, 'Add response rule', () => addRule(decision.id)));
  }

  function renderPathControls(nodes, document, beat, path, isSlide = false) {
    const decisionIndex = findIndexById(document.decisions, beat.decision_id);
    const pathIndex = findIndexById(document.decisions?.[decisionIndex]?.paths, path.id);
    const prefix = `/decisions/${decisionIndex}/paths/${pathIndex}`;
    const panel = element(doc, 'section', undefined, 'builder-path-panel');
    panel.append(element(doc, 'h4', 'Selected consequence'));
    panel.append(makeInlineInput(`${path.id}:label`, 'Consequence name', path.label ?? '', value => updateById('decisions', beat.decision_id, d => { d.paths.find(item => item.id === path.id).label = value; }), `${prefix}/label`));
    panel.append(makeSelect('Teaching classification', ['sound', 'defensible', 'context-dependent', 'unsafe', 'terminal-unsafe', 'discussion-prompt'].map(value => [value, value.replaceAll('-', ' ')]), path.classification, value => updatePath(beat.decision_id, path.id, 'classification', value), `${prefix}/classification`));
    panel.append(makeSelect('Learner content to reveal', (document.surfaces ?? []).map(surface => [surface.id, surface.title || 'Untitled content']), path.reveal_surface_id, value => updatePath(beat.decision_id, path.id, 'reveal_surface_id', value), `${prefix}/reveal_surface_id`));
    panel.append(makeSelect('Continue to stage', [['', 'Choose a stage'], ...(document.beats ?? []).map(item => [item.id, item.title || 'Untitled stage'])], path.next_beat_id ?? '', value => updatePath(beat.decision_id, path.id, 'next_beat_id', value || undefined), `${prefix}/next_beat_id`));
    panel.append(makeSelect('Recommended main path', [['', 'Choose recommended consequence'], ...(document.decisions.find(d => d.id === beat.decision_id)?.paths ?? []).map(item => [item.id, item.label || 'Untitled consequence'])], document.decisions.find(d => d.id === beat.decision_id)?.paths?.find(item => item.recommended)?.id ?? '', value => { if (value) setRecommendedPath(beat.decision_id, value); }, `${prefix}/recommended`));
    // Rationale, cue, recovery action and debrief prompt each have one editor, in the stage's fields (Facilitator notes on
    // a slide); this panel keeps only the consequence's structure (one editor per field, §3/§5).
    panel.append(dangerButton(doc, `Review removal of ${path.label || 'this consequence'}`, () => requestRemove('path', path.id, builderDependencyReport(activeDocument(), { kind: 'path', id: path.id }))));
    // Mappings left from single choice (D20) are read by nothing; this is where they are cleared.
    const owner = document.decisions?.[decisionIndex];
    if (owner?.interaction?.type !== 'single_choice' && Object.hasOwn(path, 'option_ids')) {
      const left = element(doc, 'div', undefined, 'builder-leftover'), clear = button(doc, 'Clear response mappings', () => clearLeftoverMappings(path.id));
      clear.dataset.controlKey = `leftover-mappings:${path.id}`; clear.dataset.documentPointer = `${prefix}/option_ids`;
      left.append(element(doc, 'p', path.option_ids?.length ? 'Response mappings left from single choice. This question type does not use them.' : 'An empty response mapping left from single choice.'), clear);
      panel.append(left);
    }
    const flags = document.flags ?? [];
    panel.append(makeMultiSelect('Flags set by this consequence', flags.map(flag => [flag.key, flag.label || flag.key]), path.set_flags ?? [], value => updatePath(beat.decision_id, path.id, 'set_flags', value), `${prefix}/set_flags`));
    panel.append(makeMultiSelect('Flags cleared by this consequence', flags.map(flag => [flag.key, flag.label || flag.key]), path.clear_flags ?? [], value => updatePath(beat.decision_id, path.id, 'clear_flags', value), `${prefix}/clear_flags`));
    if (path.terminal) {
      panel.append(button(doc, 'Make this consequence continue from its checkpoint', () => {
        replacePath(beat.decision_id, path.id, current => configurePathTerminal(current, null, { decisionBeatId: beat.id }));
      }));
      panel.append(makeSelect('Terminal checkpoint', (document.beats ?? []).map(item => [item.id, item.title || 'Untitled stage']), path.terminal.checkpoint_beat_id ?? '', value => updatePath(beat.decision_id, path.id, 'terminal/checkpoint_beat_id', value), `${prefix}/terminal/checkpoint_beat_id`));
    } else panel.append(button(doc, 'Make this a terminal consequence', () => {
      // PREVIEW-02: it resets to its own question, the one checkpoint that lies on every route to it; the author can
      // choose an earlier stage under Terminal checkpoint.
      replacePath(beat.decision_id, path.id, current => configurePathTerminal(current, beat.id));
    }));
    if (document.schema_version >= 2) {
      const required = element(doc, 'label', undefined, 'builder-check-row');
      const control = element(doc, 'input'); control.type = 'checkbox'; control.checked = Boolean(path.recovery);
      control.addEventListener('change', () => toggleRecovery(beat.decision_id, path.id, control.checked));
      required.append(control, doc.createTextNode('Require facilitator confirmation before continuing'));
      panel.append(required);
    }
    nodes.push(panel);
  }

  function renderCaseTools(document, beat) {
    const section = element(doc, 'div', undefined, 'builder-case-details');
    section.append(makeSelect('First teaching stage', (document.beats ?? []).map(item => [item.id, item.title || 'Untitled stage']), document.start_beat_id ?? '', value => {
      const next = clone(activeDocument()); next.start_beat_id = value; commit(next, activeMetadata(), { focusKey: 'select:First teaching stage', label: 'First teaching stage updated.' });
    }));
    section.append(button(doc, 'Add private preparation requirements', () => addPreparationRequirements()));
    for (const flag of document.flags ?? []) {
      const row = element(doc, 'div', undefined, 'builder-flag-row');
      row.append(makeInlineInput(`${flag.id}:label`, 'Flag name', flag.label ?? '', value => updateById('flags', flag.id, item => { item.label = value; })));
      row.append(makeInlineInput(`${flag.id}:key`, 'Flag key', flag.key ?? '', value => renameFlag(flag.id, value)));
      row.append(dangerButton(doc, 'Remove flag', () => requestRemove('flag', flag.id, builderDependencyReport(document, { kind: 'flag', id: flag.id }))));
      section.append(row);
    }
    section.append(button(doc, 'Add narrative flag', () => addFlag()));
    const ownedSurface = document.surfaces?.find(surface => surface.id === beat?.surface_id);
    if (ownedSurface) {
      section.append(makeMultiSelect('Required flags before this stage', (document.flags ?? []).map(flag => [flag.key, flag.label || flag.key]), beat?.requires_flags ?? [], value => updateById('beats', beat.id, item => { item.requires_flags = value; })));
      section.append(makeSelect('Presentation purpose', ['handover','update','observations','image','ecg','gas','text','debrief','reflection','wrap_up'].map(value => [value, value.replaceAll('_',' ')]), ownedSurface.kind, value => updateById('surfaces', ownedSurface.id, item => { item.kind = value; })));
      for (const [variantIndex, variant] of (ownedSurface.variants ?? []).entries()) {
        section.append(makeMultiSelect(`Variant ${variantIndex + 1} appears when these flags are set`, (document.flags ?? []).map(flag => [flag.key, flag.label || flag.key]), variant.when_flags ?? [], value => updateSurfaceVariant(ownedSurface.id, variantIndex, value)));
      }
      if (!composed(beat)) section.append(button(doc, 'Add content variant', () => addVariant(ownedSurface.id)));
    }
    for (const clarification of document.clarifications ?? []) {
      const row = element(doc, 'section', undefined, 'builder-clarification-row');
      row.append(makeInlineInput(`${clarification.id}:label`, 'Clarification label', clarification.label ?? '', value => updateById('clarifications', clarification.id, item => { item.label = value; })));
      row.append(makeSelect('Clarification content', (document.surfaces ?? []).map(surface => [surface.id, surface.title || 'Untitled content']), clarification.surface_id, value => updateById('clarifications', clarification.id, item => { item.surface_id = value; })));
      row.append(makeMultiSelect('Available during these stages', (document.beats ?? []).map(item => [item.id, item.title || 'Untitled stage']), clarification.beat_ids ?? [], value => updateById('clarifications', clarification.id, item => { item.beat_ids = value; })));
      // D15: its slide opens from here as well as from the Outline, where it is listed under its first stage.
      if (document.compositions?.some(item => item.owner?.kind === 'clarification' && item.owner.id === clarification.id)) {
        const open = button(doc, 'Edit its slide', () => { if (selectClarification(clarification.id)) { panels.showSlide(); render(); sheetHeading.focus(); } }, 'builder-btn');
        open.setAttribute('aria-label', `Edit the slide of clarification ${clarification.label || 'Untitled clarification'}`);
        row.append(open);
      }
      section.append(row);
    }
    section.append(button(doc, 'Add early clarification', () => addClarification()));
    caseToolsHost.replaceChildren(section);
  }

  /** Readiness as data (CASE-321): each slide's entry with its problems, and the source lines; Readiness and the Overview show it. */
  function readinessModel(document) {
    const preserve = checked(document, activeMetadata(), 'preserve');
    const ready = checked(document, activeMetadata(), 'ready');
    // The shared validators speak the schema's words (paths, beats); Readiness uses the Builder's (re-audit round 11).
    // No raw ids in Readiness (final audit, round 15): an id becomes the record's name, or "a record" if it has none.
    const promptWords = prompt => { const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '').replace(/"[a-z_]+":|[{}\[\]"]/g, ' '); const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' '); return words ? `“${words}…”` : 'an untitled question'; };
    const names = new Map([...(document?.beats ?? []).map(beat => [beat.id, `“${beat.title || 'Untitled stage'}”`]), ...(document?.decisions ?? []).map(decision => [decision.id, `the question ${promptWords(decision.prompt)}`]),
      ...(document?.decisions ?? []).flatMap(decision => (decision.paths ?? []).map(path => [path.id, `“${path.label || 'Untitled consequence'}”`]))]);
    const unid = message => message.replace(/\b(?:Decision|Beat|Path|Stage|Consequence)?\s?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, (whole, id) => names.get(id.toLowerCase()) ?? 'a record');
    const plain = message => typeof message === 'string' ? unid(message).replace(/\bpaths\b/g, 'consequences').replace(/\bpath\b/g, 'consequence').replace(/\bbeats\b/g, 'stages').replace(/\bbeat\b/g, 'stage') : message;
    // Builder wording for codes whose schema text is unclear, and sentence case for the rest (round 12).
    const WORDING = { provenance_unreviewed: 'Source trace not reviewed yet', provenance_stale: 'Source trace changed since it was reviewed: review it again' };
    const branching = issue => issue.code === 'branching_complexity' ? `${/^(\d+)/.exec(issue.message ?? '')?.[1] ?? 'Many'} consequences: more than the recommended one plus two alternatives.` : null;
    const sentence = message => typeof message === 'string' && message ? message[0].toUpperCase() + message.slice(1) : message;
    // A collection's count limit names what is counted and how many there are (round 12): "Must have 1–99 items" on
    // /beats reads as the room's stage limit.
    const COUNTED = { beats: ['stages', 'a room runs'], compositions: ['slides', 'a case holds'], blocks: ['blocks', 'a case holds'], decisions: ['decisions', 'a case holds'], surfaces: ['content records', 'a case holds'] };
    const counted = issue => { const name = /^\/([a-z_]+)$/.exec(issue.at ?? '')?.[1], limit = /1[–-](\d+) items/.exec(issue.message ?? '')?.[1];
      return name && limit && COUNTED[name] ? `This case has ${(document?.[name] ?? []).length} ${COUNTED[name][0]}; ${COUNTED[name][1]} at most ${limit}.${name === 'beats' ? ' The Preview cannot run it until stages are removed or combined.' : ''}` : null; };
    // Case-wide fields name themselves and what they need (round 28 P1-2): "Length must be 1–1200" named no field.
    const namedCase = issue => caseWords(issue, document, activeMetadata(), plain);
    // A trend chart's problem says which field (round 28 P2-5): "Name the vertical axis", not "Needs text".
    const trendWords = issue => {
      const [, index, rest] = /^\/blocks\/(\d+)(\/.*)$/.exec(issue.at ?? '') ?? [], block = index !== undefined && document.blocks?.[Number(index)];
      const target = block?.type === 'trend' ? slides?.trendTarget?.(block, rest) : null;
      if (!target?.text) return null;
      return issue.code === 'required' ? target.text : issue.code === 'empty_series' ? `${target.text} needs at least one value` : `${target.text}: ${sentence(plain(issue.message))}`;
    };
    const seen = new Set(), fresh = list => (list ?? []).filter(issue => { const key = `${issue.code}|${issue.at}|${issue.message}`; return !seen.has(key) && seen.add(key); }).map(issue => ({ ...issue, message: WORDING[issue.code] ?? branching(issue) ?? counted(issue) ?? namedCase(issue) ?? trendWords(issue) ?? sentence(plain(issue.message)) }));
    // BWR12: editable-content problems, rehearsal blockers, review and publication requirements — each issue once.
    // Case-wide projector fit (gap audit #10): measured in the background, so it joins once each slide is measured.
    // The Builder holds up to its byte and block caps, but a room runs at most 99 stages (CASE-237): said plainly here.
    const roomCap = (document?.beats ?? []).length > 99 && !(ready.errors ?? []).some(issue => issue.at === '/beats')
      ? [{ code: 'room_stage_cap', at: '/beats', message: `This case has ${document.beats.length} stages; a room runs at most 99. The Preview cannot run it until stages are removed or combined.` }] : [];
    // Julian (CASE-238): Readiness is a slide checklist. Each slide that needs work is one entry holding all its problems;
    // case-wide problems come first; source traces are one line with a single Mark all reviewed.
    const fit = unfitIssues.map(issue => ({ ...issue, at: `/compositions/${(document.compositions ?? []).findIndex(item => item.id === issue.compositionId)}` })).filter(issue => !issue.at.endsWith('/-1'));
    const all = [...roomCap.map(issue => ({ ...issue, stops: 'run' })), ...fresh(preserve.errors).map(issue => ({ ...issue, stops: 'save' })), ...fresh(ready.errors).map(issue => ({ ...issue, stops: 'run' })),
      ...fresh(publicationIssues(document, activeMetadata(), ready)).filter(issue => !['provenance_unreviewed', 'provenance_stale'].includes(issue.code)).map(issue => ({ ...issue, stops: 'publish' })), ...fresh(preserve.warnings).map(issue => ({ ...issue, stops: null })), ...fit.map(issue => ({ ...issue, stops: null }))];
    // Traces not yet reviewed (imported) keep their one line; traces whose slide or source changed since they were
    // confirmed are one line too, counted by slide (CASE-321).
    const provenance = activeMetadata().provenance ?? [], unreviewed = provenance.filter(entry => entry.review_status !== 'confirmed' && entry.review_status !== 'stale').length;
    const staleSlides = new Set(provenance.filter(entry => entry.review_status === 'stale').map(entry => traceHome(document, entry.entity_id) ?? entry.entity_id)).size;
    const traces = unreviewed + staleSlides;
    if (publicationCheck) {
      const state = saveState.snapshot();
      const current = publication && publication.generation === state.localGeneration && publication.revision === state.baseRevision && !state.dirty;
      // CASE-342: image approval is gone; a server still naming an unapproved image is not a blocker.
      all.push(...(current ? publication.issues.filter(issue => issue.code !== 'asset_not_approved') : [{ code: 'publication_unchecked', message: state.dirty ? 'Save this draft before checking publishing.' : 'Check publishing to verify the saved revision, images and storage limits.' }]).map(issue => ({ ...issue, stops: 'publish' })));
    }
    const groups = new Map();
    // Both leftovers have their own control (D20, D22): mappings clear from the consequence, unused content from its entry.
    const leftover = new Set(leftoverMappings(document).map(item => item.pathId));
    const unused = unusedContent(document, activeMetadata());
    const unusedAt = new Map([...unused.surfaces, ...unused.traced].map(item => [(document.surfaces ?? []).findIndex(surface => surface.id === item.id), item]));
    const unusedOf = issue => unusedAt.get(Number(/^\/surfaces\/(\d+)(?:\/|$)/.exec(issue.at ?? '')?.[1] ?? -1)) ?? null;
    // Unused content is named even when its own fields are valid, so every leftover has its entry.
    for (const [index, item] of unusedAt) if (index >= 0) all.push({ code: 'unused_surface', at: `/surfaces/${index}`, message: item.title, stops: null });
    for (const issue of all) {
      const pointer = /^\/decisions\/(\d+)\/paths\/(\d+)\/option_ids$/.exec(issue.at ?? '');
      if (pointer && leftover.has(document.decisions?.[Number(pointer[1])]?.paths?.[Number(pointer[2])]?.id)) {
        issue.message = 'Response mappings left from single choice; this question type does not use them';
      }
    }
    // An unnamed slide stage's learner heading follows its name (CASE-247): one line, "Name this stage", not two (r24 P3).
    const follows = issue => { const id = document.schema_version === 3 && document.surfaces?.[Number(/^\/surfaces\/(\d+)\/title$/.exec(issue.at ?? '')?.[1] ?? -1)]?.id;
      return Boolean(id) && (document.beats ?? []).filter(beat => beat.surface_id === id).length === 1 && document.beats.some(beat => beat.surface_id === id && !beat.title); };
    for (const issue of all.filter(item => !follows(item))) {
      // Content nothing shows is one entry that says so, never its fields' problems with nothing to open (D22).
      const unused = unusedOf(issue);
      if (unused) {
        const key = `Unused content “${unused.title}”`;
        if (!groups.has(key)) groups.set(key, { name: key, home: null, order: -1, unused, issues: [] });
        groups.get(key).issues.push(issue); continue;
      }
      const home = slidePointer(document, issue.at), key = home ? recordName(document, home) : 'Case';
      if (!groups.has(key)) groups.set(key, { name: key, home, order: home ? slideOrder(document, home) : -1, issues: [] });
      groups.get(key).issues.push(issue);
    }
    const entries = [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return { all, entries, traces, unreviewed, staleSlides, truncated: preserve.issuesTruncated || ready.issuesTruncated };
  }
  /** Ask the service whether the saved revision can be published (images, storage, limits); the answer joins Readiness and Check. */
  async function runPublicationCheck() {
    if (publicationChecking || !publicationCheck) return;
    const state = saveState.snapshot();
    if (state.dirty || state.status !== 'saved') { setStatus('Save the draft before checking publishing.'); return; }
    publicationChecking = true; renderIssues(activeDocument());
    try {
      const result = await publicationCheck(state.baseRevision);
      if (!Array.isArray(result?.issues) || result.revision !== state.baseRevision || typeof result.ready !== 'boolean') throw Error('invalid_readiness');
      publication = { revision: state.baseRevision, generation: state.localGeneration, issues: result.issues };
    } catch { publication = null; setStatus('Publishing could not be checked. Check again when the service is available.'); }
    finally { publicationChecking = false; if (!destroyed) renderIssues(activeDocument()); }
  }

  // ── Check (CASE-344): every blocker in one list, each with Fix to the field ──
  const distinct = issues => { const byMessage = new Map(); for (const issue of issues) { const message = issue.message || 'Review this field'; if (!byMessage.has(message)) byMessage.set(message, []); byMessage.get(message).push(issue); } return [...byMessage].map(([message, items]) => ({ message, items })); };
  function checkModel(model) {
    const groups = model.entries.filter(group => !group.unused).map(group => ({ group, blockers: distinct(group.issues.filter(issue => issue.stops && issue.code !== 'publication_unchecked')), advice: distinct(group.issues.filter(issue => !issue.stops)) }));
    const unchecked = model.all.some(issue => issue.code === 'publication_unchecked');
    const count = groups.reduce((sum, item) => sum + item.blockers.length, 0) + (model.staleSlides ? 1 : 0) + (model.unreviewed ? 1 : 0);
    return { groups, unchecked, count, model };
  }
  function paintCheck(model) {
    const check = checkModel(model);
    checkDot.textContent = String(check.count); checkDot.hidden = !check.count;
    checkButton.setAttribute('aria-label', check.count ? `Check, ${check.count} to fix` : 'Check, nothing to fix');
    if (checkDialog.open) renderCheck(check);
    return check;
  }
  function renderCheck(check = checkModel(readinessModel(activeDocument()))) {
    const document = activeDocument(), STOPS = { save: 'stops saving', run: 'stops preview', publish: 'stops publishing' };
    const title = element(doc, 'h2', 'Check'); title.id = 'builderCheckTitle';
    const sub = element(doc, 'p', check.count ? `${check.count} ${check.count === 1 ? 'thing' : 'things'} to fix before publishing. Fix takes you to the field.` : 'Nothing to fix.', 'builder-slide-note'); sub.setAttribute('role', 'status');
    const list = element(doc, 'ul', undefined, 'builder-check-list');
    const fix = (label, run) => { const control = button(doc, 'Fix', () => { checkDialog.close(); run(); }, 'builder-btn builder-check-fix'); control.setAttribute('aria-label', `Fix: ${label}`); return control; };
    for (const { group, blockers } of check.groups) {
      if (!blockers.length) continue;
      const section = element(doc, 'li', undefined, 'builder-check-group'), inner = element(doc, 'ul'); section.append(element(doc, 'h3', group.name));
      for (const { message, items } of blockers) {
        const row = element(doc, 'li'), stops = items.find(issue => issue.stops)?.stops;
        row.append(element(doc, 'span', `${message}${items.length > 1 ? ` · ${items.length}` : ''}`), ...(stops ? [element(doc, 'small', STOPS[stops])] : []));
        row.append(fix(`${group.name}: ${message}`, () => navigateIssue(document, items[0].at)));
        inner.append(row);
      }
      section.append(inner); list.append(section);
    }
    const traces = [[check.model.staleSlides, `${check.model.staleSlides} ${check.model.staleSlides === 1 ? 'slide' : 'slides'} changed since cited`], [check.model.unreviewed, `Sources: ${check.model.unreviewed} ${check.model.unreviewed === 1 ? 'trace' : 'traces'} not reviewed`]].filter(([count]) => count);
    if (traces.length) { const section = element(doc, 'li', undefined, 'builder-check-group'), inner = element(doc, 'ul'); section.append(element(doc, 'h3', 'Sources'));
      for (const [, words] of traces) { const row = element(doc, 'li'); row.append(element(doc, 'span', words), element(doc, 'small', STOPS.publish), fix(words, () => openSources({ review: true }))); inner.append(row); }
      section.append(inner); list.append(section); }
    const foot = element(doc, 'div', undefined, 'builder-check-foot');
    if (publicationCheck) {
      const state = saveState.snapshot(), line = element(doc, 'p', check.unchecked ? (state.dirty ? 'Save this draft to check images and storage limits with the service.' : 'Images and storage limits are checked with the service.') : 'Checked with the service for this saved revision.', 'builder-slide-note');
      foot.append(line);
      if (check.unchecked && !state.dirty) foot.append(button(doc, publicationChecking ? 'Checking publishing…' : 'Check publishing', () => void runPublicationCheck(), 'builder-btn'));
    }
    const advice = check.groups.filter(item => item.advice.length);
    const more = advice.length ? element(doc, 'details', undefined, 'builder-check-advice') : null;
    if (more) { more.append(element(doc, 'summary', `Also worth a look · ${advice.reduce((sum, item) => sum + item.advice.length, 0)}`));
      for (const { group, advice: rows } of advice) for (const { message, items } of rows) { const row = element(doc, 'p'); row.append(element(doc, 'span', `${group.name}: ${message}`), group.home ? button(doc, 'Go', () => { checkDialog.close(); navigateIssue(document, items[0].at); }, 'builder-quiet-link') : doc.createTextNode('')); more.append(row); } }
    const close = button(doc, 'Close', () => checkDialog.close(), 'builder-btn');
    checkDialog.replaceChildren(element(doc, 'div', undefined, 'builder-check-body'));
    checkDialog.firstChild.append(title, sub, ...(list.childElementCount ? [list] : []), ...(more ? [more] : []), foot, close);
  }
  async function openCheck() {
    renderCheck(); if (!checkDialog.open) checkDialog.showModal();
    if (publicationCheck && !publicationChecking) { const state = saveState.snapshot(); if (!state.dirty && state.status === 'saved' && !publication) void runPublicationCheck(); }
  }
  checkDialog.addEventListener('close', () => checkButton.focus({ preventScroll: true }));

  // ── Import and export (CASE-344): the transfer tools, from the ⋯ menu in a dialog; they also live in the publishing view's lazy chunk ──
  let transferHandle = null;
  async function openTransfer() {
    if (!transferDialog.open) {
      transferDialog.replaceChildren(element(doc, 'p', 'Loading import and export…', 'builder-slide-note'));
      transferDialog.showModal();
    }
    try {
      const module = await import('./builder-workflows.mjs');
      transferHandle?.close();
      const body = element(doc, 'div', undefined, 'builder-transfer-body'), title = element(doc, 'h2', 'Import and export'); title.id = 'builderTransferTitle';
      const close = button(doc, 'Close', () => transferDialog.close(), 'builder-btn');
      transferDialog.replaceChildren(body);
      transferHandle = module.mountBuilderTransfer(body, {
        studio: { getSnapshot: () => saveState.snapshot(), applyImport },
        current: () => !destroyed && isCurrent(), slides: Boolean(slideCheck || slides), validateDocument,
        createCopy: async next => { const result = await onCreate({ candidate: { document: next.document, authoringMetadata: next.authoring_metadata }, provenance: { kind: 'copy' } }); return { ok: result?.created === true }; } });
      body.prepend(title); body.append(close);
    } catch { transferDialog.replaceChildren(element(doc, 'p', 'Import and export could not be loaded. The draft is unchanged.', 'builder-slide-note'), button(doc, 'Close', () => transferDialog.close(), 'builder-btn')); }
  }
  transferDialog.addEventListener('close', () => { transferHandle?.close(); transferHandle = null; moreFocus(); });
  const moreFocus = () => more.toggle.focus({ preventScroll: true });
  function applyImport(document, authoringMetadata) {
    if (!flushValidation()) return false;
    const before = { document: activeDocument(), authoringMetadata: activeMetadata() };
    const where = { ...currentSelection(), blockId: slideState.blockId ?? null };
    saveState.setDraft(document, authoringMetadata);
    history?.record(before, { document, authoringMetadata }, { label: 'Replace this draft', where: { before: where } });
    render();
    settleAfterImport();
    return true;
  }

  /** A save left uncertain before an import is asked again once the imported draft is in: the Reconcile button clears when the service answers. */
  function settleAfterImport() {
    syncStatus();
    if (saveState.snapshot().status === 'uncertain') void reconcile();
  }

  function renderIssues(document) {
    const model = readinessModel(document), { all, entries, traces, unreviewed, staleSlides, truncated } = model;
    const count = entries.filter(group => group.home).length, caseWide = (entries.find(group => group.name === 'Case' && !group.home)?.issues.length ?? 0) + entries.filter(group => group.unused).length;
    // The count waits for the first case-wide fit pass (round 18), so it settles once instead of climbing as slides are
    // measured; where slide editing is not loaded (the preview view, or a failed load) it shows the count at once (round 20).
    // Problems that stop saving or rehearsal set the zone's severity; the rest are advice.
    const stopping = all.some(issue => issue.stops);
    readinessZone.details.dataset.severity = stopping ? 'stop' : entries.length ? 'advice' : 'ready';
    readinessZone.summary.firstChild.textContent = !fitMeasured && slides && !slidesFailed && document?.schema_version === 3 && !container.closest?.('[hidden]') ? 'Readiness · checking fit…' : !entries.length && !traces ? 'Readiness · ready'
      : `Readiness · ${[count && `${count} ${count === 1 ? 'slide needs' : 'slides need'} work`, caseWide && `${caseWide} case ${caseWide === 1 ? 'item' : 'items'}`, !count && !caseWide && 'sources to review'].filter(Boolean).join(' · ')}`;
    issuesPanel.replaceChildren(element(doc, 'h3', 'Readiness and repairs', 'builder-sr-only'));
    paintCheck(model);
    if (publicationCheck) {
      const check = button(doc, publicationChecking ? 'Checking publishing…' : 'Check publishing', () => void runPublicationCheck(), 'builder-quiet-link');
      check.disabled = publicationChecking; issuesPanel.append(check);
    }
    if (!entries.length && !traces) { issuesPanel.append(element(doc, 'p', 'Nothing to fix.')); return; }
    const STOPS = { save: 'stops saving', run: 'stops preview', publish: 'stops publishing' };
    const shown = ui.readinessAll ? entries : entries.slice(0, 12);
    for (const group of shown) {
      const entry = element(doc, 'section', undefined, 'builder-readiness-slide');
      if (group.unused) { issuesPanel.append(unusedEntry(entry, group)); continue; }
      entry.append(group.home ? button(doc, group.name, () => navigateIssue(document, group.home), 'builder-issue-link builder-readiness-name') : element(doc, 'h4', 'Case', 'builder-readiness-name'));
      const list = element(doc, 'ul'), byMessage = new Map();
      for (const issue of group.issues) { const message = issue.message || 'Review this field'; if (!byMessage.has(message)) byMessage.set(message, []); byMessage.get(message).push(issue); }
      for (const [message, items] of [...byMessage].sort((a, b) => Number(Boolean(b[1][0].stops)) - Number(Boolean(a[1][0].stops)))) {
        const item = element(doc, 'li'), stops = items.find(issue => issue.stops)?.stops; item.dataset.stops = stops ?? ''; item.dataset.severity = stops && stops !== 'publish' ? 'stop' : 'advice';
        const action = button(doc, `${message}${items.length > 1 ? ` · ${items.length}` : ''}`, () => navigateIssue(document, items[0].at), 'builder-issue-link builder-issue-message');
        action.setAttribute('aria-label', `${group.name}: ${message}${stops ? ` (${STOPS[stops]})` : ''}`);
        item.append(action); if (stops) item.append(element(doc, 'span', STOPS[stops], 'builder-readiness-stops'));
        list.append(item);
      }
      entry.append(list); issuesPanel.append(entry);
    }
    if (entries.length > shown.length) issuesPanel.append(button(doc, `Show all ${entries.length}`, () => { ui.readinessAll = true; renderIssues(activeDocument()); }, 'builder-quiet-link'));
    if (staleSlides) {
      const line = element(doc, 'p', `${staleSlides} ${staleSlides === 1 ? 'slide' : 'slides'} changed since cited · stops publishing`, 'builder-readiness-cited');
      line.append(' · ', button(doc, 'Review all', () => openSources({ review: true }), 'builder-quiet-link'));
      issuesPanel.append(line);
    }
    if (unreviewed) {
      const line = element(doc, 'p', `Sources: ${unreviewed} ${unreviewed === 1 ? 'trace' : 'traces'} not reviewed · stops publishing`, 'builder-readiness-sources');
      line.append(' · ', button(doc, 'Mark all reviewed', () => {
        const next = clone(activeMetadata());
        for (const entry of next.provenance ?? []) if (entry.review_status !== 'confirmed' && entry.review_status !== 'stale') entry.review_status = 'confirmed';
        commit(activeDocument(), next, { structural: true, label: `All ${unreviewed} source traces marked reviewed.` });
      }, 'builder-quiet-link'));
      issuesPanel.append(line);
    }
    if (truncated) issuesPanel.append(element(doc, 'p', 'Some issues are not shown. Narrow the repair by section.'));

    /** One Readiness entry for content nothing shows (D22): what it is, and the one way to clear it. */
    function unusedEntry(entry, group) {
      const stops = group.issues.find(issue => issue.stops)?.stops, item = element(doc, 'li');
      item.dataset.stops = stops ?? ''; item.dataset.severity = stops && stops !== 'publish' ? 'stop' : 'advice';
      entry.append(element(doc, 'h4', group.name, 'builder-readiness-name'));
      item.append(element(doc, 'span', 'No stage, consequence or clarification shows this content.'));
      if (stops) item.append(' ', element(doc, 'span', STOPS[stops], 'builder-readiness-stops'));
      if (group.unused.traces.length) {
        item.append(' ', element(doc, 'span', 'Source traces point at it: move each to the record that now holds its text, or remove it, then remove the content here.'));
        const blockers = element(doc, 'ul', undefined, 'builder-removal-blockers'); for (const index of group.unused.traces) blockers.append(traceBlocker(index, null));
        item.append(blockers);
      } else {
        const remove = button(doc, 'Remove unused content', () => removeUnusedContent(group.unused.id), 'builder-btn builder-issue-link');
        remove.setAttribute('aria-label', `Remove unused content “${group.unused.title}”`);
        item.append(' ', remove);
      }
      const list = element(doc, 'ul'); list.append(item); entry.append(list);
      return entry;
    }
  }

  /** Remove one entry of unused content (D22) in its own undoable change; a source trace still on it keeps it. */
  function removeUnusedContent(id) {
    const entry = unusedContent(activeDocument(), activeMetadata()).surfaces.find(item => item.id === id);
    if (!entry) { setStatus('That content is shown by a stage now, or a source trace points at it.'); return false; }
    const next = clone(activeDocument()); next.surfaces = next.surfaces.filter(surface => surface.id !== id);
    return commit(next, activeMetadata(), { structural: true, label: `Removed unused content “${entry.title}”. Use Undo last change to restore it.` });
  }

  /** Clear the response mappings a consequence still holds from single choice (D20), in one undoable change. */
  function clearLeftoverMappings(pathId) {
    if (!leftoverMappings(activeDocument()).some(item => item.pathId === pathId)) { setStatus('That consequence has no response mappings to clear.'); return false; }
    const path = activeDocument().decisions.flatMap(decision => decision.paths ?? []).find(item => item.id === pathId);
    return commit(withoutMappings(activeDocument(), [pathId]), activeMetadata(), { structural: true, label: `Cleared the response mappings on “${path?.label || 'Untitled consequence'}”. Use Undo last change to restore them.` });
  }

  /** The slide (stage, consequence or clarification) an issue belongs to, as a pointer; null for case-wide issues. */
  function slidePointer(document, pointer) {
    const parts = String(pointer || '').split('/').filter(Boolean).map(decodePointer), at = Number(parts[1]);
    if (!Number.isInteger(at)) return null;
    const beatOf = id => { const index = (document.beats ?? []).findIndex(beat => beat.id === id); return index >= 0 ? `/beats/${index}` : null; };
    if (parts[0] === 'beats') return `/beats/${at}`;
    if (parts[0] === 'decisions') {
      const decision = document.decisions?.[at], path = parts[2] === 'paths' && Number.isInteger(Number(parts[3])) ? Number(parts[3]) : null;
      return path !== null ? `/decisions/${at}/paths/${path}` : beatOf(document.beats?.find(beat => beat.decision_id === decision?.id)?.id);
    }
    if (parts[0] === 'blocks') { const home = recordPointer(document, document.blocks?.[at]?.id); return home && home !== pointer ? slidePointer(document, home) : null; }
    if (parts[0] === 'clarifications') return `/clarifications/${at}`;
    if (parts[0] === 'surfaces' || parts[0] === 'compositions') {
      const owner = parts[0] === 'compositions' ? document.compositions?.[at]?.owner : null, id = parts[0] === 'surfaces' ? document.surfaces?.[at]?.id : null;
      if (owner?.kind === 'beat') return beatOf(owner.id);
      if (owner?.kind === 'clarification') { const index = (document.clarifications ?? []).findIndex(item => item.id === owner.id); return index >= 0 ? `/clarifications/${index}` : null; }
      const pathId = owner?.kind === 'path' ? owner.id : null;
      for (const [index, decision] of (document.decisions ?? []).entries()) { const path = (decision.paths ?? []).findIndex(item => item.id === pathId || (id && item.reveal_surface_id === id)); if (path >= 0) return `/decisions/${index}/paths/${path}`; }
      if (id) { const beat = beatOf(document.beats?.find(item => item.surface_id === id)?.id); if (beat) return beat;
        const clarification = (document.clarifications ?? []).findIndex(item => item.surface_id === id); if (clarification >= 0) return `/clarifications/${clarification}`; }
    }
    return null;
  }
  /** Outline order for a slide pointer: the spine number, a consequence just after its stage, everything else after. */
  function slideOrder(document, pointer) {
    const spine = new Map((outline.projection?.() ?? deriveBuilderOutline(document)).rows?.filter(row => row.kind === 'stage' && Number.isInteger(row.number)).map(row => [row.beatId, row.number]) ?? []);
    const parts = pointer.split('/').filter(Boolean), at = Number(parts[1]);
    // A clarification's slide follows the stage it is shown during, before that stage's consequences (D15).
    const shownDuring = parts[0] === 'clarifications' ? document.clarifications?.[at]?.beat_ids?.[0] : null;
    const beat = parts[0] === 'beats' ? document.beats?.[at] : parts[0] === 'decisions' ? document.beats?.find(item => item.decision_id === document.decisions?.[at]?.id)
      : shownDuring ? document.beats?.find(item => item.id === shownDuring) : null;
    return beat ? (spine.get(beat.id) ?? 500) * 10 + (parts[2] === 'paths' ? 1 : shownDuring ? 0.5 : 0) : 9000;
  }

  /** Where an authored record lives, as a pointer recordName can name: a block by the slide that shows it. */
  function recordPointer(document, id) {
    if (!id) return null;
    const at = (key, test = item => item?.id === id) => (document[key] ?? []).findIndex(test);
    const block = at('blocks');
    if (block >= 0) { const slide = at('compositions', item => item?.reading_order?.includes(id)); return slide >= 0 ? `/compositions/${slide}` : `/blocks/${block}`; }
    for (const [index, decision] of (document.decisions ?? []).entries()) { const path = (decision?.paths ?? []).findIndex(item => item?.reveal_surface_id === id); if (path >= 0) return `/decisions/${index}/paths/${path}`; }
    for (const key of ['beats', 'surfaces', 'decisions']) { const index = at(key); if (index >= 0) return `/${key}/${index}`; }
    for (const [index, decision] of (document.decisions ?? []).entries()) { const path = (decision?.paths ?? []).findIndex(item => item?.id === id); if (path >= 0) return `/decisions/${index}/paths/${path}`; }
    const clarification = at('clarifications');
    if (clarification >= 0) { const slide = at('compositions', item => item?.owner?.kind === 'clarification' && item.owner.id === id); return slide >= 0 ? `/compositions/${slide}` : `/clarifications/${clarification}`; }
    const slide = at('compositions'); return slide >= 0 ? `/compositions/${slide}` : null;
  }

  const FIELD_WORDS = { paragraphs: 'text', runs: 'text', items: 'list', prompt: 'question', notes: 'private notes', label: 'name', title: 'title', scene: 'scene', rationale: 'rationale', cue: 'cue', debrief_prompt: 'debrief question', caption: 'caption', rows: 'rows', entries: 'entries' };
  function traceName(document, entry) {
    const field = String(entry?.field ?? '').replace(/^.*\./, '').replace(/\[\d+\]/g, '');
    return (FIELD_WORDS[field] ?? (field.replaceAll('_', ' ') || 'text')).replace(/^./, c => c.toUpperCase());
  }

  /** A readable name for the record an issue points at, so a repair link says where it goes. */
  function recordName(document, pointer) {
    const parts = String(pointer || '').split('/').filter(Boolean).map(decodePointer), at = Number(parts[1]);
    // Numbered as the Outline and canvas head number the authored spine (gap audit #17), never by storage order.
    const spine = new Map((outline.projection?.() ?? deriveBuilderOutline(document)).rows?.filter(row => row.kind === 'stage' && Number.isInteger(row.number)).map(row => [row.beatId, row.number]) ?? []);
    const noun = document.schema_version === 3 ? 'Slide' : 'Stage';
    const stage = beat => !beat ? noun : spine.has(beat.id) ? `${noun} ${spine.get(beat.id)} · ${beat.title || 'Untitled stage'}` : `${beat.title || 'Untitled stage'} (off the main path)`;
    if (parts[0] === 'beats') return stage(document.beats?.[at]);
    const clarificationName = id => `Clarification · ${(document.clarifications ?? []).find(item => item.id === id)?.label || 'Untitled clarification'}`;
    if (parts.length === 1) return 'Case';
    if (parts[0] === 'surfaces') {
      const id = document.surfaces?.[at]?.id, beat = document.beats?.find(item => item.surface_id === id);
      if (beat) return stage(beat);
      const clarification = (document.clarifications ?? []).find(item => item.surface_id === id);
      if (clarification) return clarificationName(clarification.id);
      for (const decision of document.decisions ?? []) { const path = (decision.paths ?? []).find(item => item.reveal_surface_id === id); if (path) return `${stage(document.beats?.find(item => item.decision_id === decision.id))} · ${path.label || 'Untitled consequence'}`; }
      return 'Unused content';
    }
    if (parts[0] === 'decisions') {
      const decision = document.decisions?.[at], owner = stage(document.beats?.find(beat => beat.decision_id === decision?.id));
      return parts[2] === 'paths' ? `${owner} · ${decision?.paths?.[Number(parts[3])]?.label || 'Untitled consequence'}` : `${owner} · Question`;
    }
    if (parts[0] === 'clarifications') return clarificationName(document.clarifications?.[at]?.id);
    if (parts[0] === 'compositions' && document.compositions?.[at]?.owner?.kind === 'clarification') return clarificationName(document.compositions[at].owner.id);
    if (parts[0] === 'compositions') {
      const owner = ownerSelection(document, document.compositions?.[at]?.owner), beat = document.beats?.find(item => item.id === owner.beatId);
      const path = owner.pathId && (document.decisions ?? []).flatMap(item => item.paths ?? []).find(item => item.id === owner.pathId);
      return path ? `${stage(beat)} · ${path.label || 'Untitled consequence'}` : beat ? stage(beat) : `Slide ${at + 1}`;
    }
    // Re-audit #13: a block is named by the slide that shows it and its type, never by its storage position.
    if (parts[0] === 'blocks') {
      const block = document.blocks?.[at], home = (document.compositions ?? []).findIndex(item => item.reading_order?.includes(block?.id));
      const kind = { text: 'Text', list: 'List', quote: 'Quote', callout: 'Callout', values: 'Values', table: 'Table', timeline: 'Timeline', trend: 'Trend chart', gas: 'Blood gas', question: 'Question' }[block?.type] ?? 'Block';
      return home < 0 ? `${kind} block · not on a slide` : `${recordName(document, `/compositions/${home}`)} · ${kind}`;
    }
    // A source trace is named by the slide or stage it supports and its field, never by its storage position
    // (re-audit round 11); a trace whose record is gone keeps its number.
    if (parts[0] === 'provenance') {
      const entry = activeMetadata()?.provenance?.[at], owner = entry && recordPointer(document, entry.entity_id);
      if (!owner) return `Source trace ${at + 1}`;
      const where = recordName(document, owner), field = traceName(document, entry).toLowerCase();
      return where.toLowerCase().endsWith(` · ${field}`) ? where : `${where} · ${field}`;
    }
    if (parts[0] === 'sources') return `Source ${at + 1}`;
    return parts.length ? 'Case details' : 'Case';
  }

  // CASE-321: the Overview and the Sources panel are lazy chunks, loaded the first time either is shown.
  let overviewModule = null, overviewLoad = null, sourcesModule = null, sourcesLoad = null, sourcesFocus = null;
  const loading = (host, text) => { if (!host.firstChild) host.replaceChildren(element(doc, 'p', text, 'builder-slide-note')); };
  function renderOverview(document) {
    if (!overviewModule) {
      loading(overviewHost, 'Loading the overview…');
      overviewLoad ??= import('./builder-overview.mjs').then(module => { overviewModule = module; if (!destroyed && ui.view === 'overview') render(); },
        () => { overviewLoad = null; overviewHost.replaceChildren(element(doc, 'p', 'The overview could not be loaded. The draft is unchanged.')); });
      return;
    }
    overviewModule.renderOverview(overviewHost, overviewContext(document));
  }
  function overviewContext(document) {
    const open = (beatId, pathId = null, clarificationId = null) => { if (!beatId) return; ui.beatId = beatId; ui.pathId = pathId; ui.clarificationId = clarificationId; showView('path'); panels.showSlide(); };
    return { doc, document, metadata: activeMetadata(), projection: outline.projection?.() ?? deriveBuilderOutline(document), readiness: readinessModel(document), button, element,
      saved: saveLabel.textContent,
      open, openIssue: at => navigateIssue(document, at), openSources: () => showView('sources'), openDetails: () => showView('details'), preview: () => openPreviewWindow(),
      publish: primaryAction ? { label: primaryAction.getAttribute('aria-label') || primaryAction.textContent, run: () => primaryAction.click() } : null,
      reviewSources: () => openSources({ review: true }) };
  }
  function renderSourcesView(document) {
    const metadata = activeMetadata(), traces = metadata.provenance?.length ?? 0;
    sourcesAdvancedSummary.textContent = `Advanced · detailed source traces (${traces})`;
    if (ui.sourcesAdvanced) { sourcesAdvanced.open = true; ui.sourcesAdvanced = false; }
    if (sourcesModule) { const tools = element(doc, 'div'); renderSources(tools, metadata); renderProvenance(tools, document, metadata); sourceToolsHost.replaceChildren(tools); }
    if (!sourcesModule) { loading(sourcesPanelHost, 'Loading sources…'); void loadSources(); return; }
    sourcesModule.renderSources(sourcesPanelHost, sourcesContext(document));
    if (sourcesFocus) { const key = sourcesFocus; sourcesFocus = null; focusControl(sourcesPanelHost.querySelector(`[data-control-key="${cssEscape(key)}"]`)); }
  }
  function loadSources() {
    // On a slide only the Based on chips wait for this chunk: draw just them. A full render here rebuilt the slide under an
    // author who had just clicked into a block, so the caret and the text editor were lost (AS-153 polish round 17).
    return (sourcesLoad ??= import('./builder-sources.mjs').then(module => { sourcesModule = module; if (destroyed) return;
      if (['sources', 'details', 'overview'].includes(ui.view)) render(); else renderBasedOn(activeDocument()); },
      () => { sourcesLoad = null; if (ui.view === 'sources') sourcesPanelHost.replaceChildren(element(doc, 'p', 'Sources could not be loaded. The draft is unchanged.')); }));
  }
  function sourcesContext(document) {
    const metadata = activeMetadata(), names = new Map();
    // A trace's slide, named and numbered as the Outline numbers the spine; null for content no slide shows.
    const slideOf = entityId => {
      const home = traceHome(document, entityId); if (!home) return null;
      if (!names.has(home)) names.set(home, { key: home, name: recordName(document, home), order: slideOrder(document, home), open: () => navigateIssue(document, home) });
      return names.get(home);
    };
    return { doc, document, metadata, button, element, createId, slideOf, review: ui.sourcesReview === true, traceName: index => recordName(document, `/provenance/${index}`),
      hash: hashText, clean: (text, multiline) => cleanPasted(text, multiline),
      metadataNow: activeMetadata, forget: id => sourceDigest.forget(id), commit: (next, label) => commit(activeDocument(), next, { structural: true, label }),
      status: setStatus, closeReview: () => { ui.sourcesReview = false; render(); }, openAdvanced: () => { sourcesAdvanced.open = true; focusControl(sourcesAdvancedSummary); } };
  }
  /** Open the Sources view; `review` lists the slides whose cited content changed (Readiness "Review all"). */
  function openSources({ review = false, focus = null } = {}) { ui.sourcesReview = review; sourcesFocus = focus; showView('sources'); }
  // Each record's slide pointer, once per draft value (the chips and the Sources list ask for every trace).
  const traceHomes = new WeakMap();
  function traceHome(document, entityId) {
    let homes = traceHomes.get(document); if (!homes) traceHomes.set(document, homes = new Map());
    if (!homes.has(entityId)) { const record = recordPointer(document, entityId); homes.set(entityId, record ? slidePointer(document, record) : null); }
    return homes.get(entityId);
  }
  /** The record and field a slide's "Based on" link is written to: its stage title, consequence or clarification name. */
  function basedOnTarget() {
    const card = selectedClarification(), path = selectionPath(), beat = selectionBeat();
    return card ? { id: card.id, field: 'label' } : path ? { id: path.id, field: 'label' } : beat ? { id: beat.id, field: 'title' } : null;
  }
  // The chips are built by the Sources chunk, loaded with the first slide shown (CASE-321).
  function renderBasedOn(document) {
    const target = basedOnTarget();
    basedOn.hidden = !target; if (!target) { basedOn.replaceChildren(); return; }
    // Only once slides are drawn: the workflows view keeps a studio with the slide check alone and never shows these chips.
    if (!sourcesModule) { if (slides !== slideCheck) void loadSources(); return; }
    sourcesModule.renderBasedOn(basedOn, { doc, element, button, menuButton: shell.menuButton, document, metadata: activeMetadata(), metadataNow: activeMetadata, target, home: id => traceHome(document, id),
      commit: (next, label) => commit(activeDocument(), next, { structural: true, label }), status: setStatus, openSources: () => openSources({ focus: 'source:citation' }),
      removed: at => { sourceRangeDrafts.delete(at); shiftMapDown(sourceRangeDrafts, at); } });
  }

  function renderConflict() {
    const conflict = snapshot?.conflict;
    if (snapshot?.status !== 'conflict' || !conflict) return;
    const panel = element(doc, 'section', undefined, 'builder-conflict');
    panel.setAttribute('aria-labelledby', 'builderConflictTitle');
    const title = element(doc, 'h3', 'A newer saved draft exists.'); title.id = 'builderConflictTitle';
    panel.append(title, element(doc, 'p', `Your local revision and saved revision ${conflict.revision} are both kept.`));
    panel.append(button(doc, 'Use the saved draft', () => { destroyFormat(); ui.fieldKey = null; saveState.resolveConflict('saved'); history?.boundary('The saved draft replaced your local copy. Undo starts again from here.'); }), button(doc, 'Keep my local draft', () => { saveState.resolveConflict('local'); }));
    reviewHost.append(panel);
  }

  function updateScalar(key, value) {
    const field = activeFieldDescriptors.get(key);
    if (!field) return;
    if (field.valueKind === 'number') {
      if (value === '') value = undefined;
      else if (!Number.isFinite(Number(value))) { setStatus('Enter a finite number.'); return; }
      else value = Number(value);
    }
    try {
      if (field.metadata && field.metadataKind === 'source-text') void updateSourceText(field, value);
      else if (field.metadata) commit(activeDocument(), writePointer(activeMetadata(), field.pointer, value), { coalesce: `field:${key}` });
      else commit(writePointer(activeDocument(), field.pointer, value), staleFieldMetadata(activeMetadata(), field), { coalesce: `field:${key}` });
    }
    catch (error) { setStatus(error.message || 'This field could not be updated.'); }
  }

  async function updateSourceText(field, value) {
    const previous = activeMetadata().sources?.find(item => item.id === field.ownerId)?.text, metadata = writePointer(activeMetadata(), field.pointer, value);
    // A "Based on" link covers the whole source, so it follows the source's length (CASE-321); every trace into it is
    // still marked changed, as before.
    if (metadata.provenance) metadata.provenance = rerangeWholeSourceTraces(metadata.provenance, field.ownerId, previous, value).map(entry => entry.source_id === field.ownerId ? { ...entry, review_status: 'stale' } : entry);
    if (!commit(activeDocument(), metadata)) return;
    const sourceId = field.ownerId;
    const result = await sourceDigest.update(sourceId, value);
    if (result?.error) setStatus(result.error?.message || 'The source hash could not be updated; source text remains in the draft.');
    else if (result?.ok === false) setStatus('The source hash could not be updated; source text remains in the draft.');
  }

  function commit(nextDocument, nextMetadata = activeMetadata(), { structural = false, focusKey = null, label = 'Draft updated.', coalesce = null } = {}) {
    if (nextDocument.schema_version >= 2 && nextDocument.decisions?.some(item => item.interpretation === 'facilitator')) {
      nextDocument.required_capabilities = [...new Set([...(nextDocument.required_capabilities ?? []), 'human_interpretation'])];
    }
    // A removed stage or consequence takes its slide, and blocks only that slide used, with it (card 51).
    const reconciled = slides?.reconcile(nextDocument, nextMetadata);
    if (reconciled?.traces) { setStatus(`This change was not applied. ${reconciled.traces} private source traces point into the removed slide content; move each to the record that now holds its text, or remove it, first.`); return false; }
    if (reconciled) nextDocument = reconciled.document;
    // Older drafts may still carry the empty scene and points a new stage once kept beside its slide (D5).
    nextDocument = shell.withoutComposedShadows(nextDocument, activeDocument());
    // …and a stage's slide heading and learner title stay one heading while they match (r24 P2-3).
    nextDocument = slides?.followHeadings?.(nextDocument, activeDocument()) ?? nextDocument;
    nextDocument = withOrdinaryMappings(nextDocument, activeDocument());
    nextMetadata = invalidateChangedProvenance(activeDocument(), activeMetadata(), nextDocument, nextMetadata);
    // Typing (re-audit round 12, BWR13 at the caps): the edited block is checked now, so text over a limit is refused
    // at the key as before; the whole pair is validated once the keys pause. Any other change first settles a pending
    // check, and one that fails returns the draft to its last valid state with the reason.
    const typing = deferRender && !structural;
    if (!typing && !flushValidation()) return false;
    if (typing) {
      const problem = typedBlockProblem(nextDocument);
      if (problem) { setStatus(refusal(problem)); return false; }
      pendingValid ??= { document: activeDocument(), authoringMetadata: activeMetadata() };
      pendingValid.key = structural ? null : coalesce ?? focusKey ?? label; pendingValid.label = label.replace(/\.$/, '');
      doc.defaultView?.clearTimeout?.(validationTimer); validationTimer = doc.defaultView?.setTimeout?.(() => { validationTimer = null; flushValidation(); }, 120);
    } else {
      const result = validateDocument(nextDocument, nextMetadata, { mode: 'preserve' });
      if (!result?.ok) { setStatus(refusal(result?.errors?.[0]?.message)); return false; }
    }
    const before = { document: activeDocument(), authoringMetadata: activeMetadata() };
    saveState.setDraft(nextDocument, nextMetadata, { owned: true });
    // Typing coalesces by field; every other change is its own step.
    history?.record(before, { document: nextDocument, authoringMetadata: nextMetadata }, { label: label.replace(/\.$/, ''), coalesceKey: structural ? null : coalesce ?? focusKey ?? label,
      // Where the change was made: the selection shown before the command (a structural command moves the selection
      // first) and the one after it. Undo returns to the first, Redo to the second (re-audit #3).
      where: { before: renderedSelection ?? null, after: { ...currentSelection(), blockId: slideState.blockId ?? null } } });
    focusAfterRender = focusKey;
    setStatus(label);
    if (!deferRender) render();
    return true;
  }

  // One validation per draft value and mode: the pair held by the save state is never changed in place, so render,
  // Readiness and the typed check share a result instead of each walking a draft at the caps (round 12).
  const validations = new WeakMap();
  function checked(document, metadata, mode) {
    if (!document || typeof document !== 'object') return validateDocument(document, metadata, { mode });
    let byMode = validations.get(document); if (!byMode) validations.set(document, byMode = new Map());
    const hit = byMode.get(mode); if (hit && hit.metadata === metadata) return hit.result;
    const result = validateDocument(document, metadata, { mode }); byMode.set(mode, { metadata, result }); return result;
  }
  /** A refused edit in plain words (round 13): the schema's messages name limits and characters as an author would. */
  function refusal(message) {
    const text = String(message || '');
    const limit = /must be at most (\d+) characters/.exec(text)?.[1];
    if (limit) return `This text was not applied: it is over the ${Number(limit).toLocaleString('en-GB')}-character limit.`;
    const range = /length must be (\d+)[–-](\d+)/.exec(text);
    if (range) return `This text was not applied: it must be ${range[1] === '1' ? 'at most' : `${range[1]} to`} ${Number(range[2]).toLocaleString('en-GB')} characters${range[1] === '1' ? ', and not empty' : ''}.`;
    if (/unsafe control|bidi/.test(text)) return 'This text was not applied: it contains hidden characters (such as a tab). Remove them to continue.';
    return `This change was not applied. ${text ? text[0].toUpperCase() + text.slice(1) : 'Review the named field issue.'}`;
  }
  /** How many of the selected slide's blocks have no place on it (they wait in the tray), for the fit line. */
  function unplacedHere(document) {
    const composition = (document?.compositions ?? []).find(item => item.id === slideState.slideId);
    if (!composition) return 0;
    const placed = new Set((composition.placements ?? []).map(item => item.block_id));
    return (composition.reading_order ?? []).filter(id => !placed.has(id)).length;
  }
  /** The block being written, alone: its text limits and safe characters, without validating the whole pair. */
  function typedBlockProblem(document) {
    const block = slideState.blockId && document.blocks?.find(item => item.id === slideState.blockId);
    if (!block || block.type === 'question') return null;
    return slides?.blockProblem?.(block) ?? null;
  }
  /** Validate a typed draft now; if it fails, return to the last valid pair (as a history step) and say why. */
  function flushValidation() {
    doc.defaultView?.clearTimeout?.(validationTimer); validationTimer = null;
    if (!pendingValid || destroyed) { pendingValid = null; return true; }
    const good = pendingValid; pendingValid = null;
    const result = checked(activeDocument(), activeMetadata(), 'preserve');
    if (result?.ok) return true;
    const bad = { document: activeDocument(), authoringMetadata: activeMetadata() };
    saveState.setDraft(good.document, good.authoringMetadata);
    // The return folds into the typing step itself (same history key), so Undo never brings the refused text back.
    history?.record(bad, { document: good.document, authoringMetadata: good.authoringMetadata }, { label: good.label ?? 'Edit', coalesceKey: good.key ?? null, where: { before: renderedSelection ?? null, after: renderedSelection ?? null } });
    setStatus(refusal(result?.errors?.[0]?.message));
    forceSync = true; try { render(); } finally { forceSync = false; }
    return false;
  }

  // Display order only (re-audit #8): every id, mapping, rule, the recommendation and the fallback stay as they are, so
  // no source trace goes stale.
  function moveWithin(decisionId, pick, from, to, label) {
    const next = clone(activeDocument()), items = pick(next.decisions?.find(item => item.id === decisionId) ?? {});
    if (!Array.isArray(items) || to < 0 || to >= items.length || from === to) return false;
    items.splice(to, 0, ...items.splice(from, 1));
    return commit(next, activeMetadata(), { structural: true, label });
  }

  function updateById(collection, id, edit) {
    const index = findIndexById(activeDocument()[collection], id);
    if (index < 0) return false;
    const next = clone(activeDocument()); edit(next[collection][index]);
    const nextMetadata = clone(activeMetadata());
    for (const entry of nextMetadata.provenance ?? []) if (entry.entity_id === id) entry.review_status = 'stale';
    return commit(next, nextMetadata);
  }

  function updateDecision(decisionId, path, value) { return updateById('decisions', decisionId, decision => value === undefined ? deleteRelative(decision, path) : setRelative(decision, path, value)); }
  function updatePath(decisionId, pathId, path, value) {
    return updateById('decisions', decisionId, decision => {
      const target = decision.paths?.find(item => item.id === pathId); if (!target) return;
      if (value === undefined) deleteRelative(target, path); else setRelative(target, path, value);
    });
  }
  /** PREVIEW-02: a consequence that changes shape (terminal or continuing) is replaced whole, so the keys it drops go. */
  function replacePath(decisionId, pathId, make) {
    return updateById('decisions', decisionId, decision => {
      const index = decision.paths?.findIndex(item => item.id === pathId) ?? -1, replacement = index < 0 ? null : make(decision.paths[index]);
      if (replacement) decision.paths[index] = replacement;
    });
  }
  function updateRule(decisionId, index, path, value) { return updateById('decisions', decisionId, decision => { if (decision.rules?.[index]) setRelative(decision.rules[index], path, value); }); }
  function setRelative(target, path, value) {
    const parts = String(path).split('/').filter(Boolean); const last = parts.pop();
    const parent = parts.reduce((item, part) => item[part] ??= {}, target); parent[last] = value;
  }
  function deleteRelative(target, path) {
    const parts = String(path).split('/').filter(Boolean); const last = parts.pop();
    const parent = parts.reduce((item, part) => item?.[part], target); if (parent) delete parent[last];
  }

  function addContent(surfaceId, group) {
    if (!surfaceId) { setStatus('Add a teaching stage with learner content first.'); return; }
    const surface = activeDocument().surfaces?.find(item => item.id === surfaceId); if (!surface) return;
    const list = surface[group] ?? [];
    const value = group === 'observations' ? { label: '', value: '', unit: '' } : '';
    const next = clone(activeDocument()); next.surfaces.find(item => item.id === surfaceId)[group] = [...list, value];
    const rowKey = getRowKey(surfaceId, group, list.length);
    const focusKey = fieldKey(rowKey, group === 'observations' ? 'label' : 'value');
    commit(next, activeMetadata(), { structural: true, focusKey, label: `${groupLabel(group)} added. Write in the new row.` });
  }
  function addObjective() {
    const objectives = activeDocument().learning_objectives ?? [];
    const next = clone(activeDocument()); next.learning_objectives ??= []; next.learning_objectives.push('');
    commit(next, activeMetadata(), { structural: true, focusKey: fieldKey('case', `objective:${objectives.length}`), label: 'Learning objective added. Write its outcome.' });
  }
  function addPreparationRequirements() {
    if (activeMetadata().preparation_requirements !== undefined) { setStatus('Private preparation requirements are already available above.'); return; }
    const next = clone(activeMetadata()); next.preparation_requirements = '';
    commit(activeDocument(), next, { structural: true, focusKey: 'metadata:preparation_requirements', label: 'Private preparation requirements added.' });
  }
  function removeContent(surfaceId, group, index) {
    const current = activeDocument().surfaces?.find(item => item.id === surfaceId)?.[group];
    if (!Array.isArray(current) || !Number.isInteger(index) || index < 0 || index >= current.length) return;
    const next = clone(activeDocument()); next.surfaces.find(item => item.id === surfaceId)[group].splice(index, 1);
    const keys = rowKeys.get(`${surfaceId}:${group}`); keys?.splice(index, 1);
    commit(next, activeMetadata(), { structural: true, label: `${groupLabel(group)} removed. Use Undo last change to restore it.` });
  }
  function moveContent(surfaceId, group, from, to) {
    const current = activeDocument().surfaces?.find(item => item.id === surfaceId)?.[group];
    if (!Array.isArray(current) || from < 0 || to < 0 || from >= current.length || to >= current.length || from === to) return;
    if (group === 'observations' && new Set(current.map(row => row?.label)).size !== current.length) { setStatus('Observation labels are duplicated. Rename the duplicate before moving rows.'); return; }
    const next = clone(activeDocument()); const list = next.surfaces.find(item => item.id === surfaceId)[group]; list.splice(to, 0, list.splice(from, 1)[0]);
    const keys = rowKeys.get(`${surfaceId}:${group}`); if (keys) keys.splice(to, 0, keys.splice(from, 1)[0]);
    commit(next, activeMetadata(), { structural: true, label: `${groupLabel(group)} moved. Existing text and links are unchanged.` });
  }

  function addStage(selection) {
    const document = activeDocument();
    const next = clone(document);
    next.beats ??= []; next.surfaces ??= [];
    const surfaceId = createId(); const beatId = createId();
    const newSurface = { id: surfaceId, kind: 'text', title: '', scene: '', points: [] };
    const newBeat = { id: beatId, kind: 'surface', title: '', surface_id: surfaceId };
    if (!selection) {
      if (next.beats.length) { setStatus('Choose the connected stage or consequence where this stage should be inserted.'); return; }
      next.start_beat_id = beatId;
    } else {
      const previous = next.beats.find(item => item.id === selection.beatId);
      if (!previous) { setStatus('The selected stage no longer exists.'); return; }
      let owner;
      if (previous.kind === 'decision') {
        const paths = next.decisions?.find(item => item.id === previous.decision_id)?.paths;
        owner = paths?.find(path => path.id === selection.pathId) ?? (paths?.length === 1 && paths[0].continue_to_next ? paths[0] : null);
        if (!owner || owner.terminal) { setStatus('Choose a non-terminal consequence before adding its next stage.'); return; }
      } else owner = previous;
      if (Object.hasOwn(owner, 'next_beat_id')) newBeat.next_beat_id = owner.next_beat_id;
      owner.next_beat_id = beatId;
      const at = next.beats.findIndex(item => item.id === previous.id);
      next.beats.splice(at + 1, 0, newBeat);
    }
    if (!selection) next.beats.push(newBeat);
    next.surfaces.push(newSurface);
    const previousSelection = { beatId: ui.beatId, pathId: ui.pathId };
    ui.beatId = beatId; ui.pathId = null;
    // In a slide draft the new stage is a slide from the start, with one empty text block to write in.
    if (slides && next.schema_version === 3) { const slid = shell.withEmptySlide(next, beatId, createId); Object.assign(next, slid); }
    const composed = slides && next.schema_version === 3;
    if (!commit(next, activeMetadata(), { structural: true, focusKey: composed ? `${beatId}:title` : `${surfaceId}:scene`, label: composed ? 'Teaching stage added. Name it, then write on its slide.' : 'Teaching stage added. Its learner content is ready to write.' })) {
      ui.beatId = previousSelection.beatId; ui.pathId = previousSelection.pathId;
    }
  }

  function addDecision(selection, { branches = false, type = 'free_text' } = {}) {
    if (!selection) { setStatus('Choose the connected stage or consequence where this decision should continue.'); return; }
    const document = activeDocument(); const next = clone(document);
    const previous = next.beats.find(item => item.id === selection.beatId);
    if (!previous) { setStatus('The selected stage no longer exists.'); return; }
    // The stage, or its selected consequence, that leads into the new question.
    const ownerIn = draft => {
      if (previous.kind !== 'decision') return draft.beats.find(item => item.id === previous.id);
      const paths = draft.decisions?.find(item => item.id === previous.decision_id)?.paths;
      return paths?.find(path => path.id === selection.pathId) ?? (paths?.length === 1 && paths[0].continue_to_next ? paths[0] : null);
    };
    let owner = ownerIn(next);
    if (previous.kind === 'decision' && (!owner || owner.terminal)) { setStatus('Choose a non-terminal consequence before inserting a decision.'); return; }
    let oldDestination = owner.next_beat_id;
    const ordinary = slides && next.schema_version === 3 && !branches;
    if (ordinary && !oldDestination) {
      const id = createId(), sid = createId();
      next.surfaces.push({ id: sid, kind: 'text', title: '' });
      next.beats.push({ id, kind: 'debrief', title: '', surface_id: sid });
      // STRUCTURE-01: the slide comes from a copy of the draft, so the owner is found again in the copy it links from.
      Object.assign(next, shell.withEmptySlide(next, id, createId));
      owner = ownerIn(next);
      oldDestination = id;
    }
    const surfaceId = createId(); const beatId = createId(); const decisionId = createId();
    const interactionType = ordinary ? type : 'single_choice';
    const optionIds = interactionType === 'free_text' ? [] : [createId(), createId()]; const pathIds = ordinary ? [createId()] : [createId(), createId()];
    // D25: in a slide draft each consequence owns its slide, so it also gets its own learner content, whose heading the
    // facilitator's Reveal button names; elsewhere both still reveal the question's content.
    const ownReveal = slides && next.schema_version === 3 && !ordinary, revealIds = pathIds.map(() => ownReveal ? createId() : surfaceId);
    const paths = pathIds.map((id, index) => ({ id, label: ordinary ? 'Continue' : '', classification: 'discussion-prompt', recommended: index === 0,
      rationale: ordinary ? 'Discuss responses, then continue the story.' : '', ...(ordinary ? { cue: 'Continue after discussion.', continue_to_next: true } : {}),
      ...(interactionType === 'single_choice' ? { option_ids: ordinary ? optionIds : [optionIds[index]] } : {}), reveal_surface_id: revealIds[index], ...(oldDestination ? { next_beat_id: oldDestination } : {}) }));
    if (ordinary) next.required_capabilities = [...new Set([...next.required_capabilities, 'human_interpretation', 'direct_continuation'])];
    owner.next_beat_id = beatId;
    const questionSurface = { id: surfaceId, kind: 'text', title: '', scene: '', points: [] };
    const questionBeat = { id: beatId, kind: 'decision', title: '', surface_id: surfaceId, decision_id: decisionId };
    const decision = { id: decisionId, prompt: '', ...(next.schema_version >= 2 ? { interpretation: ordinary ? 'facilitator' : 'rules' } : {}), interaction: { type: interactionType,
      ...(interactionType === 'free_text' ? { max_length: FREE_TEXT_MAX } : { options: optionIds.map(id => ({ id, label: '' })) }) }, fallback_path_id: pathIds[0], paths };
    next.surfaces.push(questionSurface, ...(ownReveal ? revealIds.map(id => ({ id, kind: 'text', title: '' })) : [])); next.beats.splice(next.beats.findIndex(item => item.id === previous.id) + 1, 0, questionBeat); next.decisions.push(decision);
    // In a slide draft the decision stage and each consequence get their own slide; the stage's binds its question.
    if (slides && next.schema_version === 3) {
      Object.assign(next, ordinary ? withOrdinaryQuestionSlide(next, beatId, decisionId, createId) : shell.withEmptySlide(next, beatId, createId, { decisionId }));
      if (!ordinary) for (const id of pathIds) Object.assign(next, shell.withEmptySlide(next, { kind: 'path', id }, createId));
    }
    const previousSelection = { beatId: ui.beatId, pathId: ui.pathId, fieldKey: ui.fieldKey };
    ui.beatId = beatId; ui.pathId = ordinary ? null : pathIds[0]; ui.fieldKey = `${decisionId}:prompt`;
    // On a slide the selected consequence's slide takes the caret's place (r24 P2-1): its heading block is selected and
    // the caret waits in its text, not on its Edit button (r25 P3).
    const lead = next.compositions?.find(item => item.owner?.id === pathIds[0])?.reading_order?.[0];
    const wasBlock = slideState.blockId; if (lead) slideState.blockId = slideState.keepBlockId = lead;
    if (!commit(next, activeMetadata(), { structural: true, focusKey: lead ? `slide-text:${lead}` : `${decisionId}:prompt`, label: ordinary ? 'Question added. Collect responses, discuss, then Continue to the next slide.' : 'Decision inserted. Review its authored branches.' })) {
      ui.beatId = previousSelection.beatId; ui.pathId = previousSelection.pathId; ui.fieldKey = previousSelection.fieldKey; slideState.blockId = wasBlock; slideState.keepBlockId = null;
    }
  }

  function reviewDecisionInsertion(selection) {
    const document = activeDocument();
    const beat = document.beats?.find(item => item.id === selection.beatId);
    let owner = beat?.kind === 'decision'
      ? document.decisions?.find(item => item.id === beat.decision_id)?.paths?.find(path => path.id === selection.pathId)
      : beat;
    if (!owner && beat?.kind === 'decision') {
      const paths = document.decisions?.find(item => item.id === beat.decision_id)?.paths;
      if (paths?.length === 1 && paths[0].continue_to_next) owner = paths[0];
    }
    if (!owner || owner.terminal) { setStatus('Choose a connected non-terminal stage or consequence first.'); return; }
    if (slides && document.schema_version === 3) {
      const panel = element(doc, 'section', undefined, 'builder-confirm-change');
      panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Add question');
      panel.append(element(doc, 'h4', 'Add question'), element(doc, 'p', 'Collect responses and discuss, then Continue along the story.'));
      let type = 'free_text';
      panel.append(makeSelect('Response type', ['free_text', 'single_choice', 'multi_select', 'ranking'].map(value => [value, interactionLabel(value)]), type, value => { type = value; }));
      panel.append(button(doc, 'Add question', () => { panel.remove(); addDecision(selection, { type }); }));
      panel.append(button(doc, 'Add a branching decision', () => { panel.remove(); addDecision(selection, { branches: true }); }));
      panel.append(button(doc, 'Cancel', () => panel.remove())); reviewHost.append(panel); return;
    }
    const destination = owner.next_beat_id ? document.beats?.find(item => item.id === owner.next_beat_id) : null;
    const panel = element(doc, 'section', undefined, 'builder-confirm-change');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Review decision insertion');
    panel.append(element(doc, 'h4', 'Review decision insertion'));
    panel.append(element(doc, 'p', destination
      ? `Both new consequences will continue to “${destination.title || 'Untitled stage'}”. This preserves the current destination while inserting the question.`
      : 'The new consequences will have no destination yet. You will choose each destination explicitly.'));
    panel.append(element(doc, 'p', 'The scaffold adds two blank responses and two blank consequences paired in order. The first blank consequence is temporarily set as the required recommended path and no-response/tie fallback so the draft remains structurally usable; these are placeholders, not clinical recommendations. Review both choices after insertion.'));
    panel.append(button(doc, 'Insert decision with these routes', () => { panel.remove(); addDecision(selection); }));
    panel.append(button(doc, 'Cancel', () => panel.remove()));
    reviewHost.append(panel);
  }

  function sharedRevealOwner(beat) {
    const card = selectedClarification(), path = card ? null : selectionPath();
    if (!beat?.surface_id || !slides || activeDocument().schema_version !== 3) return null;
    if (card) return card.surface_id === beat.surface_id ? { kind: 'clarification', id: card.id } : null;
    return path?.reveal_surface_id === beat.surface_id ? { kind: 'path', id: path.id } : null;
  }

  function separateRevealContent(beat, owner) {
    const next = clone(activeDocument()), key = owner.kind === 'path' ? 'reveal_surface_id' : 'surface_id';
    const target = owner.kind === 'path' ? next.decisions?.flatMap(item => item.paths ?? []).find(item => item.id === owner.id) : next.clarifications?.find(item => item.id === owner.id);
    const shared = next.surfaces?.find(item => item.id === beat.surface_id);
    if (!target || !shared || target[key] !== shared.id) return;
    const composition = next.compositions?.find(item => item.owner?.kind === owner.kind && item.owner.id === owner.id);
    const heading = (composition?.reading_order ?? []).map(id => next.blocks?.find(block => block.id === id)).find(block => block?.type === 'text' && block.paragraphs?.[0]?.style?.startsWith('h'));
    const text = (heading?.paragraphs[0].runs ?? []).map(run => run.text ?? '').join('').trim().slice(0, 120);
    const id = createId();
    next.surfaces.push({ id, kind: 'text', title: text || shared.title || '', ...(shared.notes !== undefined ? { notes: clone(shared.notes) } : {}) });
    target[key] = id;
    if (text && owner.kind === 'clarification') target.label = text;
    commit(next, activeMetadata(), { structural: true, focusKey: `${id}:title`, label: `This ${owner.kind === 'path' ? 'consequence' : 'clarification'} now has its own heading and notes.` });
  }

  function addPath(decisionId) {
    const decision = activeDocument().decisions?.find(item => item.id === decisionId);
    if (!decision) return;
    const id = createId(); const beat = activeDocument().beats.find(item => item.decision_id === decisionId);
    const selected = selectionPath(), next = clone(activeDocument()), ownReveal = slides && next.schema_version === 3;
    let owner = next.decisions.find(item => item.id === decisionId);
    const ordinary = owner.paths?.length === 1 && owner.paths[0].continue_to_next === true;
    if (ordinary) {
      const first = owner.paths[0], sid = createId(); delete first.continue_to_next;
      first.reveal_surface_id = sid; next.surfaces.push({ id: sid, kind: 'text', title: '' });
      // As in addDecision (STRUCTURE-01): the slide comes from a copy of the draft, so the question is found again in it.
      if (ownReveal) { Object.assign(next, shell.withEmptySlide(next, { kind: 'path', id: first.id }, createId)); owner = next.decisions.find(item => item.id === decisionId); }
      if (!next.decisions.some(item => item.paths?.some(path => path.continue_to_next))) next.required_capabilities = next.required_capabilities.filter(value => value !== 'direct_continuation');
    }
    const revealSurfaceId = ownReveal ? createId() : selected?.reveal_surface_id ?? beat?.surface_id ?? '';
    if (ownReveal) next.surfaces.push({ id: revealSurfaceId, kind: 'text', title: '' }); // D25, as addDecision
    const destination = selected?.next_beat_id ?? (ordinary ? owner.paths[0].next_beat_id : null);
    owner.paths.push({ id, label: '', classification: 'discussion-prompt', recommended: false, rationale: '', reveal_surface_id: revealSurfaceId, ...(destination ? { next_beat_id: destination } : {}) });
    if (slides && next.schema_version === 3) Object.assign(next, shell.withEmptySlide(next, { kind: 'path', id }, createId));
    const beforePathId = ui.pathId; ui.pathId = id;
    if (!commit(next, activeMetadata(), { structural: true, focusKey: `${id}:label`, label: 'Consequence added. Name it and map its response if needed.' })) ui.pathId = beforePathId;
  }

  function addOption(decisionId) {
    const id = createId();
    const next = clone(activeDocument()); const owner = next.decisions.find(decision => decision.id === decisionId);
    if (!owner) return;
    owner.interaction.options ??= []; owner.interaction.options.push({ id, label: '' });
    commit(next, activeMetadata(), { structural: true, focusKey: `${id}:label`, label: 'Response option added without a route. Map it explicitly to a consequence.' });
    setStatus('Response option added without a route. Map it explicitly to a consequence.');
  }

  function addRule(decisionId) {
    const decision = activeDocument().decisions?.find(item => item.id === decisionId);
    if (!decision) return;
    const type = decision.interaction?.type;
    if (type === 'single_choice') { setStatus('Single-choice outcomes are paired directly with authored response mappings.'); return; }
    const key = type === 'free_text' ? 'keywords' : type === 'ranking' ? 'top' : 'includes_any';
    const index = decision.rules?.length ?? 0;
    const next = clone(activeDocument()); const owner = next.decisions.find(item => item.id === decisionId);
    owner.rules ??= []; owner.rules.push({ when: { [key]: [] }, path_id: owner.fallback_path_id });
    commit(next, activeMetadata(), { structural: true, focusKey: `${decisionId}:rule:${index}:reason`, label: 'Response rule added. Add its condition, destination and private rationale.' });
  }

  function toggleOptionMapping(decisionId, pathId, optionId, checked) {
    updateById('decisions', decisionId, decision => {
      const path = decision.paths?.find(item => item.id === pathId); if (!path) return;
      const options = new Set(path.option_ids ?? []);
      if (checked) { for (const item of decision.paths) item.option_ids = (item.option_ids ?? []).filter(id => id !== optionId); options.add(optionId); }
      else options.delete(optionId);
      path.option_ids = [...options];
    });
  }

  function setRecommendedPath(decisionId, pathId) { updateById('decisions', decisionId, decision => { for (const path of decision.paths ?? []) path.recommended = path.id === pathId; }); }
  function toggleRecovery(decisionId, pathId, enabled) {
    if (activeDocument().schema_version < 2) { setStatus('Convert this draft explicitly before adding required recovery.'); return; }
    const next = clone(activeDocument());
    const decision = next.decisions.find(item => item.id === decisionId); const path = decision?.paths?.find(item => item.id === pathId);
    if (!path) return;
    if (enabled) path.recovery = { prompt: '' }; else delete path.recovery;
    next.required_capabilities ??= [];
    if (enabled && !next.required_capabilities.includes('required_recovery')) next.required_capabilities.push('required_recovery');
    if (!enabled && !next.decisions.some(item => item.paths?.some(candidate => candidate.recovery)) ) next.required_capabilities = next.required_capabilities.filter(value => value !== 'required_recovery');
    commit(next);
  }

  function addFlag() {
    const next = clone(activeDocument()); next.flags ??= [];
    if (next.flags.length >= 64) { setStatus('The draft has reached its supported flag limit. Existing content is unchanged.'); return; }
    let suffix = 1; while (next.flags.some(flag => flag.key === `flag_${suffix}`)) suffix++;
    const id = createId(); next.flags.push({ id, key: `flag_${suffix}`, label: '' });
    commit(next, activeMetadata(), { structural: true, label: 'Narrative flag added. Name its purpose before using it.' });
  }
  function renameFlag(id, key) {
    const flag = activeDocument().flags?.find(item => item.id === id);
    if (!flag || !/^[a-z][a-z0-9_]{1,47}$/.test(key) || activeDocument().flags.some(item => item.id !== id && item.key === key)) { setStatus('Choose a unique flag key using lowercase letters, numbers or underscores.'); return; }
    const next = clone(activeDocument()); const target = next.flags.find(item => item.id === id); const old = target.key; target.key = key;
    for (const beat of next.beats ?? []) beat.requires_flags = (beat.requires_flags ?? []).map(item => item === old ? key : item);
    for (const surface of next.surfaces ?? []) for (const variant of surface.variants ?? []) variant.when_flags = (variant.when_flags ?? []).map(item => item === old ? key : item);
    for (const decision of next.decisions ?? []) for (const path of decision.paths ?? []) {
      path.set_flags = (path.set_flags ?? []).map(item => item === old ? key : item);
      path.clear_flags = (path.clear_flags ?? []).map(item => item === old ? key : item);
    }
    commit(next, activeMetadata(), { structural: true, label: `Flag renamed. ${old} references were updated together.` });
  }

  function addVariant(surfaceId) {
    const index = activeDocument().surfaces.find(item => item.id === surfaceId)?.variants?.length ?? 0;
    const next = clone(activeDocument()); const surface = next.surfaces.find(item => item.id === surfaceId);
    if (!surface) return;
    surface.variants ??= []; surface.variants.push({ when_flags: [], scene: '', points: [], investigations: [] });
    commit(next, activeMetadata(), { structural: true, focusKey: fieldKey(`${surfaceId}:variant:${index}`, 'scene'), label: `Content variant ${index + 1} added. Add its condition and variant text.` });
  }
  function updateSurfaceVariant(surfaceId, index, flags) { updateById('surfaces', surfaceId, surface => { surface.variants ??= []; surface.variants[index] ??= { when_flags: [], scene: '', points: [], investigations: [] }; surface.variants[index].when_flags = flags; }); }
  function updateMetadataAt(collection, index, edit, label) {
    const next = clone(activeMetadata());
    if (!Array.isArray(next[collection]) || !next[collection][index]) return false;
    edit(next[collection][index]);
    return commit(activeDocument(), next, label ? { label } : undefined);
  }
  function addSource() {
    const next = clone(activeMetadata()); next.sources ??= [];
    if (next.sources.length >= 32) { setStatus('The draft reached its source limit. Existing sources remain unchanged.'); return; }
    const id = createId(); next.sources.push({ id, title: '', text: '', sha256: EMPTY_SOURCE_SHA256, rights_status: 'unknown' });
    commit(activeDocument(), next, { structural: true, focusKey: fieldKey(id, 'title'), label: 'Private source added. Record its title and original text.' });
  }
  function renderSources(host, metadata) {
    const block = element(doc, 'section', undefined, 'builder-source-tools');
    block.append(element(doc, 'h3', 'Source text and rights'));
    block.append(element(doc, 'p', 'Each source’s name and full text are above. Its text and permission stay in the private draft; they are never sent to learner or public views.'));
    block.append(button(doc, 'Add source material', () => addSource()));
    for (const [index, source] of (metadata.sources ?? []).entries()) {
      const row = element(doc, 'article', undefined, 'builder-source-row');
      row.append(element(doc, 'h5', `Source ${index + 1}`));
      row.append(makeSelect(`Source ${index + 1} rights status`, [['unknown','Unresolved'],['permitted','Permission recorded'],['restricted','Restricted']], source.rights_status, value => updateMetadataAt('sources', index, item => { item.rights_status = value; })));
      const refs = (metadata.provenance ?? []).filter(entry => entry.source_id === source.id);
      const remove = dangerButton(doc, `Review removal of source ${index + 1}`, () => {
        const panel = element(doc, 'section', undefined, 'builder-confirm-change');
        panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Review source removal');
        panel.append(element(doc, 'p', refs.length ? `This source is linked from ${refs.length} provenance ${refs.length === 1 ? 'entry' : 'entries'}. Remove those links explicitly before deleting the source.` : 'Remove this unreferenced private source material?'));
        if (!refs.length) panel.append(dangerButton(doc, 'Delete unreferenced source', () => {
          sourceDigest.forget(source.id);
          const next = clone(activeMetadata()); next.sources.splice(index, 1);
          commit(activeDocument(), next, { structural: true, label: 'Unreferenced source removed. Use Undo last change to restore it.' }); panel.remove();
        }));
        panel.append(button(doc, 'Cancel', () => panel.remove())); row.append(panel);
      });
      row.append(remove); block.append(row);
    }
    host.append(block);
  }
  function renderProvenance(host, document, metadata) {
    const block = element(doc, 'section', undefined, 'builder-provenance-tools');
    block.append(element(doc, 'h4', 'Detailed source traces'));
    block.append(element(doc, 'p', 'A trace links one piece of slide text to lines of a source, or records it as the author’s own addition.'));
    block.append(button(doc, 'Add source trace', () => addProvenance()));
    // Plain words (CASE-321): each record is named by its slide, each field as an author reads it ("Observation 3 · Unit").
    const words = sourcesModule, slideName = id => { const home = traceHome(document, id); return home ? recordName(document, home) : null; };
    const entities = provenanceEntities(document, slides).map(item => ({ ...item, label: words?.entityLabel(item, slideName(item.id)) ?? item.label }));
    for (const [index, entry] of (metadata.provenance ?? []).entries()) {
      const row = element(doc, 'article', undefined, 'builder-provenance-row');
      row.append(element(doc, 'h5', `Source trace ${index + 1}`));
      row.append(makeSelect(`Trace ${index + 1} slide or record`, entities.map(item => [item.id, item.label]), entry.entity_id, id => updateMetadataAt('provenance', index, item => {
        const entity = entities.find(candidate => candidate.id === id);
        item.entity_id = id; item.field = provenanceFields(entity?.kind, entity, document, slides)[0] ?? 'title';
      })));
      const selectedEntity = entities.find(item => item.id === entry.entity_id);
      // A trace always shows the field it holds, even one the list would not offer for a new trace (D7).
      const fields = provenanceFields(selectedEntity?.kind, selectedEntity, document, slides);
      if (entry.field && !fields.includes(entry.field)) fields.unshift(entry.field);
      row.append(makeSelect(`Trace ${index + 1} text`, fields.map(field => [field, words?.plainField(field) ?? field]), entry.field, field => updateMetadataAt('provenance', index, item => { item.field = field; })));
      row.append(makeSelect(`Trace ${index + 1} source`, [['','Editorial addition — no source'], ...(metadata.sources ?? []).map(source => [source.id, source.title || 'Untitled source'])], entry.source_id ?? '', value => updateMetadataAt('provenance', index, item => { if (value) item.source_id = value; else delete item.source_id; if (!value) item.transformation = 'editorial'; })));
      row.append(makeSelect(`Trace ${index + 1} transformation`, [['verbatim','Verbatim'],['adapted','Adapted'],['editorial','Editorial addition']], entry.transformation, value => updateMetadataAt('provenance', index, item => { item.transformation = value; })));
      row.append(makeSelect(`Trace ${index + 1} visibility`, [['private','Private'],['public','Learner-facing']], entry.visibility, value => updateMetadataAt('provenance', index, item => { item.visibility = value; })));
      row.append(makeSelect(`Trace ${index + 1} review status`, [['unreviewed','Needs review'],['confirmed','Confirmed'],['stale','Needs re-review']], entry.review_status, value => updateMetadataAt('provenance', index, item => { item.review_status = value; })));
      const source = (metadata.sources ?? []).find(item => item.id === entry.source_id);
      const lineCount = typeof source?.text === 'string' ? (source.text.match(/\r\n|\n|\r/g) ?? []).length + 1 : 1;
      row.append(makeSourceRange(index, entry, lineCount));
      row.append(dangerButton(doc, `Remove source trace ${index + 1}`, () => {
        const next = clone(activeMetadata()); next.provenance.splice(index, 1);
        sourceRangeDrafts.delete(index); shiftMapDown(sourceRangeDrafts, index);
        commit(activeDocument(), next, { structural: true, label: 'Source trace removed. Use Undo last change to restore it.' });
      }));
      block.append(row);
    }
    host.append(block);
  }
  function makeSourceRange(index, entry, lineCount) {
    const fieldset = element(doc, 'fieldset', undefined, 'builder-source-range');
    fieldset.append(element(doc, 'legend', `Source lines for trace ${index + 1} (needed unless it is the author’s own addition)`));
    const draft = sourceRangeDrafts.get(index) ?? { start: entry.start_line ?? '', end: entry.end_line ?? '' };
    sourceRangeDrafts.set(index, draft);
    const start = element(doc, 'input'); start.type = 'number'; start.min = '1'; start.max = String(lineCount); start.step = '1'; start.value = String(draft.start); start.dataset.controlKey = `provenance:${index}:start`; start.setAttribute('aria-label', `Trace ${index + 1} source start line`);
    const end = element(doc, 'input'); end.type = 'number'; end.min = '1'; end.max = String(lineCount); end.step = '1'; end.value = String(draft.end); end.dataset.controlKey = `provenance:${index}:end`; end.setAttribute('aria-label', `Trace ${index + 1} source end line`);
    const applyRange = () => {
      draft.start = start.value; draft.end = end.value;
      if (!draft.start && !draft.end) {
        updateMetadataAt('provenance', index, item => { delete item.start_line; delete item.end_line; });
      } else if (!draft.start || !draft.end) setStatus('Enter both source range lines, or clear both; the saved range remains unchanged until then.');
      else {
        const from = Number(start.value), to = Number(end.value);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > lineCount) { setStatus(`Enter a source range from 1 to ${lineCount}, with the end at or after the start.`); return; }
        updateMetadataAt('provenance', index, item => { item.start_line = from; item.end_line = to; });
      }
    };
    start.addEventListener('change', applyRange); end.addEventListener('change', applyRange);
    fieldset.append(start, end); return fieldset;
  }
  function shiftMapDown(map, removed) {
    const next = new Map();
    for (const [key, value] of map) if (key !== removed) next.set(key > removed ? key - 1 : key, value);
    map.clear(); for (const [key, value] of next) map.set(key, value);
  }
  function addProvenance() {
    const entities = provenanceEntities(activeDocument());
    if (!entities.length) { setStatus('Add an authored Case record before tracing provenance.'); return; }
    const next = clone(activeMetadata()); next.provenance ??= [];
    if (next.provenance.length >= 2000) { setStatus('The draft reached its provenance limit. Existing entries remain unchanged.'); return; }
    const first = entities[0]; next.provenance.push({ entity_id: first.id, field: provenanceFields(first.kind, first, activeDocument())[0] ?? 'title', transformation: 'editorial', visibility: 'private', review_status: 'unreviewed' });
    commit(activeDocument(), next, { structural: true, label: 'Source trace added. Identify its source or confirm it as editorial.' });
  }
  function addClarification() {
    if (activeDocument().schema_version < 2) { setStatus('Convert this draft explicitly before adding early clarification.'); return; }
    const id = createId(); const selected = selectionBeat(); const surface = activeDocument().surfaces?.find(item => item.id === selected?.surface_id);
    if (!selected || !surface) { setStatus('Select a stage with learner content before adding an early clarification.'); return; }
    const next = clone(activeDocument()); next.clarifications ??= [];
    // D25: in a slide draft the clarification's slide is its own, so its heading and notes are too.
    const own = slides && next.schema_version === 3 ? createId() : null;
    if (own) next.surfaces.push({ id: own, kind: 'text', title: '' });
    next.clarifications.push({ id, label: '', surface_id: own ?? surface?.id ?? '', beat_ids: selectionBeat() ? [selectionBeat().id] : [] });
    next.required_capabilities ??= []; if (!next.required_capabilities.includes('early_clarification')) next.required_capabilities.push('early_clarification');
    // Shown while its stage's question is open, a clarification's slide starts with that question in place (D15), as a
    // decision stage's does; otherwise the room draws the question beside the slide, too narrow for its text.
    if (slides && next.schema_version === 3) Object.assign(next, shell.withEmptySlide(next, { kind: 'clarification', id }, createId, { decisionId: selected.kind === 'decision' ? selected.decision_id : null }));
    commit(next, activeMetadata(), { structural: true, focusKey: `${id}:label`, label: next.schema_version === 3 ? 'Clarification added. Name it, then write its slide: it is listed under its stage in the Outline.' : 'Clarification added. Choose its text and allowed stages.' });
  }

  async function beginScratch() {
    if (typeof createScratch !== 'function') { setStatus('Scratch creation is unavailable in this mount. Existing draft values are preserved.'); return; }
    try {
      const candidate = await createScratch({ createId });
      if (!candidate?.document || !candidate?.authoringMetadata) { setStatus('Scratch starter did not provide a complete draft. Existing work is unchanged.'); return; }
      requestDraftReplacement(candidate, { kind: 'scratch' });
    } catch (error) { setStatus(error?.message || 'Could not start a scratch draft. Existing work is unchanged.'); }
  }

  function requestRemove(kind, id, report) {
    const list = kind === 'flag' ? activeDocument().flags
      : kind === 'option' ? activeDocument().decisions.flatMap(item => item.interaction?.options ?? [])
        : kind === 'path' ? activeDocument().decisions.flatMap(item => item.paths ?? []) : [];
    const item = list.find(value => value.id === id);
    if (!item) return;
    // A consequence takes its reveal content when nothing else shows it (D22), and says so.
    const takes = kind === 'path' ? orphanedSurfaces(activeDocument(), withoutItem(kind, id, { keepContent: true }) ?? activeDocument()) : [];
    const message = report.references.length
      ? `Cannot remove “${item.label || 'Untitled item'}” yet. ${report.references.map(reference => reference.label).join(' ')}`
      : `Remove “${item.label || 'Untitled item'}”${takes.length ? ` and its reveal content “${takes.map(surface => surface.title || 'Untitled content').join('”, “')}”, which nothing else shows` : ''}?`;
    const panel = element(doc, 'section', undefined, 'builder-confirm-change');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', `${kind} removal review`);
    panel.append(element(doc, 'h5', report.references.length ? 'Review linked changes' : 'Confirm removal'), element(doc, 'p', message));
    const ownerDecision = kind === 'path' ? activeDocument().decisions.find(decision => decision.paths?.some(path => path.id === id)) : null;
    const tooFewPaths = kind === 'path' && (ownerDecision?.paths?.length ?? 0) <= 1;
    const rankWouldBreak = kind === 'option' && activeDocument().decisions.some(decision => decision.interaction?.options?.some(option => option.id === id)
      && decision.interaction?.type === 'ranking' && Number.isInteger(decision.interaction.rank_count)
      && decision.interaction.rank_count > (decision.interaction.options.length - 1));
    const traceRefs = kind === 'path' && !tooFewPaths ? removalTraces(withoutItem(kind, id) ?? activeDocument()) : [];
    if (traceRefs.length) {
      panel.append(element(doc, 'p', TRACES_BLOCK));
      const blockers = element(doc, 'ul', undefined, 'builder-removal-blockers');
      for (const index of traceRefs) blockers.append(traceBlocker(index, panel));
      panel.append(blockers);
    } else if (report.safeToRemove && !tooFewPaths && !rankWouldBreak) panel.append(dangerButton(doc, 'Confirm removal', () => removeUnlinked(kind, id)));
    else if (tooFewPaths || rankWouldBreak) panel.append(element(doc, 'p', tooFewPaths
      ? 'This decision needs at least one consequence. Add and review another before removing this one.'
      : 'The configured number of ranked responses depends on this option. Change that setting before removing it.'));
    else panel.append(button(doc, 'Keep this item and inspect links', () => { panel.remove(); showView('overview'); }));
    panel.append(button(doc, 'Cancel', () => panel.remove()));
    reviewHost.append(panel);
  }
  /**
   * Reviewed removal of an early clarification (D15): its slide and the blocks only that slide shows go with it (see
   * commit), and its content too when nothing else uses it. Refused while private source traces point into any of it.
   */
  function reviewClarificationRemoval(card) {
    if (!card) return;
    const used = id => [...activeDocument().beats ?? [], ...(activeDocument().clarifications ?? []).filter(item => item.id !== card.id)].some(item => item.surface_id === id)
      || (activeDocument().decisions ?? []).some(decision => decision.paths?.some(path => path.reveal_surface_id === id));
    const without = () => {
      const next = clone(activeDocument()); next.clarifications = next.clarifications.filter(item => item.id !== card.id);
      if (!used(card.surface_id)) next.surfaces = next.surfaces.filter(item => item.id !== card.surface_id);
      return next;
    };
    const owned = new Set([card.id, used(card.surface_id) ? null : card.surface_id]);
    const traces = [...new Set([...(activeMetadata().provenance ?? []).flatMap((item, index) => owned.has(item?.entity_id) ? [index] : []), ...slideTraceBlockers(without())])].sort((a, b) => a - b);
    const panel = element(doc, 'section', undefined, 'builder-confirm-change'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Review clarification removal'); panel.tabIndex = -1;
    panel.append(element(doc, 'h4', 'Review clarification removal'), element(doc, 'p', `Would remove: clarification “${card.label || 'Untitled clarification'}” and its slide${used(card.surface_id) ? '' : ', and its learner content, which nothing else uses'}.`));
    if (traces.length) {
      const list = element(doc, 'ul', undefined, 'builder-removal-blockers'); for (const index of traces) list.append(traceBlocker(index, panel));
      panel.append(element(doc, 'p', TRACES_BLOCK), list);
    } else panel.append(dangerButton(doc, 'Remove clarification and its slide', () => {
      panel.remove(); const was = currentSelection(); ui.pathId = null;
      if (!commit(without(), activeMetadata(), { structural: true, label: 'Clarification and its slide removed. Use Undo last change to restore them.' })) { ui.beatId = was.beatId; ui.clarificationId = was.clarificationId; }
    }));
    panel.append(button(doc, 'Cancel', () => { panel.remove(); notChanged(); }));
    reviewHost.replaceChildren(panel); panel.focus();
  }
  /** The draft without one unlinked flag, response or consequence, or null when it cannot go. */
  function withoutItem(kind, id, { keepContent = false } = {}) {
    const collection = kind === 'flag' ? 'flags' : null;
    const next = clone(activeDocument());
    if (collection) next[collection] = next[collection].filter(item => item.id !== id);
    else if (kind === 'option') {
      const owner = next.decisions.find(decision => decision.interaction?.options?.some(option => option.id === id));
      if (!owner) return null;
      owner.interaction.options = owner.interaction.options.filter(option => option.id !== id);
    } else if (kind === 'path') {
      const owner = next.decisions.find(decision => decision.paths?.some(path => path.id === id));
      if (!owner || owner.fallback_path_id === id || owner.paths.length <= 1) return null;
      owner.paths = owner.paths.filter(path => path.id !== id);
      if (owner.interpretation === 'facilitator' && owner.fallback_path_id === undefined) owner.fallback_path_id = owner.paths[0]?.id;
    }
    return keepContent ? next : dropOrphaned(next);
  }
  /** `next` without the content this change leaves unshown (D22), in the same reviewed, undoable change. */
  function dropOrphaned(next) {
    const gone = new Set(orphanedSurfaces(activeDocument(), next).map(surface => surface.id));
    if (gone.size) next.surfaces = next.surfaces.filter(surface => !gone.has(surface.id));
    return next;
  }
  /** Source traces a removal would leave pointing at nothing: into its slides' blocks (D7) or at content it takes (D22). */
  function removalTraces(next) {
    const kept = new Set((next.surfaces ?? []).map(surface => surface.id));
    const gone = new Set((activeDocument().surfaces ?? []).map(surface => surface.id).filter(id => !kept.has(id)));
    const onContent = (activeMetadata().provenance ?? []).flatMap((entry, index) => gone.has(entry?.entity_id) ? [index] : []);
    return [...new Set([...slideTraceBlockers(next), ...onContent])].sort((a, b) => a - b);
  }
  function removeUnlinked(kind, id) {
    const next = withoutItem(kind, id);
    if (!next) { if (kind === 'path') setStatus('This consequence is required by current decision structure.'); return; }
    const label = kind === 'flag' ? 'Unlinked flag removed.' : kind === 'option' ? 'Unlinked response removed.' : 'Unlinked consequence removed.';
    const wasPath = ui.pathId;
    if (kind === 'path' && ui.pathId === id) ui.pathId = null;
    if (!commit(next, activeMetadata(), { structural: true, label: `${label} Use Undo last change to restore it.` })) ui.pathId = wasPath;
  }
  /** Private source traces pointing into the slide content a removal would take (D7), by index. */
  function slideTraceBlockers(next) { return slides?.reconcile?.(next, activeMetadata())?.traced ?? []; }
  /** One blocking trace, named by the slide and field it supports, with a way to it in the trace editor (D7). */
  function traceBlocker(index, panel) {
    const item = element(doc, 'li', `Source trace ${index + 1} · ${recordName(activeDocument(), `/provenance/${index}`)}`);
    item.append(doc.createTextNode(' '), button(doc, `Show source trace ${index + 1}`, () => showTrace(index, panel), 'builder-btn builder-issue-link'));
    return item;
  }
  function showTrace(index, panel) {
    panel?.remove();
    ui.sourcesAdvanced = true; showView('sources');
    const focus = () => focusControl(root.querySelector?.(`[data-control-key="${cssEscape(`select:Trace ${index + 1} slide or record`)}"]`));
    if (!focus()) void sourcesLoad?.then(() => { if (!focus()) setStatus(`Source trace ${index + 1} is under Sources, Advanced.`); });
  }

  /** Undo or Redo one draft change from the unified history; a refused step leaves the draft as it is. */
  function step(direction) {
    if (!history) return false;
    const result = history[direction]({ document: activeDocument(), authoringMetadata: activeMetadata() });
    if (!result.ok) { if (result.refused) setStatus(result.refused); return false; }
    // One history for every field (BWR16): a mounted formatted editor remounts from the restored draft and keeps focus.
    const inFormat = formatHost.contains(doc.activeElement);
    saveState.setDraft(result.pair.document, result.pair.authoringMetadata);
    destroyFormat();
    setStatus(`${direction === 'undo' ? 'Undone' : 'Redone'}: ${result.label}.`);
    // Show what changed (gap audit #11): go to the selection the change was made in, where it still exists.
    const restored = result.pair.document, exists = place => place?.beatId && restored.beats?.some(beat => beat.id === place.beatId);
    const order = direction === 'undo' ? [result.where?.before, result.where?.after] : [result.where?.after, result.where?.before];
    const where = order.find(exists) ?? null, moved = where && (where.beatId !== ui.beatId || (where.pathId ?? null) !== (ui.pathId ?? null) || (where.clarificationId ?? null) !== (ui.clarificationId ?? null));
    if (where) {
      ui.beatId = where.beatId; ui.view = 'path';
      ui.pathId = where.pathId && restored.decisions?.some(decision => decision.paths?.some(path => path.id === where.pathId)) ? where.pathId : null;
      // A clarification's slide is restored too; settleSelection drops it if the step removed it (D15).
      ui.clarificationId = where.clarificationId ?? null;
      slideState.blockId = slideState.keepBlockId = where.blockId && restored.blocks?.some(block => block.id === where.blockId) ? where.blockId : null;
    } else if (!restored.beats?.some(beat => beat.id === ui.beatId)) {
      // The selected stage no longer exists after this step: show the case's first stage, never a blank sheet.
      ui.beatId = restored.start_beat_id ?? restored.beats?.[0]?.id ?? null; ui.pathId = null; slideState.blockId = null; ui.view = 'path';
    }
    // Focused fields show the restored value too (a history step is the one time a focused field is overwritten).
    forceSync = true; try { render(); } finally { forceSync = false; }
    if (inFormat && !moved) formatMount?.focus?.();
    const flash = slideState.blockId && root.querySelector?.(`.builder-slide .slide-block[data-block-id="${CSS.escape(slideState.blockId)}"]`);
    if (flash) { flash.setAttribute('data-flash', ''); doc.defaultView?.setTimeout?.(() => flash.removeAttribute('data-flash'), 700); }
    return true;
  }
  // A pending typed check that fails has already returned the draft to its last valid state; that is the step.
  function undo() { return flushValidation() ? step('undo') : false; }
  function redo() { return flushValidation() ? step('redo') : false; }

  let saving = null;
  async function save() {
    if (saving) await saving;
    if (destroyed || !isCurrent()) return;
    if (!flushValidation()) return;
    if (sourceDigest.blocksSave()) { setStatus('Wait for every source digest to update before saving.'); return; }
    if (!snapshot?.dirty || saveButton.disabled) return;
    try { saving = saveState.save(); await saving; }
    catch (error) { if (error?.code === 'invalid_candidate') setStatus(refusal(error.issues?.[0]?.message).replace(/^This (change|text) was not applied/, 'Draft not saved')); else setStatus(error?.message || 'Draft could not be saved.'); }
    finally { saving = null; }
  }
  async function reconcile() {
    try { await saveState.reconcile(); }
    catch (error) { setStatus(error?.message || 'Saved state could not be refreshed. Local writing remains unchanged.'); }
  }
  // Saved checkpoints (D1/D2): one panel with its own name field, supplied by the route (builder-checkpoints.mjs).
  const checkpoints = checkpointServices && checkpointPanel?.({ doc, services: checkpointServices, reviewHost, setStatus, saveState, validateDocument, createId,
    onRestored: value => { destroyFormat(); ui.fieldKey = null; saveState.load(value); repairLoadedDraft(); history?.boundary('Checkpoint restored. Undo starts again from here.'); setStatus(`Checkpoint restored as revision ${value.revision}.`); render(); } });
  function showCheckpoints() { if (checkpoints) void checkpoints.show(); else setStatus('Checkpoints are unavailable in this mount.'); }
  /** The /edit/preview route (CASE-226): a launcher — the Preview inline below the slide, beside the editor. */
  function openPreview() {
    showInline('The Preview is shown below the slide. Open it in a window to see it beside the editor.', 'The Preview is shown here. Open it in its own window to see it beside the editor.');
  }
  function closePreview() { closeInline(); }
  async function createFromTemplate(template) {
    if (typeof template.create !== 'function') { setStatus('This template is unavailable. Existing draft values are preserved.'); return; }
    const candidate = await template.create({ createId });
    if (!candidate?.document || !candidate?.authoringMetadata) { setStatus('This template did not provide a valid draft. Existing work is unchanged.'); return; }
    const result = validateDocument(candidate.document, candidate.authoringMetadata, { mode: 'preserve' });
    if (!result?.ok) { setStatus('This template cannot be opened safely. Existing work is unchanged.'); return; }
    requestDraftReplacement(candidate, { kind: 'template', templateId: template.id, templateName: template.label });
  }

  function requestDraftReplacement(candidate, provenance) {
    const result = validateDocument(candidate.document, candidate.authoringMetadata, { mode: 'preserve' });
    if (!result?.ok) { setStatus('This starter cannot be opened safely. Existing work is unchanged.'); return; }
    const panel = element(doc, 'section', undefined, 'builder-confirm-change');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Review new draft');
    panel.append(element(doc, 'h4', provenance.kind === 'template' ? 'Start from this template?' : 'Start a scratch draft?'));
    panel.append(element(doc, 'p', snapshot?.dirty
      ? 'Starting this draft will replace the current unsaved working copy in this editor. Save it or cancel if you want to keep it here.'
      : `This will replace the current editor with the ${provenance.kind === 'template' ? 'selected starter' : 'blank starter'}.`));
    const open = button(doc, 'Create this new case', async () => {
      open.disabled = true;
      panel.querySelectorAll?.('button').forEach(item => { item.disabled = true; });
      setStatus('Creating a new case… Current draft remains open until creation succeeds.');
      try {
        const result = await onCreate({ ...provenance, candidate: clone(candidate) });
        if (result?.created !== true) throw new Error('The new case was not confirmed. Current writing remains open.');
        panel.remove();
      } catch (error) {
        open.disabled = false;
        panel.querySelectorAll?.('button').forEach(item => { item.disabled = false; });
        setStatus(error?.message || 'Could not create the new case. Current writing remains open.');
      }
    });
    panel.append(open);
    panel.append(button(doc, 'Cancel', () => { panel.remove(); templateButton.value = ''; }));
    reviewHost.append(panel);
  }

  /** CASE-316: the draft leaves every list once its title is typed exactly; nothing is deleted. */
  function requestArchive() {
    reviewHost.querySelector?.('.builder-archive')?.remove();
    // The server's rule (as the drafts list): spaces trimmed, at most 200 characters; an untitled draft confirms with ''.
    const title = [...String(snapshot?.document?.title ?? '').replace(/^ +| +$/g, '')].slice(0, 200).join('');
    const panel = element(doc, 'section', undefined, 'builder-confirm-change builder-archive');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Archive draft');
    panel.append(element(doc, 'h4', 'Archive this draft?'),
      element(doc, 'p', 'It leaves your drafts and every list. Nothing is deleted: the draft, its checkpoints and saved revisions are kept.'));
    const field = element(doc, 'input'); field.type = 'text'; field.setAttribute('aria-label', `Type ${title} to confirm`);
    const said = element(doc, 'p'); said.setAttribute('role', 'alert');
    const go = button(doc, 'Archive draft', async () => {
      go.disabled = true;
      try { await archiveDraft(field.value); panel.remove(); onDirty(false); onArchived(); }
      catch (error) {
        said.textContent = { case_published: 'This case has a published version, so it stays.', review_open: 'This draft is in review. Cancel the submission first.',
          title_mismatch: 'The title does not match the saved draft. Save, then try again.', forbidden: 'This draft is no longer available; it may already be archived.' }[error?.code] ?? 'The draft was not archived. Try again.';
        go.disabled = Boolean(title) && field.value !== title;
      }
    }, 'builder-btn builder-danger');
    go.disabled = Boolean(title);
    field.addEventListener('input', () => { go.disabled = field.value !== title; });
    panel.append(title ? element(doc, 'p', `Type ${title} to confirm.`) : element(doc, 'p', 'This draft has no title.'), ...(title ? [field] : []), said, go, button(doc, 'Cancel', () => panel.remove()));
    reviewHost.append(panel);
    (title ? field : go).focus?.();
  }

  /** Focus a control in view; a Case dropdown hides its native select, so its visible trigger takes focus instead. */
  function focusControl(node) {
    for (let parent = node?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    const target = node?.matches?.('select') && node.hidden && node.nextElementSibling?.matches?.('.shared-select-trigger') ? node.nextElementSibling : node;
    target?.scrollIntoView?.({ block: 'nearest' }); target?.focus?.({ preventScroll: true });
    return doc.activeElement === target;
  }
  /** The selection that owns a composition: its stage, its consequence's stage and path, or a clarification (shown during its first stage). */
  function ownerSelection(document, owner) {
    if (owner?.kind === 'beat') return { beatId: owner.id, pathId: null };
    if (owner?.kind === 'path') {
      const decision = (document.decisions ?? []).find(item => (item.paths ?? []).some(path => path.id === owner.id));
      return { beatId: document.beats?.find(item => item.decision_id === decision?.id)?.id ?? null, pathId: owner.id };
    }
    if (owner?.kind === 'clarification') return { beatId: (document.clarifications ?? []).find(item => item.id === owner.id)?.beat_ids?.[0] ?? null, pathId: null, clarificationId: owner.id };
    return { beatId: null, pathId: null };
  }

  /**
   * Issue navigation (BWR12): select the named record, reveal the context that holds it (opening a collapsed one) and
   * focus its editor, keeping the current writing. Slide issues select their slide and, where named, the block.
   */
  function navigateIssue(document, pointer) {
    const parts = String(pointer || '').split('/').filter(Boolean).map(decodePointer);
    if (parts[0] === 'authoring_metadata') parts.shift();
    if (parts[0] === 'provenance') { showTrace(Number(parts[1])); return; }
    // A case-wide field or a source opens Case details on that field (round 28 P1-2), never the slide's heading.
    // A source's permission opens its row in Sources; its name or text, the detailed editor there (CASE-321).
    if (parts[0] === 'sources') {
      const index = Number(parts[1]), source = activeMetadata().sources?.[index];
      if (parts[2] === 'rights_status' && source) { openSources({ focus: `source:${source.id}:permitted` }); return; }
      ui.sourcesAdvanced = true; showView('sources');
      if (source && sourceFields.focusField(fieldKey(source.id, parts[2] === 'text' ? 'text' : 'title'))) return;
      sheetHeading.focus(); return;
    }
    if (CASE_FIELDS.has(parts[0])) {
      ui.view = 'details'; render();
      const index = Number(parts[1]), objective = parts[0] === 'learning_objectives', source = parts[0] === 'sources' && activeMetadata().sources?.[index];
      const key = objective && Number.isInteger(index) ? fieldKey('case', `objective:${index}`) : parts[0] === 'preparation_requirements' ? 'metadata:preparation_requirements'
        : source ? fieldKey(source.id, parts[2] === 'text' ? 'text' : 'title') : fieldKey('case', parts[0]);
      const control = source && parts[2] === 'rights_status' ? root.querySelector?.(`[data-control-key="${cssEscape(`select:Source ${index + 1} rights status`)}"]`)
        : objective && !Number.isInteger(index) ? [...root.querySelectorAll?.('button') ?? []].find(node => node.textContent === 'Add learning objective' && node.offsetParent) : null;
      if ((control && focusControl(control)) || globalFields.focusField(key)) return;
      sheetHeading.focus(); return;
    }
    // A source trace opens the slide or stage it supports (re-audit round 11); its review lives beneath that slide.
    if (parts[0] === 'provenance') {
      const owner = recordPointer(document, activeMetadata()?.provenance?.[Number(parts[1])]?.entity_id);
      if (owner) return navigateIssue(document, owner);
    }
    let beatId = null; let pathId = null; let blockId = null; let clarificationId = null;
    const at = index => Number.isInteger(Number(parts[index])) ? Number(parts[index]) : -1;
    if (parts[0] === 'beats' && at(1) >= 0) beatId = document.beats?.[at(1)]?.id;
    // D15: a clarification's own problems open its slide, never its stage's.
    else if (parts[0] === 'clarifications' && at(1) >= 0) {
      const card = document.clarifications?.[at(1)], slide = (document.compositions ?? []).find(item => item.owner?.kind === 'clarification' && item.owner.id === card?.id);
      ({ beatId, pathId, clarificationId } = slide ? ownerSelection(document, slide.owner) : { beatId: card?.beat_ids?.[0] ?? null, pathId: null, clarificationId: null });
    }
    else if (parts[0] === 'decisions' && at(1) >= 0) {
      const decision = document.decisions?.[at(1)];
      beatId = document.beats?.find(item => item.decision_id === decision?.id)?.id;
      if (parts[2] === 'paths' && at(3) >= 0) pathId = decision?.paths?.[at(3)]?.id;
      // On a slide the question is a block: its prompt opens that block, not the hidden heading (r24 P2-1).
      else if (parts[2] === 'prompt') blockId = (document.blocks ?? []).find(block => block.type === 'question' && block.decision_id === decision?.id)?.id ?? null;
    } else if (parts[0] === 'surfaces' && at(1) >= 0) {
      const surface = document.surfaces?.[at(1)];
      beatId = document.beats?.find(item => item.surface_id === surface?.id)?.id;
      // Content only a clarification uses opens that clarification's slide.
      const card = !beatId && (document.clarifications ?? []).find(item => item.surface_id === surface?.id);
      const slide = card && (document.compositions ?? []).find(item => item.owner?.kind === 'clarification' && item.owner.id === card.id);
      if (slide) ({ beatId, pathId, clarificationId } = ownerSelection(document, slide.owner));
    } else if (parts[0] === 'compositions' && at(1) >= 0) {
      const composition = document.compositions?.[at(1)];
      ({ beatId, pathId, clarificationId = null } = ownerSelection(document, composition?.owner));
      // A placement, step or style row names its block; a reading-order entry is the block id itself.
      const row = parts[2] && at(3) >= 0 ? composition?.[parts[2]]?.[at(3)] : null;
      blockId = typeof row === 'string' ? row : row?.block_id ?? null;
    } else if (parts[0] === 'blocks' && at(1) >= 0) {
      blockId = document.blocks?.[at(1)]?.id ?? null;
      // Prefer the selected slide when it uses the block; otherwise the first slide that does.
      const uses = (document.compositions ?? []).filter(item => item.reading_order?.includes(blockId));
      const here = uses.find(item => { const owner = ownerSelection(document, item.owner); return owner.beatId === ui.beatId && (owner.pathId ?? null) === (ui.pathId ?? null) && (owner.clarificationId ?? null) === (ui.clarificationId ?? null); });
      ({ beatId, pathId, clarificationId = null } = ownerSelection(document, (here ?? uses[0])?.owner));
    }
    if (beatId) { ui.beatId = beatId; ui.pathId = pathId ?? null; ui.clarificationId = clarificationId ?? null; }
    ui.view = 'path';
    slideState.blockId = slideState.keepBlockId = blockId && document.blocks?.some(item => item.id === blockId) ? blockId : null;
    // The context that holds the field opens first, so its editor can take focus.
    const field = parts.at(-1), parent = parts.at(-2);
    // Private writing opens Facilitator notes; a decision's structure (options, rules, destinations, checkpoints) opens
    // Response and consequences; a stage's or surface's name and kind open Stage settings (re-audit #4).
    const isPrivate = ['rationale', 'cue', 'notes', 'debrief_prompt'].includes(field) || (parent === 'recovery' && field === 'prompt');
    const zoneKey = isPrivate ? 'private' : parts[0] === 'decisions' ? 'response' : ['beats', 'surfaces'].includes(parts[0]) && ['title', 'kind'].includes(field) ? 'settings' : null;
    if (zoneKey) { zones[zoneKey] = true; ({ private: privateZone, response: responseZone, settings: settingsZone })[zoneKey].details.open = true; }
    render();
    // A trend chart's problem focuses its field in the Block tab (round 28 P2-5).
    const trend = parts[0] === 'blocks' && document.blocks?.[at(1)]?.type === 'trend' ? slides?.trendTarget?.(document.blocks[at(1)], `/${parts.slice(2).join('/')}`) : null;
    const control = trend?.key && root.querySelector?.(`[data-control-key="${cssEscape(trend.key)}"]`);
    if (control && focusControl(control)) return;
    if (slideState.blockId) { const node = root.querySelector?.(`.builder-slide [data-block-id="${CSS.escape(slideState.blockId)}"]`); (node?.querySelector('.builder-slide-edit, textarea, [contenteditable="true"]') ?? node)?.focus?.(); return; }
    const exact = [...activeFieldDescriptors.values()].find(item => item.pointer === pointer);
    if (exact?.type === 'formatted') {
      ui.fieldKey = exact.key; render(); formatMount?.focus?.(); return;
    }
    if (exact && (fields.focusField(exact.key) || privateFields.focusField(exact.key) || settingsFields.focusField(exact.key) || headFields.focusField(exact.key))) return;
    const inline = [...(root.querySelectorAll?.('[data-document-pointer]') ?? [])].find(node => node.dataset.documentPointer === pointer);
    if (inline) { focusControl(inline.matches?.('fieldset') ? inline.querySelector?.('input') : inline); return; }
    sheetHeading.focus();
  }

  function getRowKey(surfaceId, group, index) {
    const name = `${surfaceId}:${group}`; let keys = rowKeys.get(name);
    if (!keys) { keys = []; rowKeys.set(name, keys); }
    while (keys.length <= index) keys.push(createId());
    return keys[index];
  }
  function makeInlineInput(key, label, value, onChange, pointer = null) {
    const wrap = element(doc, 'label', undefined, 'builder-inline-field');
    wrap.append(doc.createTextNode(label));
    const input = element(doc, 'input'); input.type = 'text'; input.value = String(value ?? ''); input.setAttribute('aria-label', label);
    input.addEventListener('input', () => {
      const wasDeferred = deferRender;
      deferRender = true;
      try { onChange(input.value); }
      finally { deferRender = wasDeferred; }
      syncStatus(); afterTyping();
    });
    input.dataset.controlKey = key;
    if (pointer) input.dataset.documentPointer = pointer;
    wrap.append(input);
    return wrap;
  }
  function makeNumberInput(key, label, value, min, max, onChange, allowEmpty = false) {
    const wrap = element(doc, 'label', undefined, 'builder-inline-field');
    wrap.append(doc.createTextNode(label));
    const input = element(doc, 'input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1';
    input.value = value === '' || value === null || value === undefined ? '' : String(value);
    input.setAttribute('aria-label', label); input.dataset.controlKey = key;
    input.addEventListener('change', () => {
      if (!input.value && allowEmpty) { onChange(undefined); syncStatus(); return; }
      const number = input.valueAsNumber;
      if (!Number.isInteger(number) || number < min || number > max) { setStatus(`Enter a whole number from ${min} to ${max}.`); return; }
      onChange(number);
    });
    wrap.append(input); return wrap;
  }
  function makeSelect(label, options, value, onChange, pointer = null) {
    const wrap = element(doc, 'label', undefined, 'builder-select-field'); wrap.append(doc.createTextNode(label));
    const select = element(doc, 'select'); select.setAttribute('aria-label', label); select.dataset.controlKey = `select:${label}`;
    if (pointer) select.dataset.documentPointer = pointer;
    for (const [optionValue, text] of options) { const option = element(doc, 'option', text); option.value = optionValue; option.selected = optionValue === value; select.append(option); }
    select.value = value ?? '';
    select.addEventListener('change', () => onChange(select.value)); wrap.append(select); return wrap;
  }
  function makeMultiSelect(label, options, selected, onChange, pointer = null) {
    const fieldset = element(doc, 'fieldset', undefined, 'builder-multi-select'); fieldset.append(element(doc, 'legend', label));
    if (pointer) fieldset.dataset.documentPointer = pointer;
    const values = new Set(selected ?? []);
    for (const [key, name] of options) {
      const row = element(doc, 'label', undefined, 'builder-check-row'); const input = element(doc, 'input'); input.type = 'checkbox'; input.checked = values.has(key);
      input.dataset.controlKey = `check:${label}:${key}`;
      input.addEventListener('change', () => { if (input.checked) values.add(key); else values.delete(key); onChange([...values]); });
      row.append(input, doc.createTextNode(name)); fieldset.append(row);
    }
    return fieldset;
  }

  /** PREVIEW-02: a draft saved with a terminal the old controls made is repaired as it loads, and autosaved. */
  function repairLoadedDraft() {
    const repaired = normaliseDraftTerminals(activeDocument());
    if (repaired.changed) saveState.setDraft(repaired.document, clone(activeMetadata()), { owned: true });
  }
  function destroyFormat() { formatMount?.destroy?.(); formatMount = null; formatKey = null; }
  function destroy() {
    if (destroyed) return;
    autosave.close();
    metadataFields.destroy(); sourceFields.destroy();
    checkDialog.remove(); transferDialog.remove(); transferHandle?.close();
    destroyed = true; pendingValid = null; for (const [, api] of enhanced) api.dispose(); enhanced.clear(); doc.defaultView?.clearTimeout?.(typedTimer); doc.defaultView?.clearTimeout?.(validationTimer); doc.removeEventListener('keydown', onKeys); caseProbe?.destroy(); caseFit.clear(); doc.defaultView?.clearTimeout?.(caseFitTimer); inline?.close(); inline = null; doc.defaultView?.clearTimeout?.(fitTimer); fitProbe?.destroy(); unbindHistory(); history?.destroy(); top.remove(); bar?.classList.remove('builder-app-bar'); panels.destroy(); sourceDigest.destroy(); destroyFormat(); fields.destroy(); globalFields.destroy(); inspect?.close(); root.remove(); rowKeys.clear(); activeFieldDescriptors.clear(); sourceRangeDrafts.clear();
  }

  render();
  repairLoadedDraft();
  // Only a studio that mounted joins the site bar; a failed mount leaves the bar as it was.
  if (bar) bar.insertBefore(top, bar.querySelector('.menu-button')), bar.classList.add('builder-app-bar');
  return Object.freeze({ destroy, getSnapshot: () => saveState.snapshot(), getSelection: () => ({ ...ui, undo: historyState.canUndo }), save, undo, redo, historyBoundary: reason => history?.boundary(reason), openPreview, closePreview, saveState, setSlides: next => { slides = next; slidesFailed = false; outline.refresh?.(); render(); }, slidesUnavailable: () => { slidesFailed = true; renderIssues(activeDocument()); }, refresh: () => render(), notice: message => setStatus(message),
    // The route's address chooses the Overview or the editor (CASE-321); leaving the Overview returns to the slide.
    openView: view => { if (view === 'overview') ui.view = 'overview'; else if (ui.view === 'overview') ui.view = 'path'; render(); } });
}

function isFormatted(value) { return record(value) && Array.isArray(value.blocks); }
function saveStatus(snapshot) {
  if (snapshot?.status === 'saved') return `Saved revision ${snapshot.baseRevision}.`;
  if (snapshot?.status === 'saving') return 'Saving this draft…';
  if (snapshot?.status === 'uncertain') return 'Save status is uncertain. Reconcile this exact save before saving again.';
  if (snapshot?.status === 'conflict') return `A newer saved draft needs review. Saved revision ${snapshot.conflict?.revision ?? 'unknown'}. Both copies are kept.`;
  if (snapshot?.status === 'conflict_read_failed') return 'A newer saved revision exists but could not be loaded. Refresh it before retrying.';
  if (snapshot?.status === 'dirty') return 'Unsaved changes.';
  return 'Draft status is unavailable.';
}
function groupLabel(group) { return group === 'points' ? 'Finding' : group === 'investigations' ? 'Investigation result' : 'Observation'; }
function interactionLabel(type) { return ({ single_choice: 'Single choice', multi_select: 'Select all that apply', ranking: 'Rank in order', free_text: 'Free text' })[type] ?? 'Choose response type'; }
function ruleKeys(type) { return type === 'multi_select' ? ['includes_all', 'includes_any', 'excludes'] : type === 'ranking' ? ['top', 'before'] : type === 'free_text' ? ['keywords'] : []; }
function decodePointer(value) { return String(value).replaceAll('~1', '/').replaceAll('~0', '~'); }
function childPath(root, node) {
  const path = [];
  for (let current = node; current && current !== root; current = current.parentNode) {
    const siblings = current.parentNode?.childNodes;
    if (!siblings) return null;
    path.push([...siblings].indexOf(current));
  }
  return node === root ? [] : path.reverse();
}
function followChildPath(root, path) {
  if (!Array.isArray(path)) return null;
  return path.reduce((node, index) => node?.childNodes?.[index] ?? null, root);
}
function provenanceEntities(document, slides = null) {
  const entities = [];
  for (const beat of document?.beats ?? []) entities.push({ id: beat.id, kind: 'stage', label: `Stage · ${beat.title || 'Untitled stage'}` });
  for (const surface of document?.surfaces ?? []) entities.push({ id: surface.id, kind: 'surface', label: `Learner content · ${surface.title || 'Untitled content'}` });
  for (const decision of document?.decisions ?? []) {
    entities.push({ id: decision.id, kind: 'decision', label: `Question · ${decision.prompt || 'Untitled question'}` });
    for (const path of decision.paths ?? []) entities.push({ id: path.id, kind: 'consequence', label: `Consequence · ${path.label || 'Untitled consequence'}` });
    for (const option of decision.interaction?.options ?? []) entities.push({ id: option.id, kind: 'response', label: `Response · ${option.label || 'Untitled response'}` });
  }
  for (const clarification of document?.clarifications ?? []) entities.push({ id: clarification.id, kind: 'clarification', label: `Clarification · ${clarification.label || 'Untitled clarification'}` });
  for (const flag of document?.flags ?? []) entities.push({ id: flag.id, kind: 'flag', label: `Narrative flag · ${flag.label || flag.key}` });
  // Slide blocks and their rows, entries and columns (D7): a trace on slide content names its target too.
  return [...entities, ...(slides?.traceTargets?.(document) ?? [])];
}
function staleFieldMetadata(metadata, field) {
  if (!field?.ownerId || !field?.provenanceField) return metadata;
  const stale = entry => entry.entity_id === field.ownerId && entry.field === field.provenanceField;
  return { ...metadata, ...(metadata.provenance && { provenance: metadata.provenance.map(entry => stale(entry) ? { ...entry, review_status: 'stale' } : entry) }) };
}
function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replaceAll('"', '\\"'); }
function deepEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && deepEqual(left[key], right[key]));
}

const PROVENANCE_BINDING_FIELDS = ['entity_id', 'field', 'source_id', 'start_line', 'end_line', 'transformation'];
function provenanceBindingKey(entry) { return JSON.stringify(PROVENANCE_BINDING_FIELDS.map(key => entry?.[key] ?? null)); }
// Each record by id, first found in the order the scan it replaces searched (round 28: once per draft, not per trace).
const owners = new WeakMap();
function provenanceOwner(document, id) {
  if (!document || typeof document !== 'object') return undefined;
  let index = owners.get(document);
  if (!index) {
    owners.set(document, index = new Map());
    const add = item => { if (item && !index.has(item.id)) index.set(item.id, item); };
    for (const collection of ['beats', 'surfaces', 'decisions', 'clarifications', 'flags']) {
      const list = Array.isArray(document[collection]) ? document[collection] : [];
      list.forEach(add);
      if (collection === 'decisions') for (const decision of list) { (decision?.paths ?? []).forEach(add); (decision?.interaction?.options ?? []).forEach(add); }
    }
  }
  return index.get(id);
}
function provenanceValue(document, entry) {
  let value = provenanceOwner(document, entry?.entity_id);
  if (!value || typeof entry?.field !== 'string') return undefined;
  const parts = [...entry.field.matchAll(/(?:^|\.)([^.[\]]+)|\[(\d+)\]/g)].map(match => match[1] ?? Number(match[2]));
  for (const part of parts) value = value?.[part];
  return value;
}
function provenanceSource(metadata, entry) {
  const source = metadata?.sources?.find(item => item?.id === entry?.source_id);
  return source ? { title: source.title, text: source.text, rights_status: source.rights_status } : undefined;
}

/** Mark traces stale when any bound authored/source value or binding changes, regardless of edit path. */
/** Pasted text without hidden characters (CASE-236): tabs become spaces; other controls and bidi marks are removed. */
export function cleanPasted(text, multiline = true) {
  const clean = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  return multiline ? clean : clean.replace(/\n+/g, ' ');
}

export function invalidateChangedProvenance(previousDocument, previousMetadata, nextDocument, nextMetadata) {
  // A new record and trace list; a trace that goes stale is replaced, never changed in place (round 28).
  const result = { ...nextMetadata }, after = Array.isArray(result.provenance) ? result.provenance = [...result.provenance] : [];
  const before = previousMetadata?.provenance ?? [];
  const oldByBinding = new Map();
  for (const entry of before) {
    const key = provenanceBindingKey(entry);
    if (!oldByBinding.has(key)) oldByBinding.set(key, []);
    oldByBinding.get(key).push(entry);
  }
  for (let index = 0; index < after.length; index++) {
    const entry = after[index];
    const exact = oldByBinding.get(provenanceBindingKey(entry));
    const old = exact?.shift() ?? before[index];
    if (!old) continue;
    const bindingChanged = PROVENANCE_BINDING_FIELDS.some(key => !deepEqual(old[key] ?? null, entry[key] ?? null));
    const authoredValueChanged = !deepEqual(provenanceValue(previousDocument, old), provenanceValue(nextDocument, entry));
    const sourceChanged = !deepEqual(provenanceSource(previousMetadata, old), provenanceSource(result, entry));
    if (bindingChanged || authoredValueChanged || sourceChanged) after[index] = { ...entry, review_status: 'stale' };
  }
  return result;
}

/** Ordered pair for ranking's `before` rule: A must be ranked above B. */
export function rankingBeforePair(higherOptionId, lowerOptionId) {
  return higherOptionId && lowerOptionId && higherOptionId !== lowerOptionId ? [higherOptionId, lowerOptionId] : null;
}

/**
 * The consequence made terminal, resetting to `checkpointBeatId`, or made to continue from its checkpoint. Either way
 * the result is one the validator accepts in shape (PREVIEW-02): only a terminal-unsafe consequence is terminal, its
 * reset restores the snapshot, and a terminal has no next stage. A checkpoint that is the question's own stage
 * (`decisionBeatId`) would loop back to the question, so continuing from it leaves the next stage for the author.
 */
export function configurePathTerminal(path, checkpointBeatId = null, { decisionBeatId = null } = {}) {
  const next = clone(path);
  if (next.terminal) {
    const checkpoint = next.terminal.checkpoint_beat_id;
    delete next.terminal; delete next.next_beat_id;
    if (typeof checkpoint === 'string' && checkpoint && checkpoint !== decisionBeatId) next.next_beat_id = checkpoint;
    if (next.classification === 'terminal-unsafe') next.classification = 'unsafe';
  } else {
    if (typeof checkpointBeatId !== 'string' || !checkpointBeatId) return null;
    next.terminal = { checkpoint_beat_id: checkpointBeatId, debrief_prompt: '', restore_policy: 'snapshot' };
    next.classification = 'terminal-unsafe';
    delete next.next_beat_id;
  }
  return next;
}

export function provenanceFields(kind, entity, document, slides = null) {
  if (kind === 'block') return slides?.traceFields?.(entity, document) ?? [];
  if (kind !== 'surface') return ({
    stage: ['title', 'cue'], decision: ['prompt'], clarification: ['label'], consequence: ['label', 'rationale', 'cue', 'recovery.prompt', 'terminal.debrief_prompt'],
    response: ['label'], flag: ['label'],
  })[kind] ?? ['title'];
  const surface = document?.surfaces?.find(item => item?.id === entity?.id);
  const fields = ['title', 'scene', 'notes'];
  for (const [index] of (surface?.points ?? []).entries()) fields.push(`points[${index}]`);
  for (const [index] of (surface?.investigations ?? []).entries()) fields.push(`investigations[${index}]`);
  for (const [index] of (surface?.observations ?? []).entries()) for (const leaf of ['label', 'value', 'unit'])
    if (surface.observations[index]?.[leaf] !== undefined) fields.push(`observations[${index}].${leaf}`);
  for (const [variantIndex, variant] of (surface?.variants ?? []).entries()) {
    if (variant.scene !== undefined) fields.push(`variants[${variantIndex}].scene`);
    if (variant.notes !== undefined) fields.push(`variants[${variantIndex}].notes`);
    for (const [index] of (variant.points ?? []).entries()) fields.push(`variants[${variantIndex}].points[${index}]`);
    for (const [index] of (variant.investigations ?? []).entries()) fields.push(`variants[${variantIndex}].investigations[${index}]`);
  }
  return fields;
}
