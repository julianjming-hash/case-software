// CASE-334: the shipped room music is exactly the approved round8 library (CASE-333), checked byte for byte; the build emits
// it lazily with hashed URLs and never precaches it; and the music scene follows public projector state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClient } from '../scripts/build-client.mjs';
import { parseRoomMusicManifest, readRoomMusicManifest, ROOM_MUSIC_DIR } from '../scripts/room-music-manifest.mjs';
import { ROOM_EFFECTS } from '../src/client/room-audio-map.mjs';
import { musicSceneForView, musicTimerForView } from '../src/client/room-audio-state.mjs';

const root = new URL('..', import.meta.url).pathname;
const shipped = JSON.parse(readFileSync(join(root, ROOM_MUSIC_DIR, 'manifest.json'), 'utf8'));
const approval = JSON.parse(readFileSync(join(root, 'tests/fixtures/room-music-approval.json'), 'utf8'));

test('[AS-200] the shipped library is the approved round8 library: six tracks, 42 files, 18,599,304 bytes', async () => {
  assert.equal(approval.decision, 'CASE-333'); assert.ok(shipped.sourceCommit.startsWith(approval.approvedSourceCommit));
  const profiles = tracks => tracks.flatMap(track => [track, ...(track.boosts ?? [])]);
  const pick = a => ({ sha256: a.sha256, bytes: a.bytes, durationS: a.durationS, loopS: a.loopS, leadInS: a.leadInS });
  const approved = profiles(approval.tracks), ours = profiles(shipped.tracks);
  assert.deepEqual(ours.map(p => p.id), approved.map(p => p.id), 'the same six tracks and their 125/150 profiles, in order');
  for (const [i, profile] of ours.entries()) for (const part of Object.keys(approved[i].assets))
    assert.deepEqual(pick(profile.assets[part]), pick(approved[i].assets[part]), `${profile.id} ${part}`);
  const files = await readRoomMusicManifest(root).then(parseRoomMusicManifest);
  assert.equal(files.size, 42);
  assert.equal([...files.values()].reduce((sum, f) => sum + f.bytes, 0), 18_599_304);
  assert.deepEqual(readdirSync(join(root, 'public/audio')).filter(name => !/\.(wav|json|txt)$/.test(name)), ['room-music'], 'no historical music directory ships');
});

test('[AS-200] the manifest and inventory checks refuse anything but the approved files', async () => {
  for (const change of [m => { m.extra = 1; }, m => { m.sourceCommit = '0'.repeat(40); }, m => { m.tracks[0].assets.low.file = '../x.mp3'; },
    m => { m.tracks[0].bpm = 107; }, m => { m.tracks[0].boosts[0].bpm = 120; },
    m => { m.tracks[0].boosts[0].assets.zero.sha256 = 'f'.repeat(64); }, m => { m.tracks.pop(); }, m => { m.tracks[0].assets.zero.attackSkipS = .15; },
    m => { m.tracks[4].kind = 'decision'; }, m => { m.licence = 'CC-BY-NC-4.0'; }]) {
    const value = structuredClone(shipped); change(value);
    assert.throws(() => parseRoomMusicManifest(value), /invalid_room_music_manifest/);
  }
  for (const mutate of [dir => writeFileSync(join(dir, 'historical.mp3'), 'x'), dir => { const p = join(dir, 'atlas-current-low.mp3'), b = readFileSync(p); b[4000] ^= 1; writeFileSync(p, b); },
    dir => writeFileSync(join(dir, 'LICENSE.txt'), 'unreviewed permission')]) {
    const temp = mkdtempSync(join(tmpdir(), 'case-room-music-')), dir = join(temp, ROOM_MUSIC_DIR);
    try {
      mkdirSync(dir, { recursive: true });
      for (const file of readdirSync(join(root, ROOM_MUSIC_DIR))) copyFileSync(join(root, ROOM_MUSIC_DIR, file), join(dir, file));
      await readRoomMusicManifest(temp); mutate(dir);
      await assert.rejects(readRoomMusicManifest(temp), /invalid_room_music_manifest/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
});

test('[AS-200] the real build emits the library lazily with hashed URLs, no hashes or sources, and precaches no audio', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'case-music-build-'));
  try {
    for (const directory of ['src/client', ROOM_MUSIC_DIR]) mkdirSync(join(temp, directory), { recursive: true });
    mkdirSync(join(temp, 'src/shared'), { recursive: true });
    copyFileSync(join(root, 'src/shared/music-catalogue.mjs'), join(temp, 'src/shared/music-catalogue.mjs'));
    copyFileSync(join(root, 'src/shared/music-timeline.mjs'), join(temp, 'src/shared/music-timeline.mjs'));
    writeFileSync(join(temp, 'public/index.html'), '<script type="module" src="../src/client/app.mjs"></script>');
    writeFileSync(join(temp, 'src/client/app.mjs'), "export const music = () => import('./room-music.mjs');\n");
    writeFileSync(join(temp, 'src/client/room-music.mjs'), "import { MUSIC_LIBRARY } from './music-assets.mjs'; export { MUSIC_LIBRARY };\n");
    copyFileSync(join(root, 'src/client/music-assets.mjs'), join(temp, 'src/client/music-assets.mjs'));
    writeFileSync(join(temp, 'src/client/sw.mjs'), "const name = '__CACHE_NAME__'; const files = /*__SHELL__*/[];");
    for (const file of readdirSync(join(root, ROOM_MUSIC_DIR))) copyFileSync(join(root, ROOM_MUSIC_DIR, file), join(temp, ROOM_MUSIC_DIR, file));
    const result = await buildClient({ root: temp });
    assert.ok(result.entries['room-music']);
    const file = result.hashedFiles.find(path => /^assets\/music-assets\.[a-f0-9]{64}\.mjs$/.test(path));
    const text = readFileSync(join(temp, 'dist', file), 'utf8'), library = JSON.parse(text.match(/Object.freeze\((.*)\);/)[1].replace(/\\x([0-9A-F]{2})/g, '\\u00$1')); // the build writes ASCII-escaped JS
    assert.deepEqual(library.tracks.map(t => t.id), shipped.tracks.map(t => t.id));
    const urls = library.tracks.flatMap(t => [t, ...t.boosts]).flatMap(p => Object.values(p.assets).map(a => a.url));
    assert.equal(new Set(urls).size, 42);
    for (const url of urls) assert.match(url, /^\/assets\/[a-z0-9-]+\.[a-f0-9]{64}\.mp3$/);
    assert.equal(library.tracks[0].boosts[1].bpm, 118.72); assert.equal(library.tracks[0].boosts[1].kind, 'decision');
    assert.doesNotMatch(text, /sha256|sourceCommit|caseDoc|displayName|clinical/);
    assert.equal(result.shell.some(path => /\.(wav|mp3)$/.test(path)), false);
    assert.doesNotMatch(readFileSync(join(temp, 'dist/sw.mjs'), 'utf8'), /\.mp3/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('[AS-200] the music scene follows the public view: lobby, the decision transport, debrief beds, silence elsewhere', () => {
  const transport = { trackId: 'side-street-developed', draw: 2, tier: 0, atMs: 1, originMs: 0 };
  const open = { phase: 'decision_open', decision: { decisionId: 'd', status: 'open' }, music: { choice: 'auto', intensity: 70, transport }, timer: { paused: false, endsAt: '2026-11-01T09:01:00.000Z' }, timerTotalS: 60 };
  assert.deepEqual(musicSceneForView({ phase: 'waiting' }), { kind: 'lobby' });
  assert.deepEqual(musicSceneForView(open), { kind: 'decision', decisionId: 'd', trackId: 'side-street-developed', closing: false, transport: { atMs: 1, tier: 0, originMs: 0 } });
  assert.equal(musicSceneForView({ ...open, music: { ...open.music, transport: { ...transport, closing: true } } }).closing, true);
  assert.equal(musicSceneForView({ ...open, music: undefined }), null, 'a server without CASE-334 leaves the decision silent');
  for (const kind of ['debrief', 'wrap_up']) assert.deepEqual(musicSceneForView({ phase: 'teaching', surface: { kind } }), { kind: 'debrief' });
  assert.deepEqual(musicSceneForView({ phase: 'debrief', surface: null }), { kind: 'debrief' });
  for (const view of [{ phase: 'reviewing' }, { phase: 'ended' }, { phase: 'live', surface: { kind: 'reflection' } }, { ...open, replay: true }, { ...open, decision: { ...open.decision, status: 'locked' } }, null])
    assert.equal(musicSceneForView(view), null, JSON.stringify(view));
  assert.deepEqual(musicTimerForView(open, 5), { paused: false, endsAtMs: Date.parse('2026-11-01T09:01:00.000Z'), totalS: 60, nowMs: 5 });
  assert.equal(musicTimerForView({ ...open, timer: null }, 5), null);
  assert.deepEqual(ROOM_EFFECTS, { decision_open: { semantic: 'material-revealed', source: 'material-revealed', gain: 1 }, reveal: { semantic: 'reveal-soft', source: 'material-revealed', gain: .5 } }, 'Effects are unchanged and have no time-up cue');
});
