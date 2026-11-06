// What each destructive action does, said before the code is asked for (facilitator-UX A5, AS-212; the mockup's
// "every button says what it does"). Pure text: lists of sentences, no markup.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const phones = rooms => rooms.reduce((sum, room) => sum + (room.participantCount ?? 0), 0);
const roomLine = rooms => rooms === null || rooms === undefined ? 'Any room they are running ends now.'
  : !rooms.length ? 'They are running no live room.'
    : `Their ${plural(rooms.length, 'live room')} ${rooms.length === 1 ? 'ends' : 'end'} now (${plural(phones(rooms), 'phone')} joined).`;
const ROLE = { owner: 'Can manage', author: 'Can edit', facilitator: 'Can run' };
const POWER = {
  facilitator: 'Can run allows presenting published cases and reading your own session records, without editing cases.',
  author: 'Can edit also allows creating and editing cases. Publishing depends on workspace policy.',
  owner: 'Can manage also allows publishing workspace cases and managing groups. Invitations and workspace session records depend on policy.',
};
export const size = bytes => bytes >= 1e9 ? `${+(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${+(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;

export const disable = ({ rooms }) => ['They are signed out on every device and cannot sign in.', roomLine(rooms),
  'Their cases, drafts and session records stay. Enable gives everything back.'];
export const disableLabel = rooms => rooms?.length ? `Disable and end ${plural(rooms.length, 'room')}` : 'Disable';
export const softDelete = ({ rooms }) => ['They are signed out on every device and cannot sign in.', roomLine(rooms),
  'After 30 days the account is deleted for good. Until then Restore brings it back.',
  'Their cases, drafts and session records stay, without their sign-in.'];
export const softDeleteLabel = rooms => rooms?.length ? `Soft delete and end ${plural(rooms.length, 'room')}` : 'Soft delete';
export const removeMember = ({ email, workspace }) => [`${email} loses access to every case in ${workspace}.`,
  'Rooms they are running keep going until they end; they cannot start new ones here.',
  'Their account, and any access they hold elsewhere, stay. They can be added again.'];
export const changeRole = ({ email, workspace, from, to }) => [`${email}’s access in ${workspace} changes from ${ROLE[from] ?? from} to ${ROLE[to] ?? to}.`, POWER[to] ?? ''].filter(Boolean);
export const addMember = ({ email, workspace, role }) => [`${email} joins ${workspace} with ${ROLE[role] ?? role} access and sees every case there.`, POWER[role] ?? ''].filter(Boolean);
export const withdrawVersion = ({ title, versionNo }) => [`No one can start a new session from “${title}” (version ${versionNo}) until it is republished.`,
  'Rooms already running are not ended.', 'Republish brings it back with the same content.'];
export const republishVersion = ({ title, versionNo }) => [`“${title}” (version ${versionNo}) can be started again from the library.`, 'Nothing in the case changes.'];
export const endRoom = ({ participantCount }) => ['The room ends now for everyone in it.',
  `${plural(participantCount ?? 0, 'phone')} will see the end screen.`, 'It cannot be reopened; its facilitator can start a new one.'];
export const revokeInvitation = ({ email }) => [`The link in the email to ${email} stops working at once.`, 'Nothing they already have changes.', 'You can invite them again.'];
export const deleteUnused = ({ count, bytes }) => [`${plural(count, 'image')} (${size(bytes)}) that no draft, version or room uses ${count === 1 ? 'is' : 'are'} deleted.`,
  'An image used since you opened this list is kept.', 'Deleted images cannot be recovered; the same file can be uploaded again.'];
