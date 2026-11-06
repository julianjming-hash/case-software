import { compactTool } from './ui-icons.mjs';
// Card 30 (CASE-168 (3)): the Groups screen, shared by the owner's facilitator document (/cases) and
// Administration -> Groups, and the Change group control used by case detail and Admin -> Cases. A lazily
// loaded chunk (scripts/size-budget.mjs `groups-screen`). Groups organise one workspace's cases (one group per case,
// or Ungrouped) and tint their covers with one of ten curated grounds; they never grant or remove access.
// Text only: every value is set with textContent. The server authorizes every write (owner of the workspace,
// or admin); this screen only offers what the matrix allows, and a 403 closes it.
import { guardDialog } from './dialog-behaviour.mjs';
import { node } from './auth-ui.mjs';
import { enhanceSelect, disposeSelects } from './accessible-select.mjs';
// Administration opens the same universal menu through this existing bounded owner/admin chunk.
export { attachSiteMenu } from './shared-menu.mjs';
import { paintCovers, clearCoverCache, currentTheme } from './mosaic.mjs';
import { watchTheme } from './appearance-watch.mjs';
import { BRAND_ART } from './brand-art.mjs';
import { validArtDescriptor } from '../shared/art-descriptor.mjs';
import { catalogueSearch } from '../shared/catalogue.mjs';
import { stepUpFailure, CODE_RATE_LIMITED } from './admin-stepup-messages.mjs';
import { GROUP_TINTS, UNGROUPED, cleanGroupName, tintOf, TINT_NAMES, cleanGroupDescription, validGroupRow } from '../shared/groups.mjs';


const MESSAGES = Object.freeze({
  name_taken: 'A live group in this workspace already has that name.',
  conflict: 'This changed elsewhere. Current information has been loaded; check it and try again.',
  not_found: 'That group or case is no longer available. Current information has been loaded.',
  confirm_mismatch: 'Type the group name exactly as shown to confirm.',
  invalid_group: 'Check the name, description and tint.',
  forbidden: 'You can no longer manage groups in this workspace.',
  rate_limited: CODE_RATE_LIMITED,
});
export const groupMessage = code => MESSAGES[code] ?? 'Groups are unavailable. Nothing was changed; try again.';
/** Automatic refresh never replaces a draft: it waits while a form, a dialog or a request is open. */
export const mayRefresh = ({ editing, dialogOpen, busy, drafting, focusInForm }) => !editing && !dialogOpen && !busy && !drafting && !focusInForm;

let ids = 0;
const field = (label, control, hint) => {
  const wrap = node('div', null, 'field');
  control.id = `groups-field-${++ids}`;
  const name = node('label', label); name.htmlFor = control.id;
  wrap.append(name, control);
  if (hint) { const note = node('p', hint, 'hint'); note.id = `${control.id}-hint`; control.setAttribute('aria-describedby', note.id); wrap.append(note); }
  if (control.tagName === 'SELECT') enhanceSelect(control, { label });
  return wrap;
};
const input = (value = '', max = 60) => { const item = node('input'); item.className = 'input'; item.maxLength = max; item.value = value; item.autocomplete = 'off'; return item; };
const area = (value = '') => { const item = node('textarea'); item.className = 'input'; item.rows = 2; item.maxLength = 200; item.value = value ?? ''; return item; };
const button = (label, className = 'btn') => { const item = node('button', label, className); item.type = 'button'; return item; };

/** A cover canvas with the generic art label, painted later with a given tint. */
function coverSlot(className = 'cover', decorative = false) {
  const holder = node('div', null, className); const canvas = node('canvas');
  // A swatch beside its written name is decorative; the preview keeps the art's generic label.
  if (decorative) holder.setAttribute('aria-hidden', 'true');
  holder.append(canvas); return { holder, canvas };
}

/** Ten radio choices, each a real cover in that tint, named in text so colour is never the only identifier. */
function tintChoices(name, selected, sample, painting) {
  const fieldset = node('fieldset', null, 'tint-choices');
  fieldset.append(node('legend', 'Artwork tint'));
  const grid = node('div', null, 'tint-grid');
  for (const tint of GROUP_TINTS) {
    const label = node('label', null, 'tint-choice');
    const radio = node('input'); radio.type = 'radio'; radio.name = name; radio.value = tint; radio.checked = tint === selected;
    const { holder, canvas } = coverSlot('cover tint-cover', true);
    holder.dataset.tint = tint;
    if (sample) painting.push({ canvas, art: sample.art, group: tint, contentSeed: sample.seed }); else holder.classList.add('unavailable');
    label.append(radio, holder, node('span', TINT_NAMES[tint]));
    grid.append(label);
  }
  fieldset.append(grid);
  return { fieldset, value: () => fieldset.querySelector('input:checked')?.value ?? null };
}

/**
 * Mount the Groups screen. `request(parts, options)` is accountRequest bound to the signed-in account.
 * Owner: `workspaces` is the one workspace the person owns. Admin: every workspace, with a picker, and
 * `stepUp` ({ has, token, drop, sendCode, verify }) for the archive's session elevation (R-a).
 */
export function mountGroups(host, { request, workspaces, workspaceId = workspaces[0]?.workspace_id, admin = false, scoped = false, stepUp = null,
  onClose = null, refreshMs = 30_000 }) {
  const state = { workspace: workspaceId, groups: [], editing: null, busy: false, dialogOpen: false, sample: null, closed: false };
  let generation = 0, painting = [], previews = [];
  const root = node('section', null, 'groups-screen'); root.setAttribute('aria-labelledby', 'groupsTitle');
  const head = node('div', null, 'groups-head');
  const title = node(admin ? 'h2' : 'h1', 'Groups'); title.id = 'groupsTitle'; title.tabIndex = -1;
  const intro = node('p', 'Organise the case library. A case belongs to one group, or none. Groups never grant or remove access.', 'muted');
  const status = node('p', '', 'groups-status'); status.setAttribute('role', 'status');
  head.append(title, intro);
  let picker = null;
  if (admin && !scoped) {
    picker = node('select'); picker.className = 'input';
    for (const ws of workspaces) { const option = node('option', ws.name || 'Workspace'); option.value = ws.workspace_id; picker.append(option); }
    picker.value = state.workspace ?? '';
    picker.addEventListener('change', () => {const target=picker.value;picker.value=state.workspace;attempt(()=>{picker.value=target;state.workspace=target;state.editing=null;void load();});});
    head.append(field('Workspace', picker));
  }
  const body = node('div', null, 'groups-body');
  let archiveGuard=null;const dialog = node('dialog', null, 'groups-dialog'); dialog.setAttribute('aria-labelledby', 'groupsDialogTitle');
  root.append(head, status, body, dialog);
  host.append(root);

  let dirty=()=>false,continuation=null,allowing=false;
  const pending=()=>state.busy||state.dialogOpen||dialog.open;
  const leaveGuard=guardDialog(root,{dirty:()=>!allowing&&dirty(),pending,onClose:()=>{const run=continuation;continuation=null;allowing=true;try{run?.();}finally{allowing=false;}}});
  function attempt(run){if(pending()||state.closed)return false;if(allowing||!dirty()){run();return true;}continuation=run;const menu=document.querySelector('dialog.site-menu[open]');if(menu){menu.close();root.querySelector('.groups-form input')?.focus();}leaveGuard.requestClose();return false;}
  function track(form){const snapshot=()=>JSON.stringify([...form.querySelectorAll('input,textarea,select')].map(n=>n.type==='radio'||n.type==='checkbox'?[n.value,n.checked]:n.value));const saved=snapshot();dirty=()=>snapshot()!==saved;}
  const beforeUnload=event=>{if(!allowing&&!state.closed&&(state.busy||dirty()||[...dialog.querySelectorAll('input')].some(n=>n.value))){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  const say = text => { status.textContent = text; };
  const workspaceName = () => workspaces.find(ws => ws.workspace_id === state.workspace)?.name || 'this workspace';
  async function call(parts, options) {
    try { return { ok: true, value: await request(parts, options) }; }
    catch (error) {
      if (error?.status === 403 && admin && stepUp) stepUp.drop();
      return { ok: false, status: error?.status ?? 0, code: error?.code ?? null };
    }
  }
  function refused(result) {
    say(groupMessage(result.code ?? (result.status === 403 ? 'forbidden' : null)));
    // E24: an owner demoted while the screen is open gets 403 on the next write; the screen closes.
    if (result.status === 403 && !admin && onClose) onClose({ forbidden: true });
    else if ([404, 409].includes(result.status)) void load({ keepStatus: true });
  }

  async function sampleCover() {
    // Preview a stored case cover when available; legacy and empty catalogues use the brand braid.
    const result = await call(['workspaces', state.workspace, 'catalogue'], { query: catalogueSearch({ limit: 1 }) });
    const row = result.ok && Array.isArray(result.value?.cases) ? result.value.cases.find(item => validArtDescriptor(item?.art)) : null;
    return row ? { art: row.art, seed: row.case_id } : { art: BRAND_ART, seed: 'case-brand' };
  }
  async function load({ keepStatus = false } = {}) {
    const current = ++generation, ws = state.workspace;
    if (!ws) { say('No workspaces to manage.'); body.replaceChildren(); return; }
    disposeSelects(body); body.replaceChildren();dirty=()=>false;
    if (!keepStatus) say('Loading groups…');
    const [listed, sample] = await Promise.all([call(['workspaces', ws, 'groups']), state.sample?.ws === ws ? state.sample : sampleCover()]);
    if (state.closed || current !== generation) return;
    if (!listed.ok || !Array.isArray(listed.value?.groups) || !listed.value.groups.every(validGroupRow)) {
      if (listed.status === 403) { refused(listed); return; }
      say('Groups are unavailable. Try again.'); const retry = button('Retry groups', 'btn quiet'); retry.onclick = () => void load(); body.replaceChildren(retry); return;
    }
    state.groups = listed.value.groups;
    state.sample = sample && sample.ws !== ws ? { ...sample, ws } : sample;
    if (!keepStatus) say(state.groups.length ? `${state.groups.length} ${state.groups.length === 1 ? 'group' : 'groups'} in ${workspaceName()}` : `No groups in ${workspaceName()} yet.`);
    if (state.editing) {
      const fresh = state.groups.find(group => group.id === state.editing.id);
      if (fresh) { renderEdit(fresh); return; }
      state.editing = null;
    }
    renderList();
  }

  let paintGeneration = 0;
  function paint() {
    const generation = ++paintGeneration;
    const isCurrent = () => generation === paintGeneration;
    for (const { canvas, art } of [...painting, ...previews.map(([item]) => item)]) {
      canvas.parentElement.dataset.art = art === BRAND_ART ? 'brand' : 'case';
      if (art === BRAND_ART) canvas.parentElement.setAttribute('aria-hidden', 'true');
    }
    void paintCovers(painting, { cssSize: 64, theme: currentTheme(), isCurrent });
    for (const [item, previewTheme] of previews) void paintCovers([item], { theme: previewTheme, cssSize: 200, isCurrent });
  }

  function renderList() {
    painting = []; previews = [];
    // SURFACE-06: the list is the page; creation opens from a New group button.
    const layout = node('div', null, 'groups-layout single');
    const table = node('table', null, 'groups-table');
    table.append(node('caption', `Groups in ${workspaceName()}`, 'sr-only'));
    const thead = node('thead'), headRow = node('tr');
    for (const [label, hidden] of [['Cover', true], ['Group'], ['Tint'], ['Cases'], ['Actions', true]]) {
      const th = node('th'); th.scope = 'col';
      if (hidden) th.append(node('span', label, 'sr-only')); else th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = node('tbody');
    for (const group of state.groups) {
      const tr = node('tr');
      const coverCell = node('td'); const { holder, canvas } = coverSlot('cover small', true);
      holder.dataset.tint = group.tint;
      if (state.sample) { painting.push({ canvas, art: state.sample.art, group: group.tint, contentSeed: state.sample.seed }); }
      else holder.classList.add('unavailable');
      coverCell.append(holder);
      const nameCell = node('td'); nameCell.append(node('span', group.name, 'group-name'));
      if (group.description) nameCell.append(node('span', group.description, 'group-description'));
      const edit = button('Edit', 'btn quiet'); edit.dataset.group = group.id;
      edit.setAttribute('aria-label', `Edit ${group.name}`);
      edit.addEventListener('click', () => attempt(()=>{state.editing=group;renderEdit(group);}));
      const actions = node('td'); actions.append(edit);
      tr.append(coverCell, nameCell, node('td', TINT_NAMES[group.tint]), node('td', String(group.caseCount), 'num'), actions);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const scroll = node('div', null, 'table-scroll'); scroll.append(table);
    const list = node('div', null, 'groups-list');
    list.append(state.groups.length ? scroll : node('p', 'No groups yet. Every case is Ungrouped.', 'muted'));
    const open = button('New group'), form = renderCreate(); form.hidden = true;
    open.ariaExpanded = 'false'; open.setAttribute('aria-controls', form.id);
    open.addEventListener('click',()=>{const toggle=()=>{form.hidden=!form.hidden;layout.classList.toggle('single',form.hidden);open.ariaExpanded=String(!form.hidden);if(!form.hidden)form.querySelector('input')?.focus();};if(form.hidden)toggle();else attempt(()=>{renderList();root.querySelector('.groups-list>button')?.focus();});});
    list.prepend(open);
    layout.append(list, form);
    body.replaceChildren(layout);
    paint();
  }

  function renderCreate() {
    const aside = node('aside', null, 'groups-new surface'); aside.id = 'groupsNew'; aside.setAttribute('aria-labelledby', 'groupsNewTitle');
    const heading = node('h2', 'New group'); heading.id = 'groupsNewTitle';
    const name = input(), description = area();
    const form = node('form', null, 'groups-form');
    const tints = tintChoices('new-tint', 'neutral', state.sample, painting);
    const create = node('button', 'Create group', 'btn primary'); create.type = 'submit';
    form.append(field('Name', name), field('Description (optional)', description), tints.fieldset, create);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (state.busy) return;
      const clean = cleanGroupName(name.value), text = cleanGroupDescription(description.value);
      if (!clean || text === undefined) { say(groupMessage('invalid_group')); name.focus(); return; }
      state.busy = true; form.inert=true;create.disabled = true; say('Creating group…');
      const result = await call(['workspaces', state.workspace, 'groups'], { method: 'POST', body: { name: clean, description: text, tint: tints.value() } });
      if(state.closed)return;
      if(!result.ok){state.busy=false;form.inert=false;create.disabled=false;refused(result);if(result.status!==403)name.focus();return;}
      say(`${clean} created.`);
      name.value = ''; description.value = '';
      await load({ keepStatus: true });state.busy=false;if(state.closed)return;form.inert=false;create.disabled=false;
      root.querySelector(`button[data-group="${result.value.group.id}"]`)?.focus();
    });
    track(form);aside.append(heading, form);
    return aside;
  }

  function renderEdit(group) {
    painting = []; previews = [];
    const wrap = node('div', null, 'groups-edit');
    const back = button('← Groups', 'btn tertiary');
    back.addEventListener('click',()=>attempt(()=>{state.editing=null;renderList();root.querySelector(`button[data-group="${group.id}"]`)?.focus();}));
    const heading = node('h2', group.name); heading.id = 'groupsEditTitle'; heading.tabIndex = -1;
    const name = input(group.name), description = area(group.description);
    const form = node('form', null, 'groups-form');
    const tints = tintChoices('edit-tint', group.tint, state.sample, painting);
    const hint = node('p', `Changes the background of every ${group.name} cover. Rooms already running keep the artwork they started with.`, 'hint');
    const save = node('button', 'Save group', 'btn primary'); save.type = 'submit';
    const archive = button('Archive group', 'btn danger');
    const actions = node('div', null, 'groups-actions'); actions.append(save, archive);
    form.append(field('Name', name), field('Description', description), tints.fieldset, hint, actions);
    // The preview: the same real cover in both themes, in the chosen tint.
    const preview = node('div', null, 'tint-preview');
    preview.append(node('p', 'Preview: the same cover in both themes', 'small muted'));
    const figures = node('div', null, 'tint-preview-row');
    for (const theme of ['light', 'dark']) {
      const figure = node('figure');
      const { holder, canvas } = coverSlot('cover'); holder.dataset.tint = group.tint; holder.dataset.theme = theme;
      if (state.sample) previews.push([{ canvas, art: state.sample.art, group: group.tint, contentSeed: state.sample.seed }, theme]);
      else holder.classList.add('unavailable');
      figure.append(holder, node('figcaption', theme === 'light' ? 'Light' : 'Dark', 'small muted'));
      figures.append(figure);
    }
    preview.append(figures, node('p', `${group.caseCount} ${group.caseCount === 1 ? 'case uses' : 'cases use'} this group`, 'small muted'));
    if (!state.sample) preview.append(node('p', 'No published case in this workspace yet; the preview appears once one is.', 'small muted'));
    tints.fieldset.addEventListener('change', () => {
      const tint = tints.value();
      for (const [item] of previews) { item.group = tint; item.canvas.parentElement.dataset.tint = tint; }
      paint();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (state.busy) return;
      const clean = cleanGroupName(name.value), text = cleanGroupDescription(description.value);
      if (!clean || text === undefined) { say(groupMessage('invalid_group')); name.focus(); return; }
      state.busy = true;form.inert=true; save.disabled = archive.disabled = true; say('Saving group…');
      const result = await call(['workspaces', state.workspace, 'groups', group.id], { method: 'PUT',
        body: { expectedRevision: group.revision, name: clean, description: text, tint: tints.value() } });
      if(state.closed)return;
      if(!result.ok){state.busy=false;form.inert=false;save.disabled=archive.disabled=false;refused(result);return;}
      say(`${clean} saved.`);
      state.editing = null;
      await load({ keepStatus: true });state.busy=false;if(state.closed)return;form.inert=false;save.disabled=archive.disabled=false;
      root.querySelector(`button[data-group="${group.id}"]`)?.focus();
    });
    archive.addEventListener('click', () => openArchive(group, archive));
    const layout = node('div', null, 'groups-edit-layout'); layout.append(form, preview);
    track(form);wrap.append(back, heading, layout);
    body.replaceChildren(wrap);
    heading.focus();
    paint();
  }

  // Archive: an explicit disposition, the exact name typed, one request in flight; an admin also gives the
  // session's email code (R-a). Focus returns to the control that opened it, or the list after success.
  function openArchive(group, opener) {
    if (state.busy || dialog.open) return;
    state.dialogOpen = true;
    const others = state.groups.filter(item => item.id !== group.id);
    const heading = node('h2', `Archive ${group.name}?`); heading.id = 'groupsDialogTitle';
    const count = `${group.caseCount} ${group.caseCount === 1 ? 'case uses' : 'cases use'} this group.`;
    const text = node('p', `${count} Choose where they go. Their covers change tint; no case content changes, and running rooms keep their current artwork. No case is deleted.`, 'small');
    const move = node('select'); move.className = 'input';
    move.append(Object.assign(node('option', UNGROUPED), { value: '' }), ...others.map(item => Object.assign(node('option', item.name), { value: item.id })));
    const confirm = input('', 240);
    const code = input('', 6); code.inputMode = 'numeric'; code.pattern = '[0-9]{6}';
    const codeField = field('Six-digit email code', code); codeField.hidden = true;
    const notice = node('p', '', 'groups-dialog-status'); notice.setAttribute('role', 'status');
    const needsCode = () => admin && !stepUp?.has();
    const submit = node('button', needsCode() ? 'Send verification code' : 'Archive group', 'btn danger'); submit.type = 'submit';
    const cancel = button('Cancel', 'btn quiet');
    const actions = node('div', null, 'dialog-actions'); actions.append(cancel, submit);
    const form = node('form');
    form.append(field('Move its cases to', move), field(`Type ${group.name} to confirm`, confirm), codeField, actions);
    let phase = needsCode() ? 'confirm' : 'ready';
    const close = (focus = opener) => {archiveGuard?.dispose();archiveGuard=null;
      if (dialog.open) dialog.close();
      disposeSelects(dialog); dialog.replaceChildren(); state.dialogOpen = false;
      (focus?.isConnected ? focus : title).focus();
    };
    archiveGuard?.dispose();archiveGuard=guardDialog(dialog,{dirty:()=>Boolean(confirm.value||code.value||move.value),pending:()=>state.busy,onClose:()=>close(),opener:()=>opener});cancel.addEventListener('click',()=>archiveGuard.requestClose());
    dialog.onclose = () => { state.dialogOpen = false; };
    dialog.oncancel=null;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (state.busy) return;
      if (confirm.value !== group.name) { notice.textContent = groupMessage('confirm_mismatch'); confirm.focus(); return; }
      const busy = value => { state.busy = value; submit.disabled = cancel.disabled = move.disabled = confirm.disabled = code.disabled = value; };
      busy(true);
      try {
        if (phase === 'confirm') {
          notice.textContent = 'Sending a code to your email…';
          const sent = await stepUp.sendCode();
          if (!sent?.ok) { notice.textContent = stepUpFailure(sent); return; }
          phase = 'code'; codeField.hidden = false; submit.textContent = 'Confirm action';
          notice.textContent = 'Enter the code sent to your email. It covers destructive actions until you sign out.';
          busy(false); code.focus(); return;
        }
        if (phase === 'code') {
          if (!/^[0-9]{6}$/.test(code.value)) { notice.textContent = 'Enter the six-digit code.'; code.focus(); return; }
          const verified = await stepUp.verify(code.value); code.value = '';
          if (!verified?.ok) { notice.textContent = stepUpFailure(verified); return; }
          phase = 'ready';
        }
        notice.textContent = 'Archiving…';
        const result = await call(['workspaces', state.workspace, 'groups', group.id, 'archive'], { method: 'POST',
          body: { expectedRevision: group.revision, confirmName: confirm.value, moveTo: move.value || null },
          headers: admin && stepUp?.token() ? { 'X-Admin-Elevation': stepUp.token() } : {} });
        if (state.closed) return;
        if (!result.ok) {
          // Compensation feedback: nothing changed; say why and leave the dialog for a corrected retry.
          notice.textContent = groupMessage(result.code ?? (result.status === 403 ? 'forbidden' : null));
          if (result.status === 403 && admin) { phase = 'confirm'; submit.textContent = 'Send verification code'; codeField.hidden = true; }
          if ([404, 409].includes(result.status)) { close(); state.editing = null; await load({ keepStatus: true }); say(groupMessage(result.code)); }
          return;
        }
        const target = move.value ? others.find(item => item.id === move.value)?.name : UNGROUPED;
        close(title);
        state.editing = null;
        await load({ keepStatus: true });
        say(`${group.name} archived. ${result.value.moved} ${result.value.moved === 1 ? 'case' : 'cases'} moved to ${target}.`);
        title.focus();
      } finally { if (dialog.open) busy(false); else state.busy = false; }
    });
    dialog.replaceChildren(heading, text, form, notice);
    dialog.showModal();
    confirm.focus();
  }

  const stopTheme = watchTheme(() => { clearCoverCache(); paint(); });
  // Refresh pauses during edits: never while editing, a dialog is open, a request is in flight, the new-group
  // form holds a draft or focus is in a form field.
  function refresh() {
    if (state.closed) return;
    const active = document.activeElement;
    const drafting = dirty();
    if (!mayRefresh({ editing: state.editing !== null, dialogOpen: state.dialogOpen || dialog.open, busy: state.busy, drafting,
      focusInForm: root.contains(active) && active.matches('input, textarea, select, [role="combobox"]') })) return;
    void load({ keepStatus: true });
  }
  const timer = setInterval(refresh, refreshMs);
  window.addEventListener('focus', refresh);
  void load();
  if (!scoped) title.focus();
  return {
    refresh,hasUnsaved:()=>dirty(),pending,
    beforeNavigate(action={}){if(pending())return false;if(allowing||!dirty())return true;attempt(action.resume??(()=>{if(action.href)location.assign(action.href);}));return false;},
    close() {
      leaveGuard.dispose();window.removeEventListener('beforeunload',beforeUnload);dirty=()=>false;continuation=null;archiveGuard?.dispose();disposeSelects(root);
      state.closed = true; generation++; clearInterval(timer); window.removeEventListener('focus', refresh); stopTheme();
      if (dialog.open) dialog.close();
      root.remove();
    },
  };
}

/**
 * Change group: one case's group, with the assignment revision the server CAS-checks. `group` is
 * { id, name, tint, revision }. Resolves the new group through `onChanged`.
 */
export function mountCaseGroup(host, { request, workspaceId, workspaceName = 'Selected workspace', caseId, group, submitButton = null, onChanged = () => {}, onConflict = () => {} }) {
  const wrap = node('section', null, 'case-group'); wrap.setAttribute('aria-labelledby', `case-group-${caseId}`);
  const heading = node('h2', 'Group'); heading.id = `case-group-${caseId}`;
  const select = node('select'); select.className = 'input';
  const save = submitButton ?? node('button', 'Change group', 'btn'); save.type = 'submit';
  const status = node('p', '', 'small muted'); status.setAttribute('role', 'status');
  const form = node('form', null, 'case-group-form');
  if(submitButton){form.id='case-group-form-'+caseId;save.setAttribute('form',form.id);}
  form.append(field('Group for this case', select),...(submitButton?[]:[save]));enhanceSelect(select);
  const retry = compactTool(button('Refresh groups', 'btn quiet'),'refresh'); retry.onclick = () => { if (!busy) void load(); };
  wrap.append(heading, node('p', workspaceName, 'small muted'), form, status, retry);
  host.append(wrap);
  let current = { ...group }, groups = [], busy = false, closed = false, ready = false, generation = 0;
  const syncSave=()=>{save.disabled=busy||!ready||(select.value||null)===current.id;};select.addEventListener('change',syncSave);
  const fill = () => {
    select.replaceChildren(Object.assign(node('option', UNGROUPED), { value: '' }),
      ...groups.map(item => Object.assign(node('option', item.name), { value: item.id })));
    select.value = current.id ?? '';
  };
  async function load() {
    const version = ++generation; ready = false; save.disabled = select.disabled = retry.disabled = true; status.textContent = 'Loading groups…';
    try {
      const value = await request(['workspaces', workspaceId, 'groups']);
      if (closed || version !== generation) return;
      if (!Array.isArray(value?.groups) || !value.groups.every(validGroupRow)) throw new Error('invalid_groups');
      groups = value.groups; fill(); ready = current.id === null || groups.some(item => item.id === current.id); select.disabled = !ready; syncSave();
      status.textContent = !ready ? 'The assigned group changed. Refresh the case before changing its group.' : groups.length ? '' : 'No live groups in this workspace. Create a group here first.';
    } catch { if (!closed && version === generation) status.textContent = 'Groups are unavailable. Refresh groups to retry.'; }
    finally { if (!closed && version === generation) retry.disabled = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || closed || !ready) return;
    const next = select.value || null;
    if (next === current.id) { status.textContent = 'No change.'; return; }
    busy = true; save.disabled = true; status.textContent = 'Saving…';
    try {
      const value = await request(['workspaces', workspaceId, 'cases', caseId, 'group'], { method: 'PUT',
        body: { expectedRevision: current.revision, groupId: next } });
      if (closed) return;
      if (!value?.case || value.case.id !== caseId || value.case.groupId !== next || value.case.groupRevision !== current.revision + 1) throw new Error('invalid_assignment');
      const chosen = groups.find(item => item.id === next);
      current = { id: next, name: chosen?.name ?? null, tint: tintOf(chosen?.tint), revision: value.case.groupRevision };
      status.textContent = `Moved to ${current.name ?? UNGROUPED}.`;
      onChanged(current);
    } catch (error) {
      if (closed) return;
      status.textContent = groupMessage(error?.code);
      if ([404, 409].includes(error?.status)) { ready = false; select.disabled = true; onConflict(); }
    } finally { busy = false; if (!closed) { syncSave();wrap.querySelector('[role="combobox"]')?.focus(); } }
  });
  void load();
  return { pending:()=>busy,hasUnsaved:()=>ready&&(select.value||null)!==current.id,close() { closed = true; generation++; disposeSelects(wrap); wrap.replaceChildren(); wrap.remove(); } };
}
