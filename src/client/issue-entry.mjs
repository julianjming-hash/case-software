// Header wiring stays small. Native capture starts in the click before importing the form.
import {captureTabFrame} from './issue-capture.mjs';
export function attachIssueEntry(opener,controls){
 const{uiIcon}=controls;
 let auth=null,email=null,disposed=false,generation=0,controller=null,screen=null,button=null,notice=null;
 const retire=()=>{generation++;controller?.abort();controller=null;screen?.close();screen=null;notice?.remove();notice=null;};
 function setAccount(nextAuth,nextEmail){if(auth===nextAuth&&email===nextEmail)return;retire();auth=nextAuth;email=nextEmail;
  if(!auth){button?.remove();button=null;return;}
  if(button)return;button=opener.ownerDocument.createElement('button');button.type='button';button.className='menu-button issue-trigger';button.setAttribute('aria-label','Report an issue');button.title='Report an issue · capture a screenshot with the browser picker';
  button.append(uiIcon('circle-question-mark',18,opener.ownerDocument));opener.before(button);
  button.onclick=async()=>{if(disposed||!auth||screen)return;const owner=auth,version=++generation,session=auth.sessionGeneration();controller=new AbortController();const current=()=>!disposed&&version===generation&&auth===owner&&owner.sessionGeneration()===session;
   notice?.remove();notice=null;button.disabled=true;
   // This call invokes getDisplayMedia synchronously in the trusted user activation.
   const captured=captureTabFrame({signal:controller.signal,isCurrent:current});
   try{const [{mountIssueReporter},shot]=await Promise.all([import('./issue-reporter.mjs'),captured]);if(!current())return;
    screen=mountIssueReporter({auth:owner,shot,ui:controls,isCurrent:current,opener:button,onClosed:()=>{screen=null;}});
   }catch{controller?.abort();if(current()){notice=opener.ownerDocument.createElement('p');notice.className='site-menu-notice';notice.setAttribute('role','status');notice.textContent='Reporting is unavailable. Please try again.';opener.parentElement?.append(notice);}}finally{if(current()&&button)button.disabled=false;}
  };
 }
 const hide=()=>{setAccount(null,null);};window.addEventListener('pagehide',hide);window.addEventListener('case-auth-retired',hide);
 return{setAccount,remove(){disposed=true;retire();button?.remove();button=null;auth=null;email=null;window.removeEventListener('pagehide',hide);window.removeEventListener('case-auth-retired',hide);}};
}
