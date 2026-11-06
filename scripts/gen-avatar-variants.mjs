// scripts/gen-avatar-variants.mjs: recolour vendored Shadows SVGs locally, preserving their geometry
// and CC0 metadata. No packages or HTTP calls: run after gen-avatars.mjs when originals change.
import { readFileSync, writeFileSync } from 'node:fs';
import { AVATAR_SHAPES, AVATAR_COLORS, customAvatarId } from '../src/shared/participant.mjs';

const out = new URL('../prototypes/room/lib/avatars/', import.meta.url);
for (const shape of AVATAR_SHAPES) {
  const original = readFileSync(new URL(`${shape.id}.svg`, out), 'utf8');
  for (const color of AVATAR_COLORS) {
    const svg = original.replaceAll(`fill="${shape.ink}"`, `fill="${color.ink}"`)
      .replaceAll(`fill="${shape.background}"`, `fill="${color.background}"`);
    writeFileSync(new URL(`${customAvatarId(shape.id, color.id)}.svg`, out), svg);
  }
}
console.log(`wrote ${AVATAR_SHAPES.length * AVATAR_COLORS.length} static colour variants`);
