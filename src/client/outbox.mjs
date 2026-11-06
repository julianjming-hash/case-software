// Phone-only durable vote envelopes. Credentials never enter this store.
import { uuidv7, isUuidV7 } from '../shared/ids.mjs';
import { parseCommandEnvelope, WIRE_VERSION } from '../shared/wire.mjs';

import {OUTBOX_LIMIT,isVoteResponse} from './vote-policy.mjs';
export {OUTBOX_LIMIT,isVoteResponse} from './vote-policy.mjs';
const TERMINAL = new Set(['accepted', 'already_accepted', 'locked', 'rejected', 'voided', 'removed', 'ended']);

export function createOutbox({ store, roomId, participantId, send, onRoundClosed = () => {}, locks = globalThis.navigator?.locks }) {
  if (!isUuidV7(roomId) || !isUuidV7(participantId)) throw new TypeError('invalid outbox scope');
  let flight = null, generation = 0, closed = false, requested = false;
  const owned = row => row.roomId === roomId && row.participantId === participantId;
  const update = change => store.update(roomId, change);
  const read = () => update(rows => ({ rows, result: rows.filter(owned) }));
  const box = {
    async enqueue(input) {
      if (closed || !input || Object.keys(input).some(key => !['roundId', 'epoch', 'response'].includes(key))) throw new TypeError('invalid vote');
      const envelope = { v: WIRE_VERSION, type: 'vote', epoch: input.epoch, clientEventId: uuidv7(), roundId: input.roundId, response: structuredClone(input.response) };
      if (!parseCommandEnvelope(envelope, 'participant').ok || !isVoteResponse(envelope.response)) throw new TypeError('invalid vote');
      await update(rows => {
        const next = rows.map(row => owned(row) && row.envelope.roundId === envelope.roundId ? { ...row, superseded: true } : row);
        if (next.length >= OUTBOX_LIMIT) {
          const sameRound = next.findIndex(row => owned(row) && row.superseded && row.admitted === false && row.envelope.roundId === envelope.roundId);
          const stale = sameRound >= 0 ? sameRound : next.findIndex(row => row.superseded && row.admitted === false);
          if (stale < 0) throw new Error('Outbox full');
          next.splice(stale, 1);
        }
        next.push({ roomId, participantId, envelope, superseded: false, admitted: false });
        return { rows: next, result: null };
      });
      return structuredClone(envelope);
    },
    async count() { return (await read()).filter(row => !row.superseded).length; },
    async latest(roundId) { return structuredClone((await read()).findLast(row => !row.superseded && row.envelope.roundId === roundId)?.envelope ?? null); },
    async setEpoch(epoch) {
      if (!Number.isInteger(epoch) || epoch < 0) throw new TypeError('invalid epoch');
      await update(rows => ({ rows: rows.map(row => owned(row) ? { ...row, envelope: { ...row.envelope, epoch } } : row), result: null }));
    },
    flush() {
      if (flight) { requested = true; return flight; }
      const seen = generation;
      const drain = async () => {
        for (;;) {
          if (closed || generation !== seen) return;
          // Persist admission before dispatch. A timeout cannot cancel an already-admitted HTTP
          // write, so settle that same event before allowing the latest desired replacement.
          // Old four-field rows have unknown admission and are conservatively replayed in order.
          const live = await update(rows => {
            const queue = rows.filter(owned);
            const next = queue.find(row => row.admitted === true && row.superseded)
              ?? queue.find(row => row.admitted === true)
              ?? queue.find(row => row.admitted === undefined && row.superseded)
              ?? queue.find(row => row.admitted === undefined)
              ?? queue.find(row => !row.superseded);
            if (!next) return { rows, result: null };
            return { rows: rows.map(row => row === next ? { ...row, admitted: true } : row), result: { ...next, admitted: true } };
          });
          if (!live || closed || generation !== seen) return;
          if (!parseCommandEnvelope(live.envelope, 'participant').ok || !isVoteResponse(live.envelope.response)) { await box.clear(); return; }
          let receipt;
          try { receipt = await send(structuredClone(live.envelope)); } catch { return; }
          if (generation !== seen || closed) return;
          if (!TERMINAL.has(receipt?.receipt)) return;
          await update(rows => ({ rows: rows.filter(row => !owned(row) || row.envelope.clientEventId !== live.envelope.clientEventId && !(row.superseded && row.admitted === false && row.envelope.roundId === live.envelope.roundId)), result: null }));
          if (['locked', 'voided', 'removed', 'ended'].includes(receipt.receipt) || receipt.receipt === 'rejected' && ['round_voided', 'manual_room', 'unknown_round', 'unknown_participant', 'room_ended'].includes(receipt.reason)) {
            await update(rows => ({ rows: rows.filter(row => !owned(row) || row.envelope.roundId !== live.envelope.roundId), result: null }));
            onRoundClosed(live.envelope.roundId, receipt.receipt);
          }
        }
      };
      // Different tabs restoring the same participant queue share delivery admission. Without
      // browser mutual exclusion fail closed; Node-only unit stores have no other documents.
      flight = Promise.resolve().then(() => locks?.request
        ? locks.request(`case-vote-delivery:${roomId}:${participantId}`, drain)
        : typeof window === 'undefined' ? drain() : Promise.reject(new Error('Vote delivery unavailable'))
      ).finally(() => {
        flight = null;
        // A resume/refetch may arrive before the previous held delivery settles. Retain that
        // explicit request rather than losing it to coalescing; do not retry without a request.
        if (requested && !closed && generation === seen) { requested = false; return box.flush(); }
        requested = false;
      });
      return flight;
    },
    async clear() { generation++; await update(rows => ({ rows: rows.filter(row => !owned(row)), result: null })); },
    async close() { closed = true; generation++; },
  };
  return box;
}
