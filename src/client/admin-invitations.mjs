// Administration -> Invitations (CASE-339, CASE-340; plan §3 A4; prototypes/admin-people.html, the invite parts).
// Invite people into a workspace as Facilitator, Author or Owner, then see that workspace's invitations with Resend and
// Revoke (a dialog that says what Revoke does). Every outcome is said as a fact with its reason; a failed address stays
// in the field. Text only.
import { collapseSearch, disclosure } from './surface-controls.mjs';
import { guardDialog } from './dialog-behaviour.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
import { permissionComparison } from './permission-comparison.mjs';
import { enhanceSelect, disposeSelects } from './accessible-select.mjs';
import { node } from './auth-ui.mjs';
import { workspacePage } from '../shared/admin-workbench.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { revokeInvitation } from './admin-consequences.mjs';

const ROLES = Object.freeze([['run', 'Can run', 'Run published cases and read your own session records.'],
  ['edit', 'Can edit', 'Create and edit cases. Publishing follows the workspace policy.'],
  ['manage', 'Can manage', 'Manage this workspace and its groups. Invitations and workspace session records depend on policy. Admin access is separate.']]);
const ROLE = Object.fromEntries(ROLES.map(([level, label]) => [level, label]));
export const EMAIL_NOT_CONFIGURED = 'Email isn\'t set up yet: invitations are saved; press Resend once it is.';
const time = iso => { const at = new Date(iso); return Number.isFinite(at.getTime()) ? at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'later'; };
const day = iso => { const at = new Date(iso); return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Not recorded'; };

/** What Administration says for one create or resend answer: [tone, text]; tone '' is good news, 'bad' needs action. */
export function inviteOutcome(result, { email, workspace }) {
  const place = workspace ?? 'the workspace', role = ROLE[result?.invitation?.level] ?? 'Can run';
  switch (result?.outcome) {
    case 'sent': return ['', `Invitation sent to ${email} · ${role} in ${place}. ${result.account === 'existing' ? 'They already have a Case account and sign in as usual.' : 'They sign in with a code from a second email.'}`];
    case 'email_not_configured': return ['bad', EMAIL_NOT_CONFIGURED];
    case 'email_limit': return ['bad', `Case has reached its email limit. Nothing was sent; the invitation is saved and Resend works after ${time(result.retryAfter)}.`];
    case 'saved_not_sent': return ['bad', result.reason === 'account_rate_limited'
      ? 'The sign-in service is busy, so the account was not created and nothing was sent. The invitation is saved; press Resend in a few minutes.'
      : result.reason === 'email_failed' ? 'The email could not be sent. The invitation is saved; press Resend to try again.'
        : 'The sign-in service did not create the account, so nothing was sent. The invitation is saved; press Resend to try again.'];
    case 'already_has_access': return ['', `${email} already has access to ${place}. No email was sent. Change their role under People.`];
    case 'already_invited': return ['bad', `${email} already has a waiting invitation to ${place}. Nothing was sent; press Resend on it below.`];
    default: return ['bad', 'The invitation could not be confirmed. Refresh the list before trying again.'];
  }
}
/** What Administration says for a refusal (the Worker's fixed error code). */
export function inviteRefusal(code) {
  return ({ cap_reached: 'You have sent the daily limit of 50 invitations and resends. Nothing was sent; try again tomorrow.',
    account_disabled: 'That account is disabled. Enable it under People before inviting it. Nothing was saved.',
    account_deleted: 'That account is scheduled for deletion. Restore it under People before inviting it. Nothing was saved.',
    account_unavailable: 'That address can’t be invited. Nothing was saved.',
    auth_unavailable: 'Case could not reach the sign-in service. Nothing was saved; try again in a minute.',
    auth_rate_limited: 'The sign-in service is busy. Nothing was saved; try again in a few minutes.',
    invitation_ended: 'That invitation has already ended. Send a new one.',
    forbidden: 'You can’t invite into this workspace.', bad_request: 'Enter one email address.',
    rate_limited: 'Too many requests. Wait a minute, then try again.' })[code] ?? 'Case could not confirm this result. Refresh invitations before trying again.';
}

const STATUS = Object.freeze({ pending: 'Waiting', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired' });
const SEND = Object.freeze({ sent: 'Sent', not_sent: 'Not sent', failed: 'Not sent', email_limit: 'Not sent (email limit)', email_not_configured: 'Not sent (email not set up)' });

export function mountAdminInvitations(host, { request, confirm = null, workspace = null, allowedLevels = null, dialogOnly = false, opener = null }) {
  if(workspace&&(!isUuidV7(workspace.id)||typeof workspace.name!=='string'))throw new TypeError('Invalid workspace');
  let readConfirmed=false;let pendingAddress=null;let closed = false, busy = false, workspaces = [], workspaceId = null, rows = [], listing = false;
  const notices=createSurfaceNotice(),root = node('section', null, 'admin-invitations');const searches=[];const dialog=node('dialog',null,'computer-dialog admin-invite-dialog');dialog.setAttribute('aria-label','Invite person');if(dialogOnly)dialog.classList.add('workspace-share');const invite=node('button','+ Invite person','btn primary');invite.type='button';const cancel=node('button','Cancel','btn quiet');cancel.type='button';const guard=guardDialog(dialog,{dirty:()=>Boolean(email.value.trim())||accessLevel.value!=='run',pending:()=>busy||Boolean(pendingAddress),opener:()=>opener??invite});invite.onclick=()=>{if(!busy){dialog.showModal();email.focus();}};cancel.onclick=()=>guard.requestClose();
  const form = node('form', null, 'admin-invite-form'); form.noValidate = true;
  const emailLabel = node('label', 'Email address'), email = node('input');
  email.className='input';email.type = 'email'; email.maxLength = 320; email.autocomplete = 'off'; email.required = true; emailLabel.append(email);
  const wsLabel = node('label', 'Workspace'), ws = node('select'); wsLabel.append(ws);
  const roles=node('fieldset',null,'admin-invite-roles'),accessLevel=node('select');accessLevel.setAttribute('aria-label','Access');roles.append(node('legend','Access'),accessLevel);for(const [level,label,help]of ROLES.filter(row=>!allowedLevels||allowedLevels.includes(row[0]))){const option=node('option',label);option.value=level;option.dataset.description=help;accessLevel.append(option);}
  const send = node('button', 'Send invitation', 'btn primary'); send.type = 'submit';const reconcile=node('button','Check invitation status','btn');reconcile.type='button';reconcile.hidden=true;reconcile.onclick=()=>void loadList();
  const notice = node('p', null, 'admin-notice'); notice.setAttribute('role', 'status');
  const accessSummary=node('p',ROLES[0][2],'small muted');accessLevel.onchange=()=>{accessSummary.textContent=ROLES.find(r=>r[0]===accessLevel.value)?.[2]??'';};const comparison=permissionComparison({search:(run,{label,inputLabel})=>{const input=node('input');input.type='search';input.setAttribute('aria-label',inputLabel);input.oninput=()=>run(input.value);const control=collapseSearch(input,{label});searches.push(control);return control.root;}});comparison.hidden=false;const permissions=disclosure('full permissions',comparison);const actions=node('div',null,'dialog-actions');actions.append(cancel,reconcile,send);const targetName=node('p','','small muted');form.append(node('h2','Invite person'),targetName,emailLabel,roles,accessSummary,permissions,actions);dialog.append(form);
  const listHeading = node('h3', 'Invitations'), table = node('table', null, 'admin-table admin-invitation-list');
  const intro = node('p', 'An invitation becomes access when the person first signs in with that email. It works for 90 days; Resend sends a new link and ends the old one.', 'admin-muted');
  const title=node('h2','Invitations','sr-only'),toolbar=node('div',null,'admin-toolbar studio-admin-toolbar');const searchInput=node('input');searchInput.type='search';searchInput.setAttribute('aria-label','Search loaded invitations');const searchControl=collapseSearch(searchInput,{label:'Search loaded invitations'});searches.push(searchControl);searchInput.oninput=()=>renderList();const count=node('span','','small muted');toolbar.append(title,wsLabel,searchControl.root,count,invite);root.append(toolbar,notice,listHeading,table,dialog);intro.className='small muted';form.insertBefore(intro,emailLabel);
  host.replaceChildren(root);

  const say = ([tone, text]) => { notices.notify(text,{error:tone==='bad'}); };
  const setBusy = value => { busy = value;send.textContent=value?'Sending…':'Send invitation'; send.disabled = value || !workspaceId||Boolean(pendingAddress);reconcile.hidden=!pendingAddress;reconcile.disabled=value;cancel.disabled=value||Boolean(pendingAddress); ws.disabled = value || !workspaceId||Boolean(pendingAddress); email.disabled = value||Boolean(pendingAddress); roles.disabled = value||Boolean(pendingAddress); for (const button of table.querySelectorAll('button')) button.disabled = value; };
  enhanceSelect(accessLevel,{label:'Access'});
  enhanceSelect(comparison.querySelector('select'),{label:'Permission comparison scope'});
  const selectedName = () => workspaces.find(row => row.id === workspaceId)?.name ?? null;

  async function loadWorkspaces() {
    try {
      const page = workspace ? {workspaces:[workspace]} : workspacePage(await request(['admin', 'workspaces', 'query'], { method: 'POST', body: { after: null }, maxResponseBytes: 131072 }));
      if (closed) return;
      if (!page) throw new Error('invalid');
      workspaces = page.workspaces; ws.replaceChildren(...workspaces.map(row => { const option = node('option', row.name); option.value = row.id; return option; }));
      workspaceId = workspaces[0]?.id ?? null;
      enhanceSelect(ws, { label: 'Workspace' }); setBusy(busy);
      if (workspaceId) await loadList(); else listHeading.textContent = 'Invitations · no workspaces yet';
    } catch { if (!closed) say(['bad', 'Workspaces could not be loaded. Refresh to try again.']); }
  }
  async function loadList() {
    if (!isUuidV7(workspaceId)) return;
    const asked = workspaceId;
    try {
      const value = await request(['workspaces', workspaceId, 'invitations'], { maxResponseBytes: 262144 });
      if (closed || asked !== workspaceId) return;
      readConfirmed=Array.isArray(value?.invitations);listing = false; rows = Array.isArray(value?.invitations) ? value.invitations : [];
      renderList();if(pendingAddress){const found=rows.find(r=>r.email===pendingAddress&&!r.caseTitle&&r.level===accessLevel.value&&['pending','accepted'].includes(r.status));if(found){const address=pendingAddress;pendingAddress=null;email.value='';dialog.close();setBusy(false);say(['',`Current invitation for ${address}: ${STATUS[found.status]} · ${SEND[found.sendState]??'Delivery not confirmed'}. Check this entry before using Resend.`]);}else say(['bad','No matching invitation is visible yet. Check again; sending remains disabled.']);}
    } catch (error) { if (!closed && asked === workspaceId) { readConfirmed=false;listing = false; rows = []; renderList(); say(['bad', inviteRefusal(error?.code)]); } }
  }
  function renderList() {
    targetName.textContent=selectedName()??'Workspace';listHeading.textContent = `Invitations · ${selectedName() ?? 'workspace'}`;
    const head = node('thead'), headRow = node('tr'), body = node('tbody');
    for (const label of ['Email', 'Access', 'Invited by', 'Expires', 'Status', 'Actions']) { const th = node('th', label); th.scope = 'col'; headRow.append(th); }
    head.append(headRow);
    const shown=rows.filter(r=>[r.email,r.caseTitle,ROLE[r.level],STATUS[r.status]].join(' ').toLowerCase().includes(searchInput.value.toLowerCase()));count.textContent=shown.length+' loaded invitations';
    for (const row of shown) {
      const tr = node('tr'), live = row.status === 'pending';
      tr.append(node('td', row.email ?? 'Address removed'), node('td', row.caseTitle ? `${row.level === 'edit' ? 'Can edit' : 'Can run'} · ${row.caseTitle}` : ROLE[row.level] ?? row.level),
        node('td', row.inviterName ?? 'Not recorded'), node('td', live ? day(row.expiresAt) : '—'),
        node('td', live ? `${STATUS.pending} · ${SEND[row.sendState] ?? 'Not sent'}` : STATUS[row.status] ?? row.status));
      const cell = node('td');
      if (live) {
        const resend = node('button', 'Resend', 'btn quiet'), revoke = node('button', 'Revoke', 'btn danger');
        resend.type = revoke.type = 'button';
        resend.setAttribute('aria-label', `Resend the invitation to ${row.email}`); revoke.setAttribute('aria-label', `Revoke the invitation to ${row.email}`);
        resend.addEventListener('click', () => void act(row, 'resend'));
        revoke.addEventListener('click', () => {
          if (busy || closed) return;
          // The dialog states the consequences first (AS-212); Revoke needs no step-up.
          confirm.open({ title: `Revoke the invitation to ${row.email}?`, sub: `${selectedName() ?? 'Workspace'} · ${ROLE[row.level] ?? row.level}`, consequences: revokeInvitation({ email: row.email }),
            actionLabel: 'Revoke invitation', elevation: null,
            run: () => act(row, 'revoke', {report:false}), onDone: result => {if(!closed&&result.notice)say(result.notice);} });
        });
        cell.append(resend, revoke);
      }
      tr.append(cell);for(const [i,td]of [...tr.children].entries())td.dataset.label=['Email','Access','Invited by','Expires','Status','Actions'][i];body.append(tr);
    }
    table.replaceChildren(head, body);
    if (!shown.length) table.append(node('caption', listing ? 'Loading invitations…' : 'No invitations in this workspace yet.'));
    setBusy(busy);
  }
  async function act(row, verb, {report=true}={}) {
    if (busy || closed) return {ok:false,status:409,error:'conflict'};
    const target = { id: workspaceId, name: selectedName() };
    setBusy(true);
    try {
      const result = await request(['workspaces', target.id, 'invitations', row.id, verb], { method: 'POST', body: {} });
      if (closed) return {ok:false,status:0,error:'admin_unavailable'};
      if(verb==='revoke'&&result?.outcome!=='revoked')throw new Error('unconfirmed_revoke');
      const notice=verb === 'revoke' ? ['', `The invitation to ${row.email} is revoked. Its link no longer works.`] : inviteOutcome(result, { email: row.email, workspace: target.name });
      if(report)say(notice);return {ok:true,status:200,notice};
    } catch (error) { const notice=['bad',inviteRefusal(error?.code)];if(!closed&&report)say(notice);return {ok:false,status:error?.status??0,error:error?.code??'admin_unavailable',notice}; }
    finally { if (!closed) { setBusy(false); await loadList(); } }
  }
  ws.addEventListener('change', () => { if (busy||pendingAddress) { ws.value = workspaceId; return; } workspaceId = ws.value; rows = []; listing = true; renderList(); void loadList(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (event.submitter !== send) return;
    if (busy || pendingAddress || closed || !isUuidV7(workspaceId)) return;
    const address = email.value.trim().toLowerCase(), level = accessLevel.value;
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address)) { say(['bad', inviteRefusal('bad_request')]); email.focus(); return; }
    const target = { id: workspaceId, name: selectedName() };
    setBusy(true); say(['', `Sending the invitation to ${address}…`]);
    try {
      const result = await request(['invitations'], { method: 'POST', body: { workspaceId: target.id, level, email: address } });
      if (closed) return;
      const outcome=inviteOutcome(result, { email: address, workspace: target.name });
      // The address stays in the field until the invitation is saved or found (discovery §1: a failed address was lost).
      if (['sent', 'email_not_configured', 'email_limit', 'saved_not_sent', 'already_has_access', 'already_invited'].includes(result?.outcome)) {email.value = '';dialog.close();}else pendingAddress=address;say(outcome);
    } catch (error) {if(!closed){if(!error?.status||error.status>=500){pendingAddress=address;say(['bad','The invitation outcome is unknown. Check invitation status before sending again.']);}else say(['bad',inviteRefusal(error?.code)]);}}
    finally { if (!closed) { setBusy(false); await loadList(); } }
  });
  if(dialogOnly)for(const child of root.children)if(child!==dialog)child.hidden=true;
  setBusy(false); const ready=loadWorkspaces();
  return {open:async()=>{await ready;if(!closed&&workspaceId&&(!dialogOnly||readConfirmed))invite.click();}, hasUnsaved:()=>dialog.open&&(busy||Boolean(pendingAddress)||Boolean(email.value.trim())),beforeNavigate(){if(busy||pendingAddress)return false;if(dialog.open){guard.requestClose();return !dialog.open;}return true;}, close() { closed = true;guard.dispose();notices.close();for(const s of searches)s.dispose();disposeSelects(root);host.replaceChildren(); } };
}
