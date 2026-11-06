// Quiet, lazy covers for the library and case detail. Each canvas keeps only its latest requested paint.
// The shared splash chunk owns the renderer; missing artwork never delays the controls.
export function createCoverPainter(load = () => import('./splash.mjs')) {
  let chunk = null, loading = null;
  const paints = new WeakMap();
  const renderer = () => chunk ? Promise.resolve(chunk) : loading ??= load()
    .then(value => (chunk = value)).finally(() => { loading = null; });
  return {
    clearCoverCache() { chunk?.clearCoverCache(); },
    async paintCovers(items, opts = {}) {
      const tickets = new Map(items.map(({ canvas }) => { const ticket = {}; paints.set(canvas, ticket); return [canvas, ticket]; }));
      const isCurrent = canvas => canvas.isConnected !== false && paints.get(canvas) === tickets.get(canvas);
      try {
        const art = await renderer();
        return await art.paintCovers(items, { ...opts, theme: opts.theme ?? art.currentTheme(), isCurrent });
      } catch { return []; } // Decorative art has a reserved plain ground when its chunk cannot load.
    },
  };
}

const painter = createCoverPainter();
export const paintCovers = (items, opts) => painter.paintCovers(items, opts);
export const clearCoverCache = () => painter.clearCoverCache();
