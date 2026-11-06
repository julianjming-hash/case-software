---
doc: CASE-README
status: evolving
purpose: Standalone software, technical contracts and synthetic verification inputs.
read_when: Before using or reviewing this software.
---

# Case software

Case is facilitator-led educational decision theatre. This software tree uses fresh history and self-contained compatibility inputs. Original clinical/teaching source, participant records, private procurement, pilot and research records, and old repository history are excluded.

Software, technical documentation and reusable interface styles use MIT terms. Newly authored synthetic fixture text uses CC0 as identified by adjacent licences. Names and logos are reserved; third-party assets retain their actual notices. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Publication admits only reviewed inputs; a public copy does not grant trademark rights or make the software clinical advice.

Use Node 22.5 or newer and plain `npm ci`. Run `npm run verify` for technical checks, unit/property coverage, real local workerd/SQLite and throwaway Postgres. CI requires database execution; do not accept a local missing-Postgres skip as database qualification. Run `npm run test:e2e`, `npm run test:devices` and `npm run test:load-gates` for the separate browser, recovery and performance gates. Test code uses local services, never a live provider account. The bundled legacy baseline needs no private origin or credentials.

Linux x64/ARM64, hosted x64 performance and the narrow real Mac/Bash3.2/Homebrew Postgres lane have separate purposes. Preserve all selected gates. A local pass is not a hosted, deployed or physical-device receipt.

Read [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [permissions](docs/PERMISSIONS.md), [acceptance scenarios](docs/ACCEPTANCE-SCENARIOS.md) and the [canonical interface contract](prototypes/design-system.html). [SECURITY.md](SECURITY.md) defines private reporting. Source publication, software source-of-truth cutover and deployed service promotion are separate milestones. Deployments require the qualified controller and Julian's separate approval for staging and production; agents never approve environments.
