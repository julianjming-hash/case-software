#!/usr/bin/env node
// One-off conversion of saved Builder drafts to slides (Julian, 2026-10-11, CASE-216).
//
// Dry run (default): for every schema-1 or schema-2 draft in a workspace the account owns or authors, convert with the
// Builder's lossless conversions (schema 1 → 2, then card 56's → slides; a schema-1 draft whose flag variants have no
// slide form stops at schema 2), choose each slide's layout by measuring it in the shipped projector frame at 1280×720
// (prototypes/slide-fit.html in headless Chromium), validate, and write one reviewed plan file per case to --out.
// Nothing remote is written.
//
// Apply (--apply): reads the reviewed plan files, re-reads each draft and refuses it unless it is exactly the source the
// plan was made from; then reuses or creates a "Before slides" checkpoint at that revision and saves the planned slide
// draft through the normal revision window, checking the receipt. Cases with a pending or approved review candidate are
// skipped unless --include-under-review (saving would supersede that review). Drafts edited in the last 10 minutes are
// skipped (close Builder tabs first). Each case is isolated: a failure is reported and the run continues.
//
// Titles (--titles, CASE-222): for drafts already on slides, plan an H1 of each slide's learner heading in its title
// rows, On entry. Only slides still in a layout the conversion offered are re-laid (and re-measured); a slide an author
// arranged, or one that already has a heading, is listed and left exactly as it is. Apply works as above, with its own
// checkpoint "Before slide titles". --since DIR names the earlier conversion's plan directory: a slide still exactly as
// that conversion saved it counts as the conversion's own, even where today's layout heuristics would offer others.
//
//   CASE_SUPABASE_URL=… CASE_SUPABASE_SECRET_KEY=… node scripts/convert-drafts-to-slides.mjs --email you@example --out DIR [--titles [--since DIR]] [--apply] [--include-under-review]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { convertToSlideDocument, addSlideTitles } from '../src/shared/slide-legacy.mjs';
import { validateBuilderDocument, convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateBuilderProvenancePaths } from '../src/shared/builder-provenance.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2), flag = name => args.includes(name), option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = flag('--apply'), TITLES = flag('--titles'), SINCE = option('--since'), UNDER_REVIEW = flag('--include-under-review'), EMAIL = option('--email'), OUT = option('--out');
const BASE = process.env.CASE_SUPABASE_URL, KEY = process.env.CASE_SUPABASE_SECRET_KEY;
if (!BASE || !KEY || !EMAIL || !OUT) { console.error('Needs CASE_SUPABASE_URL, CASE_SUPABASE_SECRET_KEY, --email and --out.'); process.exit(2); }
const CHECKPOINT = 'Before slides (2026-10-11)', TITLE_CHECKPOINT = 'Before slide titles (2026-10-12)', RECENT_MS = 10 * 60 * 1000, PAGE = 50;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function rpc(name, body) {
  const response = await fetch(`${BASE}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'manual',
    headers: { apikey: KEY, 'content-profile': 'case_api', 'accept-profile': 'case_api', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const one = (rows, name) => { if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${name} returned ${Array.isArray(rows) ? rows.length : 'no'} rows`); return rows[0]; };
const actor = user => ({ p_user_id: user, p_admin: false, p_admin_email: null });

async function userId(email) {
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(`${BASE}/auth/v1/admin/users?page=${page}&per_page=100`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
    if (!response.ok) throw new Error(`auth admin ${response.status}`);
    const { users = [] } = await response.json();
    const found = users.find(user => user.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (users.length < 100) break;
  }
  throw new Error(`No account for ${email}.`);
}
/** Workspaces where the account may author drafts (owner or author), across every page of memberships. */
async function authorWorkspaces(user) {
  const out = [];
  let after = null;
  for (let guard = 0; guard < 100; guard++) {
    const row = one(await rpc('get_me', { p_user_id: user, p_limit: 100, p_after: after, p_workspace_id: null }), 'get_me');
    for (const item of row.memberships ?? []) if (['owner', 'author'].includes(item.role)) out.push(item.workspace_id);
    if (!row.next_after) break;
    after = row.next_after;
  }
  return [...new Set(out)];
}
/** Every draft in a workspace: the RPC returns limit+1 rows to signal another page. */
async function allDrafts(workspace, user) {
  const out = [];
  for (let offset = 0; offset <= 10000 - PAGE; offset += PAGE) {
    const rows = await rpc('builder_list_drafts', { p_workspace_id: workspace, p_limit: PAGE, p_offset: offset, ...actor(user) });
    out.push(...rows.slice(0, PAGE));
    if (rows.length <= PAGE) break;
  }
  return out;
}

// Static server for the fit harness: only the client sources, the harness and fonts; loopback Host only.
let current = null;
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const SERVED = ['src/client/', 'src/shared/', 'prototypes/', 'public/fonts/'];
const server = createServer(async (request, response) => {
  const host = request.headers.host ?? '';
  if (!/^127\.0\.0\.1:\d+$/.test(host)) { response.writeHead(403); response.end(); return; }
  const path = new URL(request.url, 'http://local').pathname;
  if (path === '/fit-document.json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(current)); return; }
  const file = normalize(join(ROOT, path)), relative = file.slice(ROOT.length);
  if (!file.startsWith(ROOT) || !SERVED.some(prefix => relative.startsWith(prefix)) || !TYPES[extname(file)]) { response.writeHead(404); response.end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'content-type': TYPES[extname(file)] }); response.end(body); }
  catch { response.writeHead(404); response.end(); }
});

/** Measure every slide in the projector frame and adopt the chosen layouts; returns the per-slide report. */
async function fitLayouts(page, origin, document, only = null) {
  current = document;
  await page.goto(`${origin}/prototypes/slide-fit.html?choose=1`);
  const report = await page.evaluate(() => window.fit);
  for (const row of report) if (row.chosen && (!only || only.has(row.id))) {
    const composition = document.compositions.find(item => item.id === row.id);
    composition.template = row.chosen.template; composition.placements = row.chosen.placements;
  }
  return report;
}

async function plan(user, workspace, row, page, origin) {
  const entry = { caseId: row.case_id, title: row.title, revision: row.revision };
  const [draft] = await rpc('builder_get_draft', { p_case_id: row.case_id, ...actor(user) });
  if (!draft?.document) return { ...entry, outcome: 'no saved draft' };
  if (TITLES) return planTitles(user, entry, workspace, row, draft, page, origin);
  if (![1, 2].includes(draft.schema_version)) return { ...entry, outcome: `schema ${draft.schema_version}: unchanged` };
  const metadata = draft.authoring_metadata ?? { metadata_version: 1 };
  // Schema 1 first becomes schema 2 (the Builder's explicit, lossless conversion), then goes on to slides where it can.
  let source = draft.document, note = '';
  if (draft.schema_version === 1) {
    const upgraded = convertSchema1ToBuilderDocument(draft.document, metadata);
    if (!upgraded.ok) return { ...entry, outcome: `refused: schema 1 could not convert (${upgraded.errors?.[0]?.code})` };
    source = upgraded.candidate;
  }
  let document = source, authoringMetadata = metadata, report = [], staled = 0;
  const converted = convertToSlideDocument(source, metadata, { createId: uuidv7 });
  if (converted.ok) {
    document = converted.candidate.document; authoringMetadata = converted.candidate.authoringMetadata; staled = converted.staled;
    report = await fitLayouts(page, origin, document);
  } else if (draft.schema_version === 1 && converted.code === 'variants_need_review') {
    // Slides have no form for flag variants yet; stopping at schema 2 keeps them exactly.
    const stages = source.surfaces.filter(surface => surface.variants?.length).map(surface => surface.title);
    note = ` as schema 2 only: flag variants on ${stages.length} stage${stages.length === 1 ? '' : 's'} have no slide form (${stages.join('; ')})`;
  } else return { ...entry, outcome: `refused: ${converted.code} (${converted.message})` };
  const checked = validateBuilderDocument(document, authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!checked.ok) return { ...entry, outcome: `refused: invalid after conversion (${checked.errors[0]?.code})` };
  if (validateBuilderProvenancePaths(document, authoringMetadata).length) return { ...entry, outcome: 'refused: source traces would not resolve' };
  if (JSON.stringify(authoringMetadata.sources ?? null) !== JSON.stringify(metadata.sources ?? null)) return { ...entry, outcome: 'refused: sources would change' };
  const candidates = await rpc('builder_list_candidates', { p_case_id: row.case_id, ...actor(user) });
  const underReview = candidates.filter(item => ['pending', 'approved'].includes(item.status)).map(item => item.status);
  const result = { ...entry, workspace, sourceRevision: draft.revision, sourceDigest: digest([draft.document, draft.authoring_metadata]), updatedAt: draft.updated_at,
    target: document.schema_version, slides: report.length, overflowing: report.filter(item => item.overflow.length).map(item => item.owner), staleTraces: staled, underReview,
    document, authoringMetadata };
  await writeFile(join(OUT, `${row.case_id}.json`), JSON.stringify(result, null, 1));
  return { ...result, outcome: `planned${note}${underReview.length ? `; under review (${underReview.join(', ')}): skipped on apply unless --include-under-review` : ''}` };
}

async function planTitles(user, entry, workspace, row, draft, page, origin) {
  if (draft.schema_version !== 3) return { ...entry, outcome: `schema ${draft.schema_version}: not on slides; unchanged` };
  // The earlier conversion's own saved document for this case, when --since names its plan directory.
  const converted = SINCE ? await readFile(join(SINCE, `${row.case_id}.json`), 'utf8').then(text => JSON.parse(text).document, () => null) : null;
  // The live slide draft is kept beside the plans so a "left alone" verdict can be checked against it.
  await writeFile(join(OUT, `${row.case_id}.source.json`), JSON.stringify({ revision: draft.revision, document: draft.document }, null, 1));
  const titled = addSlideTitles(draft.document, { createId: uuidv7, converted }), metadata = draft.authoring_metadata ?? { metadata_version: 1 };
  if (!titled.ok) return { ...entry, outcome: `refused: ${titled.reason}` };
  if (!titled.added.length) return { ...entry, outcome: `nothing to add${titled.skipped.length ? ` (${titled.skipped.map(item => `${item.owner}: ${item.reason}`).join('; ')})` : ''}` };
  const document = titled.document, only = new Set(titled.added.map(item => item.compositionId));
  const report = (await fitLayouts(page, origin, document, only)).filter(item => only.has(item.id));
  const checked = validateBuilderDocument(document, metadata, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!checked.ok) return { ...entry, outcome: `refused: invalid after titles (${checked.errors[0]?.code})` };
  if (validateBuilderProvenancePaths(document, metadata).length) return { ...entry, outcome: 'refused: source traces would not resolve' };
  const candidates = await rpc('builder_list_candidates', { p_case_id: row.case_id, ...actor(user) });
  const underReview = candidates.filter(item => ['pending', 'approved'].includes(item.status)).map(item => item.status);
  const result = { ...entry, mode: 'titles', workspace, sourceRevision: draft.revision, sourceDigest: digest([draft.document, draft.authoring_metadata]), updatedAt: draft.updated_at,
    target: 3, slides: report.length, overflowing: report.filter(item => item.overflow.length).map(item => item.owner), staleTraces: 0, underReview,
    leftAlone: titled.skipped, document, authoringMetadata: metadata };
  await writeFile(join(OUT, `${row.case_id}.json`), JSON.stringify(result, null, 1));
  return { ...result, outcome: `planned titles on ${titled.added.length} slide${titled.added.length === 1 ? '' : 's'}${titled.skipped.length ? `; left alone: ${titled.skipped.map(item => `${item.owner} (${item.reason})`).join('; ')}` : ''}${underReview.length ? `; under review (${underReview.join(', ')}): skipped on apply unless --include-under-review` : ''}` };
}

async function apply(user, saved) {
  const entry = { caseId: saved.caseId, title: saved.title, slides: saved.slides, overflowing: saved.overflowing, staleTraces: saved.staleTraces };
  let step = 'read';
  try {
    if (saved.underReview?.length && !UNDER_REVIEW) return { ...entry, outcome: `skipped: under review (${saved.underReview.join(', ')})` };
    const draft = one(await rpc('builder_get_draft', { p_case_id: saved.caseId, ...actor(user) }), 'builder_get_draft');
    const titles = saved.mode === 'titles', checkpoint = titles ? TITLE_CHECKPOINT : CHECKPOINT;
    if (!titles && draft.schema_version >= saved.target) return { ...entry, outcome: `already schema ${draft.schema_version} (revision ${draft.revision}); nothing to do` };
    if (draft.revision !== saved.sourceRevision || digest([draft.document, draft.authoring_metadata]) !== saved.sourceDigest)
      return { ...entry, outcome: `skipped: the draft changed since the dry run (revision ${draft.revision}); dry-run again` };
    if (Date.now() - Date.parse(draft.updated_at) < RECENT_MS) return { ...entry, outcome: 'skipped: edited in the last 10 minutes; close Builder tabs and re-run' };
    step = 'checkpoint';
    const existing = (await rpc('builder_list_checkpoints', { p_case_id: saved.caseId, ...actor(user) })).find(item => item.name === checkpoint && item.revision === draft.revision);
    if (!existing) {
      let made;
      try { made = one(await rpc('builder_create_checkpoint', { p_case_id: saved.caseId, p_name: checkpoint, p_expected_revision: draft.revision, ...actor(user) }), 'builder_create_checkpoint'); }
      catch (error) { return { ...entry, outcome: `not converted: checkpoint refused (${error.message.slice(0, 120)})${/checkpoint_limit/.test(error.message) ? '; free a checkpoint slot and re-run' : ''}` }; }
      if (made.revision !== draft.revision) return { ...entry, outcome: `skipped: the draft moved to revision ${made.revision} while checkpointing; dry-run again` };
    }
    step = 'window';
    const window = one(await rpc('builder_open_save_window', { p_case_id: saved.caseId, p_base_revision: draft.revision, ...actor(user) }), 'builder_open_save_window');
    step = 'save';
    let receipt;
    try { receipt = one(await rpc('builder_save_draft', { p_case_id: saved.caseId, p_operation_id: window.operation_id, p_document: saved.document,
      p_authoring_metadata: saved.authoringMetadata, ...actor(user) }), 'builder_save_draft'); }
    catch (error) {
      // A lost acknowledgement: the receipt says whether the save committed.
      receipt = (await rpc('builder_get_save_receipt', { p_case_id: saved.caseId, p_operation_id: window.operation_id, ...actor(user) }).catch(() => []))?.[0];
      if (receipt?.status !== 'saved') throw error;
    }
    if (receipt.status !== 'saved' || receipt.revision !== draft.revision + 1) throw new Error(`unexpected receipt ${receipt.status} revision ${receipt.revision}`);
    return { ...entry, outcome: `${titles ? 'titled' : `converted to schema ${saved.target}`}: revision ${receipt.revision} (checkpoint "${checkpoint}" holds revision ${draft.revision})` };
  } catch (error) {
    return { ...entry, outcome: `failed at ${step}: ${error.message.slice(0, 160)} (the draft is unchanged unless a receipt says otherwise; re-run is safe)` };
  }
}

await mkdir(OUT, { recursive: true });
const summary = [];
let browser = null;
try {
  const user = await userId(EMAIL);
  if (APPLY) {
    for (const name of (await readdir(OUT)).filter(file => /^[0-9a-f-]{36}\.json$/.test(file))) summary.push(await apply(user, JSON.parse(await readFile(join(OUT, name), 'utf8'))));
    if (!summary.length) console.log('No plan files in --out. Run the dry run first.');
  } else {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const workspaces = await authorWorkspaces(user);
    if (!workspaces.length) console.log('No workspaces where this account owns or authors cases.');
    for (const workspace of workspaces) {
      let drafts = [];
      try { drafts = await allDrafts(workspace, user); }
      catch (error) { summary.push({ title: `workspace ${workspace}`, outcome: `skipped: ${error.message.slice(0, 120)}` }); continue; }
      for (const row of drafts) {
        try { summary.push(await plan(user, workspace, row, page, origin)); }
        catch (error) { summary.push({ caseId: row.case_id, title: row.title, outcome: `not planned: ${error.message.slice(0, 160)}` }); }
      }
    }
  }
} finally {
  await browser?.close(); server.close();
  await writeFile(join(OUT, APPLY ? 'apply-summary.json' : 'dry-run-summary.json'), JSON.stringify(summary.map(({ document, authoringMetadata, ...rest }) => rest), null, 1));
  for (const entry of summary) console.log(`${entry.title} — ${entry.outcome}${entry.slides ? ` · ${entry.slides} slides, ${entry.overflowing.length} need editing${entry.overflowing.length ? `: ${entry.overflowing.join('; ')}` : ''}${entry.staleTraces ? ` · ${entry.staleTraces} source traces to re-review` : ''}` : ''}`);
  console.log(APPLY ? 'Apply finished.' : 'Dry run: nothing written remotely. Review the plan files in --out, then re-run with --apply.');
}
