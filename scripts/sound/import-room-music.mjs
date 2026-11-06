// Authoring command (CASE-334): copy the approved round8 library (CASE-333) from the audition source into the shipped
// public/audio/room-music, with its manifest and licence, then check it as the build will. Run by hand only:
//   node scripts/sound/import-room-music.mjs
import { readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoomMusicManifest, readRoomMusicManifest, ROOM_MUSIC_DIR, ROOM_MUSIC_SOURCE_COMMIT } from '../room-music-manifest.mjs';

async function importLibrary(root) {
  const library = JSON.parse(await readFile(join(root, 'prototypes/sound-stage/assets/library.json'), 'utf8'));
  const directory = join(root, ROOM_MUSIC_DIR); await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
  const named = new Map();
  const asset = async (profileId, part, source) => {
    const file = named.get(source.sha256) ?? `${profileId}-${part}.mp3`;
    if (!named.has(source.sha256)) { named.set(source.sha256, file); await copyFile(join(root, 'prototypes/sound-stage', source.file), join(directory, file)); }
    return { file, bytes: source.bytes, sha256: source.sha256, durationS: source.durationS, loopS: source.loopS, leadInS: source.leadInS,
      ...(part === 'zero' ? { attackSkipS: source.attackSkipS } : {}) };
  };
  const tracks = [];
  for (const track of library.tracks) {
    const assets = async profile => Object.fromEntries(await Promise.all(Object.entries(profile.assets).map(async ([part, a]) => [part, await asset(profile.id, part, a)])));
    tracks.push({ id: track.id, name: track.name, kind: track.kind, bpm: track.bpm, meter: track.meter, bars: track.bars, loopS: track.loopS, assets: await assets(track),
      boosts: await Promise.all((track.boosts ?? []).map(async boost => ({ id: boost.id, bpm: boost.bpm, loopS: boost.loopS, assets: await assets(boost) }))) });
  }
  const manifest = { v: 1, source: `prototypes/sound-stage/assets/library.json v${library.version}, approved round8 (CASE-333)`, sourceCommit: ROOM_MUSIC_SOURCE_COMMIT, licence: 'CC0-1.0', tracks };
  parseRoomMusicManifest(manifest);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  await writeFile(join(directory, 'LICENSE.txt'), `Case room music (CASE-334): the approved Card 69 round8 library (CASE-333), CC0 1.0 Universal (CC0-1.0).
The author dedicates these original compositions and recordings to the public domain under CC0 1.0.
Source recordings: Versilian Community Sample Library (Versilian Studios LLC), CC0-1.0;
Karoryfer Shinyguitar and Swagbass (Karoryfer Samples), CC0-1.0.
Pinned source revisions, individual paths, hashes and licensing evidence: prototypes/sound-stage/sources/manifest.json.
Offline generators: scripts/sound/. Rendered and approved at ${ROOM_MUSIC_SOURCE_COMMIT}.
CC0 legal text: https://creativecommons.org/publicdomain/zero/1.0/legalcode
`);
  await readRoomMusicManifest(root);
  return { files: named.size, bytes: [...new Set(tracks.flatMap(t => [t, ...t.boosts]).flatMap(p => Object.values(p.assets)).map(a => `${a.sha256}:${a.bytes}`))].reduce((sum, key) => sum + Number(key.split(':')[1]), 0) };
}
console.log(await importLibrary(join(dirname(fileURLToPath(import.meta.url)), '../..')));
