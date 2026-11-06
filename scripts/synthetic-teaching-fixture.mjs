// Frozen synthetic layout stress input, not a clinical teaching-revision algorithm or historical receipt.
import {readFileSync}from'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../tests/fixtures/synthetic/teaching-layout.json',import.meta.url),'utf8'));
export const teachingSlides=Object.freeze(fixture.teachingSlides);
export const teachingPromptTitle=fixture.promptTitle;
export function syntheticTeachingPair(){return structuredClone(fixture.pair)}
