---
doc: CASE-PRIVACY-DATA-FLOW
status: evolving
purpose: Public technical privacy boundaries; private procurement records are not exported.
read_when: Reviewing the public software contract.
---

# DATA FLOW

Administrative audit retention is indefinite; participant and response data has its separate 24-hour purge. Operational copies and provider recovery history are separate from current-store deletion. Account deletion is Auth-first, with a thirty-day restore window; unresolved deletion claims require manual reconciliation. Cloudflare Durable Object PITR has a reported 30 days recovery window; deleteAll() erases the current store, not proven recovery-history erasure. post-deletion recovery-history erasure is unverified. The recovery-history compatibility remains unverified. PITR is unavailable in local development. DO recovery-history erasure after deleteAll and the seven-day contract: Not verified. This recovery-history boundary is unresolved before any pilot. These are software boundary statements, not an institutional procurement approval or a verified provider erasure receipt.



## Beta issue path — software contract; deployment separately qualified (5 November 2026, CASE-376)

A signed-in account or current participant capability opens the issue reporter. The browser’s native picker produces one unfiltered still in local memory; no report/screenshot leaves before Send. The Worker verifies account state or the room credential, derives deployment/principal scope and calls service-only issue RPCs. Postgres stores report/receipt/triage data; private MEDIA R2 stores validated PNG/JPEG bytes. Both queue and storage cleanup are deployment-scoped. Reporters read their own public projection; deployment administrators read ordinary issues; only the separately designated current deployment administrator reads restricted incidents. Manual reviewed clipboard export is explicit. No new scanner service, automatic AI send or external incident notification.
