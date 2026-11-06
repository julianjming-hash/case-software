---
doc: CASE-SETUP-SECRETS
status: evolving
purpose: Binding-name contract; no credential values or implementation authority.
read_when: Reviewing the software candidate.
---

# Deployment binding contract

This candidate is not deployment-configured. All committed hosts and identities are inert examples. A future owner-approved private controller supplies per-environment credentials; public PR CI has none. Local tests use ephemeral fakes and never contact providers.

- `SUPABASE_SECRET_KEY`: per-environment secret binding; never commit a value.
- `STEPUP_SECRET`: per-environment secret binding; never commit a value.
- `DEPLOY_GUARD_TOKEN`: per-environment secret binding; never commit a value.
- `TURNSTILE_SECRET_KEY`: per-environment secret binding; never commit a value.
- `ALERT_EMAIL_TO`: per-environment secret binding; never commit a value.
- `RESEND_ALERT_API_KEY`: per-environment secret binding; never commit a value.
- `HEALTHCHECK_PING_URL`: per-environment secret binding; never commit a value.
- `RESEND_INVITE_API_KEY`: per-environment secret binding; never commit a value.
