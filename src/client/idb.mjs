/** No database or store is opened until a caller supplies its own factory. No personal data schema. */
export function reopenOnce(open) {
  let handle; let opening; let generation = 0;
  const current = async () => {
    if (handle) return handle;
    if (!opening) opening = Promise.resolve().then(open).then(db => { handle = db; return db; }).finally(() => { opening = null; });
    return opening;
  };
  return {
    async run(operation) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const db = await current(); const seen = generation;
        try { return await operation(db); }
        catch (error) {
          if (attempt || error?.name !== 'InvalidStateError') throw error;
          if (seen === generation) { generation++; try { handle?.close(); } catch { /* already closed */ } handle = null; }
        }
      }
    },
    async close() { if (opening) await opening; try { handle?.close(); } finally { handle = null; generation++; } },
  };
}
