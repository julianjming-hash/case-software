// A manual segment is replay-safe under its stable segment ID. A timeout keeps
// exactly the same body for an explicit retry; a 409 keeps local notes available.
export function createManualRecovery(manual, upload) {
  let body = null, refused = false, inFlight = null;
  return {
    get pending() { return body !== null; },
    get refused() { return refused; },
    resume() {
      if (refused) return Promise.resolve({ kind: 'refused' });
      if (inFlight) return inFlight;
      if (!body) {
        if (!manual.view().actions?.includes('resume_online'))
          return Promise.resolve({ kind: 'not_ready' });
        const receipt = manual.command('resume_online');
        if (receipt.receipt !== 'accepted') return Promise.resolve({ kind: 'not_ready' });
        body = manual.segmentBody();
      }
      inFlight = (async () => {
        let result;
        try { result = await upload(body); } catch { return { kind: 'retryable' }; }
        if (result?.status === 200 && result.body?.ok === true) {
          manual.forget(); manual.close(); body = null;
          return { kind: 'applied' };
        }
        if (result?.status === 409) { refused = true; return { kind: 'refused' }; }
        return { kind: 'retryable' };
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
