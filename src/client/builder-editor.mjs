let uiFieldSequence = 0;

const SAVE_COPY = Object.freeze({
  saved: 'Saved.',
  dirty: 'Unsaved changes.',
  saving: 'Saving this draft…',
  uncertain: 'Save status is uncertain. Reconcile this exact save before saving again.',
  conflict: 'A newer saved draft needs review. Both copies are kept.',
  conflict_read_failed: 'A newer saved revision exists but could not be loaded. Refresh before retrying.',
});

export function builderSaveStatusText(state) {
  const prefix = SAVE_COPY[state?.status] ?? 'Draft status is unavailable.';
  if (state?.status === 'saved' && Number.isSafeInteger(state.baseRevision)) return `Saved revision ${state.baseRevision}.`;
  if (state?.status === 'conflict' && Number.isSafeInteger(state.conflict?.revision)) return `${prefix} Saved revision ${state.conflict.revision}.`;
  return prefix;
}

/** A single live status node keeps text-only save feedback stable across updates. */
export function mountBuilderSaveStatus(container) {
  const doc = container?.ownerDocument;
  if (!doc) throw new TypeError('status container must belong to a document');
  const node = doc.createElement('p');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  container.append(node);
  return Object.freeze({ update: state => { node.textContent = builderSaveStatusText(state); }, destroy: () => { node.remove(); } });
}

/**
 * Create stable native inputs keyed by canonical field identity. Syncing readiness,
 * save status or unchanged values does not replace a focused control or its selection.
 */
export function mountKeyedNativeFields(container, { fields = [], onEdit = () => {}, onFocus = () => {} } = {}) {
  const doc = container?.ownerDocument;
  if (!doc) throw new TypeError('field container must belong to a document');
  const records = new Map();
  let destroyed = false;

  function makeRecord(field) {
    if (!field || typeof field.key !== 'string' || !field.key) throw new TypeError('each native field needs a stable key');
    if (field.type !== 'text' && field.type !== 'textarea') throw new TypeError('field type must be text or textarea');
    const id = `builder-native-field-${++uiFieldSequence}`;
    const wrapper = doc.createElement('div');
    const label = doc.createElement('label');
    const labelText = doc.createTextNode(String(field.label ?? ''));
    const input = doc.createElement(field.type === 'textarea' ? 'textarea' : 'input');
    const error = doc.createElement('p');
    const errorId = `${id}-error`;
    let composing = false;
    input.id = id;
    input.name = id;
    if (field.type === 'text') input.type = 'text';
    if (field.placeholder) input.placeholder = field.placeholder;
    label.htmlFor = id;
    label.append(labelText);
    error.id = errorId;
    error.hidden = true;
    error.className = 'field-error';
    input.setAttribute('aria-describedby', errorId);
    wrapper.append(label, input, error);
    const record = { key: field.key, wrapper, label, labelText, input, error, composing, type: field.type };
    record.compositionStart = () => { record.composing = true; };
    record.compositionEnd = () => { record.composing = false; onEdit(record.key, input.value, { composing: false }); };
    record.inputHandler = () => { if (!record.composing) onEdit(record.key, input.value, { composing: false }); };
    record.focusHandler = () => onFocus(record.key);
    input.addEventListener('compositionstart', record.compositionStart);
    input.addEventListener('compositionend', record.compositionEnd);
    input.addEventListener('input', record.inputHandler);
    input.addEventListener('focus', record.focusHandler);
    input.value = String(field.value ?? '');
    updateRecord(record, field);
    return record;
  }

  function updateRecord(record, field, force = false) {
    record.labelText.nodeValue = String(field.label ?? '');
    // An empty field whose placeholder says what it needs is not shown in red as well; Readiness still lists it.
    const errorText = Array.isArray(field.issues) && !(field.placeholder && !String(field.value ?? '')) ? field.issues.slice(0, 3).map(issue => String(issue?.message ?? 'This field needs attention.')).join(' ') : '';
    record.error.textContent = errorText;
    record.error.hidden = !errorText;
    if (errorText) record.input.setAttribute('aria-invalid', 'true');
    else record.input.removeAttribute('aria-invalid');
    const nextValue = String(field.value ?? '');
    const focused = doc.activeElement === record.input;
    // Never assign .value during focus/IME. Native selection and Undo remain attached to this node. A draft-history
    // step (force) is the exception: the field shows the restored value, keeping the caret where it still fits.
    if (!record.composing && (!focused || force) && record.input.value !== nextValue) {
      const at = focused ? Math.min(record.input.selectionStart ?? nextValue.length, nextValue.length) : null;
      record.input.value = nextValue;
      if (at !== null) try { record.input.setSelectionRange(at, at); } catch { /* not a text control */ }
    }
  }

  function sync(nextFields, { force = false } = {}) {
    if (destroyed) return;
    if (!Array.isArray(nextFields)) throw new TypeError('fields must be an array');
    const seen = new Set();
    const desired = [];
    for (const field of nextFields) {
      if (seen.has(field?.key)) throw new TypeError(`duplicate native field key: ${field?.key}`);
      seen.add(field?.key);
      let record = records.get(field.key);
      if (record && record.type !== field.type) {
        retire(record);
        records.delete(field.key);
        record = null;
      }
      if (!record) { record = makeRecord(field); records.set(field.key, record); }
      else updateRecord(record, field, force);
      desired.push(record);
    }
    for (const [key, record] of records) {
      if (!seen.has(key)) { record.wrapper.remove(); retire(record); records.delete(key); }
    }
    desired.forEach((record, index) => {
      const current = container.children[index] ?? null;
      if (current !== record.wrapper) container.insertBefore(record.wrapper, current);
    });
  }

  function retire(record) {
    record.input.removeEventListener('compositionstart', record.compositionStart);
    record.input.removeEventListener('compositionend', record.compositionEnd);
    record.input.removeEventListener('input', record.inputHandler);
    record.input.removeEventListener('focus', record.focusHandler);
    record.input.value = '';
    record.error.textContent = '';
    record.wrapper.remove();
  }

  function getField(key) { return records.get(key)?.input ?? null; }
  function focusField(key, { select = false } = {}) {
    const input = getField(key);
    if (!input) return false;
    input.focus();
    if (select) input.select();
    return true;
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const record of records.values()) retire(record);
    records.clear();
    container.replaceChildren();
  }

  sync(fields);
  return Object.freeze({ sync, getField, focusField, destroy });
}
