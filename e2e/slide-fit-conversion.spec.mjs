// Fit-aware conversion: every slide of the committed real cases, converted to slides, measured in the shipped projector
// frame at the 1280×720 target with all steps released and each decision in its slot.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { parseBuilderTransfer, inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

async function cases() {
  const mvc = convertSchema1ToBuilderDocument(JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8')), { metadata_version: 1 }).candidate;
  const out = [{ name: 'mvc', document: mvc, metadata: { metadata_version: 1 } }];
  for (const name of ['builder-diving-polished-transfer', 'builder-diving-transfer']) {
    const parsed = parseBuilderTransfer(readFileSync(new URL(`../tests/fixtures/synthetic/${name}.json`, import.meta.url), 'utf8'));
    const inspected = await inspectBuilderTransfer(parsed.envelope, {});
    out.push({ name, document: inspected.candidate.document, metadata: inspected.candidate.authoring_metadata ?? inspected.candidate.authoringMetadata });
  }
  return out;
}

test('[AS-152] [AS-158] converted real cases fit the 1280×720 projector; text shrinks to fit, never below its 10 px floor', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const all = [];
  for (const item of await cases()) {
    for (const surface of item.document.surfaces ?? []) delete surface.variants;
    const converted = convertToSlideDocument(item.document, item.metadata, { createId: uuidv7 });
    expect(converted.ok, `${item.name}: ${converted.message}`).toBe(true);
    await page.unroute('**/fit-document.json').catch(() => {});
    await page.route('**/fit-document.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(converted.candidate.document) }));
    await page.goto('/prototypes/slide-fit.html?choose=1');
    const report = await page.evaluate(() => window.fit);
    for (const row of report) all.push({ case: item.name, ...row });
  }
  writeFileSync(testInfo.outputPath('fit-report.json'), JSON.stringify(all, null, 1));
  console.log('FIT', JSON.stringify(all.map(row => [row.case, row.owner, row.template, row.overflow.join('+') || 'fits', row.questionPx, row.bodyPx])));
  // Regression guard on the real diving case: 29 of 32 slides fit at the ruled sizes; the 3 that do not carry more text
  // than one 720p slide holds and are listed for the author (D6 referred diagnosis, D7 staged evidence, D8 leg CT).
  const polished = all.filter(row => row.case === 'builder-diving-polished-transfer');
  expect(polished.filter(row => row.overflow.length).length).toBeLessThanOrEqual(3);
  // CASE-225: a block's text may shrink to the 10 px floor at 720p, never below; real slides do use it.
  expect(all.every(row => row.bodyPx >= 9.9)).toBe(true);
  expect(all.some(row => row.bodyPx < 24)).toBe(true);
  console.log('SUMMARY', JSON.stringify(Object.entries(all.reduce((acc, row) => { const key = row.case; acc[key] ??= { slides: 0, overflowing: 0 }; acc[key].slides++; if (row.overflow.length) acc[key].overflowing++; return acc; }, {}))));
});

import { syntheticTeachingPair, teachingSlides, teachingPromptTitle } from '../scripts/synthetic-teaching-fixture.mjs';
test('Diving teaching slides and twelve-chip Builder preview fit the projector frame',async({page})=>{
 const snapshot=JSON.parse(readFileSync(new URL('../tests/fixtures/synthetic/diving-revision-243.json',import.meta.url)));
 const revised=syntheticTeachingPair(),d=revised.document;
 await page.route('**/fit-document.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(d)}));
 await page.goto('/prototypes/slide-fit.html');
 await page.evaluate(()=>document.fonts.ready);
 const targets=teachingSlides.map(s=>({title:s.title,phase:'open'}));
 targets.push({title:teachingPromptTitle,phase:'results'},{title:teachingPromptTitle,phase:'open'});
 for(const [width,height]of [[1280,720],[1920,1080]])for(const theme of ['light','dark'])for(const target of targets){
  await page.setViewportSize({width,height});
  const result=await page.evaluate(async({d,target,theme})=>{
   const{drawStage,inspectionSlide}=await import('/src/client/builder-fit.mjs');
   document.documentElement.dataset.theme=theme;
   let beat=d.beats.find(b=>b.title===target.title),path;
   if(!beat){const surface=d.surfaces.find(s=>s.title===target.title);path=d.decisions.flatMap(x=>x.paths).find(p=>p.reveal_surface_id===surface.id);const decision=d.decisions.find(x=>x.paths.includes(path));beat=d.beats.find(b=>b.decision_id===decision.id);}
   const slide=inspectionSlide(d,{beatId:beat.id,pathId:path?.id});
   return drawStage(document,{document:d,beat,path,slide,phase:target.phase});
  },{d,target,theme});
  expect(result.marked,`${target.title} ${width} ${theme}`).toBe(0);
  if(target.title===teachingPromptTitle&&target.phase==='open'){
   await expect(page.locator('.decision .call')).toHaveText('Prompt');
   await expect(page.locator('.decision .call svg')).toBeVisible();
   expect(await page.locator('.decision .call').evaluate(n=>parseFloat(getComputedStyle(n).fontSize))).toBeLessThanOrEqual(24);
  }
  if(target.phase==='results'){
   await expect(page.locator('.text-answer')).toHaveCount(12);
   const boxes=await page.locator('.text-answer').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,bottom:r.bottom,font:parseFloat(getComputedStyle(n).fontSize),clip:n.scrollHeight>n.clientHeight||n.scrollWidth>n.clientWidth};}));
   // CASE-318: answers flow down three columns in reading order (rows need not align once heights differ), and the fit
   // check measures them as the projector does: nothing overflows the band.
   expect(new Set(boxes.map(b=>Math.round(b.x))).size).toBe(3);
   expect(boxes.every((b,i)=>i===0||b.x>boxes[i-1].x+1||(Math.abs(b.x-boxes[i-1].x)<=1&&b.y>boxes[i-1].y))).toBe(true);
   expect(await page.locator('main').first().evaluate(n=>n.dataset.overflow)).not.toBe('true');
   expect(boxes.every(b=>b.font>=24&&!b.clip)).toBe(true);
   expect(Math.max(...boxes.map(b=>b.bottom))).toBeLessThanOrEqual(await page.locator('footer').evaluate(n=>n.getBoundingClientRect().top));
  }
  // Wait for the resized/redrawn projector to reach the compositor before capture.
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  await page.screenshot({path:`/tmp/diving-teaching-${targets.indexOf(target)}-${width}-${theme}.png`});
 }
});
