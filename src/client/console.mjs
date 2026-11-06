import {rememberIssueAuth,bindIssueIdentity} from './issue-auth-binding.mjs';
// The facilitator document (/cases): sign-in, the case catalogue (card 29, library.mjs) and the
// facilitator room lifetime. Room rendering and its capability stay in console-room.mjs, never in web
// storage or the URL. Shared-computer approval lives in the room's Room tab (CASE-166), not here.
import { mountAccount, accountRequest, node } from './auth-ui.mjs';
import { isUuidV7, normalizeCode } from '../shared/ids.mjs';
import { readSavedManualSegment, notesFromSaved, savedManualKey } from './console-manual-storage.mjs';
import * as roomOwnership from './console-ownership.mjs';
import { ACTIVE_ROOM_KEY } from './teardown.mjs';
import { casesUrl, caseVersionUrl, parseRoute, sessionUrl, localNotesObjectUrl, parseCaseWorkspace } from '../shared/urls.mjs';
import { consolePage } from './console-pages.mjs';
import { canEditCases, menuIdentity as accountIdentity } from './navigation-access.mjs';
import { mountSiteHeader } from './site-header.mjs';
const ADMIN_CSS='__ADMIN_SURFACE_CSS_URL__';
import { loadPrivateStyle } from './private-style.mjs';
import { isPlainNavigation } from './shared-menu.mjs';

export function mount({ magicCallback = null, mode = 'cases', requestedSessionId = null, requestedRecordId = null, invite = null } = {}) {
  let menuIdentity = null,menuWorkspace=null,library=null,stagedAdmin=null;
  const main = document.querySelector('main'); main.replaceChildren();
  main.classList.add('facilitator-console','private-ui');document.body.classList.add('private-shell');
  main.removeAttribute('aria-labelledby');
  const pageTitle = mode==='admin'?'Administration':mode === 'history' ? 'Sessions' : mode === 'account' ? 'Account' : parseCaseWorkspace(location.href).drafts ? 'Create' : 'Present';
  const header = mountSiteHeader(document.body, { context: pageTitle, loadAccount:loadMenuAccount,current: mode==='cases'&&parseCaseWorkspace(location.href).drafts?'builder':mode, getWorkspace: () => library?.workspaceId?.()??parseCaseWorkspace(location.href).workspaceId, beforeNavigate: navigatePrivate });
  const intro = node('div', null, 'facilitator-intro');
  // An invitation page (/i/#<ref>, CASE-341) signs in here, under its own heading, with the invited address filled in.
  const signInTitle = invite ? invite.heading : 'Sign in';
  intro.append(node('h1', signInTitle, 'case-catalog-heading'),
    node('p', invite ? invite.lead : 'Participants never need an account.', 'muted'));
  const catalog = node('section', null, 'case-catalog');
  const savedPanel = node('section', null, 'console-saved-notes');
  const status = node('p', null, 'case-catalog-status');
  status.setAttribute('role', 'status');
  const panel = node('div', null, 'auth-panel');panel.setAttribute('role','region');panel.setAttribute('aria-label','Account access');
  panel.append(intro, status); main.append(panel, savedPanel, catalog);
  let signedOut = false;
  const authSplash = () => import('./splash.mjs').then(c => c.setAuthSplash(main, signedOut)); // signed out: the brand braid behind one panel
  let roomIndex=0,restoringRoomPop=false;
  addEventListener('popstate',event=>{if(!activeRoom)return;if(restoringRoomPop){restoringRoomPop=false;return;}const nextIndex=Number.isSafeInteger(event.state?.caseLibraryIndex)?event.state.caseLibraryIndex:roomIndex-1;if(!activeRoom.beforeNavigate({kind:'history'})){restoringRoomPop=true;history.go(roomIndex-nextIndex||1);return;}location.assign(location.href);});
  let roomToken = null, generation = 0, activeRoom = null, hooks, signedInAuth = null, endedSummary = null;
  // Card 38: the browser asks "Leave site?" on Back, reload or close while a room is live.
  const leave = event => { event.preventDefault(); event.returnValue = ''; };
  const live = on => on ? addEventListener('beforeunload', leave) : removeEventListener('beforeunload', leave);
  function savedSegment() {
    const key = savedManualKey();
    return key ? { key, sessionId: key.slice('case-lab:segment:'.length),
      saved: readSavedManualSegment(key.slice('case-lab:segment:'.length)) } : null;
  }
  function downloadSavedNotes() {
    const entry = savedSegment();
    if (!entry?.saved) { savedPanel.replaceChildren(); return; }
    const blob = new Blob([notesFromSaved(entry.saved)], { type: 'text/plain;charset=utf-8' });
    const url = localNotesObjectUrl(blob);
    const anchor = node('a'); anchor.href = url; anchor.download = 'case-manual-notes.txt';
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function showSavedNotes() {
    savedPanel.replaceChildren();
    if (!savedSegment()?.saved) return;
    const download = node('button', 'Download saved manual notes', 'btn'); download.type = 'button';
    download.addEventListener('click', downloadSavedNotes);
    savedPanel.append(node('h2', 'Saved manual notes'),
      node('p', 'Notes stay on this tab. Reconnecting to the room needs a fresh sign-in and ownership check.'), download);
  }
  if (!['history','account'].includes(mode)) showSavedNotes();
  async function openRoom(auth, room, restoredSaved = null, stillCurrent = () => true, projectorWindow = null) {
    if (!isUuidV7(room?.sessionId) || normalizeCode(room?.joinCode, 6) !== room.joinCode ||
        typeof room.facilitatorToken !== 'string' || !room.facilitatorToken) throw new Error('invalid_room');
    const selected = parseRoute(location.pathname);
    const remembered = history.state?.caseReturn;
    const returnCase = selected?.route === 'case-version'
      ? { caseId: selected.caseId, versionNo: selected.versionNo }
      : isUuidV7(remembered?.caseId) && Number.isSafeInteger(remembered?.versionNo) && remembered.versionNo > 0
        ? { caseId: remembered.caseId, versionNo: remembered.versionNo } : null;
    const returnUrl = returnCase ? caseVersionUrl(returnCase.caseId, returnCase.versionNo, location.origin) : casesUrl(location.origin);
    try {
      const { mountConsoleRoom } = await import('./console-room.mjs');
      if (!stillCurrent()) return false;
      roomToken = room.facilitatorToken;
      if (activeRoom) roomOwnership.releaseRoom();
      activeRoom?.close();
      activeRoom = null;
      main.classList.remove('room-active'); document.body.classList.remove('room-active');
      activeRoom = mountConsoleRoom(catalog, { auth, sessionId: room.sessionId,
        joinCode: room.joinCode, facilitatorToken: roomToken, restoredSaved, projectorWindow, onSignOut:()=>account.signOut.click(),
        onLeave: ({preserveResume=false}={}) => { live(false); roomOwnership.releaseRoom(); activeRoom = null; roomToken = null; if(!preserveResume)try{sessionStorage.removeItem(ACTIVE_ROOM_KEY);}catch{} },
        onEnded({ localOnly = false, reason = null, ended = null, fromDebrief = false, title = null } = {}) {
          // Card 38: room end clears room state only; the facilitator stays signed in, back in the library.
          live(false); roomOwnership.releaseRoom(); activeRoom = null;
          history.replaceState(null, '', returnUrl);
          main.classList.remove('room-active'); document.body.classList.remove('room-active');
          const endedGeneration = generation;
          void auth.teardown('room_end').then(async () => {
            if (endedGeneration !== generation) return;
            // Card 40 slice 6: an ended room first shows its summary; Back to cases returns to the library.
            if (ended) {
              const { mountEndedSummary } = await import('./ended-summary.mjs');
              if (endedGeneration !== generation) return;
              endedSummary = mountEndedSummary(catalog, { ...ended, auth, onBack: () => { endedSummary = null; if (endedGeneration === generation) void hooks.onSignedIn(auth, ''); } });
              return;
            }
            // Console layout v2: ended from Debrief, the review already happened; the record is in History.
            if (fromDebrief) return hooks.onSignedIn(auth, `${title ? `${title}: ` : ''}session ended. Its debrief and feedback are in Sessions.`);
            return hooks.onSignedIn(auth, reason === 'access_lost'
              ? 'Console access ended. The room may still be running.'
              : localOnly ? 'Local presentation ended. Check the server room is closed when online.' : '');
          }).catch(() => { if (endedGeneration === generation && !endedSummary) void hooks.onSignedIn(auth, ''); });
        } });
      // Invalidate catalog requests only after the local mount has succeeded.
      // A failed prerequisite leaves the Start action and its error recoverable.
      generation++; library?.close(); library = null;
      main.classList.add('room-active'); document.body.classList.add('room-active');
      try { sessionStorage.setItem(ACTIVE_ROOM_KEY, room.sessionId); } catch {}
      void roomOwnership.holdRoom(room.sessionId);
      live(true);
      // Only public case/version identifiers enter history state; no case content or capability.
      roomIndex=Number.isSafeInteger(history.state?.caseLibraryIndex)?history.state.caseLibraryIndex:0;
      history.replaceState({ privateNavigationIndex:history.state?.privateNavigationIndex??0,caseLibraryIndex:roomIndex,caseReturn: returnCase, ownedSessionId: room.sessionId }, '', sessionUrl(room.sessionId, 'facilitate', location.origin));
      savedPanel.replaceChildren();
      status.textContent = 'Room ready';
      return true;
    } catch (error) { if (stillCurrent()) roomOwnership.releaseRoom(); throw error; }
    finally { roomToken = null; }
  }
  function rememberMenuWorkspaces(rows){const row=rows.find(item=>['admin','owner','author'].includes(item.role));if(row)menuWorkspace=row.workspace_id;}
  async function loadMenuAccount(){
    const owner=signedInAuth,token=owner?.accessToken(),version=generation;
    if(!token)return null;
    const current=()=>owner===signedInAuth&&owner.accessToken()===token&&version===generation;
    try{
      const me=await accountRequest(owner,['me'],{query:new URLSearchParams({limit:'20'})});
      if(!current())return null;
      const workspaceId=menuWorkspace;
      if(workspaceId&&!canEditCases(me)){
        const scoped=await accountRequest(owner,['me'],{query:new URLSearchParams({workspaceId,limit:'20'})});
        if(!current())return null;
        const rows=consolePage('memberships',scoped,null).rows.filter(row=>row.workspace_id===workspaceId);menuWorkspace=null;rememberMenuWorkspaces(rows);me.memberships=[...(me.memberships??[]),...rows];
      }
      return menuIdentity=accountIdentity(me,()=>account.signOut.click());
    }catch(error){if(current())menuIdentity=null;throw error;}
  }
  function accountAccessRetry() {
    library?.close();library=null;header.setAccount(null);catalog.replaceChildren();
    const retry=node('button','Retry account access','btn');retry.type='button';
    const retryAuth=signedInAuth;retry.onclick=()=>{if(retryAuth===signedInAuth)void hooks.onSignedIn(retryAuth);};catalog.append(retry);
    status.textContent='Account access could not be checked. Retry to reload current workspaces.';
  }
  // CASE-336: a person who holds cases alone (grants, no membership) still has workspaces to read their own records in,
  // and the Builder for any case they may edit.
  function grantWorkspaces(rows, grants) {
    const known = new Set(rows.map(row => row.workspace_id)), extra = [];
    for (const grant of Array.isArray(grants) ? grants : []) {
      if (!isUuidV7(grant?.workspace_id) || known.has(grant.workspace_id)) continue;
      known.add(grant.workspace_id); extra.push({ workspace_id: grant.workspace_id, name: typeof grant.workspace_name === 'string' ? grant.workspace_name : 'Workspace', role: 'case access' });
    }
    return [...rows, ...extra];
  }
  function addWorkspacePages(after) {
    if(!after)return;const version=generation;
    const more=node('button','More workspaces','btn tertiary library-more-workspaces');more.type='button';catalog.append(more);
    more.onclick=async()=>{more.disabled=true;try{
      const next=await accountRequest(signedInAuth,['me'],{query:new URLSearchParams({limit:'20',after})});
      if(version!==generation)return;const page=consolePage('memberships',next,after);
      rememberMenuWorkspaces(page.rows);library?.addMemberships(page.rows);if(menuIdentity&&page.rows.some(m=>['owner','author'].includes(m.role)))header.setAccount(menuIdentity=bindIssueIdentity({...menuIdentity,builder:true},menuIdentity));more.remove();addWorkspacePages(page.nextAfter);
    }catch{if(version===generation){if(mode==='history'||mode==='account'){accountAccessRetry();}else{status.textContent='The next workspaces could not be loaded. Try again.';more.disabled=false;}}}};
  }
  async function loadPrivate(auth,notice='',{retain=false}={}){
      const ticket=++navigationEpoch;stagedAdmin?.close();stagedAdmin=null;let current=retain?generation:++generation; signedInAuth=auth;let swapped=!retain;
      const isCurrent=()=>current===generation&&ticket===navigationEpoch;
      const swap=()=>{if(!swapped){library?.close();library=null;catalog.replaceChildren();current=++generation;swapped=true;}surfaceMode=mode;catalog.inert=false;catalog.removeAttribute('aria-busy');main.classList.remove('private-loading');status.classList.remove('sr-only');};
      endedSummary?.close(); endedSummary = null;
      let rejoinCurrent = true;
      // A magic-link callback lands on the root; the catalogue's own address is /cases.
      if (location.pathname === '/' || /^\/i\/?$/.test(location.pathname)) history.replaceState(null, '', casesUrl(location.origin));
      main.classList.add('signed-in');
      if(!retain){library?.close();library=null;catalog.replaceChildren();}else{catalog.inert=true;catalog.setAttribute('aria-busy','true');main.classList.add('private-loading');status.classList.add('sr-only');}
      status.textContent='Loading '+(mode==='history'?'sessions':mode==='account'?'account':mode==='admin'?'administration':'cases')+'…';
      try {
        const me = await accountRequest(auth, ['me'], { query: new URLSearchParams({ limit: '20' }) });
        if (!isCurrent()) return;
        if (invite?.email && me.account?.email?.toLowerCase() !== invite.email.toLowerCase())
          notice = 'This invitation is for a different email address. Sign out and use the invited address to join.';
        const firstMembershipPage = consolePage('memberships', me, null);
        const requestedWorkspace = mode !== 'account' ? parseCaseWorkspace(location.href).workspaceId : null;
        if (requestedWorkspace && !firstMembershipPage.rows.some(row => row.workspace_id === requestedWorkspace)) {
          const scoped = await accountRequest(auth, ['me'], { query: new URLSearchParams({ limit: '20', workspaceId: requestedWorkspace }) });
          if (!isCurrent()) return;
          const exact = consolePage('memberships', scoped, null).rows.filter(row => row.workspace_id === requestedWorkspace);
          firstMembershipPage.rows = [...firstMembershipPage.rows, ...exact];
        }
        rememberMenuWorkspaces(firstMembershipPage.rows);header.setAccount(menuIdentity = accountIdentity(rememberIssueAuth({...me,memberships:firstMembershipPage.rows},auth),()=>account.signOut.click()));
        account.status.textContent = '';
        // The first-sign-in step (Julian, 2026-10-18): Name & role before anything else, for every account, admins included,
        // that has not confirmed them. null (a database without the label migration) never gates.
        if (me.profile?.labelConfirmed === false) {
          status.textContent = ''; header.setBreadcrumbs([{ label: 'Your name and role' }]);
          const { mountLabelStep } = await import('./facilitator-label-form.mjs');
          if (!isCurrent()) return;
          swap();const saved = await mountLabelStep(catalog, { auth, profile: me.profile, current: () => current === generation });
          if (!saved || !isCurrent()) return;
          me.profile = saved;
        }
        // CASE-339: /me accepted this person's invitations; the first-sign-in landing says what is new and opens the case.
        if (mode === 'cases' && Array.isArray(me.joined) && me.joined.length) {
          status.textContent = ''; header.setBreadcrumbs([{ label: 'Welcome to Case' }]);
          const { mountJoinedLanding } = await import('./invite-landing.mjs');
          if (!isCurrent()) return;
          swap();await mountJoinedLanding(catalog, me.joined, { current: () => current === generation });
          if (!isCurrent()) return;
          header.setBreadcrumbs([{ label: pageTitle }]);
        }
        if(mode==='admin'){
          savedPanel.replaceChildren();status.textContent='Loading administration…';
          const [{mountAdminSurface}]=await Promise.all([import('./admin.mjs'),loadPrivateStyle(new URL(ADMIN_CSS==='__ADMIN_SURFACE_CSS_URL__'?'/src/client/admin.css':ADMIN_CSS,location.origin).href)]);if(!isCurrent())return;
          const stage=node('div');let attached=false;const control=mountAdminSurface(stage,{auth,me,header:{...header,setAccount:value=>{if(attached&&isCurrent())header.setAccount(value);},setBreadcrumbs:value=>{if(attached&&isCurrent())privateContext(value);}},signOut:()=>account.signOut.click()});stagedAdmin=control;await control.ready;if(!isCurrent()){control.close();if(stagedAdmin===control)stagedAdmin=null;return;}stagedAdmin=null;swap();status.textContent='';attached=true;catalog.append(stage);library=control;control.reveal();return;
        }
        if (mode === 'history' || mode === 'account') {
          // Summary/account documents never check, claim or mint a live-room console.
          savedPanel.replaceChildren();status.textContent = '';
          if(mode==='account'){
            const {mountAccountPage}=await import('./account-page.mjs');if(!isCurrent())return;
            swap();library=mountAccountPage(catalog,{auth,me,memberships:firstMembershipPage.rows,current:()=>current===generation,onContext:privateContext,onNavigate:href=>resumeNavigation({href,kind:'discard-navigation'})});
            addWorkspacePages(firstMembershipPage.nextAfter);return;
          }
          const { mountPortfolio } = await import('./portfolio-page.mjs');
          if (!isCurrent()) return;
          swap();library = mountPortfolio(catalog, { auth, me, mode, requestedRecordId, memberships: grantWorkspaces(firstMembershipPage.rows, me.grants), current: () => current === generation, onContext:privateContext });
          addWorkspacePages(firstMembershipPage.nextAfter);return;
        }
        // Same-tab recovery keeps priority. A fresh visit can browse while its own rooms are checked.
        const saved = savedSegment();
        let fresh = !activeRoom && !saved?.saved && requestedSessionId === null;
        try { fresh &&= sessionStorage.getItem(ACTIVE_ROOM_KEY) === null; } catch { fresh = false; }
        const canRejoin = () => isCurrent() && rejoinCurrent;
        const checkRooms = async () => {
          try {
            const chunk = await import('./account-session.mjs');
            if (!canRejoin()) return;
            await chunk.offerRejoin({ ownership: roomOwnership, panel: savedPanel, status, saved, requestedSessionId,
              resumeRequestedSession: globalThis.history?.state?.ownedSessionId === requestedSessionId,
              request: (parts, options) => accountRequest(auth, parts, options),
              open: (room, restored) => canRejoin() ? openRoom(auth, room, restored, canRejoin) : false, current: canRejoin });
          } catch { if (canRejoin()) status.textContent = 'Active sessions could not be checked.'; }
        };
        if (fresh) void checkRooms(); else await checkRooms();
        if (!isCurrent()) return;
        status.textContent = notice || (firstMembershipPage.rows.length || (Array.isArray(me.grants) && me.grants.length) ? '' : 'No workspaces are assigned to this account.');
        // The catalogue is its own chunk (CASE-166), loaded once signed in.
        const { mountLibrary } = await import('./library.mjs');
        if (!isCurrent()) return;
        swap();library = mountLibrary(catalog, { auth, me: { memberships: firstMembershipPage.rows, grants: Array.isArray(me.grants) ? me.grants : [], profile: me.profile ?? null },
          onContext:privateContext,onNavigate:href=>resumeNavigation({href,kind:'discard-navigation'}),
          async onStart({ workspaceId, versionId, facilitator = null, projectorWindow = null }) {
            // Fence the pending owner check at the press, before a held room-creation response.
            rejoinCurrent = false;
            savedPanel.querySelector('.console-rejoin')?.remove();
            const room = await accountRequest(auth, ['sessions'], { method: 'POST', body: {
              workspaceId, caseVersionId: versionId, ttlMinutes: 60, ...(facilitator ? { facilitator } : {}),
            } });
            if (!isCurrent()) return false;
            try{return await openRoom(auth, room, null, () => current === generation, projectorWindow);}
            catch{throw Object.assign(new Error('console_mount_failed'),{sessionCreated:true});}
          } });
        // One page per click: workspaces are never auto-looped (console-pages.mjs).
        addWorkspacePages(firstMembershipPage.nextAfter);
      } catch {if(isCurrent()){swap();if(mode==='history'||mode==='account'||mode==='admin')accountAccessRetry();else status.textContent='Published cases are unavailable. Try again.';}}
  }
  let navigationEpoch=0,surfaceMode=mode,privateUrl=location.href,privateIndex=Number.isSafeInteger(history.state?.privateNavigationIndex)?history.state.privateNavigationIndex:0,restoringPrivate=false;
  history.replaceState({...history.state,privateNavigationIndex:privateIndex},'',location.href);
  function privateDestination(href){try{const url=new URL(href,location.origin),route=parseRoute(url.href);if(url.origin!==location.origin||!['cases','case','case-version','history','session-record','account','admin'].includes(route?.route))return null;return{url,mode:route.route==='admin'?'admin':route.route==='account'?'account':['history','session-record'].includes(route.route)?'history':'cases',record:route.route==='session-record'?route.sessionId:null};}catch{return null;}}
  function privateContext(value){const items=Array.isArray(value)?value:[{label:value}];header.setBreadcrumbs(items);header.setCurrent(mode==='admin'?'admin':mode==='history'?'history':mode==='account'?'account':items[0]?.label==='Create'?'builder':'cases');privateUrl=location.href;if(Number.isSafeInteger(history.state?.privateNavigationIndex))privateIndex=history.state.privateNavigationIndex;}
  function resumeNavigation(action){if(navigatePrivate(action)===true)location.assign(action.href);}
  function navigatePrivate(action){
    if(library?.beforeNavigate?.({...action,resume:()=>resumeNavigation(action)})===false)return false;const target=privateDestination(action?.href);
    if(!target||!signedInAuth||activeRoom||requestedSessionId)return true;
    document.querySelector('dialog.site-menu[open]')?.close();if(target.url.href===location.href&&!library?.hasGroupScreen?.())return false;
    history.pushState({privateNavigationIndex:++privateIndex},'',target.url.href);privateUrl=target.url.href;mode=target.mode;requestedRecordId=target.record;void loadPrivate(signedInAuth,'',{retain:true});return false;
  }
  const privateClick=event=>{const link=event.target.closest?.('a[href]');if(link&&isPlainNavigation(event)&&navigatePrivate({href:link.href,kind:'navigation'})===false)event.preventDefault();};main.addEventListener('click',privateClick);
  const privatePop=event=>{
    if(restoringPrivate){restoringPrivate=false;event.stopImmediatePropagation();return;}
    const target=privateDestination(location.href);if(!target||!signedInAuth||activeRoom||requestedSessionId)return;
    if(['cases','history'].includes(surfaceMode)&&surfaceMode===target.mode)return;
    event.stopImmediatePropagation();const next=Number.isSafeInteger(event.state?.privateNavigationIndex)?event.state.privateNavigationIndex:privateIndex;
    const destination=location.href;if(library?.beforeNavigate?.({href:destination,kind:'navigation',resume:()=>resumeNavigation({href:destination,kind:'discard-navigation'})})===false){const delta=privateIndex-next;if(delta){restoringPrivate=true;history.go(delta);}else history.replaceState(history.state,'',privateUrl);return;}
    privateIndex=next;privateUrl=location.href;mode=target.mode;requestedRecordId=target.record;void loadPrivate(signedInAuth,'',{retain:true});
  };addEventListener('popstate',privatePop);addEventListener('pagehide',()=>{removeEventListener('popstate',privatePop);main.removeEventListener('click',privateClick);},{once:true});
  const account = mountAccount(main, hooks = { magicCallback, idleText: invite ? 'We fill in your invited address; we email you a 6-digit code.' : 'Sign in to run and manage cases.',
    prefillEmail: invite?.email ?? null,
    onStateChange(value) {
      signedOut = value === 'signed-out';
      intro.firstChild.textContent = signedOut ? signInTitle : pageTitle;
      intro.firstChild.classList.toggle('sr-only', !signedOut);
      intro.lastChild.hidden = !signedOut;
      if (value !== 'signed-in') header.setBreadcrumbs([{ label: intro.firstChild.textContent }]);
      if (signedOut || main.classList.contains('auth-splash')) void authSplash();
    },
    preserveSessionKeys: () => {
      const key = savedManualKey();
      return key ? [key] : [];
    },
    onSignedOut(reason) {
      stagedAdmin?.close();stagedAdmin=null;navigationEpoch++;catalog.inert=false;catalog.removeAttribute('aria-busy');main.classList.remove('private-loading');status.classList.remove('sr-only');generation++; menuIdentity = null; menuWorkspace=null;signedInAuth = null; roomToken = null; live(false); roomOwnership.releaseRoom();
      if (location.pathname.startsWith('/sessions/')) history.replaceState(null, '', casesUrl(location.origin));
      main.classList.remove('room-active', 'signed-in'); document.body.classList.remove('room-active');
      activeRoom?.close({ preserveSegment: reason === 'pagehide' }); activeRoom = null; endedSummary?.close(); endedSummary = null;
      library?.close(); library = null; header.setAccount(null);
      catalog.replaceChildren(); savedPanel.replaceChildren();
      status.textContent = '';
    },
    onSignedIn:(auth,notice)=>loadPrivate(auth,notice),
  });
  const form = main.querySelector('form.auth-form');
  if (form) panel.insertBefore(form, status);
  if (form && invite) {
    const other = node('p', 'Not you? ', 'muted invite-other'), link = node('a', 'Sign in with a different email');
    link.href = casesUrl(location.origin); other.append(link); form.after(other);
    const hide = () => { other.hidden = form.classList.contains('is-signed-in'); };
    new MutationObserver(hide).observe(form, { attributes: true, attributeFilter: ['class'] }); hide();
  }
}
