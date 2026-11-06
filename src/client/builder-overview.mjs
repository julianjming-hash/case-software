// Builder Overview (CASE-321). A lazy chunk of the edit route, shown at /cases/:id/edit/overview: the case at a glance
// (title, audience, setting, estimate, save state, Preview and Publish), counts, the flow map, what stands between the
// draft and publishing, and the case details. Presentation only: it reads the draft, the Outline projection and the
// Readiness model the studio already derives, never writes, and renders text only (hard rule 14). The braid is the
// console's own case map (src/client/case-map.mjs), so the Builder and the room draw the same picture.
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Build a presentation-only node/edge set. It never writes inferred destinations into the draft. */
export function deriveBuilderTopology(document) {
  const beats = Array.isArray(document?.beats) ? document.beats.filter(record) : [];
  const decisions = new Map((Array.isArray(document?.decisions) ? document.decisions : []).filter(record).map(decision => [decision.id, decision]));
  const beatIds = new Set(beats.map(beat => beat.id));
  const nodes = beats.map(beat => ({ kind: 'beat', id: beat.id, beatId: beat.id, label: beat.title || 'Untitled stage', beatKind: beat.kind, missing: false }));
  const paths = [];
  const edges = [];
  for (const beat of beats) {
    if (beat.kind !== 'decision') {
      if (Object.hasOwn(beat, 'next_beat_id')) edges.push(edge('beat-successor', beat.id, beat.next_beat_id, { missing: !beatIds.has(beat.next_beat_id) }));
      continue;
    }
    const decision = decisions.get(beat.decision_id);
    for (const path of Array.isArray(decision?.paths) ? decision.paths : []) {
      if (!path || typeof path.id !== 'string') continue;
      paths.push({ kind: 'path', id: path.id, beatId: beat.id, label: path.label || 'Untitled consequence', classification: path.classification, missing: false });
      edges.push({ kind: 'decision-path', from: beat.id, to: path.id, pathId: path.id, missing: false });
      if (path.terminal) edges.push(edge('checkpoint', path.id, path.terminal.checkpoint_beat_id, { pathId: path.id, missing: !beatIds.has(path.terminal.checkpoint_beat_id) }));
      else if (Object.hasOwn(path, 'next_beat_id')) edges.push(edge('path-destination', path.id, path.next_beat_id, { pathId: path.id, missing: !beatIds.has(path.next_beat_id) }));
    }
  }
  nodes.push(...paths);
  for (const item of edges) {
    if (item.missing && typeof item.to === 'string' && !nodes.some(node => node.kind === 'missing' && node.id === item.to)) nodes.push({ kind: 'missing', id: item.to, label: 'Unresolved stage destination', missing: true });
  }
  return { nodes, edges };
}
function edge(kind, from, to, extra = {}) { return { kind, from, to: to ?? null, missing: !to, ...extra }; }

export function topologyEdgeText(edge, document = {}) {
  const path = document.decisions?.flatMap(decision => decision.paths ?? []).find(item => item.id === edge?.to);
  if (path) return `Consequence: ${path.label || 'Untitled consequence'}`;
  const target = document.beats?.find(beat => beat.id === edge?.to);
  const title = target?.title || (target ? 'Untitled stage' : null);
  if (edge?.missing || !target) return edge?.kind === 'checkpoint' ? 'Checkpoint destination needs repair' : 'Stage destination needs repair';
  return edge.kind === 'checkpoint' ? `Returns to checkpoint: ${title}` : `Continues to: ${title}`;
}

/** The Overview's counts: slides, questions, branches, resets, images and sources (the chip row). */
export function overviewCounts(document, metadata, projection, imagesAwaiting = null) {
  const rows = projection?.ok ? projection.rows : [];
  const decisionIds = new Set((document?.beats ?? []).filter(beat => beat?.kind === 'decision').map(beat => beat.decision_id));
  const paths = (document?.decisions ?? []).filter(decision => decisionIds.has(decision?.id)).flatMap(decision => decision.paths ?? []);
  const images = (document?.blocks ?? []).filter(block => block?.type === 'image').length + (document?.surfaces ?? []).reduce((n, surface) => n + (surface?.asset_ids?.length ?? 0), 0);
  const sources = metadata?.sources ?? [];
  return { slides: rows.filter(row => ['stage', 'consequence', 'clarification'].includes(row.kind)).length, questions: decisionIds.size,
    branches: paths.filter(path => !path.recommended).length, resets: paths.filter(path => record(path.terminal)).length,
    images, imagesAwaiting, sources: sources.length, sourcesNeedPermission: sources.filter(source => source?.rights_status !== 'permitted').length };
}

/** Readiness grouped by what it stops (Stops publishing, Stops rehearsal, Advice), each item one jump. */
export function overviewChecklist(readiness) {
  const bands = { publish: [], rehearsal: [], advice: [] };
  for (const group of readiness?.entries ?? []) {
    const seen = new Set();
    for (const issue of group.issues ?? []) {
      const message = group.unused ? 'No stage, consequence or clarification shows this content.' : issue.message || 'Review this field';
      if (seen.has(message)) continue; seen.add(message);
      const band = issue.stops === 'publish' ? 'publish' : issue.stops ? 'rehearsal' : 'advice';
      bands[band].push({ text: group.home || group.unused ? `${group.name}: ${message}` : message, at: group.unused ? null : issue.at ?? null, home: group.home ?? null });
    }
  }
  // Source review is one line each, as in Readiness (CASE-238): slides changed since cited, imported traces unreviewed.
  if (readiness?.staleSlides) bands.publish.push({ text: `${readiness.staleSlides} ${readiness.staleSlides === 1 ? 'slide' : 'slides'} changed since cited`, action: 'review' });
  if (readiness?.unreviewed) bands.publish.push({ text: `Sources: ${readiness.unreviewed} detailed ${readiness.unreviewed === 1 ? 'trace' : 'traces'} not reviewed`, action: 'sources' });
  return bands;
}

const maps = new WeakMap();
const BAND_NAMES = { publish: 'Stops publishing', rehearsal: 'Stops preview', advice: 'Advice' };
const CLASSES = { sound: 'Sound', defensible: 'Defensible', 'context-dependent': 'Context-dependent', unsafe: 'Unsafe', 'terminal-unsafe': 'Unsafe · resets', 'discussion-prompt': 'Discussion' };

/** Render the Overview into `host` from the studio's context. */
export function renderOverview(host, ctx) {
  const { doc, document, metadata, element, button } = ctx, counts = overviewCounts(document, metadata, ctx.projection, ctx.imagesAwaiting);
  const head = element(doc, 'header', undefined, 'builder-overview-head'), identity = element(doc, 'div');
  identity.append(element(doc, 'h3', document?.title || 'Untitled case', 'builder-overview-title'));
  const meta = element(doc, 'p', undefined, 'builder-overview-meta');
  const facts = [document?.audience, document?.setting, Number.isFinite(document?.duration_min) ? `about ${document.duration_min} min` : null].filter(Boolean);
  if (facts.length) meta.append(`${facts.join(' · ')} · `);
  meta.append(element(doc, 'span', 'Draft', 'tag'));
  if (ctx.saved) meta.append(` · ${ctx.saved}`);
  identity.append(meta);
  const actions = element(doc, 'div', undefined, 'builder-overview-actions');
  actions.append(button(doc, 'Preview', () => ctx.preview(), 'builder-btn builder-private'));
  if (ctx.publish) actions.append(button(doc, `${ctx.publish.label}…`, () => ctx.publish.run(), 'builder-btn builder-primary'));
  head.append(identity, actions);

  const chips = element(doc, 'p', undefined, 'builder-chip-row builder-overview-counts');
  const chip = (text, tone = '') => chips.append(element(doc, 'span', text, `tag${tone ? ` ${tone}` : ''}`));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  chip(plural(counts.slides, 'slide')); chip(plural(counts.questions, 'question')); chip(plural(counts.branches, 'branch', 'branches')); chip(plural(counts.resets, 'reset'));
  if (counts.imagesAwaiting) chip(`${plural(counts.imagesAwaiting, 'image')} awaiting approval`, 'warn');
  else if (counts.images) chip(plural(counts.images, 'image'));
  if (counts.sourcesNeedPermission) chip(`${plural(counts.sourcesNeedPermission, 'source')} ${counts.sourcesNeedPermission === 1 ? 'needs' : 'need'} permission`, 'warn');
  else if (counts.sources) chip(plural(counts.sources, 'source'));

  const body = element(doc, 'div', undefined, 'builder-overview-body');
  body.append(flow(host, ctx), side(ctx));
  host.replaceChildren(head, chips, body);
}

/** The case flow: the console's braid, then every slide in Outline order with its branches by classification. */
function flow(host, ctx) {
  const { doc, document, element, button, projection } = ctx, section = element(doc, 'section', undefined, 'builder-overview-flow');
  section.setAttribute('aria-label', 'Case flow');
  section.append(element(doc, 'h3', 'Case flow', 'builder-overview-label'));
  section.append(braid(host, ctx));
  if (!projection?.ok) { section.append(element(doc, 'p', (projection?.diagnostics ?? ['This draft’s structure needs repair before its flow can be drawn.']).join(' '))); return section; }
  const numbers = new Map(projection.rows.filter(row => row.kind === 'stage' && Number.isInteger(row.number)).map(row => [row.beatId, row.number]));
  const beats = new Map((document.beats ?? []).map(beat => [beat.id, beat]));
  const paths = new Map((document.decisions ?? []).flatMap(decision => decision.paths ?? []).map(path => [path.id, path]));
  const where = id => numbers.has(id) ? String(numbers.get(id)) : `“${beats.get(id)?.title || 'Untitled stage'}”`;
  const list = element(doc, 'ol', undefined, 'builder-flow');
  list.setAttribute('aria-label', 'Slides in order');
  for (const row of projection.rows) {
    if (row.kind === 'heading') { const item = element(doc, 'li', undefined, 'builder-flow-heading'); item.append(element(doc, 'h4', row.label)); list.append(item); continue; }
    if (row.kind === 'reference') {
      const item = element(doc, 'li', row.label, `builder-flow-ref${row.reference === 'missing' ? ' is-missing' : ''}`); item.style.setProperty('--depth', row.depth);
      list.append(item); continue;
    }
    if (row.kind !== 'stage') continue;
    const item = element(doc, 'li', undefined, 'builder-flow-stop'); item.style.setProperty('--depth', row.depth);
    item.dataset.kind = row.beatKind === 'decision' ? 'question' : 'slide';
    const open = button(doc, '', () => ctx.open(row.beatId), 'builder-flow-node');
    open.append(element(doc, 'span', row.number ? String(row.number) : '·', 'builder-flow-number'), element(doc, 'span', row.title));
    if (row.beatKind === 'decision') open.append(element(doc, 'small', 'Question'));
    open.setAttribute('aria-label', `Open ${row.number ? `slide ${row.number}, ` : ''}${row.title}${row.beatKind === 'decision' ? ', a question' : ''}`);
    item.append(open);
    if (row.issue) item.append(element(doc, 'span', row.issue, 'tag bad'));
    const lanes = element(doc, 'div', undefined, 'builder-flow-branches');
    for (const card of row.clarifications ?? []) lanes.append(button(doc, `Clarification · ${card.label}`, () => ctx.open(card.beatId, null, card.clarificationId), 'builder-flow-branch'));
    for (const consequence of row.consequences ?? []) {
      const path = paths.get(consequence.pathId) ?? {}, terminal = record(path.terminal), to = terminal ? path.terminal.checkpoint_beat_id : path.next_beat_id;
      const marker = terminal ? (beats.has(to) ? `↺ resets to ${where(to)}` : 'reset needs repair') : !to ? 'no next slide' : !beats.has(to) ? 'destination needs repair'
        : consequence.recommended ? 'continues' : numbers.has(to) ? `rejoins at ${numbers.get(to)}` : `→ ${where(to)}`;
      const lane = button(doc, '', () => ctx.open(row.beatId, consequence.pathId), 'builder-flow-branch');
      lane.dataset.classification = path.classification ?? '';
      if (consequence.recommended) lane.dataset.recommended = 'true';
      if (/repair/.test(marker)) lane.dataset.broken = 'true';
      lane.append(element(doc, 'span', consequence.label), element(doc, 'small', [consequence.recommended && 'Recommended', CLASSES[path.classification], marker].filter(Boolean).join(' · ')));
      lanes.append(lane);
    }
    if (row.consequences?.length || row.clarifications?.length) item.append(lanes);
    list.append(item);
  }
  section.append(list);
  const legend = element(doc, 'p', undefined, 'builder-flow-legend');
  for (const [key, text] of [['sound', 'Sound'], ['defensible', 'Defensible'], ['context-dependent', 'Context-dependent'], ['unsafe', 'Unsafe']]) {
    const swatch = element(doc, 'span', text, 'builder-flow-key'); swatch.dataset.classification = key; legend.append(swatch);
  }
  legend.append(element(doc, 'span', '↺ resets to a checkpoint · rejoins = returns to the main path', 'builder-flow-key-note'));
  section.append(legend, element(doc, 'p', 'Choose any slide or branch to open it. The map is drawn from the draft; it never changes a route.', 'builder-slide-note'));
  return section;
}

/** The console's case map in its compact form, mounted once per structure and kept across renders. */
function braid(host, ctx) {
  const { doc, document, element } = ctx, signature = JSON.stringify([document?.start_beat_id, (document?.beats ?? []).map(beat => [beat.id, beat.title, beat.next_beat_id, beat.decision_id]),
    (document?.decisions ?? []).map(decision => (decision.paths ?? []).map(path => [path.id, path.recommended, path.next_beat_id, path.terminal?.checkpoint_beat_id]))]);
  let held = maps.get(host);
  if (held?.signature === signature) return held.node;
  held?.map?.close?.();
  const node = element(doc, 'div', undefined, 'builder-overview-braid');
  held = { signature, node, map: null }; maps.set(host, held);
  import('./case-map.mjs').then(({ mountCaseMap }) => {
    if (maps.get(host) !== held) return;
    // The authored model refuses a draft whose routes point nowhere; the slide list below still shows every route.
    try { held.map = mountCaseMap(node, { document, compact: true, adapter: { onSelectBeat: id => ctx.open(id) } }); } catch { node.replaceChildren(); }
  }, () => node.replaceChildren());
  return node;
}

/** Before you publish (Readiness, grouped) and the case details summary. */
function side(ctx) {
  const { doc, document, metadata, element, button } = ctx, aside = element(doc, 'aside', undefined, 'builder-overview-side');
  const check = element(doc, 'section', undefined, 'builder-overview-check'); check.setAttribute('aria-label', 'Before you publish');
  check.append(element(doc, 'h3', 'Before you publish', 'builder-overview-label'));
  const bands = overviewChecklist(ctx.readiness);
  if (!bands.publish.length && !bands.rehearsal.length && !bands.advice.length) check.append(element(doc, 'p', 'Nothing to fix.'));
  for (const [band, items] of Object.entries(bands)) {
    if (!items.length) continue;
    const group = element(doc, 'div', undefined, 'builder-overview-band'); group.dataset.band = band;
    group.append(element(doc, 'h4', `${BAND_NAMES[band]} · ${items.length}`));
    const list = element(doc, 'ul');
    for (const item of items.slice(0, 6)) {
      const row = element(doc, 'li'), go = item.action === 'review' ? () => ctx.reviewSources() : item.action === 'sources' ? () => ctx.openSources() : item.at ? () => ctx.openIssue(item.at) : item.home ? () => ctx.openIssue(item.home) : null;
      row.append(element(doc, 'span', item.text));
      if (go) { const link = button(doc, item.action === 'review' ? 'Review' : 'Open', go, 'builder-quiet-link'); link.setAttribute('aria-label', `${item.action === 'review' ? 'Review' : 'Open'}: ${item.text}`); row.append(' ', link); }
      list.append(row);
    }
    group.append(list);
    if (items.length > 6) group.append(element(doc, 'p', `${items.length - 6} more in Readiness, under each slide.`, 'builder-slide-note'));
    check.append(group);
  }
  const details = element(doc, 'section', undefined, 'builder-overview-details'); details.setAttribute('aria-label', 'Case details');
  const title = element(doc, 'div', undefined, 'builder-overview-details-head');
  title.append(element(doc, 'h3', 'Case details', 'builder-overview-label'));
  const edit = button(doc, 'Edit', () => ctx.openDetails(), 'builder-quiet-link'); edit.setAttribute('aria-label', 'Edit case details'); title.append(edit);
  details.append(title);
  if (document?.summary) details.append(element(doc, 'p', document.summary));
  const objectives = (document?.learning_objectives ?? []).filter(text => typeof text === 'string' && text.trim());
  if (objectives.length) { details.append(element(doc, 'h4', 'Learning objectives')); const list = element(doc, 'ul'); for (const text of objectives) list.append(element(doc, 'li', text)); details.append(list); }
  if (typeof metadata?.preparation_requirements === 'string' && metadata.preparation_requirements.trim()) details.append(element(doc, 'h4', 'Private preparation'), element(doc, 'p', metadata.preparation_requirements));
  if (!document?.summary && !objectives.length) details.append(element(doc, 'p', 'No summary or learning objectives yet.', 'builder-slide-note'));
  aside.append(check, details);
  return aside;
}
