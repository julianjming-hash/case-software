import {afterEach,it,expect,vi} from 'vitest';
import worker from '../../src/worker/index.mjs';
import {uuidv7,newCapabilityToken} from '../../src/shared/ids.mjs';
afterEach(()=>vi.unstubAllGlobals());
it('Card21a mounted purge47 performs audited due-only Auth-first deletion without invoking health',async()=>{
 const id=uuidv7(),calls=[];
 const profile={user_id:id,admin_revision:0,disabled_at:'2026-09-01T00:00:00Z',soft_deleted_at:'2026-09-01T00:00:00Z',delete_due_at:'2026-10-01T00:00:00Z'};
 vi.stubGlobal('fetch',async(url,options)=>{
  const endpoint=new URL(url);expect(endpoint.host).toBe('admin-sweep.invalid');
  calls.push({path:endpoint.pathname,method:options.method,args:options.body?JSON.parse(options.body):null});
  if(endpoint.pathname==='/rest/v1/rpc/beta_issue_sweep') return Response.json(0);
  if(endpoint.pathname==='/rest/v1/rpc/builder_cleanup_expired_state') return Response.json(0);
  if(endpoint.pathname==='/rest/v1/rpc/list_admin_due_profiles') return Response.json([profile]);
  if(endpoint.pathname==='/rest/v1/rpc/write_admin_audit') return Response.json(uuidv7());
  if(endpoint.pathname==='/rest/v1/rpc/admin_claim_due_profile_deletion') return Response.json(true);
  if(endpoint.pathname==='/rest/v1/rpc/admin_delete_due_profile') return Response.json(true);
  // CASE-339: the same sweep nulls ended invitations' addresses after 30 days.
  if(endpoint.pathname==='/rest/v1/rpc/purge_abandoned_lobbies')return Response.json(0);
  if(endpoint.pathname==='/rest/v1/rpc/purge_invitation_addresses') return Response.json(0);
  if(endpoint.pathname===`/auth/v1/admin/users/${id}`&&options.method==='GET') return Response.json({id,email:'target@example.test'});
  if(endpoint.pathname===`/auth/v1/admin/users/${id}`&&options.method==='DELETE') return new Response(null,{status:204});
  throw Error('unexpected outbound call');
 });
 await worker.scheduled({cron:'47 * * * *'},{ADMIN_EMAILS:'admin@example.test',SUPABASE_URL:'https://admin-sweep.invalid/',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`},{waitUntil:()=>{}});
 expect(calls.map(x=>x.path)).toEqual(['/rest/v1/rpc/beta_issue_sweep','/rest/v1/rpc/builder_cleanup_expired_state','/rest/v1/rpc/list_admin_due_profiles',`/auth/v1/admin/users/${id}`,
  '/rest/v1/rpc/write_admin_audit','/rest/v1/rpc/admin_claim_due_profile_deletion',`/auth/v1/admin/users/${id}`,'/rest/v1/rpc/admin_delete_due_profile','/rest/v1/rpc/write_admin_audit','/rest/v1/rpc/purge_invitation_addresses','/rest/v1/rpc/purge_abandoned_lobbies']);
 expect(calls[0].args).toEqual({p_action:'purge',p_input:{deployment:'local'}});
 expect(calls.at(-1).args).toEqual({p_limit:200});
 expect(calls[1].args).toEqual({p_case_id:null});
 expect(calls[6].method).toBe('DELETE');
 expect(calls[5].args).toEqual({p_user_id:id,p_expected_revision:0,p_intent_id:calls[4].args.p_intent_id});
 expect(calls[2].args).toEqual({p_limit:100,p_after:null});
 expect(calls[4].args).toMatchObject({p_actor_email:'system@case.iatrogenic.app',p_from_prefix:null,p_phase:'intent'});
 expect(calls[8].args).toMatchObject({p_phase:'outcome',p_after:{status:'completed'}});
});
