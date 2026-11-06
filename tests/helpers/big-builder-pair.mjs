// A large Builder draft for latency gates (BWR13 at the admitted caps): the given case repeated with fresh ids until it
// nears the byte, block and stage limits, still valid in preserve mode. Shared flags keep their ids.
import { uuidv7 } from '../../src/shared/ids.mjs';
import { validateBuilderDocument } from '../../src/shared/builder-document.mjs';
import { validateSlideParts } from '../../src/shared/slide-document.mjs';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const KEYS = ['beats', 'surfaces', 'decisions', 'blocks', 'compositions', 'clarifications'];
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

export function bigBuilderPair(pair, { target = 900_000 } = {}) {
  const big = structuredClone(pair), doc = big.document;
  let copies = 0;
  while (bytes(big) < target) {
    copies++;
    const ids = new Map(), fresh = id => { if (!ids.has(id)) ids.set(id, uuidv7()); return ids.get(id); };
    const part = Object.fromEntries(KEYS.map(key => [key, pair.document[key] ?? []]));
    let text = JSON.stringify(part).replace(UUID, fresh);
    for (const flag of pair.document.flags ?? []) text = text.split(fresh(flag.id)).join(flag.id);
    const copy = JSON.parse(text);
    for (const beat of copy.beats) if (beat.title) beat.title = `${beat.title} (copy ${copies})`;
    for (const key of KEYS) doc[key] = [...(doc[key] ?? []), ...copy[key]];
    if (bytes(big) > 1_000_000 || doc.blocks.length > 600 || doc.beats.length > 600) {
      for (const key of KEYS) doc[key] = doc[key].slice(0, doc[key].length - copy[key].length);
      copies--; break;
    }
  }
  const checked = validateBuilderDocument(big.document, big.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!checked.ok) throw new Error(`large fixture invalid: ${JSON.stringify(checked.errors.slice(0, 3))}`);
  return { pair: big, copies, bytes: bytes(big) };
}
