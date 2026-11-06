import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';
import { populatedPresentationGroups, publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { renderSurface } from '../src/client/teaching-controls.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';

function schema2SceneOnly() {
  const { doc } = miniCase();
  doc.schema_version = 2;
  doc.required_capabilities = ['human_interpretation'];
  for (const surface of doc.surfaces) {
    surface.scene = `Source-authored scene for ${surface.title}.`;
    surface.points = [];
  }
  for (const decision of doc.decisions) decision.interpretation = 'facilitator';
  return doc;
}

class TestNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this._text = ''; this.ownerDocument = globalThis.document; }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
}

function withFakeDocument(run) {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new TestNode(tag) };
  try { return run(); } finally { globalThis.document = previous; }
}

test('schema 2 accepts empty findings only when a non-empty scene directly supplies projected content', () => {
  const doc = schema2SceneOnly();
  assert.deepEqual(validateCaseDocument(doc, { profile: 'schema2' }).errors, []);
  assert.equal(validateRuntimeDocument(doc).ok, true);

  doc.surfaces[0].scene = '';
  assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.at === '/surfaces/0/points'));
  doc.surfaces[0].scene = 'Valid scene.';
  doc.surfaces[0].points = [''];
  assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.at === '/surfaces/0/points/0'));
  doc.surfaces[0].points = [];
  delete doc.surfaces[0].scene;
  assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.at === '/surfaces/0/points'));
});

test('schema 1 still requires explicit point content when points are absent or empty', () => {
  const { doc } = miniCase();
  delete doc.surfaces[0].points;
  assert.ok(validateCaseDocument(doc).errors.some(issue => issue.at === '/surfaces/0/points'));
  doc.surfaces[0].points = [];
  assert.ok(validateCaseDocument(doc).errors.some(issue => issue.at === '/surfaces/0/points'));
});

test('the public presentation and projector render the scene-only field as text without an empty findings tile', () => {
  const surface = { surfaceId: 'scene-only', at: 'visit-1', title: 'Source scene', kind: 'text',
    scene: 'Source wording <remains> text.', points: [], investigations: [], observations: [], assetIds: [] };
  assert.deepEqual(populatedPresentationGroups(surface), ['scene']);
  const projected = publicPresentationSurface(surface, 1);
  assert.equal(projected.scene, surface.scene);
  assert.deepEqual(projected.points, []);

  withFakeDocument(() => {
    const view = { timeline: [{ surfaceId: surface.surfaceId, at: surface.at }], display: { cursor: null },
      publicDisplaySurface: surface, phase: 'surface_live' };
    const card = renderSurface(view);
    assert.equal(card.textContent, `Source scene${surface.scene}`);
    assert.equal(card.children.some(node => node.tagName === 'section'), false);
    assert.equal(card.children[1].textContent, surface.scene);
  });
});


test('actual room projections support omitted schema2 findings after Start without exposing private notes', () => {
  const doc = schema2SceneOnly();
  for (const surface of doc.surfaces) { delete surface.points; surface.notes = 'PRIVATE NOTES'; }
  let state = initialState({ sessionId: uuidv7(), caseDoc: doc });
  const result = dispatch(state, {type:'start',actor:{role:'facilitator'},epoch:state.epoch,expectRevision:state.revision,clientEventId:uuidv7(),roundId:uuidv7(),at:'2026-10-09T12:00:00Z'},new Map());
  assert.equal(result.effects.find(effect=>effect.type==='receipt')?.receipt,'accepted');
  state=result.state;
  for (const role of ['facilitator','display','participant']) {
    const view=project(state,role);
    assert.ok(view);
    if(role!=='facilitator')assert.ok(!JSON.stringify(view).includes('PRIVATE NOTES'));
  }
  assert.equal(doc.surfaces[0].points,undefined,'the canonical source was not repaired');
});
