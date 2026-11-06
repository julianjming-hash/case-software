/** Fence each asynchronous Builder import and mount by both identity generation and host. */
export function isCurrentBuilderMount(expectedGeneration, currentGeneration, expectedHost, currentHost) {
  return expectedGeneration === currentGeneration && expectedHost === currentHost;
}

export async function mountBuilderForCurrentRoute({ expectedGeneration, currentGeneration, expectedHost, currentHost, load, mount }) {
  const module = await load();
  if (!isCurrentBuilderMount(expectedGeneration, currentGeneration(), expectedHost, currentHost())) return null;
  const instance = await mount(module);
  if (!isCurrentBuilderMount(expectedGeneration, currentGeneration(), expectedHost, currentHost())) {
    instance?.close?.();
    return null;
  }
  return instance;
}
