// Narrow pending-vote boundary shared by the wire and durable storage inventory.
// No participant catalogue, command table or renderer dependency reaches cleanup through it.
export const VOTE_WIRE_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/;
const KEYS = ['v', 'type', 'epoch', 'clientEventId', 'roundId', 'response'];
const bad = error => ({ ok: false, error });
export function parseVoteEnvelope(body, role = 'participant') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('not_an_object');
  if (body.v !== VOTE_WIRE_VERSION) return bad('wire_version');
  if (body.type !== 'vote') return bad('unknown_command');
  if (role !== 'participant') return bad('forbidden');
  if (!Number.isInteger(body.epoch) || body.epoch < 0) return bad('bad_epoch');
  if (!UUID.test(body.clientEventId ?? '')) return bad('bad_client_event_id');
  for (const key of Object.keys(body)) if (!KEYS.includes(key)) return bad(`unexpected_field:${key}`);
  const envelope = { ...body };
  if (envelope.response?.text !== undefined && (typeof envelope.response.text !== 'string' || UNSAFE.test(envelope.response.text))) return bad('unsafe_characters');
  if (!UUID.test(envelope.roundId ?? '')) return bad('bad_round_id');
  if (!envelope.response || typeof envelope.response !== 'object' || Array.isArray(envelope.response)) return bad('bad_response');
  return { ok: true, envelope };
}
