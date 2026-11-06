// A render captures current options/handlers, while data-keep preserves the person's live combobox.
// The shared enhancer is injected by the console; this module owns only reconciliation and disposal.
const selector = '[data-console-select]';
const handlers = ['onchange', 'oninput', 'onkeydown', 'onclick'];
const rowsKey = native => JSON.stringify([...native.options].map(option =>
  [option.value, option.label, option.disabled, option.hasAttribute('selected')]));
export function createConsoleSelects(root, { enhance }) {
  const entries = new Map(); let pending = new Map(), closed = false;
  function prune() {
    for (const [native, entry] of entries) if (!root.contains(native)) {
      entry.control.dispose(); entries.delete(native);
    }
  }
  return {
    prepare(fresh) {
      if (closed) return;
      pending = new Map();
      for (const slot of fresh.querySelectorAll(selector)) {
        const native = slot.querySelector('select'); if (!native) continue;
        pending.set(slot.dataset.consoleSelect, { native, rows: rowsKey(native),
          observed: slot.dataset.selectionMode === 'observed',
          value: [...native.options].find(option => option.hasAttribute('selected'))?.value ?? native.value });
      }
    },
    sync() {
      if (closed) return; prune();
      for (const slot of root.querySelectorAll(selector)) {
        const native = slot.querySelector('select'), next = pending.get(slot.dataset.consoleSelect);
        if (!native || !next) continue;
        let entry = entries.get(native);
        const previous = native.value;
        const rowsChanged = !entry || entry.rows !== next.rows;
        const selectionChanged = next.observed && (!entry || entry.observedValue !== next.value);
        const disabledChanged = native.disabled !== next.native.disabled;
        if (rowsChanged) {
          native.replaceChildren(...[...next.native.options].map(option => option.cloneNode(true)));
          if ([...native.options].some(option => option.value === previous)) native.value = previous;
        }
        if (selectionChanged) native.value = next.value;
        if (disabledChanged) native.disabled = next.native.disabled;
        for (const handler of handlers) native[handler] = next.native[handler] ?? null;
        if (!entry) {
          entry = { control: enhance(native), rows: next.rows, observedValue: next.value };
          entries.set(native, entry);
          // Focus restoration must find the visible trigger, never the hidden native twin.
          native.removeAttribute('data-focus-key');
        }
        entry.rows = next.rows; entry.observedValue = next.value;
        if (rowsChanged || selectionChanged || disabledChanged) entry.control.update();
      }
      pending.clear(); prune();
    },
    dispose() {
      closed = true; pending.clear();
      for (const entry of entries.values()) entry.control.dispose(); entries.clear();
    },
  };
}
