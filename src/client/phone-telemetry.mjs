// Participant-only adapter: no beacon exists until the current server identity is confirmed.
import { isUuidV7 } from '../shared/ids.mjs';
const MODES = new Set(['ws','long-poll','poll']);
function fixedEvent(input) {
  try {
    if (!input || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) return null;
    const keys=Reflect.ownKeys(input);
    if (input.event==='sync_timeout') return keys.length===1?{event:'sync_timeout'}:null;
    if (!['transport_mode','transport_pin'].includes(input.event) || !MODES.has(input.transport) ||
      keys.length!==2 || keys.some(key=>key!=='event'&&key!=='transport')) return null;
    return {event:input.event,transport:input.transport};
  } catch {return null;}
}
export function createParticipantTelemetry({createReporter}={}) {
  let closed=false,attempted=false,active=false,currentMode=null,reporter=null;
  const send=event=> {
    try {void Promise.resolve(reporter(event)).catch(()=>{});return true;} catch {return false;}
  };
  const observe=input=> {
    const event=fixedEvent(input);
    if(closed||!event)return false;
    if(event.event==='transport_mode')currentMode=event.transport;
    return active?send(event):false;
  };
  observe.confirm=(view,sessionId)=> {
    try {
      if(closed||view?.role!=='participant'||!isUuidV7(sessionId)||view.sessionId!==sessionId||
        !isUuidV7(view.you?.id)||view.you.removed===true)return false;
      if(active)return true;
      if(attempted)return false;
      attempted=true;reporter=createReporter();
      if(typeof reporter!=='function')return false;
      active=true;
      if(currentMode)send({event:'transport_mode',transport:currentMode});
      return true;
    } catch {return false;}
  };
  observe.close=()=> {
    if(closed)return;closed=true;active=false;currentMode=null;
    try {void Promise.resolve(reporter?.close?.()).catch(()=>{});} catch {/* optional */}
    reporter=null;
  };
  return observe;
}
