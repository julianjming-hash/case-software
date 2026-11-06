// Card 51: the schema-3 slide canvas and its one contextual inspector (lazy chunk; CASE-344: no tabs). The route loads it
// only when the server grants `slide_composition`. Canonical text lives only in the document's blocks: every gesture is
// a slide-edit.mjs operation committed through the studio's validated commit, and the slide is drawn by card 56's
// text-only renderer. Editing controls are native inputs keyed for focus restore; nothing is written from the DOM.
import { slidePlan, buildSlide, inkShows, heroColumns, slideIcons } from './slide-render.mjs';
export { heroColumns };
import { PARAGRAPH_STYLES, SLIDE_LIMITS, CALLOUT_ICONS, paragraphsText, validateSlideParts } from '../shared/slide-document.mjs';
import * as ops from '../shared/slide-edit.mjs';
import { INK_TONES, SLIDE_FILLS } from '../shared/slide-text.mjs';
import { decisionBranches, BRANCH_ICON_PATH, BRANCH_LABEL } from '../shared/decision-branches.mjs';
import { gasTitle, GAS_SAMPLES } from '../shared/slide-gas-view.mjs';
import { SLIDE_THEMES, applySlideTheme } from '../shared/slide-themes.mjs';
import { slideHero } from '../shared/slide-hero.mjs';
import { compositionFor, clarificationDecision } from './builder-slide-check.mjs';
import { mountBlockText, setCaret } from './builder-slide-text.mjs';
import { builderTileKey, helpKey } from './keymap.mjs';
import { SLASH, slashMatches, slashQuery } from './builder-slash.mjs';

export { caretOf, setCaret } from './builder-slide-text.mjs';

export { compositionFor, clarificationDecision, isComposed, reconcile } from './builder-slide-check.mjs';
export { traceTargets, traceFields, followHeadings } from '../shared/slide-edit.mjs';
// ── images (card 59 M2) ──────────────────────────────────────────────────────────────
// The route hands over the signed-in workspace's image services; images load lazily (builder-media.mjs) and are held as
// browser-local handles for this page only, revoked when the services change or the Builder closes.
const media = { services: null, rows: new Map(), urls: new Map(), copies: new Map(), loading: new Set(), listed: null, module: null, rerender: null, generation: 0 };
export function setMediaServices(services) {
  for (const entry of [...media.urls.values(), ...media.copies.values()]) if (entry?.url) URL.revokeObjectURL(entry.url);
  Object.assign(media, { services, rows: new Map(), urls: new Map(), copies: new Map(), loading: new Set(), listed: null, rerender: null });
}
const mediaModule = () => (media.module ??= import('./builder-media.mjs'));
/** The resolver slidePlan draws images with: dimensions and credit from the image's row, bytes once fetched. */
const resolveImage = ({ asset_id: assetId }) => {
  const row = media.rows.get(assetId), got = media.urls.get(assetId);
  if (!row || !got) loadImage(assetId);
  return got || row ? { url: got?.url ?? null, state: got?.state ?? row?.status, width: row?.width ?? 0, height: row?.height ?? 0, attribution: row?.attribution ?? '' } : null;
};
function mediaFor(ctx) { media.rerender = () => ctx.rerender(); return resolveImage; }
/**
 * D28: the canvas's own images for the Builder's other drawings (the fit check, Run preview). It never takes over the
 * canvas's redraw; an image that arrives redraws the canvas, which updates them. `generation` moves as images arrive.
 */
export const builderMedia = Object.freeze({ resolve: resolveImage, get generation() { return media.generation; } });
function loadImage(assetId) {
  if (!media.services || media.loading.has(assetId)) return;
  media.loading.add(assetId);
  const services = media.services;
  mediaModule().then(async module => {
    if (!media.listed) media.listed = module.listImages(services).then(rows => { if (media.services === services) for (const row of rows) media.rows.set(row.asset_id, row); }, () => {});
    await media.listed;
    // The canvas draws a video's poster (rooms play it); a GIF animates as itself.
    const found = await module.fetchImage(services, assetId, media.rows.get(assetId)?.media_type === 'video/mp4' ? 'poster' : 'display').catch(() => ({ state: 'missing' }));
    if (media.services !== services) { if (found.url) URL.revokeObjectURL(found.url); return; }
    media.urls.set(assetId, found); media.generation++; media.rerender?.();
  }, () => {});
}

const BUILDER_SLIDES_CSS_URL = '__BUILDER_SLIDES_CSS_URL__';
export function ensureSlideStyles(doc) {
  if (doc.getElementById('builder-slides-styles')) return;
  const link = doc.createElement('link'); link.id = 'builder-slides-styles'; link.rel = 'stylesheet';
  link.href = new URL(BUILDER_SLIDES_CSS_URL === '__BUILDER_SLIDES_CSS_URL__' ? '/src/client/builder-slides.css' : BUILDER_SLIDES_CSS_URL, doc.location.origin).href;
  doc.head.append(link);
}

const TYPE_NAMES = { text: 'Text', list: 'List', quote: 'Quote', callout: 'Callout', values: 'Values and units', table: 'Table', timeline: 'Timeline', trend: 'Trend chart', gas: 'Blood gas', image: 'Image', question: 'Question' };
const STYLE_NAMES = { p: 'Paragraph', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4' };
const TEMPLATE_NAMES = { bento: 'Bento', story: 'Story', columns: 'Columns', title_text: 'Title and text', blank: 'Blank' };
const RECIPE_NAMES = { observations: 'Observations table', investigations: 'Investigations table', timeline: 'Timeline table', comparison: 'Comparison table', blank: 'Blank table' };
const TONE_NAMES = { plain: 'Plain', soft: 'Soft', blue: 'Blue', teal: 'Teal', green: 'Green', purple: 'Purple', coral: 'Coral', orange: 'Orange', amber: 'Amber', grey: 'Grey' };
const WRITING = ['text', 'quote', 'callout', 'list'];

const el = (doc, tag, text, cls) => { const node = doc.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
const btn = (doc, label, action, cls = 'builder-btn') => { const node = el(doc, 'button', label, cls); node.type = 'button'; node.addEventListener('click', action); return node; };
const byId = (list, id) => (Array.isArray(list) ? list : []).find(item => item?.id === id) ?? null;
/** The room's branch badge (CASE-313): Lucide "split", labelled for assistive technology. */
function branchBadge(doc) {
  const badge = el(doc, 'span', null, 'builder-branch-badge'); badge.title = BRANCH_LABEL; badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', BRANCH_LABEL);
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', BRANCH_ICON_PATH); svg.append(path); badge.append(svg);
  return badge;
}
/** The names of the slides that use a block: their stage, consequence or clarification (§5: name every use). */
function sharedNames(document, blockId) {
  return document.compositions.filter(item => item.reading_order.includes(blockId)).map(({ owner }) => {
    if (owner.kind === 'beat') return byId(document.beats, owner.id)?.title || 'Untitled stage';
    if (owner.kind === 'path') return (document.decisions ?? []).flatMap(item => item.paths ?? []).find(path => path.id === owner.id)?.label || 'Untitled consequence';
    return byId(document.clarifications, owner.id)?.label || 'Untitled clarification';
  });
}
// Plain editing covers one unformatted run. Bold or multi-run text stays exact and read-only until the format toolbar.
const promptText = value => typeof value === 'string' ? value : paragraphsText(value?.blocks?.map(item => item.runs ? item : { runs: (item.items ?? []).flatMap(entry => entry.runs) }) ?? []);

/** The slide for the selection, dropping a block selection or review that belongs to another slide. */
function slideOf(ctx) {
  const composition = compositionFor(ctx.document, ctx.selection), state = ctx.state;
  if (state.slideId !== composition?.id) {
    // A navigation that names a block on the new slide (Undo, an issue link) keeps it selected across the slide change.
    const keep = state.keepBlockId;
    Object.assign(state, { slideId: composition?.id, blockId: null, cell: null, review: null, node: null, previewStep: null, fresh: null });
    if (keep && composition?.reading_order?.includes(keep)) state.blockId = keep;
  } else if (state.blockId && !composition.reading_order.includes(state.blockId)) state.blockId = null;
  state.keepBlockId = null;
  return composition;
}

export function blockLabel(block, decisions = []) {
  if (!block) return 'Missing block';
  const words = block.type === 'question' ? promptText(byId(decisions, block.decision_id)?.prompt)
    : block.type === 'list' ? paragraphsText(block.items) : block.paragraphs ? paragraphsText(block.paragraphs)
    : block.type === 'table' ? block.caption || block.columns.map(item => item.label).filter(Boolean).join(', ')
    : block.type === 'trend' ? block.caption || block.y_label || block.series.map(item => item.label).filter(Boolean).join(', ')
    : block.type === 'image' ? block.caption || block.alt
    : block.type === 'gas' ? gasTitle(block)
    : (block.rows ?? block.entries ?? []).map(item => item.label).filter(Boolean).join(', ');
  const short = words.replace(/\s+/g, ' ').trim();
  // A text block whose every paragraph is a heading style is named a Heading, as the palette called it (round 19).
  const kind = block.type === 'text' && block.paragraphs?.length && block.paragraphs.every(item => /^h[1-3]$/.test(item?.style ?? '')) ? 'Heading' : TYPE_NAMES[block.type];
  return `${kind}${short ? ` · ${short.length > 48 ? `${short.slice(0, 47)}…` : short}` : ''}`;
}

/**
 * Run one operation. A refusal is announced and changes nothing; a reviewable refusal (populated rows, losses, shared
 * use, removal) waits in the inspector until Confirm, which re-runs against the same document or asks for a new review.
 */
function run(ctx, attempt, label, { quiet = false, review = null } = {}) {
  const result = review ? { ok: false, review: true, reason: review } : attempt(false);
  if (result.ok) return apply(ctx, result.document, label, quiet, attempt, false, result.metadata);
  if (result.review) return ask(ctx, result.reason, label, attempt, result.preview ?? null);
  ctx.status(`Not changed. ${result.reason}`);
  if (!quiet) ctx.rerender();
  return false;
}
function ask(ctx, reason, label, attempt, preview = null) {
  ctx.state.review = { reason, label, attempt, base: ctx.document, preview };
  // The review lives in Tools: a review started on the canvas opens Tools when it is hidden, so Confirm is always there.
  ctx.revealTools?.();
  ctx.status(reason); ctx.rerender('slide-review');
  return false;
}
/** Commit with the private source traces carried along; dropping any trace is reviewed first. */
function apply(ctx, document, label, quiet, attempt, confirmed = false, metadata = null) {
  // An operation that copied source traces to new identities (Unsync this slide) hands the metadata that holds them.
  const carried = ops.carryProvenance(ctx.document, document, metadata ?? ctx.metadata);
  if (carried.removed && !confirmed)
    return ask(ctx, `This also removes ${carried.removed} private source ${carried.removed === 1 ? 'trace' : 'traces'} attached to the removed content. Confirm to continue.`, label, attempt);
  // A typing commit leaves a pending review in place; Confirm then re-checks it against the changed draft.
  if (!quiet) ctx.state.review = null;
  const ok = ctx.commit(document, { label, structural: !quiet, quiet, metadata: carried.metadata });
  if (!ok && !quiet) ctx.rerender();
  return ok;
}
function confirmReview(ctx) {
  const pending = ctx.state.review; ctx.state.review = null;
  if (!pending) return;
  if (pending.base !== ctx.document) { ctx.status('The draft changed after this review. Review the change again.'); ctx.rerender(); return; }
  const result = pending.attempt(true);
  if (result.ok) apply(ctx, result.document, pending.label, false, pending.attempt, true, result.metadata);
  else { ctx.status(`Not changed. ${result.reason}`); ctx.rerender(); }
}

/** The key a block's measured canvas fit is kept under: the slide and the block (CASE-249). */
export const fitKey = (compositionId, blockId) => `${compositionId}:${blockId}`;

/** The shared keymap's Builder keys (CASE-249): on the selected slide tile → Space Enter reveal the next step and ← the
 *  one before (the reveal preview); ? opens the sheet. True when the key was taken. */
export function builderKeys(ctx, event, slideShown) {
  const step = builderTileKey(event);
  if (step && slideShown) { event.preventDefault(); ctx.state.previewStep = Math.max(0, (ctx.state.previewStep ?? -1) + (step === 'next_step' ? 1 : -1)); ctx.rerender(); return true; }
  if (!helpKey(event)) return false;
  event.preventDefault(); import('./keymap-sheet.mjs').then(sheet => sheet.shortcutSheet(ctx.doc, 'builder'), () => {});
  return true;
}

// ── canvas ──────────────────────────────────────────────────────────────────────────
/** The editable slide for the current selection, or null when the selection has no slide. */
export function slideCanvas(ctx) {
  const { doc, document, state } = ctx, composition = slideOf(ctx);
  if (!composition) return null;
  // While an IME composition is open the canvas is kept as it is; the next render after compositionend rebuilds it.
  if (state.composing && state.node?.isConnected && state.node.contains(doc.activeElement)) return state.node;
  const blocks = new Map(document.blocks.map(block => [block.id, block]));
  // Reveal preview steps through the slide as the room will see it; editing waits until it ends.
  const previewing = Number.isInteger(state.previewStep), lastStep = composition.steps.length - 1;
  if (previewing) { state.previewStep = Math.max(0, Math.min(lastStep, state.previewStep)); state.blockId = null; }
  const released = previewing ? new Set(composition.steps.slice(0, state.previewStep + 1).flatMap(item => item.block_ids)) : null;
  const members = composition.reading_order.filter(id => blocks.has(id) && (!released || released.has(id)));
  const placed = new Set(composition.placements.map(item => item.block_id));
  const plan = slidePlan({ blocks: members.map(id => blocks.get(id)), composition }, { layout: 'grid', media: mediaFor(ctx), hero: slideHero(composition, id => blocks.get(id)) });
  const { root } = buildSlide(doc, plan);
  applySlideTheme(root, document.theme);
  const wrap = el(doc, 'section', null, 'builder-slide');
  wrap.setAttribute('aria-label', 'Slide editor'); wrap.dataset.compositionId = composition.id;
  if (!previewing) {
    wrap.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    wrap.addEventListener('drop', event => {
      const files = event.dataTransfer?.files; if (!files?.length) return;
      event.preventDefault(); event.stopPropagation();
      if (files.length !== 1) { ctx.status('Add one image at a time.'); return; }
      const block = blocks.get(event.target.closest?.('[data-block-id]')?.dataset.blockId);
      addImage(ctx, composition, null, block?.type === 'image' ? block : null, files[0]);
    }, true);
  }
  wrap.addEventListener('compositionstart', () => { state.composing = true; });
  wrap.addEventListener('compositionend', () => { state.composing = false; });
  const toolbar = el(doc, 'div', null, 'builder-canvas-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Text formatting');
  toolbar.hidden = true;
  state.toolbar = toolbar;
  const step = new Map(composition.steps.flatMap((item, index) => item.block_ids.map(id => [id, index])));
  if (!previewing) members.filter(id => placed.has(id)).forEach((id, index) => decorate(ctx, root.children[index], blocks.get(id), composition, step.get(id)));
  // Each block keeps its last measured fit (CASE-224) until the next measure, so a re-render never flashes full size.
  // A fit belongs to the block on this slide: a block shared by another slide fits that slide's area (CASE-249).
  members.filter(id => placed.has(id)).forEach((id, index) => { const fit = state.fit?.[fitKey(composition.id, id)]; if (fit) root.children[index]?.style.setProperty('--fit', String(fit)); });
  // A hero card keeps the room's column span too (D23), so a re-render never shows it at its measured text width. One
  // written from empty takes the full span until it is left (round 28 P1-1): its span measured empty is a sliver.
  // An empty hero spans the slide, selected or not, so selecting it moves nothing (AS-165).
  const hero = plan.hero?.block_id, lines = hero && (blocks.get(hero).paragraphs ?? blocks.get(hero).items);
  const blank = Boolean(lines) && !lines.some(line => (line.runs ?? []).some(run => run.text?.trim()));
  state.heroWide = hero && state.blockId === hero && (state.heroWide === hero || blank) ? hero : null;
  const wide = blank || Boolean(state.heroWide), cols = wide ? 12 : hero && state.cols?.[fitKey(composition.id, hero)], card = cols && root.querySelector(':scope > .slide-hero:not(.slide-hero-full)');
  if (card) { heroColumns(card, cols); card.toggleAttribute('data-hero-wide', wide); }
  // Escape or a click on empty slide space ends block editing.
  root.addEventListener('click', event => { if (event.target === root && state.blockId) { state.blockId = null; ctx.rerender(); } });
  wrap.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && state.blockId) { const id = state.blockId; state.blockId = null; ctx.rerender(`slide-block:${id}`); } });
  // CASE-344: a “+” in every free area starts a text block there (“/” as its first character turns it into any kind). A hero
  // slide has no free space to offer: its one block fills it (the Inspector's Add a block still adds one).
  const fresh = state.fresh?.compositionId === composition.id && !previewing ? state.fresh : null;
  if (!plan.hero && !state.blockId && !previewing && !fresh) for (const area of ops.freeAreas(composition.placements)) root.append(canvasAdd(ctx, composition, area));
  if (fresh) { const made = freshBlock(ctx, composition, fresh); root.append(made.node); wrap.append(made.menu); }
  // CASE-223: the text tools dock in the canvas head when the studio gives a dock; nothing on the slide is covered.
  if (ctx.toolbarDock) { ctx.toolbarDock.replaceChildren(toolbar); wrap.append(root); } else wrap.append(toolbar, root);
  if (previewing) wrap.append(revealStepper(ctx, state.previewStep, lastStep));
  const unplaced = members.filter(id => !placed.has(id));
  if (unplaced.length) {
    const tray = el(doc, 'section', null, 'builder-slide-unplaced');
    tray.append(el(doc, 'h3', `${unplaced.length} unplaced ${unplaced.length === 1 ? 'block' : 'blocks'}`), el(doc, 'p', 'Their content is kept. Place on slide uses free space or a block with room to spare; if none has room, make a block smaller first.'));
    const list = el(doc, 'ul');
    for (const id of unplaced) {
      const item = el(doc, 'li'), block = blocks.get(id);
      // A row reads as a name with two compact actions (round 21); the actions' full names carry the block's name.
      const name = blockLabel(block, document.decisions), place = btn(doc, 'Place on slide', () => run(ctx, () => ops.placeBlock(ctx.document, composition.id, id), 'Block placed.'));
      place.setAttribute('aria-label', `Place ${name} on the slide`);
      item.append(el(doc, 'span', name, 'builder-unplaced-name'), place);
      // An unplaced block is still edited in place, here in the tray; its id lets a new block's caret find it.
      if (state.blockId === id) { const node = el(doc, 'div', null, `slide-block slide-${block.type} builder-tray-block`); node.dataset.selected = 'true'; node.dataset.blockId = id; item.append(node); editInPlace(ctx, node, block, composition); }
      else { const edit = btn(doc, 'Edit', () => select(ctx, id)); edit.setAttribute('aria-label', `Edit ${name}`); item.append(edit); }
      list.append(item);
    }
    tray.append(list); wrap.append(tray);
  }
  state.node = wrap;
  return wrap;
}

function revealStepper(ctx, at, last) {
  const { doc, state } = ctx, bar = el(doc, 'div', null, 'builder-reveal-stepper'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Reveal preview');
  const go = (next, key) => { state.previewStep = next; ctx.rerender(key); };
  const previous = btn(doc, 'Previous step', () => go(at - 1, 'reveal:previous'), 'builder-btn builder-private'); previous.disabled = at <= 0; previous.dataset.controlKey = 'reveal:previous';
  const next = btn(doc, 'Reveal next step', () => go(at + 1, 'reveal:next'), 'builder-btn builder-private'); next.disabled = at >= last; next.dataset.controlKey = 'reveal:next';
  const all = btn(doc, 'All visible', () => go(last, 'reveal:all'), 'builder-btn'); all.dataset.controlKey = 'reveal:all';
  const where = el(doc, 'span', at ? `Step ${at} of ${last}` : `On entry · ${last} ${last === 1 ? 'step' : 'steps'} to reveal`, 'builder-reveal-where'); where.setAttribute('aria-live', 'polite');
  const done = btn(doc, 'Done', () => { state.previewStep = null; ctx.rerender('reveal:toggle'); }, 'builder-btn'); done.dataset.controlKey = 'reveal:done';
  bar.append(previous, where, next, all, done);
  return bar;
}

function canvasAdd(ctx, composition, area) {
  const { doc } = ctx, wrap = el(doc, 'div', null, 'builder-canvas-add');
  wrap.style.gridArea = `${area.row} / ${area.col} / span ${area.h} / span ${area.w}`;
  const open = btn(doc, '+', () => { ctx.state.fresh = { compositionId: composition.id, area, text: '', hot: 0 }; ctx.state.blockId = null; ctx.state.freshFocus = true; ctx.rerender('slide-fresh'); }, 'builder-canvas-add-button');
  open.setAttribute('aria-label', 'Add a block here'); open.title = 'Add a block here. Type, or / for a block.'; open.dataset.controlKey = `slide-canvas-add:${area.col}:${area.row}`;
  wrap.append(open);
  return wrap;
}

/**
 * The new block being written (CASE-344). It is editor-local: nothing is in the draft until it has words or a kind, so the
 * “/” and the query after it never reach the draft, the autosave or the undo stack. Plain words make a text block in this
 * area; Enter or a click on a kind makes that block instead, in one history step, with the caret in its first field. Esc
 * keeps the text as a text block; Backspace on an empty one removes it.
 */
function freshBlock(ctx, composition, fresh) {
  const { doc, state } = ctx, at = ops.settle('text', fresh.area);
  const node = el(doc, 'div', null, 'slide-block slide-text builder-fresh'); node.style.gridArea = `${at.row} / ${at.col} / span ${at.h} / span ${at.w}`; node.dataset.fresh = 'true';
  const surface = el(doc, 'div', null, 'builder-fresh-text'), menu = el(doc, 'div', null, 'builder-slash-menu');
  surface.contentEditable = 'true'; surface.setAttribute('role', 'combobox'); surface.setAttribute('aria-label', 'New block text'); surface.setAttribute('aria-autocomplete', 'list'); surface.setAttribute('aria-haspopup', 'listbox'); surface.setAttribute('aria-expanded', 'false');
  surface.dataset.placeholder = 'Type, or / for a block'; surface.dataset.controlKey = 'slide-fresh'; surface.textContent = fresh.text;
  menu.id = `builder-slash-${ctx.createId()}`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Blocks'); menu.hidden = true; surface.setAttribute('aria-controls', menu.id);
  node.append(surface);
  let list = [], composing = false;
  const textOf = () => surface.textContent.replace(/\u200b/g, '').replace(/\n/g, ' ');
  const place = () => { const outer = menu.parentElement?.getBoundingClientRect(), box = node.getBoundingClientRect(); if (!outer) return;
    const below = box.bottom - outer.top + 6, room = doc.defaultView.innerHeight - box.bottom, tall = Math.min(menu.scrollHeight, 300);
    menu.style.left = `${Math.max(0, Math.min(box.left - outer.left, outer.width - 300))}px`; menu.style.top = `${room < tall + 12 ? Math.max(0, box.top - outer.top - tall - 6) : below}px`; };
  const paint = () => {
    const query = slashQuery(textOf());
    fresh.text = textOf();
    if (query === null) { menu.hidden = true; surface.setAttribute('aria-expanded', 'false'); surface.removeAttribute('aria-activedescendant'); return; }
    list = slashMatches(query); fresh.hot = Math.min(fresh.hot ?? 0, Math.max(0, list.length - 1));
    menu.hidden = false; surface.setAttribute('aria-expanded', 'true'); menu.replaceChildren();
    let last = '';
    list.forEach((entry, index) => {
      if (entry.group !== last) { const group = el(doc, 'p', entry.group, 'builder-slash-group'); group.setAttribute('aria-hidden', 'true'); menu.append(group); last = entry.group; }
      const item = btn(doc, entry.name, () => {}, 'builder-slash-item'); item.id = `${menu.id}-${index}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(index === fresh.hot)); item.tabIndex = -1;
      if (entry.tag) item.append(el(doc, 'small', entry.tag));
      item.addEventListener('mousedown', event => { event.preventDefault(); void convert(entry); });
      menu.append(item);
      if (index === fresh.hot) surface.setAttribute('aria-activedescendant', item.id);
    });
    if (!list.length) menu.append(el(doc, 'p', 'No block by that name. Esc keeps the text.', 'builder-slash-empty'));
    place(); menu.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  };
  // The new block in this area as `text`, then (for a kind) replaced by its starter: one operation, one history step.
  const make = (entry, words) => {
    const added = ops.addBlock(ctx.document, composition.id, entry.kind, ctx.createId, { at: fresh.area, recipe: entry.recipe, sample: entry.sample });
    if (!added.ok) return added;
    let next = added.document; const id = added.blockId, chain = result => { if (result.ok) next = result.document; return result; };
    if (!added.unplaced) {
      if (entry.ordered) { const r = chain(ops.setListOrdered(next, id, true)); if (!r.ok) return r; }
      if (entry.tone) { const r = chain(ops.setCalloutTone(next, composition.id, id, entry.tone)); if (!r.ok) return r; }
      if (entry.icon) { const r = chain(ops.setCalloutIcon(next, id, entry.icon)); if (!r.ok) return r; }
      if (words) { const r = chain(ops.setParagraphs(next, id, [{ style: 'p', runs: [{ text: words }] }])); if (!r.ok) return r; }
      const block = byId(next.blocks, id), placed = chain(ops.setPlacement(next, composition.id, id, ops.settle(entry.kind, fresh.area, block)));
      if (!placed.ok) return placed;
    }
    return { ok: true, document: next, blockId: id, unplaced: added.unplaced };
  };
  const finish = (result, caret, label) => {
    if (!result.ok) { ctx.status(`Not changed. ${result.reason}`); return false; }
    state.fresh = null; state.blockId = result.blockId; state.pendingCaret = caret;
    return run(ctx, () => result, result.unplaced ? `${label} The slide is full, so it waits under Unplaced until a block is made smaller.` : label);
  };
  async function convert(entry) {
    if (entry.picture) {
      // A picture needs an image first: the chooser opens, and the new block waits here until one is chosen.
      const area = ops.settle('image', fresh.area);
      fresh.busy = true;
      try { await addImage(ctx, composition, area, null, null, () => { state.fresh = null; }); }
      finally { fresh.busy = false; if (state.fresh === fresh && surface.isConnected) surface.focus({ preventScroll: true }); }
      return;
    }
    const result = make(entry, '');
    if (result.ok && entry.kind === 'gas') state.pendingField = { blockId: result.blockId, prefix: `slide:${result.blockId}:gas:cell:` };
    finish(result, 'all', `${entry.name} added.`);
  }
  // Words become a text block the moment the first character that is not a “/” query is typed; the caret stays at the end.
  const commitText = (label = 'Text block added.') => {
    const words = textOf(); if (!words.trim()) return false;
    const result = make({ kind: 'text' }, words);
    return finish(result, words.length, label);
  };
  surface.addEventListener('input', event => {
    if (event.isComposing || composing) return;
    const words = textOf();
    if (slashQuery(words) === null && words.trim()) { commitText(); return; }
    fresh.hot = 0; paint();
  });
  surface.addEventListener('compositionstart', () => { composing = true; });
  surface.addEventListener('compositionend', () => { composing = false; const words = textOf(); if (slashQuery(words) === null && words.trim()) commitText(); else { fresh.hot = 0; paint(); } });
  surface.addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData?.getData('text/plain') ?? ''; doc.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' ')); });
  surface.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const words = textOf(), open = !menu.hidden;
    if ((event.key === 'Backspace' || event.key === 'Delete') && !words) { event.preventDefault(); event.stopPropagation(); state.fresh = null; ctx.status('Empty block removed.'); ctx.rerender(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (words.trim()) commitText('Text kept as a text block.'); else { state.fresh = null; ctx.rerender(); } return; }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (open && list[fresh.hot]) void convert(list[fresh.hot]); return; }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); fresh.hot = Math.max(0, Math.min(list.length - 1, fresh.hot + (event.key === 'ArrowDown' ? 1 : -1))); paint(); }
  });
  // Leaving to anywhere else keeps what was typed as words, or drops an empty block.
  surface.addEventListener('focusout', () => doc.defaultView.setTimeout(() => {
    if (state.fresh !== fresh || fresh.busy || !surface.isConnected || !doc.hasFocus() || node.contains(doc.activeElement)) return;
    if (!textOf().trim()) { state.fresh = null; ctx.rerender(); } else commitText();
  }, 0));
  if (fresh.text) paint();
  // The new block takes the caret as soon as it is drawn; the menu is placed once the slide is in the page.
  doc.defaultView.requestAnimationFrame(() => { if (!surface.isConnected) return; if (state.freshFocus || fresh.text) { state.freshFocus = false; surface.focus({ preventScroll: true }); if (fresh.text) setCaret(surface, { start: fresh.text.length, end: fresh.text.length }); } if (!menu.hidden) place(); });
  return { node, menu };
}

function select(ctx, blockId, caret = null) {
  if (ctx.state.blockId === blockId) return;
  ctx.state.blockId = blockId; ctx.state.cell = null; ctx.state.entry = null; ctx.state.review = null; ctx.state.pendingCaret = caret;
  ctx.rerender(`slide-text:${blockId}`);
}

/** The character offset of a click in a drawn block's text (chrome such as badges and handles not counted), or null. */
function clickedOffset(node, event) {
  const doc = node.ownerDocument, range = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!range || !node.contains(range.startContainer) || range.startContainer.nodeType !== 3) return null;
  const chrome = '.builder-reveal-badge, .builder-shared-note, .builder-block-handle, .builder-block-resize, .builder-slide-edit, .builder-slide-kicker';
  const walker = doc.createTreeWalker(node, 4, { acceptNode: text => text.parentElement?.closest(chrome) ? 2 : 1 });
  let offset = 0;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) { if (text === range.startContainer) return offset + range.startOffset; offset += text.data.length; }
  return null;
}

/** For a block edited in fields, the field under a click and the caret offset in it (CASE-249): the click that selects
 *  a table cell or the question leaves the caret there, as it does in text, so typing never lands on the page. */
function fieldAt(block, event) {
  const range = event.target.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
  const offset = range?.startContainer.nodeType === 3 && !range.startContainer.parentElement.closest('.slide-unit') ? range.startOffset : null;
  if (block.type === 'question') return { key: event.target.closest('.builder-slide-prompt') ? `slide-text:${block.id}` : null, offset };
  if (block.type === 'values' || block.type === 'timeline') {
    // The drawn row and part under the click (dt/dd/unit, or a timeline's time/event) name the field that takes the caret.
    const list = block.rows ?? block.entries, part = event.target.closest('dt, dd, li > strong, li > span, .slide-unit');
    const row = block.type === 'values' ? Math.floor([...(part?.closest('dl')?.children ?? [])].indexOf(part?.closest('dt, dd')) / 2) : [...(part?.closest('ol')?.children ?? [])].indexOf(part?.closest('li'));
    const key = !part || !list[row] ? null : part.matches('.slide-unit') ? 'unit' : part.matches('dt') ? 'label' : part.matches('dd') ? 'value' : part.matches('strong') ? 'label' : 'text';
    return { key: key && `slide:${block.id}:${list[row].id}:${key}`, offset: part?.matches('.slide-unit') || !part?.closest('.slide-unit') ? range?.startOffset ?? null : null };
  }
  const cell = block.type === 'table' && event.target.closest('th, td, caption');
  if (!cell) return { key: null, offset: null };
  if (cell.tagName === 'CAPTION') return { key: `slide:${block.id}:caption`, offset };
  const row = cell.parentElement, column = block.columns[[...row.children].indexOf(cell)], item = block.rows[[...row.parentElement.children].indexOf(row)];
  return { key: !column ? null : row.parentElement.tagName === 'THEAD' ? `slide:${block.id}:label:${column.id}` : item ? `slide:${block.id}:${item.id}:${column.id}` : null, offset };
}

function decorate(ctx, node, block, composition, step) {
  const { doc, state } = ctx;
  node.dataset.blockId = block.id;
  const uses = ctx.document.compositions.filter(item => item.reading_order.includes(block.id)).length;
  // CASE-344: a block shown on several slides is outlined on hover and selection and says so (“On 3 slides”).
  if (uses > 1) { node.dataset.synced = 'true'; const shared = el(doc, 'span', `On ${uses} slides`, 'builder-shared-note'); shared.title = `An edit changes every slide that shows this block: ${sharedNames(ctx.document, block.id).join(', ')}.`; node.append(shared); }
  // Only a later reveal is badged (round 18): a block without a number is on the slide when it opens.
  if (step) { const badge = el(doc, 'span', String(step), 'builder-reveal-badge'); badge.setAttribute('aria-hidden', 'true'); badge.title = `Revealed at step ${step}`; node.append(badge); }
  if (block.type === 'question') {
    const decision = byId(ctx.document.decisions, block.decision_id);
    node.append(el(doc, 'p', 'Question', 'builder-slide-kicker'), el(doc, 'p', promptText(decision?.prompt) || 'Write the question here.', 'builder-slide-prompt'));
    // CASE-313: the room's branch badge, shown here when the answers lead to different next slides.
    if (decisionBranches(decision)) node.append(branchBadge(doc));
  }
  // An empty block says what it holds, in the Builder only, as the question block already does (r24 P2-4). An empty hero
  // (D23) keeps the full width, selected or not: hugging nothing it would have no box to write in.
  const lines = block.paragraphs ?? block.items, blank = lines && !lines.some(line => (line.runs ?? []).some(run => run.text?.trim()));
  if (blank) node.dataset.blank = 'true';
  if (state.blockId === block.id) { node.dataset.selected = 'true'; editInPlace(ctx, node, block, composition); return; }
  if (blank) node.dataset.empty = lines[0]?.style && lines[0].style !== 'p' ? 'Heading' : 'Write here';
  // Move and resize work straight from hover or keyboard focus, without entering text editing (the study's grip).
  handles(ctx, node, block, composition, blockLabel(block, ctx.document.decisions));
  // Pointer selects anywhere on the block; keyboard and assistive technology use a real button.
  // The caret lands where the author clicked, not at the start of the block (polish round 17).
  node.addEventListener('click', event => { if (!event.target.closest('button')) select(ctx, block.id, block.paragraphs || block.type === 'list' ? clickedOffset(node, event) : fieldAt(block, event)); });
  const edit = btn(doc, 'Edit', () => select(ctx, block.id), 'builder-slide-edit');
  edit.setAttribute('aria-label', `Edit ${blockLabel(block, ctx.document.decisions)}`);
  edit.dataset.controlKey = `slide-block:${block.id}`;
  // A second Escape lets go of the block entirely (polish round 17): focus returns to the canvas, nothing is selected.
  edit.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); edit.blur(); ctx.doc.querySelector('.builder-canvas-stage')?.focus?.(); } });
  node.append(edit);
}

// Every text control is a textarea: an <input> strips line breaks, which cells, values and labels may hold. While an
// IME composition is open nothing is committed; the composed text commits once, at compositionend.
const textInput = (doc, value, label, key, onInput) => {
  const input = el(doc, 'textarea', null, 'builder-slide-input');
  input.value = value; input.rows = Math.min(6, Math.max(1, value.split('\n').length)); input.setAttribute('aria-label', label); input.dataset.controlKey = key;
  const send = () => { const ok = onInput(input.value); if (ok === false) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); };
  input.addEventListener('input', event => { if (!event.isComposing) send(); });
  input.addEventListener('compositionend', send);
  return input;
};

/** The selected block, edited where it sits: text in place, cells and rows in their own fields, plus move/resize handles. */
function editInPlace(ctx, node, block, composition) {
  const { doc, document, state } = ctx, label = blockLabel(block, document.decisions);
  const quiet = (attempt, done) => run(ctx, () => attempt(ctx.document), done, { quiet: true });
  // A trend chart stays drawn exactly as the room sees it; its numbers are edited in the Block tab (card 59 M1).
  if (block.type === 'image') {
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Editing ${label}`); handles(ctx, node, block, composition, label);
    if (!node.querySelector('figure')) node.append(...buildSlide(doc, slidePlan({ blocks: [block], composition: { reading_order: [block.id] } }, { layout: 'reflow', media: mediaFor(ctx) })).root.firstChild.childNodes);
    if (state.pendingCaret) { state.pendingCaret = null; doc.defaultView.requestAnimationFrame(() => doc.querySelector(`[data-control-key="slide:${CSS.escape(block.id)}:image:alt"]`)?.focus()); }
    return;
  }
  // A blood gas, like a chart, stays drawn as the room sees it; its rows are edited in the Block tab (CASE-311).
  if (block.type === 'gas') {
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Editing ${label}`); handles(ctx, node, block, composition, label);
    if (!node.querySelector('.slide-gas-title')) drawGas(doc, node, block);
    if (state.pendingCaret) { state.pendingCaret = null; doc.defaultView.requestAnimationFrame(() => doc.querySelector(`[data-control-key="slide:${CSS.escape(block.id)}:gas:caption"]`)?.focus()); }
    return;
  }
  if (block.type === 'trend') {
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Editing ${label}`); handles(ctx, node, block, composition, label);
    // In the Unplaced tray the chart is drawn here, as a phone reads it.
    if (!node.querySelector('svg')) drawTrend(doc, node, block);
    // A new chart opens with its vertical axis label ready to type, in the Block tab.
    if (state.pendingCaret) { state.pendingCaret = null; doc.defaultView.requestAnimationFrame(() => doc.querySelector(`[data-control-key="slide:${CSS.escape(block.id)}:trend:y_label"]`)?.focus()); }
    return;
  }
  for (const child of [...node.children]) if (!child.matches('.builder-reveal-badge, .builder-slide-kicker, .builder-shared-note')) child.remove();
  node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Editing ${label}`);
  if (block.paragraphs || block.type === 'list') {
    // A refused edit (over the block's limit, say) stays visible, marked invalid, with the reason in the status line.
    // A meter at the block shows the room left as the limit nears, and says so there when typing goes past it
    // (polish round 17): refused text never looks saved.
    const limit = SLIDE_LIMITS.textChars, meter = el(doc, 'span', null, 'builder-limit-meter'); meter.setAttribute('role', 'status');
    const count = value => block.type === 'list' ? (value ?? []).map(item => paragraphsText([item])).join('').length : paragraphsText(value ?? []).length;
    const show = (length, refused) => { meter.hidden = !refused && length < limit * 0.85; meter.dataset.state = refused ? 'over' : length >= limit * 0.95 ? 'near' : 'ok';
      meter.textContent = refused ? `Over the ${limit}-character limit · not saved` : `${length} / ${limit}`; };
    let current = block.type === 'list' ? block.items : block.paragraphs;
    // A quote or callout is written inside the same blockquote or aside the slide draws, so its indent, padding and
    // fill stay put when it is selected (CASE-251, critique P1-2).
    const wrap = block.type === 'quote' || block.type === 'callout' ? el(doc, block.type === 'quote' ? 'blockquote' : 'aside', null, 'builder-slide-wrap') : null;
    if (wrap) node.append(wrap);
    // A callout carrying `icon` is centred with its icon beside the text, selected or not (CASE-344).
    let host = wrap ?? node;
    if (block.type === 'callout' && Object.hasOwn(block, 'icon')) {
      if (block.icon !== 'none' && CALLOUT_ICONS.includes(block.icon)) wrap.append(iconSvg(doc, block.icon, 'slide-icon'));
      host = el(doc, 'div', null, 'slide-callout-text'); wrap.append(host);
    }
    const editor = mountBlockText(host, { block, label: block.type === 'text' ? 'Slide text' : `${TYPE_NAMES[block.type]} text`, onRefused: message => ctx.status(message),
      room: () => limit - count(current),
      onLimit: () => { meter.hidden = false; meter.dataset.state = 'limit'; meter.textContent = `${limit} / ${limit} · limit reached`; },
      onChange: value => { current = value;
        // CASE-344: a quote becomes a Plain callout with the quote icon when its author first edits it, in the same step as the edit.
        const converting = byId(ctx.document.blocks, block.id)?.type === 'quote';
        const refused = (converting ? run(ctx, () => { const made = ops.convertQuote(ctx.document, block.id); return made.ok ? ops.setParagraphs(made.document, block.id, value) : made; }, 'Quote edited. It is now a callout with the quote icon.', { quiet: false })
          : quiet(current => block.type === 'list' ? ops.setListItems(current, block.id, value) : ops.setParagraphs(current, block.id, value), 'Text updated.')) === false;
        editor.surface.toggleAttribute('aria-invalid', refused); show(count(value), refused && count(value) > limit); } });
    // It sits with the docked text tools (CASE-223), clear of the slide's words.
    show(count(block.type === 'list' ? block.items : block.paragraphs), false);
    if (Number.isInteger(state.pendingCaret) || state.pendingCaret === 'all') {
      const at = state.pendingCaret; state.pendingCaret = null;
      // A later render in the same frame may replace the surface, so the live one is looked up when the caret is placed.
      doc.defaultView.requestAnimationFrame(() => { const surface = doc.querySelector(`[data-control-key="slide-text:${CSS.escape(block.id)}"]`); if (!surface || (surface === doc.activeElement && !doc.getSelection().isCollapsed)) return; surface.focus({ preventScroll: true }); surface.scrollIntoView?.({ block: 'nearest' });
        if (at === 'all') { const range = doc.createRange(); range.selectNodeContents(surface); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range); }
        else setCaret(surface, { start: at, end: at }); });
    }
    editor.surface.dataset.controlKey = `slide-text:${block.id}`;
    textToolbar(ctx, block, editor);
    (state.toolbar ?? node).append(meter);
  } else if (block.type === 'question') {
    const decision = byId(document.decisions, block.decision_id);
    if (typeof decision?.prompt === 'string') {
      const prompt = textInput(doc, decision.prompt, 'Question text', `slide-text:${block.id}`, value => quiet(current => setPrompt(current, decision.id, value), 'Question updated.'));
      prompt.classList.add('builder-slide-prompt-input'); node.append(prompt);
    } else node.append(el(doc, 'p', promptText(decision?.prompt) || 'No question text yet.', 'builder-slide-prompt'), el(doc, 'p', 'This question is formatted. Edit it under Response and consequences.', 'builder-slide-note'));
  } else if (block.type === 'values' || block.type === 'timeline') node.append(entryEditor(ctx, block));
  else if (block.type === 'table') node.append(tableEditor(ctx, block, node.classList.contains('builder-tray-block')));
  // A click's field takes the caret where it was clicked; with no field under it, the first field, caret at the end.
  const want = state.pendingCaret;
  if (want && typeof want === 'object') { state.pendingCaret = null; doc.defaultView.requestAnimationFrame(() => {
    const live = doc.querySelector(`.slide-block[data-block-id="${CSS.escape(block.id)}"]`) ?? node;
    if (live.contains(doc.activeElement)) return;
    const field = (want.key && live.querySelector(`[data-control-key="${CSS.escape(want.key)}"]`)) || live.querySelector('textarea, input, [data-entry-field]');
    if (!field) return;
    const length = (field.value ?? field.textContent).length, at = Number.isInteger(want.offset) ? Math.min(want.offset, length) : length;
    field.focus({ preventScroll: true }); caretAt(field, at); }); }
  // Blocks edited in fields (tables, values, timelines, questions): the first field takes the caret.
  if (state.pendingCaret === 'all') { state.pendingCaret = null; doc.defaultView.requestAnimationFrame(() => { const live = doc.querySelector(`.slide-block[data-block-id="${CSS.escape(block.id)}"]`) ?? node; const field = live.querySelector('tbody :is(textarea, input)') ?? live.querySelector('textarea, input, [data-entry-field]');
    // A late frame never pulls the caret back from a field already being typed in, such as the row Tab just added.
    if (live.contains(doc.activeElement)) return;
    // In the Unplaced tray the slide stays in view: focus without the jump, then show just the field (round 21).
    field?.focus({ preventScroll: true }); if (field?.select) field.select(); else if (field) caretAt(field, field.textContent.length); field?.scrollIntoView?.({ block: 'nearest' }); }); }
  handles(ctx, node, block, composition, label);
  state.focusText = `slide-text:${block.id}`;
}

/** Replace a decision's plain prompt; the slide shows the decision's own question, never a second copy. */
function setPrompt(document, decisionId, prompt) {
  const next = structuredClone(document), decision = byId(next.decisions, decisionId);
  if (!decision) return { ok: false, reason: 'That decision no longer exists.' };
  decision.prompt = prompt;
  return { ok: true, document: next };
}

function textToolbar(ctx, block, editor) {
  const { doc, state } = ctx, bar = state.toolbar;
  if (!bar) return;
  bar.hidden = false; bar.replaceChildren();
  // Without a dock the toolbar floats just above the block it formats.
  if (!bar.closest('.builder-slide')) { /* docked: stays in the canvas head */ } else doc.defaultView.requestAnimationFrame(() => {
    const wrap = bar.parentElement, node = editor.surface.closest('.slide-block');
    if (!wrap || !node?.isConnected) return;
    const outer = wrap.getBoundingClientRect(), inner = node.getBoundingClientRect();
    bar.style.left = `${Math.max(0, Math.min(outer.width - bar.offsetWidth, inner.left - outer.left))}px`;
    bar.style.top = `${inner.top - outer.top - bar.offsetHeight - 6}px`;
  });
  if (block.type === 'text') {
    const style = el(doc, 'select'); style.setAttribute('aria-label', 'Text style'); style.dataset.controlKey = `slide:${block.id}:style`; style.dataset.keepSelection = 'true';
    for (const name of PARAGRAPH_STYLES) { const option = el(doc, 'option', STYLE_NAMES[name]); option.value = name; style.append(option); }
    style.value = block.paragraphs[0]?.style ?? 'p';
    // The select follows the caret; choosing restyles the lines the selection touches.
    doc.addEventListener('selectionchange', function follow() { if (!editor.surface.isConnected) return doc.removeEventListener('selectionchange', follow); const at = editor.styleAtCaret(); if (at) style.value = at; });
    style.addEventListener('mousedown', () => { state.keep = doc.getSelection()?.rangeCount ? doc.getSelection().getRangeAt(0).cloneRange() : null; });
    style.addEventListener('change', () => { if (state.keep) { const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(state.keep); } editor.setStyle(style.value); editor.focus(); });
    bar.append(style);
  }
  const bold = btn(doc, 'B', () => editor.bold(), 'builder-tool-button builder-tool-bold');
  bold.setAttribute('aria-label', 'Bold selection');
  // Keep the text selection: the button acts on it without taking focus.
  bold.addEventListener('mousedown', event => event.preventDefault());
  bar.append(bold);
  const marks = [[bold, 'strong, b']];
  for (const [kind, glyph, name] of [['sub', 'x₂', 'Subscript'], ['sup', 'x²', 'Superscript']]) {
    if (!editor.script) break;
    const button = btn(doc, glyph, () => editor.script(kind), 'builder-tool-button');
    button.setAttribute('aria-label', `${name} selection`); button.addEventListener('mousedown', event => event.preventDefault());
    bar.append(button); marks.push([button, kind]);
  }
  // Each format button says whether the text at the caret already has it (gap audit #20).
  const pressed = () => {
    const node = doc.getSelection()?.anchorNode, at = node?.nodeType === 1 ? node : node?.parentElement;
    if (!at || !editor.surface.contains(at)) return;
    for (const [button, selector] of marks) { const mark = at.closest(selector); button.setAttribute('aria-pressed', String(Boolean(mark && editor.surface.contains(mark)))); }
  };
  for (const [button] of marks) button.setAttribute('aria-pressed', 'false');
  doc.addEventListener('selectionchange', function track() { if (!editor.surface.isConnected) return doc.removeEventListener('selectionchange', track); pressed(); });
  if (block.type === 'list') {
    // The visible name is the accessible name (WCAG 2.5.3); pressed means numbered.
    const ordered = btn(doc, 'Numbered list', () => run(ctx, () => ops.setListOrdered(ctx.document, block.id, !block.ordered), 'List numbering changed.'), 'builder-tool-button');
    ordered.setAttribute('aria-pressed', String(block.ordered)); ordered.dataset.controlKey = `slide:${block.id}:ordered`;
    bar.append(ordered);
  }
}

/**
 * Move and resize on the 12 × 12 grid: drag the handles, or focus a handle and use the arrow keys (Shift with the
 * resize handle). Each gesture commits one validated placement; overlaps and out-of-grid positions are refused.
 */
function handles(ctx, node, block, composition, label) {
  const { doc } = ctx, placement = composition.placements.find(item => item.block_id === block.id);
  // A hero block (D23, CASE-264) has no grips: the hero rule places it; its stored placement waits for a second block.
  if (!placement || node.classList.contains('slide-hero')) return;
  // A block one or two rows tall has no room for both grips in its right edge: Move sits beside Resize (CASE-251).
  if (placement.h <= 2) node.dataset.short = 'true';
  const move = btn(doc, '⠿', () => {}, 'builder-block-handle'), size = btn(doc, '', () => {}, 'builder-block-resize');
  move.setAttribute('aria-label', `Move ${label}. Arrow keys move it one grid cell.`); move.dataset.controlKey = `slide:${block.id}:move`;
  size.setAttribute('aria-label', `Resize ${label}. Arrow keys change its width and height.`); size.dataset.controlKey = `slide:${block.id}:resize`;
  const place = (next, focusKey) => {
    const result = ops.setPlacement(ctx.document, composition.id, block.id, next);
    if (!result.ok) { ctx.status(`Not moved. ${result.reason}`); return; }
    run(ctx, () => result, `Block ${focusKey.endsWith(':move') ? 'moved' : 'resized'} to column ${next.col}, row ${next.row}, ${next.w} wide and ${next.h} high.`);
  };
  const keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  move.addEventListener('keydown', event => { const delta = keys[event.key]; if (!delta) return; event.preventDefault();
    place({ ...cell(placement), col: placement.col + delta[0], row: placement.row + delta[1] }, move.dataset.controlKey); });
  size.addEventListener('keydown', event => { const delta = keys[event.key]; if (!delta) return; event.preventDefault();
    place({ ...cell(placement), w: placement.w + delta[0], h: placement.h + delta[1] }, size.dataset.controlKey); });
  // Pointer drags snap to grid cells measured from the live canvas and preview live; an overlapping or out-of-grid
  // position is outlined as invalid. Escape, a cancelled pointer or lost capture restores the block; one commit on release.
  const drag = (handle, resize) => handle.addEventListener('pointerdown', event => {
    if (event.button) return;
    event.preventDefault(); handle.setPointerCapture?.(event.pointerId);
    const canvas = node.parentElement, box = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    const pad = parseFloat(style.paddingLeft) || 0, gap = parseFloat(style.columnGap) || 0;
    const colW = (box.width - 2 * pad + gap) / 12, rowH = (box.height - 2 * pad + gap) / 12, start = { x: event.clientX, y: event.clientY }, original = node.style.gridArea;
    const others = composition.placements.filter(item => item.block_id !== block.id);
    let next = null;
    const at = moveEvent => {
      const dc = Math.round((moveEvent.clientX - start.x) / colW), dr = Math.round((moveEvent.clientY - start.y) / rowH);
      return resize ? { ...cell(placement), w: placement.w + dc, h: placement.h + dr } : { ...cell(placement), col: placement.col + dc, row: placement.row + dr };
    };
    const onMove = moveEvent => {
      next = at(moveEvent);
      const inside = next.col >= 1 && next.row >= 1 && next.w >= 1 && next.h >= 1 && next.col + next.w - 1 <= 12 && next.row + next.h - 1 <= 12;
      node.style.gridArea = `${Math.max(1, next.row)} / ${Math.max(1, next.col)} / span ${Math.max(1, next.h)} / span ${Math.max(1, next.w)}`;
      node.toggleAttribute('data-invalid', !inside || others.some(item => item.col < next.col + next.w && next.col < item.col + item.w && item.row < next.row + next.h && next.row < item.row + item.h));
    };
    const finish = cancel => {
      handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel); handle.removeEventListener('lostpointercapture', onCancel);
      doc.removeEventListener('keydown', onKey, true);
      try { handle.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
      node.removeAttribute('data-invalid');
      const moved = next && (next.col !== placement.col || next.row !== placement.row || next.w !== placement.w || next.h !== placement.h);
      if (cancel || !moved) { node.style.gridArea = original; if (cancel && moved) ctx.status('Not moved. The block is back where it was.'); return; }
      place(next, handle.dataset.controlKey);
    };
    const onUp = () => finish(false), onCancel = () => finish(true);
    const onKey = keyEvent => { if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); finish(true); } };
    handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel); handle.addEventListener('lostpointercapture', onCancel);
    doc.addEventListener('keydown', onKey, true);
  });
  drag(move, false); drag(size, true);
  node.append(move, size);
}
const cell = ({ col, row, w, h }) => ({ col, row, w, h });

// CASE-249: the table being edited is the slide's table (the same element, classes and cell metrics), so selecting it
// moves nothing. A caption field shows only where the slide draws a caption (or in the Unplaced tray, which has no slide);
// Tools add one. The column ruler lies over the table: an edge on each column boundary, named only while dragged.
function tableEditor(ctx, table, tray = false) {
  const { doc } = ctx, state = ctx.state, wrap = el(doc, 'div', null, 'builder-slide-table');
  // BWR20 / gap audit #26: the table reflows to one card per row when its own width leaves under ~80 px a column,
  // whatever the canvas width; the observer stops when the editor is replaced.
  const Observer = doc.defaultView?.ResizeObserver;
  if (Observer) { const watch = new Observer(([entry]) => {
    if (!wrap.isConnected) { watch.disconnect(); return; }
    const cards = entry.contentRect.width < table.columns.length * 80;
    if (cards === wrap.classList.contains('builder-table-cards')) return;
    wrap.classList.toggle('builder-table-cards', cards);
    // Cards hide the header row; its label fields leave the tab order (labels are edited in the column's tools then).
    for (const input of wrap.querySelectorAll('thead textarea, thead input')) input.tabIndex = cards ? -1 : 0;
    // A header label being written when the cards appear hands focus to its column's first visible cell (BWR20).
    const head = cards ? doc.activeElement?.closest?.('thead th, thead td') : null;
    if (head && wrap.contains(head)) wrap.querySelector(`tbody tr > :nth-child(${[...head.parentNode.children].indexOf(head) + 1}) :is(textarea, input)`)?.focus();
  }); watch.observe(wrap); }
  const grid = el(doc, 'table', null, 'slide-table-grid');
  if (table.caption || tray) {
    const caption = textInput(doc, table.caption ?? '', 'Table caption', `slide:${table.id}:caption`, value => run(ctx, () => ops.setCaption(ctx.document, table.id, value), 'Caption updated.', { quiet: true })); caption.placeholder = 'Caption (optional)';
    const holder = el(doc, 'caption'); holder.append(caption); grid.append(holder);
  }
  // A long table scrolls inside its block while edited; its header row takes a ground only once rows pass under it.
  wrap.addEventListener('scroll', () => wrap.toggleAttribute('data-scrolled', wrap.scrollTop > 0), { passive: true });
  // Column widths, as the room draws them, and a ruler over the table whose edges drag or step a column wider or
  // narrower (1–6 parts; gap audit #26). Keyboard: each edge is a separator; ←/→ change the column to its left.
  const colgroup = el(doc, 'colgroup'), total = table.columns.reduce((sum, column) => sum + column.width, 0);
  for (const column of table.columns) { const col = el(doc, 'col'); col.style.width = `${(100 * column.width / total).toFixed(2)}%`; colgroup.append(col); }
  grid.append(colgroup);
  let ruler = null;
  if (table.columns.length > 1) {
    ruler = el(doc, 'div', null, 'builder-col-ruler'); ruler.style.gridTemplateColumns = table.columns.map(column => `${column.width}fr`).join(' ');
    table.columns.forEach((column, index) => {
      const segment = el(doc, 'span', null, 'builder-col-segment');
      const name = table.header_row && column.label ? column.label : `Column ${index + 1}`;
      segment.append(el(doc, 'span', name, 'builder-col-name')); // the width shows as the segment's share; numbers only while dragging (round 17)
      if (index < table.columns.length - 1) {
        const edge = el(doc, 'span', null, 'builder-col-edge');
        Object.assign(edge, { tabIndex: 0 }); edge.setAttribute('role', 'separator'); edge.setAttribute('aria-orientation', 'vertical');
        edge.setAttribute('aria-label', `Width of ${name}`); edge.setAttribute('aria-valuemin', '1'); edge.setAttribute('aria-valuemax', '6'); edge.setAttribute('aria-valuenow', String(column.width));
        edge.dataset.controlKey = `slide:${table.id}:edge:${column.id}`;
        const set = width => { const next = Math.max(1, Math.min(6, width)); if (next !== column.width) run(ctx, () => ops.setColumn(ctx.document, table.id, column.id, { width: next }), `${name} is ${next} ${next === 1 ? 'part' : 'parts'} wide.`); };
        edge.addEventListener('keydown', event => {
          const step = { ArrowLeft: -1, ArrowRight: 1, Home: -6, End: 6 }[event.key];
          if (step === undefined) return;
          event.preventDefault(); set(column.width + step); ctx.rerender(edge.dataset.controlKey);
        });
        edge.addEventListener('pointerdown', event => {
          event.preventDefault(); edge.setPointerCapture?.(event.pointerId);
          const unit = ruler.getBoundingClientRect().width / total, start = event.clientX, from = column.width;
          let width = from;
          // The ruler and the editor's columns follow the pointer; Escape or a cancelled pointer leaves the width unchanged.
          const preview = parts => { ruler.style.gridTemplateColumns = parts.map(value => `${value}fr`).join(' '); const sum = parts.reduce((a, b) => a + b, 0);
            [...colgroup.children].forEach((col, at) => { col.style.width = `${(100 * parts[at] / sum).toFixed(2)}%`; }); };
          const widths = table.columns.map(item => item.width);
          const move = moved => { width = Math.max(1, Math.min(6, Math.round(from + (moved.clientX - start) / unit))); segment.querySelector('.builder-col-name').textContent = `${name} · ${width} of ${widths.reduce((a, b) => a + b, 0) - widths[index] + width} parts`;
            widths[index] = width; preview(widths); };
          // Lost capture (the editor re-rendered mid-drag, say) ends the drag unchanged and drops every listener.
          let ended = false;
          segment.dataset.dragging = 'true';
          const stop = commit => { if (ended) return; ended = true; delete segment.dataset.dragging; edge.removeEventListener('lostpointercapture', cancel); edge.removeEventListener('pointermove', move); edge.removeEventListener('pointerup', up); edge.removeEventListener('pointercancel', cancel); doc.removeEventListener('keydown', escape, true);
            if (commit) set(width); else { widths[index] = from; preview(widths); segment.querySelector('.builder-col-name').textContent = name; } };
          const up = () => stop(true), cancel = () => stop(false), escape = key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); stop(false); } };
          edge.addEventListener('pointermove', move); edge.addEventListener('pointerup', up); edge.addEventListener('pointercancel', cancel); edge.addEventListener('lostpointercapture', cancel); doc.addEventListener('keydown', escape, true);
        });
        segment.append(edge);
      }
      ruler.append(segment);
    });
  }
  // A focused cell shows its row and column controls at once (D9): only the table's tools are rebuilt, not the slide.
  const focusCell = (rowId, columnId) => {
    const was = state.cell; state.cell = { tableId: table.id, rowId, columnId };
    if (was?.tableId === table.id && was.rowId === rowId && was.columnId === columnId) return;
    const holder = doc.querySelector(`[data-table-tools="${table.id}"]`), current = holder && byId(ctx.document.blocks, table.id);
    if (current) holder.replaceChildren(...tableTools(ctx, current));
  };
  if (table.header_row) {
    const head = el(doc, 'tr');
    table.columns.forEach((column, index) => {
      const th = el(doc, 'th', null, `slide-${column.align}`); th.scope = 'col';
      const input = textInput(doc, column.label, `Column ${index + 1} label`, `slide:${table.id}:label:${column.id}`, value => run(ctx, () => ops.setColumn(ctx.document, table.id, column.id, { label: value }), 'Column label updated.', { quiet: true }));
      input.addEventListener('focus', () => focusCell(null, column.id));
      th.append(...withUnit(doc, input, column.unit));
      head.append(th);
    });
    const thead = el(doc, 'thead'); thead.append(head); grid.append(thead);
  }
  const body = el(doc, 'tbody');
  table.rows.forEach((row, rowIndex) => {
    const tr = el(doc, 'tr');
    row.cells.forEach((value, index) => {
      const column = table.columns[index], name = table.header_row && column.label ? column.label : `Column ${index + 1}`;
      const td = el(doc, index === 0 && table.first_column_header ? 'th' : 'td', null, `slide-${column.align}`);
      if (td.tagName === 'TH') td.scope = 'row';
      // At narrow widths each row becomes a card; the cell names its column (BWR20 narrow reflow while editing).
      td.dataset.column = name;
      const input = textInput(doc, value, `${name}, row ${rowIndex + 1}`, `slide:${table.id}:${row.id}:${column.id}`, next => run(ctx, () => ops.setCell(ctx.document, table.id, row.id, column.id, next), 'Cell updated.', { quiet: true }));
      input.addEventListener('focus', () => focusCell(row.id, column.id));
      // Tab moves cell to cell; Tab in the last cell adds a row (inside the table's limits) and continues there.
      if (rowIndex === table.rows.length - 1 && index === row.cells.length - 1) input.addEventListener('keydown', event => {
        if (event.key !== 'Tab' || event.shiftKey || event.isComposing) return;
        const result = ops.addRow(ctx.document, table.id, row.id, ctx.createId);
        if (!result.ok) return;
        event.preventDefault();
        const added = byId(result.document.blocks, table.id).rows.at(-1);
        if (run(ctx, () => result, 'Row added.')) ctx.rerender(`slide:${table.id}:${added.id}:${table.columns[0].id}`);
      });
      // A tab- or line-separated clipboard is a range: it pastes rectangularly and atomically, reviewed before overwriting.
      input.addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
        event.preventDefault();
        run(ctx, confirmed => ops.pasteRange(ctx.document, table.id, row.id, column.id, text, ctx.createId, { confirmed }), 'Range pasted.');
      });
      td.append(...withUnit(doc, input, value === '' ? '' : column.unit));
      tr.append(td);
    });
    body.append(tr);
  });
  // The ruler follows the grid in Tab order (cells, then the width edges; round 19) and lies over it (CASE-249).
  grid.append(body); wrap.append(grid); if (ruler) wrap.append(ruler);
  return wrap;
}
/** Place the caret at a character offset in a textarea or a plain-text editable field. */
function caretAt(field, at) {
  if (field.setSelectionRange) { field.setSelectionRange(at, at); return; }
  const doc = field.ownerDocument, range = doc.createRange(), text = field.firstChild;
  if (text?.nodeType === 3) range.setStart(text, Math.min(at, text.length)); else range.selectNodeContents(field);
  range.collapse(true); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
}

/**
 * Values and Timeline edited as the slide draws them (CASE-251, critique P2-2): the same dl or timeline list, each label,
 * value, unit, time and event a plain-text field in place, so selecting one moves and rescales nothing. Row controls
 * (add, move, delete, a values row's unit) are in the Block tab, for the row whose field has focus, as a table's are.
 */
function entryEditor(ctx, block) {
  const { doc, state } = ctx, values = block.type === 'values', list = block.rows ?? block.entries;
  const names = values ? { label: 'Label', value: 'Value', unit: 'Unit' } : { label: 'Time', text: 'Event' };
  const focusEntry = entryId => {
    const was = state.entry; state.entry = { blockId: block.id, entryId };
    if (was?.blockId === block.id && was.entryId === entryId) return;
    const holder = doc.querySelector(`[data-entry-tools="${block.id}"]`), current = holder && byId(ctx.document.blocks, block.id);
    if (current) holder.replaceChildren(...entryTools(ctx, current));
  };
  const field = (tag, entry, index, key, cls) => {
    const node = el(doc, tag, entry[key] ?? '', cls); node.contentEditable = 'plaintext-only';
    node.setAttribute('role', 'textbox'); node.setAttribute('aria-label', `${names[key]}, row ${index + 1}`);
    node.dataset.controlKey = `slide:${block.id}:${entry.id}:${key}`; node.dataset.entryField = names[key]; node.spellcheck = true;
    const send = () => { const ok = run(ctx, () => ops.setEntry(ctx.document, block.id, entry.id, key, node.textContent), 'Row updated.', { quiet: true });
      node.toggleAttribute('aria-invalid', ok === false); };
    node.addEventListener('input', event => { if (!event.isComposing) send(); });
    node.addEventListener('compositionend', send);
    node.addEventListener('focus', () => focusEntry(entry.id));
    // One line, as drawn: Enter does nothing; a paste arrives as plain text on one line, hidden characters cleaned (CASE-236).
    node.addEventListener('beforeinput', event => {
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { event.preventDefault(); return; }
      if (event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') return;
      event.preventDefault();
      const text = (event.dataTransfer?.getData('text/plain') ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
      const range = doc.getSelection()?.rangeCount ? doc.getSelection().getRangeAt(0) : null;
      if (!range || !node.contains(range.startContainer)) return;
      range.deleteContents(); const part = doc.createTextNode(text); range.insertNode(part); range.setStartAfter(part); range.collapse(true);
      node.normalize(); send();
    });
    return node;
  };
  if (values) {
    const dl = el(doc, 'dl');
    list.forEach((entry, index) => {
      const dd = el(doc, 'dd'); dd.append(field('span', entry, index, 'value'));
      if (entry.unit) dd.append(field('span', entry, index, 'unit', 'slide-unit'));
      dl.append(field('dt', entry, index, 'label'), dd);
    });
    return dl;
  }
  const ol = el(doc, 'ol', null, 'slide-timeline-list');
  list.forEach((entry, index) => { const li = el(doc, 'li'); li.append(field('strong', entry, index, 'label'), doc.createTextNode(' '), field('span', entry, index, 'text')); ol.append(li); });
  return ol;
}

function entryTools(ctx, block) {
  const { doc, state } = ctx, list = block.rows ?? block.entries, nodes = [el(doc, 'h3', block.type === 'values' ? 'Values' : 'Timeline')];
  const entry = state.entry?.blockId === block.id ? list.find(item => item.id === state.entry.entryId) : null, index = entry ? list.indexOf(entry) : -1;
  const actions = el(doc, 'div', null, 'builder-slide-choices');
  const act = (label, attempt, done, cls) => actions.append(btn(doc, label, () => run(ctx, attempt, done), cls));
  act(entry ? 'Add row below' : 'Add row', () => ops.addEntry(ctx.document, block.id, entry?.id ?? null, ctx.createId), 'Row added.');
  if (!entry) { nodes.push(el(doc, 'p', 'Select a row on the slide to move or delete it.', 'builder-slide-note'), actions); return nodes; }
  nodes.push(el(doc, 'p', `Row ${index + 1}`, 'builder-slide-note'));
  if (block.type === 'values') {
    // A unit is written here; once it has text it is also edited where the slide draws it.
    const unit = el(doc, 'textarea'); unit.rows = 1; unit.value = entry.unit ?? ''; unit.placeholder = 'Optional'; unit.dataset.controlKey = `slide:${block.id}:unit-tools:${entry.id}`;
    unit.addEventListener('change', () => run(ctx, () => ops.setEntry(ctx.document, block.id, entry.id, 'unit', unit.value), unit.value ? 'Unit updated.' : 'Unit removed.'));
    nodes.push(labelled(doc, 'Unit', unit));
  }
  if (index > 0) act('Move row up', () => ops.moveEntry(ctx.document, block.id, entry.id, -1), 'Row moved up.');
  if (index < list.length - 1) act('Move row down', () => ops.moveEntry(ctx.document, block.id, entry.id, 1), 'Row moved down.');
  if (list.length > 1) act('Delete row', confirmed => ops.removeEntry(ctx.document, block.id, entry.id, { confirmed }), 'Row deleted. Undo restores it.', 'builder-btn builder-danger');
  nodes.push(actions);
  return nodes;
}

// A unit follows its value on the same line, as the slide draws it.
function withUnit(doc, input, unit) {
  if (!unit) return [input];
  const line = el(doc, 'span', null, 'builder-cell-unit'); line.append(input, el(doc, 'span', unit, 'slide-unit'));
  return [line];
}

// ── inspector ───────────────────────────────────────────────────────────────────────
/**
 * The one contextual inspector (CASE-344): with nothing selected it is the slide's (Add a block, the reveal order as one
 * drag list, layout and fill folded); with a block selected it is that block's. Null when the selection has no slide (the
 * studio keeps its own text).
 */
export function slideInspector(ctx) {
  const { doc, document } = ctx;
  // A fixed-layout draft's upgrade review is the workspace shell's (it measures the result before applying it).
  if (document?.schema_version !== 3) return null;
  const composition = slideOf(ctx);
  if (!composition) return null;
  const nodes = [];
  if (ctx.state.review) {
    const review = el(doc, 'section', null, 'builder-slide-review'); review.setAttribute('role', 'group'); review.setAttribute('aria-label', 'Review change'); review.tabIndex = -1; review.dataset.controlKey = 'slide-review';
    review.append(el(doc, 'p', ctx.state.review.reason), ...(ctx.state.review.preview ? [el(doc, 'pre', ctx.state.review.preview, 'builder-turn-preview')] : []), btn(doc, 'Confirm', () => confirmReview(ctx), /remov|delet/i.test(ctx.state.review.label ?? '') ? 'builder-btn builder-danger' : 'builder-btn builder-confirm'), btn(doc, 'Cancel', () => { ctx.state.review = null; ctx.status('Not changed.'); ctx.rerender(); }));
    nodes.push(review);
  }
  const block = byId(document.blocks, ctx.state.blockId);
  nodes.push(...(block ? blockPanel(ctx, composition, block) : slidePanel(ctx, composition)));
  wantedField(ctx);
  return nodes;
}

/** A field a new block asked to focus (a blood gas opens in pH) takes the caret once the inspector has drawn it. */
function wantedField(ctx) {
  const want = ctx.state.pendingField; if (!want) return;
  ctx.doc.defaultView.requestAnimationFrame(() => {
    if (ctx.state.pendingField !== want) return;
    const field = [...ctx.doc.querySelectorAll('[data-control-key]')].find(node => node.dataset.controlKey.startsWith(want.prefix));
    if (field && field.offsetParent !== null) { ctx.state.pendingField = null; field.focus({ preventScroll: true }); field.select?.(); }
  });
}

/** What a slide is called in lists: its stage, consequence or clarification, with its kind. */
function slideName(document, composition) {
  const { owner } = composition;
  if (owner.kind === 'beat') { const beat = byId(document.beats, owner.id); return { name: beat?.title || 'Untitled stage', kind: beat?.kind === 'decision' ? 'Decision' : beat?.kind === 'debrief' ? 'Debrief' : 'Teaching stage' }; }
  if (owner.kind === 'path') return { name: (document.decisions ?? []).flatMap(item => item.paths ?? []).find(path => path.id === owner.id)?.label || 'Untitled consequence', kind: 'Consequence' };
  return { name: byId(document.clarifications, owner.id)?.label || 'Untitled clarification', kind: 'Clarification' };
}

const PALETTE = [['text', 'Text', 'Heading, list, paragraph'], ['callout', 'Callout', 'Tone and icon'], ['table', 'Table', 'Starters or blank'], ['values', 'Values', 'Name, value, unit'],
  ['trend', 'Chart', 'Trend over time'], ['gas', 'Blood gas', 'Arterial or venous'], ['image', 'Image', 'Image, ECG, GIF, video']];

/** Nothing selected (CASE-344): the slide itself. */
function slidePanel(ctx, composition) {
  const { doc, document } = ctx, nodes = [], here = slideName(document, composition);
  nodes.push(el(doc, 'h3', here.name, 'builder-inspector-title'), el(doc, 'p', `Nothing selected · ${here.kind.toLowerCase()}`, 'builder-slide-note'));
  const add = el(doc, 'section', null, 'builder-inspector-section');
  const palette = el(doc, 'div', null, 'builder-palette'); palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', 'Add block');
  palette.append(...paletteChoices(ctx, composition));
  add.append(el(doc, 'h4', 'Add a block', 'builder-inspector-group'), palette, el(doc, 'p', 'Or click + in any empty space on the slide and type. / turns it into any kind.', 'builder-slide-note'));
  nodes.push(add);
  const order = el(doc, 'section', null, 'builder-inspector-section'); order.append(el(doc, 'h4', 'Reveal order · drag to change', 'builder-inspector-group'), ...orderTab(ctx, composition));
  nodes.push(order);
  const layout = el(doc, 'details', null, 'builder-exact builder-layout-fold'); layout.open = Boolean(ctx.state.layoutOpen);
  layout.addEventListener('toggle', () => { ctx.state.layoutOpen = layout.open; });
  layout.append(el(doc, 'summary', 'Layout and fill (optional)'), ...layoutTab(ctx, composition));
  nodes.push(layout);
  return nodes;
}

function layoutTab(ctx, composition) {
  const { doc, document } = ctx, nodes = [];
  const gallery = el(doc, 'div', null, 'builder-template-gallery'); gallery.setAttribute('role', 'group'); gallery.setAttribute('aria-label', 'Layouts');
  for (const [name, label] of Object.entries(TEMPLATE_NAMES)) {
    const choice = btn(doc, '', () => run(ctx, () => ops.applyTemplate(ctx.document, composition.id, name), `${label} layout applied. Blocks that do not fit stay unplaced with their content.`), 'builder-template-option');
    choice.setAttribute('aria-label', label); choice.setAttribute('aria-pressed', String(composition.template === name)); choice.dataset.controlKey = `slide-template:${name}`;
    // A drawn miniature of the template's own slots: the picture is the template, not a decoration.
    const preview = el(doc, 'span', null, 'builder-template-preview'); preview.setAttribute('aria-hidden', 'true');
    for (const [, col, row, w, h] of ops.TEMPLATES[name]) { const slot = el(doc, 'i'); slot.style.gridArea = `${row} / ${col} / span ${h} / span ${w}`; preview.append(slot); }
    choice.append(preview, el(doc, 'span', label));
    gallery.append(choice);
  }
  nodes.push(gallery, el(doc, 'p', 'A layout moves blocks only. Text, reveal steps and reading order stay as they are.', 'builder-slide-note'));
  nodes.push(...heroControls(ctx, composition));
  // The case's presentation theme (CASE-227): each tile is drawn in its own theme's tokens, so the picture is the theme.
  const current = document.theme ?? 'case', themes = el(doc, 'div', null, 'builder-theme-gallery');
  themes.setAttribute('role', 'group'); themes.setAttribute('aria-label', 'Theme for every slide');
  for (const [name, label] of Object.entries(SLIDE_THEMES)) {
    const choice = btn(doc, '', () => run(ctx, () => ops.setTheme(ctx.document, name), `${label} theme applied to every slide.`), 'builder-template-option builder-theme-option');
    choice.setAttribute('aria-label', `${label} theme`); choice.setAttribute('aria-pressed', String(current === name)); choice.dataset.controlKey = `slide-theme:${name}`;
    const preview = el(doc, 'span', null, `builder-theme-preview${name === 'case' ? '' : ` slide-theme-${name}`}`); preview.setAttribute('aria-hidden', 'true');
    preview.append(el(doc, 'b', 'Aa'), ...['blue', 'teal', 'amber'].map(tone => el(doc, 'i', null, `slide-tone-${tone}`)));
    choice.append(preview, el(doc, 'span', label));
    themes.append(choice);
  }
  nodes.push(el(doc, 'h3', 'Theme', 'builder-inspector-subhead'), themes, el(doc, 'p', 'A theme sets the colours of every slide on the projector and phones. Case follows the room’s light or dark.', 'builder-slide-note'));
  // A whole-slide fill (CASE-312): this slide's ground from the block palette, in the room's light or dark and the theme.
  const filled = el(doc, 'div', null, 'builder-swatches'); filled.setAttribute('role', 'group'); filled.setAttribute('aria-label', 'Slide fill');
  for (const name of ['plain', ...SLIDE_FILLS]) {
    const swatch = btn(doc, '', () => run(ctx, () => ops.setFill(ctx.document, composition.id, name === 'plain' ? null : name), name === 'plain' ? 'Slide fill removed.' : `Slide fill: ${TONE_NAMES[name]}.`), `builder-swatch slide-tone-${name}`);
    swatch.setAttribute('aria-label', name === 'plain' ? 'No fill' : TONE_NAMES[name]); swatch.title = `Slide fill: ${name === 'plain' ? 'None' : TONE_NAMES[name]}`;
    swatch.setAttribute('aria-pressed', String((composition.fill ?? 'plain') === name)); swatch.dataset.controlKey = `slide-fill:${name}`;
    filled.append(swatch);
  }
  nodes.push(el(doc, 'h3', 'Slide fill', 'builder-inspector-subhead'), filled, el(doc, 'p', 'Fills this slide on the projector, phones and here, in light or dark. Text on a filled slide stays plain so it keeps full contrast.', 'builder-slide-note'));
  return nodes;
}

/**
 * D23 hero (CASE-264): one block, or a title and one block, is shown large. The author can turn that off for this slide
 * or centre the block in the space; both are stored only when not the default (on, top).
 */
function heroControls(ctx, composition) {
  const { doc, document } = ctx;
  const one = slideHero({ ...composition, hero: undefined }, id => byId(document.blocks, id));
  const nodes = [el(doc, 'h3', 'Only block', 'builder-inspector-subhead')];
  if (!one) {
    nodes.push(el(doc, 'p', 'A slide with one block, or a title and one block, shows that block large. This slide has more, so its blocks stay where they are placed.', 'builder-slide-note'));
    return nodes;
  }
  const on = composition.hero !== 'off';
  const label = el(doc, 'label', null, 'builder-slide-check'), box = doc.createElement('input');
  box.type = 'checkbox'; box.checked = on; box.dataset.controlKey = 'slide-hero';
  box.addEventListener('change', () => run(ctx, () => ops.setHero(ctx.document, composition.id, box.checked ? null : 'off'),
    box.checked ? 'The only block is shown large.' : 'The only block keeps its placed size and position.'));
  label.append(box, el(doc, 'span', 'Enlarge the only block'));
  nodes.push(label);
  if (on) {
    const position = el(doc, 'div', null, 'builder-slide-choices'); position.setAttribute('role', 'group'); position.setAttribute('aria-label', 'Position');
    for (const [value, text] of [[null, 'Top'], ['centred', 'Centred']]) {
      const choice = btn(doc, text, () => run(ctx, () => ops.setHero(ctx.document, composition.id, value), value ? 'The block is centred in the space under the title.' : 'The block sits at the top, under the title.'), 'builder-btn');
      choice.setAttribute('aria-pressed', String((composition.hero ?? null) === value)); choice.dataset.controlKey = `slide-hero:${value ?? 'top'}`;
      position.append(choice);
    }
    nodes.push(position, el(doc, 'p', 'Shown large, across the slide. Its placement is kept and used again when another block is added.', 'builder-slide-note'));
  } else nodes.push(el(doc, 'p', 'Drawn at its placed size and position.', 'builder-slide-note'));
  return nodes;
}

/**
 * The selected slide's issues, for their one home under the canvas (CASE-223): blocks that overflow their area
 * (measured), unplaced blocks and the slide validator's findings. An item with a block id selects that block.
 */
/** The first problem with one block alone (text limits, safe characters): the per-key check while typing. */
export function blockProblem(block) {
  return validateSlideParts({ schema_version: 3, blocks: [block], compositions: [] }).errors?.[0]?.message ?? null;
}

export function slideIssues(ctx) {
  const { document } = ctx, composition = document?.schema_version === 3 ? slideOf(ctx) : null;
  if (!composition) return [];
  const result = validateSlideParts(document, {}), here = `/compositions/${document.compositions.indexOf(composition)}`;
  // Plain words, naming the block where the issue has one (gap audit #27); anything unmapped keeps the validator's text.
  const named = issue => { const row = /\/placements\/(\d+)/.exec(issue.at.slice(here.length)); const id = row ? composition.placements[Number(row[1])]?.block_id : null;
    return id ? { blockId: id, label: blockLabel(byId(document.blocks, id), document.decisions) } : {}; };
  const words = { placement_overlap: ({ label }) => `${label ?? 'A block'} overlaps another block. Move or resize one of them.`,
    empty_entry: () => 'Nothing shows when this slide opens. Put at least one block in On entry (Reveal order).',
    reading_order: () => 'The reading order no longer matches the slide’s blocks. Open Reading order under Reveal order to put it right.',
    question_missing: () => 'This decision’s question is not on its slide. Add it back with Add a block → Question.' };
  const issues = [...result.errors, ...result.warnings].filter(issue => issue.at.startsWith(here)).map(issue => { const block = named(issue);
    return { ...(block.blockId ? { blockId: block.blockId } : {}), text: words[issue.code]?.(block) ?? issue.message }; });
  for (const id of ctx.state.overflow ?? []) if (composition.reading_order.includes(id)) issues.unshift({ blockId: id, overflow: true, text: `${blockLabel(byId(document.blocks, id), document.decisions)} does not fit its area; the room sees “More on your phone”.` });
  const unplaced = composition.reading_order.length - composition.placements.length;
  if (unplaced > 0) issues.push({ text: `${unplaced} ${unplaced === 1 ? 'block is' : 'blocks are'} not placed on the slide.` });
  return issues;
}

/** A whole-slide miniature for the Outline: every block of the selection's composition, drawn by the slide renderer. */
export function slideThumbnail(doc, document, selection) {
  const composition = document?.schema_version === 3 ? compositionFor(document, selection) : null;
  if (!composition) return null;
  const blocks = new Map(document.blocks.map(block => [block.id, block]));
  const plan = slidePlan({ blocks: composition.reading_order.map(id => blocks.get(id)).filter(Boolean), composition }, { layout: 'grid', hero: slideHero(composition, id => blocks.get(id)) });
  const root = applySlideTheme(buildSlide(doc, plan).root, document.theme);
  // CASE-344: a slide showing a synced block carries a small mark in the Outline.
  if (syncedSlides(document).has(composition.id)) { const mark = el(doc, 'span', '⟳', 'builder-thumb-sync'); mark.title = 'Shows a synced block'; root.append(mark); }
  return root;
}
/** The ids of the slides that show a block another slide shows too. */
export function syncedSlides(document) {
  const uses = new Map();
  for (const composition of document?.compositions ?? []) for (const id of composition.reading_order ?? []) uses.set(id, (uses.get(id) ?? 0) + 1);
  return new Set((document?.compositions ?? []).filter(composition => (composition.reading_order ?? []).some(id => uses.get(id) > 1)).map(composition => composition.id));
}

/** The seven blocks of the Add a block palette (variants live in each block's own panel); Question when its slide lacks it. */
function paletteChoices(ctx, composition) {
  const { doc } = ctx;
  const adding = (kind, name, hint, options) => {
    const button = btn(doc, '', () => {
      if (kind === 'image') { addImage(ctx, composition, null); return; }
      const result = ops.addBlock(ctx.document, composition.id, kind, ctx.createId, options);
      // The new block opens ready to write: its starter text selected, a table's first cell focused, a blood gas in pH.
      if (result.ok) { ctx.state.blockId = result.blockId; ctx.state.pendingCaret = 'all'; ctx.showSlide?.(); if (kind === 'gas') ctx.state.pendingField = { blockId: result.blockId, prefix: `slide:${result.blockId}:gas:cell:` }; }
      run(ctx, () => result, result.unplaced ? `${name} added. The slide is full, so it waits under Unplaced until a block is made smaller.` : `${name} added as a new reveal step.`);
    }, 'builder-palette-item');
    button.setAttribute('aria-label', name); button.title = hint; button.dataset.controlKey = `slide-palette:${kind}`;
    button.append(el(doc, 'span', name, 'builder-palette-name'), el(doc, 'small', hint));
    return button;
  };
  const choices = PALETTE.map(([kind, name, hint]) => adding(kind, name, hint));
  // A decision's slide without its question offers it back; a clarification's slide can place the question of its stage (D15).
  const clarification = composition.owner?.kind === 'clarification';
  const owner = composition.owner?.kind === 'beat' ? byId(ctx.document.beats, composition.owner.id) : null;
  const decisionId = clarification ? clarificationDecision(ctx.document, composition.owner.id) : owner?.kind === 'decision' ? owner.decision_id : null;
  const shown = decisionId && composition.reading_order.some(id => { const block = byId(ctx.document.blocks, id); return block?.type === 'question' && block.decision_id === decisionId; });
  if (decisionId && !shown) choices.push(adding('question', 'Question', 'This stage’s question', { decisionId }));
  return choices;
}

const PANEL_NAMES = { text: 'Text', list: 'Text', quote: 'Callout', callout: 'Callout', values: 'Values', timeline: 'Values', table: 'Table', trend: 'Chart', gas: 'Blood gas', image: 'Image', question: 'Question' };
const ICON_NAMES = { none: 'No icon', info: 'Information', alert: 'Alert', stop: 'Stop', check: 'Tick', pulse: 'Pulse', clock: 'Clock', pill: 'Pill', syringe: 'Syringe', stethoscope: 'Stethoscope', bulb: 'Idea', phone: 'Phone', users: 'People', quote: 'Quote' };
const CALLOUT_TONE_CHOICES = [['plain', 'Plain'], ['blue', 'Note'], ['amber', 'Warning'], ['coral', 'Danger'], ['green', 'Good']];
const FILL_CHOICES = [['plain', 'None'], ['soft', 'Soft'], ['blue', 'Blue'], ['amber', 'Amber'], ['coral', 'Coral']];

/** A Lucide icon drawn as strokes into a decorative svg; the geometry is its own lazy chunk, so it paints when it arrives. */
function iconSvg(doc, key, cls = 'builder-icon') {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', cls);
  if (key !== 'none') slideIcons().then(module => { for (const [tag, attrs] of module?.iconNodes(key) ?? []) { const child = doc.createElementNS(svg.namespaceURI, tag); for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value); svg.append(child); } });
  else { const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M5 12h14'); path.setAttribute('stroke-dasharray', '2 3'); svg.append(path); }
  return svg;
}

/** A block is selected (CASE-344): its kind, where else it is shown, its variants and colour, then the rest folded. */
function blockPanel(ctx, composition, block) {
  const { doc, document, state } = ctx, uses = document.compositions.filter(item => item.reading_order.includes(block.id));
  const nodes = [], back = btn(doc, '← This slide', () => { state.blockId = null; ctx.rerender(); }, 'builder-quiet-link builder-back-to-slide'); back.dataset.controlKey = 'slide-panel-back';
  nodes.push(back, el(doc, 'h3', PANEL_NAMES[block.type] ?? 'Block', 'builder-inspector-title'), el(doc, 'p', uses.length > 1 ? `Synced · on ${uses.length} slides` : 'On this slide', 'builder-slide-note'));
  if (block.type === 'question') {
    // The question's settings live once, in Response and consequences; this panel says what it is and takes you there
    // (BWR05: options belong near the selected decision; one editor per field).
    const decision = (document.decisions ?? []).find(item => item.id === block.decision_id);
    const type = { single_choice: 'Single choice', multi_select: 'Multiple choice', ranking: 'Ranking', free_text: 'Free text' }[decision?.interaction?.type] ?? 'Question';
    const options = decision?.interaction?.options?.length ?? 0;
    const summary = el(doc, 'div', null, 'builder-question-summary');
    summary.append(el(doc, 'p', `${type}${decision?.interaction?.type === 'free_text' ? '' : ` · ${options} ${options === 1 ? 'option' : 'options'}`} · ${(decision?.paths ?? []).length} consequences`),
      el(doc, 'p', decision?.prompt && typeof decision.prompt === 'string' ? decision.prompt : 'The question to the room is written on the slide.', 'builder-slide-note'));
    const open = btn(doc, 'Edit question and options', () => ctx.openResponse?.(), 'builder-btn');
    open.dataset.controlKey = `slide:${block.id}:question-settings`;
    summary.append(open); nodes.push(summary);
  }
  const style = composition.styles?.find(item => item.block_id === block.id) ?? {};
  // ── variants and content tools ──
  if (block.type === 'text' || block.type === 'list') nodes.push(textVariants(ctx, block));
  if (block.type === 'values' || block.type === 'timeline') nodes.push(variantChoice(ctx, block, 'Layout', 'layout', [['values', 'Values'], ['timeline', 'Timeline']], block.type, value => confirmed => ops.turnInto(ctx.document, block.id, value, { confirmed, createId: ctx.createId }), 'Layout'));
  if (block.type === 'callout' || block.type === 'quote') nodes.push(...calloutTools(ctx, composition, block, style));
  // A chart's readings and an image's text come first: they are the block's content (card 59).
  if (block.type === 'trend') nodes.push(...trendTools(ctx, block));
  if (block.type === 'gas') nodes.push(...gasTools(ctx, block));
  if (block.type === 'image') nodes.push(...imageTools(ctx, block));
  // ── shown on other slides ──
  if (block.type !== 'question') nodes.push(syncSection(ctx, composition, block, uses));
  // ── reveal and colour ──
  const reveal = el(doc, 'select'); reveal.setAttribute('aria-label', 'Reveal'); reveal.dataset.controlKey = `slide:${block.id}:reveal`;
  composition.steps.forEach((step, at) => { const option = el(doc, 'option', at ? `Step ${at}` : 'On entry'); option.value = step.id; reveal.append(option); });
  const own = el(doc, 'option', 'A new last step'); own.value = 'new'; reveal.append(own);
  reveal.value = composition.steps.find(step => step.block_ids.includes(block.id))?.id ?? 'new';
  reveal.addEventListener('change', () => run(ctx, () => ops.moveBlockToStep(ctx.document, composition.id, block.id, reveal.value, ctx.createId), 'Reveal step changed. The block stays where it is on the slide.'));
  nodes.push(labelled(doc, 'Appears', reveal));
  if (block.type !== 'callout' && block.type !== 'quote') {
    const fill = style.tone ?? (style.background === 'soft' ? 'soft' : 'plain');
    nodes.push(...tonePicker(ctx, composition, block, style, 'Fill', FILL_CHOICES, fill));
  }
  // ── the rest, folded ──
  const rest = el(doc, 'details', null, 'builder-exact builder-more-format'); rest.open = Boolean(state.moreOpen);
  rest.addEventListener('toggle', () => { state.moreOpen = rest.open; });
  rest.append(el(doc, 'summary', 'More formatting'));
  if (WRITING.includes(block.type) || ['table', 'values', 'timeline'].includes(block.type)) {
    // Writing types convert among themselves and to and from a table; Values and Timeline to and from a table (gap
    // audit #9). Structural conversions are previewed first.
    const convert = el(doc, 'select'); convert.setAttribute('aria-label', 'Turn into'); convert.dataset.controlKey = `slide:${block.id}:turn-into`;
    const targets = block.type === 'values' || block.type === 'timeline' ? [block.type, 'table'] : block.type === 'table' ? [...WRITING, 'table', 'values', 'timeline'] : [...WRITING, 'table'];
    for (const type of targets) { const option = el(doc, 'option', TYPE_NAMES[type]); option.value = type; convert.append(option); }
    convert.value = block.type;
    convert.addEventListener('change', () => run(ctx, confirmed => ops.turnInto(ctx.document, block.id, convert.value, { confirmed, createId: ctx.createId }), `Turned into ${TYPE_NAMES[convert.value].toLowerCase()}. Every word is kept.`));
    rest.append(labelled(doc, 'Turn into', convert));
  }
  if (block.type === 'text') {
    // Block-wide text style; single lines are restyled from the canvas toolbar.
    const textStyle = el(doc, 'select'); textStyle.setAttribute('aria-label', 'Whole-block text style'); textStyle.dataset.controlKey = `slide:${block.id}:block-style`;
    const styles = [...new Set(block.paragraphs.map(item => item.style))];
    if (styles.length > 1) { const mixed = el(doc, 'option', 'Mixed'); mixed.value = ''; mixed.disabled = true; textStyle.append(mixed); }
    for (const name of PARAGRAPH_STYLES) { const option = el(doc, 'option', STYLE_NAMES[name]); option.value = name; textStyle.append(option); }
    textStyle.value = styles.length > 1 ? '' : styles[0];
    textStyle.addEventListener('change', () => run(ctx, () => ops.setParagraphs(ctx.document, block.id, byId(ctx.document.blocks, block.id).paragraphs.map(item => ({ ...item, style: textStyle.value }))), 'Text style changed.'));
    rest.append(labelled(doc, 'Whole-block text style', textStyle));
  }
  const DEFAULTS = { align: 'start', padding: 'none', background: 'plain', banded: false, density: 'normal', text_size: 'normal' };
  const segmented = (label, key, options) => {
    const group = el(doc, 'div', null, 'builder-segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, name] of options) {
      const choice = btn(doc, name, () => run(ctx, () => ops.setBlockStyle(ctx.document, composition.id, block.id, key, value), `${label}: ${name}.`), 'builder-segment');
      choice.setAttribute('aria-pressed', String((style[key] ?? DEFAULTS[key]) === value)); choice.dataset.controlKey = `slide:${block.id}:${key}:${value}`;
      group.append(choice);
    }
    return [el(doc, 'h3', label, 'builder-inspector-group'), group];
  };
  // A text colour shows only on a plain ground (CASE-244): on a fill, banded rows or a callout the text stays plain, so
  // it keeps 7:1 in every theme. A colour already chosen is kept and returns when the ground is plain again.
  const fill = style.tone ?? (style.background === 'soft' ? 'soft' : 'plain');
  const plainOnly = inkShows(style, block.type, Boolean(composition.fill)) ? '' : `Text stays plain on ${block.type === 'callout' ? 'a callout' : composition.fill && !style.tone ? 'a filled slide' : style.banded && fill === 'plain' ? 'banded rows' : 'a fill'}, so it reads at full contrast.${style.ink ? ` ${TONE_NAMES[style.ink]} returns on a plain ground.` : ''}`;
  rest.append(...swatchGroup(ctx, composition, block, 'Text colour', 'ink', ['plain', ...INK_TONES], style.ink ?? 'plain', name => ops.setBlockStyle(ctx.document, composition.id, block.id, 'ink', name), 'builder-ink slide-ink', plainOnly));
  const border = el(doc, 'div', null, 'builder-segmented'); border.setAttribute('role', 'group'); border.setAttribute('aria-label', 'Border');
  for (const [value, name] of [['plain', 'None'], ['outline', 'Outline']]) {
    const choice = btn(doc, name, () => run(ctx, () => ops.setBlockStyle(ctx.document, composition.id, block.id, 'background', value), `Border: ${name}.`), 'builder-segment');
    choice.setAttribute('aria-pressed', String((style.background === 'outline' ? 'outline' : 'plain') === value)); choice.dataset.controlKey = `slide:${block.id}:border:${value}`;
    border.append(choice);
  }
  rest.append(el(doc, 'h3', 'Border', 'builder-inspector-group'), border);
  rest.append(...segmented('Alignment', 'align', [['start', 'Left'], ['center', 'Centre'], ['end', 'Right']]), ...segmented('Spacing', 'padding', [['none', 'None'], ['normal', 'Normal'], ['roomy', 'Roomy']]));
  if (block.type === 'table') rest.append(...segmented('Rows', 'banded', [[false, 'Plain'], [true, 'Banded']]), ...segmented('Density', 'density', [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']]),
    ...segmented('Text size', 'text_size', [['normal', 'Normal'], ['large', 'Large']]));
  const placement = composition.placements.find(item => item.block_id === block.id);
  if (placement) {
    rest.append(el(doc, 'p', 'Move or resize with the handles on the slide, or focus a handle and use the arrow keys.', 'builder-slide-note'));
    // The numbers stay available for exact placement, folded away so they never interrupt writing.
    const exact = el(doc, 'details', null, 'builder-exact'); exact.open = Boolean(state.exactOpen);
    exact.addEventListener('toggle', () => { state.exactOpen = exact.open; });
    exact.append(el(doc, 'summary', 'Exact position'));
    const fields = {}, grid = el(doc, 'div', null, 'builder-slide-placement');
    for (const [key, name] of [['col', 'Column'], ['row', 'Row'], ['w', 'Width'], ['h', 'Height']]) {
      const input = el(doc, 'input'); input.type = 'number'; input.min = '1'; input.max = '12'; input.value = String(placement[key]);
      input.setAttribute('aria-label', name); input.dataset.controlKey = `slide:${block.id}:place:${key}`;
      fields[key] = input; grid.append(labelled(doc, name, input));
    }
    grid.append(btn(doc, 'Apply', () => run(ctx, () => ops.setPlacement(ctx.document, composition.id, block.id, Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, Number(input.value)]))), 'Block moved. Its reveal step and reading position are unchanged.'), 'builder-btn builder-apply'));
    exact.append(grid);
    rest.append(exact);
  } else nodes.push(el(doc, 'p', 'This block is unplaced. Its content is kept.'), btn(doc, 'Place on slide', () => run(ctx, () => ops.placeBlock(ctx.document, composition.id, block.id), 'Block placed.')));
  nodes.push(rest);
  if (block.type === 'table') { const tools = el(doc, 'div'); tools.dataset.tableTools = block.id; tools.style.display = 'contents'; tools.append(...tableTools(ctx, block)); nodes.push(tools); }
  if (block.type === 'values' || block.type === 'timeline') { const tools = el(doc, 'div'); tools.dataset.entryTools = block.id; tools.style.display = 'contents'; tools.append(...entryTools(ctx, block)); nodes.push(tools); }
  const actions = el(doc, 'div', null, 'builder-block-actions');
  if (block.type !== 'question') actions.append(btn(doc, 'Duplicate', () => {
    const result = ops.duplicateBlock(ctx.document, composition.id, block.id, ctx.createId);
    if (result.ok) ctx.state.blockId = result.blockId;
    run(ctx, () => result, 'Block duplicated as an independent copy and its own reveal step.');
  }));
  if (placement) actions.append(btn(doc, 'Unplace', () => run(ctx, () => ops.unplaceBlock(ctx.document, composition.id, block.id), 'Block unplaced. Its content is kept in the draft, listed under the slide.')));
  if (actions.childElementCount) nodes.push(actions);
  if (block.type !== 'question') nodes.push(btn(doc, uses.length > 1 ? 'Remove from this slide' : 'Delete', () => requestRemoveBlock(ctx), 'builder-btn builder-danger'));
  return nodes;
}

/** Text's variants (CASE-344): Heading, Paragraph, Bulleted and Numbered, over the text and list blocks beneath them. */
function textVariants(ctx, block) {
  const heading = block.type === 'text' && block.paragraphs.length > 0 && block.paragraphs.every(item => /^h[1-4]$/.test(item.style ?? ''));
  const current = block.type === 'list' ? (block.ordered ? 'numbered' : 'bulleted') : heading ? 'heading' : 'paragraph';
  const restyle = (document, style) => ops.setParagraphs(document, block.id, byId(document.blocks, block.id).paragraphs.map(item => ({ ...item, style })));
  const to = {
    heading: confirmed => block.type === 'text' ? restyle(ctx.document, 'h2') : chain(ops.turnInto(ctx.document, block.id, 'text', { confirmed, createId: ctx.createId }), next => restyle(next, 'h2')),
    paragraph: confirmed => block.type === 'text' ? restyle(ctx.document, 'p') : ops.turnInto(ctx.document, block.id, 'text', { confirmed, createId: ctx.createId }),
    bulleted: confirmed => block.type === 'list' ? ops.setListOrdered(ctx.document, block.id, false) : ops.turnInto(ctx.document, block.id, 'list', { confirmed, createId: ctx.createId }),
    numbered: confirmed => block.type === 'list' ? ops.setListOrdered(ctx.document, block.id, true) : chain(ops.turnInto(ctx.document, block.id, 'list', { confirmed, createId: ctx.createId }), next => ops.setListOrdered(next, block.id, true)),
  };
  return variantChoice(ctx, block, 'Style', 'style', [['heading', 'Heading'], ['paragraph', 'Paragraph'], ['bulleted', 'Bulleted'], ['numbered', 'Numbered']], current, value => to[value], 'Style');
}
/** The result of an operation carried into the next one on its document, or the refusal as it stands. */
const chain = (result, next) => (result.ok ? next(result.document) : result);

/** A labelled row of choices, one pressed: `attempt(value)` returns the (confirmed) => result the choice runs. */
function variantChoice(ctx, block, label, key, options, current, attempt, said) {
  const { doc } = ctx, group = el(doc, 'div', null, 'builder-segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
  for (const [value, name] of options) {
    const choice = btn(doc, name, () => { if (value !== current) run(ctx, attempt(value), `${said}: ${name}.`); }, 'builder-segment');
    choice.setAttribute('aria-pressed', String(current === value)); choice.dataset.controlKey = `slide:${block.id}:${key}:${value}`;
    group.append(choice);
  }
  const wrap = el(doc, 'div', null, 'builder-variants'); wrap.append(el(doc, 'h3', label, 'builder-inspector-group'), group);
  return wrap;
}

/** Five tones, then every colour under More colours (CASE-344); the text colour follows the fill so it always reads. */
function tonePicker(ctx, composition, block, style, label, choices, current) {
  const { doc } = ctx, group = el(doc, 'div', null, 'builder-segmented builder-tones'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
  const apply = name => {
    const result = ops.setCalloutTone(ctx.document, composition.id, block.id, name);
    return result.ok && style.background === 'soft' ? ops.setBlockStyle(result.document, composition.id, block.id, 'background', 'plain') : result;
  };
  for (const [value, name] of choices) {
    const choice = btn(doc, name, () => run(ctx, () => apply(value), `${label}: ${name}.`), 'builder-segment');
    choice.setAttribute('aria-pressed', String(current === value)); choice.dataset.controlKey = `slide:${block.id}:tone:${value}`; group.append(choice);
  }
  const more = el(doc, 'details', null, 'builder-exact builder-more-colours'); more.open = Boolean(ctx.state.coloursOpen);
  more.addEventListener('toggle', () => { ctx.state.coloursOpen = more.open; });
  more.append(el(doc, 'summary', 'More colours'), ...swatchGroup(ctx, composition, block, 'More colours', 'more-tone', Object.keys(TONE_NAMES), current, apply, 'slide-tone', ''), el(doc, 'p', 'Text colour follows the fill, so it always reads.', 'builder-slide-note'));
  const wrap = el(doc, 'div', null, 'builder-variants'); wrap.append(el(doc, 'h3', label, 'builder-inspector-group'), group, more);
  return [wrap];
}

/** Labelled swatches from the slide palette (BWR20: the name says the colour; colour carries no clinical meaning). */
function swatchGroup(ctx, composition, block, label, key, names, current, apply, look = 'slide-tone', off = '') {
  const { doc } = ctx, group = el(doc, 'div', null, 'builder-swatches'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
  for (const name of names) {
    // A compact swatch named by its accessible label and tooltip (polish round 17); text colours show a sample.
    const swatch = btn(doc, '', () => run(ctx, () => apply(name), `${label}: ${TONE_NAMES[name]}.`), `builder-swatch ${look}-${name}`);
    swatch.setAttribute('aria-label', TONE_NAMES[name]); swatch.title = `${label}: ${TONE_NAMES[name]}`;
    if (key === 'ink') { const sample = el(doc, 'span', 'Aa', 'builder-swatch-sample'); sample.setAttribute('aria-hidden', 'true'); swatch.append(sample); }
    swatch.setAttribute('aria-pressed', String(current === name)); swatch.dataset.controlKey = `slide:${block.id}:${key}:${name}`;
    if (off && name !== 'plain') swatch.disabled = true;
    group.append(swatch);
  }
  return [el(doc, 'h3', label, 'builder-inspector-group'), group, ...(off ? [el(doc, 'p', off, 'builder-slide-note')] : [])];
}

/** A callout's tone (Plain, Note, Warning, Danger, Good) and icon; its words sit centred on the slide (CASE-344). */
function calloutTools(ctx, composition, block, style) {
  const { doc } = ctx, tone = style.tone ?? (style.background === 'soft' ? 'soft' : 'plain');
  const nodes = [...tonePicker(ctx, composition, block, style, 'Tone', CALLOUT_TONE_CHOICES, tone)];
  const icons = el(doc, 'div', null, 'builder-icons'); icons.setAttribute('role', 'group'); icons.setAttribute('aria-label', 'Icon');
  const chosen = block.type === 'quote' ? null : block.icon ?? 'none';
  for (const key of CALLOUT_ICONS) {
    const choice = btn(doc, '', () => run(ctx, () => ops.setCalloutIcon(ctx.document, block.id, key), key === 'none' ? 'Icon removed.' : `Icon: ${ICON_NAMES[key]}.`), 'builder-icon-choice');
    choice.setAttribute('aria-label', ICON_NAMES[key]); choice.title = ICON_NAMES[key]; choice.setAttribute('aria-pressed', String(chosen === key)); choice.dataset.controlKey = `slide:${block.id}:icon:${key}`;
    choice.append(iconSvg(doc, key)); icons.append(choice);
  }
  nodes.push(el(doc, 'h3', 'Icon', 'builder-inspector-group'), icons, el(doc, 'p', 'Text fills the callout and sits centred; a long callout shrinks to fit.', 'builder-slide-note'));
  return nodes;
}

/** Where else a block is shown (CASE-344): the picker, the slides it is also on, and Unsync this slide. */
function syncSection(ctx, composition, block, uses) {
  const { doc, document } = ctx, synced = uses.length > 1;
  const box = el(doc, 'section', null, synced ? 'builder-sync builder-syncbox' : 'builder-sync');
  const pick = btn(doc, 'Show on other slides…', () => openSyncPicker(ctx, composition, block), 'builder-btn'); pick.dataset.controlKey = `slide:${block.id}:sync-picker`;
  if (!synced) { box.append(el(doc, 'h3', 'Use on other slides', 'builder-inspector-group'), pick, el(doc, 'p', 'Keeps one copy in step across slides, such as the vitals as they change.', 'builder-slide-note')); return box; }
  box.append(el(doc, 'p', `Synced · editing it here changes it on ${uses.length - 1 === 1 ? 'the other slide' : `all ${uses.length} slides`}.`, 'builder-sync-note'), el(doc, 'h3', 'Also on', 'builder-inspector-group'));
  const chips = el(doc, 'div', null, 'builder-sync-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Also on');
  for (const other of uses.filter(item => item.id !== composition.id)) {
    const here = slideName(document, other), chip = btn(doc, here.name, () => ctx.openSlide?.(other.id, block.id), 'builder-sync-chip');
    chip.title = `Go to this slide: ${here.name}`; chip.dataset.controlKey = `slide:${block.id}:also-on:${other.id}`; chips.append(chip);
  }
  const unsync = btn(doc, 'Unsync this slide', () => {
    const result = ops.unshareBlock(ctx.document, composition.id, block.id, ctx.createId, { metadata: ctx.metadata });
    if (result.ok) ctx.state.blockId = result.blockId;
    run(ctx, () => result, 'This slide now has its own copy. The other slides keep the shared block.');
  }, 'builder-quiet-link');
  unsync.dataset.controlKey = `slide:${block.id}:unsync`;
  const row = el(doc, 'div', null, 'builder-sync-actions'); row.append(pick, unsync);
  box.append(chips, row);
  return box;
}

/** “Show on other slides…”: tick the slides that show this block. Each keeps its own position, size and reveal step. */
function openSyncPicker(ctx, composition, block) {
  const { doc, document } = ctx, dialog = el(doc, 'dialog', null, 'builder-sync-dialog'), form = el(doc, 'form', null, 'builder-sync-form');
  dialog.setAttribute('aria-labelledby', 'builder-sync-title'); form.method = 'dialog';
  const title = el(doc, 'h2', 'Show on other slides'); title.id = 'builder-sync-title';
  const list = el(doc, 'div', null, 'builder-sync-list'), boxes = [];
  const has = new Set(document.compositions.filter(item => item.reading_order.includes(block.id)).map(item => item.id));
  for (const other of document.compositions) {
    const row = el(doc, 'label'), input = el(doc, 'input'), here = slideName(document, other);
    input.type = 'checkbox'; input.value = other.id; input.checked = has.has(other.id); input.disabled = other.id === composition.id; input.dataset.controlKey = `sync-pick:${other.id}`;
    row.append(input, el(doc, 'span', here.name), el(doc, 'small', other.id === composition.id ? 'This slide' : here.kind)); list.append(row); boxes.push(input);
  }
  const cancel = btn(doc, 'Cancel', () => dialog.close(), 'builder-btn'), done = btn(doc, 'Done', () => {
    const want = new Set(boxes.filter(input => input.checked).map(input => input.value)), added = [...want].filter(id => !has.has(id)), removed = [...has].filter(id => id !== composition.id && !want.has(id));
    dialog.close();
    if (!added.length && !removed.length) return;
    run(ctx, () => {
      let next = ctx.document;
      if (added.length) { const result = ops.shareBlock(next, block.id, added, ctx.createId); if (!result.ok) return result; next = result.document; }
      for (const id of removed) { const result = ops.removeBlock(next, id, block.id); if (!result.ok) return result; next = result.document; }
      return { ok: true, document: next };
    }, `${added.length ? `Shown on ${added.length} more ${added.length === 1 ? 'slide' : 'slides'}. ` : ''}${removed.length ? `Removed from ${removed.length} ${removed.length === 1 ? 'slide' : 'slides'}.` : ''}`.trim());
  }, 'builder-btn builder-confirm');
  const actions = el(doc, 'div', null, 'builder-sync-buttons'); actions.append(cancel, done);
  form.append(title, el(doc, 'p', 'Tick a slide to show this block there. Editing it on any slide changes it everywhere it is ticked. Each slide keeps its own position, size and reveal step.', 'builder-slide-note'), list, actions);
  dialog.append(form); dialog.addEventListener('close', () => { dialog.remove(); ctx.doc.querySelector(`[data-control-key="slide:${CSS.escape(block.id)}:sync-picker"]`)?.focus(); }); dialog.addEventListener('cancel', () => {});
  doc.body.append(dialog); dialog.showModal(); boxes.find(input => !input.disabled)?.focus();
}

/** The selected block's reviewed removal (the Remove button and the Delete key); a question block is never removed here. */
export function requestRemoveBlock(ctx) {
  const composition = slideOf(ctx), block = composition && byId(ctx.document.blocks, ctx.state.blockId);
  if (!block || block.type === 'question' || !composition.reading_order.includes(block.id)) return false;
  const uses = ctx.document.compositions.filter(item => item.reading_order.includes(block.id)).length;
  const shared = uses > 1 ? ' The other slides keep it.' : '';
  run(ctx, () => ops.removeBlock(ctx.document, composition.id, block.id), 'Block removed from this slide.', { review: `Remove ${blockLabel(block)} from this slide?${shared} Undo restores it.` });
  return true;
}

// The chart drawn inside a block node, replacing any earlier drawing: a typing commit does not rebuild the canvas, so each
// chart edit redraws the chart where it sits (on the slide, or as a phone reads it in the Unplaced tray).
const TREND_PARTS = ':scope > :is(svg, .slide-trend-legend, .slide-trend-caption, .slide-trend-data)';
function drawTrend(doc, node, block) {
  for (const part of node.querySelectorAll(TREND_PARTS)) part.remove();
  const layout = node.classList.contains('builder-tray-block') ? 'reflow' : 'grid';
  node.append(...buildSlide(doc, slidePlan({ blocks: [block], composition: { reading_order: [block.id], placements: [{ block_id: block.id, col: 1, row: 1, w: 1, h: 1 }] } }, { layout })).root.firstChild.childNodes);
}

/**
 * A trend chart's settings and readings (card 59 M1, CASE-263): axis labels, units and bounds, then one row per point
 * with a field per series. Numbers are typed as text and kept exactly; Readiness names a missing or out-of-axis value.
 * Nothing is calculated, smoothed or interpreted.
 */
function trendTools(ctx, trend) {
  const { doc } = ctx, nodes = [el(doc, 'h3', 'Chart', 'builder-inspector-group')];
  const field = (label, value, key, commit, { number = false } = {}) => {
    const input = el(doc, 'input'); input.type = 'text'; input.value = value; input.setAttribute('aria-label', label); input.dataset.controlKey = key;
    input.size = number ? 6 : 12;
    if (number) { input.inputMode = 'decimal'; input.autocomplete = 'off'; input.spellcheck = false; }
    const send = () => {
      const ok = run(ctx, () => commit(ctx.document, input.value), 'Chart updated.', { quiet: true }) !== false, current = byId(ctx.document.blocks, trend.id);
      input.toggleAttribute('aria-invalid', !ok);
      if (ok && current) for (const node of doc.querySelectorAll(`.slide-block[data-block-id="${CSS.escape(trend.id)}"]`)) drawTrend(doc, node, current);
    };
    input.addEventListener('input', event => { if (!event.isComposing) send(); });
    input.addEventListener('compositionend', send);
    return input;
  };
  const setting = (label, key, number) => labelled(doc, label, field(label, trend[key], `slide:${trend.id}:trend:${key}`, (current, value) => ops.setTrendField(current, trend.id, key, value), { number }));
  const choice = (label, key, options) => {
    const group = el(doc, 'div', null, 'builder-segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, name] of options) {
      const option = btn(doc, name, () => run(ctx, () => ops.setTrendField(ctx.document, trend.id, key, value), `${label}: ${name}.`), 'builder-segment');
      option.setAttribute('aria-pressed', String(trend[key] === value)); option.dataset.controlKey = `slide:${trend.id}:trend:${key}:${value}`;
      group.append(option);
    }
    return [el(doc, 'h3', label, 'builder-inspector-group'), group];
  };
  nodes.push(setting('Caption', 'caption'), el(doc, 'h3', 'Vertical axis', 'builder-inspector-group'), setting('Label', 'y_label'), setting('Unit', 'y_unit'),
    setting('Bottom', 'y_min', true), setting('Top', 'y_max', true), el(doc, 'h3', 'Horizontal axis', 'builder-inspector-group'), setting('Label', 'x_label'), setting('Unit', 'x_unit'),
    ...choice('Spacing', 'scale', [['time', 'By time'], ['category', 'Evenly']]), ...choice('Draw as', 'style', [['line', 'Line'], ['points', 'Points only']]),
    ...choice('Values on the chart', 'values_shown', [[true, 'Shown'], [false, 'Hidden']]));
  // The readings: a row per point (its axis label, its time when spaced by time) and a column per series.
  const timed = trend.scale === 'time', table = el(doc, 'table', null, 'builder-trend-grid'), head = el(doc, 'tr');
  const th = (text, scope = 'col') => { const cell = el(doc, 'th', text); cell.setAttribute('scope', scope); return cell; };
  head.append(th('Point'), ...(timed ? [th(`Time${trend.x_unit ? ` (${trend.x_unit})` : ''}`)] : []));
  trend.series.forEach((series, n) => {
    const cell = el(doc, 'th'); cell.setAttribute('scope', 'col');
    cell.append(field(`Series ${n + 1} name`, series.label, `slide:${trend.id}:series:${series.id}`, (current, value) => ops.setTrendSeriesLabel(current, trend.id, series.id, value)));
    if (trend.series.length > 1) { const remove = btn(doc, '×', () => run(ctx, confirmed => ops.removeTrendSeries(ctx.document, trend.id, series.id, { confirmed }), 'Series deleted. Undo restores it.'), 'builder-trend-remove'); remove.setAttribute('aria-label', `Delete series ${n + 1}`); cell.append(remove); }
    head.append(cell);
  });
  head.append(th('Row'));
  const body = el(doc, 'tbody');
  trend.points.forEach((point, index) => {
    const row = el(doc, 'tr'), cell = control => { const td = el(doc, 'td'); td.append(control); return td; };
    row.append(cell(field(`Point ${index + 1} label`, point.label, `slide:${trend.id}:point:${point.id}:label`, (current, value) => ops.setTrendPoint(current, trend.id, point.id, 'label', value))));
    if (timed) row.append(cell(field(`Point ${index + 1} time`, point.at, `slide:${trend.id}:point:${point.id}:at`, (current, value) => ops.setTrendPoint(current, trend.id, point.id, 'at', value), { number: true })));
    trend.series.forEach((series, n) => row.append(cell(field(`${series.label || `Series ${n + 1}`} at point ${index + 1}`, series.values[index], `slide:${trend.id}:value:${series.id}:${point.id}`, (current, value) => ops.setTrendValue(current, trend.id, series.id, point.id, value), { number: true }))));
    const actions = el(doc, 'td', null, 'builder-trend-row');
    const act = (label, glyph, attempt, done, enabled) => { const button = btn(doc, glyph, () => run(ctx, attempt, done), 'builder-trend-act'); button.setAttribute('aria-label', `${label} ${index + 1}`); button.title = label; button.disabled = !enabled; actions.append(button); };
    act('Move point up', '↑', () => ops.moveTrendPoint(ctx.document, trend.id, point.id, -1), 'Point moved up.', index > 0);
    act('Move point down', '↓', () => ops.moveTrendPoint(ctx.document, trend.id, point.id, 1), 'Point moved down.', index < trend.points.length - 1);
    act('Delete point', '×', confirmed => ops.removeTrendPoint(ctx.document, trend.id, point.id, { confirmed }), 'Point deleted. Undo restores it.', trend.points.length > 2);
    row.append(actions); body.append(row);
  });
  const thead = el(doc, 'thead'); thead.append(head); table.append(thead, body);
  // The grid scrolls sideways inside the panel when it holds several series (no new stylesheet bytes).
  const scroller = el(doc, 'div', null, 'builder-trend-scroll'); scroller.style.overflowX = 'auto'; scroller.append(table);
  const add = el(doc, 'div', null, 'builder-slide-choices');
  add.append(btn(doc, 'Add point', () => run(ctx, () => ops.addTrendPoint(ctx.document, trend.id, null, ctx.createId), 'Point added.')));
  if (trend.series.length < SLIDE_LIMITS.trendSeries) add.append(btn(doc, 'Add series', () => run(ctx, () => ops.addTrendSeries(ctx.document, trend.id, ctx.createId), 'Series added.')));
  nodes.push(el(doc, 'h3', 'Readings', 'builder-inspector-group'), el(doc, 'p', 'Type each number as it should read, such as 7.30. Leave a reading blank for no value; the line is not joined across it.', 'builder-slide-note'), scroller, add);
  return nodes;
}

// The report drawn inside a block node, replacing any earlier drawing: a typing commit does not rebuild the canvas, so each
// edit redraws it where it sits (on the slide, or as a phone reads it in the Unplaced tray).
function drawGas(doc, node, block) {
  for (const part of node.querySelectorAll(':scope > :is(.slide-gas-title, .slide-gas-groups, .slide-gas-compare)')) part.remove();
  const layout = node.classList.contains('builder-tray-block') ? 'reflow' : 'grid';
  node.append(...buildSlide(doc, slidePlan({ blocks: [block], composition: { reading_order: [block.id], placements: [{ block_id: block.id, col: 1, row: 1, w: 1, h: 1 }] } }, { layout })).root.firstChild.childNodes);
}

/**
 * A blood gas report's editor (CASE-311; redesigned with compare mode, CASE-317) is its own lazy chunk, builder-gas.mjs, loaded
 * the first time a gas block is selected; it shares this chunk's commit, review and status path through `kit`.
 */
const gasEditor = { module: null, loading: null };
function gasTools(ctx, gas) {
  if (gasEditor.module) return gasEditor.module.gasTools(ctx, gas, { el, btn, labelled, run, drawGas, sharedNames });
  gasEditor.loading ??= import('./builder-gas.mjs').then(module => { gasEditor.module = module; ctx.rerender(); }, () => { gasEditor.loading = null; ctx.status('The blood gas editor could not load. Select the block again to retry.'); });
  return [el(ctx.doc, 'h3', 'Blood gas', 'builder-inspector-group'), el(ctx.doc, 'p', 'Loading the blood gas editor…', 'builder-slide-note')];
}

/** Choose or upload an image (builder-media.mjs dialog), then add it as its own new reveal step. */
async function addImage(ctx, composition, at, replace = null, file = null, before = null) {
  if (!media.services) { ctx.status('Images are not available in this view.'); return; }
  if (ctx.state.imagePending) return;
  const services = media.services; ctx.state.imagePending = true;
  let chosen;
  try { chosen = await (await mediaModule()).chooseImage(ctx.doc, services, { title: replace ? 'Replace image' : 'Image or ECG', file }); }
  catch { ctx.status('Images could not be loaded. The draft is unchanged.'); return; }
  finally { ctx.state.imagePending = false; }
  if (media.services !== services) return;
  const asset = chosen?.asset;
  if (!asset) return;
  media.rows.set(asset.asset_id, asset); media.urls.delete(asset.asset_id); media.loading.delete(asset.asset_id);
  if (replace?.asset_id === asset.asset_id) { ctx.status('This is the same image. Its existing details are unchanged.'); return; }
  if (replace) { run(ctx, () => ops.setImageField(ctx.document, replace.id, 'asset_id', asset.asset_id), 'Image replaced. Its text alternative and caption are kept.'); return; }
  const result = ops.addBlock(ctx.document, composition.id, 'image', ctx.createId, { at, image: { assetId: asset.asset_id, alt: chosen.alt ?? asset.alt_text, ecg: asset.evidence_kind === 'ecg' } });
  if (result.ok) { before?.(); ctx.state.blockId = result.blockId; ctx.state.pendingCaret = 'all'; ctx.showSlide?.(); }
  run(ctx, () => result, result.unplaced ? 'Image added. The slide is full, so it waits under Unplaced until a block is made smaller.' : 'Image added as a new reveal step.');
}

/** An image block's text alternative, caption, fit and, for an ECG, its calibration, and where it came from. */
function imageTools(ctx, block) {
  const row = media.rows.get(block.asset_id), form = { 'image/gif': 'Animated GIF', 'video/mp4': 'Video' }[row?.media_type];
  const { doc } = ctx, nodes = [el(doc, 'h3', block.ecg ? 'ECG' : form ?? 'Image', 'builder-inspector-group')];
  if (!row) nodes.push(el(doc, 'p', 'Checking the image…', 'builder-slide-note'));
  const text = (label, key, max, rows) => {
    const input = el(doc, 'textarea'); input.rows = rows; input.maxLength = max; input.value = block[key]; input.setAttribute('aria-label', label); input.dataset.controlKey = `slide:${block.id}:image:${key}`;
    const send = () => input.toggleAttribute('aria-invalid', run(ctx, () => ops.setImageField(ctx.document, block.id, key, input.value), 'Image updated.', { quiet: true }) === false);
    input.addEventListener('input', event => { if (!event.isComposing) send(); });
    input.addEventListener('compositionend', send);
    return labelled(doc, label, input);
  };
  nodes.push(text('Text alternative (describe it; do not give the answer away)', 'alt', 300, 3), text('Caption', 'caption', 200, 2));
  const choice = (label, key, options, current, apply) => {
    const group = el(doc, 'div', null, 'builder-segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, name] of options) {
      const option = btn(doc, name, () => run(ctx, () => apply(value), `${label}: ${name}.`), 'builder-segment');
      option.setAttribute('aria-pressed', String(current === value)); option.dataset.controlKey = `slide:${block.id}:image:${key}:${value}`; group.append(option);
    }
    return [el(doc, 'h3', label, 'builder-inspector-group'), group];
  };
  if (block.ecg) {
    const calibrate = (key, value) => ops.setImageField(ctx.document, block.id, 'ecg', { ...block.ecg, [key]: value });
    nodes.push(...choice('Paper speed', 'speed', [['25', '25 mm/s'], ['50', '50 mm/s'], ['', 'Not stated']], block.ecg.speed, value => calibrate('speed', value)),
      ...choice('Gain', 'gain', [['5', '5'], ['10', '10 mm/mV'], ['20', '20'], ['', 'Not stated']], block.ecg.gain, value => calibrate('gain', value)),
      ...choice('Layout', 'layout', [['12-lead', '12-lead'], ['rhythm-strip', 'Rhythm strip'], ['other', 'Other']], block.ecg.layout, value => calibrate('layout', value)),
      el(doc, 'p', 'An ECG is always shown whole. Crop it when you upload it.', 'builder-slide-note'));
  } else nodes.push(...choice('Fit', 'fit', [['contain', 'Whole image'], ['cover', 'Fill the block']], block.fit, value => ops.setImageField(ctx.document, block.id, 'fit', value)));
  nodes.push(btn(doc, 'Replace image', () => addImage(ctx, slideOf(ctx), null, block), 'builder-btn'));
  // Where it came from, as the author declared it; an administrator can take it down (CASE-270).
  if (row) {
    const licence = { 'own-work': 'Own work', 'CC0-1.0': 'CC0 1.0', 'CC-BY-4.0': 'CC BY 4.0', 'CC-BY-SA-4.0': 'CC BY-SA 4.0', PDM: 'Public domain', 'licensed-other': 'Licensed',
      'CC-BY-NC-4.0': 'CC BY-NC 4.0', 'CC-BY-NC-SA-4.0': 'CC BY-NC-SA 4.0', 'CC-BY-ND-4.0': 'CC BY-ND 4.0', 'CC-BY-NC-ND-4.0': 'CC BY-NC-ND 4.0',
      unlicensed: 'Textbook or journal figure, no licence held', unknown: 'Source not known' }[row.licence] ?? '';
    const length = Number.isInteger(row.duration_ms) ? `${Math.floor(row.duration_ms / 60000)}:${String(Math.round(row.duration_ms / 1000) % 60).padStart(2, '0')}` : '';
    const facts = el(doc, 'dl', null, 'builder-image-facts');
    for (const [term, value] of [['Licence', `${licence}${row.rights_basis === 'consented_patient' ? ' · patient consent recorded outside Case' : ''}`], ['Creator', row.creator], ['Attribution', row.attribution], ['Licence terms', row.rights_note], ['Source', row.source_url], ['Size', `${row.width} × ${row.height}`], ['Length', length]])
      if (value) facts.append(el(doc, 'dt', term), el(doc, 'dd', value));
    nodes.push(el(doc, 'h3', 'Source and licence', 'builder-inspector-group'), facts);
    // Card 59 M4 (J8): an administrator takes an image down with an emailed step-up code; every room then shows it as withdrawn.
    if (media.services?.canApprove && !['withdrawn', 'rejected'].includes(row.status)) {
      const panel = el(doc, 'div', null, 'builder-slide-choices');
      const start = btn(doc, 'Withdraw image…', () => {
        const reason = el(doc, 'textarea'); reason.rows = 2; reason.maxLength = 500; reason.setAttribute('aria-label', 'Reason for withdrawal'); reason.dataset.controlKey = `slide:${block.id}:image:withdraw-reason`;
        const code = el(doc, 'input'); code.inputMode = 'numeric'; code.maxLength = 6; code.autocomplete = 'one-time-code'; code.setAttribute('aria-label', 'Six-digit code');
        const send = btn(doc, 'Email me a code', async () => { try { await (await mediaModule()).requestStepUp(media.services); ctx.status('Code sent to your email.'); } catch (error) { ctx.status(error.message); } }, 'builder-btn');
        const confirm = btn(doc, 'Withdraw from every room', async () => {
          if (!reason.value.trim() || !/^[0-9]{6}$/.test(code.value)) { ctx.status('Give a reason and the six-digit code.'); return; }
          try {
            await (await mediaModule()).withdrawImage(media.services, row.asset_id, { reason: reason.value.trim(), code: code.value });
            media.rows.set(row.asset_id, { ...row, status: 'withdrawn' });
            const held = media.urls.get(row.asset_id); if (held?.url) URL.revokeObjectURL(held.url);
            media.urls.set(row.asset_id, { state: 'withdrawn' }); media.generation++; ctx.status('Image withdrawn. Its stored copies are deleted.'); ctx.rerender();
          } catch (error) { ctx.status(error.message); }
        }, 'builder-btn builder-danger');
        panel.replaceChildren(labelled(doc, 'Reason (kept in the audit)', reason), send, labelled(doc, 'Code from the email', code), confirm);
      }, 'builder-btn builder-danger');
      panel.append(start); nodes.push(panel);
    }
  }
  return nodes;
}

/**
 * Where a trend chart's problem is fixed (round 28 P2-5): what to do, in plain words, and the Block-tab control's key.
 * `rest` is the pointer below the block, such as `/series/0/label`; null when it names nothing on the chart.
 */
export function trendTarget(trend, rest) {
  const [key, at, field, cell] = String(rest ?? '').split('/').filter(Boolean), n = Number(at), point = trend.points?.[n], series = trend.series?.[n];
  const AXIS = { x_label: 'Name the horizontal axis', y_label: 'Name the vertical axis', y_min: 'Set the axis bottom', y_max: 'Set the axis top', caption: 'Caption', x_unit: 'Horizontal unit', y_unit: 'Vertical unit' };
  if (AXIS[key] && at === undefined) return { text: AXIS[key], key: `slide:${trend.id}:trend:${key}` };
  if (key === 'points' && point && ['label', 'at'].includes(field)) return { text: field === 'label' ? `Label point ${n + 1}` : `Set the time of point ${n + 1}`, key: `slide:${trend.id}:point:${point.id}:${field}` };
  if (key === 'points') return { text: null, key: trend.points?.[0] ? `slide:${trend.id}:point:${trend.points[0].id}:label` : null };
  if (key === 'series' && series && field === 'label') return { text: `Name series ${n + 1}`, key: `slide:${trend.id}:series:${series.id}` };
  if (key === 'series' && series) {
    const index = field === 'values' && cell !== undefined ? Number(cell) : series.values?.findIndex(value => value === '') ?? 0, target = trend.points?.[Math.max(0, index)];
    return { text: field === 'values' ? `${series.label || `Series ${n + 1}`} at point ${Math.max(0, index) + 1}` : `Series ${n + 1}`, key: target ? `slide:${trend.id}:value:${series.id}:${target.id}` : null };
  }
  return null;
}

function labelled(doc, name, control) { const label = el(doc, 'label', null, 'builder-slide-field'); label.append(el(doc, 'span', name), control); return label; }

function tableTools(ctx, table) {
  const { doc, state } = ctx, nodes = [el(doc, 'h3', 'Table')];
  // Starters swap the columns of an empty table only; once anything is written, labels and values stay.
  const starter = el(doc, 'select'); starter.setAttribute('aria-label', 'Table starter'); starter.dataset.controlKey = `slide:${table.id}:starter`;
  const current = Object.entries(ops.TABLE_RECIPES).find(([, labels]) => labels.join('|') === table.columns.map(column => column.label).join('|'))?.[0];
  for (const [recipe, label] of Object.entries(RECIPE_NAMES)) { const option = el(doc, 'option', label); option.value = recipe; starter.append(option); }
  starter.value = current ?? '';
  starter.disabled = !current || Boolean(table.caption) || table.rows.some(row => row.cells.some(Boolean));
  starter.addEventListener('change', () => run(ctx, () => ops.applyTableRecipe(ctx.document, table.id, starter.value, ctx.createId), `Table starter: ${RECIPE_NAMES[starter.value]}.`));
  nodes.push(labelled(doc, 'Table starter', starter));
  if (starter.disabled) nodes.push(el(doc, 'p', 'Starters apply to an empty table. Existing labels and values are kept.', 'builder-slide-note'));
  const toggle = (name, checked, change, key) => {
    const label = el(doc, 'label', null, 'builder-slide-check'), input = el(doc, 'input'); input.type = 'checkbox'; input.checked = checked; input.dataset.controlKey = `slide:${table.id}:${key}`;
    input.addEventListener('change', () => change(input.checked)); label.append(input, doc.createTextNode(` ${name}`)); return label;
  };
  nodes.push(toggle('Header row', table.header_row, on => run(ctx, confirmed => ops.setHeaderRow(ctx.document, table.id, on, ctx.createId, { confirmed }), on ? 'The first row is now the header row.' : 'Header text is kept as the first row.'), 'header-row'),
    toggle('First column labels each row', table.first_column_header, on => run(ctx, () => ops.setFirstColumnHeader(ctx.document, table.id, on), 'Row labels changed.'), 'first-column'));
  // The caption is written here; once it has text it is also edited where the slide draws it (CASE-249).
  const caption = el(doc, 'textarea'); caption.rows = 1; caption.value = table.caption ?? ''; caption.placeholder = 'Optional'; caption.dataset.controlKey = `slide:${table.id}:caption-tools`;
  caption.addEventListener('change', () => run(ctx, () => ops.setCaption(ctx.document, table.id, caption.value), caption.value ? 'Caption updated.' : 'Caption removed.'));
  nodes.push(labelled(doc, 'Caption', caption));
  const cell = state.cell?.tableId === table.id ? state.cell : null;
  const column = cell && table.columns.find(item => item.id === cell.columnId), row = cell?.rowId && table.rows.find(item => item.id === cell.rowId);
  if (!column) { nodes.push(el(doc, 'p', 'Select a cell to change its row or column.', 'builder-slide-note')); return nodes; }
  const columnIndex = table.columns.indexOf(column);
  nodes.push(el(doc, 'p', `${row ? `Row ${table.rows.indexOf(row) + 1} · ` : ''}Column ${columnIndex + 1}${column.label ? ` (${column.label})` : ''}`, 'builder-slide-note'));
  const unit = el(doc, 'textarea'); unit.rows = 1; unit.value = column.unit ?? ''; unit.setAttribute('aria-label', 'Column unit'); unit.dataset.controlKey = `slide:${table.id}:unit:${column.id}`;
  unit.addEventListener('change', () => run(ctx, () => ops.setColumn(ctx.document, table.id, column.id, { unit: unit.value }), 'Column unit changed.'));
  const align = el(doc, 'select'); align.setAttribute('aria-label', 'Column alignment'); align.dataset.controlKey = `slide:${table.id}:align:${column.id}`;
  for (const [value, name] of [['start', 'Text · left'], ['end', 'Numbers · right']]) { const option = el(doc, 'option', name); option.value = value; align.append(option); }
  align.value = column.align;
  align.addEventListener('change', () => run(ctx, () => ops.setColumn(ctx.document, table.id, column.id, { align: align.value }), 'Column alignment changed.'));
  const width = el(doc, 'input'); width.type = 'number'; width.min = '1'; width.max = '6'; width.value = String(column.width); width.setAttribute('aria-label', 'Relative column width'); width.dataset.controlKey = `slide:${table.id}:width:${column.id}`;
  width.addEventListener('change', () => run(ctx, () => ops.setColumn(ctx.document, table.id, column.id, { width: Number(width.value) }), 'Column width changed.'));
  // The column's label has an editor here too, for card layout where the header row is hidden (re-audit #6).
  if (table.header_row) {
    const label = el(doc, 'textarea'); label.rows = 1; label.value = column.label ?? ''; label.setAttribute('aria-label', 'Column label'); label.dataset.controlKey = `slide:${table.id}:column-label:${column.id}`;
    label.addEventListener('change', () => run(ctx, () => ops.setColumn(ctx.document, table.id, column.id, { label: label.value }), 'Column label updated.'));
    nodes.push(labelled(doc, 'Label', label));
  }
  nodes.push(labelled(doc, 'Unit', unit), labelled(doc, 'Alignment', align), labelled(doc, 'Relative width', width));
  const actions = el(doc, 'div', null, 'builder-slide-choices');
  const act = (label, attempt, done, cls) => actions.append(btn(doc, label, () => run(ctx, attempt, done), cls));
  act('Add row below', () => ops.addRow(ctx.document, table.id, row?.id ?? null, ctx.createId), 'Row added.');
  act('Add column right', () => ops.addColumn(ctx.document, table.id, column.id, ctx.createId), 'Column added.');
  if (row) { act('Move row up', () => ops.moveRow(ctx.document, table.id, row.id, -1), 'Row moved.'); act('Move row down', () => ops.moveRow(ctx.document, table.id, row.id, 1), 'Row moved.'); }
  act('Move column left', () => ops.moveColumn(ctx.document, table.id, column.id, -1), 'Column moved.');
  act('Move column right', () => ops.moveColumn(ctx.document, table.id, column.id, 1), 'Column moved.');
  if (row) act('Delete row', confirmed => ops.removeRow(ctx.document, table.id, row.id, { confirmed }), 'Row deleted. Undo restores it.', 'builder-btn builder-danger');
  act('Delete column', confirmed => ops.removeColumn(ctx.document, table.id, column.id, { confirmed }), 'Column deleted. Undo restores it.', 'builder-btn builder-danger');
  nodes.push(actions);
  return nodes;
}

const TYPE_ICONS = { text: '¶', list: '≡', quote: '❝', callout: '▣', values: '#', table: '▦', timeline: '⧗', gas: '▤', question: '?' };

/**
 * Block order (BWR15): reveal steps with draggable block rows. Drop a row on a step to reveal it there, or on “New step”;
 * “Its own step” splits it into the next step; the row's Move to… select is the keyboard path. Hovering or focusing a row outlines its block.
 */
function orderTab(ctx, composition) {
  const { doc, document } = ctx, how = el(doc, 'details', null, 'builder-exact builder-order-help');
  how.append(el(doc, 'summary', 'How steps work'), el(doc, 'p', 'On entry shows when the slide opens; the facilitator reveals each later step. Drag a block between steps, or use its Move to… menu. Steps never move blocks on the slide.', 'builder-slide-note'));
  const nodes = [el(doc, 'p', 'Each step is revealed by the facilitator.', 'builder-slide-note'), how];
  const steps = el(doc, 'ol', null, 'builder-slide-steps');
  const highlight = (id, on) => doc.querySelector(`.builder-slide .slide-block[data-block-id="${id}"]`)?.toggleAttribute('data-highlight', on);
  const dropOn = (zone, target, label) => {
    zone.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('application/x-case-block')) { event.preventDefault(); zone.dataset.drop = 'true'; } });
    zone.addEventListener('dragleave', () => { delete zone.dataset.drop; });
    zone.addEventListener('drop', event => {
      event.preventDefault(); delete zone.dataset.drop;
      const id = event.dataTransfer.getData('application/x-case-block');
      if (id) run(ctx, () => ops.moveBlockToStep(ctx.document, composition.id, id, target, ctx.createId), `Moved to ${label}. The block stays where it is on the slide.`);
    });
  };
  composition.steps.forEach((step, index) => {
    const item = el(doc, 'li', null, 'builder-step'), name = index ? `Step ${index}` : 'On entry', head = el(doc, 'div', null, 'builder-slide-step-head');
    head.append(el(doc, 'h3', name, 'builder-step-title'), el(doc, 'span', `${step.block_ids.length} ${step.block_ids.length === 1 ? 'block' : 'blocks'}`, 'builder-step-count'));
    const shift = (glyph, delta, word) => { const move = btn(doc, glyph, () => run(ctx, () => ops.moveStep(ctx.document, composition.id, step.id, delta), `${name} moved ${word}.`), 'builder-icon-button'); move.setAttribute('aria-label', `Move ${name} ${word}`); head.append(move); };
    if (index > 0) shift('↑', -1, 'earlier');
    if (index < composition.steps.length - 1) shift('↓', 1, 'later');
    // A whole step drags by its grip onto another step's place; Alt+↑/↓ on the grip does the same (BWR15, gap audit #8).
    if (composition.steps.length > 1) {
      const grip = btn(doc, '⠿', () => {}, 'builder-icon-button builder-step-grip'); grip.setAttribute('aria-label', `Drag ${name} to reorder`); grip.draggable = true;
      grip.dataset.controlKey = `slide-step-grip:${step.id}`;
      grip.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-case-step', step.id); event.dataTransfer.effectAllowed = 'move'; item.dataset.dragging = 'true'; });
      grip.addEventListener('dragend', () => { delete item.dataset.dragging; });
      grip.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        run(ctx, () => ops.moveStep(ctx.document, composition.id, step.id, delta), `${name} moved ${delta < 0 ? 'earlier' : 'later'}.`);
      });
      head.prepend(grip);
    }
    item.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-case-step')) { event.preventDefault(); item.dataset.drop = 'true'; } });
    item.addEventListener('dragleave', () => { delete item.dataset.drop; });
    item.addEventListener('drop', event => {
      const from = event.dataTransfer.getData('application/x-case-step'); delete item.dataset.drop;
      if (!from) return;
      event.preventDefault(); event.stopPropagation();
      const fromIndex = composition.steps.findIndex(item => item.id === from);
      if (fromIndex >= 0 && fromIndex !== index) run(ctx, () => ops.moveStep(ctx.document, composition.id, from, index - fromIndex), 'Step moved. Its blocks reveal at its new place.');
    });
    item.append(head);
    const blocks = el(doc, 'ul', null, 'builder-step-blocks');
    for (const id of step.block_ids) {
      const block = byId(document.blocks, id), label = blockLabel(block, document.decisions), row = el(doc, 'li', null, 'builder-order-row');
      row.draggable = true; row.dataset.blockId = id;
      row.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-case-block', id); event.dataTransfer.effectAllowed = 'move'; row.dataset.dragging = 'true'; });
      row.addEventListener('dragend', () => { delete row.dataset.dragging; });
      for (const [type, on] of [['mouseenter', true], ['mouseleave', false], ['focusin', true], ['focusout', false]]) row.addEventListener(type, () => highlight(id, on));
      // Keyboard parity with drag: Alt+↑/↓ reveals the block one step earlier or later.
      row.addEventListener('keydown', event => {
        // A key the row's dropdown already handled (Alt+↓ opens it) is not also a step move.
        if (event.defaultPrevented || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const target = composition.steps[index + (event.key === 'ArrowUp' ? -1 : 1)];
        event.preventDefault();
        if (!target && event.key === 'ArrowUp') return ctx.status('Not changed. The block already reveals on entry.');
        run(ctx, () => ops.moveBlockToStep(ctx.document, composition.id, id, target ? target.id : 'new', ctx.createId), `Reveal step changed for ${label}.`);
      });
      // One control per row (round 18): the step heading already names where the block reveals, so the row offers only
      // where it can go — another step, its own step right after, or a new last step.
      const move = el(doc, 'select', null, 'builder-order-move'); move.setAttribute('aria-label', `Move ${label} to another step`); move.dataset.controlKey = `slide-order:${id}`;
      const choice = (text, value) => { const option = el(doc, 'option', text); option.value = value; move.append(option); };
      choice('Move to…', '');
      composition.steps.forEach((target, at) => { if (at !== index) choice(at ? `Step ${at}` : 'On entry', target.id); });
      if (step.block_ids.length > 1) choice('Its own step, right after', 'own');
      choice('A new last step', 'new');
      move.value = '';
      move.addEventListener('change', () => { const to = move.value; if (!to) return;
        run(ctx, () => ops.moveBlockToStep(ctx.document, composition.id, id, to, ctx.createId), to === 'own' ? 'The block now reveals in its own step, right after.' : 'Reveal step changed. The block stays where it is on the slide.'); });
      const icon = el(doc, 'span', TYPE_ICONS[block?.type] ?? '·', 'builder-type-icon'); icon.setAttribute('aria-hidden', 'true');
      // The name selects its block on the slide, as in the study (gap audit #8).
      const name = btn(doc, label, () => { ctx.state.blockId = id; ctx.rerender(`slide-order-name:${id}`); }, 'builder-order-label'); name.title = label;
      name.dataset.controlKey = `slide-order-name:${id}`; name.setAttribute('aria-pressed', String(ctx.state.blockId === id));
      row.append(icon, name, move);
      // A block waiting under Unplaced says so here too (round 21): it reveals with its step once it is placed.
      if (!composition.placements.some(item => item.block_id === id)) { row.append(el(doc, 'small', 'Not on the slide', 'builder-order-unplaced')); name.title = `${label} · not on the slide`; }
      blocks.append(row);
    }
    if (!step.block_ids.length) blocks.append(el(doc, 'li', 'Drop blocks here. An empty step is skipped.', 'builder-slide-note'));
    dropOn(item, step.id, name);
    item.append(blocks); steps.append(item);
  });
  const newStep = el(doc, 'li', 'Drop here for a new last step', 'builder-step builder-step-new'); dropOn(newStep, 'new', 'a new last step'); steps.append(newStep);
  nodes.push(steps);
  // Reading order is independent of position and reveal; it is folded away until needed.
  const reading = el(doc, 'details', null, 'builder-exact'); reading.open = Boolean(ctx.state.readingOpen);
  reading.addEventListener('toggle', () => { ctx.state.readingOpen = reading.open; });
  reading.append(el(doc, 'summary', 'Reading order'), el(doc, 'p', 'The order phones and screen readers use. It is independent of position and reveal.', 'builder-slide-note'));
  const order = el(doc, 'ol', null, 'builder-slide-reading');
  composition.reading_order.forEach((id, index) => {
    const row = el(doc, 'li'), label = blockLabel(byId(document.blocks, id), document.decisions);
    row.append(el(doc, 'span', label));
    // Compact arrows; the full sentence is the accessible name and tooltip (gap audit #18).
    const move = (glyph, delta, word) => { const b = btn(doc, glyph, () => run(ctx, () => ops.moveInReadingOrder(ctx.document, composition.id, id, delta), 'Reading order changed.'), 'builder-btn builder-reading-move');
      b.setAttribute('aria-label', `Read ${label} ${word}`); b.title = `Read ${word}`; row.append(b); };
    if (index > 0) move('↑', -1, 'earlier');
    if (index < composition.reading_order.length - 1) move('↓', 1, 'later');
    order.append(row);
  });
  reading.append(order); nodes.push(reading);
  return nodes;
}
