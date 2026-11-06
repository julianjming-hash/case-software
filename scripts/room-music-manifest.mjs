// The room music the build admits (CASE-334): exactly the approved round8 library (CASE-333), nothing historical.
// `readRoomMusicManifest` checks the shipped inventory byte for byte. The authoring command that copies the approved assets
// in is scripts/sound/import-room-music.mjs (never run by a test or the build).
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MUSIC_DECISION_TRACKS, MUSIC_TEMPO } from '../src/shared/music-timeline.mjs';

export const ROOM_MUSIC_DIR = 'public/audio/room-music';
/** The approved sound source (CASE-333). */
export const ROOM_MUSIC_SOURCE_COMMIT = '4b46526acb37a729160e213619d1d1ae1b5637bf';
const PARTS = Object.freeze({ decision: ['low', 'mid', 'peak', 'zero'], lobby: ['low'], debrief: ['low'] });
const MAX_ASSET_BYTES = 1_048_576, MAX_TOTAL_BYTES = 20_000_000;
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
const bad = () => { throw new Error('invalid_room_music_manifest'); };
const finite = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

function checkAsset(asset, part, files) {
  if (!['bytes,durationS,file,leadInS,loopS,sha256', 'attackSkipS,bytes,durationS,file,leadInS,loopS,sha256'].includes(keys(asset))) bad();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1024 || asset.bytes > MAX_ASSET_BYTES) bad();
  if (!finite(asset.durationS, .5, 60) || !finite(asset.leadInS, 0, 10)) bad();
  if (part === 'zero' ? asset.loopS !== null || asset.attackSkipS !== 0 : !finite(asset.loopS, 4, 60) || Math.abs(asset.loopS - asset.durationS) > 1e-6 || 'attackSkipS' in asset) bad();
  const seen = files.get(asset.file);
  if (seen && (seen.sha256 !== asset.sha256 || seen.bytes !== asset.bytes)) bad();
  files.set(asset.file, { sha256: asset.sha256, bytes: asset.bytes });
}
/** Validate the shipped manifest's shape and its agreement with the shared tempo catalogue. Returns file → {sha256, bytes}. */
export function parseRoomMusicManifest(manifest) {
  if (keys(manifest) !== 'licence,source,sourceCommit,tracks,v' || manifest.v !== 1 || manifest.sourceCommit !== ROOM_MUSIC_SOURCE_COMMIT ||
      typeof manifest.source !== 'string' || manifest.source.length > 256 || manifest.licence !== 'CC0-1.0' || !Array.isArray(manifest.tracks)) bad();
  const files = new Map(), ids = new Set();
  for (const track of manifest.tracks) {
    if (keys(track) !== 'assets,bars,boosts,bpm,id,kind,loopS,meter,name' || ids.has(track.id) || !PARTS[track.kind] || typeof track.name !== 'string' || track.name.length > 60) bad();
    ids.add(track.id);
    if (keys(track.assets) !== [...PARTS[track.kind]].sort().join() || !Number.isInteger(track.meter) || !Number.isInteger(track.bars) || !finite(track.bpm, 40, 200)) bad();
    for (const part of PARTS[track.kind]) checkAsset(track.assets[part], part, files);
    if (!Array.isArray(track.boosts) || (track.kind === 'decision' ? track.boosts.length !== 2 : track.boosts.length !== 0)) bad();
    if (track.kind === 'decision') {
      const tempo = MUSIC_TEMPO[track.id];
      if (!tempo || tempo.meter !== track.meter || tempo.bars !== track.bars || tempo.bpm[0] !== track.bpm || tempo.loopS[0] !== track.loopS) bad();
      track.boosts.forEach((boost, index) => {
        if (keys(boost) !== 'assets,bpm,id,loopS' || boost.id !== `${track.id}-boost-${[125, 150][index]}` || tempo.bpm[index + 1] !== boost.bpm || tempo.loopS[index + 1] !== boost.loopS) bad();
        if (keys(boost.assets) !== 'low,mid,peak,zero' || boost.assets.zero.sha256 !== track.assets.zero.sha256) bad();
        for (const part of PARTS.decision) checkAsset(boost.assets[part], part, files);
      });
    }
  }
  const decisions = manifest.tracks.filter(track => track.kind === 'decision').map(track => track.id);
  if (decisions.join() !== MUSIC_DECISION_TRACKS.join() || manifest.tracks.filter(t => t.kind === 'lobby').length !== 1 || manifest.tracks.filter(t => t.kind === 'debrief').length !== 1) bad();
  if ([...files.values()].reduce((sum, file) => sum + file.bytes, 0) > MAX_TOTAL_BYTES) bad();
  return files;
}
/** Read and check the shipped directory: exactly the manifest's files, each with its recorded size, hash and MPEG audio sync. */
export async function readRoomMusicManifest(root) {
  const directory = join(root, ROOM_MUSIC_DIR), path = join(directory, 'manifest.json');
  if ((await stat(path)).size > 65_536) bad();
  const manifest = JSON.parse(await readFile(path, 'utf8')), files = parseRoomMusicManifest(manifest);
  const expected = ['LICENSE.txt', 'manifest.json', ...files.keys()].sort();
  if ((await readdir(directory)).sort().join() !== expected.join()) bad();
  for (const [file, entry] of files) {
    const bytes = await readFile(join(directory, file));
    const syncAt = bytes.toString('latin1', 0, 3) === 'ID3' ? 10 + ((bytes[6] & 127) << 21 | (bytes[7] & 127) << 14 | (bytes[8] & 127) << 7 | bytes[9] & 127) : 0;
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256 || bytes[syncAt] !== 0xff || (bytes[syncAt + 1] & 0xe0) !== 0xe0) bad();
  }
  if (!(await readFile(join(directory, 'LICENSE.txt'), 'utf8')).startsWith('Case room music (CASE-334)')) bad();
  return manifest;
}
