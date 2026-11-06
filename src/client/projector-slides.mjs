// Card 57 served rendering, projector (lazy): the released slide fills the main band at 16:9. Card 56's text-only
// renderer builds only the blocks the room has released; the question slot takes the live decision column or the
// results. CASE-211 B: each question shrinks to its slot, from the slide's body size down to the 24 px floor.
import { slidePlan, buildSlide, heroColumns, HERO_CAP } from './slide-render.mjs';

// CASE-225: text may shrink to a 10 px floor at 1280×720 (body there is 24.1 px), scaling with the projector.
const FLOOR = 24, MIN_FIT = .415;
const fits = node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1;

const px = node => parseFloat(getComputedStyle(node).fontSize) || 0;
// Its card then takes the narrowest centred span of the slide's 12 columns that holds its text with 4% to spare. Text
// widths do not scale exactly with type size (Linux rounds glyph advances), so a box sized from measured text is a
// different share of the slide in the Builder canvas than in the room; a column span is the same share everywhere.
// Every slide is 3% padding a side and 1.2% gaps, so n columns span (7.93n − 1.2)% of its width.
const snapColumns = block => heroColumns(block, Math.min(12, Math.max(2, 2 * Math.ceil((block.offsetWidth * 1.04 / block.parentElement.offsetWidth + .012) / .0793 / 2))));

// The slide last drawn into each main band, so an unchanged slide keeps its DOM: a playing video is never rebuilt
// (and restarted) because a vote count or the connection status changed (card 59 M3).
const drawn = new WeakMap();

/** Render a slide view into the projector's main band. `parts` are the projector's own decision/result builders. */
export function renderSlideMain(main, view, { el, decisionColumn, responseResult, media = null }) {
  const slide = view.surface.slide;
  const plan = slidePlan({ blocks: slide.blocks, composition: slide }, { media, hero: slide.hero ?? null }); // grid is the default layout
  const signature = JSON.stringify(plan), last = drawn.get(main);
  const part = view.responseResult ? () => responseResult(view) : view.decision ? () => decisionColumn(view) : null;
  const title = el('h1', 'sr-only', view.surface.title || view.caseTitle);
  if (view.responseResult?.textPage) {
    // As the projector's live free-text reveal (projector-render.mjs): in a column, so the result box keeps its own height
    // and fitTextAnswers (CASE-318) measures the band under the prompt, not a box stretched to fill main.
    const column = el('div', 'col'); column.append(title, part());
    main.className = 'single'; main.replaceChildren(column); drawn.delete(main); return;
  }
  main.className = 'slide-band';
  if (last?.signature === signature && last.root.parentNode === main) {
    // Same slide: only the title, the question slots and the side column change.
    main.firstElementChild?.replaceWith(title);
    for (const slot of last.slots) slot.replaceChildren(...(part ? [part()] : []));
    main.querySelector(':scope > .slide-side')?.remove();
  } else {
    const { root, slots } = buildSlide(main.ownerDocument, plan);
    if (part) for (const slot of slots) slot.append(part());
    main.replaceChildren(title, root);
    drawn.set(main, { signature, root, slots });
  }
  // An open decision whose question has not been placed on this slide is still shown, beside the slide.
  if (part && !drawn.get(main).slots.length) {
    main.classList.add('slide-with-side');
    const side = el('div', 'col slide-side'); side.append(part()); main.append(side);
  }
  syncVideos(main, view.playback ?? null);
}

/**
 * Card 59 M3 (Julian, 2026-10-15): the projector's videos follow the room's playback, which only the facilitator sets
 * (Play, Pause, Restart). The position is `at` seconds at server time `since`, advancing while playing; a drift over half
 * a second is corrected. Sound is kept; when the browser will not start sound without a click on this window, the video
 * plays muted and a chip offers to turn sound on.
 */
export function syncVideos(main, playback, now = Date.now()) {
  const doc = main.ownerDocument;
  for (const video of main.querySelectorAll('video[data-video-block]')) {
    // What the room asked of this video, readable by assistive tools and tests whatever the decoder manages.
    video.dataset.state = !playback || playback.blockId !== video.dataset.videoBlock ? 'idle' : playback.playing ? 'playing' : 'paused';
    if (!playback || playback.blockId !== video.dataset.videoBlock) { if (!video.paused) video.pause(); continue; }
    if (video.readyState < 1) { video.addEventListener('loadedmetadata', () => syncVideos(main, playback), { once: true }); continue; }
    const elapsed = playback.playing ? Math.max(0, (now - Date.parse(playback.since)) / 1000) : 0;
    const target = Math.min(playback.at + elapsed, Number.isFinite(video.duration) ? video.duration : Infinity);
    if (Math.abs(video.currentTime - target) > 0.5) video.currentTime = target;
    if (!playback.playing || target >= video.duration) { if (!video.paused) video.pause(); continue; }
    if (video.paused) video.play().catch(error => {
      if (error?.name !== 'NotAllowedError' || video.muted) return;
      video.muted = true; void video.play().catch(() => {});
      if (main.querySelector('.video-sound-off')) return;
      const chip = doc.createElement('button'); chip.type = 'button'; chip.className = 'video-sound-off'; chip.textContent = 'Sound is off. Click to turn it on.';
      chip.addEventListener('click', () => { for (const each of main.querySelectorAll('video[data-video-block]')) each.muted = false; chip.remove(); });
      main.append(chip);
    });
  }
}

function shrink(slot) {
  slot.style.fontSize = '';
  const base = px(slot);
  let size = slot.classList.contains('slide-hero') ? base * HERO_CAP : base;
  for (;;) { slot.style.fontSize = `${size}px`; slot.style.setProperty('--hero-scale', size / base); if (fits(slot) || size <= FLOOR) break; size = Math.max(FLOOR, size - .5); }
}

// Grid area "row / col / span h / span w" (slide-render.mjs) as half-open row and column ranges.
const span = area => { const m = /^(\d+) \/ (\d+) \/ span (\d+) \/ span (\d+)$/.exec(area); return m && { r0: +m[1], r1: +m[1] + +m[3], c0: +m[2], c1: +m[2] + +m[4] }; };
const overlaps = (a, b) => a.r0 < b.r1 && b.r0 < a.r1 && a.c0 < b.c1 && b.c0 < a.c1;

/**
 * Closed responses that cannot fit beside the slide's other blocks take their room (Julian, 2026-10-31): first the full
 * width of every row they share with another block, then the whole slide, title row too, since the prompt heads them.
 * The blocks they cover are hidden until the next stage, which is drawn afresh. Results that fit beside them stay put.
 */
function giveResultsRoom(main, slot) {
  const own = span(slot.style.gridArea);
  if (!own) return; // a hero or flow layout has no authored grid area to widen
  const others = [...main.querySelectorAll('.slide-canvas > .slide-block')].filter(block => block !== slot).map(block => ({ block, area: span(block.style.gridArea) })).filter(item => item.area);
  const beside = others.filter(item => item.area.r0 < own.r1 && own.r0 < item.area.r1);
  const rows = { r0: Math.min(own.r0, ...beside.map(item => item.area.r0)), r1: Math.max(own.r1, ...beside.map(item => item.area.r1)) };
  slot.dataset.authoredArea = slot.style.gridArea;
  for (const [room, area] of [['context', { ...rows, c0: 1, c1: 13 }], ['slide', { r0: 1, r1: 13, c0: 1, c1: 13 }]]) {
    slot.style.gridArea = `${area.r0} / ${area.c0} / ${area.r1} / ${area.c1}`;
    for (const item of others) item.block.classList.toggle('slide-yielded', overlaps(item.area, area));
    main.dataset.resultRoom = room;
    shrink(slot);
    if (fits(slot)) return;
  }
}

/**
 * Fit pass after layout: shrink each question to its slot (never below the floor). Body text keeps the CASE-211 size,
 * so a block that still overflows is marked and says the rest is on phones, which always show every released block
 * in full. The projector never scrolls and never silently clips; the overflow is reported on `main`.
 */
export function fitSlide(main) {
  let over = false;
  // A slide drawn again keeps its DOM, so undo the room a previous fit gave its results.
  for (const block of main.querySelectorAll('.slide-yielded')) block.classList.remove('slide-yielded');
  for (const block of main.querySelectorAll('[data-authored-area]')) { block.style.gridArea = block.dataset.authoredArea; delete block.dataset.authoredArea; }
  delete main.dataset.resultRoom;
  // The question slot, or the side column when the decision has no released slot, shrinks to the floor.
  // A hero question (D23) starts at HERO_CAP × body; its phase line keeps body size through --hero-scale.
  for (const slot of main.querySelectorAll('.slide-question, .slide-side')) {
    shrink(slot);
    if (!fits(slot) && slot.querySelector('.result')) giveResultsRoom(main, slot);
    if (!fits(slot)) over = true;
  }
  // CASE-224: text shrinks to fit its block in 5% steps, to the floor; only then is it marked.
  // A hero block (D23) starts above 1 and comes down the same steps; its box hugs its text inside the hero area.
  for (const block of main.querySelectorAll('.slide-block:not(.slide-question, .slide-yielded)')) {
    let fit = 1; block.style.removeProperty('--fit');
    const card = block.matches('.slide-hero:not(.slide-hero-full)');
    if (card) heroColumns(block, 12, '');
    if (block.dataset.heroCap) block.style.setProperty('--fit', fit = +block.dataset.heroCap); // D23: the plan's start
    while (!fits(block) && fit > MIN_FIT) block.style.setProperty('--fit', fit = Math.max(MIN_FIT, fit - .05));
    if (card) snapColumns(block);
    if (fits(block)) continue;
    over = true;
    if (!block.querySelector('.slide-more')) {
      const note = main.ownerDocument.createElement('p'); note.className = 'slide-more'; note.textContent = 'More on your phone';
      block.classList.add('slide-clipped'); block.append(note);
    }
  }
  // A side column narrows the slide; if body text falls under the ruled size, that is reported, never hidden.
  const body = main.querySelector('.slide-block');
  if (body && parseFloat(getComputedStyle(body).fontSize) / (parseFloat(body.style.getPropertyValue('--fit')) || 1) < FLOOR - .5) over = true;
  main.dataset.overflow = over;
  // A fit measured before the web font loads is too generous once it arrives (most of all a hero's): fit this slide
  // again when the fonts are ready, if it is still showing.
  const fonts = main.ownerDocument.fonts, canvas = main.querySelector('.slide-canvas');
  if (fonts?.status === 'loading') fonts.ready.then(() => { if (canvas?.isConnected) fitSlide(main); });
}
