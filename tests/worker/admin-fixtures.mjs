// Test-only explicit authority bindings around the actual Worker and real DOs; SELF sockets stay real.
import {env} from 'cloudflare:test';
import {afterEach,vi} from 'vitest';
import worker from '../../src/worker/index.mjs';
import {newCapabilityToken} from '../../src/shared/ids.mjs';
import {knownAccountFake} from '../helpers/admin-account-fixture.mjs';
afterEach(()=>vi.unstubAllGlobals());
export function nativeAccountFetch(input,init,actors) {
 const fake=knownAccountFake({actors});
 vi.stubGlobal('fetch',fake.fetchImpl);
 return worker.fetch(new Request(input,init),{...env,SUPABASE_URL:'https://admin-accounts.invalid/',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`});
}
