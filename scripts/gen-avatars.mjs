// scripts/gen-avatars.mjs: generate the participant avatars ONCE, at dev time, from DiceBear's
// "Shadows" style (CC0 1.0, by DiceBear). The output is committed as static SVG files under
// prototypes/room/lib/avatars/, so no page ever calls the DiceBear HTTP API (participant privacy):
// the phone, console and projector load the vendored files from Case's own origin.
//
// The generator needs the DiceBear packages, which are NOT dependencies of Case. Install them
// without saving, run, and commit the result:
//
//   npm i --no-save @dicebear/core@10.7.0 @dicebear/styles@10.6.0
//   node scripts/gen-avatars.mjs
//
// The allow-list of ids and their spoken labels is src/shared/participant.mjs (AVATARS); this
// script renders exactly that list, so the two cannot drift. tests/avatars.test.mjs checks the files.
import { writeFileSync, mkdirSync } from 'node:fs';
import { AVATARS } from '../src/shared/participant.mjs';

let Avatar; let Style; let shadows;
try {
  ({ Avatar, Style } = await import('@dicebear/core'));
  shadows = (await import('@dicebear/styles/shadows.json', { with: { type: 'json' } })).default;
} catch {
  console.error('Install the generator packages first: npm i --no-save @dicebear/core@10.7.0 @dicebear/styles@10.6.0');
  process.exit(1);
}

const out = new URL('../prototypes/room/lib/avatars/', import.meta.url);
mkdirSync(out, { recursive: true });
const style = new Style(shadows);
for (const a of AVATARS) {
  const svg = new Avatar(style, {
    seed: a.id, size: 96, idRandomization: false,
    shouldersVariant: a.shoulders, headsVariant: a.head, topsVariant: a.top, topsProbability: 100,
    inkColor: [a.ink], backgroundColor: [a.background], rotate: 0,
  }).toString();
  writeFileSync(new URL(`${a.id}.svg`, out), `${svg}\n`);
}
console.log(`wrote ${AVATARS.length} avatars to ${out.pathname}`);
