// src/shared/facilitator-label.mjs: the facilitator "Name & role" on the participant record.
//
// A facilitator states a Name and a Role once, at first sign-in, and may change them in Account; an admin may correct
// them (step-up, audited). At Start room the console may replace them for that one session (Julian, 2026-10-18). The
// room keeps one label, "Name, Role", fixed at start; participants see it only once the room has ended (recap, /F,
// the Finish block's Facilitator field and the record PDF), and it is deleted with the room's personal data at 24 h
// (hard rule 8). Text only (hard rule 14). The Worker, the room DO, SQL and every client apply the same rules. Pure.
import { cleanText } from './text.mjs';

export const NAME_MAX = 80;  // case_app.profiles.display_name
export const ROLE_MAX = 80;  // case_app.profiles.facilitator_role
export const LABEL_MAX = NAME_MAX + 2 + ROLE_MAX; // case_app.sessions.facilitator_label
/** The neutral name an invited facilitator or a profile-less admin gets (CASE-141): never a confirmed name. */
export const PLACEHOLDER_NAME = 'Facilitator';

/** The Role field's suggestions as you type, most senior first; any other wording is allowed (Julian, 2026-10-18). */
export const ROLE_SUGGESTIONS = Object.freeze(['Consultant', 'Senior registrar', 'Registrar', 'Senior resident',
  'Resident / RMO', 'Intern', 'Nurse educator', 'Clinical nurse', 'Simulation educator']);

const chars = s => [...s].length; // Postgres char_length counts code points, not UTF-16 units

/** The stored form of one field: controls removed, whitespace collapsed, trimmed (never silently cut). */
export function normaliseLabelField(raw) {
  return typeof raw === 'string' ? cleanText(raw, 4096) : '';
}

/** Why a Name and Role pair is refused, or null. Both are required. */
export function labelProblem(name, role) {
  const n = normaliseLabelField(name), r = normaliseLabelField(role);
  if (!n) return { field: 'name', problem: 'required' };
  if (chars(n) > NAME_MAX) return { field: 'name', problem: 'too_long' };
  if (!r) return { field: 'role', problem: 'required' };
  if (chars(r) > ROLE_MAX) return { field: 'role', problem: 'too_long' };
  return null;
}

/** The words for each problem, shown beside the field. */
export const LABEL_PROBLEM_TEXT = Object.freeze({
  name: { required: 'Enter your name.', too_long: `Use ${NAME_MAX} characters or fewer.` },
  role: { required: 'Enter your role.', too_long: `Use ${ROLE_MAX} characters or fewer.` },
});

/** A request body's { name, role }: `{ ok, name, role }` normalised, or `{ ok: false }`. */
export function parseLabelFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.name !== 'string' || typeof value.role !== 'string' ||
      value.name.length > 4 * NAME_MAX || value.role.length > 4 * ROLE_MAX || labelProblem(value.name, value.role)) return { ok: false };
  return { ok: true, name: normaliseLabelField(value.name), role: normaliseLabelField(value.role) };
}

/** The one line the record shows: "Name, Role". */
export function composeLabel(name, role) {
  return `${normaliseLabelField(name)}, ${normaliseLabelField(role)}`;
}

/** Whether a value is a stored label exactly as composeLabel makes it (the room DO and the clients accept nothing else). */
export function validLabel(value) {
  return typeof value === 'string' && value.length > 0 && chars(value) <= LABEL_MAX && normaliseLabelField(value) === value;
}
