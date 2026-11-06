// Slide fit check (fit-aware conversion, CASE-211). Renders every composition of a schema-3 document, with every step
// released and the open decision in its slot, through the shipped projector frame, CSS, renderer and fit pass
// (projector-slides.mjs), and reports what overflows at the current viewport. Local measurement only.
import { renderSlideMain, fitSlide } from '../../src/client/projector-slides.mjs';
import { markSvg } from '../../src/client/projector-marks.mjs';
import { layoutCandidates } from '../../src/shared/slide-legacy.mjs';

const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const promptText = value => typeof value === 'string' ? value : (value?.blocks ?? []).flatMap(item => item.runs ?? (item.items ?? []).flatMap(entry => entry.runs)).map(run => run.text).join(' ');
document.body.classList.add('projector');
const screen = el('div', 'screen'), top = el('header', 'top'), main = el('main'), foot = el('footer');
const title = el('div', 'title'); title.append(el('p', 'case', 'Slide fit check'));
top.append(title, el('div'), el('div', 'meta'));
// The live top bar carries room status, counts and the timer (80 px at 1280×720); match its height so the band is real.
top.style.minHeight = '80px';
const qr = el('div', 'qrcell'), code = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); code.setAttribute('viewBox', '0 0 29 29'); qr.append(code);
const route = el('div', 'route'); route.append(el('span', 'eyebrow', 'Join at'), el('span', 'url', 'case.iatrogenic.app'));
// The served footer's room row (names), so the band matches the live projector at this viewport.
const names = el('section', 'names'); names.append(el('h2', null, 'In the room')); const chips = el('ul'); chips.append(el('li', 'chip', 'Sam')); names.append(chips);
foot.append(qr, route, names, el('span', 'code', '7K3Q X9P2'));
screen.append(top, main, foot); document.body.prepend(screen);

function decisionColumn(view) {
  const box = el('section', 'card decision'); box.dataset.phase = 'open';
  box.append(el('p', 'call', 'Team decision open · Choose on your phone'), el('h2', null, view.decision.prompt));
  const list = el('ol', 'tiles'); list.setAttribute('aria-label', 'Options');
  view.decision.options.forEach((label, index) => { const item = el('li', 'tile opt-tile'); item.append(markSvg(index, { size: 72, decorative: false }), el('span', 'lbl', label)); list.append(item); });
  box.append(list); return box;
}

const choose = new URLSearchParams(location.search).get('choose') === '1';
window.fit = (async () => {
  const document_ = await (await fetch('/fit-document.json')).json();
  // Measure with the real faces: fonts.ready alone resolves before a face nothing has used yet is loaded.
  await Promise.all(['400 24px Montserrat', '700 24px Montserrat', '400 24px "JetBrains Mono"'].map(font => window.document.fonts.load(font)));
  await window.document.fonts.ready;
  const blocks = new Map(document_.blocks.map(block => [block.id, block])), report = [];
  const measureOnce = async (composition, view) => {
    renderSlideMain(main, view, { el: (tag, cls, text) => el(tag, cls, text), decisionColumn, responseResult: () => el('div') });
    await new Promise(requestAnimationFrame);
    fitSlide(main);
    // The projector's own verdict decides; the list names what overflowed (the question slot when no block did).
    if (main.dataset.overflow !== 'true') return [];
    const blocks = [...main.querySelectorAll('.slide-block')].filter(node => node.querySelector('.slide-more') || node.scrollHeight > node.clientHeight + 1).map(node => node.className.split(' ')[1]);
    return blocks.length ? blocks : ['question'];
  };
  for (const composition of document_.compositions) {
    const beat = document_.beats.find(item => item.id === composition.owner.id);
    const decision = composition.owner.kind === 'beat' && beat?.decision_id ? document_.decisions.find(item => item.id === beat.decision_id) : null;
    const slide = { template: composition.template, blocks: composition.reading_order.map(id => blocks.get(id)), placements: composition.placements, reading_order: composition.reading_order, styles: composition.styles ?? [] };
    const view = { caseTitle: document_.title, surface: { title: beat?.title ?? '', slide },
      decision: decision ? { prompt: promptText(decision.prompt), options: (decision.interaction?.options ?? []).map(option => option.label) } : null };
    let overflow = await measureOnce(composition, view), chosen = null;
    // Choose mode: measure each candidate layout and keep the first that fits, else the least overfull one.
    if (choose && overflow.length) {
      const candidates = layoutCandidates(slide.blocks, decision);
      let best = { overflow, layout: { template: composition.template, placements: composition.placements } };
      for (const layout of candidates) {
        const result = await measureOnce(composition, { ...view, surface: { ...view.surface, slide: { ...slide, template: layout.template, placements: layout.placements } } });
        if (result.length < best.overflow.length) best = { overflow: result, layout };
        if (!result.length) break;
      }
      overflow = best.overflow; chosen = best.layout;
    }
    const question = main.querySelector('.slide-question');
    report.push({ id: composition.id, owner: `${composition.owner.kind}:${beat?.title ?? composition.owner.id}`, template: chosen?.template ?? composition.template, chosen, overflow,
      questionPx: question ? parseFloat(getComputedStyle(question).fontSize) : null, bodyPx: parseFloat(getComputedStyle(main.querySelector('.slide-block') ?? main).fontSize) });
  }
  return report;
})();
