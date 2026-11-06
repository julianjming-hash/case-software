// Saved checkpoints in the Builder (D1/D2, round 24): one panel, refreshed in place, with its own labelled name field.
// The route hands this to the studio, so the studio chunk carries none of it. Text only: every string is textContent.
import { restoreCheckpointWithoutLosingEdits } from './builder-checkpoint-restore.mjs';

export const CHECKPOINT_NAME_MAX = 60;
// A case keeps at most three checkpoints (`checkpoint_limit` in the database); the panel says so before it refuses (D12).
export const CHECKPOINT_LIMIT = 3;
const LIMIT_TEXT = `${CHECKPOINT_LIMIT} of ${CHECKPOINT_LIMIT} checkpoints. Delete one to save another.`;
// A failed request is said in words, never as its raw code ("request_unavailable").
const failure = (error, fallback) => error?.code === 'checkpoint_limit' ? LIMIT_TEXT
  : !error?.message || error.message === 'request_unavailable' || Number.isInteger(error?.status) ? fallback : error.message;
// The server takes a trimmed name without control characters; hidden marks are removed, never counted.
const cleanName = value => String(value ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/g, '').trim();

/** Why a name cannot be used, in words, or '' when it can. A long name is refused and counted, never cut short. */
export function checkpointNameIssue(value) {
  const name = cleanName(value);
  if (!name) return 'Name this checkpoint to create it.';
  if (name.length > CHECKPOINT_NAME_MAX) return `${name.length} of ${CHECKPOINT_NAME_MAX} characters: shorten the name to create it.`;
  return '';
}

/**
 * The studio supplies its review host, status line, save state and a restore hook; `show()` opens the panel or
 * refreshes the open one, so opening twice or creating never stacks a second panel.
 */
export function createCheckpointPanel({ doc, services, reviewHost, setStatus, saveState, validateDocument, createId, onRestored }) {
  const element = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
  const button = (label, action, className = 'builder-btn') => { const node = element('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node; };
  const nameOf = checkpoint => checkpoint.name || 'Untitled checkpoint';
  let panel = null;

  function review(label, question, confirm, danger) {
    const box = element('section', undefined, 'builder-confirm-change');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', label);
    box.append(element('p', question), button(confirm.label, () => void confirm.run(box), danger ? 'builder-btn builder-danger' : 'builder-btn'), button('Cancel', () => box.remove()));
    reviewHost.append(box);
  }
  async function create(input, note, hint) {
    const name = cleanName(input.value), snapshot = saveState.snapshot();
    const refuse = message => { note.textContent = message; note.dataset.tone = 'alert'; input.setAttribute('aria-invalid', 'true'); input.focus?.(); };
    const issue = checkpointNameIssue(name);
    if (issue) return refuse(issue);
    if (snapshot?.status !== 'saved') return refuse(hint(snapshot));
    try {
      const result = await services.create(name, snapshot.baseRevision);
      const message = result?.name ? `Checkpoint “${result.name}” created from revision ${result.revision}.` : 'Checkpoint created.';
      setStatus(message); await show();
    } catch (error) {
      // Full since the panel was drawn (another tab, say): redraw it at the limit, which says so and disables Create.
      if (error?.code === 'checkpoint_limit') { setStatus(LIMIT_TEXT); await show(); return; }
      refuse(failure(error, 'Checkpoint could not be created. Check the connection and try again.'));
    }
  }
  function restore(checkpoint) {
    const starting = saveState.snapshot(), expectedRevision = starting.baseRevision;
    review('Review checkpoint restore', `Restore “${nameOf(checkpoint)}” as a fresh saved revision? Current unsaved edits will be replaced.`, { label: 'Restore as new revision', run: async box => {
      try {
        await restoreCheckpointWithoutLosingEdits({
          expectedGeneration: starting.localGeneration,
          currentGeneration: () => saveState.snapshot().localGeneration,
          restore: () => services.restore(checkpoint.id, expectedRevision),
          validate: value => Number.isSafeInteger(value?.revision) && value.revision >= 0 && value.document && value.authoringMetadata &&
            validateDocument(value.document, value.authoringMetadata, { mode: 'preserve' })?.ok === true,
          apply: value => { box.remove(); onRestored(value); },
        });
      } catch (error) { setStatus(failure(error, 'Checkpoint could not be restored. Check the connection and try again.')); }
    } });
  }
  function remove(checkpoint) {
    review('Review checkpoint deletion', `Delete checkpoint “${nameOf(checkpoint)}”? This cannot be undone.`, { label: 'Delete checkpoint', run: async box => {
      try { await services.delete(checkpoint.id); box.remove(); setStatus('Checkpoint deleted.'); await show(); }
      catch (error) { setStatus(failure(error, 'Checkpoint could not be deleted. Check the connection and try again.')); }
    } }, true);
  }
  // The outcome of a create or delete is said once, in the status line; the panel just shows the new list.
  async function show() {
    let checkpoints;
    try { checkpoints = await services.list(); }
    catch (error) { setStatus(failure(error, 'Checkpoints could not be loaded. Check the connection and try again.')); return; }
    const reused = panel?.isConnected === true;
    if (!reused) { panel = element('section', undefined, 'builder-checkpoints'); panel.setAttribute('aria-label', 'Saved checkpoints'); }
    panel.replaceChildren(element('h3', 'Saved checkpoints'));
    const kept = (Array.isArray(checkpoints) ? checkpoints : []).filter(item => item && typeof item.id === 'string').length, full = kept >= CHECKPOINT_LIMIT;
    const hint = snapshot => full ? LIMIT_TEXT : snapshot?.status === 'saved' ? `Keeps saved revision ${snapshot.baseRevision}. Up to ${CHECKPOINT_NAME_MAX} characters. ${kept} of ${CHECKPOINT_LIMIT} checkpoints kept.` : 'Save the draft first: a checkpoint keeps the last saved revision.';
    const form = element('form', undefined, 'builder-checkpoint-create'); form.noValidate = true;
    const field = element('label', 'Checkpoint name', 'builder-inline-field');
    const input = element('input'); input.type = 'text'; input.autocomplete = 'off'; input.dataset.controlKey = 'checkpoint:name';
    const note = element('p', hint(saveState.snapshot()), 'builder-checkpoint-note'); note.id = `builder-checkpoint-note-${createId()}`; note.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', note.id);
    input.addEventListener('input', () => {
      const issue = cleanName(input.value).length > CHECKPOINT_NAME_MAX ? checkpointNameIssue(input.value) : '';
      if (issue) { note.textContent = issue; note.dataset.tone = 'alert'; input.setAttribute('aria-invalid', 'true'); }
      else if (note.dataset.tone) { note.textContent = hint(saveState.snapshot()); delete note.dataset.tone; input.removeAttribute('aria-invalid'); }
    });
    const submit = element('button', 'Create checkpoint', 'builder-btn builder-primary'); submit.type = 'submit';
    // At the limit Create is off and the note says why; the name field stays, so a typed name survives a deletion.
    submit.disabled = full; if (full) submit.setAttribute('aria-describedby', note.id);
    form.addEventListener('submit', event => { event.preventDefault(); void create(input, note, hint); });
    field.append(input); form.append(field, submit, note); panel.append(form);
    if (!Array.isArray(checkpoints) || !checkpoints.length) panel.append(element('p', 'No checkpoints yet.', 'builder-checkpoint-empty'));
    for (const checkpoint of checkpoints ?? []) {
      if (!checkpoint || typeof checkpoint.id !== 'string') continue;
      const row = element('article', undefined, 'builder-checkpoint-row'), actions = element('div', undefined, 'builder-checkpoint-actions');
      actions.append(button(`Restore ${checkpoint.name || 'checkpoint'}`, () => restore(checkpoint)), button(`Delete ${checkpoint.name || 'checkpoint'}`, () => remove(checkpoint), 'builder-btn builder-danger'));
      row.append(element('h4', nameOf(checkpoint)), element('p', `Saved revision ${Number.isSafeInteger(checkpoint.revision) ? checkpoint.revision : 'unknown'}. Restore creates a new revision.`), actions);
      panel.append(row);
    }
    panel.append(button('Close checkpoints', () => { panel.remove(); panel = null; }));
    if (!reused) reviewHost.append(panel);
    input.focus?.({ preventScroll: true });
  }
  return Object.freeze({ show });
}
