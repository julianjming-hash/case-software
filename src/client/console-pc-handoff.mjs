import { isUuidV7 } from '../shared/ids.mjs';

const JOIN_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
export function validatedConsoleHandoff(pair, snapshot, takeover) {
  if (!isUuidV7(pair?.sessionId) || typeof pair.facilitatorToken !== 'string' ||
      !pair.facilitatorToken || !Number.isSafeInteger(snapshot?.epoch) || snapshot.epoch < 0 ||
      snapshot.view?.role !== 'facilitator' || snapshot.view.sessionId !== pair.sessionId ||
      !JOIN_CODE.test(snapshot.view.joinCode) || takeover?.receipt?.receipt !== 'accepted') return null;
  return { sessionId: pair.sessionId, joinCode: snapshot.view.joinCode,
    facilitatorToken: pair.facilitatorToken };
}
