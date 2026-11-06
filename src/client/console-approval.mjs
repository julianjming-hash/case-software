// Fresh-tab phone approval: preview a PC, then choose one caller-owned active room.
import { accountRequest, node } from './auth-ui.mjs';
import { normalizeCode } from '../shared/ids.mjs';

export function mountConsoleApproval(main, auth) {
  const open = node('button', 'Approve a PC', 'btn'); open.type = 'button';
  const panel = node('section', null, 'console-approval'); panel.hidden = true;
  const label = node('label', 'PC code');
  const input = node('input'); input.autocomplete = 'off'; input.maxLength = 12; label.append(input);
  const preview = node('button', 'Preview device', 'btn primary'); preview.type = 'button';
  const details = node('p', ''); details.setAttribute('role', 'status');
  const rooms = node('div', null, 'owned-rooms');
  panel.append(node('h2', 'Approve a shared PC'), label, preview, details, rooms);
  main.append(open, panel);
  let code = null, generation = 0, approving = false, closed = false;
  open.addEventListener('click', () => { panel.hidden = false; open.hidden = true; input.focus(); });
  async function list(after = null) {
    const current = generation;
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (after) params.set('after', after);
      const result = await accountRequest(auth, ['me', 'rooms'], { query: params });
      if (current !== generation) return;
      if (!Array.isArray(result.rooms) || result.rooms.length > 20) throw new Error('invalid_rooms');
      if (!after) rooms.replaceChildren();
      if (!result.rooms.length && !after) details.textContent = 'No active rooms. Start one on your phone first.';
      for (const room of result.rooms) {
        if (typeof room.joinCode !== 'string') throw new Error('invalid_room');
        const choose = node('button', `Approve room ${room.joinCode}`, 'btn'); choose.type = 'button';
        choose.addEventListener('click', async () => {
          if (closed || approving || current !== generation || !code) return;
          approving = true;
          let approvalGeneration = generation;
          const approvedCode = code;
          preview.disabled = true; input.disabled = true;
          for (const item of rooms.querySelectorAll('button')) item.disabled = true;
          try {
            const result = await accountRequest(auth, ['console-pairs', 'approve'], {
              method: 'POST', body: { code: approvedCode, sessionId: room.sessionId },
            });
            if (closed || approvalGeneration !== generation) return;
            if (result.approved !== true) throw new Error('approval_unavailable');
            approvalGeneration = ++generation; code = null;
            rooms.replaceChildren(); details.textContent = 'PC approved. You may close this page.';
          } catch {
            if (!closed && approvalGeneration === generation)
              details.textContent = 'Approval failed or the room ended. Refresh the room list.';
          } finally {
            if (!closed && approvalGeneration === generation) {
              approving = false; preview.disabled = false; input.disabled = false;
              for (const item of rooms.querySelectorAll('button')) item.disabled = false;
            }
          }
        });
        rooms.append(choose);
      }
      if (result.nextAfter) {
        const more = node('button', 'More rooms', 'btn'); more.type = 'button';
        more.addEventListener('click', () => { more.remove(); void list(result.nextAfter); });
        rooms.append(more);
      }
    } catch {
      if (current === generation) {
        rooms.replaceChildren(); details.textContent = 'Room list changed or is unavailable. Reload it to try again.';
        const retry = node('button', 'Reload rooms', 'btn'); retry.type = 'button';
        retry.addEventListener('click', () => { retry.remove(); void list(); }); rooms.append(retry);
      }
    }
  }
  preview.addEventListener('click', async () => {
    if (closed || approving) return;
    const next = normalizeCode(input.value, 8);
    if (!next) { details.textContent = 'Enter the eight-character PC code.'; return; }
    const current = ++generation; code = null;
    preview.disabled = true; rooms.replaceChildren();
    try {
      const seen = await accountRequest(auth, ['console-pairs', 'preview'], { method: 'POST', body: { code: next } });
      if (closed || current !== generation) return;
      if (!['Chrome', 'Edge', 'Firefox', 'Safari', 'Other'].includes(seen.browser) ||
          typeof seen.country !== 'string' || typeof seen.city !== 'string') throw new Error('invalid_preview');
      code = next;
      details.textContent = `Browser: ${seen.browser}. Location: ${seen.city}, ${seen.country}. Requested: ${seen.requestedAt}. Expires: ${seen.expiresAt}.`;
      await list();
    } catch { if (!closed && current === generation) details.textContent = 'That PC code is unavailable or expired.'; }
    finally { if (!closed && current === generation) preview.disabled = false; }
  });
  return { clear() { closed = true; generation++; approving = false; code = null; panel.remove(); open.remove(); } };
}
