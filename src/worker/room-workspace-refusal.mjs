// Workspaces that may not start rooms in this environment (AS-100, CASE-160). Production lists the
// staging-only Load testing workspace: the load account shares the Supabase project (CASE-159), so a
// leaked load credential must not run or meter rooms on production. Only UUIDv7 entries count.
import { isUuidV7 } from '../shared/ids.mjs';

export function refusedRoomWorkspaces(env) {
  return new Set(String(env?.CASE_REFUSED_ROOM_WORKSPACES ?? '').split(',').map(id => id.trim()).filter(isUuidV7));
}
