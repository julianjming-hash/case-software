// Select-only combobox: the hidden native select retains its value, form name and change contract.
// Arrow navigation previews choices; Enter/Space or a pointer commits once. Escape never changes it.
import { compactTool } from './ui-icons.mjs';
import { sharedPopup } from './shared-popup.mjs';
import { iconNodes } from '../shared/icons.mjs';
const instances = new WeakMap();
let ids = 0;
const tones = new Set(['ok', 'warn', 'bad', 'private', 'muted']);
/** Bounded decoration only: the native option remains the value, label and disabled-state authority. */
export function selectPresentation(option) {
  const data = option.dataset ?? {};
  return { description: typeof data.description === 'string' ? [...data.description.trim()].slice(0, 240).join('') : '',
    tone: tones.has(data.tone) ? data.tone : null, icon: iconNodes(data.icon) ? data.icon : null };
}
function decoration(doc, option) {
  const parts = [];
  if (option.tone) {
    const dot = doc.createElement('span'); dot.className = 'shared-choice-dot'; dot.dataset.tone = option.tone;
    dot.setAttribute('aria-hidden', 'true'); parts.push(dot);
  }
  if (option.icon) {
    const ns = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    for (const [tag, attributes] of iconNodes(option.icon)) { const node = doc.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); svg.append(node); }
    svg.classList.add('shared-choice-icon'); parts.push(svg);
  }
  return parts;
}
export function moveChoice(options, current, direction) {
  if (!options.some(option => !option.disabled)) return -1;
  if (current < 0 && direction < 0) current = 0;
  for (let step = 1; step <= options.length; step++) {
    const index = (current + direction * step + options.length * 2) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}
export function searchChoice(options, current, text) {
  const prefix = text.toLocaleLowerCase();
  for (let step = 1; step <= options.length; step++) {
    const index = (current + step + options.length) % options.length;
    if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(prefix)) return index;
  }
  return current;
}
export function enhanceSelect(native, { label, tool = null } = {}) {
  if (instances.has(native)) return instances.get(native);
  if (native.multiple || native.size > 1) throw new Error('select_only_required');
  const doc = native.ownerDocument, trigger = doc.createElement('button'), panel = doc.createElement('div');
  const originalId = native.id, originalHidden = native.hidden, serial = ++ids;
  trigger.type = 'button'; trigger.className = `${native.className} shared-select-trigger`;
  trigger.id = originalId || `shared-select-${serial}`; native.id = `${trigger.id}-native`; native.hidden = true;
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false'); panel.id = `shared-options-${serial}`;
  panel.className = 'shared-select-options'; panel.setAttribute('role', 'listbox');
  trigger.setAttribute('aria-controls', panel.id);
  const name = label ?? native.getAttribute('aria-label');
  const toolName=tool??(native.closest('.admin-toolbar,.studio-admin-toolbar,.workbench-tools,.workbench-scope,.library-head,.portfolio-filters,.portfolio-tools,.toolbar,.studio-toolbar')?(/workspace/i.test(name??'')?'workspace':/status|access|role/i.test(name??'')?'status':/sort/i.test(name??'')?'sort':'filters'):null);
  const toolLabel=toolName&&native.parentElement?.tagName==='LABEL'?native.parentElement:null,hadToolLabel=toolLabel?.classList.contains('tool-field');toolLabel?.classList.add('tool-field');
  if (name) { trigger.setAttribute('aria-label', name); panel.setAttribute('aria-label', name); }
  for (const key of ['aria-labelledby', 'aria-describedby', 'data-focus-key']) {
    const value = native.getAttribute(key); if (value) trigger.setAttribute(key, value);
  }
  native.after(trigger);
  let options = [], rows = [], focused = -1, prefix = '', typedAt = 0, disposed = false;
  const popup = sharedPopup(trigger, panel, () => {
    trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant'); prefix = '';
  });
  function mark(index) {
    focused = index;
    for (const [i, row] of rows.entries()) {
      row.classList.toggle('active', i === index); row.setAttribute('aria-selected', String(i === native.selectedIndex));
    }
    if (index >= 0) {
      trigger.setAttribute('aria-activedescendant', rows[index].id);
      rows[index].scrollIntoView({ block: 'nearest' });
    } else trigger.removeAttribute('aria-activedescendant');
  }
  function update() {
    if (disposed) return;
    options = [...native.options].map(option => ({ label: option.label, value: option.value, ...selectPresentation(option),
      group: option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null,
      disabled: option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled) }));
    trigger.disabled = native.disabled || !options.some(option => !option.disabled);
    const selected = options[native.selectedIndex], text = doc.createElement('span');
    text.className = 'shared-select-value'; text.textContent = selected?.label ?? 'Choose…';
    trigger.replaceChildren(...(selected ? decoration(doc, selected) : []), text);
    if(toolName){compactTool(trigger,toolName,{label:name??'Choose',value:selected?.label??'Choose…',active:native.selectedIndex>0});trigger.setAttribute('aria-description',selected?.label??'Choose…');}
    if (trigger.disabled) popup.close();
    if (popup.opened) render();
  }
  function commit(index) {
    if (native.disabled || !options[index] || options[index].disabled) return;
    const changed = native.selectedIndex !== index;
    native.selectedIndex = index; popup.close(); update(); trigger.focus();
    if (changed) native.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  }
  function render() {
    rows = []; panel.replaceChildren(); const groups = new Map();
    for (const [index, option] of options.entries()) {
      let host = panel;
      if (option.group) {
        if (!groups.has(option.group)) {
          const group = doc.createElement('div'), heading = doc.createElement('div');
          heading.className = 'shared-choice-group-title'; heading.id = `${panel.id}-group-${groups.size}`;
          heading.textContent = option.group.label || 'Other choices'; heading.setAttribute('aria-hidden', 'true');
          group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', heading.id); group.append(heading);
          groups.set(option.group, group); panel.append(group);
        }
        host = groups.get(option.group);
      }
      const row = doc.createElement('div'); row.id = `${panel.id}-${index}`;
      const copy = doc.createElement('span'), title = doc.createElement('span'); copy.className = 'shared-choice-copy';
      title.id = `${row.id}-label`; title.textContent = option.label; copy.append(title);
      row.setAttribute('aria-labelledby', title.id);
      if (option.description) {
        const description = doc.createElement('span'); description.className = 'shared-choice-description'; description.id = `${row.id}-description`;
        description.textContent = option.description; copy.append(description); row.setAttribute('aria-describedby', description.id);
      }
      row.append(...decoration(doc, option), copy);
      row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(option.disabled));
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => commit(index)); rows.push(row); host.append(row);
    }
    mark(options[focused] && !options[focused].disabled ? focused : native.selectedIndex);
  }
  function open(direction = 1) {
    update(); if (trigger.disabled || popup.opened) return;
    focused = native.selectedIndex >= 0 && !options[native.selectedIndex]?.disabled ? native.selectedIndex : moveChoice(options, -1, direction);
    render(); popup.open(); trigger.setAttribute('aria-expanded', 'true'); mark(focused);
  }
  const click = () => popup.opened ? popup.close() : open();
  function keydown(event) {
    const key = event.key;
    if (key === 'Tab') { popup.close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault();
      if (!popup.opened) {
        open(key === 'ArrowUp' ? -1 : 1);
        if (key === 'Home') mark(moveChoice(options, -1, 1));
        if (key === 'End') mark(moveChoice(options, 0, -1));
        return;
      }
      if (key === 'Enter' || key === ' ') { commit(focused); return; }
      if (key === 'Home') mark(moveChoice(options, -1, 1));
      else if (key === 'End') mark(moveChoice(options, 0, -1));
      else mark(moveChoice(options, focused, key === 'ArrowUp' ? -1 : 1));
    } else if (key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); open();
      const now = Date.now(), letter = key.toLocaleLowerCase(); prefix = now - typedAt > 700 ? letter : prefix + letter; typedAt = now;
      mark(searchChoice(options, focused, [...prefix].every(value => value === letter) ? letter : prefix));
    }
  }
  trigger.addEventListener('click', click); trigger.addEventListener('keydown', keydown);
  native.addEventListener('change', update);
  const ownFocus = Object.getOwnPropertyDescriptor(native, 'focus');
  Object.defineProperty(native, 'focus', { configurable: true, value: options => trigger.focus(options) });
  const properties = ['value', 'selectedIndex', 'disabled'].map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLSelectElement.prototype, key);
    Object.defineProperty(native, key, { configurable: true, get() { return descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); update(); } }); return key;
  });
  const observer = new doc.defaultView.MutationObserver(update);
  observer.observe(native, { childList: true, subtree: true, attributes: true, characterData: true });
  const reset = () => queueMicrotask(update); doc.addEventListener('reset', reset, true);
  update();
  const api = { trigger, update, dispose() {
    if (disposed) return; disposed = true; popup.dispose(); observer.disconnect();
    doc.removeEventListener('reset', reset, true); native.removeEventListener('change', update);
    for (const key of properties) delete native[key]; native.id = originalId; native.hidden = originalHidden;if(toolLabel&&!hadToolLabel)toolLabel.classList.remove('tool-field');
    if (ownFocus) Object.defineProperty(native, 'focus', ownFocus); else delete native.focus;
    // Retire the rendered label too: callers may retain nodes across redraw or sign-out.
    for(const child of [...trigger.querySelectorAll('*')].reverse())child.textContent='';trigger.textContent='';trigger.removeAttribute('aria-label');trigger.removeAttribute('aria-description');trigger.removeAttribute('title');
    trigger.remove(); instances.delete(native);
  } };
  instances.set(native, api); return api;
}
export function disposeSelects(host) {
  for (const native of host.querySelectorAll('select')) instances.get(native)?.dispose();
}
