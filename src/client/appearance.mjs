// Appearance (card 29, CASE-166): Light, Dark or Auto, a local preference only. It is stored on this
// device (never sent anywhere), survives sign-out and room teardown (TEARDOWN_KEYS.preferences), and is
// applied before first paint by appearance-boot.mjs. Auto removes the attribute so the tokens follow the
// operating system, including live changes.
export const APPEARANCE_KEY = 'case:appearance';
export const APPEARANCES = Object.freeze(['light', 'dark', 'auto']);
const LABELS = { light: 'Light', dark: 'Dark', auto: 'Auto' };

const appearanceStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function readAppearance(storage = appearanceStorage()) {
  try { const value = storage?.getItem(APPEARANCE_KEY); return value === 'light' || value === 'dark' ? value : 'auto'; }
  catch { return 'auto'; }
}

/** Store and apply one choice. Returns the applied value. */
export function setAppearance(value, { storage = appearanceStorage(), root = globalThis.document?.documentElement } = {}) {
  const choice = APPEARANCES.includes(value) ? value : 'auto';
  try { if (choice === 'auto') storage?.removeItem(APPEARANCE_KEY); else storage?.setItem(APPEARANCE_KEY, choice); }
  catch { /* Storage blocked: the choice still applies to this page. */ }
  if (root) { if (choice === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', choice); }
  globalThis.dispatchEvent?.(new Event('case:appearance'));
  return choice;
}

/** The Appearance fieldset: three labelled radio cards. */
export function appearanceControl(doc = globalThis.document) {
  const fieldset = doc.createElement('fieldset'); fieldset.className = 'appearance';
  const legend = doc.createElement('legend'); legend.textContent = 'Appearance'; fieldset.append(legend);
  const choices = doc.createElement('div'); choices.className = 'appearance-choices';
  const current = readAppearance();
  for (const value of APPEARANCES) {
    const label = doc.createElement('label');
    const input = doc.createElement('input'); input.type = 'radio'; input.name = 'appearance'; input.value = value;
    input.checked = value === current;
    input.addEventListener('change', () => { if (input.checked) setAppearance(value); });
    label.dataset.swatch = value;
    label.append(input, LABELS[value]); choices.append(label);
  }
  const note = doc.createElement('p'); note.className = 'appearance-note'; note.textContent = 'Saved on this device only. The projector follows its own device.';
  fieldset.append(choices, note);
  return fieldset;
}
