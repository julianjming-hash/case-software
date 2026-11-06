// People model (facilitator-UX A5): the account list with each account's roles, grants and admin state, and the
// account lifecycle actions. The session's step-up lives in admin-elevation.mjs. A refresh that fails keeps the last
// data and says so; a background refresh never shows "Loading". `adminMessage` moved to admin-messages.mjs.
import { adminMessage } from './admin-messages.mjs';
export { adminMessage };
// Every action that needs this session's step-up: the destructive ones, and P-41's Name & role correction.
const STEP_UP = new Set(['facilitators_disable', 'facilitators_soft_delete', 'facilitators_label']);
export function createAdminModel({ api, elevation, onChange = () => {} } = {}) {
  let generation = 0, closed = false, flight = false;
  const state = { gate: 'loading', rows: [], selected: null, query: '', page: 1, next: null, loading: false, acting: false, notice: '', refreshFailed: false, loadedAt: null };
  const emit = () => onChange(state);
  const current = g => !closed && g === generation;
  function clear(reason = 'sign_out') {
    // The shell owns the API client and the session's step-up: leaving People must not close them.
    closed = true; generation++;
    Object.assign(state, { rows: [], selected: null, query: '', next: null, notice: '', loading: false, acting: false, refreshFailed: false, loadedAt: null, gate: reason === 'forbidden' ? 'admin_only' : 'sign_in' });
    emit();
  }
  async function load({ page = state.page, quiet = false } = {}) {
    if (closed) return false;
    const g = ++generation, search = state.query;
    // A quiet (background) refresh leaves the table, the page and any open record alone until it has an answer.
    if (!quiet) { state.page = page; state.selected = null; state.next = null; state.loading = state.gate !== 'ready'; state.notice = ''; if (state.gate !== 'ready') state.rows = []; emit(); }
    const result = await api.call(search ? 'facilitators_search' : 'facilitators_list', { options: search ? {} : { page, perPage: 100 }, ...(search ? { body: { query: search, page, perPage: 100 } } : {}) });
    if (!current(g)) return false;
    state.loading = false;
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        Object.assign(state, { gate: result.status === 401 ? 'sign_in' : 'admin_only', rows: [], selected: null, next: null, notice: adminMessage(result.error), refreshFailed: false });
      } else if (state.gate === 'ready') {
        // The last data stays: the list is stale, not gone.
        state.refreshFailed = true; state.notice = `Case could not refresh this list, so it shows information from ${new Date(state.loadedAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ${adminMessage(result.error)}`;
      } else { state.gate = 'unavailable'; state.notice = adminMessage(result.error); }
      emit(); return false;
    }
    Object.assign(state, { gate: 'ready', rows: result.data.users, next: result.data.nextPage, refreshFailed: false, loadedAt: Date.now() });
    if (quiet && state.selected) state.selected = state.rows.find(row => row.id === state.selected.id) ?? state.selected;
    if (!quiet || state.notice) state.notice = '';
    emit(); return true;
  }
  function select(target) { if (closed) return; generation++; state.selected = target; state.notice = ''; emit(); }
  function cancel() { if (closed) return; generation++; state.selected = null; state.notice = ''; emit(); }
  /** One account action. Resolves `{ ok }` or `{ ok:false, status, error }`; a stale record reloads and is reported as the conflict it is. */
  async function act(operation, { label = null, record = state.selected } = {}) {
    if (closed || flight || !record) return { ok: false, status: 0, error: 'closed' };
    if (!record.profile || !Number.isSafeInteger(record.profile.admin_revision)) return { ok: false, status: 0, error: 'bad_request' };
    if (operation === 'facilitators_label' && (typeof label?.name !== 'string' || typeof label?.role !== 'string')) return { ok: false, status: 0, error: 'bad_request' };
    if (STEP_UP.has(operation) && !elevation?.has()) return { ok: false, status: 403, error: 'step_up_required' };
    const options = { id: record.id };
    const body = { expectedRevision: record.profile.admin_revision, ...(['facilitators_disable', 'facilitators_soft_delete'].includes(operation) ? { confirmEmail: record.email } : {}),
      ...(operation === 'facilitators_label' ? { name: label.name, role: label.role } : {}) };
    flight = true; state.acting = true; emit();
    try {
      const result = await api.call(operation, { options, body, elevation: STEP_UP.has(operation) ? elevation.token() : null });
      if (closed) return { ok: false, status: 0, error: 'closed' };
      if (!result.ok) {
        if (result.status === 403) elevation?.drop();
        if (result.status === 409 || result.status === 404) { flight = false; state.acting = false; await load(); if (!closed) { state.notice = adminMessage(result.error === 'not_found' ? 'not_found' : 'conflict'); emit(); } }
        return result;
      }
      flight = false; state.acting = false; await load({ quiet: false });
      if (!closed) { state.notice = 'Action recorded.'; emit(); }
      return { ok: true };
    } catch { return { ok: false, status: 0, error: 'admin_unavailable' }; }
    finally { flight = false; if (!closed) { state.acting = false; emit(); } }
  }
  return { state, load, select, cancel, act, clear,
    async search(query) { if (closed || typeof query !== 'string' || query.length > 320) return false; state.query = query.trim(); return load({ page: 1 }); } };
}
