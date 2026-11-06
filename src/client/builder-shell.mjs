// Builder workspace shell (cards 50/51, BWR02/07/19; Julian's ruling 2026-10-11: match the Round 4 study). The app-bar
// tools, menus, panel heads, labelled disclosures, grouped readiness and the unified draft history wiring. Lazy chunk
// loaded with the studio; it owns presentation only and commits nothing itself.
import { createDraftHistory, bindHistoryKeys } from './builder-history.mjs';
export { moveStage, moveStageTo, stageMoveTargets, connectStage, duplicateStage, withEmptySlide, withoutComposedShadows } from '../shared/builder-graph.mjs';

export { createDraftHistory, bindHistoryKeys };

// Measurement and conversion load on first use: the in-page rehearsal and transfer views never need them.
let fitModule = null;
const loadFit = () => (fitModule ??= import('./builder-fit.mjs'));
/** A projector-fit probe that loads its frame code on first use. A destroyed probe answers null and builds nothing. */
export function createFitProbe(doc) {
  let probe = null, destroyed = false;
  const get = async () => { const module = await loadFit(); if (destroyed) return null; return (probe ??= module.createFitProbe(doc)); };
  return {
    measure: async (...args) => (await get())?.measure(...args) ?? null,
    fitDocument: async document => (await get())?.fitDocument(document) ?? null,
    destroy() { destroyed = true; probe?.destroy(); },
  };
}
const BUILDER_SHELL_CSS_URL = '__BUILDER_SHELL_CSS_URL__';
export function ensureShellStyles(doc) {
  if (doc.getElementById('builder-shell-styles')) return;
  const link = doc.createElement('link'); link.id = 'builder-shell-styles'; link.rel = 'stylesheet';
  link.href = new URL(BUILDER_SHELL_CSS_URL === '__BUILDER_SHELL_CSS_URL__' ? '/src/client/builder-shell.css' : BUILDER_SHELL_CSS_URL, doc.location.origin).href;
  doc.head.append(link);
}

const el = (doc, tag, text, cls) => { const node = doc.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };

/**
 * A menu button with a popover list. `items()` builds the entries each time it opens, so they reflect the current
 * draft. Escape, an outside click or choosing an entry closes it and returns focus to the button.
 */
export function menuButton(doc, { label, text = label, cls = 'builder-tool', items, onOpen = () => {} }) {
  const wrap = el(doc, 'div', null, 'builder-menu'), toggle = el(doc, 'button', text, cls), list = el(doc, 'div', null, 'builder-menu-list');
  toggle.type = 'button'; toggle.setAttribute('aria-haspopup', 'true'); toggle.setAttribute('aria-expanded', 'false');
  if (text !== label) toggle.setAttribute('aria-label', label);
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', label); list.hidden = true;
  const view = doc.defaultView;
  const close = (focus = true) => {
    if (list.hidden) return; list.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    view.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', escape, true);
    if (focus) toggle.focus();
  };
  const outside = event => { if (!wrap.contains(event.target)) close(false); };
  const escape = event => { if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); close(); } };
  toggle.addEventListener('click', () => {
    if (!list.hidden) return close();
    const entries = items(() => close());
    if (!entries.length) return;
    list.replaceChildren(...entries); list.hidden = false; toggle.setAttribute('aria-expanded', 'true'); onOpen();
    view.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', escape, true);
    // The first tool that can act takes focus; a disabled one cannot hold it.
    list.querySelector('button:not(:disabled)')?.focus();
  });
  // Choosing any entry closes the menu; its own action runs first. One delegated listener: entries may be reused.
  list.addEventListener('click', event => { if (event.target.closest('button')) close(false); });
  wrap.append(toggle, list);
  return { node: wrap, toggle, close };
}

/** A labelled, collapsible context under the slide. Its open state is kept across re-renders by `key`. */
export function disclosure(doc, title, { chip = null, open = false, onToggle = () => {}, cls = '' } = {}) {
  const details = el(doc, 'details', null, `builder-disclosure ${cls}`.trim()), summary = el(doc, 'summary');
  summary.append(el(doc, 'span', title, 'builder-disclosure-title'));
  if (chip) summary.append(el(doc, 'span', chip, 'builder-private-chip'));
  details.append(summary); details.open = open;
  details.addEventListener('toggle', () => onToggle(details.open));
  const body = el(doc, 'div', null, 'builder-disclosure-body'); details.append(body);
  return { details, summary, body };
}

/**
 * Readiness in the spec's three categories (BWR12), each grouped by what needs doing and counted, so one repeated
 * review never buries a single blocking repair. Each link names the record it opens.
 */

/** A panel heading with an optional close (×) control that proxies the region's own Hide button. */
export function panelHead(doc, title, { close = null, closeLabel = '' } = {}) {
  const head = el(doc, 'div', null, 'builder-panel-head');
  head.append(el(doc, 'h2', title));
  if (close) { const button = el(doc, 'button', '×', 'builder-panel-close'); button.type = 'button'; button.setAttribute('aria-label', closeLabel); button.addEventListener('click', close); head.append(button); }
  return head;
}

/** Plain-language fit line for the canvas footer. */
export function fitText(result, target) {
  // One short line (CASE-223); the blocks themselves are listed by the issues control beside it.
  if (!result) return 'Checking fit…';
  if (result.fits) return `All blocks fit ${target}${result.shrunk ? ` · ${result.shrunk} shrunk to fit` : ''}`;
  const count = result.marked || 0;
  return count ? `${count} ${count === 1 ? 'block overflows' : 'blocks overflow'} at ${target}` : `Does not fit ${target}`;
}

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
// The overview's topology moved to builder-overview.mjs with the Overview rebuild (CASE-321).

// The editable fields for the case and the selected stage, with their pointers and provenance owners (moved from the studio).
const fieldKey = (ownerId, field) => `${ownerId}:${field}`;
const findIndexById = (items, id) => Array.isArray(items) ? items.findIndex(item => item?.id === id) : -1;
const isFormatted = value => record(value) && Array.isArray(value.blocks);
// A prose field: formatted once it holds formatting, plain text otherwise; formatting is offered either way.
const prose = (key, label, value, pointer, ownerId, provenanceField) => ({ key, label, value: value ?? '', type: isFormatted(value) ? 'formatted' : 'textarea', formatAvailable: true, pointer, ownerId, provenanceField });
const groupLabel = group => group === 'points' ? 'Finding' : group === 'investigations' ? 'Investigation result' : 'Observation';
export function describeFields(document, metadata, beat, selectedPathId, rowKeys, composed = false) {
  const fields = [];
  const add = (ownerId, field, label, value, type, pointer) => fields.push({ key: fieldKey(ownerId, field), label, value: value ?? '', type, pointer,
    ...(['cue', 'rationale', 'recovery', 'debrief_prompt'].includes(field) ? { formatAvailable: true } : {}),
    ...(ownerId !== 'case' ? { ownerId, provenanceField: field } : {}) });
  add('case', 'title', 'Case title', document.title, 'text', '/title');
  add('case', 'summary', 'Case summary', document.summary, 'textarea', '/summary');
  add('case', 'audience', 'Audience', document.audience, 'text', '/audience');
  add('case', 'setting', 'Setting', document.setting, 'text', '/setting');
  add('case', 'duration_min', 'Teaching estimate in minutes', document.duration_min === undefined ? '' : String(document.duration_min), 'text', '/duration_min');
  fields.at(-1).valueKind = 'number';
  for (const [index, objective] of (document.learning_objectives ?? []).entries()) add('case', `objective:${index}`, `Learning objective ${index + 1}`, objective, 'textarea', `/learning_objectives/${index}`);
  if (metadata?.preparation_requirements !== undefined) fields.push({ key: 'metadata:preparation_requirements', label: 'Private preparation requirements', value: metadata.preparation_requirements, type: 'textarea', pointer: '/preparation_requirements', metadata: true });
  for (const [index, source] of (metadata?.sources ?? []).entries()) {
    fields.push({ key: fieldKey(source.id, 'title'), label: `Source ${index + 1} title`, value: source.title ?? '', type: 'text', pointer: `/sources/${index}/title`, metadata: true, ownerId: source.id });
    fields.push({ key: fieldKey(source.id, 'text'), label: `Source ${index + 1} original text`, value: source.text ?? '', type: 'textarea', pointer: `/sources/${index}/text`, metadata: true, metadataKind: 'source-text', ownerId: source.id });
  }
  if (!beat) return fields;
  const beatIndex = findIndexById(document.beats, beat.id);
  add(beat.id, 'title', 'Slide title', beat.title, 'text', `/beats/${beatIndex}/title`); fields.at(-1).placeholder = 'Name this slide';
  // A stage's purpose and its content's presentation are not free text (final audit, round 15): a decision is made or
  // removed through the Stage menu, and the presentation purpose is chosen from its list in Case details.
  add(beat.id, 'cue', 'Private stage cue', beat.cue, isFormatted(beat.cue) ? 'formatted' : 'textarea', `/beats/${beatIndex}/cue`);
  const surfaceIndex = findIndexById(document.surfaces, beat.surface_id);
  const surface = document.surfaces?.[surfaceIndex];
  if (surface) {
    add(surface.id, 'title', 'Learner content heading', surface.title, 'text', `/surfaces/${surfaceIndex}/title`);
    if (!composed) fields.push(prose(fieldKey(surface.id, 'scene'), 'Learner scene', surface.scene, `/surfaces/${surfaceIndex}/scene`, surface.id, 'scene'));
    // D14: every stage's content offers its notes field, written or not (an absent field is the empty one).
    fields.push(prose(fieldKey(surface.id, 'notes'), 'Private facilitator notes', surface.notes, `/surfaces/${surfaceIndex}/notes`, surface.id, 'notes'));
    for (const [group, values] of [['points', surface.points], ['investigations', surface.investigations]]) for (const [index, value] of (values ?? []).entries()) {
      const key = rowKeys.get(`${surface.id}:${group}`)?.[index] ?? `${index}`;
      fields.push({ key: fieldKey(key, 'value'), label: `${group === 'points' ? 'Finding' : 'Investigation'} ${index + 1}`, value, type: 'textarea', pointer: `/surfaces/${surfaceIndex}/${group}/${index}`, ownerId: surface.id, provenanceField: `${group}[${index}]` });
    }
    for (const [variantIndex, variant] of (surface.variants ?? []).entries()) {
      const variantBase = `/surfaces/${surfaceIndex}/variants/${variantIndex}`;
      const prefix = `${surface.id}:variant:${variantIndex}`;
      fields.push(prose(fieldKey(prefix, 'scene'), `Variant ${variantIndex + 1} learner scene`, variant.scene, `${variantBase}/scene`, surface.id, `variants[${variantIndex}].scene`));
      if (variant.notes !== undefined) fields.push(prose(fieldKey(prefix, 'notes'), `Variant ${variantIndex + 1} private notes`, variant.notes, `${variantBase}/notes`, surface.id, `variants[${variantIndex}].notes`));
      for (const [group, values] of [['points', variant.points], ['investigations', variant.investigations]]) for (const [index, value] of (values ?? []).entries()) {
        fields.push({ key: fieldKey(prefix, `${group}:${index}`), label: `Variant ${variantIndex + 1} ${groupLabel(group)} ${index + 1}`, value, type: 'textarea', pointer: `${variantBase}/${group}/${index}`, ownerId: surface.id, provenanceField: `variants[${variantIndex}].${group}[${index}]` });
      }
    }
    for (const [index, row] of (surface.observations ?? []).entries()) {
      const rowKey = rowKeys.get(`${surface.id}:observations`)?.[index] ?? `${index}`;
      for (const key of ['label', 'value', 'unit']) fields.push({ key: fieldKey(rowKey, key), label: `Observation ${index + 1} ${key}`, value: row?.[key] ?? '', type: 'text', pointer: `/surfaces/${surfaceIndex}/observations/${index}/${key}`, ownerId: surface.id, provenanceField: `observations[${index}].${key}` });
    }
  }
  if (beat.kind === 'decision') {
    const decisionIndex = findIndexById(document.decisions, beat.decision_id); const decision = document.decisions?.[decisionIndex];
    if (decision) {
      fields.push(prose(fieldKey(decision.id, 'prompt'), 'Question to the room', decision.prompt, `/decisions/${decisionIndex}/prompt`, decision.id, 'prompt'));
      for (const [index, path] of (decision.paths ?? []).entries()) {
        const selected = selectedPathId === path.id;
        if (!selected) continue;
        fields.push(prose(fieldKey(path.id, 'rationale'), 'Consequence rationale', path.rationale, `/decisions/${decisionIndex}/paths/${index}/rationale`, path.id, 'rationale'));
        fields.push(prose(fieldKey(path.id, 'cue'), 'Private facilitator cue', path.cue, `/decisions/${decisionIndex}/paths/${index}/cue`, path.id, 'cue'));
        if (path.recovery) fields.push(prose(fieldKey(path.id, 'recovery'), 'Required recovery action', path.recovery.prompt, `/decisions/${decisionIndex}/paths/${index}/recovery/prompt`, path.id, 'recovery.prompt'));
        if (path.terminal) fields.push(prose(fieldKey(path.id, 'debrief_prompt'), 'Terminal debrief prompt', path.terminal.debrief_prompt, `/decisions/${decisionIndex}/paths/${index}/terminal/debrief_prompt`, path.id, 'terminal.debrief_prompt'));
      }
    }
  }
  return fields;
}


/**
 * Explicit upgrade of a fixed-layout draft to slides (card 56 conversion). Reviewed before it applies; on Turn into
 * slides each slide's layout is chosen by measuring it in the projector frame, and the result names what still needs
 * editing. Nothing is saved until Save draft; Undo restores the previous draft.
 */
export function upgradePanel(ctx, { probe, button, element }) {
  const { doc, state } = ctx, nodes = [element(doc, 'h3', 'Slides'), element(doc, 'p', 'This draft uses fixed stage layouts. Turning it into slides keeps every word and moves learner content into editable blocks.')];
  const pending = state.upgrade?.base === ctx.document ? state.upgrade : null;
  if (!pending) { nodes.push(button(doc, 'Review turning this draft into slides', async () => {
    const base = ctx.document, { convertToSlideDocument } = await loadFit();
    if (base !== ctx.document) return;
    const result = convertToSlideDocument(base, ctx.metadata, { createId: ctx.createId });
    state.upgrade = { base, result };
    ctx.status(result.ok ? 'Review the upgrade before applying it.' : `Not changed. ${result.message}`);
    ctx.rerender();
  })); return nodes; }
  const { result } = pending;
  if (!result.ok) { nodes.push(element(doc, 'p', result.message), button(doc, 'Close', () => { state.upgrade = null; ctx.rerender(); })); return nodes; }
  const review = element(doc, 'section', undefined, 'builder-slide-review'); review.setAttribute('role', 'group'); review.setAttribute('aria-label', 'Review upgrade');
  const list = element(doc, 'ul');
  for (const line of [`${result.candidate.document.compositions.length} slides, one for each stage and consequence that shows learner content.`,
    `${result.candidate.document.blocks.length} blocks carry the existing text in its current reveal order.`,
    'Each slide’s layout is chosen by measuring it on a 1280 × 720 projector.',
    result.staled ? `${result.staled} source ${result.staled === 1 ? 'trace is' : 'traces are'} re-pointed and marked for review again.` : 'No source traces change.',
    'Nothing is saved until you choose Save draft. Undo restores the previous draft.']) list.append(element(doc, 'li', line));
  const apply = button(doc, 'Turn into slides', async () => {
    if (pending.base !== ctx.document) { state.upgrade = null; ctx.status('The draft changed after this review. Review the upgrade again.'); ctx.rerender(); return; }
    apply.disabled = true; ctx.status('Measuring each slide on the projector…');
    const fitted = await probe()?.fitDocument(result.candidate.document).catch(() => null);
    state.upgrade = null;
    if (pending.base !== ctx.document) { ctx.status('The draft changed while the slides were measured. Review the upgrade again.'); ctx.rerender(); return; }
    const over = fitted?.overflowing ?? 0;
    ctx.commit(fitted?.document ?? result.candidate.document, { metadata: result.candidate.authoringMetadata, structural: true,
      label: `Draft turned into slides. Every word is kept${over ? `; ${over} ${over === 1 ? 'slide needs' : 'slides need'} editing to fit the projector` : ''}. Save to keep the upgrade.` });
  }, 'builder-btn builder-confirm'); // a reviewed change confirms in amber; Save stays the one petrol primary (BWR19)
  review.append(list, apply, button(doc, 'Cancel', () => { state.upgrade = null; ctx.status('Not changed.'); ctx.rerender(); }));
  nodes.push(review);
  return nodes;
}
