import { decorateTools, uiIcon } from './ui-icons.mjs';
import { compactTool } from './ui-icons.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
// The facilitator catalogue (card 29, CASE-166): a workspace picker, search, Length and Audience filters,
// sort, honest paging, and Grid / Table / Board views over one server-sorted dataset. Cards are a single
// link named by the title, with canvas covers (card 28) in their group's tint. Start room lives on case
// detail. Card 30 adds the Group filter, column and board columns, and the owners' Groups screen (lazy).
// Text only: every value is set with textContent.
import { accountRequest, node } from './auth-ui.mjs';
import { catalogueSearch, CATALOGUE_PAGE, CATALOGUE_DURATIONS, CATALOGUE_UNGROUPED } from '../shared/catalogue.mjs';
import { validCatalogueGroupRow, UNGROUPED } from '../shared/groups.mjs';
import { caseEditUrl, caseEditWorkspaceUrl, caseEditSourceUrl, caseEditSourceViewUrl, caseVersionUrl, casesUrl, caseWorkspaceUrl, parseCaseWorkspace, parseRoute } from '../shared/urls.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { paintCovers, clearCoverCache } from './cover-art.mjs';
import { coverFor, pilotTag, formatDate } from './library-parts.mjs';
import { watchTheme } from './appearance-watch.mjs';
import { cataloguePage, showingText, lengthText, fieldText, groupText, ariaSort, nextSort, boardColumns, SORT_CHOICES,
  TABLE_COLUMNS, BOARD_COLUMNS } from './library-model.mjs';

import { caseTile } from './case-tile.mjs';
import { collapseSearch } from './surface-controls.mjs';
import { isPlainNavigation } from './shared-menu.mjs';
import { enhanceSelect } from './accessible-select.mjs';
import { mountBuilderDraftList } from './builder-draft-list.mjs';

const RANK = { facilitator: 1, author: 2, owner: 3 };
const addsAccess = row => row.memberRole === null || RANK[row.memberRole] < (row.level === 'edit' ? 2 : 1);
const optionalPilot = (row, pin) => { const tag = pilotTag(row, pin); return tag ? [tag] : []; };
const VIEWS = [['grid', 'Grid'], ['table', 'Table'], ['board', 'Board']];
let controlId = 0;
// A control with its own <label for>, so its accessible name is the label alone.
const select = (label, options, className = 'library-select') => {
  const wrap = node('div', null, className);
  const control = node('select'); control.className = 'input'; control.id = `library-control-${++controlId}`;
  const name = node('label', label, 'library-label'); name.htmlFor = control.id;
  for (const [value, text] of options) { const option = node('option', text); option.value = value; control.append(option); }
  wrap.append(name, control);
  const choice = enhanceSelect(control, { label,tool:({Workspace:'workspace',Sort:'sort',Columns:'filters'})[label]??null });
  return { wrap, control, choice };
};
export function mountLibrary(host, { auth, me, onStart, onContext = () => {}, onNavigate=href=>location.assign(href) }) {
  const notices=createSurfaceNotice();
  const initialWorkspace = parseCaseWorkspace(location.href);
  let draftsMode = initialWorkspace.drafts;
  const state = { workspace: initialWorkspace.workspaceId, view: 'grid', sort: 'title', descending: false, query: '', duration: null,
    audience: null, group: null, groups: null, boardBy: 'length', rows: [], total: null, pilotPin: null, loading: false };
  let generation = 0, groupGeneration = 0, closed = false, searchTimer = null, detail = null, painting = [], screen = null, draftList = null;
  // CASE-336: cases shared with this person on their own (a grant, not a membership), listed under "Shared with you".
  const grants = Array.isArray(me.grants) ? me.grants : [];
  let workspaceSharing=null,shareLoading=false;let shared = null, sharedNotice = '';
  const narrow = window.matchMedia('(max-width: 639px)');
  const root = node('section', null, draftsMode ? 'library library-drafts' : 'library'); root.setAttribute('aria-labelledby', 'libraryTitle');
  const list = node('div', null, 'library-list');
  const head = node('div', null, 'library-head');
  const title = node('h1', draftsMode ? 'Create' : 'Present', 'sr-only'); title.id = 'libraryTitle'; title.tabIndex = -1;
  const memberships = [...me.memberships];
  const canAuthor = () => ['admin','owner','author'].includes(memberships.find(m => m.workspace_id === state.workspace)?.role);
  const workspace = select('Workspace', [], 'library-select library-workspace');
  const status = node('p', '', 'library-status sr-only'); status.setAttribute('role', 'status');
  const views = node('div', null, 'segmented'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'View');
  const titleBlock = node('div', null, 'library-title');
  titleBlock.append(workspace.wrap);
  // Owners of the selected workspace manage its groups (P-18 to P-20); everyone else never sees the control.
  const manage = node('button', 'Groups', 'btn library-groups'); manage.type = 'button'; manage.hidden = true;
  const newCase = node('button', 'New case', 'btn primary library-new-case'); newCase.type = 'button'; newCase.hidden = true;
  const shareWorkspace=node('button',null,'btn quiet icon-button library-share');shareWorkspace.type='button';shareWorkspace.setAttribute('aria-label','Share workspace');shareWorkspace.title='Share workspace';shareWorkspace.append(uiIcon('share'));shareWorkspace.hidden=true;
  const shareHost=node('div');
  const headActions = node('div', null, 'library-head-actions'); headActions.append(views);
  head.append(titleBlock, headActions);
  const toolbar=head;head.classList.add('library-toolbar');
  const searchLabel = node('div', null, 'library-search');
  const search = node('input'); search.type = 'search'; search.className = 'input'; search.maxLength = 80;
  search.id = `library-control-${++controlId}`;
  search.placeholder = 'Search title, audience or summary';
  const searchName = node('label', 'Search cases', 'sr-only'); searchName.htmlFor = search.id;
  searchLabel.append(searchName, search);
  const length = select('Length', [['', 'All lengths'], ...CATALOGUE_DURATIONS.map(n => [String(n), `${n} min`])]);
  const audience = select('Audience', [['', 'All audiences']]);
  const group = select('Group', [['', 'All groups']]);
  const groupNotice = node('p', '', 'small muted'); groupNotice.setAttribute('role', 'status');
  const retryGroups = node('button', 'Retry groups', 'btn quiet'); retryGroups.type = 'button'; retryGroups.hidden = true;
  retryGroups.onclick = () => void loadGroups(); group.wrap.append(groupNotice, retryGroups);
  const sort = select('Sort', SORT_CHOICES.map(c => [c.value, c.label]));
  const columns = select('Columns', BOARD_COLUMNS);
  head.insertBefore(searchLabel, headActions);
  const filters = node('details', null, 'library-filters'), filterToggle = node('summary', 'Filters', 'btn quiet');
  const filterControls = node('div', null, 'library-filter-controls'); filterControls.append(length.wrap, audience.wrap, group.wrap);
  const clearFilters = node('button', 'Clear filters', 'btn tertiary'); clearFilters.type = 'button';
  clearFilters.onclick = () => { state.duration = state.audience = state.group = null; length.control.value = audience.control.value = group.control.value = ''; reload(); };
  filterControls.append(clearFilters); filters.append(filterToggle, filterControls);
  const groupTools = node('div', null, 'library-group-tools'); groupTools.append(columns.wrap, manage,shareWorkspace,newCase);
  toolbar.append(sort.wrap, filters, groupTools);
  const results = node('div', null, 'library-results');
  const more = node('button', 'Show more cases', 'btn quiet library-more'); more.type = 'button'; more.hidden = true;
  const empty = node('div', null, 'library-empty'); empty.hidden = true;
  const searchControl=collapseSearch(search,{label:'Search cases'});searchLabel.replaceChildren(searchName,searchControl.root);
  head.insertBefore(status,headActions);list.append(title, head, results, empty, more);
  const sharedHost = node('section', null, 'library-shared'); sharedHost.hidden = true; sharedHost.setAttribute('aria-labelledby', 'librarySharedTitle');
  const draftHost = node('div'); list.append(draftHost, sharedHost);
  // A person with grants and no workspace sees only what is shared with them (no picker, search or filters).
  const grantOnly = () => !memberships.length && grants.length > 0;
  root.append(list,shareHost);
  host.append(root);decorateTools(root);

  // Workspaces: the picker labels operator (rooms-refused) workspaces and lists them last, never mixed in.
  function fillWorkspaces() {
    const teaching = memberships.filter(m => m.rooms_refused !== true), operators = memberships.filter(m => m.rooms_refused === true);
    const option = m => { const item = node('option', m.rooms_refused === true ? `${m.name || 'Workspace'} (operators; rooms refused here)` : (m.name || 'Workspace')); item.value = m.workspace_id; return item; };
    workspace.control.replaceChildren(...teaching.map(option));
    if (operators.length) { const group = node('optgroup'); group.label = 'Operators'; group.append(...operators.map(option)); workspace.control.append(group); }
    if (!state.workspace) state.workspace = (teaching[0] ?? operators[0])?.workspace_id ?? null;
    if (state.workspace && !memberships.some(m => m.workspace_id === state.workspace)) {
      const unavailable = node('option', 'Workspace unavailable'); unavailable.value = state.workspace; unavailable.disabled = true; workspace.control.append(unavailable);
    }
    workspace.control.value = state.workspace ?? '';
    manage.hidden = memberships.find(m => m.workspace_id === state.workspace)?.role !== 'owner';
    shareWorkspace.hidden=draftsMode||!['owner','admin'].includes(memberships.find(m=>m.workspace_id===state.workspace)?.role);
    newCase.hidden = !canAuthor();
    workspace.wrap.hidden = grantOnly();
  }
  fillWorkspaces();
  const defaultWorkspace = state.workspace;
  function showSavedDrafts() {
    draftList?.close(); draftList = null; draftHost.replaceChildren();
    const ws = state.workspace;
    root.classList.toggle('library-drafts', draftsMode);
    status.hidden = draftsMode;
    (draftsMode ? headActions : groupTools).append(newCase);
    onContext(draftsMode ? [{ label: 'Create' }] : [{ label: 'Present' }]);
    draftHost.hidden = !draftsMode; sort.wrap.hidden=filters.hidden=groupTools.hidden=views.hidden=results.hidden=draftsMode;searchLabel.hidden=false;searchControl.setLabel(draftsMode?'Search loaded drafts':'Search cases');
    empty.hidden = more.hidden = true;
    if (grantOnly()) { sort.wrap.hidden=filters.hidden=groupTools.hidden=searchLabel.hidden=views.hidden=results.hidden=true; head.hidden = true; status.hidden = true; }
    renderShared();
    if (!draftsMode) return;
    sort.wrap.hidden=filters.hidden=groupTools.hidden=true;
    if (!ws || !canAuthor()) { if (!sharedEdits().length) draftHost.append(node('p', 'This workspace does not grant draft access. Choose an authoring workspace.')); return; }
    draftList = mountBuilderDraftList(draftHost, { auth, workspaceId: ws, current: () => !closed && state.workspace === ws,
      onEdit: caseId => location.assign(caseEditWorkspaceUrl(caseId, ws, location.origin)) });draftList.filter(search.value);
  }
  showSavedDrafts();
  for (const [value, label] of VIEWS) {
    const button = node('button', label); button.type = 'button'; button.dataset.view = value;
    button.addEventListener('click', () => { if (state.view === value) return; const board = value === 'board' || state.view === 'board'; state.view = value; if (board) reload(); else render(); });
    views.append(button);
  }

  newCase.addEventListener('click', () => location.assign(caseWorkspaceUrl(state.workspace, 'new', location.origin)));


  // "Shared with you" (CASE-336, plan §3 A6): the caller's own grants, by workspace. A grant that adds nothing to a membership is
  // not repeated here. A withdrawn case is listed and cannot be started; a draft-only case shows to Can edit only.
  function sharedRows() { return (shared ?? []).filter(addsAccess); }
  function sharedEdits() { return sharedRows().filter(row => row.level === 'edit'); }
  function workspaceName(id) {
    return memberships.find(m => m.workspace_id === id)?.name ?? (shared ?? []).find(row => row.workspaceId === id)?.workspaceName ?? grants.find(g => g.workspace_id === id)?.workspace_name ?? null;
  }
  function renderShared() {
    const rows = draftsMode ? sharedEdits() : sharedRows();
    sharedHost.hidden = !rows.length && !sharedNotice;
    sharedHost.replaceChildren();
    if (sharedHost.hidden) return;
    const heading = node('h2', draftsMode ? 'Shared drafts' : 'Shared with you', 'library-shared-title'); heading.id = 'librarySharedTitle';
    sharedHost.append(heading);
    if (sharedNotice) { const note = node('p', sharedNotice, 'small muted'); note.setAttribute('role', 'status'); sharedHost.append(note); }
    const byWorkspace = new Map();
    for (const row of rows) byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row]);
    for (const [id, items] of byWorkspace) {
      const group = node('section', null, 'library-shared-group'); group.setAttribute('aria-label', items[0].workspaceName);
      group.append(node('h3', items[0].workspaceName));
      const ul = node('ul', null, 'library-shared-list');
      for (const row of items) {
        const li = node('li', null, 'library-shared-tile'), words = node('span', null, 'library-shared-words');
        const level = node('span', row.level === 'edit' ? 'Can edit' : 'Can run', 'tag');
        if (row.withdrawn) {
          // Withdrawn: still the person's, but nothing can be started from it until it is republished.
          words.append(node('strong', row.title), node('small', 'Withdrawn. It cannot be started until it is republished.', 'muted'));
          li.append(words, node('span', 'Withdrawn', 'tag warn'), level);
        } else if (row.versionNo !== null) {
          const link = node('a', row.title, 'case-link'); link.href = caseVersionUrl(row.caseId, row.versionNo, location.origin);
          words.append(link); li.append(words, level);
        } else {
          // A case that has never been published: only a Can edit grant reaches it, through its draft.
          const link = node('a', row.title, 'draft-link'); link.href = caseEditUrl(row.caseId, location.origin);
          words.append(link, node('small', 'Draft, not published yet', 'muted')); li.append(words, level);
        }
        ul.append(li);
      }
      group.append(ul); sharedHost.append(group);
      void id;
    }
  }
  async function loadShared() {
    if (!grants.length) return;
    try {
      const value = await accountRequest(auth, ['shared-cases'], { maxResponseBytes: 262_144 });
      if (closed) return;
      if (!Array.isArray(value?.cases) || value.cases.length > 200 || value.cases.some(row => !isUuidV7(row?.caseId) || !isUuidV7(row.workspaceId) ||
          typeof row.title !== 'string' || typeof row.workspaceName !== 'string' || !['run', 'edit'].includes(row.level) || typeof row.withdrawn !== 'boolean')) throw new Error('invalid_shared');
      shared = value.cases; sharedNotice = '';
    } catch { if (!closed) { shared = shared ?? []; sharedNotice = 'Cases shared with you could not be loaded. Reload to try again.'; } }
    if (closed) return;
    fillWorkspaces(); renderShared();
    if (draftsMode && !draftList && !draftHost.children.length && !sharedEdits().length) showSavedDrafts();
  }

  async function loadAudiences() {
    if (draftsMode) return;
    const current = generation, ws = state.workspace;
    try {
      const value = await accountRequest(auth, ['workspaces', ws, 'catalogue', 'audiences']);
      if (closed || current !== generation || ws !== state.workspace) return;
      if (!Array.isArray(value?.audiences)) throw new Error('invalid_audiences');
      const chosen = state.audience;
      audience.control.replaceChildren(Object.assign(node('option', 'All audiences'), { value: '' }),
        ...value.audiences.filter(a => typeof a?.audience === 'string').map(a => Object.assign(node('option', a.audience), { value: a.audience })));
      audience.control.value = chosen ?? '';
      if (audience.control.value !== (chosen ?? '')) { state.audience = null; audience.control.value = ''; }
    } catch { /* The filter keeps "All audiences"; the list itself still loads. */ }
  }
  // The group filter and board columns: live groups with whole-set counts, then Ungrouped (card 30).
  async function loadGroups() {
    if (draftsMode) return;
    const current = ++groupGeneration, ws = state.workspace;
    group.control.disabled = true; retryGroups.hidden = true; groupNotice.textContent = 'Loading groups…';
    try {
      const value = await accountRequest(auth, ['workspaces', ws, 'catalogue', 'groups']);
      if (closed || current !== groupGeneration || ws !== state.workspace) return;
      if (!Array.isArray(value?.groups) || !value.groups.every(validCatalogueGroupRow)) throw new Error('invalid_groups');
      state.groups = value.groups;
      const chosen = state.group;
      group.control.replaceChildren(Object.assign(node('option', 'All groups'), { value: '' }),
        ...value.groups.map(g => Object.assign(node('option', g.id === null ? UNGROUPED : g.name), { value: g.id ?? CATALOGUE_UNGROUPED })));
      group.control.value = chosen ?? '';
      groupNotice.textContent = ''; group.control.disabled = false;
      if (group.control.value !== (chosen ?? '')) { state.group = null; group.control.value = ''; reload(); }
      else if (state.view === 'board' && state.boardBy === 'group') render();
    } catch { if (!closed && current === groupGeneration && ws === state.workspace) { state.groups = null; groupNotice.textContent = 'Groups could not be loaded.'; retryGroups.hidden = false; } }
  }
  const query = offset => {
    const board = state.view === 'board';
    return { sort: board ? state.boardBy : state.sort, descending: board ? false : state.descending, query: state.query,
      duration: state.duration, audience: state.audience, group: state.group, limit: CATALOGUE_PAGE, offset };
  };
  async function load(offset) {
    const current = generation, request = query(offset);
    state.loading = true; more.disabled = true;
    if (!offset) { status.textContent = 'Loading published cases…'; status.classList.remove('sr-only'); }
    try {
      const value = await accountRequest(auth, ['workspaces', state.workspace, 'catalogue'], { query: catalogueSearch(request) });
      if (closed || current !== generation) return;
      const page = cataloguePage(value, request);
      state.rows = offset ? [...state.rows, ...page.rows] : page.rows;
      state.total = page.total; state.pilotPin = page.pilotPin;
      render();
    } catch {
      if (closed || current !== generation) return;
      status.textContent = offset ? 'The next cases could not be loaded. Try again.' : 'Published cases are unavailable. Try again.';
      status.classList.remove('sr-only');
      if (!offset) { results.replaceChildren(); empty.hidden = true; }
      more.hidden = false;
    } finally { if (current === generation) { state.loading = false; more.disabled = false; } }
  }
  function reload() {
    if (draftsMode) return;
    generation++; state.rows = []; state.total = null;
    if (!state.workspace) { if (!grants.length) { status.textContent = 'No workspaces are assigned to this account.'; status.classList.remove('sr-only'); } results.replaceChildren(); more.hidden = true; return Promise.resolve(); }
    return load(0);
  }

  function cardFor(row, covers, className = 'case-card', level = 'h2') {
    const card=caseTile({title:row.title,summary:fieldText(row.summary,'summary'),metadata:[lengthText(row.duration_min),fieldText(row.audience,'audience'),groupText(row)],media:coverFor(row,covers),href:caseVersionUrl(row.case_id,row.version_no,location.origin),className:className==='case-card'?'':className,level}).root;
    for(const tag of optionalPilot(row,state.pilotPin))card.querySelector('.case-card-body').append(tag);
    return card;
  }
  function renderGrid(covers) {
    const grid = node('div', null, 'case-grid');
    grid.append(...state.rows.map(row => cardFor(row, covers)));
    return grid;
  }
  function renderTable(covers) {
    if (narrow.matches) {
      const list = node('ul', null, 'case-stacked-list');
      for (const row of state.rows) {
        const item = node('li'), link = node('a', row.title, 'case-link'); link.href = caseVersionUrl(row.case_id, row.version_no, location.origin);
        const heading = node('h2'); heading.append(link);
        const values = node('dl');
        for (const [label, value] of [['Group', groupText(row)], ['Length', lengthText(row.duration_min)], ['Audience', fieldText(row.audience, 'audience')], ['Published', formatDate(row.published_at)]]) values.append(node('dt', label), node('dd', value));
        item.append(heading, node('p', fieldText(row.summary, 'summary')), values, ...optionalPilot(row, state.pilotPin)); list.append(item);
      }
      return list;
    }
    const wrap = node('div', null, 'table-scroll');
    const table = node('table', null, 'case-table');
    const caption = node('caption', 'Published cases. Sorting applies to the whole result set, not just the rows loaded so far.', 'sr-only');
    const head = node('thead'), tr = node('tr');
    const coverTh = node('th'); coverTh.append(node('span', 'Cover', 'sr-only')); tr.append(coverTh);
    for (const [column, label] of TABLE_COLUMNS) {
      const th = node('th'); th.scope = 'col';
      th.setAttribute('aria-sort', ariaSort(column, state.sort, state.descending));
      const button = node('button', label, 'sort-button'); button.type = 'button'; button.dataset.sort = column;
      button.addEventListener('click', () => {
        Object.assign(state, nextSort(column, state.sort, state.descending));
        sort.control.value = SORT_CHOICES.find(c => c.sort === state.sort && c.descending === state.descending)?.value ?? sort.control.value;
        reload();
      });
      th.append(button); tr.append(th);
    }
    head.append(tr);
    const body = node('tbody');
    for (const row of state.rows) {
      const r = node('tr');
      const cover = node('td', null, 'cover-cell'); cover.append(coverFor(row, covers, 'cover small'));
      const titleCell = node('td');
      const link = node('a', row.title, 'case-link'); link.href = caseVersionUrl(row.case_id, row.version_no, location.origin);
      titleCell.append(link, node('span', fieldText(row.summary, 'summary'), 'case-summary-line'));
      const published = node('td');
      published.append(node('span', formatDate(row.published_at)), ...optionalPilot(row, state.pilotPin));
      const cells = [titleCell, node('td', groupText(row)), node('td', lengthText(row.duration_min)), node('td', fieldText(row.audience, 'audience')), published];
      cells.forEach((cell, index) => cell.dataset.label = ['Case', 'Group', 'Length', 'Audience', 'Published'][index]);
      r.append(cover, ...cells);
      body.append(r);
    }
    table.append(caption, head, body); wrap.append(table);
    return wrap;
  }
  function renderBoard(covers) {
    const board = node('div', null, 'case-board');
    for (const column of boardColumns(state.rows, state.boardBy, state.boardBy === 'group' ? state.groups : null)) {
      const section = node('section', null, 'board-column'); section.setAttribute('aria-label', column.label);
      const header = node('h2', null, 'board-column-head');
      header.append(node('span', column.label), node('span', String(column.count ?? column.rows.length), 'muted'));
      section.append(header, ...column.rows.map(row => cardFor(row, covers, 'case-card board-card', 'h3')));
      board.append(section);
    }
    return board;
  }
  function render() {
    if (draftsMode) return;
    if (closed) return;
    for (const button of views.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
    sort.wrap.hidden = state.view === 'board';
    const filterCount=[state.duration,state.audience,state.group].filter(v=>v!==null).length;compactTool(filterToggle,'filters',{label:filterCount?`Filters (${filterCount})`:'Filters',active:filterCount>0});
    columns.wrap.hidden = state.view !== 'board';
    status.textContent = showingText(state.rows.length, state.total);
    status.classList.remove('sr-only');status.classList.add('small','muted');
    const covers = [];
    if (!state.rows.length && state.total === 0) {
      results.replaceChildren();
      const filtered = state.query || state.duration !== null || state.audience !== null || state.group !== null;
      empty.replaceChildren(node('p', filtered ? 'No cases match.' : 'No published cases in this workspace.'));
      if (filtered) {
        const clear = node('button', 'Clear search and filters', 'btn tertiary'); clear.type = 'button';
        clear.addEventListener('click', () => {
          Object.assign(state, { query: '', duration: null, audience: null, group: null });
          search.value = ''; length.control.value = ''; audience.control.value = ''; group.control.value = ''; reload();
        });
        empty.append(clear);
      }
      empty.hidden = false;
    } else {
      empty.hidden = true;
      // A late response rebuilds the table: keep keyboard focus on the sort header it replaces, so a key
      // pressed at that instant still sorts instead of vanishing with the detached button.
      const focusedSort = results.contains(document.activeElement) ? document.activeElement.dataset?.sort : undefined;
      results.replaceChildren(state.view === 'table' ? renderTable(covers) : state.view === 'board' ? renderBoard(covers) : renderGrid(covers));
      if (focusedSort) results.querySelector(`button.sort-button[data-sort="${focusedSort}"]`)?.focus();
    }
    more.hidden = !(state.total === null ? state.rows.length > 0 && state.rows.length % CATALOGUE_PAGE === 0 : state.rows.length < state.total);
    painting = covers;
    void paintCovers(covers);
  }

  workspace.control.addEventListener('change', () => {
    pushRoute(caseWorkspaceUrl(workspace.control.value, draftsMode ? 'drafts' : 'published', location.origin));
    showCollection();
  });
  search.addEventListener('input', () => {
    if(draftsMode){draftList?.filter(search.value);return;}
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { const next = search.value.trim(); if (next !== state.query) { state.query = next; reload(); } }, 250);
  });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault();if(draftsMode){draftList?.filter(search.value);return;} clearTimeout(searchTimer); state.query = search.value.trim(); reload(); } });
  length.control.addEventListener('change', () => { state.duration = length.control.value ? Number(length.control.value) : null; reload(); });
  audience.control.addEventListener('change', () => { state.audience = audience.control.value || null; reload(); });
  group.control.addEventListener('change', () => { state.group = group.control.value || null; reload(); });
  sort.control.addEventListener('change', () => {
    const choice = SORT_CHOICES.find(c => c.value === sort.control.value);
    if (choice) { state.sort = choice.sort; state.descending = choice.descending; reload(); }
  });
  columns.control.addEventListener('change', () => { state.boardBy = ['audience', 'group'].includes(columns.control.value) ? columns.control.value : 'length'; reload(); });
  // The owner's Groups screen replaces the list in this document; closing it reloads the catalogue.
  shareWorkspace.onclick=async()=>{
    if(closed||shareLoading||shareWorkspace.hidden)return;shareLoading=true;shareWorkspace.disabled=true;const ws=state.workspace;
    try{const {mountAdminInvitations}=await import('./admin-invitations.mjs');if(closed||ws!==state.workspace)return;
      workspaceSharing??=mountAdminInvitations(shareHost,{request:(parts,options)=>accountRequest(auth,parts,options),workspace:{id:ws,name:workspaceName(ws)??'Workspace'},allowedLevels:['run','edit'],dialogOnly:true,opener:shareWorkspace});await workspaceSharing.open();
    }catch{if(!closed)notices.notify('Workspace sharing could not load. Reload this page to try again.',{error:true});}finally{shareLoading=false;if(!closed)shareWorkspace.disabled=false;}
  };
  manage.addEventListener('click', async () => {
    if (screen || manage.hidden) return;
    const ws = state.workspace;
    let mountGroups; manage.disabled = true;
    try { ({ mountGroups } = await import('./groups-screen.mjs')); }
    catch { if (!closed) { status.textContent = 'Group tools could not be opened. Try Groups again.'; status.classList.remove('sr-only'); } return; }
    finally { manage.disabled = false; }
    if (closed || ws !== state.workspace || screen) return;
    list.hidden = true;
    onContext([{ label: draftsMode ? 'Create' : 'Present', href: caseWorkspaceUrl(ws, draftsMode ? 'drafts' : 'published', location.origin) }, { label: 'Groups' }]);
    screen = mountGroups(root, { request: (parts, options) => accountRequest(auth, parts, options),
      workspaces: memberships.filter(m => m.workspace_id === ws), workspaceId: ws,
      onClose: ({ forbidden = false } = {}) => {
        screen?.close(); screen = null; list.hidden = false;
        if (forbidden) { const m = memberships.find(x => x.workspace_id === ws); if (m) m.role = 'facilitator'; manage.hidden = true; }
        onContext([{ label: 'Present' }]); reload(); void loadGroups(); (forbidden ? title : manage).focus();
      } });
  });
  more.addEventListener('click', () => { if (!state.loading) void load(state.rows.length); });
  const stopTheme = watchTheme(() => { clearCoverCache(); void paintCovers(painting); });

  // Case detail is an in-document view at /cases/<case>/v/<n>: a plain click opens it, a modified click
  // or a reload follows the link (the route mounts detail directly).
  let detailWorkspace=null,listScroll=0,selectedCase=null,detailGeneration=0,detailLoader=null,pendingDetail=null;
  let historyIndex=Number.isSafeInteger(history.state?.caseLibraryIndex)?history.state.caseLibraryIndex:0, restoringPop=false;
  history.replaceState({...history.state,caseLibraryIndex:historyIndex},'',location.href);
  function pushRoute(url) { historyIndex++;history.pushState({caseLibraryIndex:historyIndex,privateNavigationIndex:(history.state?.privateNavigationIndex??0)+1},'',url); }
  function showList({ push = false } = {}) {
    detailGeneration++;pendingDetail?.close();pendingDetail=null;detailLoader?.remove();detailLoader=null;const returning=Boolean(detail);detail?.close(); detail = null;detailWorkspace=null; screen?.close(); screen = null; list.hidden = false;
    if (push) pushRoute(caseWorkspaceUrl(state.workspace, draftsMode ? 'drafts' : 'published', location.origin));
    onContext([{ label: draftsMode?'Create':'Present' }]);if(returning){const link=[...list.querySelectorAll('a.case-link')].find(a=>parseRoute(new URL(a.href).pathname)?.caseId===selectedCase);requestAnimationFrame(()=>{link?.focus({preventScroll:true});window.scrollTo(0,listScroll);});}else title.focus();
  }
  function showCollection() {
    const next = parseCaseWorkspace(location.href), ws = next.workspaceId ?? defaultWorkspace;
    const changed = ws !== state.workspace;
    if(changed){workspaceSharing?.close();workspaceSharing=null;}
    draftsMode = next.drafts; state.workspace = ws;
    title.textContent = draftsMode ? 'Create' : 'Present';
    generation++; groupGeneration++; state.loading = false;
    clearTimeout(searchTimer); state.query = search.value.trim();
    if (changed) {
      results.replaceChildren();
      state.audience = state.group = state.groups = null;
      audience.control.value = group.control.value = '';
    }
    fillWorkspaces(); showList(); showSavedDrafts();
    reload(); void loadAudiences(); void loadGroups();
  }
  async function showDetail(caseId, versionNo, { push = false } = {}) {
    if(detail?.beforeNavigate?.()===false)return;
    if(!detail)listScroll=window.scrollY;selectedCase=caseId;
    if (push) pushRoute(caseVersionUrl(caseId, versionNo, location.origin));
    pendingDetail?.close();pendingDetail=null;const previous=detail;
    if(previous){previous.element.inert=true;previous.element.setAttribute('aria-busy','true');previous.element.classList.add('private-loading');}else list.hidden=true;
    screen?.close();screen=null;const version=++detailGeneration;detailLoader?.remove();detailLoader=node('div',null,'case-detail-frame');detailLoader.hidden=Boolean(previous);root.append(detailLoader);
    let mountCaseDetail;try{({mountCaseDetail}=await import('./case-detail.mjs'));}catch{if(!closed&&version===detailGeneration){previous?.close();detail=null;detailLoader.hidden=false;detailLoader.textContent='Case details could not load. Reload to try again.';}return;}if(closed||version!==detailGeneration)return;
    const target=detailLoader;let context=null;

    const neighbours=state.rows;const index=neighbours.findIndex(row=>row.case_id===caseId);
    pendingDetail = mountCaseDetail(target, { auth, caseId, versionNo, browse:index<0?null:{index,total:neighbours.length,complete:state.total===neighbours.length,previous:index>0?()=>showDetail(neighbours[index-1].case_id,neighbours[index-1].version_no,{push:true}):null,next:index+1<neighbours.length?()=>showDetail(neighbours[index+1].case_id,neighbours[index+1].version_no,{push:true}):null}, profile: me.profile ?? null, workspaceName, onBack: () => showList({ push: true }), onStart,
      onContext: (title, preview,workspaceId) => {context={title,preview,workspaceId};if(detail?.element.parentElement===target){detailWorkspace=workspaceId;onContext([{label:'Present',href:caseWorkspaceUrl(workspaceId,'published',location.origin)},{label:title},...(preview?[{label:'Preview'}]:[])]);}},
      onReady:()=>{if(closed||version!==detailGeneration)return;previous?.close();detail=pendingDetail;pendingDetail=null;target.hidden=false;detailLoader=null;if(context){detailWorkspace=context.workspaceId;onContext([{label:'Present',href:caseWorkspaceUrl(context.workspaceId,'published',location.origin)},{label:context.title}]);}},
      onEdit: ({ versionId, versionNo, restore }) => location.assign(restore ? caseEditSourceViewUrl(caseId, { versionId, versionNo }, 'restore', location.origin) : caseEditSourceUrl(caseId, { versionId, versionNo }, location.origin)),
      onGroupConflict: () => showDetail(caseId,versionNo), onGroupChanged: () => { reload(); void loadGroups(); } });
  }
  root.addEventListener('click', event => {
    const link = event.target.closest?.('a.case-link');
    if (!link || !isPlainNavigation(event)) return;
    const route = parseRoute(link.href);
    if (route?.route !== 'case-version' || !isUuidV7(route.caseId)) return;
    event.preventDefault(); showDetail(route.caseId, route.versionNo, { push: true });
  });
  const onPop = event => {
    if(restoringPop){restoringPop=false;return;}
    const nextIndex=Number.isSafeInteger(event.state?.caseLibraryIndex)?event.state.caseLibraryIndex:historyIndex-1;
    const destination=location.href;if(screen?.beforeNavigate?.({href:destination,resume:()=>onNavigate(destination)})===false||detail?.beforeNavigate?.()===false){restoringPop=true;history.go(historyIndex-nextIndex||1);return;}
    historyIndex=nextIndex;
    const route = parseRoute(location.pathname);
    if (route?.route === 'case-version' && isUuidV7(route.caseId)) showDetail(route.caseId, route.versionNo);
    else if (route?.route === 'case-edit' && isUuidV7(route.caseId)) {
      location.assign(location.href);
    }
    else if (route?.route === 'cases') showCollection();
    else showList();
  };
  window.addEventListener('popstate', onPop);
  const reflow = () => { if (!closed && state.view === 'table') render(); }; narrow.addEventListener('change', reflow);

  const initial = parseRoute(location.pathname);
  const firstPage = reload(); void loadAudiences(); void loadGroups(); const sharedLoaded = loadShared();
  // A bare case address (/cases/<id>, where an invitation lands): open the case's latest version, or its draft when it has never
  // been published and the person may edit it. A shared case is found in "Shared with you", a workspace case in the catalogue.
  async function openBareCase(caseId) {
    list.hidden=true;const note=node('p','Loading case…','case-detail-status');note.setAttribute('role','status');root.append(note);
    try{const value=await accountRequest(auth,['cases',caseId]);if(closed)return;if(value?.caseId!==caseId||!isUuidV7(value.workspaceId)||typeof value.editable!=='boolean'||!(value.versionNo===null||Number.isSafeInteger(value.versionNo)&&value.versionNo>0))throw new Error('invalid_case');
      if(value.versionNo!==null){history.replaceState(history.state,'',caseVersionUrl(caseId,value.versionNo,location.origin));showDetail(caseId,value.versionNo);}
      else if(value.editable)location.replace(caseEditUrl(caseId,location.origin));else throw new Error('unavailable');note.remove();
    }catch{if(closed)return;note.textContent='This case is unavailable. It may be withdrawn or outside your current access.';const back=node('button','Back to Present','btn quiet');back.type='button';back.onclick=()=>{note.remove();back.remove();showList({push:true});};root.append(back);}
  }
  if (initial?.route === 'case' && isUuidV7(initial.caseId)) void openBareCase(initial.caseId);
  else if (initial?.route === 'case-version' && isUuidV7(initial.caseId)) showDetail(initial.caseId, initial.versionNo);
  else if (initial?.route === 'case-edit' && isUuidV7(initial.caseId)) {
    location.assign(location.href);
  }
  return {
    hasGroupScreen:()=>Boolean(screen),
    workspaceId:()=>detailWorkspace??state.workspace,
    beforeNavigate: action => {if(screen?.beforeNavigate?.({...action,resume:action?.resume??(()=>onNavigate(action?.href))})===false)return false;return workspaceSharing?.beforeNavigate?.()===false?false:detail?.beforeNavigate?.()??true;},
    close() {
      closed = true;notices.close();workspaceSharing?.close();workspaceSharing=null;detailGeneration++;pendingDetail?.close();pendingDetail=null;detailLoader?.remove(); draftList?.close(); generation++; groupGeneration++; clearTimeout(searchTimer); stopTheme(); window.removeEventListener('popstate', onPop); narrow.removeEventListener('change', reflow);
      for (const item of [workspace, length, audience, group, sort, columns]) item.choice.dispose();
      searchControl.dispose(); detail?.close(); detail = null; screen?.close(); screen = null; root.remove();
    },
    addMemberships(rows) { for (const m of rows) if (!memberships.some(x => x.workspace_id === m.workspace_id)) memberships.push(m); fillWorkspaces(); showSavedDrafts(); },
  };
}
