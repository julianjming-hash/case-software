// Server-only authoritative account cutoff. Unknown authority never becomes active access.
export async function accountActive(rpc,userId) {
 try {
  const result=await rpc.call('admin_account_active',{p_user_id:userId});
  if (!result?.ok || typeof result.data !== 'boolean') return {error:'auth_unavailable',status:503};
  return result.data ? null : {error:'forbidden',status:403};
 } catch { return {error:'auth_unavailable',status:503}; }
}
