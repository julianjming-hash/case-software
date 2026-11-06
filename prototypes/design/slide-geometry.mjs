// G07 probe (CASE-209). Renders slide scenarios with the shipped card-56 renderer inside the shipped projector frame
// (top bar, footer, CSS), so the measured band, fonts and question phases are the real ones. Local study only.
import { slidePlan, buildSlide } from '../../src/client/slide-render.mjs';
import { markSvg } from '../../src/client/projector-marks.mjs';
import { renderResponseResult } from '../../src/client/projector-result.mjs';

const query = new URLSearchParams(location.search);
const scenario = query.get('s') ?? 'dense', layout = query.get('l') === 'reflow' ? 'reflow' : 'grid', optionCount = Math.max(2, Math.min(8, Number(query.get('n') ?? 8)));
document.documentElement.dataset.theme = query.get('t') === 'dark' ? 'dark' : 'light';
let serial = 0;
const id = () => `0192f000-0000-7000-8000-${String(++serial).padStart(12, '0')}`;
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const runs = text => [{ text }];
const text = (style, value) => ({ id: id(), type: 'text', paragraphs: [{ style, runs: runs(value) }] });
const SCENE = 'You are the senior registrar reviewing a woman in her late thirties after a tropical diving holiday. She has six dives over four days to about eighteen metres, neck and calf pain, red eyes and a sore throat. Symptoms worsened on the flight home. She looks well, with mild tachycardia, focal neck tenderness and calf tenderness, and no focal neurological deficit on first examination.';
const ALL_OPTIONS = ['Treat now as decompression illness and arrange recompression', 'Investigate first for an infective or inflammatory cause', 'Consider a thrombotic cause and image the calf', 'Observe with repeat neurological examination in an hour', 'Seek specialist hyperbaric advice before deciding', 'Discharge with safety-net advice and early review', 'Start empirical antibiotics while awaiting results', 'Admit for observation and serial creatine kinase'];
const OPTIONS = ALL_OPTIONS.slice(0, optionCount);

function table(rows, columns) {
  const cols = Array.from({ length: columns }, (_, index) => ({ id: id(), label: ['Time', 'HR', 'BP', 'SpO₂', 'RR', 'Temp', 'GCS', 'Pain', 'Glucose', 'Lactate', 'CK', 'Note'][index], width: index ? 1 : 2, align: index ? 'end' : 'start', ...(index === 3 ? { unit: '%' } : {}) }));
  return { id: id(), type: 'table', caption: 'Observations', header_row: true, first_column_header: true, columns: cols,
    rows: Array.from({ length: rows }, (_, row) => ({ id: id(), cells: cols.map((_, index) => index ? String(90 + ((row * 7 + index * 3) % 40)) : `${String(row * 15).padStart(2, '0')}:00`) })) };
}
const values = () => ({ id: id(), type: 'values', rows: [['Sodium', '128', 'mmol/L'], ['Creatinine', '94', 'µmol/L'], ['CRP', '472', 'mg/L'], ['WCC', '2.74', '×10⁹/L'], ['Platelets', '101', '×10⁹/L'], ['CK', '6400', 'U/L']].map(([label, value, unit]) => ({ id: id(), label, value, unit })) });
const question = { id: id(), type: 'question', decision_id: id() };

// Scenario → [blocks in reading order, placements [col,row,w,h], number of released (On entry) blocks]
const SCENARIOS = {
  dense: () => [[text('h1', 'Referred diagnosis'), text('p', SCENE), values(), table(8, 5)], [[1, 1, 12, 2], [1, 3, 7, 5], [8, 3, 5, 5], [1, 8, 12, 5]]],
  sparse: () => [[text('h1', 'Referred diagnosis'), text('p', SCENE), values()], [[1, 1, 12, 2], [1, 3, 7, 10], [8, 3, 5, 10]], 1],
  'table-max': () => [[text('h2', 'Observations'), table(32, 12)], [[1, 1, 12, 1], [1, 2, 12, 11]]],
  q8: () => [[text('h1', 'Working explanation'), text('p', SCENE), question], [[1, 1, 12, 2], [1, 3, 6, 10], [7, 5, 6, 8]]],
  'q8-results': () => [[text('h1', 'Working explanation'), text('p', SCENE), question], [[1, 1, 12, 2], [1, 3, 6, 10], [7, 5, 6, 8]]],
  'q8-wide': () => [[text('h1', 'Working explanation'), question], [[1, 1, 12, 2], [1, 3, 12, 10]]],
};
const [blocks, cells, released = blocks.length] = SCENARIOS[scenario]();
const composition = { id: id(), owner: { kind: 'beat', id: id() }, template: 'bento', styles: [],
  placements: blocks.map((block, index) => ({ block_id: block.id, col: cells[index][0], row: cells[index][1], w: cells[index][2], h: cells[index][3] })),
  reading_order: blocks.map(block => block.id), steps: [{ id: id(), block_ids: blocks.map(block => block.id) }] };

// The real projector frame: header.top, main, footer with the QR cell and room route, as projector.mjs builds them.
document.body.classList.add('projector');
const screen = el('div', 'screen'), top = el('header', 'top'), main = el('main', 'slide-band'), foot = el('footer');
const title = el('div', 'title'); title.append(el('p', 'case', 'Pain after a diving holiday'));
top.append(title, el('div'), el('div', 'meta'));
const qr = el('div', 'qrcell'), code = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
code.setAttribute('viewBox', '0 0 29 29'); qr.append(code);
const route = el('div', 'route'); route.append(el('span', 'eyebrow', 'Join at'), el('span', 'url', 'case.iatrogenic.app'));
foot.append(qr, route, el('div'), el('span', 'code', '7K3Q X9P2'));
screen.append(top, main, foot); document.body.prepend(screen);

const plan = slidePlan({ blocks: blocks.slice(0, released), composition }, { layout });
const { root, slots } = buildSlide(document, plan);
main.append(root);
for (const slot of slots) {
  if (scenario === 'q8-results') {
    const result = renderResponseResult({ responseResult: { type: 'single_choice', prompt: 'What is your working explanation?', total: 34, counts: OPTIONS.map((label, index) => ({ optionId: id(), label, count: [9, 7, 5, 4, 3, 3, 2, 1][index] })) } },
      { el, markSvg });
    slot.append(result);
  } else {
    const box = el('section', 'card decision'); box.dataset.phase = 'open';
    box.append(el('p', 'call', 'Team decision open · Choose on your phone'), el('h2', null, 'What is your working explanation? Defend one finding you would investigate further.'));
    const list = el('ol', 'tiles'); list.setAttribute('aria-label', 'Options');
    OPTIONS.forEach((label, index) => { const item = el('li', 'tile opt-tile'); item.append(markSvg(index, { size: 72, decorative: false }), el('span', 'lbl', label)); list.append(item); });
    box.append(list); slot.append(box);
  }
}

// CASE-211 B: shrink a question to its slot, from the slide's body size down to the 24 px floor, then report.
const FLOOR = 24, fits = node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1;
function fitQuestions() {
  return slots.map(slot => {
    let size = parseFloat(getComputedStyle(slot).fontSize);
    slot.style.fontSize = `${size}px`;
    while (!fits(slot) && size > FLOOR) { size = Math.max(FLOOR, size - 0.5); slot.style.fontSize = `${size}px`; }
    return { px: size, fits: fits(slot) };
  });
}
// Measurements read by e2e/slide-geometry.spec.mjs.
window.probe = document.fonts.ready.then(() => new Promise(requestAnimationFrame)).then(() => {
  const questions = fitQuestions();
  const band = main.getBoundingClientRect(), slide = root.getBoundingClientRect(), size = node => node ? parseFloat(getComputedStyle(node).fontSize) : null;
  const overflow = [...root.children].map(node => ({ kind: node.className.split(' ')[1], over: Math.max(0, node.scrollHeight - node.clientHeight, node.scrollWidth - node.clientWidth) }));
  return { scenario, layout, viewport: [innerWidth, innerHeight], band: [Math.round(band.width), Math.round(band.height)], slide: [Math.round(slide.width), Math.round(slide.height)],
    paragraph: size(root.querySelector('p')), h1: size(root.querySelector('.slide-h1')), tile: size(root.querySelector('.tile .lbl')),
    mark: root.querySelector('.tile svg')?.getBoundingClientRect().height ?? null, overflow, pageOverflow: document.documentElement.scrollWidth - innerWidth,
    fonts: [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family), options: optionCount, questions };
});
