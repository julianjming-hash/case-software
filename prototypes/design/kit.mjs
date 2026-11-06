// prototypes/design/kit.mjs — shared helpers for design-system.html and surface-design.html.
// Design artifact. Imports the SHIPPED option marks so mockups can never drift from them.
import { markSvg, MARKS } from '../../src/client/projector-marks.mjs';
import { normalizeCode, formatCode, CROCKFORD, JOIN_CODE_LENGTH, PAIR_CODE_LENGTH } from '../../src/shared/ids.mjs';
export { normalizeCode, formatCode, CROCKFORD, JOIN_CODE_LENGTH, PAIR_CODE_LENGTH };

export { MARKS };

/** Replace every [data-mark="i"] with the shipped mark tile. data-size optional. */
export function hydrateMarks(scope = document) {
  scope.querySelectorAll('[data-mark]').forEach((el) => {
    const i = Number(el.dataset.mark);
    const size = Number(el.dataset.size || 28);
    const svg = markSvg(i, { size, decorative: el.dataset.label == null });
    if (el.dataset.label != null) svg.setAttribute('aria-label', MARKS[i % MARKS.length].name);
    el.replaceChildren(svg);
  });
}

/** An ILLUSTRATIVE QR-like pattern (finder squares + seeded modules). Never scannable; labelled so. */
export function hydrateQr(scope = document) {
  const NS = 'http://www.w3.org/2000/svg';
  scope.querySelectorAll('[data-qr]').forEach((el) => {
    if (el.querySelector('svg')) return;
    const n = 29; let a = 2166136261;
    const r = () => { a = Math.imul(a ^ (a >>> 13), 1597334677) >>> 0; return (a & 0xffff) / 0xffff; };
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${n} ${n}`); svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Illustrative QR placement, not scannable');
    const finder = (x, y) => (x >= 0 && x < 7 && y >= 0 && y < 7);
    const inFinder = (x, y) => finder(x, y) || finder(x - (n - 7), y) || finder(x, y - (n - 7));
    const nearFinder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (nearFinder(x, y) && !inFinder(x, y)) continue;
      let on;
      if (inFinder(x, y)) { const fx = x % (n - 7) === x ? x : x - (n - 7), fy = y % (n - 7) === y ? y : y - (n - 7); const lx = x >= n - 7 ? x - (n - 7) : x, ly = y >= n - 7 ? y - (n - 7) : y; on = lx === 0 || lx === 6 || ly === 0 || ly === 6 || (lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4); void fx; void fy; }
      else on = r() > 0.52;
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', '#0d1214');
    svg.append(p);
    el.replaceChildren(svg);
  });
}

/** Appearance: Light / Dark / Auto. Auto removes the attribute so prefers-color-scheme decides. */
export function setTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
  try { localStorage.setItem('case-design-theme', mode); } catch { /* storage unavailable: preference is per-visit */ }
  document.querySelectorAll('[data-set-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setTheme === mode)));
  document.querySelectorAll('input[name="appearance"]').forEach((i) => { i.checked = i.value === mode; });
}
export function initTheme() {
  let mode = 'auto';
  try { mode = localStorage.getItem('case-design-theme') || 'auto'; } catch { /* default */ }
  setTheme(mode);
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-set-theme]'); if (b) setTheme(b.dataset.setTheme); });
  document.addEventListener('change', (e) => { if (e.target.name === 'appearance') setTheme(e.target.value); });
}
export function effectiveTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** WCAG relative-luminance contrast for two CSS colours, read back from the browser. */
export function contrast(c1, c2) {
  const rgb = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.slice(0, 3); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(c1), lum(c2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
/** Resolve a custom property to an rgb() string via a probe element. */
export function resolve(token, probe) {
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
}
export function toHex(rgb) { const m = rgb.match(/[\d.]+/g).map(Number); return '#' + m.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); }
