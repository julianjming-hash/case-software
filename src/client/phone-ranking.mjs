import { h } from './phone-dom.mjs';
/** Compact glyphs keep the controls in the ranked row; spoken labels describe their effect. */
export function rankingMoveControl({id,label,direction,disabled,onMove}) {
  const up=direction==='up';
  return h('button',{type:'button',class:'btn rank-move','data-act':direction,'data-id':id,
    'aria-label':`${up ? 'Move up' : 'Move down'}: ${label}`,disabled:disabled ? '' : null,onclick:onMove},
    h('span',{'aria-hidden':'true',text:up ? '↑' : '↓'}));
}

export function rankingRemoveControl({label,onRemove}) {
  return h('button',{type:'button',class:'btn rank-move','aria-label':`Remove from ranking: ${label}`,onclick:onRemove},
    h('span',{'aria-hidden':'true',text:'×'}));
}
