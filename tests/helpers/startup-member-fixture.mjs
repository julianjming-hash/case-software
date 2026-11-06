// The actual Auth restore + verified membership/catalogue/owner-list path, local stubs only.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { startStartupNetwork } from './startup-network.mjs';
const load = (root, path) => import(pathToFileURL(join(root, path)));
export async function startStartupMemberFixture(root, network) {
  const [{startLocalAuthStub},{startPublishedWorker},{startServedAuthShell},{uuidv7},{describeCase,withSolution},{FIXTURE}] = await Promise.all([
    load(root,'tests/helpers/local-auth-stub.mjs'),load(root,'tests/helpers/published-worker.mjs'),load(root,'tests/helpers/served-auth-shell.mjs'),
    load(root,'src/shared/ids.mjs'),load(root,'src/shared/art-descriptor.mjs'),load(root,'tests/helpers/local-worker.mjs')]);
  const art = withSolution(describeCase(FIXTURE), {attempt:0,summarised:false});
  const catalogue = Array.from({length:24},(_,i)=>({version_id:uuidv7(),case_id:uuidv7(),version_no:1,title:`Local case ${String(i+1).padStart(2,'0')}`,
    summary:'Local published metadata',audience:'Facilitators',setting:'Simulation',duration_min:15,published_at:'2026-10-01T00:00:00Z',art}));
  let auth,worker,shell,relay;
  try {
    auth=await startLocalAuthStub({appOrigin:null,jwt:null});worker=await startPublishedWorker({authOrigin:auth.origin,catalogue});auth.setJwt(worker.jwt);
    worker.fake.replies.set('get_me',args=>args.p_user_id===worker.userId?[{user_id:worker.userId,display_name:'Local facilitator',memberships:[{workspace_id:worker.workspaceId,role:'facilitator'}],next_after:null,admin:false}]:[]);
    worker.fake.replies.set('list_owned_active_sessions',[]);
    let ownerDelayMs=0;const native=worker.fake.fetchImpl;
    worker.fake.fetchImpl=async(...args)=>{if(new URL(args[0]).pathname.endsWith('/list_owned_active_sessions')&&ownerDelayMs)await new Promise(resolve=>setTimeout(resolve,ownerDelayMs));return native(...args);};
    shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:`${auth.origin}/auth/v1`,SUPABASE_JWKS_URL:`${auth.origin}/auth/v1/.well-known/jwks.json`}});
    relay=await startStartupNetwork({upstream:shell.origin,...network});auth.setAppOrigin(relay.origin);
    return {origin:relay.origin,assetDir:shell.outDir,auth,worker,begin(options){ownerDelayMs=options.ownerDelayMs??0;return relay.begin(options);},
      async stop(){await relay.stop();await shell.stop();await worker.stop();await auth.stop();}};
  }catch(error){await relay?.stop();await shell?.stop();await worker?.stop();await auth?.stop();throw error;}
}
