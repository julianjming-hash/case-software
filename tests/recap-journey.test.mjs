// Card 40b participant recap (card 40 + feedback integration, slice 7). The recap is a case journey built only from the
// phone's own ended view: its `timeline` (what this room was shown, in order, resets included) plus each recap round's
// `revealIndex` (ruling I4). These check the journey model and the built-in PDF, read back the way assistive technology
// reads it (tests/helpers/pdf-read.mjs). Expected stops are hand-written from the fixture below, not from the renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { walkRoom } from './helpers/room-walk.mjs';
import { readPdf } from './helpers/pdf-read.mjs';
import { project } from '../src/shared/room-machine.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { recapJourney } from '../src/client/recap-journey.mjs';
import { recapRows, RECAP_CHROME } from '../src/client/recap-pdf.mjs';

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const pdfOf = (journey) => readPdf(sessionPdf(recapRows(journey), { title: journey.title }));
const infoTitle = (pdf) => { const m = pdf.text.match(/\/Info (\d+) 0 R/); const hex = pdf.objects.get(Number(m[1])).match(/\/Title <FEFF([0-9A-F]*)>/)[1];
  return String.fromCharCode(...hex.match(/.{4}/g).map((h) => parseInt(h, 16))); };

// ── a schema-3 room, hand-built: slides, a question slide per decision, revealed teaching slides, a clarification, a
// discussion question that reveals nothing, a terminal route and the same question asked again after the reset ──
const AT = '2026-10-19T09:00:00.000Z';
const para = (t) => ({ runs: [{ text: t }] });
const text = (id, ...ps) => ({ id, type: 'text', paragraphs: ps.map(para) });
const q = (id) => ({ id, type: 'question' });
let n = 0;
const slide = (title, blocks, kind = 'live') => ({ surfaceId: `s${++n}`, kind: 'update', title, assetIds: [], timelineKind: kind, manual: false, at: AT,
  slide: { template: 'single', blocks, placements: [], reading_order: blocks.map((b) => b.id), styles: [] } });
function fixture({ code = 'ABC234', name = 'Robin Canary', dropQuestionBlock = false } = {}) {
  n = 0;
  const timeline = [
    slide('Day 1 · Arrival', [text('t0', 'Day 1 · Arrival'), text('t0b', 'A diver surfaces with calf pain.')]),
    slide('Day 1 · Likelihood', [text('t1', 'Consider the dive profile.'), ...(dropQuestionBlock ? [] : [q('q1')])]),
    slide('Day 1 · Why recompression helps', [text('t2', 'Recompression shrinks bubbles.')], 'consequence'),
    slide('Day 2 · Ask', [q('q2')]),
    slide('Day 2 · Results', [{ id: 'v1', type: 'values', rows: [{ id: 'r1', label: 'CK', value: '12000', unit: 'U/L' }, { id: 'r2', label: 'BP (nadir → after)', value: '66/40 → 94/58' }] }]),
    slide('Dive profile', [{ id: 'l1', type: 'list', ordered: false, items: [para('30 m for 25 min')] }], 'clarification'),
    slide('Day 2 · Rank the differential', [q('q3')]),
    slide('Day 2 · Arrest', [text('t7', 'Cardiac arrest in the chamber.')], 'terminal'),
    slide('Day 2 · Rank the differential', [q('q3b')]),
    slide('Day 3 · Fasciotomy', [text('t9', 'Compartment pressures were high.'), { id: 'i9', type: 'image', alt: 'Calf at operation' }], 'consequence'),
  ];
  const round = (o) => ({ decisionId: 'd', prompt: '', roundNo: 1, status: 'resolved', optionIds: [], yourResponse: null, yourAnswer: null, yourClassification: null,
    why: null, doDifferently: null, teamChoice: 'majority', whatHappened: null, revealIndex: null, ...o });
  const rounds = [
    round({ decisionId: 'd1', prompt: 'How likely is decompression sickness?', optionIds: ['a', 'b', 'c'], yourResponse: { option_id: 'b' }, yourAnswer: 'Likely',
      yourClassification: 'defensible', why: 'Bubbles explain the pain.', whatHappened: 'Day 1 · Why recompression helps', revealIndex: 2 }),
    round({ decisionId: 'd2', prompt: 'What would you ask next?', yourResponse: { text: 'Any floodwater on the trip?' }, yourAnswer: 'Any floodwater on the trip?' }),
    round({ decisionId: 'd3', prompt: 'Rank the differential', optionIds: ['x', 'y', 'z'], yourResponse: { order: ['y', 'x', 'z'] }, yourAnswer: 'Myositis → DCS → Leptospirosis',
      yourClassification: 'unsafe', why: 'Delays recompression.', doDifferently: 'Recommended here: DCS first. Treat the bubbles.', whatHappened: 'Day 2 · Arrest', revealIndex: 7 }),
    round({ decisionId: 'd3', prompt: 'Rank the differential', status: 'superseded', optionIds: ['x', 'y', 'z'], yourResponse: { order: ['x', 'z', 'y'] }, yourAnswer: 'DCS → Leptospirosis → Myositis' }),
    round({ decisionId: 'd3', prompt: 'Rank the differential', roundNo: 2, optionIds: ['x', 'y', 'z'], yourResponse: { order: ['x', 'y', 'z'] }, yourAnswer: 'DCS → Myositis → Leptospirosis',
      yourClassification: 'sound', whatHappened: 'Day 3 · Fasciotomy', revealIndex: 9 }),
    round({ decisionId: 'd4', prompt: 'Which tests now?', optionIds: ['m', 'n'], yourResponse: null, yourAnswer: null }),
  ];
  return { role: 'participant', phase: 'ended', caseTitle: 'Diving deeper', you: { id: '00000000-0000-7000-8000-00000000abcd', name, avatarId: null },
    timeline, recap: { caseTitle: 'Diving deeper', caseVersionNo: 2, expiresAt: '2026-10-20T09:00:00.000Z', rounds,
      learningPoints: ['Recognise decompression sickness.', 'Know when to recompress.'], teamPath: [], ...(code ? { feedbackCode: code } : {}) } };
}

test('[card 40b recap] each question joins its own slide; its revealed slide follows; resets and repeats stay in room order', () => {
  const j = recapJourney(fixture());
  assert.deepEqual(j.stops.map((s) => [s.kind, s.index]), [
    ['slide', 0], ['question', 1], ['reveal', 2], ['question', 3], ['slide', 4], ['slide', 5], ['question', 6], ['reveal', 7], ['question', 8], ['reveal', 9],
    ['question', null]]);
  const qs = j.stops.filter((s) => s.kind === 'question');
  assert.deepEqual(qs.map((s) => s.question.prompt), ['How likely is decompression sickness?', 'What would you ask next?', 'Rank the differential', 'Rank the differential', 'Which tests now?']);
  assert.deepEqual(qs.map((s) => s.question.shape), ['single_choice', 'free_text', 'ranking', 'ranking', null], 'an unanswered choice question has no shape to show');
  // The question asked again after the reset carries both of that ask's rounds (the superseded one and the final one).
  assert.deepEqual(qs[3].question.rounds.map((r) => r.roundNo), [1, 2]);
  assert.deepEqual(qs[0].question.rounds[0].marks, [1], 'the mark is the option position in the shared order');
  assert.deepEqual(qs[2].question.rounds[0].marks, [1, 0, 2], 'a ranking keeps its order');
  // The unanswered question (d4) has no slide in this timeline and no reveal: it closes the journey, never dropped.
  // Chapters open where a title's "Label · " prefix changes; a title without one opens none.
  assert.deepEqual(j.stops.map((s) => s.chapter), ['Day 1', null, null, 'Day 2', null, null, null, null, null, 'Day 3', null]);
  assert.deepEqual(j.objectives, ['Recognise decompression sickness.', 'Know when to recompress.']);
});

test('[card 40b recap] a question whose slide was not released stands alone just before the slide it revealed', () => {
  const j = recapJourney(fixture({ dropQuestionBlock: true }));
  assert.deepEqual(j.stops.slice(0, 4).map((s) => [s.kind, s.index]), [['slide', 0], ['slide', 1], ['question', null], ['reveal', 2]]);
});

test('[card 40b recap] Give feedback exists only with a valid feedback code', () => {
  assert.equal(recapJourney(fixture()).feedbackCode, 'ABC234');
  assert.equal(recapJourney(fixture({ code: null })).feedbackCode, null);
  assert.equal(recapJourney(fixture({ code: 'not-a-code' })).feedbackCode, null);
});

test('[card 40b recap] the PDF reads Objectives, then The Case; no session facts, explanation or expiry wording', () => {
  const pdf = pdfOf(recapJourney(fixture())), lines = pdf.lines.map(norm);
  const obj = lines.indexOf(RECAP_CHROME.objectives), theCase = lines.indexOf(RECAP_CHROME.theCase);
  assert.equal(RECAP_CHROME.objectives, 'Objectives');
  assert.equal(RECAP_CHROME.theCase, 'The Case');
  assert.ok(lines.indexOf('Diving deeper') >= 0 && lines.indexOf('Diving deeper') < obj, 'the case title opens the recap');
  assert.ok(obj > 0 && theCase > obj, 'Objectives precede The Case');
  const all = lines.join('\n');
  for (const banned of ['What this case teaches', 'What the room was shown', 'Session', 'Online until', 'Yours to keep', 'This file', 'Chosen by', 'facilitator',
    'majority', 'Your private recap', 'expire', '24 h']) assert.ok(!all.includes(banned), `the recap PDF says "${banned}"`);
  // Revealed teaching slides are carried with their content (ruling A), in room order after their question.
  const at = (t) => lines.findIndex((l) => l.includes(t));
  assert.ok(at('How likely is decompression sickness?') < at('Recompression shrinks bubbles.'));
  assert.ok(at('Rank the differential') < at('Cardiac arrest in the chamber.'));
  assert.ok(at('Cardiac arrest in the chamber.') < at('Compartment pressures were high.'), 'the reset branch reads as visited, in order');
  assert.ok(at('CK') > 0 && at('30 m for 25 min') > 0 && at('Calf at operation') > 0);
  // The font has no arrow: it is drawn as a shape that reads back as the arrow, never substituted or refused.
  assert.ok(lines.includes('BP (nadir → after)') && lines.includes('66/40 → 94/58'));
});

test('[card 40b recap] each question shows its shape, your own answer, and the classification as glyph and word', () => {
  const pdf = pdfOf(recapJourney(fixture())), lines = pdf.lines.map(norm), all = lines.join('\n');
  const spans = pdf.tree.filter((t) => t.type === 'Span').map((t) => t.actual);
  for (const shape of ['Single choice', 'Free text', 'Ranking']) assert.ok(spans.includes(shape), `the ${shape} glyph has its word for a reader`);
  assert.ok(all.includes('Likely') && all.includes('Any floodwater on the trip?'));
  for (const label of ['Myositis', 'DCS', 'Leptospirosis']) assert.ok(lines.some((l) => l.endsWith(label)), `ranked ${label}`);
  assert.ok(!all.includes('Myositis → DCS'), 'a ranking is a list, never an arrow string');
  for (const word of ['Defensible', 'Unsafe · recoverable', 'Sound']) assert.ok(lines.some((l) => l.includes(word)), word);
  assert.ok(spans.includes('Blue diamond'), 'an option mark is read by its name');
  assert.ok(all.includes('Bubbles explain the pain.') && all.includes('Recommended here: DCS first.'));
});

test('[card 40b recap] no name, token, id, feedback code or URL in the PDF text or its title', () => {
  const view = fixture(), pdf = pdfOf(recapJourney(view));
  const all = pdf.lines.join('\n');
  for (const leak of ['Robin', 'Canary', view.you.id, 'ABC234', 'http', '/F/', 'case.iatrogenic']) assert.ok(!all.includes(leak) && !pdf.text.includes(leak), `PDF carries ${leak}`);
  assert.equal(infoTitle(pdf), 'Diving deeper');
  assert.ok(!JSON.stringify(recapJourney(view).stops).includes('Robin'), 'the journey model never holds the name');
});

// ── the real room machine: every ended participant view the walk reaches, with a canary in every private field and in
// every surface title the room never revealed ──
const { pid, states } = walkRoom();
function canaryDoc(state) {
  const doc = structuredClone(state.caseDoc), revealed = new Set(state.revealed.map((e) => e.surfaceId));
  for (const s of doc.surfaces) { s.notes = `CANARY-NOTES-${s.id}`; if (!revealed.has(s.id)) s.title = `CANARY-UNREVEALED-${s.id}`; }
  for (const b of doc.beats) b.cue = `CANARY-CUE-${b.id}`;
  for (const d of doc.decisions) for (const p of d.paths) p.cue = `CANARY-CUE-${p.id}`;
  return doc;
}

test('[card 40b recap] the walk: only slides revealed to this room, every one once and in order, resets included; nothing private', () => {
  const ended = states.filter((s) => s.phase === 'ended');
  let resets = 0;
  for (const state of ended) {
    const view = project({ ...state, caseDoc: canaryDoc(state) }, 'participant', pid), j = recapJourney(view);
    const indexes = j.stops.map((s) => s.index).filter((i) => i !== null);
    assert.deepEqual(indexes, view.timeline.map((_, i) => i), `every revealed entry is one stop, in room order (revision ${state.revision})`);
    if (new Set(view.timeline.map((e) => e.surfaceId)).size < view.timeline.length) resets++;
    assert.doesNotMatch(JSON.stringify(j), /CANARY/);
    assert.doesNotMatch(pdfOf(j).lines.join('\n'), /CANARY/);
  }
  assert.ok(resets > 0, 'some walked room revisited a slide after a checkpoint reset');
});

test('[card 40b recap] the PDF writer loads only on Download: never from the phone renderer or the journey model', () => {
  const read = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');
  for (const f of ['phone-render.mjs', 'recap-journey.mjs']) assert.doesNotMatch(read(f), /session-pdf|recap-pdf/, `${f} reaches the PDF writer`);
  const phone = read('phone.mjs');
  assert.match(phone, /download: async view => \{[^\n]*import\('\.\/recap-pdf\.mjs'\)/, 'the live phone imports the recap PDF chunk only inside its download action');
  // Room PDFs v2: the Finish block replaces the Give feedback link; it saves through feedback-client.mjs with the room's public
  // code alone (no link, token or name in a URL), and its chunks, the record and its writer load lazily.
  assert.match(phone, /recap: \{ finish: finishFor,/, 'the ended screen gets the Finish block');
  assert.match(phone, /import\('\.\/finish-block\.mjs'\), import\('\.\/feedback-client\.mjs'\), import\('\.\/record-summary\.mjs'\)/, 'its chunks load lazily');
  assert.match(phone, /download: async \(summary, entry\) => \{[\s\S]{0,600}?\(await import\('\.\/participant-record\.mjs'\)\)\.downloadParticipantRecord/, 'the record PDF loads only on Download');
  assert.doesNotMatch(phone, /feedbackUrl/, 'no feedback link is built on the phone');
  assert.match(read('recap-pdf.mjs'), /await import\('\.\/session-pdf\.mjs'\)/);
});

// ── Julian's ruling 1 (2026-10-17): revealed images are embedded in the recap PDF, each with its credit printed under it, so
// CC BY / BY-SA licences are honoured. Only images in this phone's timeline (revealed), never an unrevealed one. ──
const JPEG = (pad = 0) => { const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x18, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const out = new Uint8Array(head.length + pad + 2); out.set(head); out.set([0xff, 0xd9], out.length - 2); return out; };
const media = (handle, type = 'image/jpeg') => ({ handle, width: 1200, height: 800, credit: null, type, durationMs: null });
function imageView() {
  const view = fixture();
  view.timeline[9].slide.blocks[1].media = media('h-fasc');
  view.timeline[9].slide.blocks[1].caption = 'Day 3, theatre';
  view.timeline[4].slide.blocks.push({ id: 'i4', type: 'image', alt: 'CK trend chart', caption: '', media: media('h-ck') });
  view.timeline[0].slide.blocks.push({ id: 'i0', type: 'image', alt: 'Withdrawn photo', caption: '', media: { state: 'withdrawn' } });
  view.timeline[6].slide.blocks.push({ id: 'i6', type: 'image', alt: 'Echo loop', caption: '', media: media('h-echo', 'video/mp4') });
  // The reset revisits the ranking slide: the same image again is one fetch.
  view.timeline[8].slide.blocks.push({ id: 'i6', type: 'image', alt: 'Echo loop', caption: '', media: media('h-echo', 'video/mp4') });
  view.recap.imageCredits = { i9: 'Photo: A. Surgeon, CC BY-SA 4.0', i4: 'Chart: own work', i6: 'Echo: own recording' };
  return view;
}
const imageObjects = (pdf) => [...pdf.objects.values()].filter((s) => s.includes('/Subtype /Image'));

test('[card 40b recap images] a revealed image prints in its own stop as the approved JPEG, its credit under it; one not to hand stays its text line with its credit', async () => {
  const { recapFigures } = await import('../src/client/recap-pdf.mjs');
  const { jpegShape } = await import('../src/client/session-pdf.mjs');
  const view = imageView();
  const figs = await recapFigures(view, async (block) => (block.id === 'i9' || block.id === 'i6' ? JPEG() : null), jpegShape);
  const pdf = readPdf(sessionPdf(recapRows(recapJourney(view), { figs, credits: view.recap.imageCredits }), { title: 'Diving deeper' })), lines = pdf.lines.map(norm);
  assert.equal(imageObjects(pdf).length, 2, 'two images to hand, each embedded once although one appears twice');
  assert.equal(pdf.tree.filter((t) => t.type === 'Figure').length, 3, 'the echo shows on both visits of its slide');
  assert.ok(pdf.tree.some((t) => t.type === 'Figure' && t.alt === 'Calf at operation'));
  const at = (t) => lines.indexOf(t);
  assert.ok(at('Compartment pressures were high.') < at('Calf at operation'), 'the image sits in its own stop, after the slide text');
  assert.equal(at('Day 3, theatre'), at('Calf at operation') + 1, 'the caption follows the image');
  assert.equal(at('Photo: A. Surgeon, CC BY-SA 4.0'), at('Calf at operation') + 2, 'the credit is printed under it');
  assert.ok(at('Echo: own recording') > at('Echo loop'));
  // Not to hand (not fetched, or withdrawn): its text line stays, and a credit still prints under it.
  assert.ok(lines.some((l) => l.startsWith('Image') && l.includes('CK trend chart')));
  assert.equal(at('Chart: own work'), lines.findIndex((l) => l.includes('CK trend chart')) + 1);
  assert.ok(lines.some((l) => l.includes('Withdrawn photo')));
});

test('[card 40b recap images] only released image blocks of the timeline are asked for, each once; withdrawn, non-JPEG and over-budget ones stay text', async () => {
  const { recapFigures, RECAP_IMAGE_BYTES } = await import('../src/client/recap-pdf.mjs');
  const { jpegShape } = await import('../src/client/session-pdf.mjs');
  const view = imageView(), asked = [];
  const figs = await recapFigures(view, async (block) => { asked.push(block.id); return block.id === 'i4' ? Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]) : JPEG(); }, jpegShape);
  assert.deepEqual(asked, ['i4', 'i6', 'i9'], 'timeline order, each block once, never a withdrawn one');
  assert.deepEqual([...figs.keys()], ['i6', 'i9'], 'a non-JPEG file is never embedded');
  assert.deepEqual(figs.get('i9'), { bytes: JPEG(), alt: 'Calf at operation', caption: 'Day 3, theatre' });
  // A file that fails to load is text, never a failed PDF.
  assert.deepEqual([...(await recapFigures(view, async () => { throw new Error('offline'); }, jpegShape)).keys()], []);
  // The PDF stays a sensible size: images past the budget, in timeline order, stay their text line.
  const big = Math.floor(RECAP_IMAGE_BYTES * 0.6);
  assert.deepEqual([...(await recapFigures(view, async () => JPEG(big), jpegShape)).keys()], ['i4'], 'the second large image is over the budget');
  assert.ok(RECAP_IMAGE_BYTES <= 6 * 1048576);
});

test('[card 40b recap images] Download reads each revealed image through the phone, and the PDF holds no credit of an image the timeline lacks', async () => {
  const { recapFigures } = await import('../src/client/recap-pdf.mjs');
  const { jpegShape } = await import('../src/client/session-pdf.mjs');
  const view = imageView();
  view.recap.imageCredits.unrevealed = 'CANARY-UNREVEALED-CREDIT';
  const figs = await recapFigures(view, async () => JPEG(), jpegShape);
  const pdf = readPdf(sessionPdf(recapRows(recapJourney(view), { figs, credits: view.recap.imageCredits }), { title: 'Diving deeper' }));
  assert.ok(!pdf.lines.join('\n').includes('CANARY') && !pdf.text.includes('CANARY'));
  const phone = readFileSync(new URL('../src/client/phone.mjs', import.meta.url), 'utf8');
  // Room PDFs v2: the recap PDF chunk loads on Download with the shared art chunk (the cover band); the phone hands it its image reader.
  assert.match(phone, /download: async view => \{ const \[m, art\] = await Promise\.all\(\[import\('\.\/recap-pdf\.mjs'\), import\('\.\/splash\.mjs'\)/, 'the recap PDF chunk loads only on Download');
  assert.match(phone, /return m\.downloadRecap\(view, recapStill, band\);/, 'the live phone hands the recap its image reader');
});
