// prototypes/room/lib/qr.mjs: a dependency-free QR Code encoder for the projector join panel.
//
// Scope (ISO/IEC 18004): versions 1 to 4, error correction level M, alphanumeric mode (the join
// payload is upper case and QR-alphanumeric by construction, urls.mjs qrPayload) with a byte-mode
// fallback so any short string still encodes. Reed-Solomon over GF(256) (poly 0x11D), the
// 15-bit BCH format information, and the best of the 8 masks by the four penalty rules.
//
// Importable in Node: only qrSvg() touches `document`.

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// Level M, per version: total codewords, EC codewords per block, [blocks, data codewords per block].
const VERSIONS = {
  1: { total: 26, ecPerBlock: 10, blocks: [[1, 16]], align: [] },
  2: { total: 44, ecPerBlock: 16, blocks: [[1, 28]], align: [6, 18] },
  3: { total: 70, ecPerBlock: 26, blocks: [[1, 44]], align: [6, 22] },
  4: { total: 100, ecPerBlock: 18, blocks: [[2, 32]], align: [6, 26] },
};
const EC_LEVEL_M_BITS = 0b00;

// ── GF(256) and Reed-Solomon ────────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x <<= 1; if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g; // highest degree first, leading 1
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < degree; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// ── Data encoding ───────────────────────────────────────────────────────────
function bitsFor(text) {
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  const alnum = [...text].every((c) => ALNUM.includes(c));
  if (alnum) {
    put(0b0010, 4); put(text.length, 9);
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) put(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      else put(ALNUM.indexOf(text[i]), 6);
    }
  } else {
    const bytes = new TextEncoder().encode(text);
    put(0b0100, 4); put(bytes.length, 8);
    for (const b of bytes) put(b, 8);
  }
  return bits;
}

function dataCodewords(text) {
  const bits = bitsFor(text);
  const version = Object.keys(VERSIONS).map(Number).find((v) => {
    const cap = VERSIONS[v].blocks.reduce((n, [c, d]) => n + c * d, 0) * 8;
    return bits.length <= cap;
  });
  if (!version) throw new RangeError(`qr: ${text.length} characters do not fit versions 1-4 at level M`);
  const capBits = VERSIONS[version].blocks.reduce((n, [c, d]) => n + c * d, 0) * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0); // terminator
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < capBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return { version, data: out };
}

function interleave(version, data) {
  const { blocks, ecPerBlock } = VERSIONS[version];
  const dBlocks = [];
  let at = 0;
  for (const [count, size] of blocks) for (let i = 0; i < count; i++) { dBlocks.push(data.slice(at, at + size)); at += size; }
  const eBlocks = dBlocks.map((b) => rsRemainder(b, ecPerBlock));
  const out = [];
  const maxD = Math.max(...dBlocks.map((b) => b.length));
  for (let i = 0; i < maxD; i++) for (const b of dBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of eBlocks) out.push(b[i]);
  return out;
}

// ── Matrix construction ─────────────────────────────────────────────────────
function blank(size) { return Array.from({ length: size }, () => new Array(size).fill(false)); }

/** Format information: 5 data bits (EC level, mask) + BCH(15,5), xor 0x5412. */
export function formatBits(mask, ec = EC_LEVEL_M_BITS) {
  const data = (ec << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function buildFunctionPatterns(version) {
  const size = 17 + version * 4;
  const m = blank(size);
  const fn = blank(size); // true where a module belongs to a function pattern
  const set = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };

  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= size || c >= size) continue;
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      set(r, c, ring !== 2 && ring !== 4); // 3x3 core, 7x7 border, white ring, separator white
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing

  const al = VERSIONS[version].align;
  for (const r of al) for (const c of al) {
    if (fn[r][c]) continue; // collides with a finder
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }

  set(size - 8, 8, true); // dark module
  // Reserve format areas (written later).
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (!fn[8][size - 1 - i]) set(8, size - 1 - i, false); if (!fn[size - 1 - i][8]) set(size - 1 - i, 8, false); }
  return { m, fn, size };
}

function placeData(m, fn, size, codewords) {
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let k = 0;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n++) {
      const r = up ? size - 1 - n : n;
      for (let dc = 0; dc < 2; dc++) {
        const c = right - dc;
        if (fn[r][c]) continue;
        m[r][c] = k < bits.length ? bits[k] === 1 : false; // remainder bits stay light
        k++;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, fn, size, mask) {
  const out = m.map((row) => row.slice());
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
  return out;
}

function writeFormat(m, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  // Split copy: top-right row 8, bottom-left column 8.
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = true; // dark module
}

/** The four penalty rules of ISO/IEC 18004 §7.8.3. */
export function penalty(m) {
  const n = m.length;
  let score = 0;
  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    return s;
  };
  const pat = [true, false, true, true, true, false, true];
  const finderScore = (line) => {
    let s = 0;
    for (let i = 0; i + 7 <= line.length; i++) {
      if (!pat.every((v, j) => line[i + j] === v)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
      const lightAfter = i + 7 + 4 <= line.length && [0, 1, 2, 3].every((k) => !line[i + 7 + k]);
      if (lightBefore) s += 40;
      if (lightAfter) s += 40;
    }
    return s;
  };
  for (let r = 0; r < n; r++) {
    const row = m[r];
    const col = m.map((x) => x[r]);
    score += runScore(row) + runScore(col) + finderScore(row) + finderScore(col);
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Encode `text`; returns a square boolean matrix (true = dark), no quiet zone. */
export function qrMatrix(text) {
  return qrEncode(text).matrix;
}

/** As qrMatrix, with the chosen version and mask (used by tests). */
export function qrEncode(text) {
  const { version, data } = dataCodewords(String(text));
  const words = interleave(version, data);
  const { m, fn, size } = buildFunctionPatterns(version);
  placeData(m, fn, size, words);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMask(m, fn, size, mask);
    writeFormat(cand, size, mask);
    const p = penalty(cand);
    if (!best || p < best.penalty) best = { matrix: cand, mask, penalty: p };
  }
  return { version, size, ...best };
}

/** An SVG element: one dark path, light background, quiet zone `margin` modules. Built with DOM calls only. */
export function qrSvg(text, { scale = 8, margin = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(n * scale));
  svg.setAttribute('height', String(n * scale));
  svg.setAttribute('role', 'img');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(n)); bg.setAttribute('height', String(n)); bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(NS, 'path');
  let d = '';
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) { c++; continue; }
      let e = c;
      while (e < m.length && m[r][e]) e++;
      d += `M${c + margin} ${r + margin}h${e - c}v1h${c - e}z`;
      c = e;
    }
  }
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}
