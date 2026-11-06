// Device-only audition of the shipped console player/engine. No room commands, capabilities or persisted timer pick.
import { renderPlayer, albumCover, timerClockParts } from './console-player.mjs';
import { createRoomMusic } from './room-music.mjs';
import { freshAnchor, musicTrackFor } from '../shared/music-timeline.mjs';
import { uuidv7 } from '../shared/ids.mjs';
import { uiIcon } from './ui-icons.mjs';
import { guardDialog } from './dialog-behaviour.mjs';
import { createSurfaceNotice } from './surface-notice.mjs';
const PLAYER_CSS='__MUSIC_PLAYER_CSS_URL__';
export async function openMusicAudition({opener,onClose=()=>{},isCurrent=()=>true}={}){
 const doc=opener.ownerDocument,win=doc.defaultView,el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
 const href=new URL(PLAYER_CSS==='__MUSIC_PLAYER_CSS_URL__'?'/src/client/console.css':PLAYER_CSS,win.location.origin).href;
 const existing=[...doc.querySelectorAll('link[rel=stylesheet]')].find(n=>n.href===href);if(!existing?.sheet)await new Promise((resolve,reject)=>{const link=existing??el('link');let timeout;const finish=error=>{win.clearTimeout(timeout);link.removeEventListener('load',loaded);link.removeEventListener('error',failed);if(error){link.remove();reject(Error('music_styles_unavailable'));}else resolve();},loaded=()=>finish(false),failed=()=>finish(true);link.rel='stylesheet';link.href=href;link.addEventListener('load',loaded,{once:true});link.addEventListener('error',failed,{once:true});timeout=win.setTimeout(failed,10000);if(!existing)doc.head.append(link);});if(!isCurrent())return null;
 const dialog=el('dialog',null,'computer-dialog music-audition'),head=el('div',null,'music-audition-head'),title=el('h2','Music'),close=el('button',null,'btn quiet icon-button'),host=el('div');title.id='music-audition-title';dialog.setAttribute('aria-labelledby',title.id);close.type='button';close.setAttribute('aria-label','Close music');close.append(uiIcon('x'));head.append(title,close);dialog.append(head,host,el('p','Question tracks build to the countdown, then fade over two bars. Lobby and Debrief loop. These controls affect this device only.','music-audition-note'));doc.body.append(dialog);
 const notice=createSurfaceNotice(),decisionId=uuidv7(),seed=uuidv7(),timerChoice={value:90},dragging={intensity:null,volume:null};
 let closed=false,context=null,timer=null,mode='decision',draw=0,anchor=null;
 const music={choice:'auto',intensity:70,volume:60,playing:false,effects:false,transport:null};let trackId=musicTrackFor('auto',seed,draw);
 const motion=win.matchMedia('(prefers-reduced-motion: reduce)'),reduced=()=>doc.documentElement.dataset.motion==='false'||motion.matches;
 const publicView=()=>({phase:mode==='lobby'?'waiting':mode==='debrief'?'debrief':'decision_open',decision:{status:'open',decisionId},music:{...music,transport:{...anchor,trackId}},timer:timer?{paused:false,endsAt:timer.endsAt}:null,timerTotalS:timer?.totalS});
 const sound=createRoomMusic({enabled:()=>music.playing,reduced,hidden:()=>doc.hidden,getContext:()=>context,volume:()=>music.volume/100,report:state=>{if(!closed&&state==='unavailable')notice.notify('This track could not play. Try another track or try again.',{error:true});}});
 function reanchor(){anchor=mode==='decision'?freshAnchor({trackId,intensity:music.intensity/100,timer:timer?{deadlineMs:Date.parse(timer.endsAt),totalS:timer.totalS,paused:false}:null,atMs:Date.now()}):null;}
 reanchor();
 async function gesture(){if(reduced()){notice.notify('Music is silent while reduced motion is enabled. Change Motion in Settings to audition.',{error:true});return false;}try{context??=new (win.AudioContext??win.webkitAudioContext)();await context.resume();return !closed;}catch{if(!closed)notice.notify('Audio could not start on this device. Try again.',{error:true});return false;}}
 const button=(text,run,cls)=>{const b=el('button',text,cls);b.type='button';b.onclick=run;return b;};
 async function command(kind,values){if(closed)return;if(kind==='set_timer'){timer=values.seconds===null?null:{endsAt:new Date(Date.now()+values.seconds*1000).toISOString(),totalS:values.seconds,durationS:values.seconds};reanchor();}
  else if(kind==='set_music'){if(values.playing===true&&!await gesture())return;if(closed)return;Object.assign(music,values);if(values.choice){mode='decision';trackId=values.choice==='auto'?musicTrackFor('auto',seed,++draw):values.choice;}reanchor();}
  if(closed)return;render();sound.reconcile(publicView());
 }
 function render(){if(closed)return;const focus=doc.activeElement?.dataset.focusKey;
  const view={phase:mode==='decision'?'responses_open':mode==='lobby'?'lobby':'debrief',timer,music:{...music,choice:mode==='decision'?music.choice:'audition-bed',transport:{trackId,draw}},actions:['set_timer','set_music']};
  const player=renderPlayer(view,{el,button,roomCommand:command,render,timerChoice,dragging});player.setAttribute('aria-label','Music audition');if(mode!=='decision')player.querySelector('.player-timer').hidden=true;
  player.querySelector('.player-detail').textContent=music.playing?'Playing on this device':'Paused on this device';
  const play=player.querySelector('[data-focus-key=music-play]');play.setAttribute('aria-label',music.playing?'Pause audition':'Play audition');play.title=play.getAttribute('aria-label');
  player.querySelector('[data-focus-key=music-volume]').setAttribute('aria-label','Audition music volume');player.querySelector('[data-focus-key=music-effects]')?.remove();
  const covers=player.querySelector('.player-covers');covers.setAttribute('aria-label','All tracks');
  for(const [kind,id,name]of [['lobby','atlas-arrival','Atlas · Arrival'],['debrief','side-street-afterglow','Side Street · Afterglow']]){const b=button('',()=>{mode=kind;trackId=id;reanchor();render();sound.reconcile(publicView());},'player-tile');b.setAttribute('aria-label',name);b.setAttribute('aria-pressed',String(mode===kind));b.dataset.focusKey='audition-'+kind;const art=el('span',null,'player-tile-art');art.append(albumCover(doc,id));b.append(art,el('span',name,'player-tile-name'));covers.append(b);}
  host.replaceChildren(player);if(focus)host.querySelector(`[data-focus-key="${focus}"]`)?.focus({preventScroll:true});
 }
 const tick=win.setInterval(()=>{if(closed||!timer)return;const parts=timerClockParts(timer),clock=host.querySelector('[data-timer-clock]'),detail=host.querySelector('[data-timer-detail]');if(clock)clock.textContent=parts.clock;if(detail)detail.textContent=parts.up?'Fade after countdown':'Music countdown';},250);
 const visibility=()=>sound.reconcile(publicView()),preferences=()=>{if(reduced()&&music.playing){music.playing=false;render();}sound.reconcile(publicView());};doc.addEventListener('visibilitychange',visibility);motion.addEventListener('change',preferences);win.addEventListener('case-device-preferences-change',preferences);win.addEventListener('pagehide',dispose);
 function dispose(){if(closed)return;closed=true;win.clearInterval(tick);doc.removeEventListener('visibilitychange',visibility);motion.removeEventListener('change',preferences);win.removeEventListener('case-device-preferences-change',preferences);win.removeEventListener('pagehide',dispose);sound.close();void context?.close().catch(()=>{});context=null;notice.close();guard.dispose();dialog.remove();if(opener.isConnected)opener.focus();onClose();}
 const guard=guardDialog(dialog,{opener:()=>opener,onClose:dispose});close.onclick=()=>guard.requestClose();dialog.addEventListener('close',dispose,{once:true});render();dialog.showModal();close.focus();return{close:()=>guard.requestClose()};
}
