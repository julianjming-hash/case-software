---
doc: CASE-PRIVACY-DATA-INVENTORY
status: evolving
purpose: Public technical privacy boundaries; private procurement records are not exported.
read_when: Reviewing the public software contract.
---

# DATA INVENTORY

Administrative audit retention is indefinite; participant and response data has its separate 24-hour purge. Operational copies and provider recovery history are separate from current-store deletion. Account deletion is Auth-first, with a thirty-day restore window; unresolved deletion claims require manual reconciliation. Cloudflare Durable Object PITR has a reported 30 days recovery window; deleteAll() erases the current store, not proven recovery-history erasure. post-deletion recovery-history erasure is unverified. The recovery-history compatibility remains unverified. PITR is unavailable in local development. DO recovery-history erasure after deleteAll and the seven-day contract: Not verified. This recovery-history boundary is unresolved before any pilot. These are software boundary statements, not an institutional procurement approval or a verified provider erasure receipt.

| Table | Column | Handling |
|---|---|---|
| `case_app.session_participants` | `id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_participants` | `session_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_participants` | `display_name` | Personal room archive; 24-hour participant purge. |
| `case_app.session_participants` | `token_sha256` | Personal room archive; 24-hour participant purge. |
| `case_app.session_participants` | `joined_at` | Personal room archive; 24-hour participant purge. |
| `case_app.session_participants` | `removed_at` | Personal room archive; 24-hour participant purge. |
| `case_app.session_participants` | `purged_at` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `session_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `round_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `participant_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `response` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `last_client_event_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `first_submitted_at` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `last_submitted_at` | Personal room archive; 24-hour participant purge. |
| `case_app.session_responses` | `source_response_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `session_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `seq` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `event_id` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `epoch` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `kind` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `payload` | Personal room archive; 24-hour participant purge. |
| `case_app.session_events` | `occurred_at` | Personal room archive; 24-hour participant purge. |
| `case_app.admin_audit_log` | `id` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `intent_id` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `phase` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `action` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `target_type` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `target_id` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `actor_email` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `before` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `after` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `at` | Administrative audit, indefinite retention. |
| `case_app.admin_audit_log` | `from_prefix` | Administrative audit, indefinite retention. |

Profile lifecycle: `case_app.profiles.disabled_at`, `case_app.profiles.soft_deleted_at`, `case_app.profiles.delete_due_at`, `case_app.profiles.admin_revision`, `case_app.profiles.admin_delete_claim_id`, `case_app.profiles.admin_delete_claimed_at`.

- `case:auth:refresh`: browser-local state, covered by teardown.
- `case:auth:pkce`: browser-local state, covered by teardown.
- `case:transport:pin`: browser-local state, covered by teardown.
- `case:appearance`: browser-local state, covered by teardown.
- `case:audio:music-volume`: browser-local state, covered by teardown.
- `case:audio:effects-volume`: browser-local state, covered by teardown.
- `case:preferences:ui-tones`: browser-local state, covered by teardown.
- `case:preferences:timeline-collapsed`: browser-local state, covered by teardown.
- `case:preferences:motion`: browser-local state, covered by teardown.
- `case:preferences:console-split`: browser-local state, covered by teardown.
- `case:console:timer-seconds`: browser-local state, covered by teardown.
- `case:storage:fence`: browser-local state, covered by teardown.
- `case:privacy-return-search`: browser-local state, covered by teardown.
- `case:phone:join-code-draft`: browser-local state, covered by teardown.
- `case:console:active-room`: browser-local state, covered by teardown.
- `case-lab:segment:`: browser-local state, covered by teardown.
- `case:phone-outbox`: browser-local state, covered by teardown.
- `case-shell-`: browser-local state, covered by teardown.
- `case:<role>:<slot>:token`: browser-local state, covered by teardown.
- `case-lab:<role>:<slot>:token`: browser-local state, covered by teardown.
- `case-lab:segment:<sessionId>`: browser-local state, covered by teardown.
- `^case:(?:(?:participant|display|facilitator):[^:]+:token|feedback:[^:]+:key|finish:[^:]+:saved)$`: browser-local state, covered by teardown.
- `^case:join-code-draft:[^:]+$`: browser-local state, covered by teardown.
- `^case-lab:segment:[^:]+$`: browser-local state, covered by teardown.
- `^case-lab:(?:participant|display|facilitator):[^:]+:token$`: browser-local state, covered by teardown.

A pending PKCE exchange expires after 10 minutes. Explicit preference state persists until Sign out. Resume state supports same-room recovery only to its original expiry. Transient state is cleared at sign-out and room end. Private facilitator material is not promoted to persistent caches.


## Beta issues — implemented source, software contract; deployment separately qualified (CASE-376)

Private beta_issues stores UUID/reference, derived principal, optional account/session binding, incident class, exact-operation digest, original bounded report/opt-in diagnostics/contact consent, title, reviewed nonpersonal summary, triage/revision/timestamps, duplicate link and evidence-purge time. beta_issue_files stores private object key, UUID, MIME, digest, size and storage receipt; screenshots live in private R2. beta_issue_events stores dated actions and bounded internal/public follow-up text. beta_issue_deletes durably retries object deletion; beta_issue_sweep_state stores the bounded orphan-list cursor. No client grants, public guest reporting or external notifications.

Unresolved evidence remains; resolution+30d deletes evidence. Participant evidence and all identity/resource/operation associations obey session end/expiry+24h, including derived title and copied prose. A separately reviewed nonpersonal summary may survive the participant cutoff until resolution+30d. Deadline authorization is immediate; scheduled SQL/object cleanup retries bounded pages. Original evidence never enters indefinite administrative audit. Drafts/native blobs/previews exist only in browser memory until Send and clear on identity/capability/page teardown. Native screenshot pixels have no privacy filters; optional structured diagnostics use a strict allowlist. Deployment configuration/physical retention qualification remains a release-owner step.
