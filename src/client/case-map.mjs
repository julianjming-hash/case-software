import { enhanceSelect, disposeSelects } from './accessible-select.mjs';
// Shared private case map. No authority, transport, storage or audience payload is created here.
import { authoredModel, braidModel, roomRoute } from '../shared/case-map.mjs';
import { markSvg } from './projector-marks.mjs';
import { PIGMENTS, ROW_SHADES, hash, hsl as mosaicColour } from '../shared/mosaic-geometry.mjs';
import { populatedPresentationGroups } from '../shared/presentation-groups.mjs';
import { el, button } from './native-dom.mjs';
import { patchChildren } from './console-focus.mjs';
const p=(text,cls)=>el('p',text,cls),bind=(n,id)=>{n.dataset.spec=id;return n;};
const statusTag=(text,cls='')=>el('span',text,`tag ${cls}`);
function disclosure(title,parent){const summary=el('summary');const action=el('span','Show','disclosure-action');summary.append(el('span',title),action);summary.setAttribute('aria-label',`Show ${title}`);summary.onclick=event=>{event.preventDefault();parent=event.currentTarget.closest('details');parent.open=!parent.open;event.currentTarget.lastElementChild.textContent=parent.open?'Hide':'Show';event.currentTarget.setAttribute('aria-label',`${parent.open?'Hide':'Show'} ${title}`);};return summary;}
// `compact` (CASE-321, the Builder Overview): the whole-case braid alone; the host lists the routes as text itself.
export function mountCaseMap(host,{document:doc,onWalk=()=>{},adapter=null,currentBeatId=null,selectedBeatId=null,selectedPathId=null,compact=false}={}){
 let artFrame=null,generation=0;let variantIndex=null;let graph=authoredModel(doc),braid=braidModel(doc),selected=null,expanded=new Set(),inspectorOpen=true,closed=false;
 if(selectedPathId){const beat=graph.order.find(({decision})=>decision?.paths?.some(path=>path.id===selectedPathId))?.beat;if(beat){selected={kind:'path',id:selectedPathId,beatId:beat.id};expanded.add(beat.id);}}
 else if(selectedBeatId&&graph.beats.has(selectedBeatId))selected={kind:'beat',id:selectedBeatId};
 let ownerDoc=host.ownerDocument??globalThis.document,ownerWindow=ownerDoc.defaultView??globalThis.window;
 const app=el('div',null,'case-map');host.append(app);
 const live=el('p','','sr-only');live.setAttribute('role','status');const announce=message=>{live.textContent=message;};
 function render(){if(closed)return;generation++;if(artFrame!==null)ownerWindow.cancelAnimationFrame(artFrame);const focus=ownerDoc.activeElement?.dataset.focus??ownerDoc.activeElement?.dataset.focusKey;
   const old=app.querySelector('.braid-overview-scroll'),left=old?.scrollLeft??0;
   disposeSelects(app);const fresh=el('div');fresh.append(mapView());const liveSlot=el('div');liveSlot.dataset.keep='map-status';fresh.append(liveSlot);patchChildren(app,fresh);app.querySelector('[data-keep="map-status"]')?.replaceChildren(live);
   for(const select of app.querySelectorAll('select'))enhanceSelect(select,{label:'Authored variant'});
   const scroll=app.querySelector('.braid-overview-scroll');if(scroll)scroll.scrollLeft=left;
   if(focus)[...app.querySelectorAll('[data-focus],[data-focus-key]')].find(n=>(n.dataset.focus??n.dataset.focusKey)===focus)?.focus({preventScroll:true});
 }
function chooseBeat(id){selected={kind:'beat',id};variantIndex=null;if(graph.beats.get(id)?.decision_id)expanded.add(id);render();adapter?.onSelectBeat?.(id);announce('Authored slide selected. Teaching position unchanged.');}
function choosePath(beatId,pathId){selected={kind:'path',id:pathId,beatId};variantIndex=null;inspectorOpen=true;render();adapter?.onSelectPath?.(beatId,pathId);app.querySelector('.braid-inspector h2')?.focus({preventScroll:true});announce('Authored path selected. Teaching position unchanged.');}
function mapView(){
  const workbench=bind(el('section',null,'braid-workbench'),'S01');
  workbench.append(wholeCaseBraid());if(compact)return workbench;
  const toolbar=el('div',null,'braid-toolbar'), title=el('div');title.append(el('h2','Decisions and consequences'),p('Expand a decision to compare its paths. Select a path to inspect its authored content.','route-caption'));
  const controls=el('div',null,'braid-tools');
  for(const [key,label,fn]of [
    ['expand-all','Expand all',()=>{expanded=new Set(braid.groups.map(g=>g.beat.id));}],
    ['collapse-all','Collapse all',()=>expanded.clear()],
    ['inspector',inspectorOpen?'Hide inspector':'Show inspector',()=>{inspectorOpen=!inspectorOpen;}],
  ]){const b=button(label,()=>{fn();render();});b.dataset.focus=key;controls.append(b);}
  toolbar.append(title,controls);workbench.append(toolbar);
  const body=el('div',null,`braid-body ${inspectorOpen?'':'inspector-hidden'}`), decisions=el('div',null,'decision-stack');
  for(const group of braid.groups)decisions.append(decisionGroup(group));
  if(braid.sideBeats.length){const side=el('section',null,'side-beats');side.append(el('h3','Side beats'));for(const {beat}of braid.sideBeats)side.append(button(beat.title,()=>chooseBeat(beat.id)));decisions.append(side);}
  decisions.append(textEquivalent());body.append(decisions);
  if(inspectorOpen){const inspector=authoredInspector();inspector.classList.add('braid-inspector');body.append(inspector);}
  workbench.append(body);return workbench;
}
function wholeCaseBraid(){
  const overview=el('section',null,'whole-case-braid');overview.setAttribute('aria-label','Whole-case authored braid');
  const bar=el('div',null,'braid-overview-bar');bar.append(el('h2','Whole case'),p(`${braid.groups.length} decisions · ${braid.groups.reduce((n,g)=>n+g.routes.length,0)} authored routes · Only you`,'metadata'));
  overview.append(bar);
  const scroll=el('div',null,'braid-overview-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label','Whole-case braid, horizontally scrollable on narrow screens');
  const width=Math.max(620,braid.spine.length*190), plot=el('div',null,'braid-overview-plot');plot.style.width=`${width}px`;
  const NS='http://www.w3.org/2000/svg',svg=ownerDoc.createElementNS(NS,'svg');svg.setAttribute('viewBox',`0 0 ${width} 164`);svg.setAttribute('aria-hidden','true');svg.classList.add('overview-strands');svg.setAttribute('data-art-generation',String(generation));
  const x=i=>95+i*190;
  // The overview uses laid tesserae, never visible path strokes. Geometry remains private,
  // derived from exact beat destinations; art does not become the source of semantic IDs.
  const theme=ownerDoc.documentElement.dataset.theme==='dark'?'dark':'light',tile=6.5;
  let tileCount=0,refused=false;function polygon(points,fill,cls=''){if(++tileCount>6000){refused=true;return;}
    const n=ownerDoc.createElementNS(NS,'polygon');n.setAttribute('points',points.map(p=>p.map(v=>v.toFixed(2)).join(',')).join(' '));
    n.setAttribute('fill',fill);n.setAttribute('stroke','var(--ground)');n.setAttribute('stroke-width','.8');if(cls)n.classList.add(cls);svg.append(n);
  }
  const ticket=generation;artFrame=ownerWindow.requestAnimationFrame(()=>{artFrame=null;if(closed||ticket!==generation)return;
  // Quiet tessellated ground, limited to the art region so labels stay on a clear field.
  for(let y=5;y<114;y+=tile*3)for(let xx=0;xx<width&&tileCount<800;xx+=tile*3){
    polygon([[xx,y],[xx+tile,y],[xx+tile,y+tile],[xx,y+tile]],hash(`${xx}:${y}`)%5===0?'color-mix(in srgb,var(--ground) 94%,var(--field-line))':'color-mix(in srgb,var(--ground) 98%,var(--field-line))','overview-ground-tile');
  }
  const cubic=(a,b,c,d)=>t=>{const u=1-t;return [u*u*u*a[0]+3*u*u*t*b[0]+3*u*t*t*c[0]+t*t*t*d[0],u*u*u*a[1]+3*u*u*t*b[1]+3*u*t*t*c[1]+t*t*t*d[1]];};
  function band(curve,rows,pigment){
    const samples=Array.from({length:301},(_,i)=>curve(i/300)),lengths=[0];
    for(let i=1;i<samples.length;i++)lengths.push(lengths[i-1]+Math.hypot(samples[i][0]-samples[i-1][0],samples[i][1]-samples[i-1][1]));
    const total=lengths.at(-1),count=Math.max(1,Math.round(total/tile));
    function section(distance){
      let i=1;while(i<lengths.length-1&&lengths[i]<distance)i++;
      const a=samples[i-1],b=samples[i],k=(distance-lengths[i-1])/(lengths[i]-lengths[i-1]||1),dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)||1;
      return {p:[a[0]+dx*k,a[1]+dy*k],n:[-dy/len,dx/len]};
    }
    const point=(s,offset)=>[s.p[0]+s.n[0]*offset,s.p[1]+s.n[1]*offset];
    for(let j=0;j<count;j++){
      const a=section(j*total/count),b=section((j+1)*total/count);
      for(let row=-1;row<=rows;row++){
        const lo=(row-rows/2)*tile,hi=lo+tile;
        let fill='color-mix(in srgb,var(--ground) 85%,var(--field-line))';
        if(row>=0&&row<rows){
          const tone=PIGMENTS[pigment]?.[theme];
          fill=tone?mosaicColour(tone[0],tone[1],tone[2]+(theme==='dark'?1:-1)*(ROW_SHADES[row%ROW_SHADES.length]+((j*7+row*3)%5-2)*.7)):`var(--${pigment})`;
        }
        polygon([point(a,lo),point(b,lo),point(b,hi),point(a,hi)],fill);
      }
    }
  }
  const pigments=['coral','ochre','periwinkle'];
  braid.groups.forEach((group,index)=>{
    const i=braid.positions.get(group.beat.id);if(i===undefined)return;
    const forwards=group.routes.filter(r=>!r.path.recommended&&r.kind==='forward'),targets=[...new Set(forwards.map(r=>r.targetIndex))];
    for(const target of targets){
      const rows=forwards.filter(r=>r.targetIndex===target).length,a=x(i)+18,b=x(target)-18,side=index%2?1:-1,y=60+side*13,h=side>0?113:5;
      band(cubic([a,y],[a+30,h],[b-30,h],[b,y]),rows===1?2:rows,pigments[index%3]);
    }
    for(const r of group.routes.filter(r=>r.kind==='reset'||r.kind==='return')){
      if(r.targetIndex===null)continue;
      const a=x(i)-12,b=x(r.targetIndex)+12;
      band(r.targetIndex===i?cubic([a,47],[a-50,0],[b+20,0],[b,47]):cubic([a,47],[a-28,5],[b+28,5],[b,47]),1,r.kind==='reset'?'private':pigments[index%3]);
    }
    if(group.routes.some(r=>r.kind==='divergent'||r.kind==='end'))band(t=>[x(i),73+t*30],1,pigments[index%3]);
  });
  band(t=>[x(0)+(x(braid.spine.length-1)-x(0))*t,60],4,'petrol');

  if(refused){svg.replaceChildren();svg.closest('.whole-case-braid')?.append(p('Detailed braid art is unavailable at this size. Every authored path and destination remains below.','route-caption'));}
  });
  plot.append(svg);
  braid.spine.forEach((beat,index)=>{
    const group=braid.groups.find(g=>g.beat.id===beat.id), active=(selected?.beatId??selected?.id)===beat.id;
    const n=button('',()=>chooseBeat(beat.id),`overview-stop ${active?'active':''}`);n.style.left=`${x(index)-82}px`;n.dataset.focus=`overview-${beat.id}`;
    n.setAttribute('aria-label',`${beat.title}${group?`, ${group.routes.length} routes, ${expanded.has(beat.id)?'expanded':'collapsed'}`:''}`);
    if(beat.id===currentBeatId){n.append(el('span','Current','tag'));n.setAttribute('aria-current','step');}
    n.append(el('span',group?`D${braid.groups.indexOf(group)+1}`:String(index+1).padStart(2,'0'),'overview-node'),el('strong',beat.title));
    if(group){n.append(el('small',`${group.routes.length} routes${group.routes.some(r=>r.kind==='reset')?' · reset':''}`));n.setAttribute('aria-expanded',String(expanded.has(beat.id)));}
    plot.append(n);
  });
  scroll.append(plot);overview.append(scroll);
  const legend=el('div',null,'braid-key');legend.append(p('Petrol: recommended spine'),p('Decision plaits: alternative routes'),p('Violet tesserae: authored reset · destination below'));overview.append(legend);return overview;
}
function decisionGroup(group){
  const open=expanded.has(group.beat.id), focused=(selected?.beatId??selected?.id)===group.beat.id;
  const section=el('section',null,`decision-group ${focused?'is-focused':''}`);section.style.setProperty('--decision-pigment',`var(--${group.pigment})`);
  const header=button('',()=>{if(open)expanded.delete(group.beat.id);else expanded.add(group.beat.id);selected={kind:'beat',id:group.beat.id};variantIndex=null;render();announce(`${group.beat.title} ${open?'collapsed':'expanded'}`);},'decision-header');
  header.dataset.focus=`decision-${group.beat.id}`;header.setAttribute('aria-expanded',String(open));if(open)header.setAttribute('aria-controls',`branches-${group.beat.id}`);
  const identity=el('span',null,'decision-identity');identity.append(el('span',`D${braid.groups.indexOf(group)+1}`,'decision-number'),el('strong',group.beat.title));
  const resetCount=group.routes.filter(r=>r.kind==='reset').length;
  const meta=el('span',`${group.routes.length} routes${resetCount?` · ${resetCount} authored reset${resetCount===1?'':'s'}`:''}`,'decision-meta');header.append(identity,meta,el('span',open?'Hide':'Show','disclosure-word'));section.append(header);
  if(!open)return section;
  const branches=el('div',null,'decision-branches');branches.id=`branches-${group.beat.id}`;
  branches.append(p(group.decision.prompt,'decision-prompt'));
  const labels=el('div',null,'branch-column-labels');labels.append(p('Authored path'),p('Revealed consequence'),p('Next / return'));branches.append(labels);
  for(const route of group.routes){
    const {path,outcome}=route,row=el('article',null,`branch-row ${selected?.id===path.id?'is-selected':''} ${path.recommended?'is-recommended':''}`);
    const choice=button('',()=>choosePath(group.beat.id,path.id),'branch-choice');choice.dataset.focus=`branch-${path.id}`;choice.setAttribute('aria-pressed',String(selected?.id===path.id));
    const marks=el('span',null,'branch-marks');marks.setAttribute('aria-hidden','true');for(const id of path.option_ids??[])marks.append(markSvg(group.decision.interaction.options.findIndex(o=>o.id===id),{size:22}));
    choice.append(marks,el('strong',path.label),el('small',`${path.classification}${path.recommended?' · Recommended':''}`));
    const result=button('',()=>choosePath(group.beat.id,path.id),'branch-outcome');result.dataset.focus=`outcome-${path.id}`;result.setAttribute('aria-label',`Inspect consequence: ${outcome.title}`);result.append(el('strong',outcome.title),el('small',`${populatedPresentationGroups(outcome).length} presentation groups${outcome.variants?.length?' · authored variants':''}`));
    const target=route.targetBeatId?graph.beats.get(route.targetBeatId):null;
    const destination=button('',()=>{if(target)chooseBeat(target.id);},`branch-destination ${route.kind==='reset'?'is-reset':''}`);destination.dataset.focus=`destination-${path.id}`;
    destination.append(el('small',route.kind==='reset'?'↶ Return to checkpoint':route.kind==='return'?'↶ Return to slide':route.kind==='end'?'End of branch':'→ Continue to'),el('strong',target?.title??'End'));
    if(!target)destination.disabled=true;
    row.append(choice,result,destination);branches.append(row);
  }
  const targets=[...new Set(group.routes.filter(r=>r.kind==='forward').map(r=>r.targetBeatId))];
  if(targets.length===1)branches.append(p(`Forward routes rejoin at ${graph.beats.get(targets[0]).title}. Checkpoint returns remain separate.`,'rejoin-label'));
  section.append(branches);return section;
}
function textEquivalent() {
  const details = bind(el('details',null,'text-map'),'S08'); details.append(disclosure('Read the map as text',details));
  const list = el('ol');
  for (const {beat,decision} of graph.order) {
    const row = el('li',beat.title), paths = el('ul');
    for (const path of decision?.paths ?? []) paths.append(el('li',`${path.label}. ${path.classification}${path.recommended?', recommended':''}. Reveals ${graph.surfaces.get(path.reveal_surface_id).title}. ${path.terminal ? `Resets to ${graph.beats.get(path.terminal.checkpoint_beat_id).title}` : path.next_beat_id ? `Continues to ${graph.beats.get(path.next_beat_id).title}` : 'Terminal'}.`));
    if (decision) row.append(paths); else if (beat.next_beat_id) row.append(el('p',`Continues to ${graph.beats.get(beat.next_beat_id).title}.`)); list.append(row);
  }
  details.append(list); return details;
}
function authoredInspector() {
  const beat = selected?.kind === 'beat' ? graph.beats.get(selected.id) : selected?.kind === 'path' ? graph.beats.get(selected.beatId) : graph.beats.get(doc.start_beat_id);
  const path = selected?.kind === 'path' ? graph.decisions.get(beat.decision_id).paths.find(p=>p.id===selected.id) : null;
  const raw = graph.surfaces.get(path?.reveal_surface_id ?? beat.surface_id);
  const source = variantIndex===null?raw:{...raw,...raw.variants?.[variantIndex]};
  const panel = el('section',null,'scene-panel'); panel.append(surfaceSheet(source,'Authored content', 'Only you'));panel.querySelector('h2').tabIndex=-1;
  if (raw.variants?.length) {
    const l = el('label','Authored variant: ','variant-choice'), s = el('select');
    const defaultOption=el('option','Default');defaultOption.value='';if(variantIndex===null)defaultOption.setAttribute('selected','');s.append(defaultOption);
    for(const v of raw.variants) {const o=el('option',v.when_flags.map(f=>doc.flags.find(x=>x.key===f)?.label??f).join(', '));o.value=String(raw.variants.indexOf(v));if(raw.variants.indexOf(v)===variantIndex)o.setAttribute('selected','');s.append(o);}
    s.dataset.focusKey='variant';s.value=variantIndex===null?'':String(variantIndex);s.onchange=event=>{variantIndex=event.currentTarget.value===''?null:Number(event.currentTarget.value);render();};l.append(s);panel.append(l);
  }
  panel.append(privateInfo(source,beat,path));
  const foot=el('div',null,'scene-footer');foot.append(p('Private inspection · preview position unchanged'),button('Walk through case',()=>{onWalk();}));panel.append(foot);return panel;
}
function surfaceSheet(surface,label,badge) {
  const n=bind(el('article',null,'scene-sheet'),'S06'), top=el('div',null,'scene-label');
  top.append(p(label,'eyebrow'),statusTag(badge,badge==='Only you'?'priv':''));n.append(top,el('h2',surface.title));
  if(surface.scene)n.append(p(surface.scene,'scene'));
  if(surface.observations?.length){const dl=el('dl',null,'observation-grid');for(const item of surface.observations){const cell=el('div',null,'observation');const value=el('dd',item.value);if(item.unit)value.append(el('small',` ${item.unit}`));cell.append(el('dt',item.label),value);dl.append(cell);}n.append(dl);}
  if(surface.points?.length){const ul=el('ul',null,'findings');for(const point of surface.points)ul.append(el('li',point));n.append(ul);}
  if(surface.investigations?.length){n.append(p('Investigations','content-label'));const ul=el('ul',null,'findings');for(const result of surface.investigations)ul.append(el('li',result));n.append(ul);}
  return n;
}
function privateInfo(surface,beat,path=null){
  const n=el('aside',null,'private-panel');n.append(p('◈ Only you · teaching notes','zone-label'));
  if(path){n.append(p(`${path.classification}${path.recommended?' · Recommended':''}`),p(path.rationale));}
  if(path?.cue??beat?.cue){n.append(p('Presenter cue','content-label'),p(path?.cue??beat.cue));}
  if(surface.notes){const d=el('details');d.append(disclosure('Presenter notes',d),p(surface.notes));n.append(d);}
  if(path?.terminal){n.append(p('Checkpoint discussion','content-label'),p(path.terminal.debrief_prompt));}
  return n;
}
render();return{root:app,updateCurrent(id){if(id!==currentBeatId){currentBeatId=id;render();}},close(){closed=true;disposeSelects(app);generation++;if(artFrame!==null)ownerWindow.cancelAnimationFrame(artFrame);doc=null;ownerDoc=null;ownerWindow=null;graph=null;braid=null;adapter=null;app.remove();}};
}
export function mountRoomRoute(host,{mirror,view,onInspect=()=>{}}={}){
 const ownerDoc=host.ownerDocument??globalThis.document,root=el('section',null,'case-map case-route');host.append(root);let closed=false;
 function render(nextMirror,nextView){if(closed)return;mirror=nextMirror;view=nextView;const model=roomRoute(mirror,view),fresh=el('div');fresh.append(el('h2','Actual path'));
  const open=root.querySelector('details')?.open??false,focused=ownerDoc.activeElement?.dataset.focusKey;
  if(!model.complete)fresh.append(p('Path evidence unavailable. The authored map cannot establish the path taken.'));
  else{
   const current=mirror.revealed.at(-1)?.occurrenceId;
   const renderRow=row=>{const b=button(row.surface?.title??'Disclosed visit',()=>onInspect(row.occurrenceId),'btn route-step');b.dataset.focusKey=`visit-${row.occurrenceId}`;
    if(row.occurrenceId===current)b.setAttribute('aria-current','step');b.append(p(row.correctionOf?'Teaching correction':row.checkpointOf?'Authored checkpoint reset':'Disclosed visit'));return b;};
   const list=el('ol',null,'route-list');for(const row of model.spine){const li=el('li');li.append(renderRow(row));list.append(li);}fresh.append(list);
   if(model.detours.length){const details=el('details',null,'route-excursion');details.open=open;details.append(disclosure(`Displaced visits · ${model.detours.length}`,details));details.firstChild.lastChild.textContent=open?'Hide':'Show';details.firstChild.setAttribute('aria-label',`${open?'Hide':'Show'} displaced visits`);for(const [index,group]of model.excursions.entries()){const section=el('section');section.append(el('h3',`${group.kind==='correction'?'Correction':'Checkpoint return'} ${index+1}`));for(const row of group.visits)section.append(renderRow(row));details.append(section);}fresh.append(details);}
  }
  patchChildren(root,fresh);if(focused)[...root.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===focused)?.focus({preventScroll:true});
 }
 render(mirror,view);return{root,update:render,close(){closed=true;mirror=null;view=null;onInspect=null;root.remove();}};
}
