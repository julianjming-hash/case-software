// Slide and Builder icons (CASE-344): exact Lucide geometry, vendored from lucide-static 1.59.0 (ISC licence, lucide.dev;
// credited in NOTICE.md). Each entry is [Lucide name, nodes], the nodes copied unchanged from the release's icon-nodes.json:
// [tag, attributes] on Lucide's 24-unit grid, drawn as strokes (no fill, width 2, round caps and joins). Nothing here is
// fetched at runtime and the package is not a dependency. To update, `npm pack lucide-static@<exact version>` into a fresh
// directory outside the repo and copy the nodes; a stored callout names its icon by the key on the left, never by Lucide's
// name, so a renamed Lucide icon never changes a saved case.
export const LUCIDE_VERSION = '1.59.0';
export const ICON_TAGS = Object.freeze(['path', 'circle', 'rect']);
export const ICONS = Object.freeze({
  info: ['info', [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]]],
  alert: ['triangle-alert', [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]]],
  stop: ['circle-x', [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]]],
  check: ['circle-check', [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm16 9-5.5 5.5L8 12' }]]],
  pulse: ['activity', [['path', { d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' }]]],
  clock: ['clock', [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 6v6l4 2' }]]],
  pill: ['pill', [['path', { d: 'm10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z' }], ['path', { d: 'm8.5 8.5 7 7' }]]],
  syringe: ['syringe', [['path', { d: 'm18 2 4 4' }], ['path', { d: 'm17 7 3-3' }], ['path', { d: 'M19 9 8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5' }], ['path', { d: 'm9 11 4 4' }], ['path', { d: 'm5 19-3 3' }], ['path', { d: 'm14 4 6 6' }]]],
  stethoscope: ['stethoscope', [['path', { d: 'M11 2v2' }], ['path', { d: 'M5 2v2' }], ['path', { d: 'M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1' }], ['path', { d: 'M8 15a6 6 0 0 0 12 0v-3' }], ['circle', { cx: '20', cy: '10', r: '2' }]]],
  bulb: ['lightbulb', [['path', { d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' }], ['path', { d: 'M9 18h6' }], ['path', { d: 'M10 22h4' }]]],
  phone: ['phone', [['path', { d: 'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384' }]]],
  users: ['users', [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['path', { d: 'M16 3.128a4 4 0 0 1 0 7.744' }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['circle', { cx: '9', cy: '7', r: '4' }]]],
  quote: ['quote', [['path', { d: 'M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z' }], ['path', { d: 'M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z' }]]],
  text: ['type', [['path', { d: 'M12 4v16' }], ['path', { d: 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2' }], ['path', { d: 'M9 20h6' }]]],
  callout: ['message-square-text', [['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }], ['path', { d: 'M7 11h10' }], ['path', { d: 'M7 15h6' }], ['path', { d: 'M7 7h8' }]]],
  table: ['table', [['path', { d: 'M12 3v18' }], ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M3 9h18' }], ['path', { d: 'M3 15h18' }]]],
  values: ['list', [['path', { d: 'M3 5h.01' }], ['path', { d: 'M3 12h.01' }], ['path', { d: 'M3 19h.01' }], ['path', { d: 'M8 5h13' }], ['path', { d: 'M8 12h13' }], ['path', { d: 'M8 19h13' }]]],
  chart: ['chart-line', [['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }], ['path', { d: 'm19 9-5 5-4-4-3 3' }]]],
  gas: ['flask-conical', [['path', { d: 'M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2' }], ['path', { d: 'M6.453 15h11.094' }], ['path', { d: 'M8.5 2h7' }]]],
  image: ['image', [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }], ['circle', { cx: '9', cy: '9', r: '2' }], ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]]],
  question: ['circle-question-mark', [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }], ['path', { d: 'M12 17h.01' }]]],
  sync: ['refresh-cw', [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]]],
  undo: ['undo-2', [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]]],
  redo: ['redo-2', [['path', { d: 'm15 14 5-5-5-5' }], ['path', { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13' }]]],
});

/** The nodes of one icon, or null for 'none' or an unknown key (a newer build's icon draws nothing rather than failing). */
export const iconNodes = key => (Object.hasOwn(ICONS, key) ? ICONS[key][1] : null);
