import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';
import { SLIDE_THEMES, slideTheme, applySlideTheme } from '../src/shared/slide-themes.mjs';
import { setTheme } from '../src/shared/slide-edit.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { PreviewRoom } from '../src/client/preview-room.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

function slideCase() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of converted.surfaces) delete surface.variants;
  return convertToSlideDocument(converted, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const slideOptions = { validateSlides: validateSlideParts };

test('[AS-161] a case takes one named theme; any other value is refused by the Builder and the runtime', () => {
  const document = slideCase();
  assert.deepEqual(Object.keys(SLIDE_THEMES), ['case', 'clinic', 'night', 'print']);
  for (const name of Object.keys(SLIDE_THEMES)) {
    const themed = setTheme(document, name);
    assert.equal(themed.ok, true);
    assert.equal(validateRuntimeDocument(themed.document, slideOptions).ok, true, name);
    assert.equal(validateBuilderDocument(themed.document, { metadata_version: 1 }, slideOptions).ok, true, name);
  }
  assert.equal(setTheme(document, 'case').document.theme, undefined, 'the default stores nothing');
  assert.equal(setTheme(document, 'neon').ok, false);
  const forged = { ...document, theme: '#ff00ff' };
  assert.equal(validateRuntimeDocument(forged, slideOptions).ok, false, 'a colour is never a theme');
  assert.equal(validateBuilderDocument(forged, { metadata_version: 1 }, slideOptions).ok, false);
});

test('[AS-161] a drawn slide is scoped to its theme by class; Case, absent and unknown names leave it unchanged', () => {
  const node = () => ({ classes: [], classList: { add(name) { node.last.classes.push(name); } } });
  const draw = theme => { node.last = node(); node.last.classList = { add: name => node.last.classes.push(name) }; applySlideTheme(node.last, theme); return node.last.classes; };
  assert.deepEqual(draw('night'), ['slide-theme-night']);
  for (const theme of ['case', undefined, null, 'nope', 'constructor']) assert.deepEqual(draw(theme), [], String(theme));
  assert.equal(applySlideTheme(null, 'night'), null, 'nothing drawn, nothing to scope');
});

test('[AS-161] the room sends the theme with each public slide; the projector accepts named themes only', () => {
  const document = setTheme(slideCase(), 'clinic').document;
  assert.equal(slideTheme(document), 'clinic');
  const room = new PreviewRoom(document);
  assert.ok(room.command('start'), room.reason);
  const display = room.view('display');
  assert.equal(display.surface.slide.theme, 'clinic');
  assert.ok(acceptDisplayView(display), 'the display view is accepted with a theme');
  const learner = room.learners[0];
  assert.equal(room.view('participant', learner.id).liveSurface.slide.theme, 'clinic');
  assert.equal(acceptDisplayView({ ...display, surface: { ...display.surface, slide: { ...display.surface.slide, theme: 'neon' } } }), null);
  // A case without a theme sends none, so a projector of the previous release still accepts its views.
  const plain = new PreviewRoom(slideCase());
  plain.command('start');
  assert.equal(Object.hasOwn(plain.view('display').surface.slide, 'theme'), false);
});
