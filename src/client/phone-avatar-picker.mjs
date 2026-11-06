// Independent colour/shape control. Owns selection and preview only; the phone owns saving.
import { h } from './phone-dom.mjs';
import { avatarEl } from './avatar.mjs';
import { AVATAR_URLS } from './avatar-assets.mjs';
const avatarUrl = id => AVATAR_URLS[id] ?? null;
import { AVATARS, AVATAR_COLORS, AVATAR_SHAPES, customAvatarId, avatarParts, isAvatarId } from '../shared/participant.mjs';

export function customAvatarPicker(prefix) {
  let selected = null, shapeId = AVATAR_SHAPES[0].id, colorId = AVATAR_COLORS[0].id, onPick = null;
  const preview = h('div', { class: 'preview', role: 'img', 'aria-label': 'Avatar preview' });
  const colors = [], shapes = [];
  const colorGrid = h('div', { class: 'avatars' });
  const shapeGrid = h('div', { class: 'avatars' });
  const update = () => {
    preview.replaceChildren(avatarEl(selected, { size: 64 }));
    for (const { input, color, image } of colors) { input.checked = color.id === colorId; image.src = avatarUrl(customAvatarId(shapeId, color.id)); }
    for (const { input, image, shape } of shapes) {
      input.checked = shape.id === shapeId;
      image.src = avatarUrl(customAvatarId(shape.id, colorId));
    }
  };
  const changed = () => { selected = customAvatarId(shapeId, colorId); update(); onPick?.(selected); };
  for (const color of AVATAR_COLORS) {
    const input = h('input', { type: 'radio', name: `${prefix}-color`, 'aria-label': color.label, value: color.id });
    input.addEventListener('change', () => { colorId = color.id; changed(); });
    const image = h('img', { src: avatarUrl(customAvatarId(shapeId, color.id)), alt: '', width: '48', height: '48' });
    colorGrid.append(h('label', { class: `av av-color-${color.id}` }, input, image, h('span', { text: color.label, class: 'av-color-label' })));
    colors.push({ input, color, image });
  }
  AVATAR_SHAPES.forEach((shape, index) => {
    const input = h('input', { type: 'radio', name: `${prefix}-shape`, 'aria-label': `Shape ${index + 1}: ${shape.label.split(', ')[1]}`, value: shape.id });
    const image = h('img', { alt: '', width: '48', height: '48' });
    input.addEventListener('change', () => { shapeId = shape.id; changed(); });
    shapeGrid.append(h('label', { class: 'av' }, input, image));
    shapes.push({ input, image, shape });
  });
  const root = h('div', { class: 'stack' }, preview,
    h('fieldset', {}, h('legend', { class: 'field-label', text: 'Avatar colour' }), colorGrid),
    h('fieldset', {}, h('legend', { class: 'field-label', text: 'Avatar shape' }), shapeGrid));
  return { root, value: () => selected, onPick: (fn) => { onPick = fn; }, valid: () => isAvatarId(selected),
    set(id) { const parts = avatarParts(id); if (!parts) return; selected = id; ({ shapeId, colorId } = parts); update(); } };
}


/** An avatar is optional input; the server still receives a valid, allowlisted selection. */
export function joinAvatarPicker(prefix, {randomIndex=()=>crypto.getRandomValues(new Uint32Array(1))[0] % AVATARS.length}={}) {
  let selected=null, onPick=null;
  const grid=h('div',{class:'avatars'});
  const inputs=AVATARS.map(avatar=>{
    const input=h('input',{type:'radio',name:`${prefix}-avatar`,value:avatar.id,'aria-label':avatar.label});
    input.addEventListener('change',()=>{selected=avatar.id;onPick?.(selected);});
    grid.append(h('label',{class:'av'},input,h('img',{src:avatarUrl(avatar.id),alt:'',width:'48',height:'48',decoding:'async',draggable:'false'})));
    return input;
  });
  const set=id=>{
    if (!isAvatarId(id)) return;
    selected=id;
    for (const input of inputs) input.checked=input.value===id;
  };
  const randomise=()=>{set(AVATARS[randomIndex()]?.id ?? AVATARS[0].id);onPick?.(selected);return selected;};
  grid.append(h('button',{type:'button',class:'av','aria-label':'Randomise avatar',text:'Randomise',onclick:randomise}));
  return {root:h('fieldset',{},h('legend',{class:'field-label',text:'Choose an avatar'}),grid),value:()=>selected,valid:()=>true,
    ensureSelected:()=>selected ?? randomise(),set,onPick:fn=>{onPick=fn;}};
}
