// Run preview opener (CASE-226), shared by the Builder and the library so neither loads the other's code.
import { uuidv7 } from '../shared/ids.mjs';

/**
 * Card 52: private inspection. `open` runs inside the click: it opens the window synchronously (user activation), under a
 * name unique to that open so tabs never share it, before anything is awaited; the module follows lazily. A controller
 * only ever clears its own references when it stops, so a late stop of a closed window cannot orphan a newer one.
 */
export function createInspector({ ownerWindow, sourceDocument, auth, isCurrent = () => true, onFailed = () => {}, onNotice = () => {},
  load = () => import('./builder-inspection.mjs'), options = {}, createName = () => `case-inspection-${uuidv7()}` }) {
  let inspection = null, inspectionWindow = null, latest = null;
  return {
    open() {
      // Reuse the open window; the browser may refuse to bring it forward, and that is said, not hidden (BWR08). An inline
      // preview is never reused for a window request: it closes, and the window opens in its place.
      if (inspection?.alive && !inspectionWindow) { inspection.close(); inspection = null; }
      if (inspection?.alive) {
        const child = inspectionWindow; inspection.focus();
        ownerWindow.setTimeout?.(() => { try { if (child && !child.closed && !child.document.hasFocus()) onNotice('The private preview is already open in another window or tab. Switch to it there.'); } catch { /* gone */ } }, 200);
        return true;
      }
      if (inspectionWindow && !inspectionWindow.closed) { try { inspectionWindow.focus(); } catch { /* focus may be refused */ } return true; }
      let child = null; try { child = ownerWindow.open('about:blank', createName()); } catch { /* blocked */ }
      if (!child) return false;
      try { child.opener = null; } catch { /* already detached */ }
      inspectionWindow = child;
      load().then(module => {
        if (!isCurrent() || child.closed || inspectionWindow !== child) { try { child.close(); } catch { /* gone */ } return; }
        const mounted = module.mountInspection(child, { ownerWindow, sourceDocument, auth, ...options,
          onRetired: () => { if (inspection === mounted) inspection = null; if (inspectionWindow === child) inspectionWindow = null; } });
        inspection = mounted;
        if (latest) mounted.update(latest);
      }).catch(() => {
        try { child.close(); } catch { /* gone */ }
        if (inspectionWindow === child) inspectionWindow = null;
        onFailed('The preview window could not be loaded. Your draft is unchanged.');
      });
      return true;
    },
    /**
     * Pop-ups blocked (BWR08): the same preview mounted in a frame inside the Builder, which stays mounted beside it.
     * Returns a handle whose close removes the frame; Retry is the caller's (open() again).
     */
    openInline(host, { onClosed = () => {} } = {}) {
      inspection?.close(); inspection = null; try { inspectionWindow?.close(); } catch { /* gone */ } inspectionWindow = null;
      const frame = host.ownerDocument.createElement('iframe'); frame.title = 'Private preview'; frame.className = 'builder-inline-preview-frame';
      host.replaceChildren(frame);
      const child = frame.contentWindow;
      let mine = null;
      // The handle closes only its own mount; a window opened later is never closed through it.
      load().then(module => {
        if (!isCurrent() || !frame.isConnected) return;
        const mounted = module.mountInspection(child, { ownerWindow, sourceDocument, auth, ...options, inline: true,
          onRetired: () => { if (inspection === mounted) inspection = null; frame.remove(); onClosed(); } });
        inspection = mine = mounted;
        if (latest) mounted.update(latest);
      }).catch(() => { frame.remove(); onClosed(); onFailed('The preview could not be loaded. Your draft is unchanged.'); });
      return { close() { mine?.close(); frame.remove(); } };
    },
    update(next) { latest = next; inspection?.update(next); },
    noteInput(state) { inspection?.noteInput?.(state); },
    close() { inspection?.close(); try { inspectionWindow?.close(); } catch { /* gone */ } inspection = inspectionWindow = latest = null; },
  };
}


