// G09 spike: native fields, a contenteditable and a structural command share one chronological history.
import { createDraftHistory, bindHistoryKeys } from '../../src/client/builder-history.mjs';

const $ = id => document.getElementById(id);
const fields = { title: $('title'), scene: $('scene'), notes: $('notes') };
const valueOf = name => name === 'notes' ? fields.notes.textContent : fields[name].value;
let current = { document: { title: '', scene: '', notes: '', findings: [] }, authoringMetadata: { metadata_version: 1 } };
let composing = false;
const history = createDraftHistory({ onChange: state => {
  $('undo').disabled = !state.canUndo; $('redo').disabled = !state.canRedo;
  if (state.message) $('status').textContent = state.message;
} });

function commit(edit, options) {
  const before = current;
  current = structuredClone(current); edit(current.document);
  history.record(before, current, options);
}
// Text joins the canonical draft only outside composition; one composition is one step.
for (const [name, field] of Object.entries(fields)) {
  field.addEventListener('input', event => {
    if (composing || event.isComposing) return;
    commit(doc => { doc[name] = valueOf(name); }, { label: name, coalesceKey: name });
  });
  field.addEventListener('compositionstart', () => { composing = true; });
  field.addEventListener('compositionend', () => { composing = false; commit(doc => { doc[name] = valueOf(name); }, { label: name }); });
}
$('add').addEventListener('click', () => commit(doc => { doc.findings.push(`Finding ${doc.findings.length + 1}`); }, { label: 'Add finding' }));

// Applying a step rewrites only fields whose value differs, so focus and caret elsewhere stay put.
function show() {
  for (const name of Object.keys(fields)) if (valueOf(name) !== current.document[name]) {
    if (name === 'notes') fields.notes.textContent = current.document.notes; else fields[name].value = current.document[name];
  }
  $('findings').replaceChildren(...current.document.findings.map(text => Object.assign(document.createElement('li'), { textContent: text })));
}
const apply = result => { if (result.ok) { current = result.pair; show(); } else if (result.refused) $('status').textContent = result.refused; };
const undo = () => apply(history.undo(current)), redo = () => apply(history.redo(current));
$('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
bindHistoryKeys($('editor'), { undo, redo });
// Inspection hook for the local probe only.
window.historySpike = { state: () => structuredClone(current), history };
show();
