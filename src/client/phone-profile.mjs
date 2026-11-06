// A server receipt confirms this phone's appearance; failed saves leave the editor open.
export function applyProfileReceipt(result, view, profile, collapse) {
  if (!['accepted','already_accepted'].includes(result?.receipt)) return false;
  if (view?.you) { view.you.name=profile.displayName; view.you.avatarId=profile.avatarId; }
  collapse();
  return true;
}
