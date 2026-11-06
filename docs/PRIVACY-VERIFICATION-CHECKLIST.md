---
doc: CASE-PRIVACY-VERIFICATION-CHECKLIST
status: evolving
purpose: Public technical privacy boundaries; private procurement records are not exported.
read_when: Reviewing the public software contract.
---

# VERIFICATION CHECKLIST

Administrative audit retention is indefinite; participant and response data has its separate 24-hour purge. Operational copies and provider recovery history are separate from current-store deletion. Account deletion is Auth-first, with a thirty-day restore window; unresolved deletion claims require manual reconciliation. Cloudflare Durable Object PITR has a reported 30 days recovery window; deleteAll() erases the current store, not proven recovery-history erasure. post-deletion recovery-history erasure is unverified. The recovery-history compatibility remains unverified. PITR is unavailable in local development. DO recovery-history erasure after deleteAll and the seven-day contract: Not verified. This recovery-history boundary is unresolved before any pilot. These are software boundary statements, not an institutional procurement approval or a verified provider erasure receipt.

