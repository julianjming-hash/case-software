import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { parseVoteEnvelope, VOTE_WIRE_VERSION } from '../src/shared/vote-envelope.mjs';
import { parseCommandEnvelope } from '../src/shared/wire.mjs';
import { parseCommandEnvelope as original } from './helpers/legacy-wire-83158a8.mjs';
const valid = () => ({ v: 1, type: 'vote', epoch: 0, clientEventId: uuidv7(), roundId: uuidv7(), response: { option_id: uuidv7() } });

test('narrow vote parsing is byte-equivalent to original wire success/error ordering', () => {
  const values = [null, undefined, false, 0, '', [], {}, valid(), { ...valid(), response: { text: 'Written answer' } }];
  const bads = [null, undefined, false, 0, -1, 1.5, '', [], {}, 'not-a-uuid', '\u0000', 'x\u202ey'];
  for (const key of ['v', 'epoch', 'clientEventId', 'roundId', 'response']) {
    for (const bad of bads) values.push({ ...valid(), [key]: bad });
    const omitted = valid(); delete omitted[key]; values.push(omitted);
  }
  for (const bad of bads) values.push({ ...valid(), response: { text: bad }, roundId: 'bad' });
  for (const key of ['actor', 'at', 'expectRevision', 'responseId', 'sourceRound', 'seedResponseIds', 'name']) values.push({ ...valid(), [key]: 'private' });
  values.push({ ...valid(), v: 2, actor: 'bad', epoch: -1 });
  for (const value of values) {
    // Specialized parser's supported input is a vote (including every malformed vote shape).
    if (value && typeof value === 'object' && !Array.isArray(value) && value.type !== 'vote') continue;
    for (const role of ['participant', 'facilitator', 'display']) {
      assert.deepEqual(parseVoteEnvelope(value, role), original(value, role));
      assert.deepEqual(parseCommandEnvelope(value, role), original(value, role));
    }
  }
  assert.equal(VOTE_WIRE_VERSION, 1);
});

test('deterministic malformed-vote combinations preserve original first-error priority', () => {
  const alternatives = [undefined, null, -1, [], {}, 'invalid'];
  for (let n = 0; n < 1000; n++) {
    const value = valid();
    if (n % 2 === 0) value.epoch = alternatives[n % alternatives.length];
    if (n % 3 === 0) value.clientEventId = alternatives[Math.floor(n / 3) % alternatives.length];
    if (n % 5 === 0) value.roundId = alternatives[Math.floor(n / 5) % alternatives.length];
    if (n % 7 === 0) value.response = { text: alternatives[Math.floor(n / 7) % alternatives.length] };
    if (n % 11 === 0) value.privateField = true;
    assert.deepEqual(parseVoteEnvelope(value), original(value, 'participant'));
  }
});
