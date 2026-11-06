// Local Builder study: safe typed table rendering shared with private inspection.
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function renderTable(b,makeCell){
 const wrap=el('div',undefined,'table-scroll');wrap.setAttribute('role','region');wrap.setAttribute('aria-label',`${b.caption||b.label} table`);
 const table=el('table',undefined,`data-table${b.banded?' table-banded':''}${b.density==='compact'?' table-compact':''}${b.tableText==='large'?' table-large':''}`);table.setAttribute('aria-label',b.caption||b.label);table.setAttribute('role','table');
 if(b.caption)table.append(el('caption',b.caption));
 const columns=b.headers.length,weights=Array.from({length:columns},(_,i)=>b.widths?.[i]||1),total=weights.reduce((a,v)=>a+v,0),colgroup=el('colgroup');
 for(const weight of weights){const col=el('col');col.style.width=`${weight/total*100}%`;colgroup.append(col);}table.append(colgroup);
 const header=el('tr');header.setAttribute('role','row');b.headers.forEach((v,i)=>{const rowHeading=b.headerRow===false&&b.rowHeader&&i===0,cell=el(b.headerRow!==false||rowHeading?'th':'td');if(b.headerRow!==false)cell.scope='col';else if(rowHeading)cell.scope='row';cell.style.textAlign=b.formats?.[i]==='number'?'right':'left';cell.setAttribute('role',b.headerRow!==false?'columnheader':rowHeading?'rowheader':'cell');if(b.headerRow===false){const label=el('span',`Column ${i+1}`,'table-cell-label');label.setAttribute('aria-hidden','true');cell.append(label);}if(makeCell)cell.append(makeCell(v,-1,i));else cell.append(el('span',v,'table-cell-value'));header.append(cell);});
 const body=el('tbody');body.setAttribute('role','rowgroup');if(b.headerRow===false)body.append(header);else{const head=el('thead');head.setAttribute('role','rowgroup');head.append(header);table.append(head);}
 b.rows.forEach((row,ri)=>{const tr=el('tr');tr.setAttribute('role','row');row.forEach((v,ci)=>{const cell=el(b.rowHeader&&ci===0?'th':'td');if(b.rowHeader&&ci===0)cell.scope='row';cell.setAttribute('role',b.rowHeader&&ci===0?'rowheader':'cell');const label=el('span',b.headerRow===false?`Column ${ci+1}`:b.headers[ci]||`Column ${ci+1}`,'table-cell-label');label.setAttribute('aria-hidden','true');label.dataset.column=ci;cell.append(label);cell.style.textAlign=b.formats?.[ci]==='number'?'right':'left';if(makeCell)cell.append(makeCell(v,ri,ci));else cell.append(el('span',v,'table-cell-value'));tr.append(cell);});body.append(tr);});
 table.append(body);wrap.append(table);return wrap;
}
