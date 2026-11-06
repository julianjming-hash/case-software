// CASE-344 callout icons (B1, the unit half of AS-218): the closed icon set and its named capability, the edit-only quote
// conversion, and one drawing on the projector, the phone and the PDFs. The e2e half (identical on screen) is B2's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts, CALLOUT_ICONS, CALLOUT_ICON_CAPABILITY } from '../src/shared/slide-document.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { ICONS, ICON_TAGS, LUCIDE_VERSION, iconNodes } from '../src/shared/icons.mjs';
import { publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { slidePlan, buildSlide, slideIcons } from '../src/client/slide-render.mjs';
import { briefingRows } from '../src/client/briefing.mjs';
import { recapRows } from '../src/client/recap-pdf.mjs';
import { entryLines, recapJourney } from '../src/client/recap-journey.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { readPdf } from './helpers/pdf-read.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

function slideDoc() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const check = (document, mode = 'preserve') => validateBuilderDocument(document, { metadata_version: 1 }, { mode, validateSlides: validateSlideParts });
const valid = document => { const result = check(document); assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 3))); return document; };
const applied = result => { assert.equal(result.ok, true, result.reason); return valid(result.document); };
const start = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const words = 'Salbutamol used all night';
/** A case whose start slide holds one callout (or quote) with these words, and its id. */
function withBlock(type) {
  let document = slideDoc();
  const id = start(document).id, added = edit.addBlock(document, id, type, uuidv7);
  document = applied(edit.setParagraphs(applied(added), added.blockId, [{ runs: [{ text: words }] }]));
  return { document, id, blockId: added.blockId };
}
const blockOf = (document, id) => document.blocks.find(block => block.id === id);
const find = (node, predicate) => predicate(node) ? [node] : (node.children ?? []).flatMap(child => find(child, predicate));
const texts = node => Object.hasOwn(node, 'text') ? [node.text] : (node.children ?? []).flatMap(texts);
/** One block alone on a slide, placed, as the room releases it. */
const alone = block => ({ blocks: [block], composition: { id: uuidv7(), owner: { kind: 'beat', id: uuidv7() }, template: 'blank',
  placements: [{ block_id: block.id, col: 1, row: 1, w: 12, h: 4 }], reading_order: [block.id], steps: [{ id: uuidv7(), block_ids: [block.id] }], styles: [] } });

test('[AS-218] the icon set is closed, every key draws exact Lucide nodes, and the release is pinned and credited', () => {
  assert.equal(CALLOUT_ICONS[0], 'none');
  for (const key of CALLOUT_ICONS.slice(1)) assert.ok(iconNodes(key), `${key} has an icon`);
  assert.equal(iconNodes('none'), null);
  assert.equal(iconNodes('a-newer-icon'), null, 'an unknown key draws nothing');
  assert.ok(Object.keys(ICONS).length >= 24);
  for (const [key, [name, nodes]] of Object.entries(ICONS)) {
    assert.match(name, /^[a-z0-9-]+$/, key);
    for (const [tag, attrs] of nodes) {
      assert.ok(ICON_TAGS.includes(tag), `${key}: ${tag}`);
      for (const value of Object.values(attrs)) assert.match(value, tag === 'path' ? /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/ : /^[0-9.]+$/, `${key}: plain geometry only`);
    }
  }
  assert.equal(LUCIDE_VERSION, '1.59.0');
  const notice = readFileSync(new URL('../NOTICE.md', import.meta.url), 'utf8');
  assert.match(notice, /lucide-static` 1\.59\.0/);
  assert.match(notice, /ISC/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!JSON.stringify(pkg).includes('lucide'), 'no Lucide dependency');
});

test('[AS-218] a callout icon is validated and needs callout_icon, which a build refuses by name when it does not know it', () => {
  const { document, blockId } = withBlock('callout');
  const iconic = applied(edit.setCalloutIcon(document, blockId, 'alert'));
  assert.equal(blockOf(iconic, blockId).icon, 'alert');
  assert.ok(iconic.required_capabilities.includes(CALLOUT_ICON_CAPABILITY), 'the op declares the capability');
  assert.equal(check(iconic, 'ready').errors.filter(issue => issue.code === 'missing_capability').length, 0);
  // Without the declaration a ready check fails and names it; an unknown icon key is an enum error at the field.
  const undeclared = { ...iconic, required_capabilities: iconic.required_capabilities.filter(item => item !== CALLOUT_ICON_CAPABILITY) };
  assert.ok(check(undeclared, 'ready').errors.some(issue => issue.code === 'missing_capability' && issue.message.includes(CALLOUT_ICON_CAPABILITY)));
  const bad = structuredClone(iconic); blockOf(bad, blockId).icon = 'lungs';
  const index = bad.blocks.findIndex(block => block.id === blockId);
  assert.ok(check(bad).errors.some(issue => issue.code === 'enum' && issue.at === `/blocks/${index}/icon`));
  assert.equal(edit.setCalloutIcon(document, blockId, 'lungs').ok, false);
  // A quote never carries an icon; only a callout does.
  const quote = withBlock('quote'), stray = structuredClone(quote.document); blockOf(stray, quote.blockId).icon = 'quote';
  assert.ok(check(stray).errors.some(issue => issue.code === 'unknown_key'));
  // A schema-2 document cannot declare it, and a capability this build does not know is refused by its name.
  const schema2 = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  const refusals = doc => validateBuilderDocument(doc, { metadata_version: 1 }).errors.filter(issue => issue.code === 'unknown_capability').map(issue => issue.message);
  assert.deepEqual(refusals({ ...schema2, required_capabilities: [...schema2.required_capabilities, CALLOUT_ICON_CAPABILITY] }), [`unknown required capability ${CALLOUT_ICON_CAPABILITY}`]);
  assert.deepEqual(check({ ...iconic, required_capabilities: [...iconic.required_capabilities, 'shared_timers'] }).errors.filter(issue => issue.code === 'unknown_capability').map(issue => issue.message),
    ['unknown required capability shared_timers']);
});

test('[AS-218] a quote stays a quote on load and converts to a Plain callout with the quote icon only when its block is edited', () => {
  const { document, id, blockId } = withBlock('quote');
  const toned = applied(edit.setBlockStyle(document, id, blockId, 'tone', 'blue'));
  // Loading, validating and projecting a case never converts its quotes; published versions keep them.
  valid(toned);
  assert.equal(blockOf(toned, blockId).type, 'quote');
  assert.equal(edit.convertQuote(toned, start(toned).reading_order[0]).document, toned, 'any other block is left alone');
  const converted = edit.convertQuote(toned, blockId);
  assert.equal(converted.converted, true);
  const next = valid(converted.document), block = blockOf(next, blockId);
  assert.deepEqual(block, { id: blockId, type: 'callout', paragraphs: [{ runs: [{ text: words }] }], icon: 'quote' }, 'same identity and words');
  assert.ok(next.required_capabilities.includes(CALLOUT_ICON_CAPABILITY));
  assert.ok(!(start(next).styles ?? []).some(style => style.block_id === blockId && 'tone' in style), 'Plain: no fill on any slide');
  assert.equal(check(next, 'ready').errors.filter(issue => issue.code === 'missing_capability').length, 0);
  assert.equal(blockOf(toned, blockId).type, 'quote', 'the input document is unchanged');
  // Choosing an icon on a quote is an edit too: it converts, then takes the chosen icon.
  assert.equal(blockOf(applied(edit.setCalloutIcon(toned, blockId, 'info')), blockId).icon, 'info');
});

test('[AS-218] the projector and the phone draw the icon and centre the callout; a callout without the field and a quote draw as before', async () => {
  const { document, blockId } = withBlock('callout');
  const iconic = applied(edit.setCalloutIcon(document, blockId, 'alert'));
  const slide = alone(blockOf(iconic, blockId));
  for (const layout of ['grid', 'reflow']) {
    const [block] = slidePlan(slide, { layout }).root.children;
    assert.match(block.cls, /\bslide-callout\b/);
    assert.match(block.cls, /\bslide-centred\b/, `${layout}: centred`);
    const [aside] = block.children, [svg, body] = aside.children;
    assert.equal(aside.tag, 'aside');
    assert.equal(svg.tag, 'svg');
    assert.deepEqual(svg.svg, { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, 'decorative: the text carries the meaning');
    assert.equal(svg.icon, 'alert', `${layout}: the plan names the icon; its geometry loads with the first slide that draws one`);
    assert.deepEqual(texts(body), [words]);
    assert.deepEqual(texts(block), [words], 'no icon name reaches the text');
  }
  // The DOM builder draws those nodes as SVG elements with text-only content (no markup string anywhere).
  const element = (ns, tag) => ({ ns, tag, style: {}, dataset: {}, children: [], attrs: {}, append(child) { this.children.push(child); }, setAttribute(name, value) { this.attrs[name] = value; } });
  const fake = { createTextNode: value => ({ text: value }), createElement: tag => element(null, tag), createElementNS: (ns, tag) => element(ns, tag) };
  const svg = find(buildSlide(fake, slidePlan(slide)).root, item => item.tag === 'svg')[0];
  await slideIcons();
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.deepEqual(svg.children.map(child => [child.tag, child.attrs]), ICONS.alert[1], 'Lucide\'s own nodes, drawn once');
  // Once loaded, the next slide draws its icon at once; a plan naming an icon outside the set is refused.
  const again = find(buildSlide(fake, slidePlan(slide)).root, item => item.tag === 'svg')[0];
  assert.equal(again.children.length, ICONS.alert[1].length);
  assert.throws(() => buildSlide(fake, { root: { tag: 'svg', svg: {}, icon: 'lungs', children: [] } }), /slide_icon/);
  // 'none' keeps the centring without an icon; an unknown key from a newer build draws no icon rather than failing.
  for (const icon of ['none', 'a-newer-icon']) {
    const plan = slidePlan(alone({ ...blockOf(iconic, blockId), icon })).root.children[0];
    assert.match(plan.cls, /slide-centred/);
    assert.equal(find(plan, item => item.tag === 'svg').length, 0);
  }
  const legacy = { ...blockOf(document, blockId) }; delete legacy.icon;
  const old = slidePlan(alone(legacy)).root.children[0];
  assert.doesNotMatch(old.cls, /slide-centred/);
  assert.equal(find(old, item => item.tag === 'svg').length, 0);
  assert.deepEqual(old.children[0].children.map(item => item.tag), ['p'], 'a callout without the field keeps its old markup');
  const quote = withBlock('quote');
  assert.equal(slidePlan(alone(blockOf(quote.document, quote.blockId))).root.children[0].children[0].tag, 'blockquote', 'old quotes render');
  // The room's public slide forwards the icon (and nothing else new) with the released callout.
  const shown = publicPresentationSurface({ id: uuidv7(), kind: 'slide', title: 'Slide', slide: { blocks: iconic.blocks, composition: start(iconic) } }, start(iconic).steps.length);
  assert.deepEqual(Object.keys(shown.slide.blocks.find(block => block.id === blockId)).sort(), ['icon', 'id', 'paragraphs', 'type']);
});

test('[AS-218] the briefing and recap PDFs draw the icon as a decorative Artifact beside the words, which read back unchanged', () => {
  const { document, blockId } = withBlock('callout');
  const iconic = applied(edit.setCalloutIcon(document, blockId, 'alert'));
  const rows = briefingRows(iconic), box = JSON.stringify(rows).includes('"icon":"alert"');
  assert.ok(box, 'the briefing callout carries its icon');
  const recap = entryLines({ title: 'Start', slide: { blocks: [blockOf(iconic, blockId)] } });
  assert.deepEqual(recap.map(line => [line.t, line.i]), [[words, 'alert']]);
  const plain = readPdf(sessionPdf([['BOX', { fill: 'quiet', rows: [['P', words]] }]]));
  const drawn = readPdf(sessionPdf([['BOX', { fill: 'quiet', icon: 'alert', rows: [['P', words]] }]]));
  assert.deepEqual(drawn.lines, plain.lines, 'the icon adds no text and no structure');
  assert.deepEqual(drawn.tree.map(item => item.type), plain.tree.map(item => item.type));
  // The strokes sit in an Artifact, inside the card and left of the text, which moves right to make room.
  const strokes = [...drawn.text.matchAll(/\/Artifact BMC\nq [\d.]+ [\d.]+ [\d.]+ RG [\d.]+ w 1 J 1 j ([^Q]*)Q/g)];
  assert.equal(strokes.length, 1);
  const points = [...strokes[0][1].matchAll(/(-?[\d.]+) (-?[\d.]+) [mlc]/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert.ok(points.length > 4);
  for (const [x] of points) assert.ok(x >= 60 && x <= 77, `icon x ${x} inside the card's left padding and icon box`);
  const textX = text => Number(/BT[\s\S]*?([\d.]+) [\d.]+ Td/.exec(text)?.[1] ?? /([\d.]+) [\d.]+ Tm/.exec(text)?.[1]);
  assert.ok(textX(drawn.text) > textX(plain.text), 'the words start right of the icon');
  // 'none' and an unknown icon draw nothing; anything but a key refuses.
  for (const icon of ['none', 'a-newer-icon']) assert.deepEqual(readPdf(sessionPdf([['BOX', { fill: 'quiet', icon, rows: [['P', words]] }]])).text, plain.text);
  assert.throws(() => sessionPdf([['BOX', { fill: 'quiet', icon: 3, rows: [['P', words]] }]]), /pdf_input/);
  const multiline = structuredClone(iconic), block = blockOf(multiline, blockId);
  block.paragraphs.push({ runs: [{ text: 'Reassess the response.' }] });
  const view = { caseTitle: 'Callout export', timeline: [{ title: 'Arrival', slide: { blocks: [block] } }], recap: { rounds: [], learningPoints: [] } };
  for (const output of [sessionPdf(briefingRows(multiline)), sessionPdf(recapRows(recapJourney(view)))]) {
    const parsed = readPdf(output);
    assert.ok(parsed.lines.some(line => line.includes(words)), 'complete export retains the first paragraph');
    assert.ok(parsed.lines.some(line => line.includes('Reassess the response.')), 'complete export retains the second paragraph');
    assert.equal([...parsed.text.matchAll(/\/Artifact BMC\nq [\d.]+ [\d.]+ [\d.]+ RG [\d.]+ w 1 J 1 j ([^Q]*)Q/g)].length, 1, 'one decorative icon accompanies the whole callout');
  }
});
