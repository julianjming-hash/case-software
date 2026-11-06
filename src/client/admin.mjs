import {uiIcon,compactTool} from './ui-icons.mjs';
import {rememberIssueAuth} from './issue-auth-binding.mjs';
import {loadFeedbackStyle} from './feedback-style.mjs';
// Standalone entry: private administration is never imported by the participant shell.
// Facilitator-UX A5: People, Invitations, Workspaces, Cases, Rooms, Activity and Feedback (prototypes/admin-people.html).
// Each section is its own lazily loaded chunk; this entry holds the sign-in, the section nav, the session's step-up and the
// one confirmation dialog every destructive button uses.
import {disposeSelects,enhanceSelect} from './accessible-select.mjs';
import {guardDialog} from './dialog-behaviour.mjs';
import {createSurfaceNotice} from './surface-notice.mjs';
import {node,mountAccount,accountRequest} from './auth-ui.mjs';
import {menuIdentity} from './navigation-access.mjs';
import {casesUrl} from '../shared/urls.mjs';
import {startShell} from './shell.mjs';
import {createAdminApi} from './admin-api.mjs';
import {createAdminElevation} from './admin-elevation.mjs';
import {createAdminConfirm,renderConfirm} from './admin-confirm.mjs';
import {mountSiteHeader} from './site-header.mjs';

const SECTIONS={people:'People',invitations:'Invitations',workspaces:'Workspaces',cases:'Cases',rooms:'Sessions',activity:'Activity',feedback:'Feedback',issues:'Issues'};
// Erase retained descendants as well as removing them from the document.
function erase(root){disposeSelects(root);for(const child of [...root.querySelectorAll('*')].reverse()){if('value' in child)child.value='';for(const name of ['data-record','aria-label','title'])child.removeAttribute(name);child.textContent='';}root.replaceChildren();}
export function mountAdmin({origin=location.origin,embedded=null}={}){
 const notices=createSurfaceNotice();
 const header=embedded?.header??mountSiteHeader(document.body,{context:'Administration',current:'admin',loadAccount:loadMenuAccount,beforeNavigate:action=>{if(!leaveConfirmation())return false;return activeScreen()?.beforeNavigate?.(action)??true;}});
 const surfaceHeading=embedded?node('h1','Administration','sr-only'):null;
 const surface=embedded?node('section',null,'admin-surface'):document.getElementById('adminSurface'),account=embedded?node('div'):document.getElementById('adminAccount'),dialog=embedded?node('dialog'):document.getElementById('adminConfirmation');
 if(embedded){surface.id='adminSurface';account.id='adminAccount';dialog.id='adminConfirmation';dialog.setAttribute('aria-labelledby','adminConfirmationTitle');embedded.host.classList.add('embedded-admin');}
 const admission=embedded?node('section',null,'admin-account'):account.parentElement,admissionTitle=embedded?node('h1','Administration'):admission.querySelector('h1');if(embedded){admission.append(account);admission.hidden=true;embedded.host.append(surfaceHeading,admission,surface,dialog);}account.classList.add('auth-panel');account.prepend(admissionTitle);let admissionGeneration=0;
 function admissionState(value){const signedOut=value==='signed-out',version=++admissionGeneration;document.body.classList.toggle('admin-signed-out',signedOut);admissionTitle.classList.toggle('sr-only',!signedOut);admissionTitle.textContent=signedOut?'Sign in':'Administration';if(signedOut||admission.classList.contains('auth-splash'))void import('./splash.mjs').then(chunk=>{if(!closed&&version===admissionGeneration)chunk.setAuthSplash(admission,signedOut);});}

 let api=null,elevation=null,confirm=null,authRef=null,accountUi=null,accountEmail,closed=false,gate='loading',section='people',opener=null,wasOpen=false;
 let navigation=null,workArea=null;let inviteRequested=false,people=null,invitations=null,workspaces=null,workbench=null,feedback=null,issues=null,loading=null;
 const peopleHost=node('div',null,'admin-people-host'),invitationsHost=node('div',null,'admin-invitations-host'),workspacesHost=node('div',null,'admin-workspaces-host'),workbenchHost=node('div',null,'admin-workbench-host'),feedbackHost=node('div',null,'admin-feedback-host');
 const issuesHost=node('div',null,'admin-issues-host');
 const hosts={issues:issuesHost,people:peopleHost,invitations:invitationsHost,workspaces:workspacesHost,cases:workbenchHost,rooms:workbenchHost,activity:workbenchHost,feedback:feedbackHost};
 const request=(parts,options)=>accountRequest(authRef,parts,options);
 const button=(label,action,primary=false)=>{const item=node('button',label,primary?'btn primary':'btn quiet');item.type='button';item.addEventListener('click',action);return item;};
 const status=(label,className='admin-notice')=>{const item=node('p',label,className);item.setAttribute('role','status');return item;};
 const crumb=label=>header.setBreadcrumbs([{label:'Administration'},{label}]);
 const contextFor=name=>label=>{if(!closed&&gate==='ready'&&section===name)crumb(label);};
 async function loadMenuAccount(){
  const owner=authRef,token=owner?.accessToken();if(!token)return null;
  try{
   const me=await accountRequest(owner,['me'],{query:new URLSearchParams({limit:'1'})});
   if(closed||authRef!==owner||owner.accessToken()!==token)return null;
   return menuIdentity(me,()=>accountUi.signOut.click());
  }catch(error){if(!closed&&authRef===owner&&owner.accessToken()===token){accountEmail=null;}throw error;}
 }
 async function loadAccount(){
  if(accountEmail!==undefined)return;accountEmail=null;
  const owner=authRef;
  try{const identity=await loadMenuAccount();if(closed||authRef!==owner)return;if(typeof identity?.email==='string'){accountEmail=identity.email;header.setAccount(identity);}}catch{return;}
  if(gate==='admin_only')render();
 }
 // Each section is loaded once, on first open, and kept until sign-out.
 async function ensure(name){
  if(name==='people'&&!people){const {mountAdminPeople}=await import('./admin-people.mjs');if(closed||!api||people)return;
   people=mountAdminPeople(peopleHost,{api,request,elevation,confirm,adminEmail:accountEmail,onContext:contextFor('people'),onInvite:()=>{inviteRequested=true;go('invitations');},onGate:setGate});}
  else if(name==='invitations'&&!invitations){const {mountAdminInvitations}=await import('./admin-invitations.mjs');if(closed||!api||invitations)return;invitations=mountAdminInvitations(invitationsHost,{request,confirm});contextFor('invitations')('Invitations');}
  else if(name==='workspaces'&&!workspaces){const {mountAdminWorkspaces}=await import('./admin-workspaces.mjs');if(closed||!api||workspaces)return;
   workspaces=mountAdminWorkspaces(workspacesHost,{request,api,elevation,confirm,onContext:contextFor('workspaces'),mountGroups:async(host,{workspace})=>{const {mountGroups}=await import('./groups-screen.mjs');
    return mountGroups(host,{request,workspaces:[{workspace_id:workspace.id,name:workspace.name}],workspaceId:workspace.id,admin:true,scoped:true,stepUp:{has:()=>elevation.has(),token:()=>elevation.token(),drop:()=>elevation.drop(),sendCode:()=>elevation.sendCode(),verify:code=>elevation.verify(code)}});}});}
  else if(['cases','rooms','activity'].includes(name)){
   if(!workbench){const {mountAdminWorkbench}=await import('./admin-workbench.mjs');if(closed||!api)return;if(!workbench){workbenchHost.replaceChildren();workbench=mountAdminWorkbench(workbenchHost,{auth:authRef,api,elevation,confirm,onContext:label=>{if(['cases','rooms','activity'].includes(section))crumb(label);}});}}
   if(section===name)workbench.show(name);}
  else if(name==='issues'){if(!issues){const {mountAdminIssues}=await import('./admin-issues.mjs');if(closed||!api)return;issues=mountAdminIssues(issuesHost,{auth:authRef,onContext:contextFor('issues'),controls:{enhanceSelect,disposeSelects,uiIcon,createSurfaceNotice,compactTool}});}else issues.show();}
  else if(name==='feedback'&&!feedback){const [{mountAdminFeedback}]=await Promise.all([import('./feedback-results.mjs'),loadFeedbackStyle()]);if(closed||!api||feedback)return;
   feedbackHost.replaceChildren();feedback=mountAdminFeedback(feedbackHost,{request,onContext:label=>{if(!closed&&section==='feedback')header.setBreadcrumbs([{label:'Administration'},{label:'Feedback'},{label}]);}});}
 }
 async function open(name){
  if(loading===name)return;loading=name;
  if(!hosts[name].childElementCount)hosts[name].append(status(`Loading ${SECTIONS[name].toLowerCase()}…`));
  try{await ensure(name);if(name==='invitations'&&inviteRequested){inviteRequested=false;invitations?.open();}}
  catch{if(!closed&&section===name){if(gate==='loading')setGate('unavailable');else hosts[name].replaceChildren(status(`${SECTIONS[name]} is unavailable.`),button(`Retry ${SECTIONS[name].toLowerCase()}`,()=>void open(name)));}}
  finally{if(loading===name)loading=null;}
 }
 function activeScreen(){return section==='issues'?issues:section==='people'?people:section==='invitations'?invitations:section==='workspaces'?workspaces:section==='feedback'?feedback:workbench;}
 function leaveConfirmation(){if(!confirm?.state.open)return true;confirmGuard.requestClose();return !confirm?.state.open;}
 function go(name){
  if(closed||!leaveConfirmation()||activeScreen()?.beforeNavigate?.({resume:()=>go(name)})===false)return;section=name;render();void open(name);
 }
 function setGate(value){if(closed||gate===value)return;gate=value;render();if(value!=='loading')embedded?.onReady?.(value);}
 function cleanup(reason='sign_out'){notices.clear();
  erase(surface);for(const screen of [people,invitations,workspaces,workbench,feedback,issues])screen?.close();people=invitations=workspaces=workbench=feedback=issues=null;loading=null;
  for(const host of new Set(Object.values(hosts))){erase(host);}
  confirm?.close();elevation?.clear();api?.close();confirm=elevation=api=null;gate='loading';section='people';opener=null;wasOpen=false;accountEmail=undefined;if(!embedded){header.setAccount(null);header.setBreadcrumbs([{label:'Administration'}]);}if(dialog.open)dialog.close();erase(dialog);erase(surface);surface.append(status('Sign in to continue.'));if(!embedded)document.querySelector('h1')?.focus();
 }
 function renderDenied(){
  const who=node('p',null,'admin-muted'),back=node('a','Back to Present','btn primary'),other=node('button','Sign in with another account','btn tertiary'),denied=node('div',null,'admin-denied');
  who.append("You're signed in as ",accountEmail?node('strong',accountEmail):'this account',". Signing in again won't change this.");
  back.href=casesUrl(location.origin);other.type='button';other.onclick=()=>accountUi.signOut.click();
  denied.append(node('h2',"This account doesn't have administrator access"),who,node('p','If you should have access, ask the Case owner to add this address.'),back,other);
  surface.append(denied);void loadAccount();
 }
 function render(){
  if(closed||!api)return;
  if(typeof accountEmail==='string')header.setAccount(menuIdentity(rememberIssueAuth({account:{email:accountEmail,administration:gate==='ready'},memberships:[]},authRef),()=>accountUi.signOut.click()));else void loadAccount();
  if(gate!=='ready'){
   for(const host of new Set(Object.values(hosts)))host.remove();erase(surface);navigation=workArea=null;
   if(gate==='admin_only'){renderDenied();return;}
   surface.append(status(gate==='loading'?'Loading administration…':gate==='sign_in'?'Sign in to continue.':'Administration is unavailable.'));
   if(gate==='unavailable')surface.append(button('Refresh information',()=>{gate='loading';render();people?.close();people=null;peopleHost.replaceChildren();void open('people');}));
   return;
  }
  if(!navigation?.isConnected){
   erase(surface);navigation=node('nav',null,'admin-nav');navigation.setAttribute('aria-label','Administration sections');workArea=node('section',null,'admin-work');
   for(const [name,label]of Object.entries(SECTIONS)){const item=button(label,()=>go(name));item.dataset.section=name;navigation.append(item);}
   workArea.append(...new Set(Object.values(hosts)));surface.append(navigation,workArea);
  }
  crumb(SECTIONS[section]);
  for(const item of navigation.children){if(item.dataset.section===section)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');}
  for(const host of new Set(Object.values(hosts)))host.hidden=host!==hosts[section];

 }
 function renderDialog(){
  if(closed||!confirm)return;
  // The control that opened the dialog gets focus back on close. People redraws after a close, so it is found again by its name.
  if(confirm.state.open&&!wasOpen)opener=document.activeElement;wasOpen=confirm.state.open;
  renderConfirm(dialog,confirm,{node,onCancel:()=>confirmGuard.requestClose(),notify:text=>notices.notify(text,{error:!text.startsWith('We emailed')}),adminEmail:accountEmail??null,onClosed:()=>{
   const key=opener?.getAttribute?.('aria-label')??opener?.textContent;opener=null;
   if(key)queueMicrotask(()=>{if(closed)return;[...surface.querySelectorAll('button,select')].find(item=>(item.getAttribute('aria-label')??item.textContent)===key)?.focus();});}});
 }
 const beforeUnload=event=>{if(confirm?.state.busy||confirm?.state.open||invitations?.hasUnsaved?.()){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 const confirmGuard=guardDialog(dialog,{dirty:()=>Boolean(dialog.querySelector('input')?.value),pending:()=>confirm?.state.busy===true,onClose:()=>confirm?.cancel()});
 function activate(auth){
  if(closed)return;cleanup('account_change');authRef=auth;if(embedded)accountEmail=embedded.me?.account?.email;
  api=createAdminApi({origin,auth});elevation=createAdminElevation(api);confirm=createAdminConfirm({onChange:renderDialog});render();void open('people');
 }
 if(embedded){accountUi={signOut:{click:embedded.signOut}};activate(embedded.auth);}
 else accountUi=mountAccount(account,{idleText:'',onStateChange:value=>{admissionState(value);erase(surface);if(value==='signed-out')surface.append(status('Sign in to continue.'));},onSignedOut:cleanup,onSignedIn:activate});
 function close(){if(closed)return;closed=true;confirmGuard.dispose();notices.close();window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pagehide',close);cleanup('close');if(embedded){surfaceHeading.remove();admission.remove();surface.remove();dialog.remove();embedded.host.classList.remove('embedded-admin');}else header.remove();}
 window.addEventListener('pagehide',close,{once:true});
 return {clear:cleanup,close,reveal:render,beforeNavigate(action){if(!leaveConfirmation())return false;return activeScreen()?.beforeNavigate?.(action)??true;}};
}
export function mountAdminSurface(host,options){let settle;const ready=new Promise(resolve=>{settle=resolve;});const control=mountAdmin({embedded:{host,...options,onReady:settle}});return{...control,ready,close(){settle(false);control.close();}};}

// Standalone compatibility entry; embedded imports have no URL/Auth/SW side effects.
if(document.getElementById('adminAccount')&&!document.body.classList.contains('private-shell')){
 const entryUrl=new URL(location.href);if(entryUrl.search||entryUrl.hash)history.replaceState(null,'',entryUrl.origin+entryUrl.pathname);
 mountAdmin();startShell();
}
