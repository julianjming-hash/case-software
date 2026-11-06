// Room sees as the projector draws it (CASE-327, Julian 2026-11-01): the console's own copy of the projector screen, the
// real projector renderer fed the same display projection the projector window gets, in a frame the size of the projector
// window (its hello says; 1280×720 until then) scaled to the panel. A lazy chunk; the frame adopts this page's styles (the app shell loads projector.css), so nothing is fetched.
// Decorative copy only: no sound, no art timers, nothing to press (the frame is inert and hidden from assistive tech;
// the panel keeps its own text for screen readers).
import { adoptStyles } from './adopt-styles.mjs';
import { buildScreen, createProjectorRenderer, refreshCountdown } from './projector-render.mjs';

const WIDTH = 1280, HEIGHT = 720; // until the projector says its size

/** `{ host, draw(view, screen), close() }`: `host` goes in Room sees; `draw` takes a display projection (or null) and the
 *  projector window's `{ width, height }` when known, so the copy fits its content exactly as that screen does. */
export function createProjectorMirror({ sourceDocument, origin, media = null }) {
  const doc = sourceDocument, host = doc.createElement('div'), frame = doc.createElement('iframe');
  host.className = 'console-mirror';
  frame.title = 'Projector copy'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('inert', '');
  let size = { width: WIDTH, height: HEIGHT };
  frame.width = String(size.width); frame.height = String(size.height);
  host.append(frame);
  let renderer = null, ready = false, latest = null, closed = false;
  // CASE-334: the copy's countdown reads the same deadline as the projector's, refreshed in place between draws.
  const tick = doc.defaultView.setInterval(() => { if (!closed && renderer && latest?.timer) refreshCountdown(frame.contentDocument, latest); }, 250);
  const resize = new (doc.defaultView.ResizeObserver ?? class { observe() {} disconnect() {} })(() => scale());
  resize.observe(host);
  function scale() {
    const width = host.clientWidth || size.width, k = width / size.width;
    frame.style.transform = `scale(${k})`; frame.style.transformOrigin = 'top left';
    host.style.height = `${Math.round(size.height * k)}px`;
  }
  function paint() {
    if (closed || !ready || !latest) return;
    if (!renderer) {
      const fdoc = frame.contentDocument; if (!fdoc) return;
      const { root, parts } = buildScreen(fdoc);
      // The projector page's own root: its language (wrapping and hyphens follow it) and its topology and source marks.
      fdoc.documentElement.lang = doc.documentElement.lang || 'en'; fdoc.documentElement.dataset.topology = 'same-pc'; fdoc.documentElement.dataset.source = 'server';
      fdoc.body.className = 'projector'; fdoc.body.replaceChildren(root);
      renderer = createProjectorRenderer({ doc: fdoc, parts, origin, onReady: () => paint(), media }); // a real room: its join QR and code, as the projector
    }
    const view = latest;
    renderer.renderTop(view, 'server');
    renderer.renderMain(view, renderer.placements(view)[0]);
    renderer.renderFooter(view);
    renderer.fit(view);
    renderer.fitNames();
  }
  // The frame is about:blank until it is in the page; its styles are adopted once it is. Moving the frame (Room sees
  // folded and shown again) reloads it blank, so a load starts over: styles, renderer and the latest view.
  let adopting = null;
  frame.addEventListener('load', () => { renderer = null; ready = false; adopting = null; adopt(); });
  function adopt() {
    if (adopting || !frame.isConnected || !frame.contentDocument) return;
    adopting = adoptStyles(frame.contentDocument, doc).catch(() => null).then(() => { ready = true; scale(); paint(); });
  }
  return {
    host,
    draw(view, screen = null) {
      latest = view ?? null;
      if (screen && (screen.width !== size.width || screen.height !== size.height)) {
        size = { width: screen.width, height: screen.height }; frame.width = String(size.width); frame.height = String(size.height);
      }
      adopt(); scale(); paint();
    },
    close() { closed = true; doc.defaultView.clearInterval(tick); resize.disconnect(); renderer = null; host.remove(); },
  };
}
