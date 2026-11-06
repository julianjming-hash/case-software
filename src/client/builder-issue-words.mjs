// A draft's case-wide problems in the author's words (round 28 P1-2, round 29 P1-2), shared by Readiness and the Run
// preview so neither shows the schema's own text ("Length must be 1–1200") without its field.
const CASE_NAMES = { title: ['Case title', 'Name the case'], summary: ['Case summary', 'Write the case summary'], audience: ['Audience', 'Name the audience'], setting: ['Setting', 'Name the setting'],
  duration_min: ['Teaching estimate', 'Set the teaching estimate'], learning_objectives: ['Learning objectives', 'Add a learning objective'], preparation_requirements: ['Private preparation requirements', 'Write the preparation requirements'] };

/** One field's problem in plain words: an empty required field says Required. */
export function fieldWords(message, value) {
  const text = String(message ?? ''), range = /length must be (\d+)[–-](\d+)/.exec(text), limit = /must be at most (\d+) characters/.exec(text)?.[1] ?? range?.[2];
  if (!String(value ?? '').trim() && (range?.[1] === '1' || /needs text|required|must have 1[–-]/i.test(text))) return 'Required.';
  if (limit && String(value ?? '').length > Number(limit)) return `Over the ${Number(limit).toLocaleString('en-GB')}-character limit.`;
  return text ? `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}` : 'This field needs attention.';
}

/** A case-wide field's or a source's problem, named ("Write the case summary"); null for anything else. */
export function caseWords(issue, document, metadata, plain = text => text) {
  const [, key, index, rest] = /^\/([a-z_]+)(?:\/(\d+))?(\/.*)?$/.exec(issue?.at ?? '') ?? [];
  if (key === 'sources' && index !== undefined) { const source = metadata?.sources?.[Number(index)]; return `Source ${Number(index) + 1}${source?.title ? ` “${source.title}”` : ''}: ${plain(issue.message)}`; }
  const names = CASE_NAMES[key]; if (!names || rest) return null;
  const objective = key === 'learning_objectives' && index !== undefined, name = objective ? `Learning objective ${Number(index) + 1}` : names[0];
  const value = objective ? document?.learning_objectives?.[Number(index)] : key === 'preparation_requirements' ? metadata?.preparation_requirements : document?.[key];
  const words = fieldWords(issue.message, Array.isArray(value) ? value.join('') : value);
  return words === 'Required.' ? (objective ? `Write ${name.toLowerCase()}` : names[1]) : `${name}: ${words.replace(/\.$/, '')}`;
}
