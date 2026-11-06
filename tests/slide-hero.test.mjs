import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideHero } from '../src/shared/slide-hero.mjs';
import { slidePlan, HERO_CAP } from '../src/client/slide-render.mjs';
import { publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { setHero } from '../src/shared/slide-edit.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';

const id = name => `00000000-0000-7000-8000-${name.padStart(12, '0')}`;
const title = { id: id('1'), type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: 'Day 6 · The referral' }] }] };
const card = { id: id('2'), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'Referral question', bold: true }] }, { style: 'p', runs: [{ text: 'Possible decompression sickness' }] }] };
const second = { id: id('3'), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'Why operate before the CT?' }] }] };
const question = { id: id('4'), type: 'question', decision_id: id('40') };
const slide = (blocks, steps, extra = {}) => ({ id: id('9'), owner: { kind: 'beat', id: id('8') }, template: 'title_text',
  placements: blocks.map((block, index) => index === 0 && block === title ? { block_id: block.id, col: 1, row: 1, w: 12, h: 2 } : { block_id: block.id, col: 1, row: 3 + 4 * (index - 1), w: 6, h: 3 }),
  reading_order: blocks.map(block => block.id), steps: steps.map((ids, index) => ({ id: id(`9${index}`), block_ids: ids })), styles: [], ...extra });
const of = blocks => key => blocks.find(block => block.id === key);
const cls = node => node.cls.split(' ');

test('[AS-165] a title and one block, or one block alone, is a hero; two body blocks never are', () => {
  assert.deepEqual(slideHero(slide([title, card], [[title.id, card.id]]), of([title, card])), { block_id: card.id, title_id: title.id, row: 3, align: 'top' });
  assert.deepEqual(slideHero({ ...slide([card], [[card.id]]), placements: [{ block_id: card.id, col: 3, row: 4, w: 4, h: 2 }] }, of([card])), { block_id: card.id, title_id: null, row: 1, align: 'top' });
  assert.equal(slideHero(slide([title, question], [[title.id, question.id]]), of([title, question])).block_id, question.id, 'the question counts as a block');
  assert.equal(slideHero(slide([card, second], [[card.id, second.id]]), of([card, second])), null, 'two body blocks');
  assert.equal(slideHero(slide([title, card, second], [[title.id, card.id], [second.id]]), of([title, card, second])), null, 'decided on every step, not the first');
  assert.equal(slideHero(slide([title, card], [[title.id, card.id]], { hero: 'off' }), of([title, card])), null, 'the author turned it off');
  assert.equal(slideHero(slide([title, card], [[title.id, card.id]], { hero: 'centred' }), of([title, card])).align, 'centred');
  // A title revealed after its block would make the hero foretell a later step, so such a slide is drawn as placed.
  assert.equal(slideHero(slide([title, card], [[card.id], [title.id]]), of([title, card])), null);
  // A first block with body text is not a title.
  assert.equal(slideHero(slide([card, title], [[card.id, title.id]]), of([card, title])), null);
});

test('[AS-165] the plan gives the hero block every row under its title, centred across, whatever its stored placement', () => {
  const composition = slide([title, card], [[title.id], [card.id]]);
  const { root, hero } = slidePlan({ blocks: [title, card], composition }, { hero: slideHero(composition, of([title, card])) });
  assert.equal(root.children[1].area, '3 / 1 / span 10 / span 12');
  assert.ok(cls(root.children[1]).includes('slide-hero') && cls(root.children[1]).includes('slide-hero-top'));
  assert.ok(cls(root.children[0]).includes('slide-hero-title'));
  assert.equal(root.children[0].area, '1 / 1 / span 2 / span 12', 'the title keeps its placement');
  assert.equal(hero.block_id, card.id);
  assert.equal(root.children[1].cap, 1.5, 'body text starts at the cap');
  // Its text never starts above the title: an H3 card under an H1 title starts at 4.8 / 3.3, rounded down to 1.45.
  const big = { ...card, paragraphs: [{ style: 'h3', runs: [{ text: 'Referral' }] }, card.paragraphs[1]] };
  assert.equal(slidePlan({ blocks: [title, big], composition }, { hero: slideHero(composition, of([title, big])) }).root.children[1].cap, 1.45);
  // Before the block's step, only the title shows, at its own place; nothing waits for a later re-flow.
  const entry = slidePlan({ blocks: [title], composition }, { hero: slideHero(composition, of([title])) });
  assert.equal(entry.root.children.length, 1); assert.equal(entry.root.children[0].area, '1 / 1 / span 2 / span 12'); assert.equal(entry.hero, null);
  // Questions, tables and charts keep the full width; phones and narrow reflow are never heroes.
  const withQuestion = slide([title, question], [[title.id, question.id]]);
  const full = slidePlan({ blocks: [title, question], composition: withQuestion }, { hero: slideHero(withQuestion, of([title, question])) });
  assert.ok(cls(full.root.children[1]).includes('slide-hero-full'));
  const reflow = slidePlan({ blocks: [title, card], composition }, { layout: 'reflow', hero: slideHero(composition, of([title, card])) });
  assert.ok(!reflow.root.children.some(child => cls(child).includes('slide-hero')));
  assert.equal(HERO_CAP, 1.5);
});

test('[AS-165] the public slide names its hero only once the block is released, and the projector draws from it', () => {
  const composition = slide([title, card], [[title.id], [card.id]], { hero: 'centred' });
  const surface = shown => publicPresentationSurface({ surfaceId: id('7'), kind: 'surface', title: 'Day 6', slide: { composition, blocks: [title, card] }, timelineKind: 'live', manual: false, at: '' }, shown);
  assert.equal(Object.hasOwn(surface(1).slide, 'hero'), false, 'nothing foretells the second step');
  const released = surface(2).slide;
  assert.deepEqual(released.hero, { block_id: card.id, title_id: title.id, row: 3, align: 'centred' });
  assert.equal(Object.hasOwn(released, 'steps'), false);
  const { root } = slidePlan({ blocks: released.blocks, composition: released }, { hero: released.hero });
  assert.equal(root.children[1].area, '3 / 1 / span 10 / span 12');
  assert.ok(cls(root.children[1]).includes('slide-hero-centred'));
  // A two-block slide carries no hero at any step.
  const two = slide([title, card, second], [[title.id, card.id], [second.id]]);
  const first = publicPresentationSurface({ surfaceId: id('7'), kind: 'surface', title: 'x', slide: { composition: two, blocks: [title, card, second] }, timelineKind: 'live', manual: false, at: '' }, 1);
  assert.equal(Object.hasOwn(first.slide, 'hero'), false);
});

test('[AS-165] the per-slide setting is stored only when not the default, and the contract refuses any other value', () => {
  const composition = slide([title, card], [[title.id, card.id]]);
  const document = { schema_version: 3, blocks: [title, card], compositions: [composition] };
  const off = setHero(document, composition.id, 'off');
  assert.equal(off.document.compositions[0].hero, 'off');
  assert.equal(Object.hasOwn(setHero(off.document, composition.id, null).document.compositions[0], 'hero'), false);
  assert.equal(setHero(document, composition.id, 'middle').ok, false);
  const errors = doc => validateSlideParts(doc).errors.filter(error => error.at.endsWith('/hero'));
  assert.deepEqual(errors(setHero(document, composition.id, 'centred').document), []);
  assert.equal(errors({ ...document, compositions: [{ ...composition, hero: 'large' }] }).length, 1);
});
