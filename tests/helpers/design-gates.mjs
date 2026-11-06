// Card 17: test-only CSS parsing and fail-closed design checks. No runtime dependency.
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { join,relative } from 'node:path';
import stylelint from 'stylelint';
const require=createRequire(import.meta.resolve('stylelint'));
const {parse}=require('postcss'); // stylelint's pinned, lockfile-resolved parser
export const BANDS=Object.freeze({'z-raised':'1','z-sticky':'100','z-dock':'110','z-toast':'300','z-overlay':'400'});
const TOKENS=new Set(['prototypes/room/lib/tokens.css','src/client/tokens.css']);
const fail=(what)=>{throw new Error(what);};
export function themesFrom(css){
  const light={},dark={},media={};
  parse(css).walkRules(r=>{
    const into=r.selector===':root'?light:r.selector===':root[data-theme="dark"]'?dark:null;
    if(r.selector===':root:not([data-theme="light"])'&&r.parent.type==='atrule'&&r.parent.params.replace(/\s/g,'')==='(prefers-color-scheme:dark)')r.each(d=>{if(d.type==='decl'&&d.prop.startsWith('--'))media[d.prop.slice(2)]=d.value;});
    if(into) r.each(d=>{if(d.type==='decl'&&d.prop.startsWith('--')) into[d.prop.slice(2)]=d.value;});
  });
  if(!Object.keys(light).length||!Object.keys(dark).length) fail('Both token themes must exist');
  if(Object.keys(media).length&&JSON.stringify(Object.entries(media).sort())!==JSON.stringify(Object.entries(dark).sort()))fail('System and pinned dark theme declarations differ');
  return {light,dark:{...light,...dark}};
}
function split(input){
  const parts=[];let depth=0,start=0;
  for(let i=0;i<input.length;i++){if(input[i]==='(')depth++;if(input[i]===')')depth--;if(input[i]===','&&!depth){parts.push(input.slice(start,i).trim());start=i+1;}}
  parts.push(input.slice(start).trim());return parts;
}
/** CASE-227 presentation themes: each `.slide-theme-<name>` token set over the light and dark bases, plus the derived
 *  declarations the themes share. Returns { name: { light, dark } } for slide-only contrast checks. */
export function slideThemesFrom(css,base=themesFrom(css)){
  const shared={},own={};
  parse(css).walkRules(r=>{
    const names=r.selectors.map(s=>/^\.slide-theme-([a-z]+)$/.exec(s.trim())?.[1]);
    if(names.some(n=>!n))return;
    const into=names.length>1?shared:(own[names[0]]??={});
    r.each(d=>{if(d.type==='decl'&&d.prop.startsWith('--'))into[d.prop.slice(2)]=d.value;});
  });
  if(!Object.keys(own).length)fail('No slide themes declared');
  return Object.fromEntries(Object.entries(own).map(([name,tokens])=>[name,{light:{...base.light,...shared,...tokens},dark:{...base.dark,...shared,...tokens}}]));
}
export function resolveColor(value,tokens,seen=new Set()){
  value=value.trim();
  if(/^#[a-f\d]{6}$/i.test(value)) return [1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255).concat(1);
  if(value==='transparent') return [0,0,0,0];
  const v=/^var\(--([\w-]+)(?:,\s*(.+))?\)$/.exec(value);
  if(v){if(seen.has(v[1]))fail(`Cannot resolve cyclic ${value}`);const next=new Set(seen).add(v[1]);return resolveColor(tokens[v[1]]??v[2]??fail(`Cannot resolve ${value}`),tokens,next);}
  value=value.replace(/var\(--([\w-]+)\)/g,(all,n)=>/^\d+(?:\.\d+)?%$/.test(tokens[n]??'')?tokens[n]:all);
  const m=/^color-mix\(in srgb,\s*(.+)\)$/.exec(value);
  if(m){const args=split(m[1]);if(args.length===2){const a=/^(.*)\s+(\d+(?:\.\d+)?)%$/.exec(args[0]);
    if(a){const p=Number(a[2])/100;if(p>=0&&p<=1){const x=resolveColor(a[1],tokens,seen),y=resolveColor(args[1],tokens,seen);const alpha=x[3]*p+y[3]*(1-p);return [0,1,2].map(i=>alpha?(x[i]*x[3]*p+y[i]*y[3]*(1-p))/alpha:0).concat(alpha);}}}}
  fail(`Cannot resolve ${value}`);
}
export const luminance=c=>[.2126,.7152,.0722].reduce((sum,w,i)=>sum+w*(c[i]<=.04045?c[i]/12.92:((c[i]+.055)/1.055)**2.4),0);
export const contrast=(a,b)=>{const [x,y]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return(x+.05)/(y+.05);};
const composite=(fg,bg)=>[0,1,2].map(i=>fg[i]*fg[3]+bg[i]*(1-fg[3])).concat(1);
export function checkPairs(pairs,themes){
  const results=[];
  for(const [theme,tokens] of Object.entries(themes))for(const pair of pairs){
    const context={...tokens,...pair.locals};
    const parent=resolveColor(pair.parent??'var(--surface)',context);
    const bg=composite(resolveColor(pair.bg,context),parent);
    const fg=composite(resolveColor(pair.fg,context),bg);
    const opacity=pair.opacity??1;
    const actualBg=composite([...bg.slice(0,3),opacity],parent),actualFg=composite([...fg.slice(0,3),opacity],parent);
    let ratio=contrast(actualFg,actualBg);
    // An edge pair may name its fill as an alternative: the mark is delineated by whichever of the two reads (CASE-115).
    if(pair.alt){const alt=composite(resolveColor(pair.alt,context),bg);ratio=Math.max(ratio,contrast(composite([...alt.slice(0,3),opacity],parent),actualBg));}
    if(ratio<pair.min)fail(`${pair.label} (${theme}) ${ratio.toFixed(4)}:1 under ${pair.min}:1`);
    results.push({label:pair.label,theme,ratio,min:pair.min});
  }
  return results;
}
export function checkLadder(tokens){
  const values=['sunken','ground','surface'].map(n=>({name:n,luminance:luminance(resolveColor(`var(--${n})`,tokens))}));
  for(let i=1;i<values.length;i++)if(values[i].luminance-values[i-1].luminance<.0029)fail(`dark ladder ${values[i-1].name}→${values[i].name} below 0.0029`);
  return values;
}
export function checkStacking(css,tokens){
  for(const [name,value]of Object.entries(BANDS))if(tokens[name]!==value)fail(`stacking --${name} must remain ${value}`);
  const root=parse(css);
  root.walkDecls(d=>{if(d.prop.startsWith('--z-')&&(!Object.hasOwn(BANDS,d.prop.slice(2))||BANDS[d.prop.slice(2)]!==d.value))fail(`stacking token override ${d.prop}: ${d.value}`);});
  root.walkRules(r=>{
    const decls=(r.nodes??[]).filter(n=>n.type==='decl');
    const z=decls.filter(d=>d.prop.toLowerCase()==='z-index');
    if(decls.some(d=>d.prop.toLowerCase()==='position'&&/^(fixed|sticky)$/i.test(d.value))&&!z.length)fail(`stacking ${r.selector} needs a band`);
    for(const d of z){const m=/^var\(--(z-[a-z-]+)\)$/.exec(d.value);if(!m||!Object.hasOwn(BANDS,m[1])||Number(tokens[m[1]])>=1000)fail(`stacking ${r.selector}: ${d.value}`);}
  });
}
export function classifyCss(path){
  if(TOKENS.has(path)||/^src\/client\/.+\.css$/.test(path))return{kind:'scan',reason:'Case tokens and shipped client source',tokens:TOKENS.has(path)};
  if(path==='prototypes/design/tokens.css')return{kind:'import',reason:'An @import of src/client/tokens.css (CASE-163); scripts/check-case.mjs fails if it stops being exactly that. The imported file is scanned as the token file.'};
  if(path==='prototypes/design/studio.css')return{kind:'scan',reason:'CASE-351 Studio companion surfaces; full canonical token, contrast, stacking and control coverage.'};
  if(path==='prototypes/design/case-card.css')return{kind:'scan',reason:'CASE-346 shared card study; full canonical token, contrast, stacking and control coverage without exemptions.'};
  if(path==='prototypes/design/case-ui.css')return{kind:'scan',reason:'v2 component proposal, ported into src/client by CASE-163; still scanned here against the shipped tokens, so a pair it declares cannot drift.'};
  if(path==='prototypes/design/slide-stage.css')return{kind:'scan',reason:'CASE-209 G07 slide geometry probe; scanned against canonical tokens, contrast, stacking and control rules without exemptions.'};
  if(path==='prototypes/design/builder-slide.css')return{kind:'scan',reason:'CASE-206 approved local Builder study; scanned against canonical tokens, contrast, stacking and control rules without exemptions.'};
  if(path==='prototypes/sound-stage/stage.css'||path==='prototypes/sound-stage/lab.css')return{kind:'scan',reason:'CASE-328 Card 69 audition tool; full canonical token, contrast, stacking and control coverage without exemptions.'};
  if(/^dist\/.+\.css$/.test(path))return{kind:'generated',reason:'Build output from scanned client source; card 10 validates output provenance'};
  fail(`Unclassified stylesheet ${path}`);
}
export function sourceCss(root){
  const scanned=[];
  function walk(dir){for(const f of readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','test-results','playwright-report','.wrangler'].includes(f.name))continue;const absolute=join(dir,f.name);if(f.isDirectory())walk(absolute);else if(f.name.endsWith('.css')){const path=relative(root,absolute);const info=classifyCss(path);if(info.kind==='scan')scanned.push({absolute,relative:path,...info});}}}
  walk(root);return scanned;
}

// CASE-163 (amends CASE-125): a border drawn with a hairline token is decorative on containers; on a control
// or field the border is the boundary a person must perceive, so it keeps --field-line (3:1).
const HAIRLINE=/var\(--(?:nav-)?line\b/;
const PLAIN_HAIRLINE=/^(?:[\d.]+(?:px|rem)\s+(?:solid|dashed|dotted)\s+)?var\(--(?:nav-)?line\)$/;
const BORDER_PROP=/^border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?$/;
// The subject of a selector is its last compound (what the rule styles): `details.info .info-body` styles `.info-body`.
function topLevelSplit(text,isSep){
  const out=[];let depth=0,start=0,q=null;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c===q)q=null;continue;}
    if(c==='"'||c==="'"){q=c;continue;}
    if(c==='('||c==='[')depth++;else if(c===')'||c===']')depth--;
    else if(!depth&&isSep(c)){out.push(text.slice(start,i));start=i+1;}}
  out.push(text.slice(start));return out;
}
export const subjectsOf=(selector)=>topLevelSplit(selector,c=>c===',').map(part=>topLevelSplit(part.trim(),c=>/[\s>+~]/.test(c)).filter(Boolean).pop()??'');
const CONTROL_TAG=/^(?:input|select|textarea|button|summary|details|a|label)(?![\w-])/i;
const CONTROL_ROLE=/\[\s*role\s*=\s*["']?(?:button|tab|radio|checkbox|option|switch|menuitem|textbox|combobox|slider|spinbutton|searchbox)["']?\s*\]/i;
const CONTROL_ATTR=/\[\s*contenteditable\b/i;
const CONTROL_CLASS=/\.(?:btn|iconbtn|field|[\w-]*input)(?![\w-])/;
// Remove every :not(...) (it names what a thing is not), and lift the arguments of :is()/:where() into extra subjects.
function stripFunctional(compound){
  const extra=[];let out='',i=0;
  while(i<compound.length){
    const m=/^:(not|is|where|matches|-webkit-any)\(/i.exec(compound.slice(i));
    if(!m){out+=compound[i++];continue;}
    let depth=1,j=i+m[0].length;for(;j<compound.length&&depth;j++){if(compound[j]==='(')depth++;else if(compound[j]===')')depth--;}
    const inner=compound.slice(i+m[0].length,j-1);
    if(!/^not$/i.test(m[1]))for(const arg of topLevelSplit(inner,c=>c===','))extra.push(...subjectsOf(arg));
    i=j;
  }
  return {base:out,extra};
}
export const isControlSelector=(selector)=>subjectsOf(selector).some(function test(sub){
  const {base,extra}=stripFunctional(sub);
  return CONTROL_TAG.test(base)||CONTROL_ROLE.test(base)||CONTROL_ATTR.test(base)||CONTROL_CLASS.test(base)||extra.some(test);
});
export function hairlineViolations(css,path){
  const out=[];
  parse(css).walkRules(r=>{if(!isControlSelector(r.selector))return;r.walkDecls(d=>{if(BORDER_PROP.test(d.prop)&&HAIRLINE.test(d.value))out.push(`${path} ${r.selector} { ${d.prop}: ${d.value} } uses a hairline on a control or field`);});});
  return out;
}
// CASE-163: no side or top accent rail. A rail is a border-left/top (or logical start) wider than 1px, or an inset
// one-axis box-shadow wider than 1px, in a phase, status, private or petrol colour.
const ACCENT=/var\(--(?:ph|alert|manual|ok|private|petrol|mark)(?:-[a-z]+)*\b/i;
const STYLE=/^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;
const WORD={thin:1,medium:3,thick:5};
const lengthOf=(v)=>{
  v=String(v).trim().toLowerCase();if(v in WORD)return WORD[v];
  const calc=/^calc\((.*)\)$/.exec(v);
  if(calc){const e=calc[1].replace(/(\d*\.?\d+)(?:rem|em)\b/g,(a,n)=>String(Number(n)*16)).replace(/(\d*\.?\d+)px\b/g,'$1');if(!/^[\d.\s+\-*/()]+$/.test(e))return null;try{const n=Function(`return (${e})`)();return Number.isFinite(n)?Math.abs(n):null;}catch{return null;}}
  const m=/^(-?\d*\.?\d+)(px|rem|em)?$/.exec(v);return m?Math.abs(Number(m[1]))*(m[2]==='rem'||m[2]==='em'?16:1):null;};
const words=(v)=>topLevelSplit(v.trim(),c=>/\s/.test(c)).filter(Boolean);
function substitute(v,locals){for(let i=0;i<6;i++){const n=v.replace(/var\(\s*--([\w-]+)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/gi,(all,name)=>locals[name]??all);if(n===v)break;v=n;}return v;}
const BOX=['top','right','bottom','left'];
// Logical sides are read as physical (left-to-right); a rail is a rail in either direction.
const PHYSICAL={top:['top'],right:['right'],bottom:['bottom'],left:['left'],'inline-start':['left'],'inline-end':['right'],'block-start':['top'],'block-end':['bottom'],inline:['left','right'],block:['top','bottom'],all:BOX};
const SIDE_NAMES='top|right|bottom|left|inline-start|inline-end|block-start|block-end|inline|block';
function boxValues(v){const w=words(v);const [t,r=t,b=t,l=r]=w;return {top:t,right:r,bottom:b,left:l};}
function borderSides(d){
  const W={},C={};
  const setW=(sides,v)=>{const n=lengthOf(v);for(const sd of sides)W[sd]=n??0;};
  const setC=(sides,v)=>{for(const sd of sides)C[sd]=v;};
  const shorthand=(sides,v)=>{const color=[];for(const t of words(v)){if(lengthOf(t)!==null)setW(sides,t);else if(!STYLE.test(t))color.push(t);}if(color.length)setC(sides,color.join(' '));};
  for(const [prop,value] of Object.entries(d)){
    let m;
    if(prop==='border')shorthand(BOX,value);
    else if(prop==='border-width'){const b=boxValues(value);for(const sd of BOX)setW([sd],b[sd]);}
    else if(prop==='border-color'){const b=boxValues(value);for(const sd of BOX)setC([sd],b[sd]);}
    else if((m=new RegExp(`^border-(${SIDE_NAMES})$`).exec(prop)))shorthand(PHYSICAL[m[1]],value);
    else if((m=new RegExp(`^border-(${SIDE_NAMES})-width$`).exec(prop)))setW(PHYSICAL[m[1]],words(value)[0]);
    else if((m=new RegExp(`^border-(${SIDE_NAMES})-color$`).exec(prop)))setC(PHYSICAL[m[1]],value);
  }
  return {W,C};
}
const isPseudo=(selector)=>topLevelSplit(selector,c=>c===',').every(part=>/::?(?:before|after)\s*$/i.test(part.trim()));
export function railViolations(css,path){
  const out=[];
  parse(css).walkRules(r=>{
    const raw=Object.fromEntries((r.nodes??[]).filter(n=>n.type==='decl').map(n=>[n.prop,n.value]));
    const locals=Object.fromEntries(Object.entries(raw).filter(([n])=>n.startsWith('--')).map(([n,v])=>[n.slice(2),v]));
    const d=Object.fromEntries(Object.entries(raw).map(([n,v])=>[n,substitute(v,locals)]));
    // 1. a side border wider than 1px in an accent colour whose opposite side is not equally wide (a full outline is not a rail)
    const {W,C}=borderSides(d);
    // Only a complete outline (all four sides wider than 1px in one colour) is exempt; one visible side beside a transparent or other-coloured one is still a rail.
    const outline=BOX.every(sd=>(W[sd]??0)>1&&C[sd]!==undefined&&C[sd].trim().toLowerCase()===(C.top??'').trim().toLowerCase());
    for(const side of ['left','right','top'])if(!outline&&(W[side]??0)>1&&ACCENT.test(C[side]??''))out.push(`${path} ${r.selector} has a ${W[side]}px ${side} accent rail`);
    // a hard-stop gradient stripe: linear-gradient(to <side>, <accent> Npx, transparent Npx)
    for(const g of `${d.background??''} ${d['background-image']??''}`.matchAll(/linear-gradient\(\s*(?:to\s+(?:right|left|top|bottom)|\d+deg)\s*,\s*([^,]+?)\s+(\d*\.?\d+(?:px|rem|em))\s*,\s*transparent\s+\2\s*\)/gi))
      if(ACCENT.test(g[1])&&(lengthOf(g[2])??0)>1)out.push(`${path} ${r.selector} paints a ${g[2]} hard-stop accent stripe`);
    // 2. a one-axis box-shadow offset wider than 1px with at most 1px of blur, inset or not
    for(const part of topLevelSplit(d['box-shadow']??'',c=>c===',')){
      const lengths=[],rest=[];for(const t of words(part)){const n=/^-?\d*\.?\d+(?:px|rem|em)?$/.test(t)?lengthOf(t):null;if(n!==null){lengths.push(/^-/.test(t)?-n:n);}else if(!/^inset$/i.test(t))rest.push(t);}
      const [x=0,y=0,blur=0]=lengths;
      if((x===0)!==(y===0)&&Math.max(Math.abs(x),Math.abs(y))>1&&Math.abs(blur)<=1&&ACCENT.test(rest.join(' ')))out.push(`${path} ${r.selector} has a ${x||y}px one-axis shadow rail`);
    }
    // 3. a narrow, full-height ::before/::after bar painted in an accent colour
    if(isPseudo(r.selector)&&/^(?:absolute|fixed)$/i.test(d.position??'')){
      const width=lengthOf(d.width??''),bg=d.background??d['background-color']??'';
      const inset=words(d.inset??'');const insetTB=inset.length===1?inset[0]:inset.length>=2?[inset[0],inset[2]??inset[0]]:null;
      const zero=(v)=>v!==undefined&&lengthOf(v)===0;
      const full=d.height==='100%'||(zero(d.top)&&zero(d.bottom))||(inset.length===1?zero(inset[0]):inset.length>=2&&zero(inset[0])&&zero(inset[2]??inset[0]));
      void insetTB;
      if(width!==null&&width>1&&width<=12&&full&&ACCENT.test(bg))out.push(`${path} ${r.selector} is a ${width}px full-height accent bar`);
    }
  });
  return out;
}
const SECONDARY=/var\(--(?:ink-muted|on-petrol|petrol-ink|alert-ink|on-phase|ph-[a-z]+-ink|manual-ink|ok-ink)\)/;
export function declaredPairs(css,path){
  const pairs=[];
  parse(css).walkRules(r=>{
    // Forced colours are system-colour checks in Chromium, not sRGB theme pairs.
    for(let p=r.parent;p;p=p.parent)if(p.type==='atrule'&&p.name==='media'&&p.params.replace(/\s/g,'')==='(forced-colors:active)')return;
    const d=Object.fromEntries((r.nodes??[]).filter(n=>n.type==='decl').map(n=>[n.prop,n.value]));
    const locals=Object.fromEntries(Object.entries(d).filter(([n])=>n.startsWith('--')).map(([n,v])=>[n.slice(2),v]));
    const inherited={'.btn.primary:hover:not(:disabled)':'var(--on-petrol)','.btn.tertiary:hover:not(:disabled)':'var(--petrol-ink)','details.info > summary:hover, details.info[open] > summary':'var(--petrol-ink)'};
    const fg=d.color??inherited[r.selector];
    const bg=d.background??d['background-color'];
    // A colour-only rule inherits a ground. Check every standard neutral ground instead of skipping.
    if(fg&&fg!=='inherit'&&fg!=='currentColor'){
      const min=SECONDARY.test(fg)?4.5:7;
      for(const ground of bg?[bg]:['var(--ground)','var(--surface)','var(--sunken)','var(--nav-bg)'])pairs.push({label:`${path} ${r.selector} text`,fg,bg:ground,min,locals});
    }
    // A background-only rule carries inherited body text (a ::before or ::after rule with no content, or empty content, carries none), except purely decorative avatar/QR grounds.
    if(bg&&!fg&&r.selector!=='img.avatar'&&!(isPseudo(r.selector)&&(d.content===undefined||/^(?:""|'')$/.test(d.content))))pairs.push({label:`${path} ${r.selector} inherited text`,fg:'var(--ink)',bg,min:7,locals});
    const zeroNum=(v)=>v!==undefined&&/^[+-]?(?:0*\.?0*)(?:px|rem|em|%)?$/.test(v.trim())&&/\d/.test(v);
    const strokeVisible=Boolean(d.stroke)&&!/^(?:0|none|transparent)$/i.test(d.stroke.trim())&&!zeroNum(d['stroke-width'])&&!zeroNum(d['stroke-opacity']);
    // A fill with its own stroke is delineated by that stroke (the yellow mark's dark edge, CASE-115); the stroke pair is still checked.
    const decorativeBorder=(TOKENS.has(path)&&['.card, .panel','details.info .info-body','.opt-tile'].includes(r.selector))||(path==='prototypes/design/case-ui.css'&&r.selector==='.option');
    for(const prop of ['fill','stroke','outline','outline-color','border','border-top','border-right','border-bottom','border-left','border-color','border-top-color','border-right-color','border-bottom-color','border-left-color'])if(d[prop]&&!(decorativeBorder&&prop==='border')&&!(prop==='fill'&&strokeVisible)&&!(PLAIN_HAIRLINE.test(d[prop])&&BORDER_PROP.test(prop)&&!isControlSelector(r.selector))&&!/^(0|none)$/.test(d[prop])&&!/^(?:\d+(?:px)? solid )?(?:transparent)$/.test(d[prop])){
      const inheritedPaint=['currentColor','inherit'].includes(d[prop]);
      const paint=inheritedPaint?(fg&&!['currentColor','inherit'].includes(fg)?fg:'var(--ink)'):d[prop];
      let color=(prop==='outline'||/^border(?:-(?:top|right|bottom|left))?$/.test(prop))?paint.replace(/^.*?\b(?:solid|dashed|dotted)\s+/,''):paint;
      if(/^(?:currentColor|inherit)$/i.test(color))color=fg&&!/^(?:currentColor|inherit)$/i.test(fg)?fg:'var(--ink)';
      // A border painted the same as its own fill is that fill: judge it against the surrounding grounds, not itself.
      for(const ground of bg&&bg!==color?[bg]:['var(--ground)','var(--surface)'])pairs.push({label:`${path} ${r.selector} ${prop}`,fg:color,bg:ground,min:3,locals,...(prop==='stroke'&&strokeVisible&&d.fill&&!/^(0|none)$/.test(d.fill)?{alt:d.fill}:{})});
    }
  });return pairs;
}
export function disabledPairs(css){
  let opacity=1,disabled={};
  parse(css).walkRules(r=>{if(r.selector==='.btn:disabled')r.walkDecls(d=>{disabled[d.prop]=d.value;});if(r.selector==='button:disabled')r.walkDecls('opacity',d=>{opacity=Number(d.value);});});
  opacity=Number(disabled.opacity??opacity);
  if(!Number.isFinite(opacity)||opacity<0||opacity>1)fail('Invalid disabled opacity');
  return ['var(--surface)','var(--ground)'].flatMap(parent=>[
    ['secondary','var(--petrol-ink)','var(--petrol-tint)'],['primary','var(--on-petrol)','var(--petrol)'],['tertiary','var(--petrol-ink)',parent],['danger','var(--alert-ink)',parent]
  ].map(([name,fg,bg])=>({label:`disabled ${name} on ${parent}`,fg:disabled.color??fg,bg:disabled.background??bg,parent,opacity,min:4.5})));
}
export async function lintCss(css,path){
  const root=parse(css);
  // Narrow, semantic allowlist: reduction of motion must override animation authored elsewhere.
  root.walkDecls(d=>{if(!d.important)return;const r=d.parent,p=r.parent;if(TOKENS.has(path)&&r.selector.split(',').map(s=>s.trim()).join(',')==='*,*::before,*::after'&&p.type==='atrule'&&p.name==='media'&&p.params.replace(/\s/g,'')==='(prefers-reduced-motion:reduce)'&&['animation','transition','scroll-behavior'].includes(d.prop)&&d.value=== (d.prop==='scroll-behavior'?'auto':'none'))d.important=false;});
  return stylelint.lint({ignoreDisables:true,code:root.toString(),codeFilename:path,config:{defaultSeverity:'error',rules:{'declaration-no-important':true,'property-no-unknown':true,'at-rule-disallowed-list':['import'],'color-no-hex':TOKENS.has(path)?null:true}}});
}
