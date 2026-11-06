// Participant feedback answers (CASE-284, D1): one shared validator for the page and the Worker, mirroring
// case_app.feedback_answers in 20261101000000_participant_feedback.sql so a refused shape never reaches SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseFeedbackAnswers, FEEDBACK_TEXT_MAX, RATING_KEYS } from '../src/shared/feedback.mjs';

test('feedback answers keep only the five fixed questions, trimmed and cleaned', () => {
  assert.equal(FEEDBACK_TEXT_MAX, 280);
  assert.deepEqual(RATING_KEYS, ['rating_session', 'rating_case', 'rating_app']);
  assert.deepEqual(normaliseFeedbackAnswers({ rating_session: 4, rating_case: null, takeaway: '  Re-examine\u0000 early.  ' }),
    { ok: true, answers: { rating_session: 4, takeaway: 'Re-examine early.' } });
  assert.deepEqual(normaliseFeedbackAnswers({ improve: 'More imaging.', improve_about: 'case', rating_app: 5 }),
    { ok: true, answers: { improve: 'More imaging.', improve_about: 'case', rating_app: 5 } });
});

test('feedback answers refuse every shape the SQL refuses', () => {
  const refused = [null, [], 'x', {}, { rating_session: null }, { rating_session: 0 }, { rating_session: 6 }, { rating_session: '4' },
    { rating_session: 2.5 }, { improve: 'x' }, { improve_about: 'case' }, { improve: 'x', improve_about: 'room' }, { takeaway: '   ' },
    { takeaway: 7 }, { name: 'Robin', rating_app: 3 }, { takeaway: 'x'.repeat(281) }];
  for (const input of refused) assert.deepEqual(normaliseFeedbackAnswers(input), { ok: false, error: 'invalid_feedback' }, JSON.stringify(input));
  assert.equal(normaliseFeedbackAnswers({ takeaway: 'x'.repeat(280) }).ok, true);
});

test('[AS-175] form 2: each rating may carry a comment about its subject; it never mixes with form 1\'s improve pair', () => {
  assert.deepEqual(normaliseFeedbackAnswers({ rating_session: 5, comment_session: ' Great pacing. ', comment_app: 'Bigger buttons.', takeaway: 'Re-examine.' }),
    { ok: true, answers: { rating_session: 5, comment_session: 'Great pacing.', comment_app: 'Bigger buttons.', takeaway: 'Re-examine.' } });
  assert.deepEqual(normaliseFeedbackAnswers({ comment_case: 'More imaging.' }), { ok: true, answers: { comment_case: 'More imaging.' } }, 'a comment alone is a response');
  for (const bad of [{ comment_case: '' }, { comment_case: '  ' }, { comment_app: 7 }, { comment_session: 'x'.repeat(281) }, { comment_other: 'x' },
    { improve: 'x', improve_about: 'app', comment_app: 'y' }]) assert.equal(normaliseFeedbackAnswers(bad).ok, false, JSON.stringify(bad));
});
