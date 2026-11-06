// Card 61: a ready Builder document whose decisions are ordinary questions (CASE-280): one Continue route each, no
// response-dependent mapping. `types[i]` sets decision i's interaction; decisions past the list keep their authored routes.
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../../src/shared/builder-document.mjs';
import { withOrdinaryMappings } from '../../src/shared/ordinary-question.mjs';

export function ordinaryQuestions(schema1, types) {
  const doc = convertSchema1ToBuilderDocument(structuredClone(schema1), { metadata_version: 1 }).candidate;
  types.forEach((type, index) => {
    const decision = doc.decisions[index], path = { ...decision.paths.find(item => item.next_beat_id) };
    Object.assign(path, { label: 'Continue', classification: 'discussion-prompt', continue_to_next: true, cue: 'Continue after discussion.' });
    for (const key of ['set_flags', 'clear_flags', 'terminal', 'recovery']) delete path[key];
    decision.interaction = type === 'free_text' ? { type, max_length: 300 } : { type, options: decision.interaction.options };
    decision.interpretation = 'facilitator'; delete decision.rules;
    decision.paths = [path]; decision.fallback_path_id = path.id;
  });
  for (const beat of doc.beats) delete beat.requires_flags;
  doc.required_capabilities = [...new Set([...doc.required_capabilities, 'human_interpretation', 'direct_continuation'])];
  const ready = withOrdinaryMappings(doc), checked = validateBuilderDocument(ready, { metadata_version: 1 }, { mode: 'ready' });
  if (!checked.ok) throw new Error(`ordinary-question fixture is not ready: ${JSON.stringify(checked.errors)}`);
  return ready;
}
