// A picker label only. Room creation independently rechecks membership and
// published-document integrity at the Worker.
import { isUuidV7 } from '../shared/ids.mjs';

const digest = value => typeof value === 'string' && /^\\x[0-9a-f]{64}$/.test(value);

export function pilotVersionState(row, pin) {
  if (!isUuidV7(pin?.versionId) || !digest(pin?.contentSha256)) return 'unconfigured';
  if (!isUuidV7(row?.version_id) || !digest(row?.content_sha256)) return 'unverified';
  return row.version_id === pin.versionId && row.content_sha256 === pin.contentSha256
    ? 'approved' : 'different';
}
