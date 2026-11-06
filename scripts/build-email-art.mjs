#!/usr/bin/env node
// Deterministic branding export using the existing mosaic grammar and the pinned browser encoder.
// Offline only. Retain old outputs; updating emailArtUrl is a separate reviewed source change.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../prototypes/design/mosaic.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) throw Error('usage: build-email-art.mjs [--out-dir directory]');
const folder = args.length ? resolve(args[1]) : fileURLToPath(new URL('../public/email', import.meta.url));
const svg = globalThis.CaseMosaic.render({ structure: globalThis.CaseMosaic.PRESETS.diverge, seed: 'case-email-family',
  group: 'petrol', theme: 'light', width: 1200, height: 288, tile: 9 }).svg;
const browser = await chromium.launch();
let bytes;
try {
  const context = await browser.newContext({ offline: true }), page = await context.newPage();
  const data = await page.evaluate(async svg => {
    const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 288;
    canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL('image/jpeg', 0.78);
  }, svg);
  bytes = Buffer.from(data.split(',')[1], 'base64');
} finally { await browser.close(); }
if (bytes.length > 100_000) throw Error('email_artwork_too_large');
const sha256 = createHash('sha256').update(bytes).digest('hex'), file = sha256.slice(0, 12) + '.jpg';
await mkdir(folder, { recursive: true });
const target = join(folder, file);
try { await writeFile(target, bytes, { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST' || !(await readFile(target)).equals(bytes)) throw error; }
console.log(JSON.stringify({ file, bytes: bytes.length, sha256 }));
