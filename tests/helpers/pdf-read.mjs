// A small reader for the PDFs Case writes (uncompressed content streams, Type0 fonts each with a ToUnicode CMap). It
// reads text the way assistive technology does: through the structure tree, the parent tree and ToUnicode, using
// /ActualText where a span carries it and skipping Artifacts. Test-only; no dependency.
import { inflateSync } from 'node:zlib';
export function readPdf(bytes) {
  // A true byte-for-byte latin1 decode (TextDecoder's 'latin1' is windows-1252), so binary stream bodies round-trip.
  const text = Buffer.from(bytes).toString('latin1');
  const start = text.lastIndexOf('startxref'), xrefAt = Number(text.slice(start + 9).trim().split(/\s/)[0]);
  const [, count] = text.slice(xrefAt).match(/^xref\n0 (\d+)\n/);
  const offsets = text.slice(xrefAt).split('\n').slice(3, 2 + Number(count)).map((l) => Number(l.slice(0, 10)));
  const objects = new Map();
  offsets.forEach((at, i) => { const end = text.indexOf('\nendobj', at); objects.set(i + 1, text.slice(text.indexOf('obj\n', at) + 4, end)); });
  const get = (id) => objects.get(id) ?? '';
  const ref = (s, key) => { const m = s.match(new RegExp(`/${key} (\\d+) 0 R`)); return m ? Number(m[1]) : null; };
  // A /FlateDecode stream (room PDFs v2 downloads) is inflated, so a reader sees the same text either way.
  const streamOf = (id) => { const s = get(id), i = s.indexOf('stream\n'), raw = s.slice(i + 7, s.lastIndexOf('\nendstream'));
    return s.slice(0, i).includes('/FlateDecode') ? inflateSync(Buffer.from(raw, 'latin1')).toString('latin1') : raw; };
  const hexText = (h) => { let out = ''; for (let i = 0; i < h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return out; };
  const fromUtf16 = (h) => { const units = []; for (let i = 0; i < h.length; i += 4) units.push(parseInt(h.slice(i, i + 4), 16)); return String.fromCharCode(...units); };
  const decodeHex = (s, key) => { const m = s.match(new RegExp(`/${key} <FEFF([0-9A-F]*)>`)); return m ? fromUtf16(m[1]) : undefined; };
  const catalog = ref(text.slice(text.lastIndexOf('trailer')), 'Root'), root = ref(get(catalog), 'StructTreeRoot');
  const pagesRoot = ref(get(catalog), 'Pages'), pageIds = [...get(pagesRoot).match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  // ToUnicode per Type0 font: CID → Unicode string. A page's /Font resources name each font; Tf selects one.
  const fonts = [...objects.entries()].filter(([, s]) => s.includes('/Subtype /Type0')).map(([id, s]) => {
    const toUnicode = ref(s, 'ToUnicode'), cmap = new Map();
    for (const m of streamOf(toUnicode).matchAll(/<([0-9A-Fa-f]{4})> <([0-9A-Fa-f]+)>/g)) cmap.set(parseInt(m[1], 16), fromUtf16(m[2]));
    return { id, name: (s.match(/\/BaseFont \/(\w+)/) ?? [])[1], toUnicode, cmap };
  });
  // Marked content per page: MCID → text. Artifacts are never read as content; their text is kept apart (artifacts[page])
  // so a test can see a page header or footer that a reader skips.
  const artifacts = [];
  const content = pageIds.map((id) => {
    const ops = streamOf(ref(get(id), 'Contents')), byMcid = new Map(), stack = [], art = [];
    const named = new Map([...get(id).match(/\/Font << ([^>]*) >>/)[1].matchAll(/\/(F\d+) (\d+) 0 R/g)].map((m) => [m[1], fonts.find((f) => f.id === Number(m[2]))]));
    let cmap = null;
    for (const m of ops.matchAll(/\/(\w+) <<\/MCID (\d+)>> BDC|\/Artifact BMC|\/Artifact <<[^>]*>> BDC|EMC|<([0-9A-Fa-f]*)> Tj|\/(F\d+) [\d.]+ Tf/g)) {
      if (m[4] !== undefined) { cmap = named.get(m[4])?.cmap; if (!cmap) throw new Error(`font ${m[4]} is not a page resource`); }
      else if (m[2] !== undefined) stack.push(Number(m[2]));
      else if (m[0].startsWith('/Artifact')) { stack.push(null); art.push(''); }
      else if (m[0] === 'EMC') stack.pop();
      else {
        const mcid = stack.at(-1), s = [...hexText(m[3])].map((c) => { const u = cmap.get(c.charCodeAt(0)); if (u === undefined) throw new Error(`no ToUnicode for CID ${c.charCodeAt(0)}`); return u; }).join('');
        if (mcid == null) { if (stack.length) art[art.length - 1] += s; continue; }
        byMcid.set(mcid, (byMcid.get(mcid) ?? '') + s);
      }
    }
    artifacts.push(art.filter(Boolean));
    return byMcid;
  });
  // Link annotations: page, URI, rectangle and the parent-tree key that names their structure element.
  const annots = pageIds.flatMap((id, page) => [...(get(id).match(/\/Annots \[([^\]]*)\]/)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => {
    const s = get(Number(m[1])), uri = s.match(/\/URI \(((?:\\.|[^\\)])*)\)/)?.[1].replace(/\\(.)/g, '$1');
    return { id: Number(m[1]), page, subtype: (s.match(/\/Subtype \/(\w+)/) ?? [])[1], uri, rect: (s.match(/\/Rect \[([^\]]*)\]/)?.[1] ?? '').split(' ').map(Number), structParent: Number((s.match(/\/StructParent (\d+)/) ?? [])[1]), contents: decodeHex(s, 'Contents') };
  }));
  // A page's key maps to an array of owners (by MCID); an annotation's key maps to the one element that owns it.
  const parentTree = new Map(), objectParents = new Map(), nums = get(ref(get(root), 'ParentTree')).match(/\/Nums \[([\s\S]*)\]/)[1];
  for (const m of nums.matchAll(/(\d+) (?:\[([^\]]*)\]|(\d+) 0 R)/g)) if (m[3]) objectParents.set(Number(m[1]), Number(m[3])); else parentTree.set(Number(m[1]), [...m[2].matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1])));
  // Walk the structure tree in order; block elements end a line.
  const BLOCK = new Set(['H1', 'H2', 'H3', 'P', 'LI', 'TH', 'TD', 'Figure', 'Lbl']);
  const tree = [], lines = [], seen = [];
  const walk = (id, depth) => {
    const s = get(id), type = s.match(/\/S \/(\w+)/)[1], actual = decodeHex(s, 'ActualText'), alt = decodeHex(s, 'Alt');
    const objr = [...s.matchAll(/<< \/Type \/OBJR \/Obj (\d+) 0 R \/Pg (\d+) 0 R >>/g)].map((m) => ({ obj: Number(m[1]), page: pageIds.indexOf(Number(m[2])) }));
    tree.push({ id, type, depth, alt, actual, scope: (s.match(/\/Scope \/(\w+)/) ?? [])[1], objr });
    let out = '';
    if (actual !== undefined) { out = actual; for (const m of s.matchAll(/\/Pg (\d+) 0 R \/MCID (\d+)/g)) seen.push([pageIds.indexOf(Number(m[1])), Number(m[2]), id]); return out; }
    const kids = s.match(/\/K \[([\s\S]*)\]/)[1];
    for (const m of kids.matchAll(/<< \/Type \/OBJR [^>]*>>|<< \/Type \/MCR \/Pg (\d+) 0 R \/MCID (\d+) >>|(\d+) 0 R/g)) {
      if (m[0].includes('/OBJR')) continue; // an annotation reference: read through its element's marked content
      if (m[1]) { const p = pageIds.indexOf(Number(m[1])); seen.push([p, Number(m[2]), id]); out += content[p].get(Number(m[2])) ?? ''; }
      else { const childText = walk(Number(m[3]), depth + 1); const childType = tree.findLast((t) => t.id === Number(m[3])).type; if (BLOCK.has(childType)) { if (childText) lines.push(childText); } else out += childText; }
    }
    if (type === 'Figure' && alt !== undefined) out = alt; // a figure is read by its alternative, not its drawn text
    return out;
  };
  const top = walk(Number(get(root).match(/\/K \[(\d+) 0 R\]/)[1]), 0); if (top) lines.unshift(top);
  return { text, objects, pageCount: pageIds.length, tree, lines, parentTree, objectParents, seen, pageIds, fonts, artifacts, annots };
}
