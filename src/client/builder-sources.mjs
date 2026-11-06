// Builder Sources (CASE-321; owner rulings 2026-10-30). A lazy chunk of the edit route, loaded the first time Sources is
// shown. A numbered reference list, one Add form ("Paste a citation or a link", a page or figure, the permission tick)
// and the slides whose cited content changed. It stores the same five-key sources and eight-key traces as before: no
// migration. The studio commits every change; this module only builds text-only DOM (hard rule 14).
import { builderCitationSource } from '../shared/builder-metadata.mjs';
import { isWholeSourceTrace, wholeSourceTrace } from '../shared/builder-provenance.mjs';

const MAX_SOURCES = 32;
const forms = new WeakMap();

/** Render the Sources panel into `host`. `ctx` is the studio's: draft, commit, slide names and the hash function. */
export function renderSources(host, ctx) {
  const { doc, element, metadata } = ctx, sources = metadata.sources ?? [], provenance = metadata.provenance ?? [];
  const permitted = sources.filter(source => source.rights_status === 'permitted').length;
  const stale = provenance.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry?.review_status === 'stale');
  const staleSlides = new Set(stale.map(({ entry }) => ctx.slideOf(entry.entity_id)?.key ?? entry.entity_id)).size;
  const head = element(doc, 'div', undefined, 'builder-sources-head');
  const chips = element(doc, 'p', undefined, 'builder-chip-row');
  if (permitted) chips.append(element(doc, 'span', `${permitted} ready`, 'tag ok'));
  if (sources.length - permitted) chips.append(element(doc, 'span', `${sources.length - permitted} ${sources.length - permitted === 1 ? 'needs' : 'need'} permission`, 'tag warn'));
  if (staleSlides) chips.append(element(doc, 'span', `${staleSlides} ${staleSlides === 1 ? 'slide' : 'slides'} changed since cited`, 'tag warn'));
  head.append(element(doc, 'p', 'Private to authors: sources are never shown to the room or learners. Images keep their own licence and approval.', 'builder-slide-note'), chips);
  const nodes = [head];
  if (stale.length) nodes.push(changedSinceCited(ctx, stale));
  const list = element(doc, 'ol', undefined, 'builder-source-list');
  list.setAttribute('aria-label', 'Sources');
  sources.forEach((source, index) => list.append(sourceItem(ctx, source, index)));
  if (!sources.length) nodes.push(element(doc, 'p', 'No sources yet. Add the first below, then link it from a slide with Based on + Add.', 'builder-slide-note'));
  else nodes.push(list);
  nodes.push(addForm(host, ctx));
  host.replaceChildren(...nodes);
  if (ctx.review && stale.length) host.querySelector('.builder-cited-review h3')?.focus?.();
}

/** One numbered source: its citation, where it is used, and whether it may be used in teaching. */
function sourceItem(ctx, source, index) {
  const { doc, element, button, metadata } = ctx, item = element(doc, 'li', undefined, 'builder-source-item');
  const lines = String(source.text ?? '').split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
  const body = element(doc, 'div', undefined, 'builder-source-body');
  body.append(element(doc, 'span', String(index + 1), 'builder-source-number'));
  const text = element(doc, 'div');
  text.append(element(doc, 'p', source.title || lines[0] || 'Untitled source', 'builder-source-cite'));
  // The rest of its text, as written (a link's address, the edition and pages, a note): text only, never a live link.
  const detail = lines.filter(line => line !== source.title).slice(0, 3);
  if (detail.length) text.append(element(doc, 'p', detail.join(' · '), 'builder-source-detail'));
  const traces = (metadata.provenance ?? []).filter(entry => entry?.source_id === source.id);
  const slides = new Map();
  for (const entry of traces) { const slide = ctx.slideOf(entry.entity_id); if (slide && !slides.has(slide.key)) slides.set(slide.key, slide); }
  const used = element(doc, 'p', undefined, 'builder-source-used');
  if (!slides.size) used.append(traces.length ? `${traces.length} ${traces.length === 1 ? 'trace' : 'traces'}, not on a slide` : 'Not used yet');
  else {
    used.append(slides.size === 1 ? 'Used on ' : `Used on ${slides.size} slides: `);
    [...slides.values()].sort((a, b) => a.order - b.order).forEach((slide, at) => {
      if (at) used.append(', ');
      used.append(button(doc, shortSlide(slide.name), () => slide.open(), 'builder-quiet-link builder-source-slide'));
    });
    const detailed = traces.filter(entry => !isWholeSourceTrace(entry, source)).length;
    if (detailed) used.append(` · ${detailed} detailed ${detailed === 1 ? 'trace' : 'traces'}`);
  }
  text.append(used);
  body.append(text);
  const status = source.rights_status === 'permitted' ? ['Can use', 'tag ok'] : source.rights_status === 'restricted' ? ['Restricted', 'tag bad'] : ['Needs permission', 'tag warn'];
  body.append(element(doc, 'span', status[0], status[1]));
  item.append(body);
  const actions = element(doc, 'div', undefined, 'builder-source-actions');
  const tick = element(doc, 'label', undefined, 'builder-check-row'), box = element(doc, 'input');
  box.type = 'checkbox'; box.checked = source.rights_status === 'permitted'; box.dataset.controlKey = `source:${source.id}:permitted`;
  box.setAttribute('aria-label', `I can use source ${index + 1} in teaching (licence, permission or my own work)`);
  // Restricted is set and cleared only in the detailed editor (Advanced), never by this tick.
  box.disabled = source.rights_status === 'restricted';
  box.addEventListener('change', () => {
    const next = structuredClone(ctx.metadataNow()), target = next.sources?.find(item => item.id === source.id);
    if (!target) return;
    target.rights_status = box.checked ? 'permitted' : 'unknown';
    ctx.commit(next, box.checked ? `Source ${index + 1} can be used in teaching.` : `Source ${index + 1} needs permission before publishing.`);
  });
  tick.append(box, doc.createTextNode(box.disabled ? 'Restricted: change it under Advanced' : 'I can use this in teaching (licence, permission or my own work)'));
  actions.append(tick);
  if (!traces.length) {
    const remove = button(doc, 'Remove', () => {
      const next = structuredClone(ctx.metadataNow()), at = (next.sources ?? []).findIndex(item => item.id === source.id);
      if (at < 0 || (next.provenance ?? []).some(entry => entry?.source_id === source.id)) return;
      ctx.forget(source.id); next.sources.splice(at, 1);
      ctx.commit(next, `Source ${index + 1} removed. Use Undo last change to restore it.`);
    }, 'builder-quiet-link');
    remove.setAttribute('aria-label', `Remove source ${index + 1}`);
    actions.append(remove);
  }
  item.append(actions);
  return item;
}

/** "Slide 4 · First gas" reads as "Slide 4"; a consequence or off-spine slide keeps its full name. */
function shortSlide(name) { return /^(?:Slide|Stage) \d+ · [^·]+$/.test(name) ? name.replace(/ · .*$/, '') : name; }

/**
 * The slides whose cited content (or source) changed since the link was confirmed: shown, then confirmed together.
 * Only the traces listed here are confirmed, and only while each is still the one shown (fenced like card 66).
 */
function changedSinceCited(ctx, stale) {
  const { doc, element, button, metadata } = ctx, section = element(doc, 'section', undefined, 'builder-cited-review');
  section.setAttribute('aria-label', 'Changed since cited');
  const title = element(doc, 'h3', 'Changed since cited'); title.tabIndex = -1;
  section.append(title, element(doc, 'p', 'The slide text or its source changed after it was cited. Check each still matches its source, then confirm.', 'builder-slide-note'));
  const list = element(doc, 'ul', undefined, 'builder-cited-list');
  for (const { entry, index } of stale) {
    const slide = ctx.slideOf(entry.entity_id), source = (metadata.sources ?? []).find(item => item.id === entry.source_id);
    const row = element(doc, 'li');
    row.append(`${ctx.traceName(index)} · ${source ? source.title || 'Untitled source' : 'the author’s own addition'} `);
    if (slide) row.append(button(doc, 'Open slide', () => slide.open(), 'builder-quiet-link'));
    list.append(row);
  }
  section.append(list);
  const shown = stale.map(({ entry, index }) => ({ index, key: JSON.stringify(entry) }));
  const confirm = button(doc, stale.length === 1 ? 'It still matches its source' : `All ${stale.length} still match their sources`, () => {
    const next = structuredClone(ctx.metadataNow());
    if (shown.some(({ index, key }) => JSON.stringify(next.provenance?.[index]) !== key)) { ctx.status('This list changed. Review it again before confirming.'); return; }
    for (const { index } of shown) next.provenance[index].review_status = 'confirmed';
    ctx.commit(next, `${shown.length} cited ${shown.length === 1 ? 'slide' : 'slides'} confirmed.`);
  }, 'builder-btn');
  section.append(confirm);
  return section;
}

/** The Add form keeps its node (and what is typed) across renders; Add is disabled only while the text is hashed. */
function addForm(host, ctx) {
  let form = forms.get(host);
  if (form) { form.ctx = ctx; form.sync(); return form.node; }
  const { doc, element, button } = ctx, node = element(doc, 'form', undefined, 'builder-add-source');
  node.setAttribute('aria-label', 'Add a source'); node.noValidate = true;
  const citation = element(doc, 'textarea'); citation.rows = 2; citation.placeholder = 'Paste a citation or a link'; citation.setAttribute('aria-label', 'Citation or link'); citation.dataset.controlKey = 'source:citation';
  const locator = element(doc, 'input'); locator.type = 'text'; locator.placeholder = 'Page, section or figure (optional)'; locator.setAttribute('aria-label', 'Page, section or figure'); locator.dataset.controlKey = 'source:locator';
  const tick = element(doc, 'label', undefined, 'builder-check-row'), box = element(doc, 'input'); box.type = 'checkbox'; box.dataset.controlKey = 'source:permitted';
  tick.append(box, doc.createTextNode('I can use this in teaching (licence, permission or my own work)'));
  const add = button(doc, 'Add source', () => {}, 'builder-btn builder-primary'); add.type = 'submit';
  let busy = false;
  form = { node, ctx, sync() { const full = (form.ctx.metadata.sources?.length ?? 0) >= MAX_SOURCES; add.disabled = busy || full; add.title = full ? `A case holds at most ${MAX_SOURCES} sources.` : ''; } };
  node.addEventListener('submit', async event => {
    event.preventDefault();
    const current = form.ctx, text = current.clean(citation.value).trim(), where = current.clean(locator.value, false).trim();
    if (!text) { current.status('Paste a citation or a link first.'); citation.focus(); return; }
    if ((current.metadataNow().sources?.length ?? 0) >= MAX_SOURCES) { current.status(`A case holds at most ${MAX_SOURCES} sources. Nothing was added.`); return; }
    const source = builderCitationSource({ id: current.createId(), citation: text, locator: where, permitted: box.checked, sha256: '' });
    busy = true; form.sync(); add.textContent = 'Adding…';
    try { source.sha256 = await current.hash(source.text); }
    catch { current.status('This source could not be added in this browser. Nothing was changed.'); return; }
    finally { busy = false; add.textContent = 'Add source'; form.sync(); }
    const latest = form.ctx, next = structuredClone(latest.metadataNow()); next.sources = [...(next.sources ?? []), source];
    const number = next.sources.length;
    if (latest.commit(next, `Source ${number} added${source.rights_status === 'permitted' ? '' : '. It needs permission before publishing'}. Link it from a slide with Based on + Add.`)) {
      citation.value = ''; locator.value = ''; box.checked = false;
    }
  });
  node.append(element(doc, 'h3', 'Add a source'), citation, locator, tick, add);
  forms.set(host, form); form.sync();
  return node;
}

const WORDS = { title: 'Title', cue: 'Presenter cue', prompt: 'Question', label: 'Name', rationale: 'Rationale', scene: 'Scene', notes: 'Private notes',
  points: 'Finding', investigations: 'Investigation result', observations: 'Observation', variants: 'Variant', recovery: 'Recovery', terminal: 'Checkpoint',
  debrief_prompt: 'Debrief question', paragraphs: 'Paragraph', items: 'Item', rows: 'Row', entries: 'Entry', columns: 'Column', series: 'Series', groups: 'Group',
  value: 'Value', unit: 'Unit', caption: 'Caption', alt: 'Text alternative', heading: 'Heading', text: 'Text', body: 'Text', when: 'Time', event: 'Event', name: 'Name' };
/** A field path as an author reads it: `observations[2].unit` → "Observation 3 · Unit"; `points[0]` → "Finding 1". */
export function plainField(field) {
  return String(field ?? '').split('.').filter(Boolean).map(part => {
    const [, key = part, index] = /^([a-z0-9_]+)(?:\[(\d+)\])?$/.exec(part) ?? [];
    const word = WORDS[key] ?? `${key.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())}`;
    return index === undefined ? word : `${word} ${Number(index) + 1}`;
  }).join(' · ') || 'Text';
}
const KINDS = { stage: 'Stage', surface: 'Learner content', decision: 'Question', consequence: 'Consequence', response: 'Response', clarification: 'Clarification', flag: 'Narrative flag' };
/** A trace target named by its numbered slide ("Slide 4 · First gas · Values row 2 · “SpO2”"), not by storage. */
export function entityLabel(entity, slideName) {
  if (!slideName || entity?.kind === 'flag') return entity?.label ?? 'A record';
  if (entity.kind === 'block') return [slideName, ...String(entity.label).split(' · ').slice(2)].join(' · ');
  return `${slideName} · ${KINDS[entity.kind] ?? 'Record'}`;
}

/**
 * "Based on" beneath a slide: the sources its traces cite, as chips. + Add links a whole source to the slide (written
 * confirmed: the owner ruled that making the link is the review); × removes only such a link, never a detailed trace.
 * A link is a citation for the slide's text; it never stands in for an image's own licence or approval (CASE-268).
 */
export function renderBasedOn(host, ctx) {
  const { doc, element, button, metadata, target } = ctx, sources = metadata.sources ?? [], home = ctx.home(target.id), linked = new Map();
  for (const entry of metadata.provenance ?? []) {
    if (!entry?.source_id || ctx.home(entry.entity_id) !== home) continue;
    const source = sources.find(item => item.id === entry.source_id);
    linked.set(entry.source_id, linked.get(entry.source_id) || (entry.entity_id === target.id && entry.field === target.field && isWholeSourceTrace(entry, source)));
  }
  const nodes = [element(doc, 'span', 'Based on', 'builder-based-on-label')];
  for (const [index, source] of sources.entries()) {
    if (!linked.has(source.id)) continue;
    const name = source.title || `Source ${index + 1}`, chip = element(doc, 'span', `${index + 1} ${name}`, 'tag sel builder-based-on-chip');
    if (linked.get(source.id)) { const remove = button(doc, '×', () => toggle(ctx, source.id), 'builder-based-on-remove'); remove.setAttribute('aria-label', `Remove ${name} from this slide`); chip.append(remove); }
    nodes.push(chip);
  }
  const add = ctx.menuButton(doc, { label: 'Add a source to this slide', text: '+ Add', cls: 'builder-quiet-link builder-based-on-add', items: () => [
    ...sources.map((source, index) => [source, index]).filter(([source]) => !linked.get(source.id)).map(([source, index]) => button(doc, `${index + 1} ${source.title || 'Untitled source'}`, () => toggle(ctx, source.id), 'builder-menu-item')),
    button(doc, 'New source…', () => ctx.openSources(), 'builder-menu-item')] });
  nodes.push(add.node);
  host.replaceChildren(...nodes);
}
function toggle(ctx, sourceId) {
  const { target } = ctx, next = structuredClone(ctx.metadataNow()), source = next.sources?.find(item => item.id === sourceId);
  if (!source) return false;
  next.provenance ??= [];
  const name = source.title || 'this source', at = next.provenance.findIndex(entry => entry.entity_id === target.id && entry.field === target.field && isWholeSourceTrace(entry, source));
  if (at >= 0) {
    next.provenance.splice(at, 1); ctx.removed(at);
    return ctx.commit(next, `This slide is no longer based on ${name}. Use Undo last change to restore it.`);
  }
  if (next.provenance.length >= 2000) { ctx.status('The draft reached its source trace limit. Nothing was linked.'); return false; }
  next.provenance.push(wholeSourceTrace(target.id, target.field, source));
  return ctx.commit(next, `This slide is based on ${name}.`);
}
