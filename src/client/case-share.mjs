// Share on the case page (CASE-336, CASE-339; plan §3 A6; prototypes/admin-people.html and access-model.html). One dialog:
// who to invite, "This case only" or "Every case in <workspace>", Can run or Can edit, then who already has access and
// what is waiting. It offers only what the Worker said this person may do (`share`), and says every outcome as a fact.
// A lazy chunk of the case page. Text only: every value is set with textContent.
import { guardDialog } from './dialog-behaviour.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
import { isUuidV7 } from '../shared/ids.mjs';

const node = (tag, label, className) => { const item = document.createElement(tag); if (label != null) item.textContent = label; if (className) item.className = className; return item; };

const LEVEL = Object.freeze({ run: 'Can run', edit: 'Can edit', manage: 'Can manage' });
const ROLE_LEVEL = Object.freeze({ facilitator: 'run', author: 'edit', owner: 'manage' });
const day = iso => { const at = new Date(iso); return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'later'; };
const clock = iso => { const at = new Date(iso); return Number.isFinite(at.getTime()) ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'later'; };
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** One create answer in words: [tone, sentence]. Tone '' is good news; 'bad' needs the person to act. */
export function shareOutcome(result, { email, scope, level, workspace }) {
  const what = scope === 'workspace' ? `${LEVEL[level]} on every case in ${workspace}` : `${LEVEL[level]} on this case`;
  switch (result?.outcome) {
    case 'sent': return ['', `Invitation sent to ${email}: ${what}. ${result.account === 'existing' ? 'They already have a Case account and sign in as usual.' : 'They sign in with a code from a second email.'}`];
    case 'email_not_configured': return ['bad', `The invitation to ${email} is saved, but Case's email is not set up yet, so nothing was sent. An administrator can resend it once it is.`];
    case 'email_limit': return ['bad', `Case has reached its email limit, so nothing was sent to ${email}. The invitation is saved; Resend works after ${clock(result.retryAfter)}.`];
    case 'saved_not_sent': return ['bad', `The invitation to ${email} is saved, but the email did not go. Press Resend on it below in a few minutes.`];
    case 'already_has_access': return ['', `${email} already has this access or more. Nothing changed and no email was sent.`];
    case 'already_invited': return ['bad', `${email} already has a waiting invitation. Nothing was sent; use Resend on it below.`];
    default: return ['bad', `The invitation to ${email} could not be confirmed. Reload this dialog before trying again.`];
  }
}
/** A refusal in words (the Worker's fixed error codes). */
export function shareRefusal(code, email = 'that address') {
  return ({ cap_reached: 'You have sent the daily limit of 50 invitations and resends. Nothing was sent; try again tomorrow.',
    account_disabled: `The account for ${email} is disabled, so it cannot be invited. Nothing was saved.`,
    account_deleted: `The account for ${email} is scheduled for deletion. Nothing was saved.`,
    account_unavailable: `${email} cannot be invited. Nothing was saved.`,
    auth_unavailable: 'Case could not reach the sign-in service. Nothing was saved; try again in a minute.',
    auth_rate_limited: 'The sign-in service is busy. Nothing was saved; try again in a few minutes.',
    case_archived: 'This case is archived, so it cannot be shared.',
    invitation_ended: 'That invitation has already ended. Send a new one.',
    forbidden: 'You can’t share this case.', bad_request: `${email} is not a valid email address.`,
    rate_limited: 'Too many requests. Wait a minute, then try again.' })[code] ?? 'Sharing could not be confirmed. Check current access and invitations before trying again.';
}

/** Open the Share dialog. `share` is what the Worker said this person may offer (case detail's `share`). */
export function openShare({ request, caseId, title, workspaceId, workspaceName, share, onClose = () => {} }) {
  if (typeof request !== 'function' || !isUuidV7(caseId) || !isUuidV7(workspaceId) || !share) throw new TypeError('Share needs a case, its workspace and what the person may offer.');
  const workspace = workspaceName || 'this workspace';
  const notices=createSurfaceNotice();let dismissal=null,messages=[];
  let closed = false, busy = false, access = null, scope = 'case', level = share.levels[0];
  const dialog = node('dialog', null, 'computer-dialog share-dialog'); dialog.setAttribute('aria-labelledby', 'shareTitle');
  const heading = node('h2', `Share “${title}”`); heading.id = 'shareTitle';
  const sub = node('p', 'The email names you and this case. The invitation lasts 90 days.', 'muted');

  const form = node('form', null, 'share-form'); form.noValidate = true;
  const emailLabel = node('label', 'Email addresses', 'share-field'), emails = node('input', null, 'input');
  emails.type = 'text'; emails.autocomplete = 'off'; emails.maxLength = 1000; emails.placeholder = 'name@hospital.org'; emails.setAttribute('aria-describedby', 'shareEmailHint');
  emailLabel.append(emails);
  const hint = node('small', 'Separate several addresses with commas.', 'muted'); hint.id = 'shareEmailHint';

  const scopes = node('fieldset', null, 'share-scope'); scopes.append(node('legend', 'What they get'));
  const scopeOptions = [['case', 'This case only', `It appears under “Shared with you”. Nothing else in ${workspace}.`]];
  if (share.workspaceWide) scopeOptions.push(['workspace', `Every case in ${workspace}`, 'All its cases, and any added later.']);
  for (const [value, label, help] of scopeOptions) {
    const item = node('label', null, 'share-choice'), radio = node('input'); radio.type = 'radio'; radio.name = 'share-scope'; radio.value = value; radio.checked = value === scope;
    const words = node('span'); words.append(node('strong', label), node('small', help));
    radio.addEventListener('change', () => { scope = value; describe(); });
    item.append(radio, words); scopes.append(item);
  }
  scopes.hidden = scopeOptions.length < 2;

  const levels = node('div', null, 'share-level'); levels.append(node('span', 'Level', 'share-label'));
  const group = node('div', null, 'segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Level');
  for (const value of share.levels) {
    const button = node('button', LEVEL[value]); button.type = 'button'; button.dataset.level = value; button.setAttribute('aria-pressed', String(value === level));
    button.addEventListener('click', () => { level = value; for (const other of group.children) other.setAttribute('aria-pressed', String(other === button)); describe(); });
    group.append(button);
  }
  if (share.levels.length > 1) levels.append(group); else levels.append(node('strong', LEVEL[level]), node('small', 'Your access lets you share to run only.', 'muted'));
  const meaning = node('p', null, 'muted share-meaning'); meaning.setAttribute('aria-live', 'polite');
  function describe() {
    meaning.textContent = scope === 'workspace'
      ? (level === 'edit' ? `They will see every case in ${workspace} and can create and edit cases there.` : `They will see and run every case in ${workspace}. They cannot edit.`)
      : (level === 'edit' ? 'They can open, edit and run this case. They cannot create cases or see the rest of the workspace.' : 'They can open and run this case. They cannot edit it or see the rest of the workspace.');
  }
  describe();

  const results = node('div', null, 'share-results'); results.setAttribute('role', 'status');
  const actions = node('div', null, 'dialog-actions');
  const send = node('button', 'Share', 'btn primary'); send.type = 'submit';
  const done = node('button', 'Close', 'btn'); done.type = 'button';
  actions.append(done, send);
  form.append(emailLabel, hint, scopes, levels, meaning, results, actions);

  const people = node('section', null, 'share-people'); people.setAttribute('aria-label', 'Who has access');
  people.append(node('h3', 'Who has access'), node('p', 'Loading…', 'muted'));
  dialog.append(heading, sub, form, people);
  document.body.append(dialog);

  const finish = () => { if (closed) return; closed = true;dismissal?.dispose();notices.close(); try { dialog.close(); } catch { /* not open */ } dialog.remove(); onClose(); };
  dismissal=guardDialog(dialog,{dirty:()=>Boolean(emails.value.trim())||scope!=='case'||level!==share.levels[0],pending:()=>busy,onClose:finish});done.addEventListener('click',()=>dismissal.requestClose());
  const say = (tone,text) => {if(closed)return;messages.push({tone,text});notices.notify(messages.map(m=>m.text).join(' '),{error:messages.some(m=>m.tone==='bad')});};

  function row(name, tag, ...extra) {
    const item = node('li', null, 'share-person');
    item.append(node('span', name, 'share-name'), node('span', tag, 'tag'), ...extra);
    return item;
  }
  function renderPeople() {
    people.replaceChildren(node('h3', 'Who has access'), node('p', 'Home-workspace and direct case access are listed here. Managers review additional workspace sharing in Workspace details.', 'muted'));
    if (!access) { people.append(node('p', 'Who has access could not be loaded. Close and open Share to try again.', 'muted')); return; }
    const you = access.you, list = node('ul', null, 'share-list');
    const workspaceList = node('details', null, 'share-members');
    workspaceList.append(node('summary', `Everyone in ${workspace} (${access.members.length}) can use this case`));
    const members = node('ul', null, 'share-list');
    for (const member of access.members) members.append(row(member.name, LEVEL[ROLE_LEVEL[member.role]] ?? member.role));
    workspaceList.append(members);
    for (const grant of access.grants) {
      const extra = [];
      if (you.revoke) {
        const remove = node('button', 'Remove access', 'btn quiet'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${grant.name}’s access to this case`);
        remove.addEventListener('click', () => confirmRemove(item, grant));
        extra.push(remove);
      }
      const item = row(grant.name, LEVEL[grant.level], ...extra); item.dataset.grant = grant.grantId; list.append(item);
    }
    for (const invite of access.invitations) {
      const extra = [];
      if (you.manageInvitations) {
        const resend = node('button', 'Resend', 'btn quiet'), revoke = node('button', 'Revoke', 'btn quiet');
        resend.type = revoke.type = 'button';
        resend.setAttribute('aria-label', `Resend the invitation to ${invite.email}`); revoke.setAttribute('aria-label', `Revoke the invitation to ${invite.email}`);
        resend.addEventListener('click', () => void act(invite, 'resend'));
        revoke.addEventListener('click', () => confirmRevoke(item, invite));
        extra.push(resend, revoke);
      }
      const item = row(invite.email, LEVEL[invite.level], node('small', `Invited · expires ${day(invite.expiresAt)}${invite.sendState && invite.sendState !== 'sent' ? ' · not sent' : ''}`, 'muted'), ...extra);
      item.dataset.invitation = invite.invitationId; list.append(item);
    }
    people.append(workspaceList);
    if (list.children.length) people.append(node('h4', 'This case only'), list);
    else people.append(node('p', 'No one has been given this case on its own yet.', 'muted'));
  }
  // Two steps and the consequences in words, before anything is ended.
  function confirmRemove(item, grant) {
    if(busy||closed)return;
    const box = node('div', null, 'share-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', `Remove ${grant.name}’s access`);
    const yes = node('button', 'Remove access', 'btn danger'), no = node('button', 'Keep access', 'btn quiet'); yes.type = no.type = 'button';
    box.append(node('p', `Remove ${grant.name}’s direct case access? Workspace or other shared access can still apply. Existing records keep their access rules.`), yes, no);
    item.append(box); yes.focus();
    no.addEventListener('click', () => { box.remove(); });
    yes.addEventListener('click', async () => {
      if(busy||closed)return;busy=true;yes.disabled = no.disabled = true;
      try { await request(['cases', caseId, 'access', grant.grantId, 'revoke'], { method: 'POST', body: {} }); say('', `${grant.name}’s direct case access was removed. Other access may still apply.`); }
      catch (error) { say('bad', error?.status === 403 ? 'Only a manager can remove access.' : 'Access removal could not be confirmed. Check the refreshed list before trying again.'); }
      finally {busy=false;}
      await load();
    });
  }
  function confirmRevoke(item, invite) {
    if(busy||closed)return;
    const box = node('div', null, 'share-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', `Revoke the invitation to ${invite.email}`);
    const yes = node('button', 'Revoke invitation', 'btn danger'), no = node('button', 'Keep invitation', 'btn quiet'); yes.type = no.type = 'button';
    box.append(node('p', `The link in the email to ${invite.email} stops working at once. They can be invited again.`), yes, no);
    item.append(box); yes.focus();
    no.addEventListener('click', () => { box.remove(); });
    yes.addEventListener('click', () => void act(invite, 'revoke'));
  }
  async function act(invite, verb) {
    if (busy || closed) return;
    busy = true;
    try {
      const result = await request(['workspaces', workspaceId, 'invitations', invite.invitationId, verb], { method: 'POST', body: {} });
      if (verb === 'revoke') say('', `The invitation to ${invite.email} is revoked. Its link no longer works.`);
      else { const [tone, text] = shareOutcome(result, { email: invite.email, scope: 'case', level: invite.level, workspace }); say(tone, text); }
    } catch (error) { say('bad', shareRefusal(error?.code, invite.email)); }
    finally { busy = false; await load(); }
  }
  async function load() {
    if (closed) return;
    try {
      const value = await request(['cases', caseId, 'access'], { maxResponseBytes: 262_144 });
      if (closed) return;
      if (value?.caseId !== caseId || !Array.isArray(value.members) || !Array.isArray(value.grants) || !Array.isArray(value.invitations) || !value.you) throw new Error('invalid_access');
      access = value;
    } catch { if (!closed) access = null; }
    if (!closed) renderPeople();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || closed) return;
    const addresses = [...new Set(emails.value.split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean))];
    messages=[];results.replaceChildren();
    if (!addresses.length) { say('bad', 'Enter at least one email address.'); emails.focus(); return; }
    const bad = addresses.find(item => !ADDRESS.test(item));
    if (bad) { say('bad', shareRefusal('bad_request', bad)); emails.focus(); return; }
    busy = true; send.disabled = true;emails.disabled=true;for(const input of scopes.querySelectorAll('input'))input.disabled=true;for(const b of group.children)b.disabled=true;
    const kept = [];
    for (const email of addresses) {
      if (closed) return;
      try {
        const result = await request(['invitations'], { method: 'POST', body: { workspaceId, level, email, ...(scope === 'case' ? { caseId } : {}) } });
        if(closed)return;const [tone, text] = shareOutcome(result, { email, scope, level, workspace }); say(tone, text);
        if (!['sent', 'email_not_configured', 'email_limit', 'saved_not_sent', 'already_has_access', 'already_invited'].includes(result?.outcome)) kept.push(email);
      } catch (error) { say('bad', shareRefusal(error?.code, email)); kept.push(email); }
    }
    busy = false; send.disabled = false;emails.disabled=false;for(const input of scopes.querySelectorAll('input'))input.disabled=false;for(const b of group.children)b.disabled=false;
    // An address that was not saved stays in the field (nothing is lost).
    emails.value = kept.join(', ');
    await load();
  });

  dialog.showModal();
  void load();
  return {beforeNavigate(){return !busy&&(!dialog.open||dismissal.requestClose());}, close: finish, dialog };
}
