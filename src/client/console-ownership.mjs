// Each page mounts one console. Ownership belongs to that mount, not the page. Repeated claims
// share one request; a release also cancels a request whose callback has not run yet.
let roomClaim = null;
export function releaseRoom() {
  roomClaim?.stop(); roomClaim = null;
}
export function holdRoom(id) {
  if (roomClaim?.id === id) return roomClaim.result;
  releaseRoom();
  let settle, release;
  const claim = { id, result: new Promise(resolve => { settle = resolve; }),
    stop() { settle(false); release?.(); } };
  roomClaim = claim;
  const refused = () => { if (roomClaim === claim) roomClaim = null; settle(false); };
  try {
    globalThis.navigator.locks.request(`room-owner:${id}`, { ifAvailable: true }, lock => {
      if (!lock || roomClaim !== claim) { refused(); return; }
      settle(true);
      return new Promise(resolve => { release = resolve; });
    }).catch(refused);
  } catch { refused(); }
  return claim.result;
}
