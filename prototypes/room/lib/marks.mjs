// prototypes/room/lib/marks.mjs: the option marks shared by the projector and every phone (CASE-088).
//
// An option's mark comes from its POSITION in the one authored order, so "the blue diamond" means
// the same option on every screen and someone without a phone can say their pick. Shape AND colour
// AND text always appear together: colour is never the only signal. Built with createElementNS,
// never markup strings.

// Fills are the v2 palette (CASE-163) and mirror the --mark-* tokens: each reads at 3:1 or better on the light
// AND the dark ground, on its own tinted tile, and under a white glyph (tests/contrast.test.mjs). The
// glyph is white on every mark. Yellow is a true yellow, so its white glyph is under 3:1: a recorded
// exception (CASE-115, Julian); a dark `edge` delineates the yellow mark on light backgrounds.
export const MARKS = Object.freeze([
  { shape: 'triangle', colour: 'red', name: 'Red triangle', fill: '#d34b36', ink: '#ffffff' },
  { shape: 'diamond', colour: 'blue', name: 'Blue diamond', fill: '#5e74cc', ink: '#ffffff' },
  { shape: 'circle', colour: 'yellow', name: 'Yellow circle', fill: '#e9a51d', ink: '#ffffff', edge: '#6e5208' },
  { shape: 'square', colour: 'green', name: 'Green square', fill: '#378862', ink: '#ffffff' },
  { shape: 'star', colour: 'purple', name: 'Purple star', fill: '#9c61b5', ink: '#ffffff' },
  { shape: 'hexagon', colour: 'teal', name: 'Teal hexagon', fill: '#21858c', ink: '#ffffff' },
  { shape: 'cross', colour: 'orange', name: 'Orange cross', fill: '#ba611c', ink: '#ffffff' },
  { shape: 'pentagon', colour: 'grey', name: 'Grey pentagon', fill: '#6b7b82', ink: '#ffffff' },
]);

const PATHS = {
  triangle: 'M12 3 L22 20 L2 20 Z',
  diamond: 'M12 2 L22 12 L12 22 L2 12 Z',
  circle: 'M12 3 a9 9 0 1 0 0.001 0 Z',
  square: 'M4 4 H20 V20 H4 Z',
  star: 'M12 2 L14.9 8.6 L22 9.3 L16.6 14 L18.2 21 L12 17.3 L5.8 21 L7.4 14 L2 9.3 L9.1 8.6 Z',
  hexagon: 'M7 3 H17 L22 12 L17 21 H7 L2 12 Z',
  cross: 'M9 2 H15 V9 H22 V15 H15 V22 H9 V15 H2 V9 H9 Z',
  pentagon: 'M12 2 L22 9.5 L18.2 21 H5.8 L2 9.5 Z',
};

export const markFor = (index) => MARKS[index % MARKS.length];

/**
 * A mark tile: the coloured square with the white shape on it.
 * @param {number} index option position
 * @param {{size?:number, decorative?:boolean}} opts decorative when the option text sits beside it
 */
export function markSvg(index, { size = 32, decorative = true } = {}) {
  const m = markFor(index);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('mark', `mark-${m.colour}`);
  if (decorative) svg.setAttribute('aria-hidden', 'true');
  else { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', m.name); }
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '24'); bg.setAttribute('height', '24'); bg.setAttribute('rx', '4');
  bg.setAttribute('fill', m.fill);
  if (m.edge) { bg.setAttribute('stroke', m.edge); bg.setAttribute('stroke-width', '1.5'); bg.setAttribute('x', '.75'); bg.setAttribute('y', '.75'); bg.setAttribute('width', '22.5'); bg.setAttribute('height', '22.5'); }
  const g = document.createElementNS(NS, 'path');
  g.setAttribute('d', PATHS[m.shape]);
  g.setAttribute('fill', m.ink);
  g.setAttribute('transform', 'translate(4.8 4.8) scale(0.6)');
  svg.append(bg, g);
  return svg;
}
