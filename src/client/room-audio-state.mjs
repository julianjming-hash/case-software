// The room music scene from the projector's public view only (CASE-334). No private pack, vote, correctness or clinical inference:
// the lobby bed on the join screen, the facilitator's decision theme while responses are open, the debrief bed for debrief and
// wrap-up slides and the Debrief phase, and silence everywhere else (reading, review, reveal, replay, reflection, ended).
import { isUuidV7 } from '../shared/ids.mjs';
export function publicationIdentity(view) {
  const p = view?.publication;
  return p?.v === 1 && isUuidV7(p.occurrenceId) ? p.occurrenceId : null;
}
export function musicSceneForView(view) {
  if (!view || view.phase === 'ended') return null;
  // Waiting is the visible lobby/join overlay; its underlying slide is deliberately absent.
  if (view.phase === 'waiting') return { kind: 'lobby' };
  if (view.replay || view.phase === 'paused' || view.phase === 'reviewing') return null;
  if (view.phase === 'decision_open') {
    const transport = view.music?.transport;
    if (view.decision?.status !== 'open' || !transport) return null;
    return { kind: 'decision', decisionId: view.decision.decisionId, trackId: transport.trackId, closing: transport.closing === true,
      transport: { atMs: transport.atMs, tier: transport.tier, originMs: transport.originMs } };
  }
  if (view.phase === 'debrief' && !view.surface) return { kind: 'debrief' };
  if (['live', 'teaching'].includes(view.phase) && ['debrief', 'wrap_up'].includes(view.surface?.kind)) return { kind: 'debrief' };
  return null;
}
/** The public timer the music builds to, in the engine's terms; null when there is none or it is not running yet. */
export function musicTimerForView(view, nowMs) {
  const timer = view?.timer;
  if (!timer || view.phase !== 'decision_open') return null;
  const totalS = Math.min(600, Math.max(10, Number(view.timerTotalS) || 60));
  if (timer.paused) return Number.isFinite(timer.remainingS) ? { paused: true, remainingS: timer.remainingS, totalS, nowMs } : null;
  const endsAtMs = Date.parse(timer.endsAt);
  return Number.isFinite(endsAtMs) ? { paused: false, endsAtMs, totalS, nowMs } : null;
}
