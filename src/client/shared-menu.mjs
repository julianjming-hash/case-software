import {issueIdentityAuth} from './issue-auth-binding.mjs';
// Role adapters supply verified account identity or their own participant controls. The menu never
// holds a room capability. Public identity discovery occurs only on an explicit menu open. Same-tab links use the surface leave adapter.
import { homeUrl, casesUrl, privacyUrl, adminPageUrl, helpUrl, accountUrl, historyUrl, caseWorkspaceUrl } from '../shared/urls.mjs';
import { devicePreferences } from './device-preferences.mjs';
import { uiIcon } from './ui-icons.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
export const isPlainNavigation = event => !event.defaultPrevented && event.button === 0 &&
  !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
let ids = 0;
export const textNode = (doc, tag, text, className) => {
  const node = doc.createElement(tag); if (text != null) node.textContent = text;
  if (className) node.className = className; return node;
};
export function attachSiteMenu(opener, { current = 'join', participant = false, roomActions = [], profile = null, loadAccount = null, beforeNavigate = null, signOutMessage = null, getWorkspace } = {}) {
  const doc = opener.ownerDocument, origin = doc.defaultView.location.origin, serial = ++ids;
  const dialog = textNode(doc, 'dialog', null, 'site-menu'); dialog.id = `site-menu-${serial}`;
  const head = textNode(doc, 'div', null, 'site-menu-head'), title = textNode(doc, 'h2', 'Menu'); title.id = `${dialog.id}-title`;
  dialog.setAttribute('aria-labelledby', title.id);
  const closeButton = textNode(doc, 'button', '×', 'menu-button'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close menu');
  head.append(title, closeButton);
  const account = textNode(doc, 'section', null, 'site-account'); account.setAttribute('aria-label', 'Account'); account.hidden = true;
  const privateControls = textNode(doc, 'section', null, 'site-profile'); privateControls.hidden = !profile;
  const nav = textNode(doc, 'nav', null, 'site-nav'); nav.setAttribute('aria-label', 'Main');
  const notice = textNode(doc, 'p', '', 'site-menu-notice'); notice.setAttribute('role', 'status');
  const settings = devicePreferences(doc), settingsButton = textNode(doc, 'button', 'Settings', 'site-nav-link'); settingsButton.type = 'button';
  settings.root.id = `${dialog.id}-settings`; settings.root.hidden = true;
  settingsButton.setAttribute('aria-controls', settings.root.id); settingsButton.setAttribute('aria-expanded', 'false');
  settingsButton.addEventListener('click', () => {
    settings.root.hidden = !settings.root.hidden; settingsButton.setAttribute('aria-expanded', String(!settings.root.hidden)); settings.refresh();
  });
  let musicDialog=null,musicLoading=false,musicNotice=null;
  const musicButton=textNode(doc,'button','Music','site-nav-link');musicButton.type='button';musicButton.prepend(uiIcon('list-music'));settings.audio.insertBefore(musicButton,settings.audio.children[1]??null);
  musicButton.onclick=async()=>{if(musicLoading||musicDialog)return;musicNotice?.clear();musicLoading=true;musicButton.disabled=true;try{const {openMusicAudition}=await import('./music-audition.mjs');if(!removed)musicDialog=await openMusicAudition({opener:musicButton,isCurrent:()=>!removed&&dialog.open,onClose:()=>musicDialog=null});}catch{if(!removed)(musicNotice??=createSurfaceNotice()).notify('Music is unavailable. Try again.',{error:true});}finally{musicLoading=false;if(!removed)musicButton.disabled=false;}};
  const footer = textNode(doc, 'footer', null, 'site-menu-footer');
  const confirmation = textNode(doc, 'section', null, 'site-signout-confirm'); confirmation.hidden = true;
  const confirmTitle = textNode(doc, 'h3', 'Sign out?');
  const confirmText = textNode(doc, 'p');
  const cancelOut = textNode(doc, 'button', 'Cancel', 'btn quiet'), confirmOut = textNode(doc, 'button', 'Confirm sign out', 'btn danger');
  cancelOut.type = confirmOut.type = 'button';
  confirmation.append(confirmTitle, confirmText, cancelOut, confirmOut);
  const support=textNode(doc,'nav',null,'site-menu-support');support.setAttribute('aria-label','Support');
  support.append(link('Help',helpUrl(origin),'help'),link('Privacy',privacyUrl(origin),'privacy'));
  settingsButton.prepend(uiIcon('settings'));
  footer.append(support,settingsButton,settings.root,confirmation);
  dialog.append(head, account, privateControls, nav, notice, footer);
  doc.body.append(dialog);
  opener.setAttribute('aria-haspopup', 'dialog'); opener.setAttribute('aria-controls', dialog.id); opener.setAttribute('aria-expanded', 'false');
  let identity = null, accountPending = false, accountUnavailable = false, generation = 0, removed = false, navStructure = null, accountStructure = null, publicAccount=null;
  const cleanActions = actions => Array.isArray(actions) ? actions.filter(action => typeof action?.run === 'function' && typeof action.label === 'string' && action.label.trim()) : [];
  roomActions = cleanActions(roomActions);
  function link(text, href, key) {
    const node = textNode(doc, 'a', null, 'site-nav-link'); node.href = href; node.append(textNode(doc, 'span', text));
    const icon={join:'play',cases:'clapperboard',builder:'folders',history:'rotate-ccw-clock',admin:'shield-check',help:'circle-question-mark',privacy:'shield-check'}[key];if(icon)node.prepend(uiIcon(icon));
    if (beforeNavigate) node.addEventListener('click', event => {
      if (!isPlainNavigation(event)) return;
      event.preventDefault();
      if (beforeNavigate({ href, kind: 'navigation' }) !== true) return;
      close(); doc.defaultView.location.assign(href);
    });
    if (key === current) node.setAttribute('aria-current', 'page'); return node;
  }
  function render() {
    const workspaceId = getWorkspace?.();
    const structure = JSON.stringify([workspaceId, Boolean(identity), identity?.administration, identity?.builder, accountPending, accountUnavailable, roomActions.map(action => action.label)]);
    if (structure !== navStructure) {
      const items = [link('Join', homeUrl(origin), 'join')];
      if (!participant) {
        if (identity) {
          items.push(link('Present', caseWorkspaceUrl(workspaceId, 'published', origin), 'cases'));
          if(identity.builder)items.push(link('Create',caseWorkspaceUrl(workspaceId,'drafts',origin),'builder'));
          items.push(link('Sessions', historyUrl(origin), 'history'));
          if (identity.administration) items.push(link('Admin', adminPageUrl(origin), 'admin'));
        } else if (!accountPending && !accountUnavailable) items.push(link('Sign in', casesUrl(origin), 'cases'));
      }
      for (const [index, action] of roomActions.entries()) {
        const button = textNode(doc, 'button', action.label, 'site-nav-link'); button.type = 'button'; button.disabled = action.disabled === true;
        button.dataset.roomAction = String(index);
        button.addEventListener('click', () => { const current = roomActions[index]; if (current && current.disabled !== true) { close(); current.run(); } }); items.push(button);
      }
      nav.replaceChildren(...items); navStructure = structure;
    }
    for (const button of nav.querySelectorAll('[data-room-action]')) button.disabled = roomActions[Number(button.dataset.roomAction)].disabled === true;
    const accountValue = identity?.email ?? null;
    if (accountValue === accountStructure) return;
    accountStructure = accountValue; account.replaceChildren(); account.hidden = !identity;
    confirmation.hidden = true; footer.querySelector('.site-signout')?.remove();
    if (identity) {
      const profileLink = link('', accountUrl(origin), 'account'); profileLink.className = 'menu-button site-account-profile';
      profileLink.setAttribute('aria-label', 'Open account');
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M19 21v-2a7 7 0 0 0-14 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8'); svg.append(path); profileLink.replaceChildren(svg);
      const email=link(identity.email,accountUrl(origin),'account');email.classList.add('site-account-email');account.append(email, profileLink);
      const out = textNode(doc, 'button', 'Sign out', 'btn danger site-signout'); out.type = 'button';
      out.addEventListener('click', () => {
        confirmation.hidden = false;
        confirmText.textContent = signOutMessage?.() || 'Private information held by Case on this device will be cleared.';
        cancelOut.focus();
      });
      footer.append(out);
      cancelOut.onclick = () => { confirmation.hidden = true; out.focus(); };
    }
  }
  let issueEntry=null,issueVersion=0;
  function reportAccount(value){const auth=issueIdentityAuth(value),version=++issueVersion;if(issueEntry){issueEntry.setAccount(auth??null,value?.email??null);return;}if(participant||!auth)return;void import('./issue-entry.mjs').then(({attachIssueEntry})=>{if(removed||version!==issueVersion)return;issueEntry=attachIssueEntry(opener,{uiIcon,createSurfaceNotice});issueEntry.setAccount(auth,value.email);}).catch(()=>{});}
  function setAccount(value) {
    reportAccount(value);
    const next = !participant && typeof value?.email === 'string' && value.email.trim() && typeof value.signOut === 'function'
      ? { email: value.email, administration: value.administration === true, builder: value.builder === true, signOut: value.signOut } : null;
    if (!next || next.email !== identity?.email || next.administration !== identity?.administration || next.builder !== identity?.builder) generation++;
    accountPending = accountUnavailable = false; identity = next; render();
  }
  confirmOut.onclick = () => { const signOut = identity?.signOut; confirmation.hidden = true; close(); signOut?.(); };
  async function open() {
    if (removed || dialog.open) return;
    if(!participant&&!loadAccount){loadAccount=async()=>{if(!publicAccount){const {createMenuAccount}=await import('./menu-account.mjs');if(removed)return null;publicAccount=createMenuAccount(value=>{if(!removed){setAccount(value);notice.textContent='';}});}return publicAccount.load();};}
    accountUnavailable = false; accountPending = !identity && !participant && Boolean(loadAccount); render(); confirmation.hidden = true; settings.refresh(); notice.textContent = accountPending ? 'Checking account…' : '';
    if (profile) { privateControls.replaceChildren(); profile(privateControls); privateControls.hidden = !privateControls.childNodes.length; }
    dialog.showModal(); opener.setAttribute('aria-expanded', 'true');
    if (!participant && loadAccount) {
      const version = ++generation; notice.textContent = 'Checking account…';
      try {
        const value = await loadAccount(); if (removed || version !== generation) return;
        setAccount(value); notice.textContent = '';
      } catch {
        if (!removed && version === generation) {
          setAccount(null); accountUnavailable = true; render(); notice.textContent = 'Account information is unavailable. Close and reopen the menu to try again.';
        }
      }
    }
  }
  function close() { if (dialog.open) dialog.close(); }
  const click = () => dialog.open ? close() : void open(); opener.addEventListener('click', click);
  closeButton.addEventListener('click', close);
  let outside=false;const isOutside=event=>{const r=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',event=>outside=isOutside(event));dialog.addEventListener('pointerup',event=>{if(outside&&isOutside(event))close();outside=false;});
  dialog.addEventListener('close', () => { generation++; opener.setAttribute('aria-expanded', 'false'); if (opener.isConnected) opener.focus(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary')]
      .filter(item => item.getClientRects().length && (item.type !== 'radio' || item.checked));
    const first = items[0], last = items.at(-1); if (!first) return;
    if (event.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (doc.activeElement === last || !dialog.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
  });
  render();
  return { dialog, open, close, setAccount,setCurrent(value){if(current===value)return;current=value;navStructure=null;render();}, setRoomActions(actions) { roomActions = cleanActions(actions); render(); }, remove() {
    issueEntry?.remove();removed = true; generation++; musicNotice?.close();musicNotice=null;musicDialog?.close();musicDialog=null; close(); identity = null; roomActions = []; profile = null; loadAccount = null; beforeNavigate = null; signOutMessage = null; getWorkspace = null; confirmOut.onclick = cancelOut.onclick = null;
    opener.removeEventListener('click', click); publicAccount?.dispose();publicAccount=null;settings.dispose(); account.replaceChildren(); nav.replaceChildren();
    privateControls.replaceChildren(); notice.textContent = ''; dialog.replaceChildren(); dialog.remove();
  } };
}
