// Recheck the local save-state generation after a checkpoint network wait, before replacing any text.
export async function restoreCheckpointWithoutLosingEdits({ expectedGeneration, currentGeneration, restore, validate, apply } = {}) {
  if (!Number.isSafeInteger(expectedGeneration) || typeof currentGeneration !== 'function' ||
      typeof restore !== 'function' || typeof validate !== 'function' || typeof apply !== 'function')
    throw new TypeError('Checkpoint restoration needs generation, restore, validate and apply callbacks.');
  const restored = await restore();
  if (currentGeneration() !== expectedGeneration) {
    throw Object.assign(new Error('Writing changed while the checkpoint was loading. Your current writing is retained; review and restore again if needed.'), { code: 'checkpoint_local_changed' });
  }
  if (!validate(restored)) throw Object.assign(new Error('Restored draft failed preservation checks; current writing is retained.'), { code: 'checkpoint_invalid' });
  apply(restored);
  return restored;
}
