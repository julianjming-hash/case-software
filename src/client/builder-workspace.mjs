// Builder workspace regions (card 50, BWR07). Mount-local view state only: resizing, collapsing and region
// navigation never remount editors, write the draft or persist preferences.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// `centre` is the canvas column: 640px usable plus the sheet's maximum inline padding (2 × 32px).
export const PANEL = Object.freeze({ gap: 12, centre: 704, outline: [164, 280, 204], tools: [260, 360, 284] });

/** `width` is the workspace content box. Tools collapse first; one region when Outline plus centre cannot fit.
 * Remembered widths are preferences: every layout clamps them to the live budget, so restore never overflows. */
export function builderPanelLayout(width, state = {}) {
  width = Math.max(0, Number.isFinite(width) ? width : 0);
  const { gap, centre, outline: [lo, lx, ld], tools: [to, tx, td] } = PANEL;
  if (width < lo + gap + centre) return { single: true, outline: 0, tools: 0, centre: width };
  // Tools stay while both side panels fit at their minimums; the Outline then yields width before Tools collapse.
  const keep = !state.hideTools && width >= (state.hideOutline ? 0 : lo + gap) + centre + gap + to;
  const outline = state.hideOutline ? 0 : clamp(state.outline ?? ld, lo, Math.min(lx, width - gap - centre - (keep && gap + to)));
  const room = width - centre - gap - (outline && outline + gap);
  const tools = keep ? clamp(state.tools ?? td, to, Math.min(tx, room)) : 0;
  return { single: false, outline, tools, centre: width - (outline && outline + gap) - (tools && tools + gap) };
}

const NAMES = { outline: 'Outline', slide: 'Slide', tools: 'Inspector' };

export function mountBuilderPanels({ workspace, regions, nav, createId, onStatus, onLayout = () => {} }) {
  const doc = workspace.ownerDocument, view = doc.defaultView, state = { active: 'slide' }, buttons = {}, separators = {}, removers = [], last = {};
  let layout, composing = false, retired = false;
  const listen = (target, type, fn, options) => { target?.addEventListener(type, fn, options); removers.push(() => target?.removeEventListener(type, fn, options)); };
  const width = () => workspace.getBoundingClientRect().width;
  const make = (tag, className) => { const node = doc.createElement(tag); node.className = className; return node; };
  function show(name) {
    if (!api.canNavigate()) return;
    const key = name === 'outline' ? 'hideOutline' : 'hideTools';
    if (layout.single || name === 'slide') state.active = name;
    else if (layout[name]) state[key] = true;
    // A panel that cannot fit beside the canvas opens as the single region until the author returns to the Slide.
    else if (state[key] = false, !builderPanelLayout(width(), state)[name]) state.active = name, state.forced = true;
    if (name === 'slide') state.forced = false;
    update();
    const region = regions[name];
    if (region.hidden) buttons[name].focus();
    else (region.contains(last[name]) ? last[name] : region.querySelector('button, input, textarea, select, [contenteditable="true"]') ?? region).focus({ preventScroll: true });
  }
  for (const name in NAMES) {
    const region = regions[name], button = make('button', 'builder-region-button');
    region.id ||= `builder-region-${createId()}`; region.tabIndex = -1;
    button.type = 'button'; button.setAttribute('aria-controls', region.id); listen(button, 'click', () => show(name)); nav.append(button); buttons[name] = button;
    if (name === 'slide') continue;
    const [min] = PANEL[name], node = make('div', 'builder-separator'), sign = name === 'outline' ? 1 : -1;
    node.tabIndex = 0; node.setAttribute('role', 'separator'); node.setAttribute('aria-orientation', 'vertical');
    node.setAttribute('aria-label', `Resize ${NAMES[name]}`); node.setAttribute('aria-controls', region.id); node.setAttribute('aria-valuemin', min);
    separators[name] = node;
    // Keys act only while the separator owns focus, never inside native text editing.
    listen(node, 'keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const step = { ArrowLeft: -16 * sign, ArrowRight: 16 * sign, Home: -Infinity, End: Infinity }[event.key];
      if (event.key === 'Enter') show(name);
      else if (step) state[name] = layout[name] + step, update();
      else return;
      event.preventDefault();
    });
    let drag;
    listen(node, 'pointerdown', event => { if (!event.button) drag = { id: event.pointerId, x: event.clientX, size: layout[name] }, node.setPointerCapture?.(event.pointerId); });
    listen(node, 'pointermove', event => { if (drag?.id === event.pointerId) state[name] = drag.size + (event.clientX - drag.x) * sign, update(); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(node, type, () => { drag = null; });
  }
  workspace.replaceChildren(regions.outline, separators.outline, regions.slide, separators.tools, regions.tools);
  function update() {
    if (retired) return;
    const total = width(), active = doc.activeElement;
    layout = builderPanelLayout(total, state);
    if (state.forced) layout.single = true;
    const { single } = layout;
    for (const name of ['outline', 'tools']) if (!single && layout[name]) state[name] = clamp(state[name] ?? layout[name], ...PANEL[name]);
    workspace.dataset.layout = single ? 'single' : 'wide';
    // Side tracks may shrink (minmax(0,…)) so a frame painted before the next measurement never overflows the page.
    workspace.style.gridTemplateColumns = single ? 'minmax(0,1fr)' : `${layout.outline ? `minmax(0,${layout.outline}px) ${PANEL.gap}px ` : ''}minmax(0,1fr)${layout.tools ? ` ${PANEL.gap}px minmax(0,${layout.tools}px)` : ''}`;
    for (const name in NAMES) {
      const region = regions[name], visible = single ? state.active === name : name === 'slide' || Boolean(layout[name]), button = buttons[name], separator = separators[name];
      region.hidden = !visible;
      button.textContent = single ? NAMES[name] : `${visible ? 'Hide' : 'Show'} ${NAMES[name]}`;
      button.hidden = !single && name === 'slide';
      button.setAttribute(single ? 'aria-pressed' : 'aria-expanded', visible);
      button.removeAttribute(single ? 'aria-expanded' : 'aria-pressed');
      if (separator) {
        separator.hidden = single || !visible;
        // The advertised maximum is the bound the layout enforces: the Outline leaves Tools their minimum.
        const other = name === 'outline' ? layout.tools && PANEL.tools[0] : layout.outline;
        separator.setAttribute('aria-valuemax', Math.max(PANEL[name][0], Math.min(PANEL[name][1], total - PANEL.centre - PANEL.gap - (other && other + PANEL.gap))));
        separator.setAttribute('aria-valuenow', layout[name]);
      }
      // Collapsing the region (or separator) that owns focus returns focus to its named reopen control.
      if (!visible && (region.contains(active) || active === separator)) button.focus();
    }
    onLayout(layout);
  }
  listen(workspace, 'focusin', event => { for (const name in regions) if (regions[name].contains(event.target)) last[name] = event.target; });
  listen(workspace, 'compositionstart', () => { composing = true; }, true);
  listen(workspace, 'compositionend', () => { composing = false; }, true);
  const observer = view?.ResizeObserver && new view.ResizeObserver(() => update());
  observer?.observe(workspace); listen(view, 'resize', update); update();
  const api = {
    layout: () => layout,
    canNavigate() { if (composing) onStatus('Finish composing before changing regions.'); return !composing; },
    showSlide() { if (layout.single) state.active = 'slide', state.forced = false, update(); },
    /** Open a side panel if it is hidden (the Templates tool opens Tools on its Layout tab). */
    reveal(name) { if (regions[name]?.hidden) show(name); },
    destroy() { retired = true; observer?.disconnect(); for (const remove of removers) remove(); },
  };
  return api;
}
