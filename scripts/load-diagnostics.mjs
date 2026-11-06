// Numeric-only client timing evidence. No command body, capability, authored text or event ID leaves this ledger.
import { performance } from 'node:perf_hooks';
export function voteDiagnostics(now = () => performance.now()) {
  const votes = new Map();
  const duration = (start, end) => Math.max(0, end - start);
  return {
    begin(id, phone, round) {
      if (![phone, round].every(Number.isSafeInteger) || phone < 0 || round < 1) throw Error('load_diagnostic_ordinal');
      votes.set(id, { phone, round, start: now(), attempts: [] });
    },
    attempt(id) {
      const vote = votes.get(id);
      if (!vote) throw Error('load_diagnostic_vote_missing');
      const entry = { start: now(), headers: null, inspected: null, end: null, status: null, aborted: false, failed: false };
      vote.attempts.push(entry);
      return {
        headers(status) { entry.headers = now(); entry.status = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null; },
        inspected() { entry.inspected = now(); },
        finish({ aborted = false, failed = false } = {}) { entry.end = now(); entry.aborted = aborted === true; entry.failed = failed === true; },
      };
    },
    receipt(id) { const vote = votes.get(id); if (!vote) throw Error('load_diagnostic_vote_missing'); vote.received = now(); },
    report() {
      return [...votes.values()].map(vote => {
        const last = vote.attempts.at(-1);
        return {
          phone: vote.phone, round: vote.round,
          elapsed_ms: vote.received === undefined ? null : duration(vote.start, vote.received),
          receipt_tail_ms: vote.received === undefined || last?.end == null ? null : duration(last.end, vote.received),
          attempts: vote.attempts.map(entry => ({
            headers_ms: entry.headers === null ? null : duration(entry.start, entry.headers),
            inspection_ms: entry.inspected === null || entry.headers === null ? null : duration(entry.headers, entry.inspected),
            elapsed_ms: entry.end === null ? null : duration(entry.start, entry.end),
            status: entry.status, aborted: entry.aborted, failed: entry.failed,
          })),
        };
      });
    },
  };
}
