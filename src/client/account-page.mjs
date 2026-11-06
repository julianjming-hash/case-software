// Account owns identity and scoped access. Session inventory/statistics live in Sessions.
import { guardDialog } from './dialog-behaviour.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
import { node, clearPrivate } from './auth-ui.mjs';
import { labelFields, saveOwnLabel } from './facilitator-label-form.mjs';
import { accessName } from './navigation-access.mjs';
import { caseWorkspaceUrl, caseEditUrl, caseUrl, sessionsUrl } from '../shared/urls.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
export function mountAccountPage(host,{auth,me,memberships=[],current=()=>true,onContext=()=>{},onNavigate=href=>location.assign(href)}={}){
 const notices=createSurfaceNotice();let closed=false,busy=false;const root=node('section',null,'account-page'),title=node('h1','Account','sr-only'),grid=node('div',null,'account-grid'),form=node('form',null,'surface-card account-profile'),access=node('section',null,'surface-card account-access');
 const email=node('p',me.account?.email??'Email unavailable','account-email'),fields=labelFields({name:me.profile?.displayName??'',role:me.profile?.role??''}),save=node('button','Save name and role','btn primary'),status=node('p','','field-hint');save.type='submit';status.setAttribute('role','status');
 form.append(node('h2','Your profile'),email,node('p','Your name and Role appear on Participant records. Role does not grant Access.','muted'),fields.root,save,status);
 let saved=JSON.stringify(fields.value());const dirty=()=>JSON.stringify(fields.value())!==saved;
 let destination=null;const leaveGuard=guardDialog(form,{dirty,pending:()=>busy,onClose:()=>{if(destination){saved=JSON.stringify(fields.value());onNavigate(destination);}}});
 const beforeUnload=event=>{if(busy||dirty()){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 form.onsubmit=async e=>{e.preventDefault();if(closed||busy||!fields.validate())return;busy=true;save.disabled=true;fields.disable(true);status.textContent='Saving…';try{const profile=await saveOwnLabel(auth,fields.value());if(closed||!current())return;me.profile=profile;fields.set({name:profile.displayName,role:profile.role});saved=JSON.stringify(fields.value());status.textContent='';notices.notify('Saved. New sessions use this profile; existing records keep theirs.');}catch{if(!closed&&current()){status.textContent='';notices.notify('Your name and Role could not be confirmed. Your entries are kept; check Account before retrying.',{error:true});}}finally{if(!closed){busy=false;save.disabled=false;fields.disable(false);}}};
 const list=node('ul',null,'account-memberships');access.append(node('h2','Your access'),node('p','Workspace access applies within that workspace. Shared-case access applies to one case. Your profile Role is a label, not a permission.','small muted'),list);const known=new Set();
 function addMemberships(items){for(const item of items){if(!isUuidV7(item.workspace_id)||known.has(item.workspace_id))continue;list.querySelector('[data-empty]')?.remove();known.add(item.workspace_id);const li=node('li'),name=node('strong',item.name??item.workspaceName??'Workspace'),level=node('span',item.role==='admin'?'Administrator · All workspaces':accessName(item.role)+' · Workspace access','account-access-meta'),links=node('div',null,'row');
  const open=node('a','Present','btn quiet');open.href=caseWorkspaceUrl(item.workspace_id,'published',location.origin);links.append(open);if(['admin','owner','author'].includes(item.role)){const edit=node('a','Create','btn quiet');edit.href=caseWorkspaceUrl(item.workspace_id,'drafts',location.origin);links.append(edit);}const copy=node('div',null,'account-access-copy');copy.append(name,level);li.append(copy,links);list.append(li);}}
 addMemberships(memberships);
 if(!memberships.length){const empty=node('li','No workspace memberships recorded.');empty.dataset.empty='true';list.append(empty);}
 for(const grant of Array.isArray(me.grants)?me.grants:[]){
  if(!isUuidV7(grant.case_id))continue;const li=node('li'),copy=node('div',null,'account-access-copy'),actions=node('div',null,'row'),link=node('a',grant.level==='edit'?'Edit case':'Open case','btn quiet');
  link.href=grant.level==='edit'?caseEditUrl(grant.case_id,location.origin):caseUrl(grant.case_id,location.origin);link.setAttribute('aria-label',(grant.level==='edit'?'Edit case: ':'Open case: ')+(grant.title??grant.case_title??'Shared case'));
  copy.append(node('strong',grant.title??grant.case_title??'Shared case'),node('span',accessName(grant.level)+' · '+(grant.access_source==='workspace'&&typeof grant.source_workspace_name==='string'?'Via '+grant.source_workspace_name:grant.access_source==='direct'?'Direct case access':'One case'),'account-access-meta'));actions.append(link);li.append(copy,actions);list.append(li);
 }
 const sessions=node('a','Open Sessions','btn quiet');sessions.href=sessionsUrl(location.origin);access.append(sessions);grid.append(form,access);root.append(title,grid);host.replaceChildren(root);onContext('Account');
 return{addMemberships,beforeNavigate:action=>{if(busy)return false;if(!dirty())return true;destination=action?.href??null;if(destination){document.querySelector('dialog.site-menu[open]')?.close();fields.inputs[0].focus();leaveGuard.requestClose();return false;}return false;},close(){closed=true;leaveGuard.dispose();notices.close();window.removeEventListener('beforeunload',beforeUnload);clearPrivate(root);root.remove();}};
}
