// The same-PC projector has no room credential. Send only a freshly derived
// display projection over its local channel, never the facilitator mirror or pack.
import { project } from '../shared/room-machine.mjs';
import { acceptLocalFrame } from './projector-view.mjs';

export function projectorFrame(snapshot, casePack) {
  const mirror = snapshot?.mirror;
  if (snapshot?.t !== 'snapshot' || snapshot.view?.role !== 'facilitator' ||
      !mirror || !casePack || mirror.sessionId !== snapshot.view.sessionId ||
      mirror.epoch !== snapshot.epoch || mirror.revision !== snapshot.revision ||
      mirror.display?.revision !== snapshot.displayRevision) return null;
  try {
    const view = project({ ...mirror, caseDoc: casePack }, 'display');
    const frame = { t: 'local_snapshot', epoch: snapshot.epoch,
      revision: snapshot.revision, displayRevision: snapshot.displayRevision, view };
    return acceptLocalFrame(frame, mirror.sessionId);
  } catch { return null; }
}

// Projection errors remain distinct; a closed public channel must not stop teardown.
export function publishProjectorFrame(channel, frame, sessionId) {
  const accepted = acceptLocalFrame(frame, sessionId);
  if (!accepted) return false;
  try { channel.postMessage(accepted); return true; }
  catch { return false; }
}
