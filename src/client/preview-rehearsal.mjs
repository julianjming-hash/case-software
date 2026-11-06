// A memory-only adapter. Never instantiate ConsoleManualRoom: it owns storage and a public channel.
import { initialState, reduce, project } from '../shared/room-machine.mjs';
import { uuidv7 } from '../shared/ids.mjs';
import { createRouteSelection } from './console-route-selection.mjs';
export class Rehearsal {
  constructor(doc,mode='online'){this.doc=doc;this.mode=mode;this.routes=createRouteSelection();this.restart();}
  restart(){if(!this.doc)return;this.routes.clear();this.rounds=new Map();this.state=initialState({sessionId:uuidv7(),caseDoc:this.doc});}
  view(){return this.state?project(this.state,'facilitator'):null;}
  get selection(){return this.routes.sync(this.view());}
  select(id){return this.routes.choose(this.view(),id);}
  undoChoice(){return this.routes.undo(this.view());}
  command(type,payload={}){
    if(!this.state)return false;
    const before=this.state;
    const event={type,epoch:before.epoch,expectRevision:before.revision,actor:{role:'facilitator'},at:new Date().toISOString(),
      clientEventId:uuidv7(),roundId:uuidv7(),...payload};
    if(type==='undo'){const action=before.teachingActions.at(-1);event.sourceRound=this.rounds.get(action?.roundId);event.seedResponseIds={};}
    const result=reduce(before,event),receipt=result.effects.find(e=>e.type==='receipt');this.reason=receipt?.reason??null;
    if(receipt?.receipt!=='accepted')return false;
    this.state=result.state;
    if(this.state.round)this.rounds.set(this.state.round.id,structuredClone(this.state.round));
    if(type==='start'&&this.mode==='manual')return this.command('enter_manual',{segmentId:uuidv7()});
    return true;
  }
  close(){this.doc=null;this.state=null;this.rounds.clear();this.routes.clear();}
}
