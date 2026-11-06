// The facilitator's Name and Role fields (Julian, 2026-10-18): Role suggests the seniority ladder as you type and takes any
// other wording. One builder for the first-sign-in step, Account, Start room's "Facilitator on record (this session)" and
// Administration → Facilitators, so the rules and the words are the same everywhere. Text only (hard rule 14).
import { node, accountRequest } from './auth-ui.mjs';
import { ROLE_SUGGESTIONS, NAME_MAX, ROLE_MAX, PLACEHOLDER_NAME, labelProblem, LABEL_PROBLEM_TEXT, normaliseLabelField, parseLabelFields } from '../shared/facilitator-label.mjs';

let fieldSets = 0;

/** `{ root, value(), set(), validate(), disable() }` for a Name and a Role, prefilled (the 'Facilitator' placeholder is no name). */
export function labelFields({ name = '', role = '', legend = null, hint = null } = {}) {
  const id = `facilitator-label-${++fieldSets}`;
  const root = node('fieldset', null, 'label-fields');
  if (legend) root.append(node('legend', legend));
  const field = (key, text, max) => {
    const wrap = node('div', null, 'field'), label = node('label', text), input = node('input', null, 'input'), error = node('p', '', 'field-error');
    input.id = label.htmlFor = `${id}-${key}`; input.type = 'text'; input.maxLength = max * 2; input.spellcheck = false;
    input.autocomplete = key === 'name' ? 'name' : 'organization-title';
    error.id = `${input.id}-error`; error.hidden = true; input.setAttribute('aria-describedby', error.id);
    wrap.append(label, input, error);
    return { key, wrap, input, error };
  };
  const fields = [field('name', 'Name', NAME_MAX), field('role', 'Role', ROLE_MAX)], [nameField, roleField] = fields;
  const roles = node('datalist');
  roles.id = `${id}-roles`;
  for (const suggestion of ROLE_SUGGESTIONS) { const option = node('option'); option.value = suggestion; roles.append(option); }
  roleField.input.setAttribute('list', roles.id); roleField.wrap.append(roles);
  root.append(...fields.map(f => f.wrap));
  if (hint) root.append(node('p', hint, 'field-hint'));
  const show = problem => {
    for (const f of fields) {
      const bad = problem?.field === f.key;
      f.input.setAttribute('aria-invalid', String(bad)); f.error.hidden = !bad;
      f.error.textContent = bad ? LABEL_PROBLEM_TEXT[f.key][problem.problem] : '';
    }
  };
  const set = (value = {}) => {
    nameField.input.value = value.name && value.name !== PLACEHOLDER_NAME ? value.name : '';
    roleField.input.value = value.role ?? '';
    show(null);
  };
  set({ name, role });
  return {
    root, inputs: fields.map(f => f.input), set,
    value: () => ({ name: normaliseLabelField(nameField.input.value), role: normaliseLabelField(roleField.input.value) }),
    /** Shows the first problem beside its field and focuses it; true when both are fine. */
    validate() {
      const problem = labelProblem(nameField.input.value, roleField.input.value);
      show(problem);
      if (problem) fields.find(f => f.key === problem.field).input.focus();
      return !problem;
    },
    disable(on) { for (const f of fields) f.input.disabled = on; },
  };
}

/** PUT /api/v1/me/profile (P-40). Resolves the saved, confirmed profile, or throws on any other answer. */
export async function saveOwnLabel(auth, value) {
  const reply = await accountRequest(auth, ['me', 'profile'], { method: 'PUT', body: value });
  const profile = reply?.profile, fields = parseLabelFields({ name: profile?.displayName, role: profile?.role });
  if (!fields.ok || fields.name !== value.name || fields.role !== value.role || profile.labelConfirmed !== true) throw new Error('invalid_profile');
  return profile;
}

/**
 * The first-sign-in step (Julian, 2026-10-18): every account whose Name & role are not confirmed states them before the
 * library, prefilled with what an admin may already have set. Resolves the saved profile, or null when the page moved on.
 */
export function mountLabelStep(host, { auth, profile, current = () => true }) {
  return new Promise(resolve => {
    const form = node('form', null, 'label-step');
    const fields = labelFields({ name: profile?.displayName ?? '', role: profile?.role ?? '' });
    const save = node('button', 'Save and continue', 'btn primary'), status = node('p', '', 'field-hint');
    save.type = 'submit'; status.setAttribute('role', 'status');
    form.append(node('h2', 'Your name and role'),
      node('p', 'Participants see this on their Participant record as the facilitator who ran the session. You can change it later in Account.', 'muted'),
      fields.root, save, status);
    host.replaceChildren(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled || !fields.validate()) return;
      save.disabled = true; fields.disable(true); status.textContent = 'Saving…';
      try {
        const saved = await saveOwnLabel(auth, fields.value());
        if (!current()) return resolve(null);
        form.remove(); resolve(saved);
      } catch {
        if (!current()) return resolve(null);
        status.textContent = 'Your name and role could not be saved. Try again.'; save.disabled = false; fields.disable(false);
      }
    });
    fields.inputs[0].focus({ preventScroll: true });
  });
}
