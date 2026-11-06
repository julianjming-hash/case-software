// Import and export (CASE-344 B3, {CASE-344}, AS-221). Export is one download. Import previews what will change, then offers
// two actions: Replace this draft, or Import as a new case. A file from a newer Case is refused by name; an older one imports.
// Memory-only: every transfer operation and every draft change is injected by the owning Builder integration.
const utf8 = new TextEncoder();
export const BUILDER_TRANSFER_UI_MAX_BYTES = 2 * 1024 * 1024;
const FILENAME = 'case-builder-transfer.json';

const el = (doc, tag, text = '') => {
  const node = doc.createElement(tag);
  if (text) node.textContent = text;
  return node;
};
const button = (doc, label, action) => {
  const node = el(doc, 'button', label);
  node.type = 'button'; node.className = 'btn';
  node.addEventListener('click', action);
  return node;
};
const plainJson = value => {
  try { return JSON.stringify(value); } catch { return ''; }
};
const bounded = (text, maxBytes) => typeof text === 'string' && utf8.encode(text).byteLength <= maxBytes;
const safeState = state => state && typeof state === 'object' && Number.isInteger(state.revision) &&
  (typeof state.intentDigest === 'string' || state.intentDigest === null) && typeof state.generation === 'number' &&
  state.document && typeof state.document === 'object' && state.authoringMetadata && typeof state.authoringMetadata === 'object';
const bindingOf = state => ({
  generation: state.generation, revision: state.revision, intentDigest: state.intentDigest,
  dirty: Boolean(state.dirty), documentJson: plainJson(state.document), metadataJson: plainJson(state.authoringMetadata),
});
const sameBinding = (a, b) => safeState(b) && a.generation === b.generation && a.revision === b.revision &&
  a.intentDigest === b.intentDigest && a.dirty === Boolean(b.dirty) && a.documentJson === plainJson(b.document) &&
  a.metadataJson === plainJson(b.authoringMetadata);
const clear = node => { while (node.firstChild) node.removeChild(node.firstChild); };
const checkbox = (doc, label, checked = false) => {
  const wrap = el(doc, 'label');
  const input = el(doc, 'input');
  input.type = 'checkbox'; input.checked = checked;
  wrap.append(input, doc.createTextNode(label));
  return { wrap, input };
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The preview rows: what a person compares before replacing one draft with another. */
const ROWS = [['title', 'Title', value => value || 'Untitled'], ['stages', 'Stages', String], ['questions', 'Questions', String], ['slides', 'Slides', String], ['blocks', 'Blocks', String]];

export function mountBuilderTransferControls(container, {
  getCurrentState,
  transfer,
  applyCandidate,
  createCopy,
  download = null,
  isCurrent = () => true,
  maxBytes = BUILDER_TRANSFER_UI_MAX_BYTES,
  onStatus = () => {},
} = {}) {
  const doc = container?.ownerDocument;
  if (!doc || typeof getCurrentState !== 'function' || !transfer || typeof transfer.createExport !== 'function' ||
      typeof transfer.parse !== 'function' || typeof transfer.inspect !== 'function' || typeof transfer.createCopyCandidate !== 'function' ||
      typeof applyCandidate !== 'function' || typeof createCopy !== 'function') throw new TypeError('Builder transfer controls need the document, transfer operations, and explicit apply/copy callbacks');
  maxBytes = Math.min(Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : BUILDER_TRANSFER_UI_MAX_BYTES, BUILDER_TRANSFER_UI_MAX_BYTES);

  const root = el(doc, 'section'); root.setAttribute('aria-label', 'Transfer Builder draft');
  const status = el(doc, 'p'); status.setAttribute('role', 'status');

  // ── Export: one download ──
  const exportSection = el(doc, 'section');
  exportSection.append(el(doc, 'h3', 'Export'),
    el(doc, 'p', 'One file holds this case, including your private notes and cues. Source texts are left out unless you choose them below.'));
  const downloadButton = button(doc, 'Download this case', () => void downloadCase());
  exportSection.append(downloadButton);
  // What else goes in the file is a choice made before the one download, never a second step after it.
  const moreFold = el(doc, 'details'); moreFold.append(el(doc, 'summary', 'Choose what the file includes'));
  const privateChoice = checkbox(doc, 'Include private authored fields', true);
  const sourcesChoice = checkbox(doc, 'Include selected source text', false);
  const provenanceChoice = checkbox(doc, 'Include provenance for selected sources', false);
  const preparationChoice = checkbox(doc, 'Include private preparation requirements', false);
  const lineageChoice = checkbox(doc, 'Include source lineage', false);
  const exportRights = checkbox(doc, 'I acknowledge source records marked unknown have unresolved rights', false);
  const sourceList = el(doc, 'div'); sourceList.setAttribute('role', 'group'); sourceList.setAttribute('aria-label', 'Source records to include');
  moreFold.append(privateChoice.wrap, sourcesChoice.wrap, provenanceChoice.wrap, preparationChoice.wrap, lineageChoice.wrap, exportRights.wrap, sourceList);
  exportSection.append(moreFold);

  // ── Import: choose a file, see what will change, then act ──
  const importSection = el(doc, 'section');
  importSection.append(el(doc, 'h3', 'Import'), el(doc, 'p', 'Choose a file made by Case. Nothing changes until you pick what to do with it.'));
  const file = el(doc, 'input'); file.type = 'file'; file.accept = '.json,application/json';
  file.setAttribute('aria-label', 'Choose a transfer JSON file'); importSection.append(file);
  const pasteFold = el(doc, 'details'); pasteFold.append(el(doc, 'summary', 'Paste the file’s text instead'));
  const pasted = el(doc, 'textarea'); pasted.setAttribute('aria-label', 'Transfer JSON'); pasted.maxLength = maxBytes;
  const previewButton = button(doc, 'Preview import', () => void preview());
  pasteFold.append(pasted, previewButton); importSection.append(pasteFold);
  const previewBox = el(doc, 'div'); previewBox.setAttribute('role', 'group'); previewBox.setAttribute('aria-label', 'Import preview'); previewBox.setAttribute('aria-live', 'polite');
  const summaryTable = el(doc, 'table'); summaryTable.setAttribute('aria-label', 'What will change');
  const issues = el(doc, 'div');
  const rightsBox = el(doc, 'div'), rightsLabel = el(doc, 'label'), rightsAck = el(doc, 'input'); rightsAck.type = 'checkbox';
  rightsLabel.append(rightsAck, doc.createTextNode('I reviewed unresolved source-rights warnings')); rightsBox.append(rightsLabel); rightsBox.hidden = true;
  const note = el(doc, 'p');
  const readiness = el(doc, 'p'); readiness.setAttribute('role', 'group'); readiness.setAttribute('aria-label', 'Rehearsal readiness');
  previewBox.append(summaryTable, issues, readiness, rightsBox, note); previewBox.hidden = true;
  importSection.append(previewBox);
  const replaceButton = button(doc, 'Replace this draft', () => void replaceDraft()); replaceButton.disabled = true;
  const newCaseButton = button(doc, 'Import as a new case', () => void importAsNewCase()); newCaseButton.disabled = true;
  const clearButton = button(doc, 'Clear', () => clearPrivateState());
  importSection.append(replaceButton, newCaseButton, clearButton);

  root.append(status, exportSection, importSection);
  container.append(root);

  let alive = true, generation = 0, exportGeneration = 0, inspected = null, copyCandidate = null, copyBinding = null;
  const say = message => { if (!alive) return; status.textContent = message; onStatus(message); };
  const current = () => {
    const state = getCurrentState();
    return safeState(state) ? state : null;
  };
  const resetPreview = () => {
    inspected = null; copyCandidate = null; copyBinding = null;
    replaceButton.disabled = true; newCaseButton.disabled = true;
    clear(summaryTable); clear(issues); note.textContent = ''; readiness.textContent = ''; rightsBox.hidden = true; previewBox.hidden = true;
  };

  // ── Export ──
  const sourceChoices = () => [...sourceList.querySelectorAll('input[type="checkbox"]')].filter(input => input.checked).map(input => input.value);
  function syncSourceChoices() {
    clear(sourceList);
    const sources = current()?.authoringMetadata?.sources;
    if (!Array.isArray(sources) || !sources.length) { sourceList.append(el(doc, 'p', 'No source records are available in this saved draft.')); return; }
    sourceList.append(el(doc, 'p', 'Source text is excluded by default. Select each record to include it.'));
    for (const source of sources) {
      const choice = checkbox(doc, `${source.title} — rights: ${source.rights_status}`, false);
      choice.input.value = source.id; sourceList.append(choice.wrap);
    }
  }
  syncSourceChoices();

  async function downloadCase() {
    const op = ++exportGeneration;
    const state = current();
    if (!state) return say('The current draft is unavailable.');
    if (typeof download !== 'function') return say('Downloads are not available here.');
    const selected = sourceChoices();
    if (sourcesChoice.input.checked && !selected.length) return say('Select at least one source record before including source text.');
    if (sourcesChoice.input.checked && selected.some(id => state.authoringMetadata.sources?.find(source => source.id === id)?.rights_status === 'unknown') && !exportRights.input.checked)
      return say('Acknowledge unresolved rights before including source text.');
    const binding = bindingOf(state);
    say('Preparing the file…');
    let result;
    try {
      result = await transfer.createExport({
        document: state.document, metadata: state.authoringMetadata, intent: 'copy', base: null,
        includePrivate: privateChoice.input.checked,
        includeSources: sourcesChoice.input.checked, sourceIds: selected,
        includeProvenance: provenanceChoice.input.checked,
        includePreparationRequirements: preparationChoice.input.checked,
        includeLineage: lineageChoice.input.checked,
        acknowledgeUnknownRights: exportRights.input.checked,
      });
    } catch { result = { ok: false, errors: [{ message: 'The file could not be prepared.' }] }; }
    if (!alive || op !== exportGeneration || !isCurrent() || !sameBinding(binding, current())) return say('The draft changed while the file was prepared. Nothing was downloaded; try again.');
    if (!result?.ok) return say(issueText(result?.errors) || 'The file could not be prepared.');
    const payload = plainJson(result.envelope);
    if (!bounded(payload, maxBytes)) return say('The file is larger than the local transfer limit, so nothing was downloaded.');
    try { await download({ filename: FILENAME, content: payload, contentType: 'application/json' }); say('Downloaded. The file holds this case as it is now.'); }
    catch { say('The download failed; the draft is unchanged.'); }
  }

  // ── Import ──
  async function readText() {
    if (file.files?.[0]) {
      const chosen = file.files[0];
      if (Number.isFinite(chosen.size) && chosen.size > maxBytes) throw new Error('Transfer file exceeds the local size limit.');
      const value = await chosen.text();
      if (!bounded(value, maxBytes)) throw new Error('Transfer file exceeds the local size limit.');
      return value;
    }
    if (!bounded(pasted.value, maxBytes)) throw new Error('Pasted transfer exceeds the local size limit.');
    return pasted.value;
  }

  async function preview() {
    const op = ++generation; exportGeneration++;
    resetPreview();
    const state = current();
    if (!state) return say('The current draft is unavailable.');
    const binding = bindingOf(state);
    say('Reading the file…');
    let raw;
    try { raw = await readText(); }
    catch (error) { return say(error.message || 'The file could not be read.'); }
    if (!alive || op !== generation || !isCurrent() || !sameBinding(binding, current())) return say('The draft changed while the file was read. Choose the file again.');
    let parsed;
    try { parsed = transfer.parse(raw); } catch { parsed = { ok: false, errors: [{ message: 'The file is not a Case transfer.' }] }; }
    if (!parsed?.ok) return say(issueText(parsed?.errors) || 'The file is not a Case transfer, or this Case cannot read it.');
    const intent = parsed.envelope.intent;
    // A file written for one saved revision applies only to that revision, so it needs a saved draft to compare with.
    if (intent === 'revise' && state.dirty) return say('This file applies to a saved draft. Save this draft first.');
    if (intent === 'revise' && (!state.revision || !state.intentDigest)) return say('This file applies to a saved draft, and this draft has no saved revision yet.');
    say('Checking what it would change…');
    let result;
    try {
      result = await transfer.inspect(parsed.envelope, {
        current: { document: state.document, authoringMetadata: state.authoringMetadata, revision: state.revision, intentDigest: state.intentDigest },
        intent, mode: 'preserve', acknowledgeRedactions: true, acknowledgeRightsWarnings: rightsAck.checked,
      });
    } catch { result = { ok: false, errors: [{ message: 'The file could not be checked safely.' }] }; }
    if (!alive || op !== generation || !isCurrent() || !sameBinding(binding, current())) return say('The draft changed while the file was checked. Both are unchanged; choose the file again.');
    if (!result?.candidate || !result.ok) {
      previewBox.hidden = false; showIssues(issues, result?.errors, doc);
      return say(issueText(result?.errors) || 'This file cannot be preserved safely, so nothing can be imported from it.');
    }
    inspected = { result, binding, intent };
    renderPreview(state, result, intent);
    const canPreserve = result.canAcceptPreservedCandidate ?? result.readyToAccept;
    const rightsNeedAck = result.acknowledgementCodes?.some(code => code === 'rights_unresolved' || code === 'rights_restricted');
    rightsBox.hidden = !rightsNeedAck;
    const ready = Boolean(canPreserve) && (!rightsNeedAck || rightsAck.checked);
    replaceButton.disabled = !ready;
    newCaseButton.disabled = !ready || intent !== 'copy';
    say(!canPreserve ? 'This file cannot be imported as it is; the preview lists why.' : rightsNeedAck && !rightsAck.checked ? 'Review the source-rights warnings, then choose what to do with the file.'
      : intent === 'copy' ? 'Review what will change, then replace this draft or import the file as a new case.' : 'Review what will change, then replace this draft.');
  }

  function renderPreview(state, result, intent) {
    previewBox.hidden = false;
    const summarise = typeof transfer.summarise === 'function' ? transfer.summarise : null;
    if (summarise) {
      const was = summarise({ document: state.document, authoringMetadata: state.authoringMetadata }), now = summarise({ document: result.candidate.document, authoringMetadata: result.candidate.authoring_metadata });
      const head = el(doc, 'tr');
      for (const label of ['Compared', 'This draft', 'The file']) { const th = el(doc, 'th', label); th.scope = 'col'; head.append(th); }
      const thead = el(doc, 'thead'); thead.append(head); summaryTable.append(thead);
      const body = el(doc, 'tbody');
      for (const [key, label, show] of ROWS) {
        const row = el(doc, 'tr'), name = el(doc, 'th', label); name.scope = 'row';
        const changed = String(was[key]) !== String(now[key]);
        row.append(name, el(doc, 'td', show(was[key])), el(doc, 'td', `${show(now[key])}${changed ? '' : ' (same)'}`));
        row.setAttribute('data-changed', String(changed));
        body.append(row);
      }
      summaryTable.append(body);
    }
    const lines = [];
    if (intent === 'revise') lines.push(result.diff?.length ? `${plural(result.diff.length, 'field')} would change in this draft.` : 'No field changes: the file matches this draft.');
    else lines.push('Replacing keeps nothing of this draft’s content: the file’s case takes its place. Download this case first if you may want it back.');
    if (state.dirty) lines.push('This draft has unsaved changes; they are replaced too.');
    if (result.copyReviewWarning) lines.push('As a new case, the file becomes a separate draft that does not carry approval.');
    note.textContent = lines.join(' ');
    showIssues(issues, [...(result.warnings ?? []), ...(result.errors ?? []), ...(result.staleProvenance ?? [])], doc);
    // Preserving a file is distinct from it being ready to rehearse: both are said, and neither stands in for source, rights or editorial review.
    const open = result.readinessErrors ?? [];
    readiness.textContent = result.readyForRehearsal
      ? 'Rehearsal readiness: ready structurally. This does not confirm source accuracy, rights or editorial approval. Source, rights and editorial review remain separate.'
      : `Rehearsal readiness: blocked${open.length ? ` — ${open.slice(0, 5).map(item => item.message ?? item.code ?? 'Review item').join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''}` : ''}. This does not stop the import. Source, rights and editorial review remain separate.`;
  }

  const stillBound = record => Boolean(record && alive && isCurrent() && sameBinding(record.binding, current()));
  async function replaceDraft() {
    const record = inspected;
    if (!record || !record.result.canAcceptPreservedCandidate || !stillBound(record)) return say('The preview is out of date. Choose the file again.');
    if (rightsBox.hidden === false && !rightsAck.checked) return say('Review the source-rights warnings first.');
    say('Replacing this draft…');
    try {
      const result = await applyCandidate(record.result.candidate, {
        expectedGeneration: record.binding.generation, expectedRevision: record.binding.revision,
        expectedIntentDigest: record.binding.intentDigest,
      });
      if (!alive || !isCurrent()) return;
      if (!result?.ok) return say(result?.message ?? 'The draft changed or refused the file; nothing was replaced.');
      resetPreview(); say('This draft was replaced by the file. Save it to keep it.');
    } catch { say('The draft could not be replaced; it is unchanged.'); }
  }

  async function importAsNewCase() {
    const record = inspected;
    if (!record || record.intent !== 'copy' || !record.result.canAcceptPreservedCandidate || !stillBound(record)) return say('The preview is out of date. Choose the file again.');
    if (rightsBox.hidden === false && !rightsAck.checked) return say('Review the source-rights warnings first.');
    if (!copyCandidate || copyBinding !== record.binding) {
      say('Preparing the new case…');
      try { copyCandidate = await transfer.createCopyCandidate(record.result.candidate); }
      catch { copyCandidate = { ok: false }; }
      copyBinding = record.binding;
      if (!alive || !stillBound(record)) { copyCandidate = null; copyBinding = null; return say('This draft changed while the new case was prepared. Choose the file again; no case was created.'); }
      if (!copyCandidate?.ok) return say(issueText(copyCandidate?.errors) || 'The file cannot be copied safely.');
    }
    say('Creating the new case…');
    try {
      const result = await createCopy(copyCandidate.candidate, {
        identityMap: copyCandidate.mapping,
        expectedGeneration: record.binding.generation, expectedRevision: record.binding.revision,
        expectedIntentDigest: record.binding.intentDigest,
        doNotInheritApproval: true,
      });
      if (!alive || !isCurrent()) return;
      if (!result?.ok) return say(result?.message ?? 'The new case was not created. Trying again uses the same prepared copy.');
      say('A new case was created as a separate draft that is not approved.');
    } catch { say('The new case was not created. Trying again uses the same prepared copy.'); }
  }

  function clearPrivateState() {
    generation++; exportGeneration++;
    pasted.value = ''; file.value = ''; rightsAck.checked = false;
    privateChoice.input.checked = true; for (const choice of [sourcesChoice, provenanceChoice, preparationChoice, lineageChoice, exportRights]) choice.input.checked = false;
    syncSourceChoices(); resetPreview(); say('Cleared.');
  }

  const changed = () => { generation++; exportGeneration++; resetPreview(); };
  pasted.addEventListener('input', changed);
  pasted.addEventListener('input', () => { if (file.value) file.value = ''; });
  file.addEventListener('change', changed);
  file.addEventListener('change', () => { if (file.files?.[0]) { pasted.value = ''; void preview(); } });
  // Stating the rights review again re-checks the file against the newly stated choice; a stale result is never enabled by a tick.
  rightsAck.addEventListener('change', () => { if (inspected) void preview(); });

  function retire() { if (!alive) return; alive = false; generation++; exportGeneration++; inspected = null; copyCandidate = null; copyBinding = null; clear(root); root.remove(); }
  return { element: root, clear: clearPrivateState, retire };
}

function issueText(issues) {
  if (!Array.isArray(issues) || !issues.length) return '';
  return issues.slice(0, 20).map(item => typeof item === 'string' ? item : item?.message ?? item?.code ?? 'The file did not pass validation.').join('; ');
}
function showIssues(parent, issues, doc) {
  if (!Array.isArray(issues)) return;
  for (const issue of issues.slice(0, 200)) parent.append(el(doc, 'p', typeof issue === 'string' ? issue : issue?.message ?? issue?.code ?? 'Review item'));
  if (issues.length > 200) parent.append(el(doc, 'p', `${issues.length - 200} more items are not shown.`));
}
