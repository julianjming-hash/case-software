// CASE-321 (owner rulings 2026-10-30): the simple Sources flow writes today's data shape. A "Based on" link is a confirmed
// whole-source trace that passes the publishing gate; the permission tick is the rights status; editing a source's text
// re-ranges its whole-source links so they never become out-of-range blockers. Each gate is also shown firing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderCitationParts, builderCitationSource, builderSourceSha256, validateBuilderMetadata } from '../src/shared/builder-metadata.mjs';
import { wholeSourceTrace, isWholeSourceTrace, rerangeWholeSourceTraces, sourceLineCount } from '../src/shared/builder-provenance.mjs';
import { builderPublicationIssues } from '../src/shared/builder-publication.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { createBuilderStarter, createBuilderStoryStarter } from '../src/client/builder-templates.mjs';
import { invalidateChangedProvenance } from '../src/client/builder-studio.mjs';
import { plainField, entityLabel } from '../src/client/builder-sources.mjs';

const SOURCE_CODES = /^(rights_|source_|provenance_)/;
const sourceIssues = (document, metadata, options = {}) =>
  builderPublicationIssues(document, metadata, validateBuilderDocument(document, metadata, { mode: 'ready', ...options })).filter(issue => SOURCE_CODES.test(issue.code));

async function cited({ permitted = true, story = false } = {}) {
  const starter = story ? createBuilderStoryStarter() : createBuilderStarter('single_choice');
  const source = builderCitationSource({ id: '0199a000-0000-7000-8000-0000000c3221', citation: 'https://ginasthma.org/reports/2024', locator: 'Box 9-4, p. 185', permitted, sha256: '' });
  source.sha256 = await builderSourceSha256(source.text);
  const beat = starter.document.beats.find(item => item.id === starter.document.start_beat_id);
  const metadata = { ...starter.authoringMetadata, sources: [source], provenance: [wholeSourceTrace(beat.id, 'title', source)] };
  return { document: starter.document, metadata, source, beat, options: story ? { validateSlides: validateSlideParts } : {} };
}

test('[AS-191] a citation is stored as today’s five-key source: short name, citation then locator, tick → rights status', async () => {
  assert.deepEqual(builderCitationParts('https://www.ginasthma.org/reports/2024', 'Box 9-4'), { title: 'ginasthma.org', text: 'https://www.ginasthma.org/reports/2024\nBox 9-4' });
  assert.deepEqual(builderCitationParts('  GINA. Global Strategy for Asthma, 2024 update.\n\n', ''), { title: 'GINA. Global Strategy for Asthma, 2024 update.', text: 'GINA. Global Strategy for Asthma, 2024 update.' });
  assert.ok(builderCitationParts(`Leatherman J. ${'Mechanical ventilation for severe asthma. '.repeat(6)}`).title.length <= 120);
  const ticked = builderCitationSource({ id: '0199a000-0000-7000-8000-0000000c3222', citation: 'BTS/SIGN 158', permitted: true, sha256: 'a'.repeat(64) });
  const unticked = builderCitationSource({ id: '0199a000-0000-7000-8000-0000000c3223', citation: 'BTS/SIGN 158', sha256: 'a'.repeat(64) });
  assert.deepEqual(Object.keys(ticked).sort(), ['id', 'rights_status', 'sha256', 'text', 'title']);
  assert.equal(ticked.rights_status, 'permitted');
  assert.equal(unticked.rights_status, 'unknown');
  // The unticked source is exactly what the rights gate refuses; the ticked one is what it accepts.
  const { document, metadata } = await cited({ permitted: false });
  assert.deepEqual(sourceIssues(document, metadata).map(issue => issue.code), ['rights_unresolved']);
  metadata.sources[0].rights_status = 'permitted';
  assert.deepEqual(sourceIssues(document, metadata), []);
});

for (const story of [false, true]) test(`[AS-191] a Based on link (confirmed whole-source trace) passes the client publish gate${story ? ' on a slide draft' : ''}`, async () => {
  const { document, metadata, source, beat, options } = await cited({ story });
  const [trace] = metadata.provenance;
  assert.deepEqual(trace, { entity_id: beat.id, field: 'title', source_id: source.id, start_line: 1, end_line: 2, transformation: 'adapted', visibility: 'private', review_status: 'confirmed' });
  assert.equal(validateBuilderMetadata(metadata).ok, true);
  assert.deepEqual(sourceIssues(document, metadata, options), []);
  // Known answers: the same link unconfirmed, stale, out of range, or on a missing record is refused.
  for (const [change, code] of [[{ review_status: 'unreviewed' }, 'provenance_unreviewed'], [{ review_status: 'stale' }, 'provenance_stale'], [{ end_line: 3 }, 'source_range'],
    [{ entity_id: '0199a000-0000-7000-8000-0000000c3229' }, 'provenance_entity_missing']]) {
    const broken = { ...metadata, provenance: [{ ...trace, ...change }] };
    assert.ok(sourceIssues(document, broken, options).some(issue => issue.code === code), code);
  }
  // A source whose digest no longer matches its text is refused by the server's gate; the client never claims it.
  assert.equal(await builderSourceSha256(source.text), source.sha256);
});

test('[AS-191] editing a source’s text re-ranges its whole-source links only; the change still asks for review', async () => {
  const { document, metadata, source } = await cited();
  const precise = { ...metadata.provenance[0], start_line: 2, end_line: 2, review_status: 'confirmed' };
  const provenance = [...metadata.provenance, precise];
  const longer = `${source.text}\nChecked 30 October 2026\nOwner's note`;
  const reranged = rerangeWholeSourceTraces(provenance, source.id, source.text, longer);
  assert.equal(sourceLineCount(longer), 4);
  // Counted as the SQL gate counts them, regexp_count(text, '\r\n|\n|\r') + 1: CRLF is one break, a trailing break adds a line.
  for (const [text, lines] of [['a', 1], ['a\r\nb', 2], ['a\n\rb', 3], ['a\rb\rc', 3], ['a\n', 2], ['', 1]]) assert.equal(sourceLineCount(text), lines, JSON.stringify(text));
  assert.equal(reranged[0].end_line, 4);
  assert.deepEqual(reranged[1], precise, 'a precise range is not moved');
  assert.ok(isWholeSourceTrace(reranged[0], { ...source, text: longer }));
  const nextMetadata = { ...metadata, sources: [{ ...source, text: longer }], provenance: reranged };
  assert.ok(!validateBuilderMetadata(nextMetadata).warnings.some(issue => issue.code === 'source_range'));
  // Without the re-range a shorter text leaves the link out of range: the blocker this prevents.
  const shorter = 'GINA 2024';
  const stuck = { ...metadata, sources: [{ ...source, text: shorter }] };
  assert.ok(validateBuilderMetadata(stuck).warnings.some(issue => issue.code === 'source_range'));
  const fixed = { ...stuck, provenance: rerangeWholeSourceTraces(metadata.provenance, source.id, source.text, shorter) };
  assert.equal(fixed.provenance[0].end_line, 1);
  assert.ok(!validateBuilderMetadata(fixed).warnings.some(issue => issue.code === 'source_range'));
  // The source changed, so the studio's invalidation still marks the link for review (Readiness: changed since cited).
  assert.equal(invalidateChangedProvenance(document, metadata, document, nextMetadata).provenance[0].review_status, 'stale');
  assert.equal(rerangeWholeSourceTraces(provenance, source.id, source.text, source.text), provenance, 'same length: unchanged');
});

test('detailed traces are named in plain English, never by schema path', () => {
  assert.equal(plainField('observations[2].unit'), 'Observation 3 · Unit');
  assert.equal(plainField('points[0]'), 'Finding 1');
  assert.equal(plainField('variants[0].points[1]'), 'Variant 1 · Finding 2');
  assert.equal(plainField('terminal.debrief_prompt'), 'Checkpoint · Debrief question');
  assert.equal(plainField('paragraphs[3]'), 'Paragraph 4');
  assert.equal(plainField('some_new_field'), 'Some new field');
  assert.equal(entityLabel({ kind: 'block', label: 'Slide · First gas · Values row 2 · “SpO2”' }, 'Slide 4 · First gas'), 'Slide 4 · First gas · Values row 2 · “SpO2”');
  assert.equal(entityLabel({ kind: 'surface', label: 'Learner content · Gas' }, 'Slide 4 · First gas'), 'Slide 4 · First gas · Learner content');
  assert.equal(entityLabel({ kind: 'flag', label: 'Narrative flag · Intubated' }, null), 'Narrative flag · Intubated');
});
