import { recordDialog, activateSingleActionRow } from './admin-record-dialog.mjs';
import { decorateTools } from './ui-icons.mjs';
// Administration -> People (facilitator-UX A5; prototypes/admin-people.html). Accounts and Members in one list: a row per
// person with every workspace role and case grant, search, a drawer to change roles, add to a workspace, correct the
// Name & role, and disable or delete the account. Every destructive button opens the one confirmation dialog, which
// states its consequences first. A refresh that fails keeps the last list (admin-model.mjs).
import { createSurfaceNotice } from './surface-notice.mjs';
import { collapseSearch } from './surface-controls.mjs';
import { enhanceSelect, disposeSelects } from './accessible-select.mjs';
import { node, clearPrivate } from './auth-ui.mjs';
import { createAdminModel } from './admin-model.mjs';
import { createAdminPolling } from './admin-polling.mjs';
import { adminMessage } from './admin-messages.mjs';
import * as say from './admin-consequences.mjs';
import { workspacePage } from '../shared/admin-workbench.mjs';
import { labelFields } from './facilitator-label-form.mjs';

const ROLE = { owner: 'Can manage', author: 'Can edit', facilitator: 'Can run' };
const LEVEL = { run: 'Can run', edit: 'Can edit' };
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const stateOf = row => row.profile?.soft_deleted_at ? ['Deleted', 'bad'] : row.profile?.disabled_at ? ['Disabled', 'bad'] : row.profile ? ['Active', 'ok'] : row.confirmedAt ? ['Active', 'ok'] : ['Not signed in yet', 'warn'];
const nameOf = row => row.label?.name && row.label.name !== 'Facilitator' ? row.label.name : null;
const MEMBERSHIP_REFUSED = 'The change was refused: the workspace’s people changed since this page loaded, or it would leave the workspace without an owner. Current information has been loaded.';

export function mountAdminPeople(host, { api, request, elevation, confirm, adminEmail = null, onContext = () => {}, onInvite = () => {}, onGate = () => {} }) {
  let recordModal=null;
  let closed = false, pauseNotice = false, workspaceFilter = '', statusFilter = '', focusRecord = null, workspaces = null;
  const root = node('section', null, 'admin-work admin-people');
  const model = createAdminModel({ api, elevation, onChange: () => render() });
  const polling = createAdminPolling({
    refresh: async () => {
      const active = document.activeElement;
      if (closed || model.state.selected || model.state.acting || confirm.state.open || (root.contains(active) && active.matches('input,textarea,select,[role=combobox],[contenteditable],form button'))) return;
      const key = root.contains(active) ? active.closest('button[data-record]')?.dataset.record : null;
      if (await model.load({ quiet: true }) && !closed && !model.state.selected && document.activeElement === document.body) [...root.querySelectorAll('button[data-record]')].find(item => item.dataset.record === key)?.focus();
    },
    onPause: value => { pauseNotice = value; render(); },
  });
  host.replaceChildren(root); onContext('People');
  for (const type of ['pointerdown', 'keydown']) root.addEventListener(type, () => void polling.activity());

  const button = (label, action, role = 'quiet') => { const b = node('button', label, `btn ${role}`); b.type = 'button'; b.onclick = action; return b; };
  const status = text => { const p = node('p', text, 'admin-notice'); p.setAttribute('role', 'status'); return p; };
  const pill = (text, kind = '') => node('span', text, `admin-pill ${kind}`);
  async function liveRooms(email) {
    const result = await api.call('rooms_list', { options: { limit: 100 } });
    return result.ok ? result.data.rooms.filter(room => room.ownerEmail === email) : null;
  }
  async function loadWorkspaces() {
    if (workspaces) return workspaces;
    const page = workspacePage(await request(['admin', 'workspaces', 'query'], { method: 'POST', body: { after: null }, maxResponseBytes: 131072 }));
    if (!page) throw new Error('invalid_workspaces');
    return workspaces = page.workspaces;
  }
  async function membershipRevision(workspaceId) {
    const value = await request(['admin', 'workspace', 'query'], { method: 'POST', body: { workspaceId, tab: 'members', query: '', status: 'all', from: null, until: null, after: null }, maxResponseBytes: 262144 });
    const revision = value?.workspace?.membership_revision;
    if (!Number.isSafeInteger(revision)) throw new Error('invalid_page');
    return revision;
  }
  // One membership change (add, change role, remove): the confirmation, then the step-up-guarded write.
  function askMembership({ row, workspaceId, workspaceName, from, to }) {
    const facts = { email: row.email, workspace: workspaceName, from, to, role: to };
    const lines = to === null ? say.removeMember(facts) : from === null ? say.addMember(facts) : say.changeRole(facts);
    confirm.open({
      title: to === null ? `Remove ${row.email} from ${workspaceName}?` : from === null ? `Add ${row.email} to ${workspaceName}?` : `Change ${row.email} to ${ROLE[to]}?`, sub: `${workspaceName}`,
      consequences: lines, actionLabel: to === null ? 'Remove access' : from === null ? 'Add person' : `Set ${ROLE[to]}`, danger: to === null || from === 'owner', elevation,
      run: async token => {
        try {
          const expectedRevision = await membershipRevision(workspaceId);
          await request(['admin', 'memberships', 'change'], { method: 'POST', headers: { 'X-Admin-Elevation': token }, body: { workspaceId, email: row.email, role: to, transferFrom: null, expectedRevision, confirmEmail: row.email } });
          return { ok: true };
        } catch (error) { return { ok: false, status: error?.status ?? 0, error: error?.code ?? 'admin_unavailable' }; }
      },
      onDone: result => {
        if (closed) return;
        void model.load({ quiet: true }).then(() => {
          model.state.notice = result.ok ? 'Change recorded.' : result.uncertain ? 'Case could not confirm the result. Current information has been loaded; check it before trying again.' : result.status === 409 ? MEMBERSHIP_REFUSED : adminMessage(result.error);
          render();
        });
      },
      onClose: () => render(),
    });
  }
  async function askAccount(row, operation) {
    const rooms = ['facilitators_disable', 'facilitators_soft_delete'].includes(operation) ? await liveRooms(row.email) : null;
    if (closed || !row.profile) return;
    const soft = operation === 'facilitators_soft_delete';
    confirm.open({ title: soft ? `Soft delete ${row.email}?` : `Disable ${row.email}?`, sub: (row.access?.memberships ?? []).map(m => `${ROLE[m.role]} in ${m.workspaceName}`).join(' · ') || row.email,
      consequences: soft ? say.softDelete({ rooms }) : say.disable({ rooms }), actionLabel: soft ? say.softDeleteLabel(rooms) : say.disableLabel(rooms), elevation,
      run: () => model.act(operation, { record: row }), onDone: () => { focusRecord = row.id; render(); } });
  }
  function askLabel(row, label) {
    confirm.open({ title: 'Correct this name and role?', sub: row.email, consequences: ['Participants see the corrected name and role on their records.', 'The facilitator is asked to confirm it again at their next sign-in.'],
      actionLabel: 'Save name and role', danger: false, elevation, run: () => model.act('facilitators_label', { label, record: row }), onDone: () => render() });
  }
  async function direct(row, operation) {
    const result = await model.act(operation, { record: row });
    if (!result.ok && !closed) { model.state.notice = adminMessage(result.error); render(); }
  }
  function accessCard(row) {
    const card = node('section', null, 'admin-card'); card.append(node('h4', 'Access'));
    if (row.access === null) { card.append(node('p', 'Case could not read this person’s roles. Refresh to try again.', 'admin-notice')); return card; }
    const memberships = row.access.memberships;
    if (!memberships.length && !row.access.grants.length) card.append(node('p', 'No access yet. Add them to a workspace, or invite them under Invitations.', 'admin-muted'));
    for (const m of memberships) {
      const line = node('label', null, 'admin-access-row'), select = node('select');
      select.setAttribute('aria-label', `Access in ${m.workspaceName}`);
      for (const [value, label] of [['facilitator', 'Can run'], ['author', 'Can edit'], ['owner', 'Can manage'], ['remove', `Remove from ${m.workspaceName}`]]) select.append(Object.assign(node('option', label), { value, selected: value === m.role }));
      select.addEventListener('change', () => askMembership({ row, workspaceId: m.workspaceId, workspaceName: m.workspaceName, from: m.role, to: select.value === 'remove' ? null : select.value }));
      line.append(node('span', m.workspaceName), select); card.append(line);
    }
    if (row.access.grants.length) {
      card.append(node('h5', 'Shared cases'));
      const list = node('ul', null, 'admin-grants');
      for (const g of row.access.grants) list.append(node('li', `${LEVEL[g.level]} · ${g.caseTitle} (${g.workspaceName})`));
      card.append(list);
    }
    const add = node('details', null, 'admin-add'); add.append(node('summary', '+ Add to a workspace'));
    const wsSelect = node('select'), roleSelect = node('select'), go = button('Add', () => {}, 'primary');
    wsSelect.setAttribute('aria-label', 'Workspace to add to'); roleSelect.setAttribute('aria-label', 'Access to add');
    for (const [value, label] of [['facilitator', 'Can run'], ['author', 'Can edit'], ['owner', 'Can manage']]) roleSelect.append(Object.assign(node('option', label), { value }));
    add.addEventListener('toggle', async () => {
      if (!add.open || wsSelect.options.length) return;
      try { const all = (await loadWorkspaces()).filter(w => !memberships.some(m => m.workspaceId === w.id)); wsSelect.replaceChildren(...all.map(w => Object.assign(node('option', w.name), { value: w.id }))); go.disabled = !all.length; if (!all.length) add.append(node('p', 'They are in every workspace already.', 'admin-muted')); }
      catch { add.append(node('p', 'Workspaces could not be loaded. Close this and try again.', 'admin-notice')); }
    });
    go.onclick = () => { const w = workspaces?.find(x => x.id === wsSelect.value); if (w) askMembership({ row, workspaceId: w.id, workspaceName: w.name, from: null, to: roleSelect.value }); };
    const line = node('div', null, 'admin-access-row'); line.append(wsSelect, roleSelect, go); add.append(line); card.append(add);
    return card;
  }
  function labelEditor(row) {
    const form = node('form', null, 'admin-label'), fields = labelFields({ name: row.label?.name ?? '', role: row.label?.role ?? '' }), save = node('button', 'Save name and role', 'btn'); save.type = 'submit';
    form.append(node('h4', 'Name on records'), node('p', row.label?.confirmed ? 'Confirmed by the facilitator.' : 'Not yet confirmed by the facilitator; they will see it at their next sign-in.', 'admin-muted'), fields.root, save);
    form.addEventListener('submit', event => { event.preventDefault(); if (closed || model.state.acting || !fields.validate()) return; askLabel(row, fields.value()); });
    return form;
  }
  function drawerFor(row) {
    const drawer = node('dialog', null, 'admin-record-dialog'); drawer.setAttribute('aria-label', 'Selected record'); drawer.tabIndex = -1;
    const [stateText] = stateOf(row), profile = row.profile;
    drawer.append(button('Back to results', () => { const key = model.state.selected?.id; model.cancel(); [...root.querySelectorAll('button[data-record]')].find(b => b.dataset.record === key)?.focus({ preventScroll: true }); }),
      node('h3', nameOf(row) ?? row.email), node('p', row.email, 'admin-muted'), accessCard(row));
    const facts = node('section', null, 'admin-card'); facts.append(node('h4', 'Account'));
    const dl = node('dl'); for (const [k, v] of [['Status', stateText], ['Confirmed', date(row.confirmedAt)], ['Invited', date(row.invitedAt)], ['Created', date(row.createdAt)], ['Deletion due', profile?.soft_deleted_at ? date(profile.delete_due_at) : null]]) if (v !== null) dl.append(node('dt', k), node('dd', v));
    facts.append(dl); drawer.append(facts);
    if (profile && !profile.soft_deleted_at) drawer.append(labelEditor(row));
    const zone = node('section', null, 'admin-card admin-danger'); zone.append(node('h4', 'Account actions'));
    if (!profile) zone.append(node('p', 'This person has not signed in yet, so their account cannot be disabled or deleted. Revoke their invitation under Invitations if sent in error.', 'admin-muted'));
    else if (profile.soft_deleted_at) {
      if (profile.delete_due_at && Date.parse(profile.delete_due_at) > Date.now()) zone.append(button('Restore', () => void direct(row, 'facilitators_restore')));
      zone.append(node('p', `Deleted. The account is removed for good on ${date(profile.delete_due_at)}; Restore works until then.`, 'admin-muted'));
    } else {
      zone.append(button(profile.disabled_at ? 'Enable' : 'Disable…', () => profile.disabled_at ? void direct(row, 'facilitators_enable') : void askAccount(row, 'facilitators_disable'), profile.disabled_at ? 'quiet' : 'danger'), document.createTextNode(' '),
        button('Soft delete…', () => void askAccount(row, 'facilitators_soft_delete'), 'danger'),
        node('p', 'Disable is reversible. Delete removes the account after 30 days; Restore works until then.', 'admin-muted'));
    }
    drawer.append(zone);
    for (const control of drawer.querySelectorAll('button,input,select')) if (model.state.acting) control.disabled = true;
    return drawer;
  }
  const notices=createSurfaceNotice();let lastNotice='',searchControl=null;
  function render() {
    if (closed) return;
    if(recordModal)lastNotice='';recordModal?.dispose();recordModal=null;
    const draftQuery=root.querySelector('input[type=search]')?.value,searchOpen=root.querySelector('.surface-search [aria-expanded=true]')!==null;searchControl?.dispose();
    const state = model.state, restore = focusRecord, filterFocus = root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null; disposeSelects(root); clearPrivate(root); onGate(state.gate);
    const head = node('div', null, 'admin-head'); head.append(node('h2', 'People','sr-only'), button('+ Invite person', () => onInvite(), 'primary')); root.append(head);
    root.append(node('p', 'Everyone with access to Case, with every workspace role and shared case. Search checks 100 accounts at a time; Next page continues.', 'supporting-note'));
    if (state.gate !== 'ready') {
      root.append(status(state.loading || state.gate === 'loading' ? 'Loading people…' : state.gate === 'sign_in' ? 'Sign in to continue.' : 'People are unavailable.'));
      if (state.gate === 'unavailable') { root.append(status(state.notice)); root.append(button('Refresh information', () => void model.load())); }
      return;
    }
    if (pauseNotice) root.append(status('Automatic refresh is paused after inactivity. Use any control to continue.'));
    const filters = node('form', null, 'admin-toolbar'), label = node('label', 'Search people by email'), input = node('input'); input.type = 'search'; input.maxLength = 320; input.value = draftQuery??state.query;searchControl=collapseSearch(input,{label:'Search people by email'});label.className='sr-only';
    const submit = node('button', 'Search', 'btn'); submit.type = 'submit'; filters.append(searchControl.root);searchControl.addSubmit();
    filters.addEventListener('submit',async event=>{event.preventDefault();if(closed||model.state.acting)return;await model.search(input.value);if(!closed)root.querySelector('button[data-record]')?.focus();});
    const names = [...new Set(state.rows.flatMap(r => r.access?.memberships.map(m => m.workspaceName) ?? []))].sort();
    const wsSel = node('select'), stSel = node('select'); wsSel.setAttribute('aria-label', 'Workspace'); stSel.setAttribute('aria-label', 'Status'); wsSel.dataset.focusKey = 'people-workspace'; stSel.dataset.focusKey = 'people-status';
    wsSel.append(Object.assign(node('option', 'All workspaces'), { value: '' }), ...names.map(n => Object.assign(node('option', n), { value: n }))); wsSel.value = names.includes(workspaceFilter) ? workspaceFilter : '';
    stSel.append(...[['', 'Any status'], ['Active', 'Active'], ['Disabled', 'Disabled'], ['Deleted', 'Deleted'], ['Not signed in yet', 'Not signed in yet']].map(([v, l]) => Object.assign(node('option', l), { value: v }))); stSel.value = statusFilter; wsSel.disabled = stSel.disabled = state.acting;
    for (const option of stSel.options) if (option.value) option.dataset.tone = option.value === 'Active' ? 'ok' : option.value === 'Not signed in yet' ? 'warn' : 'bad';
    wsSel.onchange = () => { workspaceFilter = wsSel.value; render(); }; stSel.onchange = () => { statusFilter = stSel.value; render(); };
    const toolbar = node('div', null, 'admin-toolbar'); toolbar.append(button('Refresh information', () => void model.load({ quiet: true })));
    filters.append(wsSel,stSel,toolbar);head.insertBefore(filters,head.lastChild);if(searchOpen)queueMicrotask(()=>searchControl?.open());
    decorateTools(root);
    const shown = state.rows.filter(r => (!workspaceFilter || r.access?.memberships.some(m => m.workspaceName === workspaceFilter)) && (!statusFilter || stateOf(r)[0] === statusFilter));
    const table = node('table', null, 'admin-table admin-people-table'), thead = node('thead'), hr = node('tr'), body = node('tbody');
    for (const text of ['Person', 'Workspaces and shared cases', 'Status']) { const th = node('th', text); th.scope = 'col'; hr.append(th); } thead.append(hr);
    for (const row of shown) {
      const tr = node('tr'), td = node('td'), open = node('button', nameOf(row) ?? row.email, 'btn tertiary'); open.type = 'button'; open.dataset.record = row.id;
      open.addEventListener('click', () => { if (closed || model.state.acting) return; model.select(row); }); td.append(open);
      if (nameOf(row)) td.append(node('br'), node('span', row.email, 'admin-muted'));
      const access = node('td'); if (row.access === null) access.append(node('span', 'Roles not available', 'admin-muted'));
      else { for (const m of row.access.memberships) access.append(pill(`${ROLE[m.role]} · ${m.workspaceName}`, m.role)); for (const g of row.access.grants) access.append(pill(`${LEVEL[g.level]} · ${g.caseTitle}`, 'grant')); if (!row.access.memberships.length && !row.access.grants.length) access.append(node('span', 'No access yet', 'admin-muted')); }
      const [text, kind] = stateOf(row); const st = node('td'); st.append(pill(text, kind));
      td.dataset.label='Person';access.dataset.label='Workspaces and shared cases';st.dataset.label='Status';
      tr.append(td, access, st);activateSingleActionRow(tr,open); body.append(tr);
    }
    table.append(node('caption', 'People · current page'), thead, body);
    const content = node('div', null, 'admin-content'), listPanel = node('div', null, 'admin-list'), scroll = node('div', null, 'admin-scroll'); scroll.append(table); listPanel.append(scroll);
    if (!shown.length) listPanel.append(node('p', state.rows.length ? 'Nobody on this page matches those filters.' : 'No records on this page.', 'admin-muted'));
    const pagination = node('div', null, 'admin-pagination'); pagination.append(node('p', `Page ${state.page}`));
    if (state.page > 1) pagination.append(button('Previous page', () => void model.load({ page: state.page - 1 })));
    if (state.next !== null) pagination.append(button('Next page', () => void model.load({ page: state.next })));
    listPanel.append(pagination); content.append(listPanel);
    if (state.selected) { const row = state.rows.find(r => r.id === state.selected.id) ?? state.selected,dialog=drawerFor(row);content.append(dialog);
      const back=dialog.querySelector('button');if(back)back.hidden=true;
      root.append(content);const index=shown.findIndex(r=>r.id===row.id);
      recordModal=recordDialog(dialog,{pending:()=>model.state.acting||confirm.state.open,opener:()=>root.querySelector('button[data-record="'+row.id+'"]'),close:()=>{const key=row.id;model.cancel();root.querySelector('button[data-record="'+key+'"]')?.focus({preventScroll:true});},previous:index>0?()=>model.select(shown[index-1]):null,next:index>=0&&index+1<shown.length?()=>model.select(shown[index+1]):null});
    }
    if(!content.isConnected)root.append(content);
    for (const control of root.querySelectorAll('.admin-toolbar button,.admin-toolbar input')) if (state.acting) control.disabled = true;
    for (const select of root.querySelectorAll('select')) enhanceSelect(select);
    if (!restore && filterFocus) [...root.querySelectorAll('[role=combobox][data-focus-key]')].find(control => control.dataset.focusKey === filterFocus)?.focus();
    if (restore) { focusRecord = null; [...root.querySelectorAll('button[data-record]')].find(b => b.dataset.record === restore)?.focus(); }
    if(state.notice&&state.notice!==lastNotice){lastNotice=state.notice;notices.notify(state.notice,{error:state.notice!=='Change recorded.'});}else if(!state.notice){lastNotice='';notices.clear();}
  }
  render(); void model.load().then(() => { if (!closed) polling.start(); });
  return {
    beforeNavigate(action) { return !model.state.acting && recordModal?.beforeNavigate(action)!==false; },
    close() { closed = true;recordModal?.dispose();notices.close();searchControl?.dispose(); polling.close(); model.clear('pagehide'); disposeSelects(root); clearPrivate(root); host.replaceChildren(); },
  };
}
