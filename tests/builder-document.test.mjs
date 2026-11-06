import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { BUILDER_DOCUMENT_MAX_BYTES } from '../src/shared/builder-document.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { readFileSync } from 'node:fs';

const capabilities = ['formatted_text', 'human_interpretation', 'required_recovery', 'early_clarification'];
function v2Case() {
  const doc = miniCase().doc;
  doc.schema_version = 2;
  doc.duration_min = 30;
  doc.required_capabilities = [...capabilities];
  doc.clarifications = [];
  for (const decision of doc.decisions) decision.interpretation = 'rules';
  for (const decision of doc.decisions) for (const path of decision.paths) path.recovery = { prompt: 'Reassess and continue.' };
  return doc;
}

test('schema2 preservation retains over-presentation writing while strict readiness blocks it', () => {
  const doc = v2Case();
  doc.surfaces[0].scene = 's'.repeat(501);
  doc.summary = 's'.repeat(1201);
  const preserved = validateBuilderDocument(doc);
  assert.equal(preserved.ok, true);
  assert.ok(preserved.warnings.some(issue => issue.at === '/surfaces/0/scene'));
  assert.ok(preserved.warnings.some(issue => issue.at === '/summary'));
  const ready = validateBuilderDocument(doc, undefined, { mode: 'ready' });
  assert.equal(ready.ok, false);
  assert.ok(ready.errors.some(issue => issue.at === '/surfaces/0/scene'));
  assert.ok(ready.errors.some(issue => issue.at === '/summary'));
});

test('schema1 default validator behavior remains closed to schema2', () => {
  const doc = v2Case();
  assert.ok(validateCaseDocument(doc).errors.some(issue => issue.code === 'schema_version'));
  assert.equal(validateCaseDocument(doc, { profile: 'schema2' }).ok, true);
});

test('preservation rejects unknown keys, invalid IDs and duplicate graph IDs', () => {
  const doc = v2Case();
  doc.surfaces[0].unknown_extension = true;
  assert.ok(validateBuilderDocument(doc).errors.some(issue => issue.code === 'unknown_key'));
  delete doc.surfaces[0].unknown_extension;
  doc.surfaces[1].id = doc.surfaces[0].id;
  assert.ok(validateBuilderDocument(doc).errors.some(issue => issue.code === 'duplicate_id'));
  doc.surfaces[1].id = 'invalid';
  assert.ok(validateBuilderDocument(doc).errors.some(issue => issue.code === 'bad_id'));
});

test('schema1 preservation refuses formatted object values instead of silently importing v2 semantics', () => {
  const doc = miniCase().doc;
  doc.surfaces[0].scene = { blocks: [{ type: 'paragraph', runs: [{ text: 'v2 only' }] }] };
  const result = validateBuilderDocument(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(issue => issue.code === 'type' && issue.at === '/surfaces/0/scene'));
});

test('schema2 recovery is optional per path and formatted terminal debriefs imply the capability', () => {
  const doc = v2Case();
  const paths = doc.decisions[0].paths;
  for (const path of paths.slice(1)) delete path.recovery;
  const terminal = paths.find(path => path.classification === 'terminal-unsafe');
  terminal.terminal.debrief_prompt = { blocks: [{ type: 'paragraph', runs: [{ text: 'Review the recovery.' }] }] };
  doc.required_capabilities = doc.required_capabilities.filter(capability => capability !== 'formatted_text');
  const preserved = validateBuilderDocument(doc);
  assert.equal(preserved.ok, true);
  assert.ok(preserved.warnings.some(issue => issue.code === 'missing_capability' && issue.message.includes('formatted_text')));
  assert.equal(validateCaseDocument(doc, { profile: 'schema2' }).ok, true);
});

test('rich scene text round-trips unchanged and strict validation measures its plain text', () => {
  const doc = v2Case();
  const scene = { blocks: [{ type: 'paragraph', runs: [{ text: 'First ' }, { text: 'bold', bold: true }, { text: ' line.' }] }] };
  doc.surfaces[0].scene = scene;
  const preserved = validateBuilderDocument(doc);
  assert.equal(preserved.ok, true);
  assert.deepEqual(doc.surfaces[0].scene, scene);
  assert.equal(validateBuilderDocument(doc, undefined, { mode: 'ready' }).ok, true);
  doc.surfaces[0].scene.blocks[0].runs[0].text = 'x'.repeat(489);
  assert.equal(validateBuilderDocument(doc, undefined, { mode: 'ready' }).ok, true, 'formatted scene text at the ceiling is ready');
  doc.surfaces[0].scene.blocks[0].runs[0].text = 'x'.repeat(491);
  assert.ok(validateBuilderDocument(doc, undefined, { mode: 'ready' }).errors.some(issue => issue.at === '/surfaces/0/scene'));
});

test('formatted schema2 scene can carry the projected content without a points array', () => {
  const doc = v2Case();
  doc.surfaces[0].scene = { blocks: [{ type: 'paragraph', runs: [{ text: 'A complete scene.' }] }] };
  doc.surfaces[0].points = [];
  assert.equal(validateBuilderDocument(doc, undefined, { mode: 'ready' }).ok, true);
  assert.equal(validateCaseDocument(doc, { profile: 'schema2' }).ok, true);
  assert.equal(validateCaseDocument(doc).ok, false, 'schema1 retains its historical finding requirement');
});

test('human interpretation permits missing automation rules without inventing keywords', () => {
  const doc = v2Case();
  const decision = doc.decisions[0];
  decision.interaction.type = 'free_text';
  decision.interaction.max_length = 280;
  delete decision.interaction.options;
  decision.interpretation = 'facilitator';
  delete decision.rules;
  for (const path of decision.paths) delete path.option_ids;
  assert.equal(validateBuilderDocument(doc, undefined, { mode: 'ready' }).ok, true);
  decision.interaction.max_length = 500;
  assert.equal(validateBuilderDocument(doc).ok, true, '500-character response limit can be preserved');
  assert.equal(validateBuilderDocument(doc, undefined, { mode: 'ready' }).ok, true, '500-character response limit is ready');
  decision.interaction.max_length = 501;
  assert.ok(validateBuilderDocument(doc).warnings.some(issue => issue.at === '/decisions/0/interaction/max_length'));
  assert.ok(validateBuilderDocument(doc, undefined, { mode: 'ready' }).errors.some(issue => issue.at === '/decisions/0/interaction/max_length'));
  decision.interaction.max_length = 280;
  decision.rules = [{ when: { keywords: ['invented'] }, path_id: decision.paths[0].id }];
  assert.ok(validateBuilderDocument(doc, undefined, { mode: 'ready' }).errors.some(issue => issue.at === '/decisions/0/rules'));
});

test('known required capabilities omitted by incomplete work are repair warnings until ready', () => {
  const doc = v2Case();
  doc.required_capabilities = ['formatted_text'];
  const preserved = validateBuilderDocument(doc);
  assert.equal(preserved.ok, true);
  assert.ok(preserved.warnings.some(issue => issue.code === 'missing_capability'));
  assert.ok(validateBuilderDocument(doc, undefined, { mode: 'ready' }).errors.some(issue => issue.code === 'missing_capability'));
  doc.required_capabilities.push('future_runtime');
  assert.ok(validateBuilderDocument(doc).errors.some(issue => issue.code === 'unknown_capability'));
});

test('clarifications retain valid identities and report unresolved references', () => {
  const doc = v2Case();
  doc.clarifications = [{ id: uuidv7(), label: 'Look at the eyes', surface_id: uuidv7(), beat_ids: [uuidv7()] }];
  assert.equal(validateBuilderDocument(doc).ok, true);
  assert.ok(validateBuilderDocument(doc, undefined, { mode: 'ready' }).errors.some(issue => issue.code === 'ref'));
});

test('the 571150-byte legacy-valid witness remains within preservation bounds', () => {
  const doc = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
  const template = structuredClone(doc.surfaces[0]);
  while (doc.surfaces.length < 200) {
    const n = doc.surfaces.length;
    const surface = structuredClone(template);
    surface.id = `0199a000-0000-7000-8000-${String(n + 1).padStart(12, '0')}`;
    surface.notes = 'n'.repeat(2000);
    doc.surfaces.push(surface);
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(doc)).byteLength;
  assert.equal(serializedBytes, 571150);
  assert.equal(validateCaseDocument(doc).ok, true);
  assert.ok(serializedBytes < 1024 * 1024);
  const before = JSON.stringify(doc);
  assert.equal(validateBuilderDocument(doc).ok, true);
  assert.equal(JSON.stringify(doc), before, 'legacy read/preservation does not rewrite the source');
});

test('schema1 incomplete safe work is preserved and strict readiness names its repair', () => {
  const doc = miniCase().doc;
  doc.surfaces[0].scene = '';
  doc.beats[0].next_beat_id = uuidv7();
  const preserved = validateBuilderDocument(doc);
  assert.equal(preserved.ok, true);
  assert.ok(preserved.warnings.some(issue => issue.at === '/surfaces/0/scene'));
  assert.ok(preserved.warnings.some(issue => issue.at === '/beats/0/next_beat_id'));
  assert.equal(validateBuilderDocument(doc, undefined, { mode: 'ready' }).ok, false);
});

test('schema1 conversion is an explicit copy that preserves authored graph IDs and adds no recovery content', () => {
  const source = miniCase().doc;
  const original = JSON.stringify(source);
  const graphIds = value => {
    const ids = [];
    const visit = item => {
      if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object') {
        if (typeof item.id === 'string') ids.push(item.id);
        Object.values(item).forEach(visit);
      }
    };
    visit(value);
    return ids;
  };
  const beforeIds = graphIds(source);
  const converted = convertSchema1ToBuilderDocument(source);
  assert.equal(converted.ok, true);
  assert.equal(JSON.stringify(source), original);
  assert.deepEqual(graphIds(converted.candidate), beforeIds);
  assert.equal(converted.candidate.schema_version, 2);
  assert.deepEqual(converted.candidate.required_capabilities, []);
  assert.ok(converted.candidate.decisions.every(decision => ['rules', 'facilitator'].includes(decision.interpretation)));
  assert.ok(converted.candidate.decisions.flatMap(decision => decision.paths).every(path => !Object.hasOwn(path, 'recovery')));
  assert.ok(!converted.candidate.required_capabilities.includes('required_recovery'));
  assert.equal(validateBuilderDocument(converted.candidate, undefined, { mode: 'ready' }).ok, true);
});

test('oversized schema1 conversion refuses atomically and leaves the legacy source unchanged', () => {
  const source = miniCase().doc;
  const initialBytes = new TextEncoder().encode(JSON.stringify(source)).byteLength;
  source.summary = 's'.repeat(source.summary.length + BUILDER_DOCUMENT_MAX_BYTES - initialBytes - 8);
  const original = JSON.stringify(source);
  assert.ok(new TextEncoder().encode(original).byteLength <= BUILDER_DOCUMENT_MAX_BYTES);
  const result = convertSchema1ToBuilderDocument(source);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(issue => issue.code === 'too_large'));
  assert.equal(JSON.stringify(source), original);
  assert.equal(Object.hasOwn(result, 'candidate'), false);
});

test('object-level depth, value and issue limits remain bounded', () => {
  const doc = v2Case();
  assert.ok(validateBuilderDocument(doc, undefined, { maxDepth: 1 }).errors.some(issue => issue.code === 'too_deep'));
  assert.ok(validateBuilderDocument(doc, undefined, { maxNodes: 10 }).errors.some(issue => issue.code === 'too_many_nodes'));
  for (let i = 0; i < 250; i++) doc[`unknown_${i}`] = true;
  const result = validateBuilderDocument(doc);
  assert.equal(result.errors.length, 200);
  assert.ok(result.remainingIssues >= 50);
  assert.equal(result.issuesTruncated, true);
});
