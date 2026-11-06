// The session's step-up (Julian, 2026-10-07, R-a): one emailed code opens a window for every destructive action until
// sign-out. Memory only; dropped by a refused action or sign-out. `sendCode` and `verify` answer `{ ok, code }` where `code`
// is the Worker's fixed error string, so every screen can say what went wrong (admin-messages.mjs).
export function createAdminElevation(api) {
  let token = null, closed = false;
  return {
    has: () => token !== null,
    token: () => token,
    drop() { token = null; },
    clear() { token = null; closed = true; },
    async sendCode() {
      if (closed) return { ok: false, code: 'closed' };
      const result = await api.call('stepup_start', { body: {} });
      return { ok: result.ok, code: result.error };
    },
    async verify(code) {
      if (closed) return { ok: false, code: 'closed' };
      if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return { ok: false, code: 'code_rejected' };
      const result = await api.call('stepup_verify', { body: { code } });
      if (!result.ok) return { ok: false, code: result.error };
      const value = result.data?.elevation;
      if (closed || typeof value !== 'string' || !value || value.length > 2048) return { ok: false, code: 'admin_unavailable' };
      token = value;
      return { ok: true };
    },
  };
}
