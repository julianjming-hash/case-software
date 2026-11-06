/** Debounce private writing; the save-state remains the authority for receipts and conflicts. */
export function createBuilderAutosave({ getSnapshot, save, scheduler = globalThis, delay = 1500, interval = 10000 }) {
  let timer = null, closed = false, running = false, lastAttempt = -Infinity, blockedGeneration = null;
  const now = () => scheduler.now?.() ?? Date.now();
  const cancel = () => { if (timer !== null) scheduler.clearTimeout(timer); timer = null; };
  function changed() {
    cancel();
    const state = getSnapshot();
    if (closed || running || !state.dirty || state.status !== 'dirty' || state.localGeneration === blockedGeneration) return;
    timer = scheduler.setTimeout(attempt, Math.max(delay, lastAttempt + interval - now()));
  }
  async function attempt() {
    timer = null;
    const state = getSnapshot();
    if (closed || running || !state.dirty || state.status !== 'dirty') return;
    running = true; lastAttempt = now();
    // Refused validation or an ambiguous save never causes a loop of fresh save operations.
    blockedGeneration = state.localGeneration;
    try { await save(); } catch { /* The saving view reports the error; this generation needs an explicit retry. */ }
    finally { running = false; if (!closed) changed(); }
  }
  return { changed, close() { closed = true; cancel(); } };
}
