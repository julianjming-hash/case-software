// Trend chart drawing (card 59 M1, CASE-263), planned for slide-render.mjs's buildSlide: SVG shapes from the author's
// numbers and text nodes for every label. Nothing is calculated for display beyond positions on the authored axis.
const node = (tag, cls, children = [], extra = {}) => ({ tag, cls, children, ...extra });
const text = value => ({ text: String(value) });

// A trend chart: the author's numbers on the author's axis, joined by straight segments (or points only). Gaps stay gaps;
// a value outside the axis is not drawn (readiness stops it). Only the axis ends are labelled, with the authored bounds.
// The same values reach assistive technology as a table, visible on a phone.
// D27: on a slide the chart is drawn in the slide's own pixels at 1280 × 720 for its grid area (3% padding, 1.2% gaps,
// less the block's inset and a line for a legend or caption), so the plot fills its block and its type is the room's
// size at any block width. A phone draws it 400 × 200, at about the phone's own size.
const L = 84, T = 40;
const MARKS = ['circle', 'square', 'triangle', 'diamond'];
const mark = (shape, x, y, cls) => shape === 'circle' ? node('circle', cls, [], { svg: { cx: x, cy: y, r: 6 } })
  : node('polygon', cls, [], { svg: { points: (shape === 'square' ? [[-5, -5], [5, -5], [5, 5], [-5, 5]] : shape === 'triangle' ? [[0, -7], [6.5, 5], [-6.5, 5]] : [[0, -7], [7, 0], [0, 7], [-7, 0]]).map(([a, b]) => `${x + a},${y + b}`).join(' ') } });
// D27: type is in the slide's pixels at 1280 × 720 (tokens.css): labels and ticks 20, about .85 of body type; values 22.
const svgText = (value, x, y, cls, anchor = 'middle') => node('text', cls, [text(value)], { svg: { x, y, 'text-anchor': anchor } });
const withUnit = (label, unit) => unit ? `${label} (${unit})` : label;
export function trendChart(block, layout, area) {
  const [, , h, w] = area?.match(/\d+/g) ?? [], W = area ? 101.5 * w - 39 : 400, H = area ? 55 * h - 50 : 200, R = W - 16, B = H - 60;
  const points = block.points, min = Number(block.y_min), max = Number(block.y_max), ok = block.y_min !== '' && block.y_max !== '' && min < max;
  const times = points.map(point => Number(point.at)), timed = block.scale === 'time' && points.length > 1 && times.every(Number.isFinite) && times.at(-1) > times[0];
  const x = index => points.length < 2 ? (L + R) / 2 : L + 14 + (R - L - 28) * (timed ? (times[index] - times[0]) / (times.at(-1) - times[0]) : index / (points.length - 1));
  const y = value => B - (Number(value) - min) / (max - min) * (B - T);
  const shapes = [node('line', 'slide-trend-axis', [], { svg: { x1: L, y1: B, x2: R, y2: B } }), node('line', 'slide-trend-axis', [], { svg: { x1: L, y1: T, x2: L, y2: B } })];
  for (const at of [T, (T * 3 + B) / 4, (T + B) / 2, (T + B * 3) / 4]) shapes.push(node('line', 'slide-trend-grid', [], { svg: { x1: L, y1: at, x2: R, y2: at } }));
  if (ok) shapes.push(svgText(block.y_max, L - 8, T + 5, 'slide-trend-tick', 'end'), svgText(block.y_min, L - 8, B + 5, 'slide-trend-tick', 'end'));
  shapes.push(svgText(withUnit(block.y_label, block.y_unit), L - 8, 22, 'slide-trend-label', 'start'), svgText(withUnit(block.x_label, block.x_unit), (L + R) / 2, H - 6, 'slide-trend-label'));
  // Point labels stay inside the chart and never overprint (round 31 P1-1): each is held within the edges, and one that
  // would run into the last drawn is left out (about 11 units a character at 20); every label stays in the table below.
  let edge = -Infinity;
  points.forEach((point, index) => {
    const half = String(point.label).length * 5.5, at = Math.min(Math.max(x(index), half + 2), W - half - 2);
    if (at - half >= edge) { edge = at + half + 12; shapes.push(svgText(point.label, at, B + 26, 'slide-trend-tick')); }
  });
  // A value label sits above its mark when it is the highest reading at that point, else below, so crossing series
  // keep their numbers apart.
  const top = points.map((_, index) => Math.max(...block.series.map(series => series.values[index] === '' ? -Infinity : Number(series.values[index]))));
  if (ok) block.series.forEach((series, n) => {
    const cls = `slide-trend-s${n + 1}`, drawn = series.values.map((value, index) => value !== '' && Number(value) >= min && Number(value) <= max ? [x(index), y(value), value, index] : null);
    if (block.style === 'line') {
      // Contiguous readings only: a blank value breaks the line, it is never bridged.
      let run = [];
      for (const at of [...drawn, null]) { if (at) { run.push(at); continue; } if (run.length > 1) shapes.push(node('polyline', `slide-trend-line ${cls}`, [], { svg: { points: run.map(([a, b]) => `${a},${b}`).join(' ') } })); run = []; }
    }
    for (const at of drawn.filter(Boolean)) {
      shapes.push(mark(MARKS[n], at[0], at[1], `slide-trend-mark ${cls}`));
      if (block.values_shown) shapes.push(svgText(at[2], at[0], Number(at[2]) >= top[at[3]] ? at[1] - 13 : at[1] + 27, 'slide-trend-value'));
    }
  });
  const children = [node('svg', 'slide-trend-chart', shapes, { svg: { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' } })];
  if (block.series.length > 1) children.push(node('ul', 'slide-trend-legend', block.series.map((series, n) => node('li', `slide-trend-key slide-trend-k${n + 1}`, [text(series.label)])), { attrs: { 'aria-hidden': 'true' } }));
  if (block.caption) children.push(node('p', 'slide-trend-caption', [text(block.caption)]));
  // The exact authored values as a table: read by assistive technology on every surface, shown on a narrow phone.
  const head = node('tr', null, [node('th', null, [text(withUnit(block.x_label, block.x_unit))], { attrs: { scope: 'col' } }), ...block.series.map(series => node('th', null, [text(withUnit(series.label, block.y_unit))], { attrs: { scope: 'col' } }))]);
  const rows = points.map((point, index) => node('tr', null, [node('th', null, [text(point.label)], { attrs: { scope: 'row' } }), ...block.series.map(series => node('td', null, [text(series.values[index])]))]));
  // A visible caption is not read twice: the table's own caption is then for assistive technology only.
  children.push(node('table', layout === 'reflow' ? 'slide-trend-data' : 'slide-trend-data sr-only', [node('caption', block.caption ? 'sr-only' : null, [text(block.caption || block.y_label)]), node('thead', null, [head]), node('tbody', null, rows)]));
  return children;
}

