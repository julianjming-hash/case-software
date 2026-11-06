import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderStarter, BUILDER_INTERACTIONS } from '../src/client/builder-templates.mjs';
import { validateBuilderDocument, convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import legacy from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

test('all four template starters declare every capability their authored interpretation requires', () => {
  for (const [type] of BUILDER_INTERACTIONS) {
    const candidate = createBuilderStarter(type);
    const result = validateBuilderDocument(candidate.document, candidate.authoringMetadata, { mode: 'preserve' });
    assert.equal(result.ok, true, type);
    assert.equal(result.warnings.some(issue => issue.code === 'missing_capability'), false, type);
    assert.equal(candidate.document.required_capabilities.includes('human_interpretation'), type !== 'single_choice');
  }
});

test('explicit legacy conversion declares human interpretation without inventing recovery', () => {
  const source = structuredClone(legacy);
  const decision = source.decisions[0];
  decision.interaction = { type: 'free_text', max_length: 280 };
  delete decision.rules;
  for (const path of decision.paths) delete path.option_ids;
  const result = convertSchema1ToBuilderDocument(source);
  assert.equal(result.ok, true);
  assert.equal(result.candidate.decisions[0].interpretation, 'facilitator');
  assert.ok(result.candidate.required_capabilities.includes('human_interpretation'));
  assert.equal(result.candidate.required_capabilities.includes('required_recovery'), false);
  assert.equal(source.schema_version, 1);
});
