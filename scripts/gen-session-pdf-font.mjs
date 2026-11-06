// Dev-only: python3 with fonttools4.66.1 + brotli1.2.0. No package is shipped to clients.
// Instantiates the existing OFL Montserrat Latin source at 400 (Regular) and 600 (SemiBold, Julian 2026-10-18), each cut to the
// same code points with no hinting or layout tables (the writer places glyphs by advance), and a JetBrains Mono subset of
// digits and number punctuation for figures and times. Never downloads a font.
// The fallback subset (CaseSymbols) is built only from the bundled OFL sources in public/fonts/: JetBrains Mono's
// arrow and comparison glyphs, ≈ from two Montserrat tildes, and check and cross marks stroked at Montserrat's stem.
// Two script subsets are cut from committed files the same way: Latin Extended-A (and Ș ș Ț ț † ℓ) from
// public/fonts/montserrat-latin-ext.woff2, and Greek from public/fonts/noto-sans-greek.woff2 (itself a committed subset
// of Noto Sans; provenance in NOTICE.md). Each keeps only the code points the primary font lacks.
// See NOTICE.md. Optional PYTHON selects a prepared development interpreter.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync(process.env.PYTHON??'python3',['-c',String.raw`
import sys,json,base64,io
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools import subset
root=Path(sys.argv[1])
def load(name,w=400):
  f=TTFont(root/'public/fonts'/name,recalcTimestamp=False)
  f.flavor=None
  if 'fvar' in f:f=instantiateVariableFont(f,{'wght':w},inplace=False)
  f.recalcTimestamp=False
  return f
def metrics(f,mapping):
  units=f['head'].unitsPerEm
  return {'map':mapping,'ascent':round(f['hhea'].ascent*1000/units),'descent':round(f['hhea'].descent*1000/units),'bbox':[round(getattr(f['head'],k)*1000/units) for k in ['xMin','yMin','xMax','yMax']]}
f=load('montserrat-latin.woff2')
buf=io.BytesIO();f.save(buf)
units=f['head'].unitsPerEm
cmap=dict(f.getBestCmap())
# Glyphs the subset carries without a cmap entry: Greek small mu (U+03BC), distinct from the micro sign U+00B5.
for code,name in {0x03BC:'uni03BC'}.items():
  if code not in cmap and name in f.getGlyphOrder():cmap[code]=name
def cut(src,codes):
  o=subset.Options();o.layout_features=[];o.hinting=False;o.notdef_outline=True;o.name_IDs=[0,1,2,3,5,6,13,14];o.recalc_timestamp=False
  have=src.getBestCmap()
  # Glyphs carried without a cmap entry (Greek small mu, U+03BC) are kept by name and mapped as before.
  extra={c:n for c,n in cmap.items() if c in codes and c not in have and n in src.getGlyphOrder()}
  sub=subset.Subsetter(o);sub.populate(unicodes=codes,glyphs=list(extra.values()));sub.subset(src)
  out=io.BytesIO();src.recalcTimestamp=False;src.save(out);u=src['head'].unitsPerEm;gc={**src.getBestCmap(),**extra}
  return {'base64':base64.b64encode(out.getvalue()).decode(),**metrics(src,{str(c):[src.getGlyphID(n),round(src['hmtx'][n][0]*1000/u)] for c,n in sorted(gc.items()) if c in codes})}
codes=sorted(cmap)
data=cut(load('montserrat-latin.woff2'),codes)
bold=cut(load('montserrat-latin.woff2',600),codes)
mono_src=load('jetbrains-mono-latin.woff2');mono_have=mono_src.getBestCmap()
mono_codes=[c for c in map(ord,'0123456789abcdef /:.,%+-\u00b7\u2013\u00d7') if c in mono_have]
mono_digits=cut(mono_src,mono_codes)
# ── CaseSymbols: only code points neither Montserrat subset maps, from bundled OFL glyphs ──
mono=load('jetbrains-mono-latin.woff2')
assert f['head'].unitsPerEm==mono['head'].unitsPerEm==1000
def recorded(src,name,dx=0,dy=0):
  gs=src.getGlyphSet();rec=DecomposingRecordingPen(gs);gs[name].draw(rec)
  out=DecomposingRecordingPen(None);rec.replay(TransformPen(out,(1,0,0,1,dx,dy)));return out
def bounds(rec):
  bp=BoundsPen(None);rec.replay(bp);return bp.bounds
pad=f['hmtx']['greater'][1]  # Montserrat's own side bearing for a comparison sign
glyphs={'.notdef':TTGlyphPen(None).glyph()};advance={'.notdef':500};cmapF={}
def add(code,recs,width,name):
  pen=TTGlyphPen(None)
  for rec in recs:rec.replay(pen)
  glyphs[name]=pen.glyph();advance[name]=width;cmapF[code]=name
def from_ink(code,recs,name):
  xs=[bounds(r) for r in recs];x0=min(b[0] for b in xs);x1=max(b[2] for b in xs)
  shifted=[]
  for r in recs:
    o=DecomposingRecordingPen(None);r.replay(TransformPen(o,(1,0,0,1,pad-x0,0)));shifted.append(o)
  add(code,shifted,round(x1-x0+2*pad),name)
# JetBrains Mono draws these as programming ligatures; each glyph is a complete arrow or comparison sign.
for code,name in {0x2190:'less_hyphen.liga',0x2192:'hyphen_greater.liga',0x2194:'less_hyphen_greater.liga',0x21D2:'equal_greater.liga',0x21D4:'less_equal_greater.liga',0x2260:'exclam_equal.liga',0x2264:'less_equal.liga',0x2265:'greater_equal.liga'}.items():
  assert code not in cmap,hex(code)
  from_ink(code,[recorded(mono,name)],'u%04X'%code)
# ≈: Montserrat's own tilde, twice, about the tilde's centre.
t=bounds(recorded(f,'asciitilde'));gap=round((t[3]-t[1])*.62)
from_ink(0x2248,[recorded(f,'asciitilde',0,gap),recorded(f,'asciitilde',0,-gap)],'u2248')
# ✓ ✗ (and heavy ✔ ✘): stroked polylines at Montserrat's stem width, mitred, every contour clockwise.
lb=bounds(recorded(f,'l'));stem=lb[2]-lb[0]
def stroke(points,w):
  import math
  def off(a,b):
    dx,dy=b[0]-a[0],b[1]-a[1];n=math.hypot(dx,dy);return (-dy/n*w/2,dx/n*w/2)
  def side(sign):
    out=[]
    for i,p in enumerate(points):
      segs=[off(points[j],points[j+1]) for j in (i-1,i) if 0<=j<len(points)-1]
      if len(segs)==1:nx,ny=segs[0]
      else:  # mitre: the sum of the two normals, scaled so each segment's edge keeps its half-width
        (ax,ay),(bx,by)=segs;mx,my=ax+bx,ay+by;k=(w/2)**2/(mx*ax+my*ay);nx,ny=mx*k,my*k
      out.append((p[0]+sign*nx,p[1]+sign*ny))
    return out
  poly=side(1)+side(-1)[::-1]
  area=sum(poly[i][0]*poly[(i+1)%len(poly)][1]-poly[(i+1)%len(poly)][0]*poly[i][1] for i in range(len(poly)))
  if area>0:poly=poly[::-1]
  rec=DecomposingRecordingPen(None);rec.moveTo(tuple(map(round,poly[0])))
  for p in poly[1:]:rec.lineTo(tuple(map(round,p)))
  rec.closePath();return rec
CHECK=[(70,330),(230,110),(560,640)];CROSS=[[(90,110),(530,640)],[(90,640),(530,110)]]
for code,w,shape in [(0x2713,stem,'check'),(0x2714,stem*1.75,'check'),(0x2717,stem,'cross'),(0x2718,stem*1.75,'cross')]:
  from_ink(code,[stroke(CHECK,w)] if shape=='check' else [stroke(p,w) for p in CROSS],'u%04X'%code)
order=['.notdef']+sorted(n for n in glyphs if n!='.notdef')
fb=FontBuilder(1000,isTTF=True)
fb.setupGlyphOrder(order);fb.setupCharacterMap(cmapF);fb.setupGlyf(glyphs)
gl=fb.font['glyf'];fb.setupHorizontalMetrics({n:(advance[n],getattr(gl[n],'xMin',0)) for n in order})
fb.setupHorizontalHeader(ascent=f['hhea'].ascent,descent=f['hhea'].descent)
copyright=f['name'].getDebugName(0)+'; '+mono['name'].getDebugName(0)
fb.setupNameTable({'copyright':copyright,'familyName':'CaseSymbols','styleName':'Regular','uniqueFontIdentifier':'CaseSymbols-Regular','fullName':'CaseSymbols Regular','psName':'CaseSymbols-Regular','version':'Version 1.000','licenseDescription':'This Font Software is licensed under the SIL Open Font License, Version 1.1. Derived from Montserrat and JetBrains Mono.','licenseInfoURL':'https://openfontlicense.org'},windows=True,mac=False)
fb.setupOS2(sTypoAscender=f['hhea'].ascent,sTypoDescender=f['hhea'].descent,usWinAscent=f['hhea'].ascent,usWinDescent=-f['hhea'].descent,fsType=0)
fb.setupPost(keepGlyphNames=False);fb.setupMaxp()
fb.font['head'].created=fb.font['head'].modified=f['head'].modified
fb.font.recalcTimestamp=False
sym=io.BytesIO();fb.font.save(sym);s=TTFont(io.BytesIO(sym.getvalue()))
fallback={'base64':base64.b64encode(sym.getvalue()).decode(),**metrics(s,{str(c):[order.index(n),advance[n]] for c,n in sorted(cmapF.items())})}
def script_subset(name,codes):
  src=load(name);have=src.getBestCmap();want=sorted(c for c in codes if c in have and c not in cmap)
  o=subset.Options();o.layout_features=[];o.hinting=False;o.notdef_outline=True;o.name_IDs=[0,1,2,3,5,6,13,14];o.recalc_timestamp=False
  sub=subset.Subsetter(o);sub.populate(unicodes=want);sub.subset(src)
  out=io.BytesIO();src.recalcTimestamp=False;src.save(out);g=TTFont(io.BytesIO(out.getvalue()));u=g['head'].unitsPerEm;gc=g.getBestCmap()
  return {'base64':base64.b64encode(out.getvalue()).decode(),**metrics(g,{str(c):[g.getGlyphID(gc[c]),round(g['hmtx'][gc[c]][0]*1000/u)] for c in want})}
latin_ext=script_subset('montserrat-latin-ext.woff2',list(range(0x100,0x180))+[0x218,0x219,0x21A,0x21B,0x2020,0x2113])
greek=script_subset('noto-sans-greek.woff2',range(0x370,0x400))
(root/'src/client/session-pdf-font.mjs').write_text('// Static Montserrat Regular and SemiBold from public/fonts/montserrat-latin.woff2 (OFL), JetBrains Mono digits, and the CaseSymbols fallback subset derived\n// from the bundled Montserrat and JetBrains Mono, a Latin Extended-A subset of montserrat-latin-ext.woff2 and a Greek subset of\n// noto-sans-greek.woff2 (all OFL; NOTICE.md). Generated by scripts/gen-session-pdf-font.mjs. PDF-only, lazy.\nexport const FONT='+json.dumps(data,separators=(',',':'))+'\nexport const BOLD='+json.dumps(bold,separators=(',',':'))+'\nexport const MONO='+json.dumps(mono_digits,separators=(',',':'))+';\nexport const FALLBACK='+json.dumps(fallback,separators=(',',':'))+';\nexport const LATIN_EXT='+json.dumps(latin_ext,separators=(',',':'))+';\nexport const GREEK='+json.dumps(greek,separators=(',',':'))+';\n')
`,root],{stdio:'inherit'});
