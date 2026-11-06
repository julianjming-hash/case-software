// Authority-only durable private evidence. No client imports, network calls or persistent cache.
import { isUuid, isUuidV7 } from '../shared/ids.mjs';
import { validateRankedGroups } from '../shared/ranked-groups.mjs';
import { recapPhase } from '../shared/room-machine.mjs';
export class EvidenceIncomplete extends Error {}
const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
// Persisted aggregate text is untrusted even when the round's control fields match.
// Older closures contain only total/counts; ranking extensions remain optional.
function validAggregate(aggregate, decision = null) {
  if (!object(aggregate) || !bounded(aggregate.total, 300) || !object(aggregate.counts)) return false;
  if (Object.keys(aggregate).some(key => !['total','counts','rankCount','eligibleOptionIds','positionCounts','completeOrders'].includes(key))) return false;
  const options = decision?.interaction.options?.map(option => option.id) ?? null;
  const validId = id => isUuid(id) && (!options || options.includes(id));
  const ids = Object.keys(aggregate.counts);
  if (ids.length > 8 || !ids.every(validId) || !Object.values(aggregate.counts).every(count => bounded(count, aggregate.total))) return false;
  if (Object.hasOwn(aggregate, 'rankCount') && !bounded(aggregate.rankCount, 8)) return false;
  if (Object.hasOwn(aggregate, 'eligibleOptionIds') && (!Array.isArray(aggregate.eligibleOptionIds) || aggregate.eligibleOptionIds.length > 8 ||
      new Set(aggregate.eligibleOptionIds).size !== aggregate.eligibleOptionIds.length || !aggregate.eligibleOptionIds.every(validId) ||
      Object.hasOwn(aggregate, 'rankCount') && aggregate.rankCount > aggregate.eligibleOptionIds.length)) return false;
  if (Object.hasOwn(aggregate, 'positionCounts')) {
    if (!object(aggregate.positionCounts) || Object.keys(aggregate.positionCounts).length > 8) return false;
    for (const [id, positions] of Object.entries(aggregate.positionCounts)) {
      if (!validId(id) || !Array.isArray(positions) || positions.length > 8 ||
          Object.hasOwn(aggregate, 'rankCount') && positions.length !== aggregate.rankCount ||
          !positions.every(count => bounded(count, aggregate.total))) return false;
    }
  }
  if (Object.hasOwn(aggregate, 'completeOrders') && !validateRankedGroups(aggregate.completeOrders, {
    optionCount: options?.length ?? 8, rankCount: aggregate.rankCount, total: aggregate.total,
    ...(options && aggregate.eligibleOptionIds ? { eligibleIndices: aggregate.eligibleOptionIds.map(id => options.indexOf(id)) }
      : aggregate.rankCount === 0 ? { eligibleIndices: [] } : {}),
  })) return false;
  return true;
}
export function compactRoomState(state) {
  return { ...state, evidenceStateVersion: 1, rounds: state.rounds.map(round => {
    const { answers, responses, aggregate, suggestion, ...control } = round;
    return { ...control, evidenceRef: 1 };
  }) };
}

export function readRoundEvidence(sql, roundId, decision = null) {
  try {
  const round = rows(sql, 'SELECT * FROM rounds WHERE id=?', roundId)[0];
  if (!round || !isUuidV7(round.id) || !isUuidV7(round.decision_id) || !Number.isSafeInteger(round.round_no) || round.round_no < 1 ||
      !['open','locked','resolved','superseded','abandoned'].includes(round.status) || !timestamp(round.opened_at) ||
      (round.locked_at !== null && !timestamp(round.locked_at)) || (round.closed_at !== null && !timestamp(round.closed_at))) return null;
  if (round.status === 'locked' && round.locked_at === null) return null;
  if (['resolved','superseded','abandoned'].includes(round.status) && round.closed_at === null) return null;
  if (round.status === 'resolved' && (!isUuidV7(round.selected_path_id) || !['majority','minority','override','manual_room'].includes(round.resolution_kind))) return null;
  if (rows(sql, 'SELECT 1 FROM response_evidence_keys k LEFT JOIN responses r ON r.id=k.response_id AND r.round_id=k.round_id AND r.participant_id=k.participant_id WHERE k.round_id=? AND r.id IS NULL LIMIT 1', roundId).length) return null;
  const responseRows = rows(sql, 'SELECT * FROM responses WHERE round_id=?', roundId);
  for (const row of responseRows) {
    if (!isUuidV7(row.id) || !isUuidV7(row.participant_id) || !isUuidV7(row.last_client_event_id) ||
        !timestamp(row.first_submitted_at) || !timestamp(row.last_submitted_at) || Date.parse(row.first_submitted_at) > Date.parse(row.last_submitted_at) || !object(JSON.parse(row.response))) return null;
    const seed = [row.source_response_id,row.source_round_id,row.source_client_event_id,row.correction_event_id,row.seeded_at];
    if (seed.some(value => value !== null) && (!seed.slice(0,4).every(isUuidV7) || !timestamp(seed[4]) || row.source_response_id === row.id || row.source_round_id === roundId)) return null;
  }
  const aggregate = round.aggregate === null ? null : JSON.parse(round.aggregate);
  if (aggregate !== null && !validAggregate(aggregate, decision)) return null;
  const responses = Object.fromEntries(responseRows.map(row => [row.participant_id, {
    id: row.id, response: JSON.parse(row.response), clientEventId: row.last_client_event_id,
    firstAt: row.first_submitted_at, lastAt: row.last_submitted_at,
    ...(row.source_response_id ? { seed: { sourceResponseId: row.source_response_id,
      sourceRoundId: row.source_round_id, sourceClientEventId: row.source_client_event_id,
      correctionEventId: row.correction_event_id, seededAt: row.seeded_at } } : {}),
  }]));
  return { id: round.id, decisionId: round.decision_id, no: round.round_no, status: round.status,
    openedAt: round.opened_at, lockedAt: round.locked_at, closedAt: round.closed_at,
    aggregate,
    selectedPathId: round.selected_path_id, resolutionKind: round.resolution_kind, responses };
  } catch { return null; }
}

export function hydrateRoomPresentation(sql, state, participantId = null) {
  const latest = [...state.rounds].reverse().find(round => round.status === 'resolved');
  return { ...state, rounds: state.rounds.map(round => {
    if (!round.evidenceRef) return round;
    let aggregate = null;
    if (round.id === latest?.id) {
      const found = rows(sql, 'SELECT aggregate FROM rounds WHERE id=?', round.id)[0];
      if (!found || found.aggregate === null) throw new EvidenceIncomplete();
      try { aggregate = JSON.parse(found.aggregate); } catch { throw new EvidenceIncomplete(); }
      if (!validAggregate(aggregate, state.caseDoc.decisions.find(decision => decision.id === round.decisionId))) throw new EvidenceIncomplete();
    }
    let answers = {};
    // Every round's own answer wherever the phone gets its recap (Debrief and End), else only the latest's.
    if (participantId && (recapPhase(state.phase) || round.id === latest?.id)) {
      const found = rows(sql, 'SELECT response FROM responses WHERE round_id=? AND participant_id=?', round.id, participantId)[0];
      const expected = rows(sql, 'SELECT 1 FROM response_evidence_keys WHERE round_id=? AND participant_id=?', round.id, participantId).length;
      if (expected && !found) throw new EvidenceIncomplete();
      if (found) { try { answers = { [participantId]: JSON.parse(found.response) }; } catch { throw new EvidenceIncomplete(); } }
    }
    return { ...round, aggregate, answers };
  }) };
}

/** An upgrade never replaces missing legacy records with invented events/timestamps. */
export function verifyLegacyEvidence(sql, state) {
  for (const round of state.rounds) {
    if (round.evidenceRef) continue;
    const evidence = readRoundEvidence(sql, round.id, state.caseDoc.decisions.find(decision => decision.id === round.decisionId));
    if (!sameControl(round, evidence) || JSON.stringify(evidence.aggregate) !== JSON.stringify(round.aggregate ?? null)) return false;
    for (const [pid, answer] of Object.entries(round.answers ?? {})) {
      if (JSON.stringify(evidence.responses[pid]?.response) !== JSON.stringify(answer)) return false;
    }
  }
  return true;
}
function sameControl(round, evidence) {
  return Boolean(evidence && ['id','decisionId','no','status','openedAt','lockedAt','closedAt','selectedPathId','resolutionKind'].every(key => (round[key] ?? null) === (evidence[key] ?? null)));
}
export function verifyCompactEvidence(sql, state) {
  if (!state.rounds.every(round => !round.evidenceRef || sameControl(round, readRoundEvidence(sql, round.id,
    state.caseDoc.decisions.find(decision => decision.id === round.decisionId))))) return false;
  if (state.round) {
    const evidence = readRoundEvidence(sql, state.round.id, state.caseDoc.decisions.find(decision => decision.id === state.round.decisionId));
    if (!sameControl(state.round, evidence) || JSON.stringify(evidence.aggregate) !== JSON.stringify(state.round.aggregate ?? null)) return false;
    for (const [pid, expected] of Object.entries(state.round.responses)) {
      const actual = evidence.responses[pid];
      if (!actual || ['id','clientEventId','firstAt','lastAt'].some(key => actual[key] !== expected[key]) || JSON.stringify(actual.response) !== JSON.stringify(expected.response)) return false;
    }
  }
  return true;
}
