---
doc: CASE-SECURITY
status: evolving
purpose: Private reporting and disclosure boundary for the software candidate.
read_when: Reporting or assessing a possible vulnerability.
---

# Security reporting

Do not post vulnerabilities, clinical material, credentials, raw logs or screenshots publicly. Use GitHub's Security tab and its private Report a vulnerability channel when available. The maintainer must enable and verify that private channel before source-of-truth cutover; if it is unavailable, keep details private and request a private route without posting the finding. Julian owns intake, triage and response; no response-time commitment is claimed. Track affected versions and remediation privately before deciding any public advisory.

Report a possible credential by file location and remediation owner only. Do not repeat its value, test it against a provider, or assume it is harmless. Active or uncertain credentials need owner-led rotation/revocation and exposure review under separate authority. Removing a file or reverting visibility cannot retrieve public copies.

Run untrusted changes only in credential-free ephemeral hosted runners. Do not use the Mini, persistent privileged hosts, private content or release credentials. The legacy bundle is a software-only compatibility input with integrity witnesses, with pinned provenance and required enclosing third-party notices; changes require fresh disclosure/redistribution review. Deployment and production recovery require separate explicit owner authority.
