import { recordDialog } from './admin-record-dialog.mjs';
import { decorateTools } from './ui-icons.mjs';
// Administration -> Cases, Rooms and Activity (facilitator-UX A5; prototypes/admin-people.html). Private, lazy, one
// workspace at a time (Activity also reads the deployment-wide log). Reads are bounded; a change goes through the one
// confirmation dialog (admin-confirm.mjs), which states its consequences before it asks for a code. Members and Groups
// moved: People changes roles, Workspaces opens Groups. Mutations are never retried.
import { createSurfaceNotice } from './surface-notice.mjs';
import { collapseSearch, disclosure } from './surface-controls.mjs';
import { node, accountRequest, clearPrivate } from './auth-ui.mjs';
import { enhanceSelect, disposeSelects } from './accessible-select.mjs';
import { workspacePage, workspaceRow, workbenchRow, auditTarget, snapshotEntries, auditLabel, activitySentence } from '../shared/admin-workbench.mjs';
import { recordRow } from './record-row.mjs';
import { sessionUrl } from '../shared/urls.mjs';
import { adminMessage } from './admin-messages.mjs';
import { withdrawVersion, republishVersion, endRoom } from './admin-consequences.mjs';
const TITLES = { cases: 'Cases', rooms: 'Sessions', activity: 'Activity' };
const DEPLOYMENT = 'deployment';
const PHASE = { lobby: 'Lobby', surface_live: 'Case on screen', responses_open: 'Responses open', responses_locked: 'Responses locked', path_selected: 'Path chosen', consequence_revealed: 'Consequence shown', terminal_teaching: 'Teaching', discussion_paused: 'Discussion paused', ended: 'Ended' };
const STATUS = { lobby: 'Lobby', live: 'Live', ended: 'Ended', expired: 'Expired', published: 'Published', withdrawn: 'Withdrawn' };
const button = (text, fn, role = 'quiet') => { const b = node('button', text, `btn ${role}`); b.type = 'button'; b.onclick = fn; return b; };
const field = (text, control) => { const label = node('label', text); label.append(control); return label; };
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const rows = items => { const dl = node('dl'); for (const [key, value] of items) dl.append(node('dt', key), node('dd', value === null || value === undefined ? 'Not recorded' : String(value))); return dl; };

export function mountAdminWorkbench(host, { auth, api, elevation, confirm, onContext = () => {} }) {
  const notices=createSurfaceNotice();
  let recordModal=null,recordRows=[];
  let closed = false, generation = 0, inventoryGeneration = 0, recordReader = null, applied = null, tab = 'cases', workspaces = [], scopeId = null, after = null, pages = [], selected = null, groups = null, picker = null, liveRooms = null, workspaceAfter = null;
  const seenWorkspaces = new Set();
  const root = node('section', null, 'workspace-workbench'), title = node('h2',null,'sr-only'), scope = node('p', null, 'supporting-note');
  const scopeControl = node('select'), loadMore = button('More workspaces', () => void loadWorkspaces()), retryWorkspace = button('Retry workspaces', () => void loadWorkspaces());
  scopeControl.setAttribute('aria-label', 'Workspace'); loadMore.hidden = retryWorkspace.hidden = true;
  const scopeTools = node('div', null, 'workbench-scope'); scopeTools.append(field('Workspace', scopeControl), loadMore, retryWorkspace);
  const form = node('form', null, 'workbench-tools admin-toolbar'), query = node('input'), statusFilter = node('select'), from = node('input'), until = node('input');
  query.type = 'search'; query.maxLength = 200; from.type = until.type = 'date';
  const submit = node('button', 'Apply filters', 'btn'); submit.type = 'submit';
  const statusField = field('Recorded state', statusFilter), fromField = field('From (UTC)', from), untilField = field('Before (UTC)', until);
  enhanceSelect(statusFilter,{label:'Recorded state',tool:'status'});
  form.append(field('Search', query), statusField, fromField, untilField, submit, button('Clear', () => { query.value = from.value = until.value = ''; statusFilter.value = 'all'; void load(true); }));
  const searchControl=collapseSearch(query,{label:'Search '+TITLES[tab].toLowerCase()});form.firstChild.replaceWith(searchControl.root);searchControl.addSubmit();const dates=node('div',null,'session-date-filters');dates.append(fromField,untilField);const dateDisclosure=disclosure('date filters',dates,{tool:'date'});form.insertBefore(dateDisclosure,submit);form.prepend(scopeTools);
  const notice = node('p', 'Loading workspaces…', 'admin-notice'); notice.setAttribute('role', 'status');
  const liveHost = node('section', null, 'admin-live'); liveHost.hidden = true;
  const content = node('div', null, 'admin-content'), listPanel = node('div', null, 'admin-list'), list = node('ul', null, 'workbench-rows'), detail = node('dialog', null, 'admin-record-dialog');
  detail.tabIndex = -1; detail.setAttribute('aria-label', 'Selected record'); detail.hidden = true;
  const pagination = node('div', null, 'admin-pagination'), prev = button('Previous page', () => { if (pages.length) { after = pages.pop(); void load(false); } }),
    next = button('Next page', () => { pages.push(after); after = next.dataset.after; void load(false); }), refresh = button('Refresh', () => void load(true));
  pagination.append(prev, next, refresh); listPanel.append(list, pagination); content.append(listPanel, detail); root.append(title, form, scope, notice, liveHost, content); host.append(root);decorateTools(root);
  const current = g => !closed && g === generation;
  const request = (parts, options) => accountRequest(auth, parts, options);
  const workspace = () => workspaces.find(w => w.id === scopeId) ?? null;
  const deployment = () => tab === 'activity' && scopeId === DEPLOYMENT;
  function closeDetail() { recordModal?.dispose();recordModal=null;groups?.close(); groups = null; recordReader?.close(); recordReader = null; const key = selected?.id; selected = null; disposeSelects(detail); clearPrivate(detail); detail.hidden = true; content.classList.remove('has-detail'); [...list.querySelectorAll('button[data-record]')].find(b => b.dataset.record === key)?.focus({ preventScroll: true }); }
  async function loadWorkspaces() {
    const g = ++inventoryGeneration; retryWorkspace.hidden = true; loadMore.disabled = true;
    try {
      const value = workspacePage(await request(['admin', 'workspaces', 'query'], { method: 'POST', body: { after: workspaceAfter }, maxResponseBytes: 131072 }));
      if (closed || g !== inventoryGeneration) return;
      if (!value || value.workspaces.some(w => seenWorkspaces.has(w.id))) throw new Error('invalid_workspaces');
      for (const row of value.workspaces) { seenWorkspaces.add(row.id); workspaces.push(row); }
      workspaceAfter = value.nextAfter; loadMore.hidden = workspaceAfter === null; fillScope();
      if (scopeId === null && workspaces.length) { scopeId = workspaces[0].id; scopeControl.value = scopeId; void load(true); }
      else if (!workspaces.length && tab === 'activity') { scopeId = DEPLOYMENT; fillScope(); void load(true); } else if (!workspaces.length) notice.textContent = 'No workspaces are available.';
    } catch { if (!closed && g === inventoryGeneration) { notice.textContent = 'Workspaces are unavailable. Retry to check your current access.'; retryWorkspace.hidden = false; } }
    finally { if (!closed && g === inventoryGeneration) loadMore.disabled = false; }
  }
  function fillScope() {
    picker?.dispose(); picker = null;
    const options = workspaces.map(row => Object.assign(node('option', row.name), { value: row.id }));
    if (tab === 'activity') options.push(Object.assign(node('option', 'Deployment-wide (sign-in codes and account changes)'), { value: DEPLOYMENT }));
    scopeControl.replaceChildren(...options); if (scopeId && options.some(o => o.value === scopeId)) scopeControl.value = scopeId;
    picker = options.length ? enhanceSelect(scopeControl) : null;
  }
  function body(cursor) { return { workspaceId: scopeId, tab: tab === 'activity' ? 'audit' : tab, query: query.value.trim(), status: statusFilter.value, from: from.value ? new Date(`${from.value}T00:00:00.000Z`).toISOString() : null, until: until.value ? new Date(`${until.value}T00:00:00.000Z`).toISOString() : null, after: cursor }; }
  function validPage(value) { const kind = deployment() ? 'operations' : tab === 'activity' ? 'audit' : tab; return value && Array.isArray(value.rows) && value.rows.length <= 20 && value.rows.every(r => workbenchRow(kind, r)) && new Set(value.rows.map(r => r.id)).size === value.rows.length && (value.nextAfter === null || typeof value.nextAfter === 'string' && value.nextAfter.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value.nextAfter)) && (kind === 'operations' || workspaceRow(value.workspace) && value.workspace.id === scopeId); }
  async function loadLive() {
    if (tab !== 'rooms') { liveHost.hidden = true; return; }
    const result = await api.call('rooms_list', { options: { limit: 100 } });
    if (closed || tab !== 'rooms') return;
    liveHost.hidden = false; liveHost.replaceChildren(node('h3', 'Live now'));
    if (!result.ok) { liveRooms = null; liveHost.append(node('p', 'Live rooms could not be read. Nothing was changed; refresh to try again.', 'admin-notice')); return; }
    liveRooms = result.data.rooms;
    if (!liveRooms.length) { liveHost.append(node('p', 'No session is live right now.', 'admin-muted')); return; }
    const table = node('table', null, 'admin-table'), head = node('thead'), hr = node('tr'), tbody = node('tbody');
    for (const label of ['Owner', 'Where it is', 'Phones joined', 'Expires', 'Actions']) { const th = node('th', label); th.scope = 'col'; hr.append(th); } head.append(hr);
    for (const room of liveRooms) {
      const tr = node('tr'), end = button('End case', () => endLive(room), 'danger'); end.setAttribute('aria-label', `End the room of ${room.ownerEmail ?? 'an unknown owner'}`);
      const cell = node('td'); cell.append(end);
      tr.append(node('td', room.ownerEmail ?? 'Owner unknown'), node('td', PHASE[room.phase] ?? 'Live'), node('td', String(room.participantCount)), node('td', date(room.expiresAt)), cell); tbody.append(tr);
    }
    table.append(node('caption', 'Rooms running now'), head, tbody); const scroll = node('div', null, 'admin-scroll'); scroll.append(table); liveHost.append(scroll);
  }
  async function load(reset) {
    if (closed || !scopeId) return;
    const g = ++generation;
    if (reset) { after = null; pages = []; applied = deployment() ? { query: query.value.trim() } : body(null); }
    recordModal?.dispose();recordModal=null;recordReader?.close(); recordReader = null; selected = null; detail.hidden = true; clearPrivate(detail); content.classList.remove('has-detail'); groups?.close(); groups = null; clearPrivate(list);
    statusField.hidden = !['rooms', 'cases'].includes(tab); fromField.hidden = untilField.hidden = deployment();dateDisclosure.hidden=deployment();
    const ws = workspace();
    scope.textContent = deployment() ? 'Deployment-wide · administrator sign-in codes and account changes, with the recorded outcome' : ws ? `${ws.name}` : '';
    title.textContent = TITLES[tab]; onContext(TITLES[tab]); notice.textContent = 'Loading…'; prev.hidden = next.hidden = true;
    void loadLive();
    try {
      const value = await request(['admin', deployment() ? 'operations' : 'workspace', 'query'], { method: 'POST', body: { ...applied, after }, maxResponseBytes: 262144 });
      if (!current(g)) return; if (!validPage(value)) throw new Error('invalid_page');
      recordRows=value.rows;const audit = tab === 'activity';
      for (const row of value.rows) {
        const meta = tab === 'cases' ? `v${row.version_no} · ${STATUS[row.status] ?? row.status} · ${row.group_name ?? 'Ungrouped'}` : tab === 'rooms' ? `v${row.version_no} · ${STATUS[row.status] ?? row.status} · ${date(row.created_at)}` : `${auditTarget(row.target_type, row.target_id)} · ${date(row.at)}`;
        const { item, row: main } = recordRow(audit ? activitySentence(row) : row.title, meta, () => openDetail(row)); main.dataset.record = row.id; list.append(item);
      }
      notice.textContent = value.rows.length ? '' : audit ? 'No activity matches this view.' : 'No records match this view.'; next.dataset.after = value.nextAfter ?? ''; next.hidden = value.nextAfter === null; prev.hidden = pages.length === 0;
    } catch (error) { if (current(g)) notice.textContent = error?.status === 403 ? adminMessage('forbidden') : error?.status === 400 ? 'Check the filter dates or refresh the query.' : 'Records are unavailable. Refresh to try again.'; }
  }
  const finish = (what, result) => {
    if (closed) return;
    const said = result.ok ? `${what} Current information loaded.` : result.uncertain ? 'Case could not confirm the result. Current information has been loaded; check it before trying again.' : adminMessage(result.error);
    void load(true).then(() => { if (!closed) notices.notify(said,{error:!result.ok}); });
  };
  const act = (operation, options, body, token) => api.call(operation, { options, body, elevation: token });
  function askVersion(row) {
    const withdrawing = row.status === 'published', facts = { title: row.title, versionNo: row.version_no };
    confirm.open({ title: withdrawing ? `Withdraw “${row.title}”?` : `Republish “${row.title}”?`, sub: `${workspace()?.name ?? ''} · version ${row.version_no}`, consequences: withdrawing ? withdrawVersion(facts) : republishVersion(facts),
      actionLabel: withdrawing ? 'Withdraw version' : 'Republish version', danger: withdrawing, elevation,
      run: token => withdrawing ? act('versions_withdraw', { id: row.id }, { expectedRevision: row.admin_revision }, token) : act('cases_publish', { id: row.case_id }, { expectedRevision: row.admin_revision, versionId: row.id }, token),
      onDone: result => finish(withdrawing ? 'Version withdrawn.' : 'Version republished.', result) });
  }
  function askEnd(sessionId, label, participantCount) {
    confirm.open({ title: 'End this session?', sub: label, consequences: endRoom({ participantCount }), actionLabel: 'End case', elevation,
      run: token => act('rooms_end', { id: sessionId }, {}, token), onDone: result => finish('Session ended.', result) });
  }
  const endLive = room => askEnd(room.sessionId, room.ownerEmail ? `Run by ${room.ownerEmail}` : 'Owner unknown', room.participantCount);
  function openDetail(row) {
    if (closed) return;recordModal?.dispose();recordModal=null; groups?.close(); groups = null; recordReader?.close(); recordReader = null; selected = row; clearPrivate(detail); detail.hidden = false; content.classList.add('has-detail');
    detail.append(node('h3', tab === 'activity' ? activitySentence(row) : row.title));
    detail.append(node('p', deployment() ? 'Deployment-wide' : workspace()?.name ?? '', 'muted'));
    if (tab === 'cases') {
      detail.append(rows([['Version', row.version_no], ['Status', STATUS[row.status] ?? row.status], ['Group', row.group_name ?? 'Ungrouped'], ['Case ID', row.case_id], ['Version ID', row.id]]));
      const groupButton = button('Change group', async () => {
        groupButton.disabled = true; const note = node('p', 'Loading groups…'); detail.append(note);
        try { const { mountCaseGroup } = await import('./groups-screen.mjs'); if (closed || selected !== row) return; groups?.close();
          groups = mountCaseGroup(detail, { request, workspaceId: scopeId, workspaceName: workspace().name, caseId: row.case_id, group: { id: row.group_id, name: row.group_name, tint: row.tint, revision: row.group_revision }, onChanged: () => void load(true), onConflict: () => void load(true) }); note.remove(); }
        catch { if (!closed && selected === row) note.textContent = 'Group choices are unavailable. Try Change group again.'; } finally { if (!closed) groupButton.disabled = false; }
      });
      detail.append(groupButton, button(row.status === 'published' ? 'Withdraw version' : 'Republish version', () => askVersion(row), row.status === 'published' ? 'danger' : 'primary'));
    } else if (tab === 'rooms') {
      detail.append(rows([['Recorded state', STATUS[row.status] ?? row.status], ['Started', date(row.started_at)], ['Ended', date(row.ended_at)], ['Expires', date(row.expires_at)], ['Session ID', row.id], ['Version ID', row.case_version_id]]), node('p', 'Recorded status may lag the live session. Opening a record does not grant live control.', 'muted'));
      const running = ['lobby', 'live'].includes(row.status) && Date.parse(row.expires_at) > Date.now();
      if (row.own && running) { const link = node('a', 'Rejoin session', 'btn'); link.href = sessionUrl(row.id, 'facilitate', location.origin); detail.append(link); }
      if (running) detail.append(button('End case', () => askEnd(row.id, row.title, liveRooms?.find(room => room.sessionId === row.id)?.participantCount ?? 0), 'danger'));
      detail.append(button('Open session record', async () => {
        const selectedRow = row, g = generation;
        try { const { mountSessionDetail } = await import('./session-detail.mjs'); if (!current(g) || selected !== selectedRow) return; recordReader?.close(); const target = node('div'); detail.append(target);
          recordReader = mountSessionDetail(target, { auth, sessionId: row.id, current: () => current(g) && selected === selectedRow, onBack: () => { recordReader = null; target.remove(); detail.focus(); } }); }
        catch { if (current(g)) notice.textContent = 'Session records are unavailable. Try again.'; }
      }));
    } else {
      detail.append(rows([['What happened', activitySentence(row)], ['Event', auditLabel(row.action)], ['Who', row.actor_email ?? row.actor_kind ?? 'Not recorded'], ['About', auditTarget(row.target_type, row.target_id)], ['Recorded', date(row.at)], ['Record ID', row.id],
        ...(deployment() ? [['Outcome', row.phase === 'unresolved' ? 'Not yet recorded; do not infer success' : row.phase === 'outcome' ? 'Recorded' : 'Attempt recorded'], ['Outcome time', date(row.outcome_at)]] : [])]));
      for (const [label, snapshot] of [['Before', row.before_state ?? row.before], ['After', row.after_state ?? row.after]]) { const entries = snapshotEntries(snapshot); detail.append(node('h4', label), entries.length ? rows(entries) : node('p', 'Not recorded', 'muted')); }
    }
    const index=recordRows.findIndex(r=>r.id===row.id);recordModal=recordDialog(detail,{close:closeDetail,pending:()=>confirm.state.open,dirty:()=>Boolean(groups?.hasUnsaved?.()),opener:()=>list.querySelector('button[data-record="'+row.id+'"]'),previous:index>0?()=>openDetail(recordRows[index-1]):null,next:index>=0&&index+1<recordRows.length?()=>openDetail(recordRows[index+1]):null});
  }
  form.onsubmit = event => { event.preventDefault(); void load(true); };
  scopeControl.onchange = () => { scopeId = scopeControl.value; void load(true); };
  function show(nextTab) {
    if (closed) return; tab = nextTab; query.value = from.value = until.value = ''; searchControl.setLabel('Search '+TITLES[tab].toLowerCase()); fillScope();
    if (tab !== 'activity' && scopeId === DEPLOYMENT) { scopeId = workspaces[0]?.id ?? null; if (scopeId) scopeControl.value = scopeId; }
    statusFilter.replaceChildren(...(tab === 'rooms' ? ['all', 'lobby', 'live', 'ended', 'expired'] : tab === 'cases' ? ['all', 'published', 'withdrawn'] : ['all']).map(value => {const option=Object.assign(node('option',value==='all'?'All states':STATUS[value]),{value});if(value!=='all')option.dataset.tone=({published:'ok',withdrawn:'warn',lobby:'private',live:'ok',ended:'muted',expired:'warn'})[value];return option;}));
    if (scopeId) void load(true);
  }
  void loadWorkspaces();
  return { show, beforeNavigate(action) { if(recordModal?.beforeNavigate(action)===false)return false;return recordReader?.beforeNavigate() ?? true; },
    close() { closed = true;recordModal?.dispose();notices.close();searchControl.dispose(); generation++; inventoryGeneration++; recordReader?.close(); recordReader = null; groups?.close(); picker?.dispose(); disposeSelects(root); selected = scopeId = null; workspaces = []; clearPrivate(root); root.remove(); } };
}
