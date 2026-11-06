// Projector fit, measured (CASE-211/216). One drawing of a stage in the shipped projector frame — top bar, 16:9 band,
// footer, renderer and fit pass — used by the private preview window and by the Builder's own fit status. A stage still
// on the fixed layout is drawn as conversion would lay it out: the first measured candidate that fits.
import { slidePlan, buildSlide } from './slide-render.mjs';
import { renderSlideMain, fitSlide } from './projector-slides.mjs';
import { slideHero } from '../shared/slide-hero.mjs';
import { renderResponseResult, fitTextAnswers } from './projector-result.mjs';
import { markSvg } from './projector-marks.mjs';
import { legacySlide, layoutCandidates } from '../shared/slide-legacy.mjs';

export { convertToSlideDocument } from '../shared/slide-legacy.mjs';
// compositionFor comes from the small check chunk the Builder already loaded.
import { compositionFor } from './builder-slide-check.mjs';
import { applySlideTheme } from '../shared/slide-themes.mjs';
import { adoptStyles } from './adopt-styles.mjs';
export { adoptStyles };

export const VIEWS = Object.freeze({ 'projector-720': ['Projector 1280×720', 1280, 720], 'projector-1080': ['Projector 1920×1080', 1920, 1080], phone: ['Phone 390×844', 390, 844] });
const el = (doc, tag, cls, text) => { const node = doc.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
export const promptText = value => typeof value === 'string' ? value : (value?.blocks ?? []).flatMap(block => block.runs ?? (block.items ?? []).flatMap(item => item.runs)).map(run => run?.text ?? '').join(' ');
// The frame needs a tile mark's size, not its drawing: an empty mark svg gets the projector CSS sizing exactly.
const markSlot = doc => { const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'mark'); svg.setAttribute('viewBox', '0 0 72 72'); svg.setAttribute('aria-hidden', 'true'); return svg; };

/** The slide for a selection: an authored composition (schema 3) or today's fixed layout as an in-memory view. */
export function inspectionSlide(document, { beatId, pathId, clarificationId = null }) {
  if (document?.schema_version === 3) {
    const composition = compositionFor(document, { beatId, pathId, clarificationId });
    if (composition) {
      const byId = new Map(document.blocks.map(block => [block.id, block]));
      return { composition, blocks: composition.reading_order.map(id => byId.get(id)).filter(Boolean), authored: true };
    }
  }
  if (clarificationId) return null;
  const owner = pathId ? { kind: 'path', id: pathId } : { kind: 'beat', id: beatId };
  const view = legacySlide(document, owner) ?? (pathId ? legacySlide(document, { kind: 'beat', id: beatId }) : null);
  return view ? { composition: view.composition, blocks: view.blocks, authored: false } : null;
}

/**
 * Draw one stage into `fdoc` (an adopted frame document) as the room would show it, and measure it. `step` is 'all'
 * or a step index; `cache` (a Map) remembers the chosen fixed-layout candidate per content so typing does not
 * re-measure every candidate. `media` is the Builder's image resolver (D28), so an image is measured as its picture.
 * Returns { fits, marked } — marked blocks say "More on your phone".
 */
/**
 * A representative closed round for a decision, so the results phase is measured as the room draws it (gap audit #10):
 * every option answered, in authored order, with the interaction's own result shape.
 */
function sampleResult(decision, prompt) {
  const type = decision?.interaction?.type ?? 'single_choice', options = decision?.interaction?.options ?? [];
  const rankCount = type === 'ranking' ? (decision.interaction.rank_count ?? options.length) : null;
  const counts = options.map((option, index) => ({ optionId: option.id, label: option.label ?? '', count: Math.max(1, options.length - index),
    positionCounts: type === 'ranking' ? Array.from({ length: rankCount }, (_, at) => (at === index % rankCount ? 2 : 1)) : null }));
  if (type === 'free_text') return { prompt, type, total: 12, rankCount: null, counts: [], textPage: { page: 0, pages: 1, answers: Array.from({ length: 12 }, (_, i) => `Example response ${i + 1}`) } };
  return { decisionId: decision?.id ?? '', prompt, roundNo: 1, type, total: counts.reduce((sum, row) => sum + row.count, 0), rankCount, counts };
}

export function drawStage(fdoc, { document, beat, path, slide, step = 'all', view = 'projector-720', search = true, cache = null, phase = 'open', media = null }) {
  const fel = (tag, cls, text) => el(fdoc, tag, cls, text);
  const decision = beat?.kind === 'decision' && !path ? (document.decisions ?? []).find(item => item.id === beat.decision_id) : null;
  const released = slide ? new Set(step === 'all' ? slide.blocks.map(block => block.id) : (slide.composition.steps ?? []).slice(0, Number(step) + 1).flatMap(item => item.block_ids)) : new Set();
  const blocks = slide ? slide.blocks.filter(block => released.has(block.id)) : [];
  const sample = decision ? { prompt: promptText(decision.prompt) || 'No question text yet.', options: (decision.interaction?.options ?? []).map(option => option.label ?? '') } : null;
  const decisionColumn = () => { const box = fel('section', 'card decision'); box.dataset.phase = 'open';
    const call=fel('p','call','Prompt'), glyph=markSlot(fdoc); glyph.setAttribute('viewBox','0 0 24 24'); glyph.setAttribute('class','ic'); const line=fdoc.createElementNS(glyph.namespaceURI,'path'); line.setAttribute('d','M8 2.5h8v19H8zM11 18h2'); glyph.append(line); call.prepend(glyph); box.append(call, fel('h2', null, sample.prompt));
    const list = fel('ol', 'tiles'); list.setAttribute('aria-label', 'Options');
    sample.options.forEach(label => { const item = fel('li', 'tile opt-tile'); item.append(markSlot(fdoc), fel('span', 'lbl', label)); list.append(item); });
    box.append(list); return box; };
  if (view === 'phone') {
    fdoc.body.className = 'phone-preview';
    const column = fel('main', 'phone-preview-column');
    column.append(fel('h2', null, path?.label || beat?.title || ''));
    if (blocks.length) column.append(applySlideTheme(buildSlide(fdoc, slidePlan({ blocks, composition: slide.composition }, { layout: 'reflow', media })).root, document.theme));
    if (sample) column.append(decisionColumn());
    fdoc.body.replaceChildren(column);
    return { fits: true, marked: 0 };
  }
  fdoc.body.className = 'projector';
  const screen = fel('div', 'screen'), top = fel('header', 'top'), main = fel('main'), foot = fel('footer');
  // The shipped projector's header (projector-render.mjs renderTop): the word Case, then the case title. A path label is
  // facilitator-only and never on the projector, so the fit check must not measure it there.
  const title = fel('div', 'title'); title.append(fel('p', 'eyebrow', 'Case'), fel('p', 'case', document.title || 'Untitled case'));
  top.append(title, fel('div'), fel('div', 'meta'));
  const names = fel('section', 'names'); names.append(fel('h2', null, 'In the room'), fel('ul'));
  const route = fel('div', 'route'); route.append(fel('span', 'eyebrow', 'Join at'), fel('span', 'url', 'case.iatrogenic.app'));
  foot.append(fel('div', 'qrcell'), route, names, fel('span', 'code', 'XXXX XXXX'));
  screen.append(top, main, foot); fdoc.body.replaceChildren(screen);
  if (!slide) { main.className = 'single'; main.append(fel('h1', 'waiting-note', 'This stage has no learner content.')); return { fits: true, marked: 0 }; }
  const draw = placements => {
    // D23 hero (CASE-264), as the room's public projection carries it: only once its block is released.
    const hero = slideHero({ ...slide.composition, placements }, id => slide.blocks.find(block => block.id === id));
    renderSlideMain(main, { caseTitle: document.title, surface: { title: beat?.title ?? '', slide: { template: slide.composition.template, blocks, placements,
      reading_order: slide.composition.reading_order.filter(id => released.has(id)), styles: slide.composition.styles ?? [], ...(slide.composition.fill ? { fill: slide.composition.fill } : {}), ...(hero && released.has(hero.block_id) ? { hero } : {}) } }, decision: sample && released.size === slide.blocks.length ? sample : null,
      ...(phase === 'results' && sample && released.size === slide.blocks.length ? { responseResult: sampleResult(decision, sample.prompt) } : {}) },
      { el: (tag, cls, text) => fel(tag, cls, text), decisionColumn, responseResult: v => renderResponseResult(v, { el: (tag, cls, text) => fel(tag, cls, text), markSvg }) ?? fel('div'), media });
    applySlideTheme(main.querySelector('.slide-canvas'), document.theme);
    // As the projector's fit(): a free-text results page fits its answers, not the slide (CASE-318).
    if (main.querySelector('.text-chips')) fitTextAnswers(main, fdoc.defaultView); else fitSlide(main);
    return { fits: main.dataset.overflow !== 'true', marked: main.querySelectorAll('.slide-more').length, room: main.dataset.resultRoom ?? null, shrunk: [...main.querySelectorAll('.slide-block')].filter(node => parseFloat(node.style.getPropertyValue('--fit')) < 1).length,
      // Per block, in the slide's DOM (reading) order: the room's fit factor and whether it is still marked for phones.
      blocks: [...main.querySelectorAll('.slide-canvas > .slide-block')].map(node => ({ fit: parseFloat(node.style.getPropertyValue('--fit')) || 1, over: Boolean(node.querySelector('.slide-more')), cols: Number(node.dataset.heroCols) || 0 })) };
  };
  let result = draw(slide.composition.placements);
  if (!slide.authored && !result.fits && search) {
    const key = JSON.stringify([view, slide.blocks, [...released], sample ? decision?.prompt : null]);
    let placements = cache?.get(key);
    if (!placements) {
      let best = { result, placements: slide.composition.placements };
      for (const layout of layoutCandidates(slide.blocks, decision).slice(1, 12)) {
        const next = draw(layout.placements);
        if (next.fits || next.marked < best.result.marked) best = { result: next, placements: layout.placements };
        if (next.fits) break;
      }
      placements = best.placements;
      if (cache) { if (cache.size >= 40) cache.delete(cache.keys().next().value); cache.set(key, placements); }
    }
    result = draw(placements);
  }
  return result;
}

/**
 * A hidden projector-sized frame in the Builder page that measures the selected stage after edits settle. `measure`
 * resolves to { fits, marked } or null when the frame is not ready or was destroyed; a newer call supersedes an older one.
 * `media` is the Builder's image resolver (builder-slides.mjs builderMedia.resolve).
 */
export function createFitProbe(sourceDocument) {
  const frame = sourceDocument.createElement('iframe');
  frame.title = 'Projector fit check'; frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  frame.width = '1280'; frame.height = '720';
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '1280px', height: '720px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
  sourceDocument.body.append(frame);
  let destroyed = false, ticket = 0;
  const ready = frame.contentDocument ? adoptStyles(frame.contentDocument, sourceDocument).then(() => true, () => true) : Promise.resolve(false);
  return {
    async measure(document, selection, view = 'projector-720', phase = 'open', media = null) {
      const mine = ++ticket;
      if (!(await ready) || destroyed || mine !== ticket || !frame.contentDocument) return null;
      const [, width, height] = VIEWS[view] ?? VIEWS['projector-720'];
      if (frame.width !== String(width)) { frame.width = String(width); frame.height = String(height); Object.assign(frame.style, { width: `${width}px`, height: `${height}px` }); }
      const beat = (document.beats ?? []).find(item => item?.id === selection.beatId);
      if (!beat) return null;
      const path = selection.pathId ? (document.decisions ?? []).flatMap(item => item.paths ?? []).find(item => item.id === selection.pathId) : null;
      // A clarification's slide has no stage of its own; it is measured by composition in its decision's frame (re-audit #14).
      const authored = selection.compositionId ? (document.compositions ?? []).find(item => item.id === selection.compositionId) : null;
      const slide = authored ? { composition: authored, blocks: authored.reading_order.map(id => document.blocks.find(block => block.id === id)).filter(Boolean), authored: true } : inspectionSlide(document, selection);
      return drawStage(frame.contentDocument, { document, beat, path, slide, search: false, phase, media });
    },
    /**
     * Choose each slide's layout by measurement (fit-aware conversion in the app): a slide that overflows tries its
     * ordered candidates and keeps the first that fits, else the one with the fewest blocks marked for phones.
     * Returns the laid-out copy and how many slides still need editing, or null if the frame is unavailable.
     */
    async fitDocument(document) {
      if (!(await ready) || destroyed || !frame.contentDocument) return null;
      const next = structuredClone(document), fdoc = frame.contentDocument, blocks = new Map(next.blocks.map(block => [block.id, block]));
      let overflowing = 0;
      for (const composition of next.compositions) {
        const path = composition.owner.kind === 'path' ? next.decisions.flatMap(item => item.paths ?? []).find(item => item.id === composition.owner.id) : null;
        const owner = path ? next.decisions.find(item => (item.paths ?? []).includes(path)) : null;
        const beat = next.beats.find(item => path ? item.decision_id === owner?.id : item.id === composition.owner.id);
        const decision = !path && beat?.kind === 'decision' ? next.decisions.find(item => item.id === beat.decision_id) : null;
        const members = composition.reading_order.map(id => blocks.get(id)).filter(Boolean);
        const measure = layout => drawStage(fdoc, { document: next, beat, path, slide: { composition: { ...composition, ...layout }, blocks: members, authored: true }, search: false });
        let best = { result: measure({}), layout: null };
        if (!best.result.fits) for (const layout of layoutCandidates(members, decision)) {
          const result = measure(layout);
          if (result.fits || result.marked < best.result.marked) best = { result, layout };
          if (result.fits) break;
        }
        if (best.layout) Object.assign(composition, { template: best.layout.template, placements: best.layout.placements });
        if (!best.result.fits) overflowing++;
      }
      return { document: next, overflowing };
    },
    destroy() { destroyed = true; frame.remove(); },
  };
}
