// Readable comparison from the canonical matrix. UI scope/search never changes the invitation target or Access.
import {MATRIX,PRINCIPALS,permissionLabels} from './permission-labels.mjs';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const NAMES={admin:'Admin',owner:'Workspace · Can manage',author:'Workspace · Can edit',facilitator:'Workspace · Can run',caseAuthor:'Case · Can edit',caseFacilitator:'Case · Can run',participant:'Participant',projector:'Projector',sharedPc:'Shared computer'};
const STATES={yes:'Allowed',no:'Unavailable',step:'Security confirmation',own:'Own session',pol:'Workspace policy','own+pol':'Own + policy',cap:'Specific capability'};
export const permissionGroups=[['Issues and incidents',['P-47','P-48','P-49']],['Workspace and access',['P-01','P-02','P-03','P-04','P-05','P-06','P-10','P-12','P-17','P-18','P-19','P-20','P-40','P-41','P-43','P-44','P-45','P-46']],['Create and publish',['P-11','P-13','P-14','P-15','P-16','P-33','P-42']],['Present and participate',['P-08','P-09','P-21','P-23','P-24','P-25','P-26','P-27','P-28','P-29','P-30']],['Records and feedback',['P-07','P-22','P-31','P-32','P-34','P-35','P-36','P-37','P-38','P-39']]];
export function permissionComparison({search}){
 const root=el('section',undefined,'studio-permissions');root.hidden=true;root.dataset.transient='true';
 const tools=el('div',undefined,'permission-tools'),label=el('label','Compare access'),scope=el('select');scope.setAttribute('aria-label','Permission comparison scope');
 for(const [value,text]of [['all','All access and capabilities'],['workspace','Workspace access'],['case','Case-only access']]){const o=el('option',text);o.value=value;scope.append(o);}label.append(scope);
 let query='';const count=el('p','','small muted'),rows=el('div',undefined,'permission-groups'),find=search(value=>{query=value;fill();},{label:'Search permissions',value:'',inputLabel:'Search permission actions'});
 tools.append(label,find,count);root.append(el('h3','Permissions'),el('p','This comparison does not change the invitation. Admin access is never granted by invitation.','small muted'),el('p','Policy means the workspace must allow the action. Own + policy adds workspace sessions when policy permits. Capability means a specific session or invitation credential. Case access applies only to that case.','small muted'),tools,rows);
 root.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('input[type=search]')){e.preventDefault();e.stopPropagation();}});
 function fill(){rows.replaceChildren();const principals=scope.value==='workspace'?['facilitator','author','owner']:scope.value==='case'?['caseFacilitator','caseAuthor']:PRINCIPALS;let total=0;
  for(const [name,ids]of permissionGroups){const section=el('section',undefined,'permission-group'),heading=el('h3',name);section.append(heading);
   for(const id of ids){const cells=MATRIX[id],title=permissionLabels[id].replaceAll('`','').replace(/\brooms\b/g,'sessions').replace(/\broom\b/g,'session');if(![name,title,id].join(' ').toLowerCase().includes(query.toLowerCase()))continue;if(scope.value!=='all'&&principals.every(p=>cells[p]==='no'))continue;
    const row=el('article',undefined,'permission-row');row.dataset.action=id;row.append(el('h4',title),el('p',id,'permission-id'));const values=el('dl',undefined,'permission-values');
    for(const principal of principals){const entry=el('div',undefined,'permission-cell'),term=el('dt',NAMES[principal]),value=el('dd',id==='P-47'&&cells[principal]==='own'?'Own report':id==='P-49'&&cells[principal]==='cap'?'Designated admin':STATES[cells[principal]]);entry.dataset.principal=principal;entry.dataset.permission=cells[principal];entry.append(term,value);values.append(entry);}row.append(values);section.append(row);total++;
   }if(section.childElementCount>1)rows.append(section);
  }count.textContent=total+' actions · '+principals.length+' access contexts'+(scope.value==='all'?'':' · Available or conditional actions');if(!total)rows.append(el('p','No actions match this search.','studio-empty'));
 }
 scope.onchange=fill;fill();return root;
}
