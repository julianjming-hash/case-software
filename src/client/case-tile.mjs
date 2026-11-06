// One card anatomy for catalogue, drafts and session records. Navigation and modal controls stay native.
let ids=0;
export function caseTile({doc=document,title,summary='',metadata=[],states=[],media=null,context=null,href=null,onOpen=null,dialog=false,variant='vertical',level='h2',className=''}={}){
 const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const root=el('article',undefined,'case-card case-tile '+className);root.dataset.presentation=variant;
 const body=el('div',undefined,'case-card-body'),heading=el(level,title,'case-card-title');heading.id='case-tile-title-'+(++ids);body.append(heading);
 if(metadata.length){const facts=el('p',undefined,'case-meta');for(const fact of metadata)facts.append(el('span',fact));body.append(facts);}
 if(summary)body.append(el('p',summary,'case-summary'));
 if(states.length){const status=el('div',undefined,'case-states');for(const state of states)status.append(el('span',state.label,'tag '+(state.tone??'')));body.append(status);}
 if(context)body.append(context);
 let open;
 if(dialog){if(media)root.append(media);root.append(body);open=el('button',undefined,'case-tile-dialog');open.type='button';open.setAttribute('aria-haspopup','dialog');open.setAttribute('aria-label','Open draft: '+title);root.append(open);}
 else{open=el('a',undefined,'case-tile-open case-link');open.href=href;open.setAttribute('aria-labelledby',heading.id);if(media)open.append(media);open.append(body);root.append(open);}
 if(onOpen)open.addEventListener('click',onOpen);
 return{root,open,body,heading};
}
