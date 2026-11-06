// Bounded tagged A4 writer. No external PDF library, network, storage or document mutation. J10 (card 59 M3): a
// ['FIG', { bytes, alt, caption }] row places a JPEG unchanged (/DCTDecode) as a tagged Figure with its text alternative,
// also inside a BOX (card 40b recap images). JPEG only: every still and poster rendition Case stores is JPEG.
// Card 40 (CASE integration slice 1): a structure tree (Document, Sect, H1–H3, P, L/LI, Table/TR/TH/TD, Figure, Span),
// coloured runs, boxes, simple tables, lists, vector symbols and option marks, and decorative art as Artifacts. A symbol or
// superscript is drawn as shapes or a raised digit and tagged with /ActualText, so extracted text stays exact. A character
// Montserrat lacks draws from the CaseSymbols fallback subset (arrows, comparison signs, ≈, check and cross marks), Latin
// Extended-A from Montserrat and Greek from Noto Sans: each a further font embedded only when a document uses it, with its
// own ToUnicode. A character in no font still refuses rather than substitutes. Briefing rulings (Julian, 2026-10-17): a
// text run may carry an https `href` (validated by urls.mjs; anything else refuses), drawn as its visible text plus a /Link
// annotation that a Link structure element owns (OBJR, /StructParent).
// Room PDFs v2 (Julian, 2026-10-18; prototypes/debrief-pdfs.html): Montserrat SemiBold (`bold` runs; headings by default)
// and JetBrains Mono digits (`mono` runs), each embedded only when used; letter-spaced runs (`track`); a ['PAGE', { header,
// footer }] row for the running header (CASE wordmark left, a label right, from page 2 when a cover opens page 1) and the
// three-slot footer (left · centre · "n / N"); a ['COVER', { height, draw, ground }] band across the top of page 1 (the case's
// braid as polygons from the shared renderer, mosaic.mjs pdfBand) with the CASE
// chip; rounded cards that nest one level, with an optional node on a journey rail (['RAIL'] … ['/RAIL']); tinted answer
// chips (P `chip`); two-column numbered lists (L `columns: 2`); lists with a symbol column (L `marks`); a card on the page foot (BOX `foot`); a stats strip (['STATS']); rounded-corner images. All the
// page chrome is pagination artifacts, never read as content.
import { FONT, BOLD, MONO, FALLBACK, LATIN_EXT, GREEK } from './session-pdf-font.mjs';
import { httpsHref } from '../shared/urls.mjs';
import { iconNodes } from '../shared/icons.mjs';
const FONTS=[{data:FONT,name:'MontserratRegular',flags:32,cmap:'CaseUnicode'},{data:BOLD,name:'MontserratSemiBold',flags:32,cmap:'CaseBoldUnicode'},
 {data:MONO,name:'JetBrainsMonoDigits',flags:33,cmap:'CaseMonoUnicode'},{data:FALLBACK,name:'CaseSymbols',flags:4,cmap:'CaseSymbolsUnicode'},
 {data:LATIN_EXT,name:'MontserratLatinExt',flags:4,cmap:'CaseLatinExtUnicode'},{data:GREEK,name:'NotoSansGreek',flags:4,cmap:'CaseGreekUnicode'}];
// A style's own font first (regular 0, bold 1, mono 2), then regular, then the fallback subsets.
const CHAIN=[[0,3,4,5],[1,0,3,4,5],[2,0,3,4,5]];
const enc=new TextEncoder();
const hex16=text=>'<FEFF'+[...text].map(c=>{const n=c.codePointAt(0);if(n<=65535)return n.toString(16).padStart(4,'0');const v=n-65536;return (55296+(v>>10)).toString(16)+(56320+(v&1023)).toString(16);}).join('').toUpperCase()+'>';
const concat=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const f2=n=>(Math.round(n*100)/100).toString();
/** A baseline or progressive JPEG's size and colour components, from its frame header, or null. */
export function jpegShape(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<4||bytes[0]!==255||bytes[1]!==216)return null;
 for(let i=2;i+9<bytes.length;){
  if(bytes[i]!==255)return null;const marker=bytes[i+1],length=bytes[i+2]<<8|bytes[i+3];
  if(marker>=192&&marker<=194){const height=bytes[i+5]<<8|bytes[i+6],width=bytes[i+7]<<8|bytes[i+8],components=bytes[i+9];return width&&height&&[1,3].includes(components)?{width,height,components}:null;}
  if(marker===218||length<2)return null;i+=2+length;
 }
 return null;
}
// Light-theme values of the shipped tokens (print is always light) and the shipped option-mark pigments, in mark order.
const HEX={ink:'16242a',muted:'4a5b62',petrol:'0f5566',line:'d5dddf',sunken:'e8edee',quiet:'eef2f3',tint:'e1eeef',private:'eeecf8',privateInk:'3f357d',consequence:'b5432e',
 consequenceTint:'f6e7e3',consequenceLine:'dba79d',white:'ffffff',field:'6f7f81',rail:'c9d3d5'};
const MARK=['d34b36','5e74cc','e9a51d','378862','9c61b5','21858c','ba611c','6b7b82'];
const rgb=h=>[0,2,4].map(i=>f2(parseInt(h.slice(i,i+2),16)/255)).join(' ');
const colour=c=>rgb(HEX[c]??(/^[0-9a-f]{6}$/.test(c??'')?c:HEX.ink));
// Vector shapes in a unit square (y down). p: polygon (filled unless stroked), l: polyline (stroked), c: circle.
const SHAPE={
 triangle:[['p',[[.5,.14],[.88,.82],[.12,.82]]]],diamond:[['p',[[.5,.1],[.9,.5],[.5,.9],[.1,.5]]]],circle:[['c',.5,.5,.36]],square:[['p',[[.16,.16],[.84,.16],[.84,.84],[.16,.84]]]],
 star:[['p',[[.5,.1],[.62,.37],[.92,.39],[.69,.58],[.76,.88],[.5,.72],[.24,.88],[.31,.58],[.08,.39],[.38,.37]]]],hexagon:[['p',[[.29,.13],[.71,.13],[.92,.5],[.71,.87],[.29,.87],[.08,.5]]]],
 cross:[['p',[[.38,.1],[.62,.1],[.62,.38],[.9,.38],[.9,.62],[.62,.62],[.62,.9],[.38,.9],[.38,.62],[.1,.62],[.1,.38],[.38,.38]]]],pentagon:[['p',[[.5,.1],[.9,.4],[.75,.88],[.25,.88],[.1,.4]]]],
 sound:[['c',.5,.55,.3]],defensible:[['c',.5,.55,.28,'s']],context:[['l',[[.5,.92],[.5,.55],[.2,.2]]],['l',[[.5,.55],[.8,.2]]]],unsafe:[['p',[[.5,.18],[.9,.88],[.1,.88]]]],
 terminal:[['p',[[.3,.2],[.7,.2],[.9,.55],[.7,.9],[.3,.9],[.1,.55]]]],discussion:[['p',[[.15,.2],[.85,.2],[.85,.9],[.15,.9]],'s'],['l',[[.3,.45],[.7,.45]]],['l',[[.3,.65],[.7,.65]]]],
 single:[['c',.5,.55,.32,'s'],['c',.5,.55,.14]],multi:[['p',[[.15,.2],[.85,.2],[.85,.9],[.15,.9]],'s'],['l',[[.3,.55],[.45,.72],[.72,.38]]]],
 ranking:[['l',[[.32,.88],[.32,.2]]],['l',[[.16,.36],[.32,.2],[.48,.36]]],['l',[[.68,.2],[.68,.88]]],['l',[[.52,.72],[.68,.88],[.84,.72]]]],free:[['l',[[.2,.88],[.82,.2]]],['l',[[.14,.92],[.26,.84]]]],
 cue:[['p',[[.28,.25],[.82,.55],[.28,.85]]]],join:[['l',[[.82,.25],[.82,.62],[.22,.62]]],['l',[[.4,.44],[.22,.62],[.4,.8]]]],clar:[['l',[[.5,.2],[.5,.9]]],['l',[[.15,.55],[.85,.55]]]],
 dot:[['c',.5,.55,.3,'s']],dia:[['p',[[.5,.2],[.82,.55],[.5,.9],[.18,.55]]]],rev:[['c',.5,.55,.3]],arrow:[['l',[[.12,.55],[.86,.55]]],['l',[[.62,.32],[.86,.55],[.62,.78]]]],
 unticked:[['p',[[.15,.2],[.85,.2],[.85,.9],[.15,.9]],'s']],ring:[['c',.5,.5,.32,'s']],node:[['p',[[.5,.08],[.92,.5],[.5,.92],[.08,.5]]]],
};
const MARK_SHAPE=['triangle','diamond','circle','square','star','hexagon','cross','pentagon'];
// Super- and subscript digits and signs: drawn as a raised or lowered small character, read by its /ActualText.
const SCRIPT={};[...'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'].forEach((c,i)=>SCRIPT[c]=['0123456789+−'[i],.38]);[...'₀₁₂₃₄₅₆₇₈₉₊₋'].forEach((c,i)=>SCRIPT[c]=['0123456789+−'[i],-.14]);
/** PDF path operators for one shape list placed in a box of side s at (x, top). */
function shapeOps(parts,x,top,s,fill,lineWidth=.1){
 const P=(u,v)=>`${f2(x+u*s)} ${f2(top-v*s)}`;let out=`q ${fill} rg ${fill} RG ${f2(s*lineWidth)} w 1 J 1 j `;
 for(const [kind,a,b,c,d] of parts){
  if(kind==='c'){const k=.5523*c,cx=a,cy=b;out+=`${P(cx+c,cy)} m ${P(cx+c,cy+k)} ${P(cx+k,cy+c)} ${P(cx,cy+c)} c ${P(cx-k,cy+c)} ${P(cx-c,cy+k)} ${P(cx-c,cy)} c ${P(cx-c,cy-k)} ${P(cx-k,cy-c)} ${P(cx,cy-c)} c ${P(cx+k,cy-c)} ${P(cx+c,cy-k)} ${P(cx+c,cy)} c ${d==='s'?'S':'f'} `;}
  else{out+=a.map(([u,v],i)=>`${P(u,v)} ${i?'l':'m'}`).join(' ')+(kind==='p'?(b==='s'?' h S ':' h f '):' S ');}
 }
 return out+'Q\n';
}
// Callout icons (CASE-344): Lucide's own nodes (shared/icons.mjs) on its 24-unit grid, stroked at width 2 with round caps
// and joins. A path's commands become absolute moves, lines and cubic curves (an arc as quarter-turn cubics, SVG F.6.5).
function pathSegments(d){
 const tokens=String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g)??[],out=[];
 let i=0,cmd='',x=0,y=0,sx=0,sy=0,cx=null,cy=null,qx=null,qy=null;
 const num=()=>{const n=Number(tokens[i++]);if(!Number.isFinite(n))throw new Error('pdf_input');return n;};
 const curve=(x1,y1,x2,y2,x3,y3)=>{out.push(['c',x1,y1,x2,y2,x3,y3]);cx=x2;cy=y2;x=x3;y=y3;};
 while(i<tokens.length){
  if(/[a-z]/i.test(tokens[i]))cmd=tokens[i++];else if(!cmd)throw new Error('pdf_input');
  const rel=cmd===cmd.toLowerCase(),ox=rel?x:0,oy=rel?y:0,c=cmd.toUpperCase(),was=[cx,cy,qx,qy];cx=cy=qx=qy=null;
  if(c==='Z'){out.push(['h']);x=sx;y=sy;continue;}
  if(c==='M'){x=ox+num();y=oy+num();sx=x;sy=y;out.push(['m',x,y]);cmd=rel?'l':'L';}
  else if(c==='L'){x=ox+num();y=oy+num();out.push(['l',x,y]);}
  else if(c==='H'){x=ox+num();out.push(['l',x,y]);}
  else if(c==='V'){y=oy+num();out.push(['l',x,y]);}
  else if(c==='C'){const a=[num(),num(),num(),num(),num(),num()];curve(ox+a[0],oy+a[1],ox+a[2],oy+a[3],ox+a[4],oy+a[5]);}
  else if(c==='S'){const a=[num(),num(),num(),num()],rx=was[0]===null?x:2*x-was[0],ry=was[1]===null?y:2*y-was[1];curve(rx,ry,ox+a[0],oy+a[1],ox+a[2],oy+a[3]);}
  else if(c==='Q'||c==='T'){const q=c==='Q'?[ox+num(),oy+num()]:[was[2]===null?x:2*x-was[2],was[3]===null?y:2*y-was[3]],e=[ox+num(),oy+num()];
   curve(x+2/3*(q[0]-x),y+2/3*(q[1]-y),e[0]+2/3*(q[0]-e[0]),e[1]+2/3*(q[1]-e[1]),e[0],e[1]);[qx,qy]=q;cx=cy=null;}
  else if(c==='A'){const [rx,ry,phi,fa,fs]=[num(),num(),num(),num(),num()],ex=ox+num(),ey=oy+num();arc(x,y,Math.abs(rx),Math.abs(ry),phi*Math.PI/180,fa!==0,fs!==0,ex,ey);cx=cy=null;}
  else throw new Error('pdf_input');
 }
 return out;
 function arc(x1,y1,rx,ry,phi,fa,fs,x2,y2){
  if(x1===x2&&y1===y2)return;
  if(!rx||!ry){out.push(['l',x2,y2]);x=x2;y=y2;return;}
  const co=Math.cos(phi),si=Math.sin(phi),dx=(x1-x2)/2,dy=(y1-y2)/2,xp=co*dx+si*dy,yp=-si*dx+co*dy,l=xp*xp/(rx*rx)+yp*yp/(ry*ry);
  if(l>1){rx*=Math.sqrt(l);ry*=Math.sqrt(l);}
  const num2=rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp,den=rx*rx*yp*yp+ry*ry*xp*xp,k=(fa!==fs?1:-1)*Math.sqrt(Math.max(0,num2/den));
  const cxp=k*rx*yp/ry,cyp=-k*ry*xp/rx,ccx=co*cxp-si*cyp+(x1+x2)/2,ccy=si*cxp+co*cyp+(y1+y2)/2;
  const ang=(ux,uy,vx,vy)=>Math.atan2(ux*vy-uy*vx,ux*vx+uy*vy),ux=(xp-cxp)/rx,uy=(yp-cyp)/ry;
  let t1=ang(1,0,ux,uy),dt=ang(ux,uy,(-xp-cxp)/rx,(-yp-cyp)/ry);
  if(!fs&&dt>0)dt-=2*Math.PI;if(fs&&dt<0)dt+=2*Math.PI;
  const n=Math.ceil(Math.abs(dt)/(Math.PI/2)-1e-9),step=dt/n,t=4/3*Math.tan(step/4),map=(u,v)=>[co*rx*u-si*ry*v+ccx,si*rx*u+co*ry*v+ccy];
  for(let j=0;j<n;j++){const a=t1+j*step,b=a+step,[p1x,p1y]=map(Math.cos(a)-t*Math.sin(a),Math.sin(a)+t*Math.cos(a)),[p2x,p2y]=map(Math.cos(b)+t*Math.sin(b),Math.sin(b)-t*Math.cos(b));
   out.push(['c',p1x,p1y,p2x,p2y,...(j===n-1?[x2,y2]:map(Math.cos(b),Math.sin(b)))]);}
  x=x2;y=y2;
 }
}
/** PDF stroke operators for one Lucide icon in a box of side s with its top-left corner at (x, top). */
function iconOps(nodes,x,top,s,stroke){
 const k=s/24,P=(u,v)=>`${f2(x+u*k)} ${f2(top-v*k)}`;let out=`q ${stroke} RG ${f2(2*k)} w 1 J 1 j `;
 const N=(a,key)=>{const n=Number(a[key]??0);if(!Number.isFinite(n))throw new Error('pdf_input');return n;};
 for(const [tag,a] of nodes){
  if(tag==='path')out+=pathSegments(a.d).map(([op,...v])=>op==='h'?'h':`${v.reduce((t,n,j)=>j%2?t+P(v[j-1],n)+' ':t,'')}${op}`).join(' ')+' S ';
  else if(tag==='circle'){const cx=N(a,'cx'),cy=N(a,'cy'),r=N(a,'r'),q=.5523*r;
   out+=`${P(cx+r,cy)} m ${P(cx+r,cy+q)} ${P(cx+q,cy+r)} ${P(cx,cy+r)} c ${P(cx-q,cy+r)} ${P(cx-r,cy+q)} ${P(cx-r,cy)} c ${P(cx-r,cy-q)} ${P(cx-q,cy-r)} ${P(cx,cy-r)} c ${P(cx+q,cy-r)} ${P(cx+r,cy-q)} ${P(cx+r,cy)} c S `;}
  else if(tag==='rect'){const rx0=N(a,'x'),ry0=N(a,'y'),w=N(a,'width'),h=N(a,'height'),r=Math.max(0,Math.min(N(a,'rx'),w/2,h/2)),q=r*.4477;
   out+=`${P(rx0+r,ry0)} m ${P(rx0+w-r,ry0)} l ${P(rx0+w-q,ry0)} ${P(rx0+w,ry0+q)} ${P(rx0+w,ry0+r)} c ${P(rx0+w,ry0+h-r)} l ${P(rx0+w,ry0+h-q)} ${P(rx0+w-q,ry0+h)} ${P(rx0+w-r,ry0+h)} c `+
    `${P(rx0+r,ry0+h)} l ${P(rx0+q,ry0+h)} ${P(rx0,ry0+h-q)} ${P(rx0,ry0+h-r)} c ${P(rx0,ry0+r)} l ${P(rx0,ry0+q)} ${P(rx0+q,ry0)} ${P(rx0+r,ry0)} c h S `;}
  else throw new Error('pdf_input');
 }
 return out+'Q\n';
}
/** A rounded rectangle path (PDF coordinates, y up from the bottom edge); r is clamped to fit. */
function rrect(x,y,w,h,r){
 r=Math.max(0,Math.min(r,w/2,h/2));if(!r)return `${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re `;const k=r*.4477;
 return `${f2(x+r)} ${f2(y)} m ${f2(x+w-r)} ${f2(y)} l ${f2(x+w-k)} ${f2(y)} ${f2(x+w)} ${f2(y+k)} ${f2(x+w)} ${f2(y+r)} c ${f2(x+w)} ${f2(y+h-r)} l ${f2(x+w)} ${f2(y+h-k)} ${f2(x+w-k)} ${f2(y+h)} ${f2(x+w-r)} ${f2(y+h)} c `+
  `${f2(x+r)} ${f2(y+h)} l ${f2(x+k)} ${f2(y+h)} ${f2(x)} ${f2(y+h-k)} ${f2(x)} ${f2(y+h-r)} c ${f2(x)} ${f2(y+r)} l ${f2(x)} ${f2(y+k)} ${f2(x+k)} ${f2(y)} ${f2(x+r)} ${f2(y)} c h `;
}
const paint=(fill,stroke,dash,width=.8)=>`${fill?colour(fill)+' rg ':''}${stroke?colour(stroke)+' RG '+f2(width)+' w ':''}${dash?'[3 2] 0 d ':''}`;
const paintOp=(fill,stroke)=>fill&&stroke?'B':fill?'f':'S';
// Page geometry (points): content column 48–547; the running header sits at the top, the footer at the foot.
const LEFT=48,WIDTH=499,TOP=790,TOP_HEADED=768,FOOT=66,RAIL_X=10,RAIL_INDENT=34;
const LINES=new Set(['H1','H2','H3','P']),SIZE={H1:26,H2:14,H3:11,P:10};
const ALLOWED=new Set([...LINES,'FIG','L','TABLE','BOX','SECT','/SECT','ART','DIAGRAM','GAP','PAGE','COVER','RAIL','/RAIL','STATS']);
function buildPdf(lines,{title='Teaching session record',header='',maxPages=100,maxBytes=2*1048576}={}){
 if(!Array.isArray(lines)||lines.length>30000||typeof title!=='string'||title.length>200||typeof header!=='string'||header.length>200)throw new Error('pdf_budget');
 // Each font keeps its own used-glyph map (CIDs from 1).
 const used=FONTS.map(()=>new Map());
 const glyph=(c,style=0)=>{const n=c.codePointAt(0),font=CHAIN[style].find(k=>FONTS[k].data.map[n]);if(font===undefined)throw new Error('pdf_font_unsupported');const glyphs=used[font],data=FONTS[font].data.map[n];if(!glyphs.has(c))glyphs.set(c,{font,cid:glyphs.size+1,gid:data[0],width:data[1]});return glyphs.get(c);};
 const width=(text,size,style=0,track=0)=>[...text].reduce((n,c)=>n+(SCRIPT[c]?glyph(SCRIPT[c][0],style).width*.62:glyph(c,style).width)*size/1000+track,0);
 const images=[];
 // Structure: elements are plain objects; kids are elements or {page, mcid} marked-content references.
 const doc={s:'Document',kids:[]};const elem=(s,parent,extra={})=>{const e={s,parent,kids:[],...extra};parent.kids.push(e);return e;};
 let sect=doc;
 // Page chrome: the legacy header string is the running header's right-hand label.
 const chrome={header:header?{right:header,colour:'privateInk',wordmark:false}:null,footer:null,cover:null};
 // ── layout: rows become items of fixed height; an item renders onto a page at a y (top) when placed ──
 // An item knows its column (x, w), the boxes it sits in (outermost first) and its rail, if any.
 const items=[],annots=[];
 let ctx={x:LEFT,w:WIDTH,boxes:[],rail:0},railN=0;
 const push=it=>{items.push({boxes:ctx.boxes,rail:ctx.rail,...it});return items[items.length-1];};
 const gap=h=>push({h,gap:!ctx.boxes.length,spacer:true});
 /** Runs → words: text pieces keep their style; a symbol, mark or superscript is an inline box with /ActualText. */
 function pieces(runs,base){
  const out=[];for(const r of (typeof runs==='string'?[runs]:runs)){
   const run=typeof r==='string'?{text:r}:r,size=run.size??base.size,col=run.colour??base.colour,style=run.mono?2:(run.bold??base.bold)?1:0,track=run.track??base.track??0;
   if(!(track>=0&&track<=6))throw new Error('pdf_input');
   if(run.sym||run.mark!==undefined){if(!(run.sym in SHAPE)&&!(Number.isInteger(run.mark)&&run.mark>=0)||typeof run.label!=='string'||run.label.length>200)throw new Error('pdf_input');out.push({box:true,sym:run.sym,mark:run.mark,label:run.label,size,colour:col,w:size*1.15});continue;}
   if(typeof run.text!=='string'||run.text.length>20000)throw new Error('pdf_input');
   // A linked run's pieces share one link; its Link element is made when the run is first drawn.
   const link=run.href===undefined?null:{href:httpsHref(run.href),text:run.text};if(link&&!link.href)throw new Error('pdf_input');
   for(const tok of run.text.split(/(\s+)/)){if(!tok)continue;
    if(/^\s+$/.test(tok)){out.push({space:true,w:width(' ',size,style,track),size,style,track,link});continue;}
    // A word is split into plain text and raised or lowered script characters, each measured exactly.
    let buf='';const flush=()=>{if(buf){out.push({text:buf,size,colour:col,style,track,w:width(buf,size,style,track),link});buf='';}};
    for(const c of tok){if(SCRIPT[c]){flush();out.push({text:SCRIPT[c][0],actual:c,sup:true,size:size*.62,rise:size*SCRIPT[c][1],colour:col,style,track:0,w:width(c,size,style)});}else buf+=c;}
    flush();out.push({join:true});
   }
  }
  return out;
 }
 /** Greedy line breaking within maxW; a word longer than a line breaks by character. */
 function breakLines(ps,maxW){
  const lines=[];let line=[],w=0;
  // A soft break (between words) keeps a zero-width space at the line's end, so extracted text keeps the word boundary.
  const push=(soft=false)=>{while(line.length&&line[line.length-1].space)line.pop();if(line.length){if(soft){const t=line[line.length-1];line.push({space:true,w:0,size:t.size,style:t.style,track:0,link:t.link});}lines.push(line);}line=[];w=0;};
  let word=[],ww=0;const place=()=>{if(!word.length)return;if(w+ww>maxW&&line.length)push(true);
   if(ww>maxW){for(const p of word){if(p.text&&!p.sup){for(const c of p.text){const cw=width(c,p.size,p.style,p.track);if(w+cw>maxW&&line.length)push();line.push({...p,text:c,w:cw});w+=cw;}}else{if(w+p.w>maxW&&line.length)push();line.push(p);w+=p.w;}}}
   else{line.push(...word);w+=ww;}word=[];ww=0;};
  for(const p of ps){if(p.join){place();continue;}if(p.space){place();if(line.length){line.push(p);w+=p.w;}continue;}word.push(p);ww+=p.w;}
  place();push();return lines;
 }
 const lineW=line=>line.reduce((n,p)=>n+p.w,0);
 const lineH=(line,lead)=>Math.max(...line.map(p=>(p.sup?p.size/.62:p.size)))*lead;
 /** Paragraph-like text into line items under one structure element. */
 function textItems(owner,runs,{size,colour='ink',bold=false,track=0,x=0,keep=false,lead=1.5,chip=null}){
  const pad=chip?[4,8]:[0,0],ls=breakLines(pieces(runs,{size,colour,bold,track}),ctx.w-x-pad[1]*2),X=ctx.x+x;
  if(chip){
   // A chip is one unbreakable item: a tinted rounded block as wide as its widest line.
   const hs=ls.map(l=>lineH(l,1.4)),h=hs.reduce((a,b)=>a+b,0)+pad[0]*2,cw=Math.max(...ls.map(lineW))+pad[1]*2;
   push({h:h+2,keep,render:(pg,top)=>{pg.under.push(`/Artifact BMC\nq ${paint(chip)}${rrect(X,top-h,cw,h,5)}f Q\nEMC\n`);let y=top-pad[0];ls.forEach((line,i)=>{drawLine(pg,owner,line,X+pad[1],y-hs[i]*.76);y-=hs[i];});}});
   return ls.length;
  }
  ls.forEach((line,i)=>{const h=lineH(line,lead);push({h,keep:keep&&i===ls.length-1,render:(pg,top)=>drawLine(pg,owner,line,X,top-h*.75)});});
  return ls.length;
 }
 function drawLine(pg,owner,line,x,base){
  // Words and the spaces between them go into one text-showing string per style, so extracted text keeps its spaces.
  // A linked piece's marked content belongs to its Link element; each drawn stretch of a link is one annotation box.
  let cx=x,run=null,seg=null;
  const flush=()=>{if(seg){run.ops+=textOps(seg.text,seg.size,colour(seg.colour),seg.x,base,seg.style,seg.track);seg=null;}};
  const close=()=>{flush();if(run){pg.ops.push(`/${run.own.s} <</MCID ${run.mcid}>> BDC\n${run.ops}EMC\n`);
   if(run.link){const a={link:run.link,page:pages.length-1,rect:[run.x,base-run.size*.25,cx,base+run.size*.85]};annots.push(a);pg.annots.push(a);run.own.kids.push({annot:a});}run=null;}};
  for(const p of line){
   const own=p.link?(p.link.el??=elem('Link',owner)):owner;
   if(p.box||p.sup){close();const span=elem('Span',own,{actual:p.box?p.label:p.actual}),mcid=pg.mark(span);
    const ops=p.box?(p.sym?shapeOps(SHAPE[p.sym],cx+p.size*.05,base+p.size*.82,p.size,colour(p.colour)):markOps(p.mark,cx+p.size*.05,base+p.size*.82,p.size))
     :textOps(p.text,p.size,colour(p.colour),cx,base+p.rise,p.style);
    pg.ops.push(`/Span <</MCID ${mcid}>> BDC\n${ops}EMC\n`);cx+=p.w;continue;}
   if(run&&run.own!==own)close();
   if(!run)run={own,link:p.link,mcid:pg.mark(own),ops:'',x:cx,size:0};
   run.size=Math.max(run.size,p.size);
   const text=p.space?' ':p.text,col=p.space?(seg?.colour??'ink'):p.colour,style=p.space?(seg?.style??p.style):p.style,track=p.space?(seg?.track??p.track):p.track;
   if(seg&&seg.size===p.size&&seg.colour===col&&seg.style===style&&seg.track===track)seg.text+=text;else{flush();seg={text,size:p.size,colour:col,style,track,x:cx};}
   cx+=p.w;
  }
  close();
 }
 const markOps=(i,x,top,s)=>{const fill=rgb(MARK[i%MARK.length]);const r=s*.18,R=(u,v)=>`${f2(x+u)} ${f2(top-v)}`;
  return `q ${fill} rg ${R(r,0)} m ${R(s-r,0)} l ${R(s,r)} l ${R(s,s-r)} l ${R(s-r,s)} l ${R(r,s)} l ${R(0,s-r)} l ${R(0,r)} l h f Q\n`+shapeOps(SHAPE[MARK_SHAPE[i%MARK_SHAPE.length]],x+s*.18,top-s*.18,s*.64,rgb('ffffff'));};
 // ── rows ──
 let boxN=0;
 function row(line){
  if(!Array.isArray(line)||!ALLOWED.has(line[0]))throw new Error('pdf_input');
  const [role,v]=line,inBox=ctx.boxes.length>0;
  if(LINES.has(role)){
   const spec=typeof v==='string'?{runs:v}:v;if(!spec||typeof spec!=='object'||(typeof v==='string'&&v.length>20000))throw new Error('pdf_input');
   const size=spec.size??SIZE[role],heading=role!=='P';
   if(role==='H2'&&!inBox)gap(10);
   textItems(elem(role,sect),spec.runs,{size,colour:spec.colour??'ink',bold:spec.bold??heading,track:spec.track??0,x:spec.indent??0,keep:heading||Boolean(spec.keep),lead:role==='H1'?1.2:1.5,chip:spec.chip??null});
   gap(inBox?(heading?3:2):role==='H1'?2:role==='P'?4:6);return;
  }
  if(role==='GAP'){if(!(v>=0&&v<=200))throw new Error('pdf_input');gap(v);return;}
  if(role==='SECT'){sect=elem('Sect',doc);if(v?.title)row(['H2',v.title]);return;}
  if(role==='/SECT'){sect=doc;return;}
  if(role==='PAGE'){
   // Page chrome: { header: { right, colour, wordmark }, footer: { left, centre } }. Text only; it is never content.
   const ok=t=>t===undefined||(typeof t==='string'&&t.length<=200);
   if(!v||typeof v!=='object'||!ok(v.header?.right)||!ok(v.footer?.left)||!ok(v.footer?.centre))throw new Error('pdf_input');
   if(v.header)chrome.header={right:v.header.right??'',colour:v.header.colour??'muted',wordmark:v.header.wordmark!==false};
   if(v.footer)chrome.footer={left:v.footer.left??'',centre:v.footer.centre??''};
   return;
  }
  if(role==='COVER'){
   // The band across the top of page 1: the case's braid as tesserae (the shared renderer's pdfBand), on its grout, then the CASE chip.
   const hex=c=>typeof c==='string'&&/^[0-9a-f]{6}$/.test(c);
   if(items.length||chrome.cover||!v||!(v.height>=40&&v.height<=260)||!Array.isArray(v.draw)||v.draw.length>8000||(v.ground!==undefined&&!hex(v.ground))||
    !v.draw.every(d=>hex(d?.fill)&&Array.isArray(d.poly)&&d.poly.length>=3&&d.poly.length<=12&&d.poly.every(q=>Array.isArray(q)&&q.length===2&&q.every(Number.isFinite))))throw new Error('pdf_input');
   chrome.cover={height:v.height,draw:v.draw,ground:v.ground??'eef2f3',grout:Math.min(3,Math.max(0,Number(v.groutWidth)||0)),chip:v.chip!==false};return;
  }
  if(role==='RAIL'){if(ctx.rail||inBox)throw new Error('pdf_input');ctx={...ctx,x:ctx.x+RAIL_INDENT,w:ctx.w-RAIL_INDENT,rail:++railN};return;}
  if(role==='/RAIL'){if(!ctx.rail||inBox)throw new Error('pdf_input');ctx={...ctx,x:ctx.x-RAIL_INDENT,w:ctx.w+RAIL_INDENT,rail:0};return;}
  if(role==='L'){
   if(!v||!Array.isArray(v.items)||v.items.length>500||![undefined,1,2].includes(v.columns))throw new Error('pdf_input');const L=elem('L',sect),size=v.size??10;
   // Labels: "1." (ordered), "01" in petrol mono (labels: 'nn'), a symbol per item (marks: [{sym,label,colour}], e.g. a ticked or
   // empty box) in its own column so wrapped lines hang clear of it, or a bullet.
   const mk=v.marks===undefined?null:v.marks;if(mk&&(!Array.isArray(mk)||mk.length!==v.items.length||v.columns===2||!mk.every(m=>m&&typeof m==='object'&&m.sym&&m.text===undefined)))throw new Error('pdf_input');
   const label=n=>v.labels==='nn'?String(n+1).padStart(2,'0'):`${n+1}.`,lw=v.labels==='nn'?24:v.labels==='none'?0:14;
   if(v.columns===2){
    const colW=(ctx.w-18)/2,X=ctx.x;
    for(let n=0;n<v.items.length;n+=2){
     const cells=v.items.slice(n,n+2).map((it,k)=>{const li=elem('LI',L),lbl=lw?elem('Lbl',li):null,body=elem('LBody',li);
      return {lbl,body,n:n+k,ls:breakLines(pieces(it,{size,colour:'ink'}),colW-lw)};});
     const h=Math.max(...cells.map(c=>c.ls.length))*size*1.5+(v.tight?2:8);
     push({h,render:(pg,top)=>cells.forEach((c,k)=>{const x=X+k*(colW+18),t=label(c.n);
      if(lw)drawLine(pg,c.lbl,[{text:t,size:size*.92,colour:'petrol',style:v.labels==='nn'?2:0,track:0,w:width(t,size*.92,v.labels==='nn'?2:0)}],x,top-size*1.5*.75);
      c.ls.forEach((line,i)=>drawLine(pg,c.body,line,x+lw,top-size*1.5*(i+.75)));})});
    }
    gap(4);return;
   }
   v.items.forEach((it,n)=>{const li=elem('LI',L),body=elem('LBody',li),X=ctx.x;
    if(mk){const lbl=elem('Lbl',li),p=pieces([mk[n]],{size,colour:'ink'});push({h:0,render:(pg,top)=>drawLine(pg,lbl,p,X,top-size*1.5*.75)});}
    else if(v.ordered||v.labels==='nn'){const lbl=elem('Lbl',li),t=label(n),st=v.labels==='nn'?2:0,col=v.labels==='nn'?'petrol':'muted';push({h:0,render:(pg,top)=>drawLine(pg,lbl,[{text:t,size,colour:col,style:st,track:0,w:width(t,size,st)}],X,top-size*1.5*.75)});}
    else push({h:0,render:(pg,top)=>pg.ops.push(`/Artifact BMC\n${shapeOps([['c',.5,.5,.22]],X+1.5,top-size*.4,size*.75,colour('muted'))}EMC\n`)});
    textItems(body,it,{size,x:mk?size*1.15+5:v.ordered||v.labels==='nn'?lw:14});if(v.loose)gap(3);});
   gap(4);return;
  }
  if(role==='STATS'){
   // A strip of large figures, each with its word under it; each is one paragraph to a reader ("62 min Time spent").
   if(!v||!Array.isArray(v.items)||!v.items.length||v.items.length>4||v.items.some(s=>typeof s?.value!=='string'||typeof s?.label!=='string'||s.value.length>40||s.label.length>80))throw new Error('pdf_input');
   const cw=ctx.w/v.items.length,X=ctx.x,cells=v.items.map(s=>({el:elem('P',sect),v:breakLines(pieces([{text:s.value,bold:true}],{size:20,colour:v.colour??'petrol'}),cw-12)[0]??[],
    lab:elem('P',sect),l:breakLines(pieces(s.label,{size:8.5,colour:'muted'}),cw-12)}));
   const h=30+Math.max(...cells.map(c=>c.l.length))*12;
   push({h:h+4,render:(pg,top)=>cells.forEach((c,k)=>{const x=X+k*cw;if(k)pg.under.push(`/Artifact BMC\nq ${colour('line')} RG .6 w ${f2(x-6)} ${f2(top-4)} m ${f2(x-6)} ${f2(top-h+2)} l S Q\nEMC\n`);
    drawLine(pg,c.el,c.v,x,top-21);c.l.forEach((line,i)=>drawLine(pg,c.lab,line,x,top-34-i*12));})});
   gap(6);return;
  }
  if(role==='TABLE'){
   if(!v||!Array.isArray(v.rows)||!Array.isArray(v.cols)||v.rows.length>2000)throw new Error('pdf_input');
   const W=ctx.w,X=ctx.x,total=v.cols.reduce((a,b)=>a+b,0),xs=[];let acc=0;for(const c of v.cols){xs.push(acc*W/total);acc+=c;}const ws=v.cols.map(c=>c*W/total-8);
   const T=elem('Table',sect),size=v.size??9.5,rules=v.rules!==false,padY=v.pad??6;
   for(const [ri,cells] of [...(v.head?[v.head]:[]),...v.rows].entries()){
    const head=Boolean(v.head)&&ri===0,TR=elem('TR',T);
    const laid=cells.map((cell,ci)=>{const C=elem(head?'TH':'TD',TR,head?{scope:'Column'}:{});
     if(cell&&typeof cell==='object'&&cell.bar){const {value,total:t,colour:c}=cell.bar;if(!(t>0&&value>=0&&value<=t))throw new Error('pdf_input');return {C,bar:{f:value/t,c},h:size*1.55};}
     const align=cell&&typeof cell==='object'&&cell.align==='end'?'end':null;
     const ls=breakLines(pieces(cell?.runs??(typeof cell==='string'?cell:''),{size:head?size*.88:size,colour:head?'muted':'ink',bold:head||(v.boldFirst&&ci===0)}),ws[ci]);return {C,ls,align,h:Math.max(1,ls.length)*size*1.5};});
    const h=Math.max(...laid.map(l=>l.h))+padY;
    push({h,keep:head,render:(pg,top)=>{
     laid.forEach((l,ci)=>{const x=X+xs[ci];
      if(l.bar){const y=top-h/2-2.5,bw=ws[ci],fw=Math.max(l.bar.f?5:0,bw*l.bar.f);pg.ops.push(`/Artifact BMC\nq ${colour('sunken')} rg ${rrect(x,y,bw,5,2.5)}f ${fw?`${colour(l.bar.c)} rg ${rrect(x,y,fw,5,2.5)}f `:''}Q\nEMC\n`);return;}
      l.ls.forEach((line,k)=>drawLine(pg,l.C,line,l.align==='end'?x+ws[ci]-lineW(line):x,top-padY/2-size*(1.5*k+1.1)));});
     if(rules)pg.ops.push(`/Artifact BMC\nq ${colour('line')} RG .6 w ${f2(X)} ${f2(top-h)} m ${f2(X+W)} ${f2(top-h)} l S Q\nEMC\n`);}});
   }
   gap(6);return;
  }
  if(role==='BOX'){
   if(ctx.boxes.length>1||!v||!Array.isArray(v.rows)||v.rows.length>500)throw new Error('pdf_input');
   const pad=v.pad??(inBox?8:12),b={id:++boxN,depth:ctx.boxes.length,x:ctx.x,w:ctx.w,fill:v.fill??'quiet',stroke:v.stroke??null,dash:Boolean(v.dash),pad,r:v.radius??(inBox?6:10),
    node:v.node??null,rail:ctx.rail,first:null};
   if(b.node&&(!ctx.rail||inBox||!(b.node.sym in SHAPE)))throw new Error('pdf_input');
   // A callout's icon (CASE-344, BOX `icon`): decorative, an Artifact beside the rows, which carry the meaning.
   // 'none', or a newer build's icon this writer does not know, draws no icon rather than refusing the record.
   if(v.icon!==undefined&&typeof v.icon!=='string')throw new Error('pdf_input');
   const icon=v.icon===undefined?null:iconNodes(v.icon),iconSize=icon?(v.iconSize??16):0,iconW=icon?iconSize+8:0;
   if(icon&&!(iconSize>=6&&iconSize<=40))throw new Error('pdf_input');
   const outer=ctx;
   // The top padding keeps with the first row and the bottom padding is dropped at a page foot, so no page holds padding alone.
   const start=push({h:pad,keep:true,boxes:[...outer.boxes,b]});ctx={...outer,x:outer.x+pad+iconW,w:outer.w-pad*2-iconW,boxes:[...outer.boxes,b]};
   const from=items.length;for(const r of v.rows)row(r);
   while(items.length>from&&items[items.length-1].h&&!items[items.length-1].render&&items[items.length-1].boxes.at(-1)===b)items.pop();
   push({h:pad,tail:true});ctx=outer;
   // A short card is kept whole on one page; a long one may break between its rows.
   const whole=items.slice(items.indexOf(start)).reduce((n,it)=>n+it.h,0);if(whole<=(inBox?200:300))start.need=whole;
   // Centred on a card kept whole; on a long card that may break, level with its first line.
   if(icon){const X=b.x+pad,mid=start.need===whole?whole/2:pad+iconSize/2;start.render=(pg,top)=>pg.ops.push(`/Artifact BMC\n${iconOps(icon,X,top-mid+iconSize/2,iconSize,colour('ink'))}EMC\n`);}
   // A foot card (BOX `foot: true`, a document's last row) sits on the page's foot, just above the footer, kept whole.
   if(v.foot){if(inBox||ctx.rail||whole>300)throw new Error('pdf_input');start.foot=whole;}
   gap(inBox?4:8);return;
  }
  if(role==='ART'||role==='DIAGRAM'){
   if(!v||!Array.isArray(v.draw)||v.draw.length>4000||!(v.height>0&&v.height<=700)||(role==='DIAGRAM'&&(typeof v.alt!=='string'||!v.alt||v.alt.length>2000)))throw new Error('pdf_input');
   const fig=role==='DIAGRAM'?elem('Figure',sect,{alt:v.alt}):null,X=ctx.x;
   push({h:v.height,render:(pg,top)=>{
    let ops='';for(const d of v.draw){
     if(d.rect){const [x,y,w,h]=d.rect;ops+=`q ${paint(d.fill,d.stroke,d.dash,d.width)}${rrect(X+x,top-y-h,w,h,d.r??0)}${paintOp(d.fill,d.stroke)} Q\n`;}
     else if(d.line){ops+=`q ${colour(d.stroke??'line')} RG ${f2(d.width??1)} w ${d.dash?'[3 2] 0 d ':''}1 J ${d.line.map(([x,y],i)=>`${f2(X+x)} ${f2(top-y)} ${i?'l':'m'}`).join(' ')} S Q\n`;}
     else if(d.sym){if(!(d.sym in SHAPE))throw new Error('pdf_input');ops+=shapeOps(SHAPE[d.sym],X+d.x,top-d.y,d.size??10,colour(d.colour));}
     else if(Number.isInteger(d.mark))ops+=markOps(d.mark,X+d.x,top-d.y,d.size??10);
     else if(typeof d.text==='string'){if(d.text.length>300)throw new Error('pdf_input');const st=d.mono?2:d.bold?1:0,size=d.size??8,tw=width(d.text,size,st,d.track??0);
      ops+=textOps(d.text,size,colour(d.colour??'muted'),X+d.x-(d.align==='end'?tw:d.align==='middle'?tw/2:0),top-d.y,st,d.track??0);}
     else throw new Error('pdf_input');
    }
    pg.ops.push(fig?`/Figure <</MCID ${pg.mark(fig)}>> BDC\n${ops}EMC\n`:`/Artifact BMC\n${ops}EMC\n`);}});
   gap(6);return;
  }
  // FIG: a JPEG, unchanged, as a tagged Figure with rounded corners, kept with its caption; also inside a box (the recap's
  // stops), and the same bytes placed twice are one image object.
  const figure=v,shape=jpegShape(figure?.bytes);let k=images.findIndex(i=>i.bytes===figure?.bytes);
  if(!shape||typeof figure.alt!=='string'||figure.alt.length>300||typeof figure.caption!=='string'||figure.caption.length>400||k<0&&images.length>=64)throw new Error('pdf_input');
  const maxH=Math.min(420,figure.maxHeight??300),scale=Math.min(1,ctx.w/shape.width,maxH/shape.height),w=shape.width*scale,h=shape.height*scale,fig=elem('Figure',sect,{alt:figure.alt}),X=ctx.x;
  if(k<0)k=images.push({...shape,bytes:figure.bytes})-1;
  push({h:h+6,keep:Boolean(figure.caption),render:(pg,top)=>{pg.images.add(k);pg.ops.push(`/Figure <</MCID ${pg.mark(fig)}>> BDC\nq ${rrect(X,top-h,w,h,6)}W n ${f2(w)} 0 0 ${f2(h)} ${f2(X)} ${f2(top-h)} cm /Im${k} Do Q\nEMC\n`);}});
  if(figure.caption)row(['P',{runs:figure.caption,colour:'muted',size:8.5}]);
 }
 for(const line of lines)row(line);
 if(ctx.rail||ctx.boxes.length)throw new Error('pdf_input');
 // ── pagination: items never shrink; a heading keeps with the next item; a short card keeps whole ──
 const pages=[];let pg=null,y=0,top0=TOP;
 const newPage=()=>{if(pages.length>=maxPages)throw new Error('pdf_page_budget');
  pg={ops:[],under:[],annots:[],images:new Set(),boxes:new Map(),rails:new Map(),parents:[],mark(e){const m=this.parents.length;this.parents.push(e);e.kids.push({page:pages.length-1,mcid:m});return m;}};
  pages.push(pg);top0=y=pages.length===1&&chrome.cover?842-chrome.cover.height-30:chrome.header?.wordmark?TOP_HEADED:TOP;};
 newPage();
 for(let i=0;i<items.length;i++){
  const it=items[i];if(it.gap&&y===top0)continue;
  // A kept item (a heading, a kicker, a card's top padding) needs room for itself and the next real item; spacing in between
  // counts, and a chain of kept items (a section heading, then a chapter kicker, then a card) moves as one.
  let need=it.need??it.h;
  if(it.keep&&it.need===undefined)for(let j=i+1;j<items.length;j++){const n=items[j];if(n.spacer||!n.h&&!n.render){need+=n.h;continue;}if(!n.h)continue;
   need+=n.need??n.h;if(!(n.keep&&n.need===undefined)||need>500)break;}
  if(it.foot!==undefined){if(y-it.foot<FOOT)newPage();y=FOOT+it.foot+.01;}
  if((it.tail||it.spacer)&&y-need<FOOT)continue;
  if(y-need<FOOT&&y<top0)newPage();
  if(it.render)it.render(pg,y);
  for(const b of it.boxes){const s=pg.boxes.get(b.id)??{b,top:y,bottom:y,first:b.first===null};if(b.first===null)b.first=pages.length-1;s.bottom=y-it.h;pg.boxes.set(b.id,s);}
  if(it.rail&&it.h){const s=pg.rails.get(it.rail)??{top:y,bottom:y};s.bottom=y-it.h;pg.rails.set(it.rail,s);}
  y-=it.h;
 }
 // Under each page's content: rail lines, card fills (outer before inner), then each card's rail node on its first page.
 for(const p of pages){
  for(const {top,bottom} of p.rails.values())p.under.unshift(`/Artifact BMC\nq ${colour('rail')} RG 1.2 w ${LEFT+RAIL_X} ${f2(top)} m ${LEFT+RAIL_X} ${f2(bottom)} l S Q\nEMC\n`);
  const segs=[...p.boxes.values()].sort((a,c)=>a.b.depth-c.b.depth);
  p.under.unshift(...segs.map(({b,top,bottom})=>`/Artifact BMC\nq ${paint(b.fill,b.stroke,b.dash)}${rrect(b.x,bottom,b.w,top-bottom,b.r)}${paintOp(b.fill,b.stroke)} Q\nEMC\n`));
  for(const {b,top,first} of segs)if(b.node&&first){const s=b.node.size??11,cx=LEFT+RAIL_X,cy=top-b.pad-s*.55;
   p.under.push(`/Artifact BMC\nq 1 1 1 rg ${f2(cx-s*.75)} ${f2(cy-s*.75)} ${f2(s*1.5)} ${f2(s*1.5)} re f Q\n${shapeOps(SHAPE[b.node.sym],cx-s/2,cy+s/2,s,colour(b.node.colour??'ink'),.14)}EMC\n`);}
 }
 // Footer and header characters are measured before the fonts' used-glyph maps are finalized.
 const foot=chrome.footer,folio=(i,n)=>foot?`${i+1} / ${n}`:`Page ${i+1} of ${n}`;
 const fit=(t,max,size)=>{if(!t||width(t,size)<=max)return t;let s=t;while(s&&width(s+'…',size)>max)s=s.slice(0,-1);return s.trimEnd()+'…';};
 for(let i=0;i<pages.length;i++)width(folio(i,pages.length),8);
 const footLeft=foot?fit(foot.left,170,7.5):'',footCentre=foot?fit(foot.centre,200,7.5):'',headRight=chrome.header?fit(chrome.header.right,330,8):'';
 if(chrome.cover?.chip||chrome.header?.wordmark)width('CASE',8,1);
 // ── serialize ──
 const objects=[null],reserve=()=>{objects.push(null);return objects.length-1;},set=(id,value)=>objects[id]=typeof value==='string'?enc.encode(value):value;
 // A stream object stays a marker until assembly, so the deflated variant can compress it (an image stays its own bytes).
 const stream=bytes=>({stream:true,dict:'',data:bytes});
 const catalog=reserve(),pagesId=reserve(),structure=reserve(),parentTree=reserve(),info=reserve();
 // A font's objects exist only when some character used it.
 const embedded=[],fontIds=[],fontObjs=[];for(let k=0;k<FONTS.length;k++)if(used[k].size){embedded.push(k);fontIds.push(reserve());fontObjs.push([reserve(),reserve(),reserve(),reserve(),reserve()]);}
 fontIds.forEach((fontId,i)=>{
  const k=embedded[i],[cidFont,descriptor,fontFile,cidMap,unicode]=fontObjs[i],{data,name,flags,cmap:cmapName}=FONTS[k],glyphs=used[k];
  const fontBytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));
  set(fontFile,{stream:true,dict:` /Length1 ${fontBytes.length}`,data:fontBytes});
  const mapping=new Uint8Array((glyphs.size+1)*2);for(const g of glyphs.values()){mapping[g.cid*2]=g.gid>>8;mapping[g.cid*2+1]=g.gid&255;}set(cidMap,stream(mapping));
  const cmap=[...glyphs].map(([c,g])=>`<${g.cid.toString(16).padStart(4,'0')}> ${hex16(c).replace('FEFF','')}`);
  let cmapText=`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /${cmapName} def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n`;
  for(let i=0;i<cmap.length;i+=100){const rows=cmap.slice(i,i+100);cmapText+=`${rows.length} beginbfchar\n${rows.join('\n')}\nendbfchar\n`;}cmapText+='endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';set(unicode,stream(enc.encode(cmapText)));
  set(descriptor,`<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} /FontBBox [${data.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${data.ascent} /Descent ${data.descent} /CapHeight 700 /StemV ${k===1?120:80} /FontFile2 ${fontFile} 0 R >>`);
  set(cidFont,`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${cidMap} 0 R /DW 1000 /W [${[...glyphs.values()].map(g=>`${g.cid} [${g.width}]`).join(' ')}] >>`);
  set(fontId,`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${unicode} 0 R >>`);
 });
 const fontResources=fontIds.map((id,i)=>`/F${embedded[i]+1} ${id} 0 R`).join(' ');
 const imageIds=images.map(image=>{const ref=reserve();set(ref,concat([enc.encode(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.components===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`),image.bytes,enc.encode('\nendstream')]));return ref;});
 const pageIds=pages.map(()=>reserve());for(const a of annots)a.id=reserve();
 // Structure elements get object ids depth-first, then serialize with their marked-content references.
 const ids=new Map();const assign=e=>{ids.set(e,reserve());for(const k of e.kids)if(k.s)assign(k);};assign(doc);
 const attrs=e=>(e.alt?` /Alt ${hex16(e.alt)}`:'')+(e.actual!==undefined?` /ActualText ${hex16(e.actual)}`:'')+(e.scope?` /A << /O /Table /Scope /${e.scope} >>`:'');
 for(const [e,id] of ids)set(id,`<< /Type /StructElem /S /${e.s}${attrs(e)} /P ${e.parent?ids.get(e.parent):structure} 0 R /K [${e.kids.map(k=>k.s?`${ids.get(k)} 0 R`:k.annot?`<< /Type /OBJR /Obj ${k.annot.id} 0 R /Pg ${pageIds[k.annot.page]} 0 R >>`:`<< /Type /MCR /Pg ${pageIds[k.page]} 0 R /MCID ${k.mcid} >>`).join(' ')}] >>`);
 // The CASE wordmark as the app draws it (site-header.mjs, site.css): four tesserae, petrol, muted, ink and petrol, beside the
 // letter-spaced word in ink, the tile square centred on the capitals (Montserrat's cap height is .70 em).
 const wordmark=(x,base,size)=>{const s=size*.48,g=size*.14,top=base+size*.35+(2*s+g)/2;let o='q ';
  for(const [u,v,c] of [[0,0,'petrol'],[1,0,'muted'],[0,1,'ink'],[1,1,'petrol']])o+=`${colour(c)} rg ${f2(x+u*(s+g))} ${f2(top-v*(s+g)-s)} ${f2(s)} ${f2(s)} re f `;
  return o+`Q\n`+textOps('CASE',size,colour('ink'),x+2*s+g+size*.5,base,1,size*.16);};
 const wordmarkW=size=>size*1.1+size*.5+width('CASE',size,1,size*.16)-size*.16;
 const nums=[];
 for(const [p,page] of pages.entries()){
  const content=reserve();let chromeOps='';
  if(p===0&&chrome.cover){const c=chrome.cover,op=c.grout?'B':'f';let art=`0 ${f2(842-c.height)} 595 ${f2(c.height)} re W n ${colour(c.ground)} rg 0 ${f2(842-c.height)} 595 ${f2(c.height)} re f ${c.grout?`${colour(c.ground)} RG ${f2(c.grout)} w 1 j `:''}`,last=null;
    for(const d of c.draw){if(d.fill!==last){art+=`${colour(d.fill)} rg `;last=d.fill;}art+=d.poly.map(([x,yy],i)=>`${f2(x)} ${f2(842-yy)} ${i?'l':'m'}`).join(' ')+` h ${op} `;}
   chromeOps+=`/Artifact BMC\nq ${art}Q\n${c.chip?`q ${colour('white')} rg ${rrect(LEFT-4,842-46,wordmarkW(9)+20,26,7)}f Q\n${wordmark(LEFT+6,809-9*.35,9)}`:''}EMC\n`;}
  // Page 1 under a cover carries the header label too, as a chip at the band's right (ruling 4: every page names its reader).
  if(p===0&&chrome.cover&&headRight){const w=width(headRight,8)+16;chromeOps+=`/Artifact << /Type /Pagination /Subtype /Header >> BDC\nq ${colour('white')} rg ${rrect(LEFT+WIDTH+4-w,842-46,w,26,7)}f Q\n${textOps(headRight,8,colour(chrome.header.colour),LEFT+WIDTH+12-w,842-36)}EMC\n`;}
  if(chrome.header&&(p>0||!chrome.cover)){const h=chrome.header;
   // The wordmark and rule are plain artifacts; the label is the page's Header, alone, so it reads back as exactly itself.
   if(h.wordmark)chromeOps+=`/Artifact BMC\n${wordmark(LEFT,808,8)}q ${colour('line')} RG .6 w ${LEFT} 796 m ${LEFT+WIDTH} 796 l S Q\nEMC\n`;
   chromeOps+=`/Artifact << /Type /Pagination /Subtype /Header >> BDC\n${headRight?textOps(headRight,8,colour(h.colour),h.wordmark?LEFT+WIDTH-width(headRight,8):LEFT,808):''}EMC\n`;}
  const fo=folio(p,pages.length);
  chromeOps+=foot?`/Artifact << /Type /Pagination /Subtype /Footer >> BDC\nq ${colour('line')} RG .6 w ${LEFT} 46 m ${LEFT+WIDTH} 46 l S Q\n${footLeft?textOps(footLeft,7.5,colour('muted'),LEFT,32):''}${footCentre?textOps(footCentre,7.5,colour('muted'),LEFT+WIDTH/2-width(footCentre,7.5)/2,32):''}${textOps(fo,8,colour('muted'),LEFT+WIDTH-width(fo,8),32)}EMC`
   :`/Artifact BMC\n${textOps(fo,9,colour('muted'),48,30)}EMC`;
  const commands=page.under.join('')+page.ops.join('')+chromeOps;
  const xobjects=[...page.images].map(k=>`/Im${k} ${imageIds[k]} 0 R`).join(' ');
  set(content,stream(enc.encode(commands)));set(pageIds[p],`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fontResources} >>${xobjects?` /XObject << ${xobjects} >>`:''} >> /Contents ${content} 0 R /StructParents ${p} /Tabs /S${page.annots.length?` /Annots [${page.annots.map(a=>`${a.id} 0 R`).join(' ')}]`:''} >>`);
  nums.push(`${p} [${page.parents.map(e=>`${ids.get(e)} 0 R`).join(' ')}]`);
 }
 // Annotations take the parent-tree keys after the pages'; each names the Link element that owns it.
 annots.forEach((a,i)=>{const key=pages.length+i;nums.push(`${key} ${ids.get(a.link.el)} 0 R`);
  set(a.id,`<< /Type /Annot /Subtype /Link /Rect [${a.rect.map(f2).join(' ')}] /Border [0 0 0] /F 4 /Contents ${hex16(a.link.text)} /A << /Type /Action /S /URI /URI (${a.link.href.replace(/[\\()]/g,'\\$&')}) >> /StructParent ${key} >>`);});
 set(parentTree,`<< /Nums [${nums.join(' ')}] >>`);set(structure,`<< /Type /StructTreeRoot /K [${ids.get(doc)} 0 R] /ParentTree ${parentTree} 0 R /ParentTreeNextKey ${pages.length+annots.length} >>`);
 set(pagesId,`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] >>`);set(catalog,`<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (en) /MarkInfo << /Marked true >> /StructTreeRoot ${structure} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`);set(info,`<< /Title ${hex16(title)} /Creator (Case) >>`);
 return {objects,catalog,info,maxBytes};
 /** One text object; the font switches (Tf) only where a character comes from another font, so spacing is unbroken. */
 function textOps(text,size,fill,x,y,style=0,track=0){
  const runs=[];for(const c of text){const g=glyph(c,style),hex=g.cid.toString(16).padStart(4,'0');if(runs.at(-1)?.font===g.font)runs.at(-1).hex+=hex;else runs.push({font:g.font,hex});}
  if(!runs.length)runs.push({font:CHAIN[style][0],hex:''});
  return `BT /F${runs[0].font+1} ${f2(size)} Tf ${fill} rg ${track?`${f2(track)} Tc `:''}1 0 0 1 ${f2(x)} ${f2(y)} Tm `+runs.map((r,i)=>(i?`/F${r.font+1} ${f2(size)} Tf `:'')+`<${r.hex}> Tj `).join('')+(track?'0 Tc ':'')+'ET\n';
 }
}

/** The objects as PDF bytes; a stream marker is written raw, or deflated (/FlateDecode) when `packed` holds its bytes. */
function assemble({objects,catalog,info,maxBytes},packed=null){
 const bytesOf=o=>{if(!o?.stream)return o;const z=packed?.get(o),data=z??o.data;return concat([enc.encode(`<< /Length ${data.length}${z?' /Filter /FlateDecode':''}${o.dict} >>\nstream\n`),data,enc.encode('\nendstream')]);};
 const chunks=[enc.encode('%PDF-1.7\n%Case tagged text\n')],offsets=[0];let offset=chunks[0].length;
 for(let i=1;i<objects.length;i++){if(!objects[i])throw new Error('pdf_structure');offsets.push(offset);const value=concat([enc.encode(`${i} 0 obj\n`),bytesOf(objects[i]),enc.encode('\nendobj\n')]);chunks.push(value);offset+=value.length;}
 const xref=`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;chunks.push(enc.encode(xref));const result=concat(chunks);if(result.length>maxBytes)throw new Error('pdf_byte_budget');return result;
}
export function sessionPdf(lines,opts){return assemble(buildPdf(lines,opts));}
/**
 * The same document with every content, font and character-map stream deflated (/FlateDecode) by the browser's built-in
 * CompressionStream (room PDFs v2: a masthead's tesserae shrink about fivefold). Without CompressionStream it is the plain file.
 */
export async function sessionPdfDeflated(lines,opts){
 const built=buildPdf(lines,opts);
 if(typeof CompressionStream!=='function')return assemble(built);
 const packed=new Map(),deflate=async b=>new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
 await Promise.all(built.objects.filter(o=>o?.stream).map(async o=>{packed.set(o,await deflate(o.data));}));
 return assemble(built,packed);
}
