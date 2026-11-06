---
doc: CASE-IT-NOTE
status: evolving
purpose: Candidate operational boundary; no live controller or settings are configured.
read_when: Reviewing the public software contract.
---

# IT NOTE

This is a private software preparation, not a deployed environment. Public CI uses credential-free ephemeral hosted Linux x64/ARM64, eleven browser shards including hosted performance, and the narrow real macOS Bash 3.2/Homebrew/Postgres lane. Private persistent runner controllers and operational records remain private.

Never dispatch, deploy, approve environments, change billing or global agent settings from this preparation. Future staging and production each require Julian's approval; agents cannot approve. Production recovery requires explicit authority. A bounded staging rollback is allowed only after its controller and failure paths have been separately qualified. No disclosure rollback can retrieve public copies. Tests use local Postgres, local workerd and fakes, never live services.
