import { recordDialog, activateSingleActionRow } from './admin-record-dialog.mjs';
import { mountWorkspaceDetails } from './workspace-details.mjs';
// Administration -> Workspaces (facilitator-UX A5; prototypes/admin-people.html). Create a workspace, set its four
// policies (P-45), see its image storage against the quota with a warning from 80%, change the quota, and delete the
// images nothing uses (step-up, with the consequences in words). Groups for the workspace open from here too.
// Presets (P-01/P-02) have no data model yet: the screen offers none.
import { guardDialog } from './dialog-behaviour.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
import { collapseSearch } from './surface-controls.mjs';
import { node } from './auth-ui.mjs';
import { workspacePage } from '../shared/admin-workbench.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { adminMessage } from './admin-messages.mjs';
import { deleteUnused, size } from './admin-consequences.mjs';

const POLICY_TEXT = Object.freeze([
  ['managers_invite', 'Managers can invite people', 'An owner invites facilitators and authors into this workspace, and manages those invitations.'],
  ['editors_publish', 'Editors publish without review', 'An author releases new versions themselves. Off: Send for review goes to the owners. Withdraw and republish stay with owners and administrators.'],
  ['runners_share', 'Anyone who can run a case can share it to run', 'A facilitator can share one case with another person as Can run. Never Can edit.'],
  ['managers_see_records', 'Managers see every session record', 'Owners see the records of every room in this workspace, not only their own.'],
]);
export const WARN_AT = 80;
/** Used bytes against the quota: the words, the percentage and whether to warn (from 80%) or stop (full). */
export function storageSummary({ usedBytes, quotaBytes }) {
  const full = quotaBytes === 0 ? usedBytes > 0 : usedBytes >= quotaBytes;
  const percent = quotaBytes > 0 ? Math.floor(usedBytes * 100 / quotaBytes) : usedBytes > 0 ? 100 : 0;
  const warn = quotaBytes > 0 && percent >= WARN_AT || full;
  const used = size(usedBytes), quota = size(quotaBytes);
  const message = full ? `Image storage is full: ${used} of ${quota} used. No more images can be added until some are deleted or the quota is raised.`
    : warn ? `${used} of ${quota} used (${percent}%). Delete unused images or raise the quota before it fills.` : `${used} of ${quota} used (${percent}%).`;
  return { percent, warn, full, used, quota, message };
}
/** "2" or "0.5" gigabytes to whole bytes (0 to 10 GB); anything else is null. */
export function quotaBytesFromGb(text) {
  const value = String(text).trim();
  if (!/^(?:\d{1,2}(?:\.\d{1,3})?)$/.test(value)) return null;
  const bytes = Math.round(Number(value) * 1e9);
  return bytes <= 1e10 ? bytes : null;
}
/** The policies that differ from what was loaded: the only ones sent. */
export function policyChanges(was, now) { return Object.fromEntries(Object.keys(now).filter(key => now[key] !== was[key]).map(key => [key, now[key]])); }
const slugOf = name => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CREATE = Object.freeze({ conflict: 'A workspace already uses that short name. Choose another.', forbidden: 'Only administrators can create workspaces.',
  bad_request: 'Check the name and the short name (lower-case letters, numbers and hyphens).' });
const SAVE = Object.freeze({ conflict: 'These settings changed since you opened them. Current settings have been loaded; check them and save again.', forbidden: 'You can no longer change this workspace’s settings.',
  bad_request: 'Check the quota: a whole number of gigabytes from 0 to 10, or up to three decimals.' });
const when = iso => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Not recorded'; };

export function mountAdminWorkspaces(host, { request, api, elevation, confirm, onContext = () => {}, mountGroups = null } = {}) {
  const notices=createSurfaceNotice();
  let recordModal=null,nameEditor=null;
  let closed = false, busy = false, rows = [], after = null, selected = null, detail = null, groups = null, generation = 0;
  const root = node('section', null, 'admin-workspaces');
  const head = node('div', null, 'admin-head'), title = node('h2', 'Workspaces'), create = node('button', 'Create workspace', 'btn primary'); create.type = 'button';
  title.className='sr-only';const search=node('input');search.type='search';const searchControl=collapseSearch(search,{label:'Search loaded workspaces'}),count=node('span','','small muted');search.oninput=()=>renderList();head.append(title,searchControl.root,count,create);
  const lede = node('p', 'Each workspace has its own people, cases and image storage. Policies are set here, for everyone in the workspace.', 'supporting-note');
  const notice = node('p', null, 'admin-notice'); notice.setAttribute('role', 'status');
  const createForm = node('form', null, 'admin-create'); createForm.hidden = true; createForm.noValidate = true;
  const nameLabel = node('label', 'Name'), name = node('input'); name.maxLength = 120; name.required = true; nameLabel.append(name);
  const slugLabel = node('label', 'Short name (lower-case letters, numbers and hyphens)'), slug = node('input'); slug.maxLength = 48; slug.required = true; slugLabel.append(slug);
  const createNote = node('p', 'You become its owner. Change roles under People.', 'admin-muted');
  const submit = node('button', 'Create workspace', 'btn primary'); submit.type = 'submit';
  const cancelCreate = node('button', 'Cancel', 'btn'); cancelCreate.type = 'button';
  const createRow = node('div', null, 'admin-actions'); createRow.append(submit, cancelCreate);
  createForm.append(nameLabel, slugLabel, createNote, createRow);
  const content = node('div', null, 'admin-content'), listPanel = node('div', null, 'admin-list'), table = node('table', null, 'admin-table');
  const more = node('button', 'More workspaces', 'btn quiet'); more.type = 'button'; more.hidden = true;
  const scroll = node('div', null, 'admin-scroll'); scroll.append(table); listPanel.append(scroll, more);
  const groupsHost = node('div', null, 'admin-groups');
  const drawer = node('dialog', null, 'admin-record-dialog'); drawer.hidden = true; drawer.tabIndex = -1; drawer.setAttribute('aria-label', 'Selected workspace');
  content.append(listPanel, drawer);
  root.append(head, lede, notice, createForm, content, groupsHost); host.replaceChildren(root);
  onContext('Workspaces');

  const say = (text, tone = '') => {if(/^(Creating|Loading)/.test(text)){notice.textContent=text;return;}notice.textContent='';notices.notify(text,{error:tone==='bad'});};
  const guard = fn => async () => { if (busy || closed) return; busy = true; try { await fn(); } finally { busy = false; } };

  async function loadList(reset) {
    try {
      const page = workspacePage(await request(['admin', 'workspaces', 'query'], { method: 'POST', body: { after: reset ? null : after }, maxResponseBytes: 131072 }));
      if (closed) return;
      if (!page) throw new Error('invalid');
      rows = reset ? page.workspaces : [...rows, ...page.workspaces]; after = page.nextAfter; more.hidden = after === null; renderList();
      if (!rows.length) say('There are no workspaces yet. Create one to begin.');
    } catch { if (!closed) say('Workspaces could not be loaded. Refresh to try again.', 'bad'); }
  }
  function renderList() {
    const body = node('tbody'), headRow = node('tr'), thead = node('thead');
    const th = node('th', 'Workspace'); th.scope = 'col'; headRow.append(th); thead.append(headRow);
    const shown=rows.filter(r=>r.name.toLowerCase().includes(search.value.toLowerCase()));count.textContent=shown.length+' loaded workspaces';
    for (const row of shown) {
      const tr = node('tr'), td = node('td'), open = node('button', row.name, 'btn tertiary'); open.type = 'button'; open.dataset.record = row.id;
      if (row.id === selected) open.setAttribute('aria-current', 'true');
      open.onclick = () => { if (!busy) void select(row); }; td.append(open); tr.append(td); activateSingleActionRow(tr,open);body.append(tr);
    }
    table.replaceChildren(node('caption', 'Workspaces'), thead, body);
  }
  async function select(row,{confirmed=false}={}) {
    if (closed||!confirmed&&groups?.beforeNavigate?.({resume:()=>void select(row)})===false) return;
    recordModal?.dispose();recordModal=null;nameEditor?.close();nameEditor=null;
    selected = row.id; renderList(); const g = ++generation;
    groups?.close(); groups = null; groupsHost.replaceChildren(); drawer.hidden = false; drawer.replaceChildren(node('h3', row.name), node('p', 'Loading settings…', 'admin-muted'));
    openRecord(row);
    try {
      const value = await request(['admin', 'workspaces', row.id, 'storage'], { maxResponseBytes: 131072 });
      if (closed || g !== generation) return;
      renderDetail(row, value);
    } catch (error) {
      if (closed || g !== generation) return;
      const retry = node('button', 'Retry', 'btn quiet'); retry.type = 'button'; retry.onclick = () => { if (!busy) void select(row); };
      drawer.replaceChildren(node('h3', row.name), node('p', error?.status === 403 ? adminMessage('forbidden') : 'Settings are unavailable. Nothing was changed; try again.', 'admin-notice'), retry);
    }
  }
  function renderDetail(row, value) {
    const checks = new Map(), parts = [];
    const back = node('button', 'Back to workspaces', 'btn quiet'); back.type = 'button';
    back.onclick = () => {if(groups?.beforeNavigate?.({resume:()=>back.click()})===false)return; generation++;recordModal?.dispose();recordModal=null;nameEditor?.close();nameEditor=null; groups?.close(); groups = null; groupsHost.replaceChildren(); selected = null; drawer.hidden = true; drawer.replaceChildren(); renderList(); table.querySelector('button[data-record]')?.focus(); };
    back.hidden=true;parts.push(back, node('h3', row.name));
    // Policies.
    const policies = node('section', null, 'admin-card'); policies.append(node('h4', 'Who can do what'));
    const saveP = node('button', 'Save policies', 'btn primary'); saveP.type = 'button'; saveP.disabled = true;
    for (const [key, text, help] of POLICY_TEXT) {
      const label = node('label', null, 'admin-policy'), box = node('input'); box.type = 'checkbox'; box.checked = value.policies[key] === true; box.dataset.policy = key;
      box.addEventListener('change', () => { saveP.disabled = Object.keys(policyChanges(value.policies, current())).length === 0; });
      const words = node('span'); words.append(node('strong', text), node('small', help, 'admin-muted')); label.append(box, words); policies.append(label); checks.set(key, box);
    }
    const current = () => Object.fromEntries([...checks].map(([key, box]) => [key, box.checked]));
    saveP.onclick = guard(async () => {
      saveP.disabled = true; say('Saving policies…');
      await save(row, value.policyRevision, policyChanges(value.policies, current()), null, 'Policies saved.');
    });
    policies.append(saveP, node('p', 'Policies apply to everyone in the workspace at once. There are no per-person switches.', 'admin-muted'));
    // Storage.
    const sum = storageSummary(value), storage = node('section', null, 'admin-card'); storage.append(node('h4', 'Image storage'));
    const meter = node('progress'); meter.max = 100; meter.value = Math.min(100, sum.percent); meter.setAttribute('aria-label', `Image storage used: ${sum.percent}%`);
    const meterNote = node('p', sum.message, sum.warn ? 'admin-notice' : 'admin-muted'); if (sum.warn) { meterNote.dataset.tone = 'bad'; meterNote.setAttribute('role', 'status'); }
    const quotaLabel = node('label', 'Quota (GB, 0 to 10)'), quota = node('input'); quota.inputMode = 'decimal'; quota.value = String(+(value.quotaBytes / 1e9).toFixed(3)); quotaLabel.append(quota);
    const saveQ = node('button', 'Save quota', 'btn'); saveQ.type = 'button';
    saveQ.onclick = guard(async () => {
      const bytes = quotaBytesFromGb(quota.value);
      if (bytes === null) { say(SAVE.bad_request, 'bad'); quota.focus(); return; }
      if (bytes === value.quotaBytes) { say('The quota is already that.'); return; }
      saveQ.disabled = true; say('Saving the quota…');
      await save(row, value.policyRevision, {}, bytes, 'Quota saved.');
    });
    const tools = node('div', null, 'admin-toolbar'); tools.append(quotaLabel, saveQ);
    storage.append(meter, meterNote, tools);
    // Unused images.
    const unused = node('section', null, 'admin-card'); unused.append(node('h4', 'Unused images'));
    if (!value.unused.length) unused.append(node('p', 'Every image is used by a draft, a version or a room, or is less than a day old.', 'admin-muted'));
    else {
      unused.append(node('p', `${value.unused.length} ${value.unused.length === 1 ? 'image is' : 'images are'} used by no draft, version or room (${size(value.unusedBytes)}).${value.unused.length >= 200 ? ' Only the first 200 are listed; delete these, then open this list again.' : ''}`, 'admin-muted'));
      const list = node('ul', null, 'admin-unused');
      for (const asset of value.unused) list.append(node('li', `${asset.altText ?? 'No description'} · ${asset.kind === 'video' ? 'video' : 'image'} · ${size(asset.bytes)} · added ${when(asset.createdAt)}`));
      const del = node('button', 'Delete unused', 'btn danger'); del.type = 'button';
      del.onclick = () => {
        if (busy || !confirm) return;
        const ids = value.unused.map(asset => asset.assetId);
        confirm.open({ title: `Delete ${value.unused.length} unused ${value.unused.length === 1 ? 'image' : 'images'}?`, sub: row.name, consequences: deleteUnused({ count: value.unused.length, bytes: value.unusedBytes }),
          actionLabel: 'Delete unused', elevation,
          run: async token => {
            try { const out = await request(['admin', 'workspaces', row.id, 'storage', 'delete-unused'], { method: 'POST', body: { assetIds: ids }, headers: { 'X-Admin-Elevation': token } }); return { ok: true, data: out }; }
            catch (error) { return { ok: false, status: error?.status ?? 0, error: error?.code ?? 'admin_unavailable' }; }
          },
          onDone: result => {
            if (closed) return;
            if (result.ok) say(`Deleted ${result.data.deleted.length}. ${result.data.kept.length ? `${result.data.kept.length} kept because they are used now.` : ''}`.trim());
            else say(result.uncertain ? 'Case could not confirm the result. Open this workspace again to see what is left before deleting more.' : adminMessage(result.error), result.cancelled ? '' : 'bad');
            void select(row);
          } });
      };
      unused.append(list, del);
    }
    parts.push(policies, storage, unused);
    if (mountGroups) {
      // Groups need the full width, so they open below the list rather than inside this narrow panel.
      const gcard = node('section', null, 'admin-card'); gcard.append(node('h4', 'Groups'));
      const open = node('button', 'Manage groups', 'btn'); open.type = 'button';
      open.onclick = async () => {
        open.disabled = true;
        try { groups = await mountGroups(groupsHost, { workspace: row }); open.hidden = true; drawer.append(groupsHost);groupsHost.scrollIntoView?.({ block: 'nearest' }); }
        catch { say('Groups are unavailable. Try again.', 'bad'); open.disabled = false; }
      };
      gcard.append(node('p', 'Groups organise cases and never grant access.', 'admin-muted'), open); parts.push(gcard);
    }
    recordModal?.dispose();recordModal=null;drawer.replaceChildren(...parts);
    nameEditor=mountWorkspaceDetails(drawer,{request,workspaceId:row.id,onReady:()=>recordModal?.reset(),onChanged:v=>{row.name=v.name;renderList();drawer.querySelector('h3').textContent=v.name;recordModal?.reset();}});
    openRecord(row);

  }
  function openRecord(row){
    const shown=rows.filter(r=>r.name.toLowerCase().includes(search.value.toLowerCase())),index=shown.findIndex(r=>r.id===row.id);
    recordModal=recordDialog(drawer,{pending:()=>busy||Boolean(nameEditor?.pending()),dirty:()=>Boolean(nameEditor?.hasUnsaved())||Boolean(groups?.hasUnsaved?.()),opener:()=>table.querySelector('button[data-record="'+row.id+'"]'),close:()=>{generation++;recordModal?.dispose();recordModal=null;nameEditor?.close();nameEditor=null;groups?.close();groups=null;groupsHost.replaceChildren();root.append(groupsHost);selected=null;drawer.hidden=true;drawer.replaceChildren();renderList();table.querySelector('button[data-record="'+row.id+'"]')?.focus();},previous:index>0?()=>void select(shown[index-1],{confirmed:true}):null,next:index>=0&&index+1<shown.length?()=>void select(shown[index+1],{confirmed:true}):null});
  }
  async function save(row, expectedRevision, policies, mediaQuotaBytes, done) {
    try {
      await request(['admin', 'workspaces', row.id, 'settings'], { method: 'POST', body: { expectedRevision, policies, mediaQuotaBytes } });
      if (closed) return; say(done); await select(row);
    } catch (error) { if (closed) return; say(SAVE[error?.code] ?? 'Case could not save. Nothing was changed; try again.', 'bad'); await select(row); }
  }
  let slugEdited=false,continuation=null,allowing=false;
  const dirtyCreation=()=>!createForm.hidden&&Boolean(name.value||slug.value);
  const resetCreation=()=>{createForm.hidden=true;createForm.reset();slugEdited=false;};
  const leaveGuard=guardDialog(root,{dirty:dirtyCreation,pending:()=>busy,onClose:()=>{const run=continuation;continuation=null;resetCreation();allowing=true;try{run?.();}finally{allowing=false;}}});
  function attempt(run){if(busy||closed)return false;if(allowing||!dirtyCreation()){run();return true;}continuation=run;document.querySelector('dialog.site-menu[open]')?.close();leaveGuard.requestClose();return false;}
  const beforeUnload=event=>{if(!closed&&!allowing&&(busy||dirtyCreation())){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  create.onclick = () => { if(!busy){createForm.hidden = false; name.focus();} };
  cancelCreate.onclick=()=>attempt(()=>{resetCreation();create.focus();});
  slug.addEventListener('input', () => { slugEdited = true; }); name.addEventListener('input', () => { if (!slugEdited) slug.value = slugOf(name.value); });
  createForm.addEventListener('submit', event => void guard(async () => {
    event.preventDefault?.();
    const label = name.value.trim(), short = slug.value.trim();
    if (!label || !SLUG.test(short) || short.length > 48) { say(CREATE.bad_request, 'bad'); return; }
    submit.disabled = true; say(`Creating ${label}…`);
    try {
      await request(['workspaces'], { method: 'POST', body: { slug: short, name: label } });
      if (closed) return; say(`${label} is created, and you are its owner. Add people under People or Invitations.`); createForm.hidden = true; createForm.reset(); slugEdited = false; await loadList(true);
    } catch (error) { if (!closed) say(CREATE[error?.code] ?? 'Case could not create the workspace. Nothing was changed; try again.', 'bad'); }
    finally { submit.disabled = false; }
  })());
  createForm.addEventListener('submit', event => event.preventDefault());
  more.onclick = guard(() => loadList(false));
  void loadList(true);
  return { beforeNavigate(action={}){if(busy||recordModal?.beforeNavigate(action)===false)return false;if(!allowing&&dirtyCreation()){attempt(action.resume??(()=>{if(action.href)location.assign(action.href);}));return false;}return groups?.beforeNavigate?.(action)??true;}, close() { closed = true;recordModal?.dispose();nameEditor?.close();leaveGuard.dispose();continuation=null;window.removeEventListener('beforeunload',beforeUnload);notices.close();searchControl.dispose(); groups?.close(); host.replaceChildren(); } };
}
