// The owner configures this public, environment-specific pair only after publishing
// the approved MVC version. An incomplete pair never labels a version approved.
import { isUuidV7 } from '../shared/ids.mjs';

export function pilotPinFromEnv(env) {
  const versionId = env?.CASE_PILOT_VERSION_ID;
  const contentSha256 = env?.CASE_PILOT_CONTENT_SHA256;
  return isUuidV7(versionId) && typeof contentSha256 === 'string' &&
    /^\\x[0-9a-f]{64}$/.test(contentSha256)
    ? { versionId, contentSha256 } : null;
}
