// Card 62 (CASE-285 R1): the Builder names the same open warnings SQL computes, and the same cautions the author saw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageWarnings, imageReviewState, IMAGE_WARNING_CODES, IMAGE_REVIEW_KEYS } from '../src/shared/image-review.mjs';
import { MEDIA_LICENCES, assetDetails } from '../src/shared/media.mjs';

// Hand-computed, and identical to db/tests/asset-review-fence.test.sql's first block, so the two lists cannot drift apart.
const CASES = [
  ['clean', { licence: 'own-work', attested: true }, []],
  ['unknown', { licence: 'unknown', attested: false }, ['not_deidentified', 'source_unknown']],
  ['ccby', { licence: 'CC-BY-4.0', attested: true }, ['credit_missing']],
  ['nc', { licence: 'CC-BY-NC-ND-4.0', attribution: 'Fig 1, A. Author', attested: true }, ['licence_caution']],
  ['publication', { licence: 'unlicensed', attribution: 'Figure 2, Textbook of X', attested: true }, ['no_licence']],
  ['licensed', { licence: 'licensed-other', attribution: 'Hospital library', attested: true }, ['licence_terms_missing']],
  ['licensed-note', { licence: 'licensed-other', attribution: 'Hospital library', rights_note: 'Teaching licence 2026', attested: true }, []],
];

test('[AS-172] card 62: the open warnings match SQL, sorted, each once', () => {
  for (const [name, row, codes] of CASES) assert.deepEqual(imageWarnings(row).map(item => item.code), codes, name);
  assert.deepEqual([...IMAGE_WARNING_CODES].sort(), [...IMAGE_WARNING_CODES]);
  // A blank credit is no credit, as the upload dialog trims it.
  assert.deepEqual(imageWarnings({ licence: 'CC-BY-4.0', attribution: '   ', attested: true }).map(item => item.code), ['credit_missing']);
  for (const [, row] of CASES) for (const item of imageWarnings(row)) assert.ok(item.text && !/undefined/.test(item.text), item.code);
});

test('[AS-172] card 62: every source the author can name gives the admin the same warnings the author was shown', () => {
  const FIELD = { source: ['licence_caution', 'no_licence', 'source_unknown'], attribution: ['credit_missing'], rightsNote: ['licence_terms_missing'], attested: ['not_deidentified'] };
  for (const [source, entry] of Object.entries(MEDIA_LICENCES)) {
    for (const attested of [true, false]) {
      const author = assetDetails({ alt: 'x', evidenceKind: 'photo', source, attested });
      const admin = imageWarnings({ licence: entry.licence, rights_basis: entry.rights_basis, attested });
      assert.equal(admin.length, author.warnings.length, `${source} ${attested}`);
      for (const warning of author.warnings) assert.ok(admin.some(item => FIELD[warning.field].includes(item.code)), `${source}: ${warning.field}`);
      // The licence caution is the same sentence in both places.
      const caution = author.warnings.find(item => item.field === 'source');
      if (caution) assert.ok(admin.some(item => item.text.includes(caution.text)), source);
    }
  }
});

