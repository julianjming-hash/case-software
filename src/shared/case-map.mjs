// Private authored topology; room disclosure always comes from the authority projection.
import { traceSpine } from './room-interpretation.mjs';
export function authoredModel(doc) {
  const beats = new Map(doc.beats.map(b => [b.id, b]));
  if (beats.size !== doc.beats.length) throw Error('Duplicate beat identity');
  const decisions = new Map(doc.decisions.map(d => [d.id, d]));
  const surfaces = new Map(doc.surfaces.map(s => [s.id, s]));
  const order = [], seen = new Set(), queue = [doc.start_beat_id];
  while (queue.length) {
    const id = queue.shift(); if (seen.has(id)) continue;
    const beat = beats.get(id); if (!beat) throw Error('Missing authored beat');
    seen.add(id); const decision = decisions.get(beat.decision_id);
    order.push({ beat, surface: surfaces.get(beat.surface_id), decision });
    if (beat.next_beat_id) queue.push(beat.next_beat_id);
    for (const path of decision?.paths ?? []) {
      if (path.next_beat_id) queue.push(path.next_beat_id);
      if (path.terminal) queue.push(path.terminal.checkpoint_beat_id);
    }
  }
  return { beats, decisions, surfaces, order };
}

// Private semantic model. The decorative numbers-only descriptor never supplies IDs.
export function braidModel(doc) {
  const graph=authoredModel(doc), spine=[], visited=new Set();let id=doc.start_beat_id;
  while(id&&!visited.has(id)){
    visited.add(id);const beat=graph.beats.get(id);if(!beat)throw Error('Missing spine beat');
    spine.push(beat);const decision=graph.decisions.get(beat.decision_id);
    id=decision?decision.paths.find(p=>p.recommended)?.next_beat_id:beat.next_beat_id;
  }
  const positions=new Map(spine.map((b,i)=>[b.id,i]));
  const groups=graph.order.filter(row=>row.decision).map((row,index)=>({...row,
    pigment:['mark-red','mark-yellow','mark-blue'][index%3],
    routes:row.decision.paths.map(path=>{
      const targetBeatId=path.terminal?.checkpoint_beat_id??path.next_beat_id??null;
      const targetIndex=positions.get(targetBeatId)??null;
      const sourceIndex=positions.get(row.beat.id)??null;
      const kind=path.terminal?'reset':!targetBeatId?'end':targetIndex===null||sourceIndex===null?'divergent':targetIndex<=sourceIndex?'return':'forward';
      return {path,sourceBeatId:row.beat.id,targetBeatId,targetIndex,sourceIndex,kind,
        outcome:graph.surfaces.get(path.reveal_surface_id)};
    }),
  }));
  return {graph,spine,groups,positions,sideBeats:graph.order.filter(row=>!positions.has(row.beat.id))};
}

export function resolvedSurface(source, flags = []) {
  const variant = source.variants?.find(v => v.when_flags.every(f => flags.includes(f)));
  return { ...source, ...variant, surfaceId: source.id };
}

export function roomRoute(mirror, view) {
  const unavailable={complete:false,spine:[],detours:[],gaps:[{kind:'unavailable_evidence'}]};
  if(!Array.isArray(mirror?.revealed)||!Array.isArray(view?.publicTimeline))return unavailable;
  const trace=traceSpine(mirror.revealed), publicRows=new Map(view.publicTimeline.map(row=>[row.occurrenceId,row]));
  if(trace.gaps.length||trace.occurrences.size!==mirror.revealed.length||publicRows.size!==view.publicTimeline.length)return unavailable;
  if(mirror.revealed.some(entry=>!publicRows.has(entry.occurrenceId)))return unavailable;
  const active=new Set(trace.spine.map(e=>e.occurrenceId));
  const rows=mirror.revealed.map(entry=>({occurrenceId:entry.occurrenceId,beatId:entry.beatId,pathId:entry.pathId??null,
    correctionOf:entry.correctionOf??null,checkpointOf:entry.checkpointOf??null,
    restoresOccurrenceId:entry.restoresOccurrenceId??null,kind:entry.kind,
    surface:publicRows.get(entry.occurrenceId).surface}));
  const byId=new Map(rows.map(row=>[row.occurrenceId,row])),excursions=[];let retained=[];
  for(const entry of mirror.revealed){
    const restore=entry.correctionOf?entry.restoresOccurrenceId:entry.checkpointOf;
    if(restore){const index=retained.findIndex(id=>id===restore);
      excursions.push({returnOccurrenceId:entry.occurrenceId,restoresOccurrenceId:restore,kind:entry.correctionOf?'correction':'checkpoint',visits:retained.slice(index).map(id=>byId.get(id))});retained=retained.slice(0,index);}
    retained.push(entry.occurrenceId);
  }
  return {complete:true,gaps:[],spine:trace.spine.map(e=>byId.get(e.occurrenceId)),
    detours:rows.filter(row=>!active.has(row.occurrenceId)),excursions};
}
