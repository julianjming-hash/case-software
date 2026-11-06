export function keepScreenAwake({ documentRef = globalThis.document,
  navigatorRef = globalThis.navigator } = {}) {
  let lock = null;
  let asking = false;
  let disposed = false;
  const release = current => {
    try { void Promise.resolve(current?.release?.()).catch(() => {}); } catch {}
  };
  const take = async () => {
    if (disposed || lock || asking || documentRef?.visibilityState !== 'visible' ||
        !navigatorRef?.wakeLock?.request) return;
    asking = true;
    try {
      const granted = await navigatorRef.wakeLock.request('screen');
      if (disposed) { release(granted); return; }
      lock = granted;
      lock.addEventListener?.('release', () => { if (lock === granted) lock = null; });
    } catch { lock = null; /* refused: the screensaver note in the pre-session checklist covers it */ } finally { asking = false; }
  };
  documentRef?.addEventListener?.('visibilitychange', take);
  void take();
  return { get held() { return Boolean(lock); }, dispose() {
    if (disposed) return;
    disposed = true;
    documentRef?.removeEventListener?.('visibilitychange', take);
    const current = lock; lock = null; release(current);
  } };
}
