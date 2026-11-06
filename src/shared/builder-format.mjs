const unsafeText = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const issue = (code, at, message) => ({ code, at, message });
const ownKeys = (value, allowed) => Object.keys(value).filter(key => !allowed.includes(key));

/** Validate the bounded Case-owned paragraph/list/run value without transforming it. */
export function validateFormattedText(value, {
  at = '', maxBytes = 16 * 1024, maxBlocks = 64, maxItems = 256, maxRuns = 1024,
} = {}) {
  const issues = [];
  const add = (code, path, message) => issues.push(issue(code, path, message));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [issue('type', at, 'must be a formatted-text object')];
  for (const key of ownKeys(value, ['blocks'])) add('unknown_key', `${at}/${escapePointer(key)}`, 'unknown formatted-text field');
  if (!Array.isArray(value.blocks)) return [...issues, issue('type', `${at}/blocks`, 'must be an array')];
  if (value.blocks.length > maxBlocks) add('too_many_blocks', `${at}/blocks`, `must have at most ${maxBlocks} blocks`);
  let itemCount = 0;
  let runCount = 0;
  value.blocks.forEach((block, blockIndex) => {
    const blockAt = `${at}/blocks/${blockIndex}`;
    if (!block || typeof block !== 'object' || Array.isArray(block)) { add('type', blockAt, 'must be a block object'); return; }
    if (block.type === 'paragraph') {
      for (const key of ownKeys(block, ['type', 'runs'])) add('unknown_key', `${blockAt}/${escapePointer(key)}`, 'unknown paragraph field');
      validateRuns(block.runs, `${blockAt}/runs`);
    } else if (block.type === 'list') {
      for (const key of ownKeys(block, ['type', 'ordered', 'items'])) add('unknown_key', `${blockAt}/${escapePointer(key)}`, 'unknown list field');
      if (typeof block.ordered !== 'boolean') add('type', `${blockAt}/ordered`, 'must be a boolean');
      if (!Array.isArray(block.items)) { add('type', `${blockAt}/items`, 'must be an array'); return; }
      itemCount += block.items.length;
      if (itemCount > maxItems) add('too_many_items', `${blockAt}/items`, `formatted text must have at most ${maxItems} list items`);
      block.items.forEach((item, itemIndex) => {
        const itemAt = `${blockAt}/items/${itemIndex}`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) { add('type', itemAt, 'must be a list item object'); return; }
        for (const key of ownKeys(item, ['runs'])) add('unknown_key', `${itemAt}/${escapePointer(key)}`, 'unknown list-item field');
        validateRuns(item.runs, `${itemAt}/runs`);
      });
    } else add('enum', `${blockAt}/type`, 'must be paragraph or list');
  });
  if (byteLength(value) > maxBytes) add('too_large', at, `formatted text exceeds ${maxBytes} UTF-8 bytes`);
  return issues;

  function validateRuns(runs, path) {
    if (!Array.isArray(runs)) { add('type', path, 'must be an array of text runs'); return; }
    runCount += runs.length;
    if (runCount > maxRuns) add('too_many_runs', path, `formatted text must have at most ${maxRuns} runs`);
    runs.forEach((run, runIndex) => {
      const runAt = `${path}/${runIndex}`;
      if (!run || typeof run !== 'object' || Array.isArray(run)) { add('type', runAt, 'must be a text-run object'); return; }
      for (const key of ownKeys(run, ['text', 'bold'])) add('unknown_key', `${runAt}/${escapePointer(key)}`, 'unknown text-run field');
      if (typeof run.text !== 'string') add('type', `${runAt}/text`, 'must be a string');
      else if (unsafeText.test(run.text)) add('unsafe_characters', `${runAt}/text`, 'contains unsafe control or bidirectional characters');
      if (run.bold !== undefined && typeof run.bold !== 'boolean') add('type', `${runAt}/bold`, 'must be a boolean when present');
    });
  }
}

/** Plain-text view used only for limits/search; the canonical formatted value is never replaced. */
export function formattedTextPlainText(value) {
  if (!value || !Array.isArray(value.blocks)) return '';
  return value.blocks.map(block => block?.type === 'list'
    ? (Array.isArray(block.items) ? block.items.map(item => runsText(item?.runs)).join('\n') : '')
    : runsText(block?.runs)).join('\n');
}

function runsText(runs) { return Array.isArray(runs) ? runs.map(run => typeof run?.text === 'string' ? run.text : '').join('') : ''; }
function escapePointer(value) { return String(value).replaceAll('~', '~0').replaceAll('/', '~1'); }
