// Fence asynchronous source hashes to the latest text for that authored source identity.
export function createBuilderSourceDigest({ hash, readCurrentText, applyDigest, onState = () => {} } = {}) {
  if (typeof hash !== 'function' || typeof readCurrentText !== 'function' || typeof applyDigest !== 'function')
    throw new TypeError('Source digest coordination needs hash, readCurrentText and applyDigest callbacks.');
  const generations = new Map();
  const states = new Map();
  let destroyed = false;
  const publish = id => onState(id, states.get(id) ?? 'ready');
  async function update(sourceId, text) {
    if (destroyed) return { stale: true };
    const generation = (generations.get(sourceId) ?? 0) + 1;
    generations.set(sourceId, generation); states.set(sourceId, 'pending'); publish(sourceId);
    try {
      const digest = await hash(text);
      if (destroyed || generations.get(sourceId) !== generation) return { stale: true };
      if (readCurrentText(sourceId) !== text) { states.delete(sourceId); publish(sourceId); return { stale: true }; }
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || applyDigest(sourceId, digest) !== true) {
        states.set(sourceId, 'failed'); publish(sourceId); return { ok: false };
      }
      states.delete(sourceId); publish(sourceId); return { ok: true, digest };
    } catch (error) {
      if (!destroyed && generations.get(sourceId) === generation) { states.set(sourceId, 'failed'); publish(sourceId); }
      return { ok: false, error };
    }
  }
  return Object.freeze({ update, state: id => states.get(id) ?? 'ready', hasPending: () => [...states.values()].includes('pending'),
    hasFailed: () => [...states.values()].includes('failed'), blocksSave: () => states.size > 0,
    forget: id => { generations.set(id, (generations.get(id) ?? 0) + 1); states.delete(id); publish(id); },
    destroy() { destroyed = true; generations.clear(); states.clear(); } });
}
