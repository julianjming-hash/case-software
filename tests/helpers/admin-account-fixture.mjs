// Local-only authority fake: explicit actors, existing exact service contract, never arbitrary success.
import {isUuid} from '../../src/shared/ids.mjs';
import {fakePostgrest} from './fake-postgrest.mjs';
export function knownAccountFake({actors,origin='https://admin-accounts.invalid',versions=[],alerts=[]}={}) {
 if (!Array.isArray(actors) || actors.some(id=>!isUuid(id))) throw new TypeError('Invalid known actor inventory');
 const known=new Set(actors),inactiveActors=new Set(),fake=fakePostgrest({origin,versions,alerts});
 const base=fake.fetchImpl;
 fake.fetchImpl=async(input,init)=>{
  const response=await base(input,init);
  if (!response.ok) return response;
  if (new URL(input).pathname!=='/rest/v1/rpc/admin_account_active') return response;
  const args=JSON.parse(init.body);
  return Response.json(known.has(args.p_user_id) && !inactiveActors.has(args.p_user_id));
 };
 return {...fake,inactiveActors};
}
