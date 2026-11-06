// Card 21a's complete server route inventory, dispatched by the Worker through one gate.
// A route must never be inserted here without the admin tag and an inline handler recheck.
const ID = '[0-9a-f-]{36}';
const entries = [
  ['workspaces_query', 'POST', '/api/v1/admin/workspaces/query'],
  ['workspace_query', 'POST', '/api/v1/admin/workspace/query'],
  ['membership_change', 'POST', '/api/v1/admin/memberships/change'],
  ['operations_query', 'POST', '/api/v1/admin/operations/query'],
  ['stepup_start', 'POST', '/api/v1/admin/stepup/start'],
  ['stepup_verify', 'POST', '/api/v1/admin/stepup'],
  ['facilitators_list', 'GET', '/api/v1/admin/facilitators'],
  ['facilitators_search', 'POST', '/api/v1/admin/facilitators/search'],
  ['facilitators_disable', 'POST', `/api/v1/admin/facilitators/(${ID})/disable`],
  ['facilitators_enable', 'POST', `/api/v1/admin/facilitators/(${ID})/enable`],
  ['facilitators_soft_delete', 'POST', `/api/v1/admin/facilitators/(${ID})/soft-delete`],
  ['facilitators_restore', 'POST', `/api/v1/admin/facilitators/(${ID})/restore`],
  // P-41: correct an account's facilitator Name & role (step-up, audited).
  ['facilitators_label', 'POST', `/api/v1/admin/facilitators/(${ID})/label`],
  ['cases_list', 'GET', '/api/v1/admin/cases'],
  ['cases_publish', 'POST', `/api/v1/admin/cases/(${ID})/publish`],
  ['versions_withdraw', 'POST', `/api/v1/admin/versions/(${ID})/withdraw`],
  ['rooms_list', 'GET', '/api/v1/admin/rooms'],
  ['rooms_end', 'POST', `/api/v1/admin/rooms/(${ID})/end`],
  ['audit_list', 'GET', '/api/v1/admin/audit'],
  // P-22 (card 35): one workspace's in-workspace audit; admins only.
  ['workspace_audit_list', 'GET', `/api/v1/admin/workspaces/(${ID})/audit`],
  // CASE-342: one workspace's image storage against its quota, its unused images, and Delete unused (step-up).
  ['workspace_storage', 'GET', `/api/v1/admin/workspaces/(${ID})/storage`],
  // A5 (P-45): an admin sets one workspace's four policies and image quota against the policy revision.
  ['workspace_settings_set', 'POST', `/api/v1/admin/workspaces/(${ID})/settings`],
  ['workspace_storage_delete_unused', 'POST', `/api/v1/admin/workspaces/(${ID})/storage/delete-unused`],
  // P-39 (card 40 + feedback slice 9): app feedback and everything pooled; admins only.
  ['feedback_query', 'POST', '/api/v1/admin/feedback'],
];

export const ADMIN_ROUTES = Object.freeze(entries.map(([key, method, path]) => Object.freeze({
  key, method, auth: 'admin',
  pattern: new RegExp(`^${path}$`),
  template: path.replace(`(${ID})`, ':id'),
})));

export function matchAdminRoute(path, method) {
  if (typeof path !== 'string' || typeof method !== 'string') return null;
  for (const route of ADMIN_ROUTES) {
    if (route.method === method && route.pattern.test(path)) return route;
  }
  return null;
}
