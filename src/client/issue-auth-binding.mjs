// Weak associations only: no credentials added to DTOs, DOM, URLs or persistent storage.
const responses=new WeakMap(),identities=new WeakMap();
export function rememberIssueAuth(value,auth){if(value&&typeof value==='object')responses.set(value,auth);return value;}
export function bindIssueIdentity(identity,me){const auth=responses.get(me)??identities.get(me);if(auth)identities.set(identity,auth);return identity;}
export const issueIdentityAuth=identity=>identity&&identities.get(identity);
