---
doc: CASE-CONVENTIONS
status: living
purpose: Naming and path rules for every file, folder, id, URL, and commit in Case. `npm run check` enforces the machine-checkable parts.
read_when: Before creating, renaming, or moving any file in Case, or writing a path, id, or URL into a doc.
---

# Case conventions

## Folder map

```text
Case/
├── README.md                      entry point
├── AGENTS.md, CLAUDE.md           shared agent contract (Claude + Codex) · Claude import shim
├── .github/workflows/             CI (verify on every PR and push to main)
├── .claude/settings.json          Claude Code project permissions: denies production dispatch, local deploys and secret writes
├── docs/                          living docs (UPPER-KEBAB.md)
│   ├── red-team/                  review packet + dated reviews
│   ├── research/                  dated research syntheses
│   ├── pilot/                     operator guides, device/metering sheets and frozen dated debrief records
│   ├── teaching-cases/            private native case pairs, derived transfers and review evidence
│   └── plans/                     dated stage plans and agent briefs
├── prototypes/                    static HTML explorations (lower-kebab.html) + README status table
│   ├── design/                    shared token, component and mosaic-study sources for design-system.html and surface-design.html (lower-kebab.mjs|css)
│   └── room/                      stage C multi-window room mockups (lower-kebab.html), the shell service worker (lower-kebab-sw.mjs) + lib/ (lower-kebab.mjs|css)
├── db/
│   ├── supabase/migrations/       Postgres migrations (Supabase CLI layout)
│   ├── public/                       HTML/manifest shell sources, icons/ (the favicon) + fonts/, avatars/ and audio/ (on-demand room cue WAVs, never precached) vendors
├── dist/                         generated hashed assets, service worker and platform header/route rules (git-ignored)
├── tests/                     SQL assertions + local Supabase stub
│   └── durable-object/            live-room SQLite schema
├── src/
│   ├── shared/                   runtime contracts shared by Worker, Durable Object and clients
│   ├── client/                   browser surfaces, transport, shell/SW helpers and styles (lower-kebab.mjs|css)
│   ├── worker/                   Worker routes and Durable Objects
│   └── fixtures/                 approved local case fixture
├── tests/                         node --test tests and test-only harness support
├── e2e/                           Playwright specifications
└── scripts/                       Case tooling (hygiene/spec generation, local test servers, DB assertions, operations)
```

A new top-level folder under `Case/` needs a row in this map and in `scripts/check-case.mjs` `RULES`.

The exact third-party licence packet is `licenses/lucide-static-1.59.0-package-LICENSE.txt`; this folder admits that named notice only.

## File names

| Kind | Pattern | Example |
|---|---|---|
| Living doc (one per concern, edited in place) | `UPPER-KEBAB.md` | `ARCHITECTURE.md` |
| Dated artefact (review, research, audit; written once) | `YYYY-MM-DD-lower-kebab.md` | `2026-09-30-red-team-review.md` |
| Monthly surface audit (handoff track) | `YYYY-MM-surface-audit.md` under private historical reference (not distributed), `status: evolving` while the track runs | private historical reference (not distributed) |
| Folder index | `README.md` | `prototypes/README.md` |
| Hospital procurement pack | `UPPER-KEBAB.md` (plus `README.md`) under private historical reference (not distributed) | private historical reference (not distributed) |
| Codex task card (CASE-124) | `NN-lower-kebab.md` in private historical reference (not distributed), indexed by its `README.md`; may name files it will create | private historical reference (not distributed) |
| Card screenshot evidence | `lower-kebab.png` in a card-numbered screenshots folder under private historical reference (not distributed), linked from the card's PR | private historical reference (not distributed) |
| Builder acceptance artifacts | `lower-kebab.json` or `lower-kebab.txt` only in private historical reference (not distributed); private review inputs, never public build assets | private historical reference (not distributed) |
| Private teaching cases | `<case>.document.json`, `<case>.metadata.json`, `<case>.transfer.json`, `<case>.evidence.json` under private historical reference (not distributed); canonical schemas only; review docs `UPPER-KEBAB.md`/`README.md`, screenshots `screenshots/lower-kebab.png`; never public build assets | private historical reference (not distributed) |
| Drawn teaching-case figures | `docs/teaching-cases/figures/<kebab>.svg`, the `.png` rendered from it for upload, and the `<kebab>.mjs` that draws them; figures come from the case's own numbers | private historical reference (not distributed) |
| Code module | `lower-kebab.mjs` (ES module) | `ids.mjs` |
| Unit test | `<module>.test.mjs` | `ids.test.mjs` |
| Test-only harness support | `<module>.mjs` under `tests/` or a lower-kebab subfolder | `playwright-harness.mjs` |
| Playwright specification | `<module>.spec.mjs` under `e2e/` | `room-lab.spec.mjs` |
| Media test fixture (card 59) | `<name>.jpg` or `<name>.png` under `tests/fixtures/media/` | `clean-64x48.jpg` |
| Postgres migration | `YYYYMMDDHHMMSS_snake_case.sql` (Supabase CLI requires it) | `20261001000000_case_init.sql` |
| SQL test | `lower-kebab.test.sql` named after its migration | `case-init.test.sql` |
| Client stylesheet | `lower-kebab.css` under `src/client/` | `shell.css` |
| Public shell | `lower-kebab.html` / `lower-kebab.webmanifest` under `public/`; the favicon `icons/case.svg`; vendors under `fonts/`, `avatars/` and `audio/` (lower-kebab `.wav`, manifest, `LICENSE.txt`); `audio/room-music/` contains exactly the approved round8 library (lower-kebab `.mp3`, CASE-333/334), its manifest and licence | `check.html` |
| Room sound design (Card 69) | private historical reference (not distributed), `directions.html`, `stage.mjs`, `stage.css`, `lab.mjs`, `lab.css`, `engine.mjs`, `manifest.json`, `LICENSE.txt`; lower-kebab WAV/MP3/JSON/TXT under `assets/` and `sources/`; generators `scripts/sound/*.mjs`; JSON/TXT/PNG review evidence under private historical reference (not distributed) | private historical reference (not distributed) |
| Email artwork and hosted template candidates | Content-versioned `<12-hex-sha256-prefix>.jpg` under `public/email/`; generated lower-kebab `.html` and `.txt` under `docs/email-templates/`; rebuild using `scripts/build-emails.mjs` | `docs/email-templates/magic-link.html` |
| Prototype | `lower-kebab.html`, no `sim-` prefix | `synchronisation-lab.html` |
| Service worker | `lower-kebab-sw.mjs` beside the pages it controls (its scope is its folder) | `prototypes/room/shell-sw.mjs` |
| Script | `lower-kebab.mjs` or `.sh` | `check-case.mjs` |
| Native macOS runner peer inspector | Exact `scripts/case-macos-peer.c` only; kernel-authenticated peer/process identity for the isolated VM controller | `case-macos-peer.c` |
| Disposable Linux reset validation | Exact `scripts/linux-idle-canary.py` and `tests/helpers/linux-idle-canary.py` only; Python 3.9+ standard library, mandatory offline bridge in private historical reference (not distributed); no general Python-file allowance | `linux-idle-canary.py` |
| Development audit exceptions | Exact root filename `audit-allowlist.json`; dated exceptions validated by card 18 tooling | `audit-allowlist.json` |
| Vendored avatar (CASE-120) | `lower-kebab.svg` in the room prototype's `lib/avatars/` folder, generated once by `scripts/gen-avatars.mjs` | `shadows-01.svg` |
| Self-hosted font (CASE-112) | `lower-kebab.woff2` in the room prototype's `lib/fonts/` folder, each family beside its licence `ofl-<family>.txt` | `montserrat-latin.woff2`, `ofl-montserrat.txt` |

**General rules:**
- ASCII only: no spaces, no accents.
- Lower-case extensions.
- Underscores only in migration names.
- Folders are `lower-kebab`. `Case/` itself is the product's proper name.
- Never rename a migration once applied anywhere.
- Superseded living docs move to `docs/archive/<NAME>.md` (create the folder when first needed) with `status: superseded`. <!-- removal-stamp-exempt: generic rule: document lifecycle policy -->

## Doc headers

Current-doc hygiene requires same-line dates for documented retirements. Quoted examples and transient room states are exempt; a generic lifecycle policy uses `<!-- removal-stamp-exempt: generic rule: reason -->` with a nonempty reason.

Every `.md` under `Case/` starts with YAML front matter:

```yaml
---
doc: CASE-<UPPER-KEBAB>       # unique id; matches the filename for living docs
status: living | evolving | stable | frozen | superseded
purpose: one sentence
read_when: one sentence
---
```

- **Dated artefacts** are `status: frozen`. Fix typos only; new findings go in a new dated file.
- **No date field.** Git owns currency: `git log -1 --format=%cd <file>`.

## Paths in docs

Case is its own git repository. On the Mac it sits beside the iatrogenic checkout, not inside it.

- **In prose, use paths relative to the Case root, in backticks**, for example `docs/HANDOFF.md`. Never use `./` or `../` in prose, because they break when text is quoted elsewhere.
- **Markdown links use relative paths**, so they work on GitHub and in editors. `npm run check` verifies they resolve.
- **Links to iatrogenic files use full GitHub URLs** (`https://github.com/julianjming-hash/iatrogenic/blob/main/…`), never `../iatrogenic/…`, because the Case repo must stand alone.
- **Absolute machine paths** belong only in the path-roots homes named by `AGENTS.md`. The canonical table lives there; a machine move is a one-table edit.

The single [path-roots table is in AGENTS.md](../AGENTS.md#path-roots). Verification commands are in its [Gates section](../AGENTS.md#gates).

## Identifiers and URLs

The full rules are in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6–7. In short:
- **UUIDv7, lower case**, for every row and document item.
- **Crockford base32, upper case**, for human and QR codes.
- **QR URLs** are `/J/`, `/D/` and `/P/` short paths, upper case.
- **No personal data or tokens in any URL.** Build URLs only through `src/shared/urls.mjs`.

## Decisions and commits

- **Decisions** get the next `CASE-NNN` id in `docs/DECISIONS.md`. Append only; supersede rather than edit.
- **Commit subject:** `case(<area>): <imperative summary>`, where the area is one of `docs`, `db`, `shared`, `runtime`, `builder`, `proto`, `tooling`, `client`, `ops`, or `ci`. Example: `case(db): add session archive RPC`.
- **Branch names:** `<type>/<short-kebab-slug>`, as defined in `AGENTS.md` §Parallel-git protocol. Agents are named in the PR, not the branch; cloud sessions use the branch they are given.

The Card26 browser matrix uses the exact root configuration `playwright.devices.config.mjs`; its spec remains in `e2e/` under the ordinary lower-kebab naming rule. private historical reference (not distributed) and private historical reference (not distributed) are living operator sheets.
