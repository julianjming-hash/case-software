// Nonpersonal deletion generation; never a credential, room identifier or browser permission.
export const STORAGE_FENCE_KEY='case:storage:fence';
export function storageGeneration(storage) {
  const value=storage?.getItem(STORAGE_FENCE_KEY);
  if(value==null)return 0;
  if(!/^(0|[1-9][0-9]{0,15})$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error('Invalid storage generation');
  return Number(value);
}
export function advanceStorageGeneration(storage) {
  if(!storage)return;
  const next=storageGeneration(storage)+1;
  if(!Number.isSafeInteger(next))throw new Error('Storage generation exhausted');
  storage.setItem(STORAGE_FENCE_KEY,String(next));
}
