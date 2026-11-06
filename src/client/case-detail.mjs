import {loadFeedbackStyle} from './feedback-style.mjs';
import { decorateTools } from './ui-icons.mjs';
// Case detail (card 29, CASE-166): cover, summary, learning objectives, audience, setting, version and the
// configured pilot pin, then Start room. Start room keeps its authority and flow: the Worker rechecks membership and
// the published document, and the room opens at its lobby, where the display check lives.
import { accountRequest, node } from './auth-ui.mjs';
import { createInspector } from './run-preview-window.mjs';
import { isUuidV7, uuidv7 } from '../shared/ids.mjs';
import { validCatalogueRow, validVersionList } from '../shared/catalogue.mjs';
import { validCaseGroup, UNGROUPED } from '../shared/groups.mjs';
import { paintCovers, clearCoverCache } from './cover-art.mjs';
import { watchTheme } from './appearance-watch.mjs';
import { lengthText, fieldText } from './library-model.mjs';
import { coverFor, pilotTag, formatDate } from './library-parts.mjs';
import { uiIcon } from './ui-icons.mjs';
import { guardDialog } from './dialog-behaviour.mjs';
import { disclosure } from './surface-controls.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
import { sessionsUrl, casesUrl } from '../shared/urls.mjs';
import { labelFields } from './facilitator-label-form.mjs';

const ROW_KEYS = ['version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'version_no',
  'published_at', 'content_sha256', 'art'];
export function catalogueCase(value, caseId, versionNo) {
  const item = value?.case;
  // Card 30: the case's group arrives beside the row; the cover takes its tint.
  const group = item?.group, editions = item?.edition_version_ids ?? [];
  const row = item && validCaseGroup(group) && { ...Object.fromEntries(ROW_KEYS.map(key => [key, item[key]])),
    group_id: group.id, group_name: group.name, tint: group.tint };
  if (!row || !validCatalogueRow(row) || row.case_id !== caseId || row.version_no !== versionNo || !isUuidV7(item.workspace_id) ||
      !['owner', 'author', 'facilitator', 'admin'].includes(item.role) || !Array.isArray(item.learning_objectives) ||
      item.learning_objectives.length > 8 || item.learning_objectives.some(o => typeof o !== 'string') ||
      !validVersionList(item.versions) || !item.versions.some(v => v.version_id === row.version_id) ||
      !Array.isArray(editions) || editions.length > 50 || new Set(editions).size !== editions.length ||
      editions.some(id => !isUuidV7(id) || !item.versions.some(version => version.version_id === id)))
    throw new Error('invalid_case');
  // CASE-336: what the caller may offer in Share (null: no Share for them) and whether they hold the case alone.
  const share = item.share ?? null;
  if (share !== null && !(share && typeof share === 'object' && Array.isArray(share.levels) && share.levels.length >= 1 && share.levels.length <= 2 &&
      share.levels.every((level, index) => level === ['run', 'edit'][index]) && ['workspaceWide', 'manageInvitations', 'revoke'].every(key => typeof share[key] === 'boolean')))
    throw new Error('invalid_case');
  return { row, workspaceId: item.workspace_id, role: item.role, scope: item.scope === 'case' ? 'case' : 'workspace', share, group, objectives: item.learning_objectives, versions: item.versions.map(version => ({ ...version, edition: editions.includes(version.version_id) })),
    pilotPin: value.pilotPin ?? null };
}

export function mountCaseDetail(host, { auth, caseId, versionNo, browse = null, profile = null, workspaceName = () => null, onBack, onStart, onEdit = () => {}, onGroupChanged = () => {}, onGroupConflict = () => {}, onContext = () => {}, onReady = () => {} }) {
  const notices=createSurfaceNotice();let historyGuard=null,titleObserver=null,metadataDialog=null,metadataGuard=null,metadataController=null;
  let launch=null,launchGuard=null,launchOpener=null,clearSessionProfile=()=>{};
  function clearLaunch(restore=false){const modal=launch,opener=launchOpener;launch=null;launchOpener=null;modal?.close();launchGuard?.dispose();launchGuard=null;modal?.remove();if(restore&&opener?.isConnected&&!opener.disabled)opener.focus();}
  let creating=false;let closed = false, covers = [], picker = null, preview = null, feedbackPanel = null, sharing = null;
  function clearMetadata(restore=false){const dialog=metadataDialog,opener=dialog?._opener;metadataDialog=null;metadataGuard?.dispose();metadataGuard=null;metadataController?.close();metadataController=null;picker=null;feedbackPanel=null;dialog?.close();dialog?.remove();if(restore&&opener?.isConnected)opener.focus();}
  function openMetadata(title,opener,{wide=false}={}){
    if(closed||metadataDialog)return null;const dialog=node('dialog',null,'computer-dialog case-information-dialog'+(wide?' case-feedback-dialog':''));dialog.setAttribute('aria-label',title);dialog._opener=opener;
    const head=node('div',null,'case-information-head'),close=node('button',null,'btn quiet icon-button');close.type='button';close.setAttribute('aria-label','Close '+title.toLowerCase());close.append(uiIcon('x'));head.append(node('h2',title),close);
    const body=node('div',null,'case-information-body');body.tabIndex=0;body.setAttribute('role','region');body.setAttribute('aria-label',title+' details');const footer=node('div',null,'case-information-foot');dialog.append(head,body,footer);root.append(dialog);metadataDialog=dialog;
    metadataGuard=guardDialog(dialog,{dirty:()=>metadataController?.hasUnsaved?.()??false,pending:()=>metadataController?.pending?.()??false,onClose:()=>clearMetadata(true),opener:()=>opener});close.onclick=()=>metadataGuard?.requestClose();
    dialog.showModal();close.focus();return{dialog,body,footer,close:()=>metadataGuard?.requestClose(),current:()=>!closed&&metadataDialog===dialog};
  }
  // The Run preview (CASE-226) is disposable memory in its own window: leaving the case closes it without asking.
  function clearPreview() { preview?.close(); preview = null; }
  const root = node('article', null, 'case-detail'); root.setAttribute('aria-labelledby', 'caseDetailTitle');
  const status = node('p', 'Loading case…', 'case-detail-status'); status.setAttribute('role', 'status');
  root.append(status);
  host.append(root);
  const stopTheme = watchTheme(() => { clearCoverCache(); void paintCovers(covers, { cssSize: 400 }); });

  void (async () => {
    try {
      const value = await accountRequest(auth, ['cases', caseId, 'versions', String(versionNo)]);
      if (closed) return;
      let { row, workspaceId, role, scope, share, group, objectives, versions, pilotPin } = catalogueCase(value, caseId, versionNo);
      onContext(row.title, false, workspaceId);
      const layout = node('div', null, 'case-detail-layout studio-detail');
      const browseBar=node('nav',null,'case-browse');browseBar.setAttribute('aria-label','Browse cases');const back=node('button','← Present','btn quiet');back.type='button';back.onclick=onBack;browseBar.append(back);if(browse){const controls=node('div',null,'case-browse-actions');controls.append(node('span',`${browse.index+1} of ${browse.total}${browse.complete?'':' loaded cases'}`));for(const [label,run]of [['Previous',browse.previous],['Next',browse.next]]){const b=node('button',label,'btn quiet');b.type='button';b.disabled=!run;b.onclick=run;controls.append(b);}browseBar.append(controls);}root.append(browseBar);decorateTools(root);
      const cover = coverFor(row, covers = [], 'cover large', { full: true });
      const info = node('section', null, 'case-identity');if(row.title.length>75)info.classList.add('long-title');
      const heading = node('h1', row.title); heading.id = 'caseDetailTitle'; heading.tabIndex = -1;
      const groupFact=node('span',group.name??UNGROUPED,'tag');
      const summary = node('p', fieldText(row.summary, 'summary'), 'case-detail-summary');
      const learning = node('section', null, 'case-objectives');
      learning.append(node('h3', 'Learning objectives'));
      if (objectives.length) { const list = node('ul'); for (const item of objectives) list.append(node('li', item)); learning.append(list); }
      else learning.append(node('p', 'Learning objectives not set'));
      const pin = pilotTag(row, pilotPin);
      if (pin) pin.id = `pilot-pin-${row.version_id}`;
      const start = node('button', 'Present', 'btn primary'); start.type = 'button';
      const recover=node('a','Check active sessions','btn tint');recover.href=casesUrl(location.origin);recover.hidden=true;recover.prepend(uiIcon('rotate-ccw-clock'));
      if (pin) start.setAttribute('aria-describedby', pin.id);
      // "Facilitator on record (this session)" (Julian, 2026-10-18): the participant record names the profile's Name & role
      // unless they are changed here, and a change applies to this one room; Account keeps its own.
      const own = profile?.labelConfirmed === true && profile.displayName && profile.role ? { name: profile.displayName, role: profile.role } : null;
      const recordFields=labelFields({...own,legend:'Session profile',hint:'For this session only. Your Account keeps its own name and role.'});clearSessionProfile=()=>recordFields.set({});
      const override = () => {
        if (!own&&!recordFields.value().name&&!recordFields.value().role) return {ok:true,value:null};
        if (!recordFields.validate()) return { ok: false };
        const value = recordFields.value();
        return { ok: true, value: own && value.name === own.name && value.role === own.role ? null : value };
      };
      const presentCase = async facilitator => {
        if (closed || start.disabled) return;
        creating=true;start.disabled = true; start.setAttribute('aria-busy','true');notices.notify('Preparing session…');
        // Start room opens the projector window in this same click (Julian, 2026-10-18), before anything is awaited, so
        // the browser counts it as the press's own window; the console sends it to the room once the room exists. A
        // blocked pop-up gives null, and the console's Projector card offers Open projector instead.
        let projector = null;
        try { projector = window.open('about:blank', `case-projector-${uuidv7()}`); } catch { /* blocked */ }
        try { if (projector) projector.opener = null; } catch { /* already detached */ }
        try { if (await onStart({ workspaceId, versionId: row.version_id, facilitator: facilitator.value, projectorWindow: projector }) === false) try { projector?.close(); } catch {} }
        catch (error) { start.dataset.uncertain=String(error?.sessionCreated===true||!error?.status||error.status>=500);try { projector?.close(); } catch {} if (!closed) notices.notify(error?.sessionCreated?'The session was created, but this console could not open. Check active sessions to reopen its Lobby.':start.dataset.uncertain==='true'?'Session setup could not be confirmed. Check active sessions before trying again.':'The session was not created. Try again.',{error:true}); }
        finally { creating=false;if (!closed) { start.removeAttribute('aria-busy');start.disabled = start.dataset.uncertain==='true';recover.hidden=start.dataset.uncertain!=='true'; } }
      };
      function confirmLaunch(kind,accept){
        if(closed||launch||creating||kind==='Present'&&start.disabled)return;
        launchOpener=document.activeElement;launch=node('dialog',null,'computer-dialog case-launch');launch.setAttribute('aria-label',kind+' case');
        const form=node('form'),title=node('h2',kind+' case'),context=node('p',row.title,'muted'),actions=node('div',null,'dialog-actions'),cancel=node('button','Cancel','btn quiet'),confirm=node('button',kind,'btn primary');cancel.type='button';confirm.type='submit';
        const initial=recordFields.value();form.append(title,context);
        if(kind==='Present'){if(pin){const warning=pin.cloneNode(true);warning.id='launch-'+pin.id;form.append(warning);confirm.setAttribute('aria-describedby',warning.id);}form.append(recordFields.root);}else form.append(node('p','Practice privately. No live session is created.'));
        actions.append(cancel,confirm);form.append(actions);launch.append(form);root.append(launch);
        launchGuard=guardDialog(launch,{dirty:()=>kind==='Present'&&JSON.stringify(recordFields.value())!==JSON.stringify(initial),onClose:()=>{recordFields.set(initial);clearLaunch(true);}});
        cancel.onclick=()=>launchGuard?.requestClose();form.onsubmit=event=>{event.preventDefault();const facilitator=kind==='Present'?override():{ok:true};if(!facilitator.ok)return;clearLaunch();accept(facilitator);};
        launch.showModal();if(kind==='Present')recordFields.inputs[0].focus();else cancel.focus();
      }
      start.addEventListener('click',()=>confirmLaunch('Present',presentCase));
      const actions = node('div', null, 'case-start'), buttons = node('div', null, 'case-actions');
      let edit;
      const canEdit = ['owner', 'author', 'admin'].includes(role);
      if (canEdit) {
        edit = node('button', 'Edit case', 'btn tertiary'); edit.type = 'button';
        edit.addEventListener('click', () => onEdit({ caseId, workspaceId, versionId: row.version_id, versionNo: row.version_no }));
      }
      // Preview runs this published version in the Run preview window (CASE-226), the Builder's own surface: opened in
      // the click, then the pack is fetched; pop-ups blocked shows the same surface inline below.
      const previewButton = node('button', 'Preview', 'btn tint'); previewButton.type = 'button';
      const previewSlot = node('section', null, 'builder-inline-preview'); previewSlot.setAttribute('aria-label', 'Preview shown here'); previewSlot.hidden = true;
      const previewHead = node('div', null, 'builder-inline-preview-head'), previewFrameHost = node('div', null, 'builder-inline-preview-host'), closeInline = node('button', 'Leave preview', 'btn quiet'); closeInline.type = 'button';
      previewHead.append(node('p', 'Pop-ups are blocked for this site, so the Preview is shown here.'), closeInline);
      previewSlot.append(previewHead, previewFrameHost); root.append(previewSlot);
      let inline = null, pack = null, previewTarget = row;
      closeInline.addEventListener('click', () => { inline?.close(); inline = null; previewSlot.hidden = true; previewButton.focus({ preventScroll: true }); });
      // The P-21 pack read (CASE-193), shared by Preview and the briefing.
      const readPack = target => accountRequest(auth, ['workspaces', workspaceId, 'versions', target.version_id, 'pack'], { maxResponseBytes: 1_048_576 }).then(value => {
        if (value?.versionId !== target.version_id || value?.workspaceId !== workspaceId || !value?.document) throw Error('invalid_pack');
        return value.document;
      });
      const loadPack = async () => {
        if (pack) return;
        const target = previewTarget, inspector = preview;
        pack = readPack(target);
        try { const document = await pack; if (!closed && preview === inspector) preview?.update({ document, metadata: { metadata_version: 1 }, selection: {}, dirty: false }); }
        catch { if (!closed && preview === inspector) { pack = null; clearPreview(); notices.notify('This published update is unavailable. Reload its details and try Preview again.',{error:true}); } }
      };
      const runPreview = target => {
        if (closed) return;
        if (previewTarget.version_id !== target.version_id) { clearPreview(); inline?.close(); inline = null; previewSlot.hidden = true; pack = null; }
        previewTarget = target;
        if (!preview) pack = null;
        preview ??= createInspector({ ownerWindow: window, sourceDocument: document, auth, isCurrent: () => !closed,
          options: { validate: 'published', label: `Published ${formatDate(target.published_at)}` },
          onNotice: message => { notices.notify(message); }, onFailed: message => { notices.notify(message,{error:true}); } });
        if (!preview.open()) {
          inline?.close(); inline = preview.openInline(previewFrameHost, { onClosed: () => { inline = null; previewSlot.hidden = true; } }); previewSlot.hidden = false;
          notices.notify('The preview window was blocked, so the preview is shown below. Allow pop-ups for this site to open it in a window.');
        }
        void loadPack();
      };
      const previewVersion = target => confirmLaunch('Preview',()=>runPreview(target));
      previewButton.addEventListener('click', () => previewVersion(row));
      // Card 40a: the facilitator briefing of this version, from a fresh pack read that is dropped once printed or saved.
      const briefing = node('div', null, 'case-briefing'), briefingButtons = [];
      for (const [kind, label] of [['pdf', 'Download briefing (PDF)'], ['print', 'Print briefing']]) {
        const b = node('button', label, 'btn quiet'); b.type = 'button'; briefingButtons.push(b); briefing.append(b);
        b.addEventListener('click', async () => {
          if (closed || b.disabled) return;
          for (const x of briefingButtons) x.disabled = true; notices.notify('Preparing the briefing…');
          try {
            const [chunk, doc] = await Promise.all([import('./briefing.mjs'), readPack(row)]);
            if (closed) return;
            const meta = { versionNo: row.version_no, sha256: row.content_sha256 };
            const message = kind === 'print' ? (chunk.printBriefing(doc, meta), null) : await chunk.downloadBriefing(doc, meta);notices.notify(message??(kind==='print'?'Print briefing opened.':'Briefing downloaded.'),{error:Boolean(message)});
          } catch { if (!closed) notices.notify('The briefing could not be prepared. Try again.',{error:true}); }
          finally { for (const x of briefingButtons) x.disabled = false; }
        });
      }
      
      // Every published version of the case (Julian, 2026-10-06): the card shows the latest; an older or
      // pilot-pinned version stays startable here with the same authority. BUTTON-01: History is a filled button in the actions group.
      const historyButton = node('button', `${formatDate(row.published_at)} · v${row.version_no}`, 'btn tertiary'); historyButton.type = 'button';
      // Share (P-43): shown only when the Worker said this person may offer it; the dialog is its own lazy chunk.
      let shareButton = null;
      if (share) {
        shareButton = node('button', null, 'btn quiet icon-button'); shareButton.type = 'button';shareButton.setAttribute('aria-label','Share case');shareButton.append(uiIcon('share'));
        shareButton.addEventListener('click', async () => {
          if (closed || shareButton.disabled) return;
          shareButton.disabled = true;
          try {
            const { openShare } = await import('./case-share.mjs');
            if (closed) return;
            sharing = openShare({ request: (parts, options) => accountRequest(auth, parts, options), caseId, title: row.title, workspaceId, workspaceName: workspaceName(workspaceId), share,
              onClose: () => { sharing = null; shareButton.focus(); } });
          } catch { if (!closed) notices.notify('Sharing could not be opened. Try again.',{error:true}); }
          finally { if (!closed) shareButton.disabled = false; }
        });
      }
      const prepare=node('aside',null,'surface-card case-present'),prepareHead=node('div',null,'case-present-head');prepareHead.append(node('h2','Present this case'),...(shareButton?[shareButton]:[]));
      const meta=node('div',null,'case-present-meta');meta.append(groupFact,node('span',lengthText(row.duration_min)),node('span',fieldText(row.audience,'audience')));
      const tools=node('div',null,'case-present-tools'),briefingDisclosure=disclosure('Briefing',briefing,{fixedLabel:true});briefingDisclosure.firstChild.prepend(uiIcon('file-down'));
      const sessions=node('a','Sessions','btn quiet');sessions.href=sessionsUrl(location.origin,workspaceId,caseId);sessions.prepend(uiIcon('rotate-ccw-clock'));tools.append(briefingDisclosure,sessions);
      const foot=node('div',null,'case-present-foot');previewButton.prepend(uiIcon('clapperboard'));start.prepend(uiIcon('play'));foot.append(previewButton,start);prepare.append(prepareHead,meta,...(pin?[pin]:[]),tools,foot,recover);
      const overview=node('section',null,'surface-card case-overview'),description=node('div');description.append(node('h2','Overview'),summary);const setting=node('section');setting.append(node('h3','Setting'),node('p',fieldText(row.setting,'setting')));overview.append(description,learning,setting);
      const metadata=node('dl',null,'case-record');for(const [term,value]of [['Updated','Not recorded'],['Published',historyButton],['Creator','Not recorded'],...(edit?[['Edit',edit]]:[])]){const entry=node('div'),dd=node('dd');entry.append(node('dt',term),dd);if(typeof value==='string')dd.textContent=value;else dd.append(value);metadata.append(entry);}
      const history = node('dialog', null, 'computer-dialog case-versions'); history.setAttribute('aria-labelledby', 'caseHistoryTitle');
      const historyTitle = node('h2', 'Versions'); historyTitle.id = 'caseHistoryTitle';
      const closeHistory = node('button', 'Close versions', 'btn quiet'); closeHistory.type = 'button';
      historyGuard=guardDialog(history,{opener:()=>historyButton});closeHistory.addEventListener('click', () => historyGuard.requestClose());
      history.addEventListener('close', () => historyButton.focus());
      historyButton.addEventListener('click', () => { history.showModal(); closeHistory.focus(); });
      history.append(historyTitle, node('p', 'Updates preserve the snapshot used by existing rooms. Restore an earlier update as a private draft to edit it.'), closeHistory);
      const list = node('ul', null, 'case-version-list');
      for (const version of versions) {
        const item = node('li', null, 'case-version');
        const tag = pilotTag(version, pilotPin);
        item.append(node('span', `v${version.version_no} · ${new Date(version.published_at).toLocaleString()}${version.version_id === versions[0].version_id ? ' · latest' : ''}${version.edition ? ' · New edition' : ''}`), ...(tag ? [tag] : []));
        const peek = node('button', 'Preview', 'btn quiet'); peek.type = 'button';
        peek.addEventListener('click', () => { history.close(); previewVersion(version); }); item.append(peek);
        if (canEdit) {
          const restore = node('button', 'Restore as draft', 'btn'); restore.type = 'button';
          restore.addEventListener('click', () => { history.close(); onEdit({ caseId, workspaceId, versionId: version.version_id, versionNo: version.version_no, restore: true }); });
          item.append(restore);
        }
        list.append(item);
      }
      history.append(list);
      const workspaceAction=node('button',workspaceName(workspaceId)??'Workspace details','btn tertiary');workspaceAction.type='button';workspaceAction.setAttribute('aria-haspopup','dialog');workspaceAction.setAttribute('aria-label','Workspace details');
      const addRecord=(label,value)=>{const item=node('div'),dd=node('dd');item.append(node('dt',label),dd);dd.append(value);metadata.append(item);};addRecord('Workspace',workspaceAction);
      workspaceAction.onclick=async()=>{
        const view=openMetadata('Workspace',workspaceAction);if(!view)return;
        const done=node('button','Done','btn quiet');done.type='button';done.onclick=view.close;view.footer.append(done);
        const slot=node('div');view.body.append(slot);
        try{const {mountCaseWorkspaceAccess}=await import('./case-workspace-access.mjs');if(!view.current())return;
          metadataController=mountCaseWorkspaceAccess(slot,{request:(parts,options)=>accountRequest(auth,parts,options),caseId,groupName:group.name??(scope==='workspace'?UNGROUPED:null),onMoved:()=>{clearMetadata();onGroupConflict();},onGroup:async()=>{if(!view.current())return;metadataController?.close();metadataController=null;slot.remove();
        const apply=node('button','Change group','btn primary');apply.disabled=true;view.footer.append(apply);const groupSlot=node('div',null,'case-group-slot');view.body.append(groupSlot);groupSlot.append(node('p','Loading group tools…','supporting-note'));
        try{const loaded=await import('./groups-screen.mjs');if(!view.current())return;groupSlot.replaceChildren();picker=loaded.mountCaseGroup(groupSlot,{submitButton:apply,onConflict:()=>{clearMetadata();onGroupConflict();},request:(parts,options)=>accountRequest(auth,parts,options),workspaceId,workspaceName:workspaceName(workspaceId)??'Workspace',caseId,group,
          onChanged:next=>{groupFact.textContent=next.name??UNGROUPED;cover.dataset.tint=next.tint;for(const item of covers)item.group=next.tint;void paintCovers(covers,{cssSize:400});group={...next};notices.notify('Group updated.');onGroupChanged(next);}});metadataController=picker;
        }catch{if(view.current())groupSlot.replaceChildren(node('p','Group tools could not load. Close and reopen Workspace to retry.','supporting-note'));}
          }});
        }catch{if(view.current())slot.replaceChildren(node('p','Workspace tools could not load. Close and reopen to retry.','supporting-note'));}

      };
      if(canEdit){const feedbackAction=node('button','Version '+row.version_no,'btn tertiary');feedbackAction.type='button';feedbackAction.setAttribute('aria-label','Feedback on version '+row.version_no);feedbackAction.setAttribute('aria-haspopup','dialog');addRecord('Feedback',feedbackAction);
        feedbackAction.onclick=async()=>{const view=openMetadata('Feedback',feedbackAction,{wide:true});if(!view)return;view.body.append(node('p',row.title+' · v'+row.version_no,'small muted'));const done=node('button','Done','btn primary');done.type='button';done.onclick=view.close;view.footer.append(done);const slot=node('div');view.body.append(slot);slot.append(node('p','Loading feedback…','supporting-note'));
          try{const[{mountCaseFeedback}]=await Promise.all([import('./feedback-results.mjs'),loadFeedbackStyle()]);if(!view.current())return;slot.replaceChildren();feedbackPanel=mountCaseFeedback(slot,{request:(parts,options)=>accountRequest(auth,parts,options),caseId,versionNo:row.version_no});metadataController=feedbackPanel;}
          catch{if(view.current())slot.replaceChildren(node('p','Feedback could not load. Close and reopen to retry.','supporting-note'));}
        };
      }
      info.append(cover,heading);layout.append(info,prepare,overview,metadata,history);
      status.textContent = ''; status.classList.add('sr-only');
      root.append(layout);
      if(typeof ResizeObserver==='function'){titleObserver=new ResizeObserver(()=>{if(!closed)info.classList.toggle('long-title',heading.getBoundingClientRect().height+32>cover.getBoundingClientRect().height);});titleObserver.observe(cover);titleObserver.observe(heading);}
      onReady(root);
      heading.focus();
      void paintCovers(covers, { cssSize: 400 });
    } catch {
      if (!closed) {status.classList.remove('sr-only');status.textContent = 'This case is unavailable. It may have been withdrawn, or it is not in your workspaces.';onReady(root);}
    }
  })();
  return { element:root, beforeNavigate() {if(creating||sharing?.beforeNavigate?.()===false)return false;if(metadataDialog){metadataGuard?.requestClose();return false;}if(launch){launchGuard?.requestClose();return false;}clearPreview(); return true; }, close() { closed = true;clearMetadata(); clearLaunch();clearSessionProfile();clearPreview(); stopTheme(); picker?.close(); feedbackPanel?.close(); sharing?.close();historyGuard?.dispose();titleObserver?.disconnect();notices.close();const frame=root.parentElement;root.remove();if(frame?.classList.contains('case-detail-frame'))frame.remove(); } };
}
