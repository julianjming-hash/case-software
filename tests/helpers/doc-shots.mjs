// Card screenshot folders under docs/cards are reviewed records, not test output. An ordinary run writes
// its captures to the ignored test-results/doc-shots/<folder>/; only CASE_REFRESH_DOC_SHOTS=1 rewrites
// the tracked copies, so a local run can no longer sweep unreviewed images into a commit (2026-10-18:
// sixty were swept into main across card 40, #308 and #310).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const refreshDocShots = process.env.CASE_REFRESH_DOC_SHOTS === '1';

/** Absolute directory for a card's screenshots, e.g. docShotsDir('12-screenshots'); created if missing. */
export function docShotsDir(folder) {
  const base = refreshDocShots ? `../../docs/cards/${folder}/` : `../../test-results/doc-shots/${folder}/`;
  const dir = fileURLToPath(new URL(base, import.meta.url));
  mkdirSync(dir, { recursive: true });
  return dir;
}
