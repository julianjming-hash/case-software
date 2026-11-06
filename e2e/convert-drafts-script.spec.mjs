// The one-off slide conversion script against a local fake of the Supabase endpoints it calls (auth admin and case_api
// RPCs), modelled on the real signatures: list pages return limit+1 rows, save windows need the current revision, the
// checkpoint limit is 3. Proves: a dry run writes nothing and plans only owner/author workspaces, across pages; apply
// uses the reviewed plans, checkpoints first, saves through the revision window and checks the receipt; it skips cases
// under review, edited in the last 10 minutes or changed since the dry run, and leaves a case at the checkpoint limit
// alone; a lost acknowledgement is recovered from the receipt; a re-run reuses the checkpoint and never double-converts.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuilderTransfer, inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import mvcFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { convertToSlideDocument, layoutCandidates } from '../src/shared/slide-legacy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString();

async function fakeSupabase(drafts, { owned, viewed }) {
  const calls = [], user = uuidv7(), receipts = new Map(), fail = new Set();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const path = new URL(request.url, 'http://x').pathname, args = body ? JSON.parse(body) : {};
    const reply = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path.startsWith('/auth/v1/admin/users')) return reply({ users: [{ id: uuidv7(), email: 'someone@example.invalid' }, { id: user, email: 'owner@example.invalid' }] });
    const name = path.replace('/rest/v1/rpc/', ''); calls.push({ name, args });
    if (args.p_user_id !== user) return reply({ message: 'forbidden' }, 403);
    if (name === 'get_me') return reply([{ user_id: user, next_after: null, memberships: [{ workspace_id: owned, role: 'owner' }, { workspace_id: viewed, role: 'viewer' }] }]);
    if (name === 'builder_list_drafts') {
      if (args.p_workspace_id !== owned) return reply({ message: 'forbidden' }, 403);
      if (args.p_limit > 50) return reply({ message: 'invalid_page' }, 400);
      return reply(drafts.slice(args.p_offset, args.p_offset + args.p_limit + 1).map(item => ({ case_id: item.caseId, title: item.document.title, revision: item.revision, updated_at: item.updatedAt })));
    }
    const draft = drafts.find(item => item.caseId === args.p_case_id);
    if (name === 'builder_get_draft') return reply([{ revision: draft.revision, schema_version: draft.document.schema_version, document: draft.document, authoring_metadata: draft.metadata, updated_at: draft.updatedAt }]);
    if (name === 'builder_list_candidates') return reply(draft.candidates ?? []);
    if (name === 'builder_list_checkpoints') return reply(draft.checkpoints);
    if (name === 'builder_create_checkpoint') {
      // Production binds the checkpoint to the revision (20261015); the unbound signature is revoked (42501).
      if (!('p_expected_revision' in args)) return reply({ code: '42501', message: 'permission denied for function builder_create_checkpoint' }, 403);
      if (args.p_expected_revision !== draft.revision) return reply({ message: 'stale_revision' }, 409);
      if (draft.checkpoints.length >= 3) return reply({ message: 'checkpoint_limit' }, 400);
      const row = { id: uuidv7(), name: args.p_name, revision: draft.revision }; draft.checkpoints.push(row); return reply([row]);
    }
    if (name === 'builder_open_save_window') {
      if (draft.failWindowOnce && !fail.has(draft.caseId)) { fail.add(draft.caseId); return reply({ message: 'temporarily_unavailable' }, 503); }
      if (args.p_base_revision !== draft.revision) return reply({ message: 'stale_revision' }, 409);
      return reply([{ operation_id: uuidv7(), base_revision: draft.revision }]);
    }
    if (name === 'builder_save_draft') {
      draft.document = args.p_document; draft.metadata = args.p_authoring_metadata; draft.revision++; draft.saves = (draft.saves ?? 0) + 1;
      const receipt = { operation_id: args.p_operation_id, revision: draft.revision, status: 'saved' };
      receipts.set(args.p_operation_id, receipt);
      return draft.loseAck ? reply({ message: 'connection reset' }, 502) : reply([receipt]);
    }
    if (name === 'builder_get_save_receipt') return reply(receipts.has(args.p_operation_id) ? [receipts.get(args.p_operation_id)] : []);
    return reply({ message: 'unknown' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

test('[AS-152] the one-off script plans, then applies only reviewed and unchanged drafts, safely and re-runnably', async () => {
  test.setTimeout(240_000);
  const parsed = parseBuilderTransfer(readFileSync(join(ROOT, 'tests/fixtures/synthetic/builder-diving-polished-transfer.json'), 'utf8'));
  const candidate = (await inspectBuilderTransfer(parsed.envelope, {})).candidate;
  for (const surface of candidate.document.surfaces) delete surface.variants;
  const metadata = candidate.authoring_metadata ?? candidate.authoringMetadata;
  const legacy = (title, extra = {}) => ({ caseId: uuidv7(), revision: 4, document: { ...structuredClone(candidate.document), title }, metadata: structuredClone(metadata), checkpoints: [], updatedAt: HOUR_AGO, ...extra });
  // 52 drafts already on slides come first, so the legacy cases sit on the second page.
  const filler = Array.from({ length: 52 }, (_, index) => ({ caseId: uuidv7(), revision: 1, document: { schema_version: 3, title: `Slides ${index}` }, metadata: { metadata_version: 1 }, checkpoints: [], updatedAt: HOUR_AGO }));
  const cases = {
    plain: legacy('Plain'),
    full: legacy('Full checkpoints', { checkpoints: [1, 2, 3].map(n => ({ id: uuidv7(), name: `Mine ${n}`, revision: n })) }),
    review: legacy('Under review', { candidates: [{ candidate_id: uuidv7(), revision: 4, status: 'pending' }] }),
    recent: legacy('Edited just now', { updatedAt: new Date().toISOString() }),
    lostAck: legacy('Lost acknowledgement', { loseAck: true }),
    changed: legacy('Changed after the dry run'),
    flaky: legacy('Window fails once', { failWindowOnce: true }),
    // Schema 1: with flag variants it stops at schema 2 (slides cannot hold them); without, it goes on to slides.
    schema1Variants: { caseId: uuidv7(), revision: 3, document: { ...structuredClone(mvcFixture), title: 'Schema 1 with variants' }, metadata: { metadata_version: 1 }, checkpoints: [], updatedAt: HOUR_AGO },
    schema1Plain: { caseId: uuidv7(), revision: 3, document: { ...structuredClone(mvcFixture), title: 'Schema 1 plain', surfaces: mvcFixture.surfaces.map(({ variants, ...surface }) => surface) }, metadata: { metadata_version: 1 }, checkpoints: [], updatedAt: HOUR_AGO },
  };
  const drafts = [...filler, ...Object.values(cases)];
  const owned = uuidv7(), viewed = uuidv7();
  const fake = await fakeSupabase(drafts, { owned, viewed });
  const out = mkdtempSync(join(tmpdir(), 'slides-'));
  // Asynchronous: the fake server lives in this process and must keep answering while the script runs.
  const run = extra => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/convert-drafts-to-slides.mjs', '--email', 'owner@example.invalid', '--out', out, ...extra],
      { cwd: ROOT, env: { ...process.env, CASE_SUPABASE_URL: fake.url, CASE_SUPABASE_SECRET_KEY: 'test-key' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  const line = (result, item) => result.stdout.split('\n').find(text => text.startsWith(`${item.document.title ?? ''} — `)) ?? '';
  const writes = () => fake.calls.filter(call => /create_checkpoint|window|save_draft/.test(call.name));
  try {
    const dry = await run([]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('Dry run: nothing written remotely');
    expect(writes()).toEqual([]);
    // Only the owned workspace is listed, page by page (51 rows means another page).
    expect(fake.calls.filter(call => call.name === 'builder_list_drafts').map(call => [call.args.p_workspace_id === owned, call.args.p_offset])).toEqual([[true, 0], [true, 50]]);
    for (const item of Object.values(cases)) expect(line(dry, { document: { title: item.document.title } })).toContain('planned');
    expect(line(dry, cases.review)).toContain('under review (pending)');
    expect(line(dry, cases.schema1Variants)).toContain('planned as schema 2 only: flag variants on 2 stages have no slide form');
    expect(line(dry, cases.schema1Plain)).toMatch(/planned · 1\d slides/);
    expect(dry.stdout).toMatch(/Plain — planned · 32 slides, [0-3] need editing/);
    const plan = JSON.parse(readFileSync(join(out, `${cases.plain.caseId}.json`), 'utf8'));
    expect(plan).toMatchObject({ sourceRevision: 4, slides: 32 });
    expect(plan.document.schema_version).toBe(3);
    expect(readFileSync(join(out, 'dry-run-summary.json'), 'utf8')).not.toContain('"document"');

    // Someone edits one case after the review.
    cases.changed.revision++; cases.changed.document.title = 'Changed after the dry run';
    cases.changed.document.surfaces[0].scene = `${cases.changed.document.surfaces[0].scene} Edited.`;
    const applied = await run(['--apply']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(line(applied, cases.plain)).toContain('converted to schema 3: revision 5 (checkpoint "Before slides (2026-10-11)" holds revision 4)');
    expect(line(applied, cases.full)).toContain('not converted: checkpoint refused');
    expect(line(applied, cases.review)).toContain('skipped: under review (pending)');
    expect(line(applied, cases.recent)).toContain('skipped: edited in the last 10 minutes');
    expect(line(applied, cases.lostAck)).toContain('converted to schema 3: revision 5');
    expect(line(applied, cases.changed)).toContain('skipped: the draft changed since the dry run');
    expect(line(applied, cases.flaky)).toContain('failed at window');
    for (const item of [cases.full, cases.review, cases.recent, cases.changed, cases.flaky]) expect(item.saves).toBeUndefined();
    expect(line(applied, cases.schema1Variants)).toContain('converted to schema 2: revision 4');
    expect(cases.schema1Variants.document.schema_version).toBe(2);
    expect(cases.schema1Variants.document.surfaces.filter(surface => surface.variants?.length)).toHaveLength(2);
    expect(validateBuilderDocument(cases.schema1Variants.document, cases.schema1Variants.metadata, { mode: 'preserve' }).ok).toBe(true);
    expect(line(applied, cases.schema1Plain)).toContain('converted to schema 3: revision 4');
    for (const item of [cases.plain, cases.lostAck, cases.schema1Plain]) {
      expect(item.saves).toBe(1);
      expect(item.checkpoints.map(row => [row.name, row.revision])).toEqual([['Before slides (2026-10-11)', item === cases.schema1Plain ? 3 : 4]]);
      expect(validateBuilderDocument(item.document, item.metadata, { mode: 'preserve', validateSlides: validateSlideParts }).ok).toBe(true);
    }

    // Re-run: the flaky case reuses its checkpoint and converts; converted cases are left alone.
    const creates = fake.calls.filter(call => call.name === 'builder_create_checkpoint').length;
    const again = await run(['--apply']);
    expect(again.status, again.stderr).toBe(0);
    expect(line(again, cases.flaky)).toContain('converted to schema 3: revision 5');
    expect(cases.flaky.checkpoints).toHaveLength(1);
    expect(line(again, cases.plain)).toContain('already schema 3');
    expect(line(again, cases.schema1Variants)).toContain('already schema 2');
    expect(cases.plain.saves).toBe(1);
    expect(fake.calls.filter(call => call.name === 'builder_create_checkpoint').length - creates).toBe(1); // only the full case retries
  } finally { fake.close(); }
});

test('[AS-157] --titles plans an H1 on converted slides only, leaves arranged slides alone, applies with its own checkpoint and re-runs as a no-op', async () => {
  test.setTimeout(240_000);
  const parsed = parseBuilderTransfer(readFileSync(join(ROOT, 'tests/fixtures/synthetic/builder-diving-polished-transfer.json'), 'utf8'));
  const candidate = (await inspectBuilderTransfer(parsed.envelope, {})).candidate;
  for (const surface of candidate.document.surfaces) delete surface.variants;
  const metadata = candidate.authoring_metadata ?? candidate.authoringMetadata;
  // A draft converted before CASE-222: the conversion's own layouts, no title blocks.
  const converted = convertToSlideDocument(candidate.document, metadata, { createId: uuidv7 }).candidate;
  const titles = new Set(converted.document.compositions.map(item => item.reading_order[0])), old = structuredClone(converted.document);
  old.blocks = old.blocks.filter(block => !titles.has(block.id));
  for (const composition of old.compositions) {
    composition.reading_order = composition.reading_order.filter(id => !titles.has(id));
    composition.steps = composition.steps.map(step => ({ ...step, block_ids: step.block_ids.filter(id => !titles.has(id)) }));
    const beat = old.beats.find(item => item.id === composition.owner.id), decision = beat?.kind === 'decision' ? old.decisions.find(item => item.id === beat.decision_id) : null;
    Object.assign(composition, layoutCandidates(composition.reading_order.map(id => old.blocks.find(block => block.id === id)), decision)[0]);
  }
  const arranged = structuredClone(old), nudged = arranged.compositions.find(item => item.placements.length > 1);
  nudged.placements[0] = { ...nudged.placements[0], w: nudged.placements[0].w - 1 };
  const draft = (title, document) => ({ caseId: uuidv7(), revision: 7, document: { ...structuredClone(document), title }, metadata: structuredClone(converted.authoringMetadata), checkpoints: [], updatedAt: HOUR_AGO });
  const cases = { slides: draft('Converted slides', old), arranged: draft('One slide arranged', arranged), legacy: draft('Still legacy', candidate.document) };
  const owned = uuidv7(), fake = await fakeSupabase(Object.values(cases), { owned, viewed: uuidv7() });
  const out = mkdtempSync(join(tmpdir(), 'titles-'));
  const run = extra => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/convert-drafts-to-slides.mjs', '--titles', '--email', 'owner@example.invalid', '--out', out, ...extra],
      { cwd: ROOT, env: { ...process.env, CASE_SUPABASE_URL: fake.url, CASE_SUPABASE_SECRET_KEY: 'test-key' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  const line = (result, item) => result.stdout.split('\n').find(text => text.startsWith(`${item.document.title} — `)) ?? '';
  const slides = old.compositions.length;
  try {
    const dry = await run([]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(fake.calls.filter(call => /create_checkpoint|window|save_draft/.test(call.name))).toEqual([]);
    expect(line(dry, cases.slides)).toContain(`planned titles on ${slides} slides`);
    expect(line(dry, cases.arranged)).toContain(`planned titles on ${slides - 1} slides; left alone: ${nudged.owner.kind}:${nudged.owner.id} (arranged by an author; add the title by hand)`);
    expect(line(dry, cases.legacy)).toContain('schema 2: not on slides; unchanged');

    const applied = await run(['--apply']);
    expect(applied.status, applied.stderr).toBe(0);
    for (const item of [cases.slides, cases.arranged]) {
      expect(line(applied, item)).toContain('titled: revision 8 (checkpoint "Before slide titles (2026-10-12)" holds revision 7)');
      expect(item.saves).toBe(1);
      expect(validateBuilderDocument(item.document, item.metadata, { mode: 'preserve', validateSlides: validateSlideParts }).ok).toBe(true);
    }
    expect(cases.legacy.saves).toBeUndefined();
    // The arranged slide is byte-identical; every other slide opens with its surface's heading as an H1.
    expect(cases.arranged.document.compositions.find(item => item.id === nudged.id)).toEqual(nudged);
    for (const composition of cases.slides.document.compositions) {
      const lead = cases.slides.document.blocks.find(block => block.id === composition.reading_order[0]);
      expect(lead.paragraphs[0].style).toBe('h1');
      expect(composition.steps[0].block_ids[0]).toBe(lead.id);
      expect(composition.placements.find(item => item.block_id === lead.id)).toMatchObject({ col: 1, row: 1, w: 12 });
    }
    // A fresh dry run finds nothing more to add.
    const again = await run([]);
    expect(line(again, cases.slides)).toContain('nothing to add');
  } finally { fake.close(); }
});
