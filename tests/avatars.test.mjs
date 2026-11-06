// The participant avatars (CASE-119, CASE-120): exactly the allow-listed ids, vendored as static files
// from DiceBear's CC0 "Shadows" style, inert SVG only, and never fetched from DiceBear at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { AVATARS, AVATAR_IDS, AVATAR_COLORS, AVATAR_SHAPES, customAvatarId, avatarParts, avatarLabel, isAvatarId, displayNameProblem, normaliseDisplayName, NAME_MIN, NAME_MAX } from '../src/shared/participant.mjs';

import { parseJoinRequest, parseCommandEnvelope } from '../src/shared/wire.mjs';
import { initialState, reduce, project } from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const DIR = new URL('../prototypes/room/lib/avatars/', import.meta.url);
const files = readdirSync(DIR).sort();

test('[AS-062] the original 16 avatars and exactly 128 colour variants are vendored and allow-listed', () => {
  assert.deepEqual(AVATARS.map((a) => a.id), Array.from({ length: 16 }, (_, i) => `shadows-${String(i + 1).padStart(2, '0')}`));
  assert.equal(AVATAR_SHAPES, AVATARS);
  assert.equal(AVATAR_COLORS.length, 8);
  assert.equal(new Set(AVATAR_COLORS.map((c) => c.id)).size, 8);
  assert.equal(AVATAR_IDS.length, 144);
  assert.equal(new Set(AVATAR_IDS).size, 144);
  assert.deepEqual(files, AVATAR_IDS.map((id) => `${id}.svg`).sort());
  assert.equal(new Set(AVATARS.map((a) => a.label)).size, 16, 'every avatar has its own spoken label');
  assert.ok(isAvatarId('shadows-01') && !isAvatarId('shadows-17') && !isAvatarId(undefined));
});

test('[AS-062] each avatar is inert SVG from the CC0 Shadows style, with its licence kept in the file', () => {
  for (const f of files) {
    const svg = readFileSync(new URL(f, DIR), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100"/, f);
    assert.match(svg, /<dc:title>Shadows<\/dc:title>/, `${f}: DiceBear Shadows style`);
    assert.match(svg, /creativecommons\.org\/publicdomain\/zero\/1\.0/, `${f}: CC0 1.0 licence metadata kept`);
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|\son[a-z]+=|javascript:|href="(?!#)/i, `${f}: no script, embedded content or external reference`);
  }
});

test('[AS-062] no page or module loads avatars from the DiceBear HTTP API (privacy, CASE-120)', () => {
  const roots = ['../prototypes/room/', '../prototypes/room/lib/', '../src/shared/', '../src/client/', '../src/worker/'];
  for (const r of roots) {
    const dir = new URL(r, import.meta.url);
    for (const f of readdirSync(dir).filter((x) => /\.(html|mjs|css)$/.test(x))) {
      assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /api\.dicebear\.com/, `${r}${f}`);
    }
  }
});

test('[AS-062] display-name rules: required, 3-20 after trimming, letters, numbers, spaces, hyphens, apostrophes', () => {
  assert.equal(NAME_MIN, 3);
  assert.equal(NAME_MAX, 20);
  assert.equal(normaliseDisplayName('  Mary   Jane  '), 'Mary Jane');
  assert.equal(displayNameProblem(''), 'required');
  assert.equal(displayNameProblem('  '), 'required');
  assert.equal(displayNameProblem('Jo'), 'too_short');
  assert.equal(displayNameProblem(' Jo '), 'too_short', 'trimmed before counting');
  assert.equal(displayNameProblem('Bartholomew Fitzgerald'), 'too_long');
  assert.equal(displayNameProblem('Sam :)'), 'characters');
  assert.equal(displayNameProblem("--'"), 'characters', 'needs a letter or number');
  for (const ok of ['Sam', "D'Arcy", 'Mei-Ling', 'Zoë', 'R2 D2', 'Анна', '김민준']) assert.equal(displayNameProblem(ok), null, ok);
});

const normalizeColors = (svg) => svg.replace(/#[0-9a-f]{6}/gi, '#COLOR');
test('avatar variants preserve every original silhouette with independent allow-listed colours', () => {
  for (const shape of AVATAR_SHAPES) {
    const original = readFileSync(new URL(`${shape.id}.svg`, DIR), 'utf8');
    assert.ok(avatarParts(shape.id), 'original ids remain editable');
    for (const color of AVATAR_COLORS) {
      const id = customAvatarId(shape.id, color.id);
      assert.equal(id, `${shape.id}-${color.id}`);
      assert.ok(isAvatarId(id));
      assert.deepEqual(avatarParts(id), { shapeId: shape.id, colorId: color.id });
      assert.equal(avatarLabel(id), `${color.label}, ${shape.label.split(', ')[1]}`);
      const svg = readFileSync(new URL(`${id}.svg`, DIR), 'utf8');
      assert.equal(normalizeColors(svg), normalizeColors(original), id);
      assert.ok(svg.includes(`fill="${color.ink}"`) && svg.includes(`fill="${color.background}"`), id);
    }
  }
  for (const id of ['shadows-01-red', 'shadows-17-wine', '../shadows-01', 'shadows-01-WINE', '', null, 1]) {
    assert.equal(isAvatarId(id), false);
    assert.equal(avatarParts(id), null);
  }
  assert.equal(customAvatarId('shadows-17', 'wine'), null);
  assert.equal(customAvatarId('shadows-01', '../wine'), null);
});

test('join, rename and reducer projections carry only allow-listed avatar variants', () => {
  const variant = customAvatarId('shadows-16', 'teal');
  assert.ok(parseJoinRequest({ v: 1, code: '7K3QX9', displayName: 'Sam', avatarId: variant }).ok);
  const envelope = (avatarId) => ({ v: 1, type: 'rename', epoch: 0, clientEventId: uuidv7(), displayName: 'Sam', avatarId });
  assert.ok(parseCommandEnvelope(envelope(variant), 'participant').ok);
  assert.equal(parseCommandEnvelope(envelope('shadows-16-red'), 'participant').error, 'bad_avatar');
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: miniCase().doc });
  const actor = { role: 'participant', id: uuidv7() };
  const event = { epoch: 0, actor, at: '2026-10-02T01:00:00Z', displayName: 'Sam' };
  state = reduce(state, { ...event, type: 'join', avatarId: 'shadows-01' }).state;
  state = reduce(state, { ...event, type: 'rename', avatarId: variant }).state;
  assert.equal(project(state, 'participant', actor.id).you.avatarId, variant);
  assert.deepEqual(project(state, 'display').names, [{ name: 'Sam', avatarId: variant }]);
  assert.equal(project(state, 'display').avatars, null, 'lobby names already carry the avatar; do not duplicate the roster');
  assert.equal(project(state, 'facilitator').participants[0].avatarId, variant);
  state = reduce(state, { ...event, type: 'rename', avatarId: '../shadows-01.svg' }).state;
  assert.equal(project(state, 'participant', actor.id).you.avatarId, null);
});
