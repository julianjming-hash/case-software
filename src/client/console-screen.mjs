// Screen identity (CASE-167), pure so it is unit-tested. Granted ScreenDetails
// names every screen by label, position, size and primacy (order-free), plus the
// screen the console is on. Without it, only the console's own screen size and
// isExtended: the window's position is left out, because without each screen's
// origin no cell can be cut from it that a drag within one screen keeps (CASE-167
// red-team). Also left out, as they move without the room's screens changing:
// devicePixelRatio (page zoom) and avail* (dock/taskbar autohide).
const num = value => Number.isFinite(value) ? Math.round(value) : '';
const screenKey = s => `${String(s?.label ?? '')}@${num(s?.left)},${num(s?.top)}:${num(s?.width)}x${num(s?.height)}${s?.isPrimary ? '*' : ''}${s?.isExtended === false ? '=' : ''}`;
export function screenFingerprint({ details = null, screenRef = null } = {}) {
  if (details?.screens) {
    const keys = Array.from(details.screens, screenKey).sort();
    return `detailed:${keys.join('|')}>${details.currentScreen ? screenKey(details.currentScreen) : ''}`;
  }
  const extended = screenRef?.isExtended === true ? 'x' : screenRef?.isExtended === false ? '1' : '?';
  return `coarse:${num(screenRef?.width)}x${num(screenRef?.height)}:${extended}`;
}

// Read the browser's actual screen topology. Detailed counts require an
// granted permission. The observer never prompts by itself; requestScreens()
// asks only when the facilitator presses "Let Case identify your screens" (CASE-167).
export function observeDisplayTopology({ screenRef = globalThis.screen,
  windowRef = globalThis.window, navigatorRef = globalThis.navigator,
  onChange = () => {}, pollMs = 2000,
  schedule = setInterval, unschedule = clearInterval } = {}) {
  let details = null, disposed = false, count = null, fingerprint = null, permission = null;
  const read = () => {
    if (details?.screens && Number.isSafeInteger(details.screens.length)) return details.screens.length;
    if (screenRef?.isExtended === true) return 2;
    if (screenRef?.isExtended === false) return 1;
    return null;
  };
  const refresh = () => {
    if (disposed) return;
    const next = read(), nextPrint = screenFingerprint({ details, screenRef });
    if (next !== count || nextPrint !== fingerprint) { count = next; fingerprint = nextPrint; onChange(count); }
  };
  screenRef?.addEventListener?.('change', refresh);
  const interval = schedule(refresh, pollMs);
  refresh();
  const attach = available => {
    if (disposed || !available?.screens) return false;
    details = available; permission = 'granted';
    details.addEventListener?.('screenschange', refresh);
    details.addEventListener?.('currentscreenchange', refresh);
    refresh();
    return true;
  };
  const query = async () => {
    try { permission = (await navigatorRef.permissions.query({ name: 'window-management' }))?.state ?? null; }
    catch { permission = null; }
  };
  const ready = (async () => {
    try {
      if (!windowRef?.getScreenDetails || !navigatorRef?.permissions?.query) return;
      await query();
      if (disposed || permission !== 'granted') return;
      attach(await windowRef.getScreenDetails());
    } catch { /* coarse isExtended fallback remains */ }
  })();
  // Facilitator-pressed only: getScreenDetails is called synchronously inside the
  // click so the browser shows its permission prompt. A denial is quiet.
  const requestScreens = () => {
    if (disposed || details || typeof windowRef?.getScreenDetails !== 'function') return Promise.resolve(false);
    let pending;
    try { pending = windowRef.getScreenDetails(); } catch (error) { pending = Promise.reject(error); }
    return Promise.resolve(pending).then(attach, async () => {
      if (navigatorRef?.permissions?.query) await query();
      return false;
    });
  };
  return { get count() { return count; },
    get fingerprint() { return disposed ? fingerprint : screenFingerprint({ details, screenRef }); },
    get canRequestScreens() { return !disposed && !details && permission === 'prompt' &&
      typeof windowRef?.getScreenDetails === 'function'; },
    requestScreens, ready, dispose() {
    if (disposed) return;
    disposed = true;
    screenRef?.removeEventListener?.('change', refresh);
    details?.removeEventListener?.('screenschange', refresh);
    details?.removeEventListener?.('currentscreenchange', refresh);
    unschedule(interval);
  } };
}
