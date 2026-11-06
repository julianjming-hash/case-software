// The common site bar uses the same menu as room and participant adapters. Account identity is
// supplied by verified /me results. Surface adapters protect active work before same-tab navigation.
import { attachSiteMenu, isPlainNavigation, textNode } from './shared-menu.mjs';
import { homeUrl } from '../shared/urls.mjs';
export { helpUrl } from '../shared/urls.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, text, className) => textNode(document, tag, text, className);
function icon(d) {
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('class', 'ic'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path); return svg;
}
/** The wordmark: the 2×2 tessera and CASE. Decorative SVG built node by node. */
export function wordmark() {
  const mark = el('a', null, 'wordmark'); mark.href = homeUrl(location.origin);
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('class', 'tessera'); svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y, c] of [[0, 0, ''], [9, 0, 't2'], [0, 9, 't3'], [9, 9, '']]) {
    const r = document.createElementNS(SVG, 'rect'); r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', '7'); r.setAttribute('height', '7'); r.setAttribute('rx', '1'); if (c) r.setAttribute('class', c);
    svg.append(r);
  }
  mark.append(svg, el('span', 'CASE'));
  mark.setAttribute('aria-label', 'Case home');
  return mark;
}

export function mountSiteHeader(host, { context = null, ...options } = {}) {
  const bar = el('header', null, 'site-bar');
  const open = el('button', null, 'menu-button'); open.type = 'button';
  open.setAttribute('aria-label', 'Open menu');
  open.append(icon('M4 7h16M4 12h16M4 17h16'));
  const mark = wordmark(), crumbs = el('nav', null, 'site-breadcrumbs'); crumbs.setAttribute('aria-label', 'Breadcrumb');crumbs.tabIndex=0;
  bar.append(mark, crumbs);
  function setBreadcrumbs(items) {
    crumbs.replaceChildren();
    for (const [index, item] of items.entries()) {
      const value = el(item.href ? 'a' : 'span', item.label, 'site-context');
      if (item.href) { value.href = item.href; value.setAttribute('aria-label', item.label); }
      if (index === items.length - 1) value.setAttribute('aria-current', 'page');
      value.title=item.label;crumbs.append(value);
    }
    crumbs.scrollLeft=crumbs.scrollWidth;
  }
  setBreadcrumbs(context ? [{ label: context }] : []);
  const guard = event => {
    const link = event.target.closest?.('a[href]');
    if (!link || !options.beforeNavigate || !isPlainNavigation(event)) return;
    event.preventDefault(); if (options.beforeNavigate({ href: link.href, kind: 'navigation' }) === true) location.assign(link.href);
  };
  bar.addEventListener('click', guard);
  bar.append(open); host.prepend(bar);
  const menu = attachSiteMenu(open, options);
  return { bar, ...menu, setBreadcrumbs, remove() { menu.remove(); bar.remove(); } };
}
