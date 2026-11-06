// The Builder's blood gas editor (CASE-311, redesigned for CASE-317 after Julian's 2026-10-30 review: "needs significant
// work to be usable by a human"; prototypes/builder-gas-editor.html). A lazy chunk builder-slides.mjs loads the first time a
// gas block is selected. Two modes fit the 340 px inspector without sideways scrolling: Values (typing results, one narrow
// column per sample, Enter moves down) and Rows and ranges (setup, one stacked card per row). Every gesture is a
// slide-edit.mjs operation through the studio's commit; controls carry data-control-key so a re-render keeps focus.
import * as ops from '../shared/slide-edit.mjs';
import * as compare from '../shared/slide-gas-edit.mjs';
import { gasColumns, gasCells, gasFlag, gasRange, gasTyped, gasTitle } from '../shared/slide-gas-view.mjs';
import { GAS_LIMITS } from '../shared/slide-gas.mjs';
import { matchGasPrintout } from '../shared/slide-gas-paste.mjs';

const BUILDER_GAS_CSS_URL = '__BUILDER_GAS_CSS_URL__';
function ensureStyles(doc) {
  if (doc.getElementById('builder-gas-styles')) return;
  const link = doc.createElement('link'); link.id = 'builder-gas-styles'; link.rel = 'stylesheet';
  link.href = new URL(BUILDER_GAS_CSS_URL === '__BUILDER_GAS_CSS_URL__' ? '/src/client/builder-gas.css' : BUILDER_GAS_CSS_URL, doc.location.origin).href;
  doc.head.append(link);
}
const FLAG_WORDS = { high: 'above its range', low: 'below its range' };

/**
 * The gas editor's nodes for the Block tab. `kit` is builder-slides' own toolkit (el, btn, labelled, run, drawGas, sharedNames),
 * so this chunk shares its commit, review and status path. View state (mode, filter, open panel) is the Builder's only: never saved.
 */
export function gasTools(ctx, gas, kit) {
  const { doc } = ctx, { el, btn, labelled, run, drawGas, sharedNames } = kit;
  ensureStyles(doc);
  const ui = ((ctx.state.gasView ??= {})[gas.id] ??= { mode: 'values', onlyFilled: false, panel: null, column: null, menu: null, from: undefined, label: '', current: '', paste: '' });
  const key = part => `slide:${gas.id}:gas:${part}`;
  const redraw = () => { const current = ctx.document.blocks.find(block => block.id === gas.id); if (current) for (const node of doc.querySelectorAll(`.slide-block[data-block-id="${CSS.escape(gas.id)}"]`)) drawGas(doc, node, current); return current; };
  const field = (label, value, controlKey, commit, { number = false, size = 10, max = 0, after = null } = {}) => {
    const input = el(doc, 'input'); input.type = 'text'; input.value = value; input.setAttribute('aria-label', label); input.dataset.controlKey = controlKey; input.size = size;
    if (max) input.maxLength = max;
    if (number) { input.inputMode = 'decimal'; input.autocomplete = 'off'; input.spellcheck = false; }
    const send = () => {
      const ok = run(ctx, () => commit(ctx.document, input.value), 'Blood gas updated.', { quiet: true }) !== false;
      input.toggleAttribute('aria-invalid', !ok);
      if (ok) { redraw(); after?.(input); }
    };
    input.addEventListener('input', event => { if (!event.isComposing) send(); });
    input.addEventListener('compositionend', send);
    return input;
  };
  const quiet = (label, action, controlKey) => { const button = btn(doc, label, action, 'builder-quiet-link builder-gas-quiet'); if (controlKey) button.dataset.controlKey = controlKey; return button; };
  const segmented = (label, slug, options, current, choose) => {
    const group = el(doc, 'div', null, 'builder-segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, name] of options) {
      const option = btn(doc, name, () => choose(value, name), 'builder-segment');
      option.setAttribute('aria-pressed', String(current === value)); option.dataset.controlKey = key(`${slug}:${value}`);
      group.append(option);
    }
    return group;
  };
  const view = (change, focus) => { Object.assign(ui, change); ctx.rerender(focus); };

  const nodes = [el(doc, 'h3', 'Blood gas', 'builder-inspector-group'),
    segmented('Sample', 'sample', [['arterial', 'Arterial'], ['venous', 'Venous']], gas.sample, (value, name) => run(ctx, () => ops.setGasField(ctx.document, gas.id, 'sample', value), `Sample: ${name}.`)),
    labelled(doc, 'Caption', field('Caption', gas.caption, key('caption'), (current, value) => ops.setGasField(current, gas.id, 'caption', value), { size: 24 })),
    segmented('Editor mode', 'mode', [['values', 'Values'], ['rows', 'Rows and ranges']], ui.mode, value => view({ mode: value, menu: null }, key(`mode:${value}`)))];
  nodes.at(-1).classList.add('builder-gas-mode');
  if (ui.mode === 'rows') nodes.push(...rowsMode());
  else nodes.push(...valuesMode());
  return nodes;

  // ── Values: one table, names as text, one narrow input column per sample (oldest first, the current one tinted) ──
  function valuesMode() {
    const columns = gasColumns(gas), samples = gas.compare?.earlier ?? [], count = columns?.length ?? 1, last = count - 1;
    const columnName = at => columns ? columns[at] || (at === last ? 'current sample' : `sample ${at + 1}`) : 'value';
    const table = el(doc, 'table', null, 'builder-gas-entry'), colgroup = el(doc, 'colgroup');
    colgroup.append(el(doc, 'col', null, 'builder-gas-name'), ...Array.from({ length: count }, () => el(doc, 'col')), el(doc, 'col', null, 'builder-gas-unit'));
    const th = (text, cls) => { const cell = el(doc, 'th', text, cls); cell.setAttribute('scope', 'col'); return cell; };
    const headRow = el(doc, 'tr');
    headRow.append(th('Parameter'));
    for (let at = 0; at < count; at++) {
      const cell = th(columns ? null : 'Value', `builder-gas-sample${at === last ? ' builder-gas-now' : ''}`);
      if (columns) cell.append(field(at === last ? 'Current sample label' : `Sample ${at + 1} label`, columns[at], key(`label:${samples[at]?.id ?? 'now'}`),
        (current, value) => compare.setGasColumnLabel(current, gas.id, at, value), { size: 5, max: GAS_LIMITS.sampleLabel, after: refreshPaste }));
      headRow.append(cell);
    }
    headRow.append(th('Unit'));
    const head = el(doc, 'thead'); head.append(headRow);
    // Each earlier column's actions open under the table from a small button in its own heading column.
    if (samples.length) {
      const actions = el(doc, 'tr', null, 'builder-gas-colacts'); actions.append(el(doc, 'td'));
      samples.forEach((sample, at) => {
        const cell = el(doc, 'td'), open = btn(doc, '⋯', () => view({ menu: ui.menu === sample.id ? null : sample.id }, key(`menu:${sample.id}`)), 'builder-trend-act');
        open.setAttribute('aria-label', `Column ${columnName(at)}: move or remove`); open.setAttribute('aria-expanded', String(ui.menu === sample.id)); open.dataset.controlKey = key(`menu:${sample.id}`);
        cell.append(open); actions.append(cell);
      });
      actions.append(el(doc, 'td'), el(doc, 'td')); head.append(actions);
    }
    table.append(colgroup, head);
    for (const group of gas.groups) {
      const rows = group.rows.filter(row => !ui.onlyFilled || gasCells(gas, row).some(gasTyped));
      if (!rows.length) continue;
      const body = el(doc, 'tbody'), title = el(doc, 'tr', null, 'builder-gas-group'), name = el(doc, 'th', group.label || 'Group');
      name.setAttribute('scope', 'rowgroup'); name.colSpan = count + 2; title.append(name); body.append(title);
      for (const row of rows) {
        const cells = gasCells(gas, row), range = gasRange(row), label = row.label || 'Unnamed row';
        const tr = el(doc, 'tr', null, cells.some(gasTyped) ? null : 'builder-gas-empty'), rowName = el(doc, 'th', label);
        rowName.setAttribute('scope', 'row'); rowName.title = range ? `${label} · range ${range}` : label; tr.append(rowName);
        cells.forEach((value, at) => {
          const td = el(doc, 'td', null, `builder-gas-value${at === last ? ' builder-gas-now' : ''}`);
          const flagged = input => { const flag = gasFlag(row, input.value); input.classList.toggle('builder-gas-flagged', Boolean(flag)); input.title = `${range ? `Range ${range}` : 'No range'}${flag ? ` · ${FLAG_WORDS[flag]}` : ''}`; };
          const input = field(columns ? `${label} at ${columnName(at)}` : `${label} value`, value, key(`cell:${row.id}:${samples[at]?.id ?? 'now'}`),
            (current, text) => compare.setGasReading(current, gas.id, row.id, at, text), { number: true, size: 4, max: GAS_LIMITS.value, after: flagged });
          input.placeholder = '–'; input.dataset.gasColumn = String(at); flagged(input);
          input.addEventListener('focus', () => { ui.column = at; refreshPaste(); });
          input.addEventListener('keydown', event => move(event, table, at));
          td.append(input); tr.append(td);
        });
        tr.append(el(doc, 'td', row.unit, 'builder-gas-unit')); body.append(tr);
      }
      table.append(body);
    }
    const out = [table];
    const menu = samples.find(sample => sample.id === ui.menu);
    if (menu) {
      const at = samples.indexOf(menu), bar = el(doc, 'div', null, 'builder-slide-choices builder-gas-colbar'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', `Column ${columnName(at)}`);
      const act = (label, attempt, done, enabled = true) => { const button = btn(doc, label, () => run(ctx, attempt, done)); button.disabled = !enabled; button.dataset.controlKey = key(`${label.toLowerCase().replace(' ', '-')}:${menu.id}`); bar.append(button); };
      act('Move earlier', () => compare.moveGasSample(ctx.document, gas.id, menu.id, -1), 'Column moved earlier.', at > 0);
      act('Move later', () => compare.moveGasSample(ctx.document, gas.id, menu.id, 1), 'Column moved later.', at < samples.length - 1);
      act('Remove column', confirmed => { const result = compare.removeGasSample(ctx.document, gas.id, menu.id, { confirmed }); if (result.ok) ui.menu = null; return result; }, 'Column removed. Undo restores it.');
      bar.append(quiet('Close', () => view({ menu: null }, key(`menu:${menu.id}`))));
      out.push(bar);
    }
    const bar = el(doc, 'div', null, 'builder-slide-choices builder-gas-bar');
    if (samples.length < GAS_LIMITS.earlier) {
      const add = btn(doc, 'Add earlier sample…', () => view({ panel: ui.panel === 'add' ? null : 'add' }, key('add')));
      add.dataset.controlKey = key('add'); add.setAttribute('aria-expanded', String(ui.panel === 'add')); bar.append(add);
    }
    const paste = quiet('Paste a printout…', () => view({ panel: ui.panel === 'paste' ? null : 'paste' }, key('paste')), key('paste'));
    paste.setAttribute('aria-expanded', String(ui.panel === 'paste')); bar.append(paste);
    const only = el(doc, 'input'); only.type = 'checkbox'; only.checked = ui.onlyFilled; only.dataset.controlKey = key('only-filled');
    only.addEventListener('change', () => view({ onlyFilled: only.checked }, key('only-filled')));
    const onlyLabel = el(doc, 'label', null, 'builder-gas-check'); onlyLabel.append(only, el(doc, 'span', 'Show only rows with a value'));
    out.push(bar, onlyLabel);
    if (ui.panel === 'add') out.push(addPanel());
    if (ui.panel === 'paste') out.push(pastePanel());
    out.push(el(doc, 'p', 'Enter or ↓ moves down a column. A value outside its range is bold here and flagged on the slide; rows without a value stay off the slide.', 'builder-slide-note'));
    return out;

    // The paste panel's summary follows the caret's column and the typed text without a re-render.
    function refreshPaste() { doc.querySelector(`[data-gas-summary="${CSS.escape(gas.id)}"]`)?.dispatchEvent(new Event('refresh')); }
  }

  // Enter or ↓ moves to the same sample in the next row, ↑ to the previous; Tab moves across as usual.
  function move(event, table, at) {
    const step = event.key === 'Enter' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const column = [...table.querySelectorAll(`tbody input[data-gas-column="${at}"]`)], target = column[column.indexOf(event.target) + step];
    event.preventDefault();
    if (target) { target.focus(); target.select(); }
  }

  // ── Add earlier sample: copied once from another gas block in this case (matched by row name), or an empty column ──
  function addPanel() {
    const others = ctx.document.blocks.filter(block => block.type === 'gas' && block.id !== gas.id);
    if (ui.from === undefined) { ui.from = others[0]?.id ?? null; ui.label = labelOf(others[0]); }
    const panel = el(doc, 'section', null, 'builder-gas-panel'); panel.setAttribute('aria-label', 'Add earlier sample');
    panel.append(el(doc, 'h4', 'Add earlier sample'), el(doc, 'p', 'Copies values once, matched by row name. Edit them freely after.', 'builder-slide-note'));
    const sources = el(doc, 'div', null, 'builder-gas-sources'); sources.setAttribute('role', 'group'); sources.setAttribute('aria-label', 'Copy values from');
    for (const block of [...others, null]) {
      const name = block ? `${gasTitle(block)} · ${sharedNames(ctx.document, block.id)[0] ?? 'not on a slide'}` : 'Empty column';
      const option = btn(doc, name, () => view({ from: block?.id ?? null, label: block ? labelOf(block) : ui.label }, key(`from:${block?.id ?? 'empty'}`)), 'builder-gas-source');
      option.setAttribute('aria-pressed', String(ui.from === (block?.id ?? null))); option.dataset.controlKey = key(`from:${block?.id ?? 'empty'}`);
      sources.append(option);
    }
    const text = (label, part, max) => {
      const input = el(doc, 'input'); input.type = 'text'; input.value = ui[part]; input.maxLength = max; input.setAttribute('aria-label', label); input.dataset.controlKey = key(`add-${part}`);
      input.addEventListener('input', () => { ui[part] = input.value; });
      return labelled(doc, label, input);
    };
    panel.append(sources, text('Column label', 'label', GAS_LIMITS.sampleLabel));
    if (!gas.compare) panel.append(text('This sample’s label', 'current', GAS_LIMITS.sampleLabel));
    const actions = el(doc, 'div', null, 'builder-slide-choices');
    const add = btn(doc, 'Add column', () => {
      const { from, label, current } = ui;
      run(ctx, () => { const result = compare.addGasSample(ctx.document, gas.id, { label: label.trim(), current: current.trim(), from }, ctx.createId); if (result.ok) Object.assign(ui, { panel: null, from: undefined, label: '', current: '' }); return result; },
        'Earlier sample added. Undo removes it.');
    });
    add.dataset.controlKey = key('add-column');
    actions.append(add, quiet('Cancel', () => view({ panel: null, from: undefined }, key('add'))));
    panel.append(actions);
    return panel;
  }
  // A source's column label: its caption up to the first " · " (usually the sample's time), within the label limit.
  function labelOf(block) { return block ? (block.caption ?? '').split(' · ')[0].trim().slice(0, GAS_LIMITS.sampleLabel) : ''; }

  // ── Paste a printout: each line's name and first number fill the caret's column (or the newest), with one Undo ──
  function pastePanel() {
    const panel = el(doc, 'section', null, 'builder-gas-panel'); panel.setAttribute('aria-label', 'Paste a printout');
    const area = el(doc, 'textarea'); area.rows = 7; area.value = ui.paste; area.spellcheck = false; area.setAttribute('aria-label', 'Printout text'); area.dataset.controlKey = key('paste-text');
    area.placeholder = 'pH 7.23\npCO2 60 mmHg\nK+ 3.4';
    const summary = el(doc, 'p', null, 'builder-slide-note'); summary.setAttribute('role', 'status'); summary.dataset.gasSummary = gas.id;
    const missed = el(doc, 'ul', null, 'builder-gas-missed'); missed.setAttribute('aria-label', 'Lines not matched');
    const fill = btn(doc, 'Fill values', () => {
      const { readings } = matchGasPrintout(ui.paste, gas), column = target();
      run(ctx, confirmed => { const result = compare.fillGasColumn(ctx.document, gas.id, column, readings, { confirmed }); if (result.ok) Object.assign(ui, { panel: null, paste: '' }); return result; },
        `${readings.length} ${readings.length === 1 ? 'value' : 'values'} filled. Undo restores the column.`);
    });
    fill.dataset.controlKey = key('fill');
    const show = () => {
      const { readings, unmatched, lines } = matchGasPrintout(ui.paste, gas), columns = gasColumns(gas), column = target();
      const into = columns ? `Fills column ${columns[column] || (column === columns.length - 1 ? 'current sample' : `sample ${column + 1}`)}.` : 'Fills the value column.';
      summary.textContent = lines ? `${readings.length} of ${lines} ${lines === 1 ? 'line' : 'lines'} matched${readings.length ? `: ${readings.map(item => item.label).join(', ')}` : ''}. ${into}` : `Paste lines such as “pH 7.23”. ${into}`;
      missed.replaceChildren(...unmatched.map(line => el(doc, 'li', line)));
      missed.hidden = !unmatched.length; fill.disabled = !readings.length;
    };
    area.addEventListener('input', () => { ui.paste = area.value; show(); });
    summary.addEventListener('refresh', show);
    show();
    const actions = el(doc, 'div', null, 'builder-slide-choices');
    actions.append(fill, quiet('Cancel', () => view({ panel: null }, key('paste'))));
    panel.append(el(doc, 'h4', 'Paste a printout'), area, summary, missed, actions);
    return panel;
  }
  function target() { const last = (gasColumns(gas)?.length ?? 1) - 1; return Number.isInteger(ui.column) && ui.column <= last ? ui.column : last; }

  // ── Rows and ranges: setup, one stacked card per row so nothing is cut off at 340 px ──
  function rowsMode() {
    const out = [];
    gas.groups.forEach((group, g) => {
      const head = el(doc, 'div', null, 'builder-gas-ghead');
      head.append(field(`Group ${g + 1} name`, group.label, `slide:${gas.id}:group:${group.id}`, (current, value) => ops.setGasGroupLabel(current, gas.id, group.id, value), { size: 18 }));
      if (gas.groups.length > 1) head.append(quiet('Delete group', () => run(ctx, confirmed => ops.removeGasGroup(ctx.document, gas.id, group.id, { confirmed }), 'Group deleted. Undo restores it.'), key(`delete-group:${group.id}`)));
      out.push(head);
      group.rows.forEach((row, index) => {
        const name = row.label || `row ${index + 1}`, set = part => (current, value) => ops.setGasRow(current, gas.id, row.id, part, value);
        const card = el(doc, 'div', null, 'builder-gas-card'), top = el(doc, 'div', null, 'builder-gas-line'), bounds = el(doc, 'div', null, 'builder-gas-line');
        const parameter = field(`${group.label} row ${index + 1} parameter`, row.label, `slide:${gas.id}:row:${row.id}:label`, set('label'), { size: 8, max: GAS_LIMITS.label });
        parameter.classList.add('builder-gas-param');
        top.append(parameter);
        bounds.append(el(doc, 'span', 'unit'), field(`${name} unit`, row.unit, `slide:${gas.id}:row:${row.id}:unit`, set('unit'), { size: 6, max: GAS_LIMITS.unit }), el(doc, 'span', 'range'), field(`${name} low`, row.low, `slide:${gas.id}:row:${row.id}:low`, set('low'), { number: true, size: 5, max: GAS_LIMITS.value }),
          el(doc, 'span', '–'), field(`${name} high`, row.high, `slide:${gas.id}:row:${row.id}:high`, set('high'), { number: true, size: 5, max: GAS_LIMITS.value }));
        const actions = el(doc, 'div', null, 'builder-gas-acts');
        const act = (label, glyph, attempt, done, enabled) => { const button = btn(doc, glyph, () => run(ctx, attempt, done), 'builder-trend-act'); button.setAttribute('aria-label', `${label}: ${name}`); button.title = label; button.disabled = !enabled; button.dataset.controlKey = key(`${label.toLowerCase().replaceAll(' ', '-')}:${row.id}`); actions.append(button); };
        act('Move row up', '↑', () => ops.moveGasRow(ctx.document, gas.id, row.id, -1), 'Row moved up.', index > 0);
        act('Move row down', '↓', () => ops.moveGasRow(ctx.document, gas.id, row.id, 1), 'Row moved down.', index < group.rows.length - 1);
        act('Delete row', '×', confirmed => ops.removeGasRow(ctx.document, gas.id, row.id, { confirmed }), 'Row deleted. Undo restores it.', group.rows.length > 1);
        card.append(top, actions, bounds); out.push(card);
      });
      const add = el(doc, 'div', null, 'builder-slide-choices');
      add.append(quiet('Add row', () => run(ctx, () => ops.addGasRow(ctx.document, gas.id, group.id, ctx.createId), 'Row added.'), key(`add-row:${group.id}`)));
      out.push(add);
    });
    const more = el(doc, 'div', null, 'builder-slide-choices builder-gas-bar');
    more.append(quiet('Add group', () => run(ctx, () => ops.addGasGroup(ctx.document, gas.id, ctx.createId), 'Group added.'), key('add-group')),
      quiet('Reset ranges to adult defaults', () => run(ctx, () => compare.resetGasRanges(ctx.document, gas.id), `Ranges reset to the ${gas.sample} adult defaults. Undo restores them.`), key('reset-ranges')));
    out.push(more, el(doc, 'p', '↑ and ↓ come from each row’s low and high. Rows without a value stay off the slide.', 'builder-slide-note'));
    return out;
  }
}
