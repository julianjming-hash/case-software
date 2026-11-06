// One confirmation dialog for every destructive Administration action (facilitator-UX A5, AS-212). It states the
// consequences first; then, if the action needs this session's step-up and none is held, asks for a code (sent on
// request, checked, never retried); then runs the action once. The state machine is DOM-free; `renderConfirm` draws it.
//   open({ title, sub, consequences, actionLabel, danger, elevation|null, run(token) -> {ok,status,error,data}, onDone(result), onClose() })
// What it says about a failure follows what actually happened:
//   - a code that could not be sent or checked changed nothing: the sign-in-service wording (admin-messages);
//   - a refusal from the action (403/404/409/400) is that refusal, not "uncertain";
//   - only an action that was sent and not answered (timeout, 5xx, no status) is reported as uncertain, and closes.
import { adminMessage, stepUpFailure } from './admin-messages.mjs';

export function createAdminConfirm({ onChange = () => {} } = {}) {
  const state = { open: false, phase: 'review', busy: false, notice: '', title: '', sub: '', consequences: [], actionLabel: '', danger: true, needsCode: false, codeSent: false };
  let spec = null, generation = 0, closed = false;
  const emit = () => onChange(state);
  const live = g => !closed && g === generation && state.open;
  function reset() {
    const closing = spec; generation++; spec = null;
    Object.assign(state, { open: false, phase: 'review', busy: false, notice: '', needsCode: false, codeSent: false, consequences: [] }); emit();
    try { closing?.onClose?.(); } catch { /* a screen's cleanup never blocks closing */ }
  }
  const needsCode = () => Boolean(spec?.elevation) && !spec.elevation.has();
  function open(next) {
    if (closed || state.busy) return false;
    generation++; spec = next;
    Object.assign(state, { open: true, phase: 'review', busy: false, notice: '', title: next.title, sub: next.sub ?? '', consequences: [...(next.consequences ?? [])],
      actionLabel: next.actionLabel, danger: next.danger !== false, needsCode: needsCode(), codeSent: false });
    emit(); return true;
  }
  async function execute(g) {
    const finished = spec;
    let result;
    try { result = await finished.run(finished.elevation?.token() ?? null); } catch { result = { ok: false, status: 0, error: 'admin_unavailable' }; }
    if (closed || g !== generation) { finished.onDone?.({ ...result, cancelled: true }); return false; }
    if (result.ok) { reset(); finished.onDone?.(result); return true; }
    if (result.status === 403) {
      // The confirmation was refused: drop it and ask for a fresh one.
      finished.elevation?.drop();
      Object.assign(state, { phase: 'review', busy: false, needsCode: needsCode(), codeSent: false, notice: adminMessage(result.error === 'step_up_required' ? 'step_up_required' : 'forbidden') });
      emit(); return false;
    }
    if (result.status === 400) { Object.assign(state, { busy: false, notice: adminMessage(result.error) }); emit(); return false; }
    // 404/409: the record moved on; 5xx/timeout/no status: the request was sent and not answered.
    const uncertain = !result.status || result.status >= 500;
    reset(); finished.onDone?.({ ...result, uncertain });
    return false;
  }
  async function proceed() {
    if (closed || !state.open || state.busy || state.phase !== 'review') return false;
    const g = generation; state.busy = true; state.notice = ''; emit();
    if (needsCode()) {
      const sent = await spec.elevation.sendCode();
      if (!live(g)) return false;
      state.busy = false;
      if (!sent.ok) { state.notice = stepUpFailure(sent); emit(); return false; }
      Object.assign(state, { phase: 'code', codeSent: true, notice: 'We emailed you a six-digit code. Enter it below.' }); emit(); return true;
    }
    return execute(g);
  }
  async function resend() {
    if (closed || !state.open || state.busy || !spec?.elevation) return false;
    const g = generation; state.busy = true; state.notice = ''; emit();
    const sent = await spec.elevation.sendCode();
    if (!live(g)) return false;
    state.busy = false; state.notice = sent.ok ? 'We emailed you a new code. The earlier one no longer works.' : stepUpFailure(sent); emit();
    return sent.ok;
  }
  async function verify(code) {
    if (closed || !state.open || state.busy || state.phase !== 'code') return false;
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) { state.notice = 'Enter all six digits of the code.'; emit(); return false; }
    const g = generation; state.busy = true; state.notice = ''; emit();
    const checked = await spec.elevation.verify(code);
    if (!live(g)) return false;
    if (!checked.ok) { state.busy = false; state.notice = stepUpFailure(checked); emit(); return false; }
    return execute(g);
  }
  return { state, open, proceed, resend, verify, cancel() { if (state.open) reset(); }, close() { closed = true; reset(); } };
}

/** Draw the confirmation into a <dialog> element: text only. `adminEmail` names where the code went. */
export function renderConfirm(dialog, flow, { node, adminEmail = null, onClosed = () => {}, notify = null,onCancel=null }) {
  const state = flow.state;
  if (!state.open) { if (dialog.open) dialog.close(); dialog.replaceChildren(); onClosed(); return; }
  const code = dialog.querySelector('input')?.value ?? '', phase = dialog.dataset.phase;
  dialog.dataset.phase = state.phase;
  const form = node('form', null, 'admin-confirm');
  const title = node('h2', state.title); title.id = 'adminConfirmTitle'; dialog.setAttribute('aria-labelledby', 'adminConfirmTitle');
  const parts = [title];
  if (state.sub) parts.push(node('p', state.sub, 'admin-muted'));
  if (state.consequences.length) { const list = node('ul', null, 'admin-consequences'); for (const line of state.consequences) list.append(node('li', line)); parts.push(list); }
  let input = null;
  if (state.phase === 'code') {
    const label = node('label', adminEmail ? `We emailed a 6-digit code to ${adminEmail}. It confirms admin changes until you sign out.` : 'Six-digit code from your email. It confirms admin changes until you sign out.');
    input = node('input'); input.type = 'text'; input.pattern = '[0-9]{6}'; input.inputMode = 'numeric'; input.maxLength = 6; input.autocomplete = 'one-time-code'; input.placeholder = '000000'; input.setAttribute('aria-label', 'Six-digit code');
    if (phase === 'code') input.value = code;
    const again = node('button', 'Send a new code', 'btn quiet'); again.type = 'button'; again.disabled = state.busy; again.onclick = () => void flow.resend();
    const row = node('div', null, 'admin-code-row'); row.append(input, again); label.append(row); parts.push(label);
  } else if (state.needsCode) parts.push(node('p', `To continue, Case emails a 6-digit code to ${adminEmail ?? 'you'}. It confirms admin changes until you sign out.`, 'admin-muted'));
  if(!notify){const note=node('p',state.notice,'admin-confirm-notice');note.setAttribute('role','status');parts.push(note);}
  const actions = node('div', null, 'admin-confirm-actions');
  const cancel = node('button', 'Cancel', 'btn'); cancel.type = 'button'; cancel.disabled = state.busy; cancel.onclick = () => onCancel?onCancel():flow.cancel();
  const asksForCode = state.phase === 'review' && state.needsCode;
  const go = node('button', asksForCode ? 'Email me a code' : state.actionLabel, state.danger && !asksForCode ? 'btn danger' : 'btn primary');
  go.type = 'submit'; go.disabled = state.busy; actions.append(cancel, go); parts.push(actions);
  form.append(...parts);
  form.addEventListener('submit', event => { event.preventDefault(); if (state.phase === 'code') void flow.verify(input.value.trim()); else void flow.proceed(); });
  dialog.replaceChildren(form);
  if (!dialog.open) dialog.showModal();
  if (!state.busy) (input ?? go).focus();
  if(notify&&state.notice)notify(state.notice);
}
