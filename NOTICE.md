---
doc: CASE-NOTICE
status: living
purpose: What the MIT licence covers and what it does not (clinical and teaching content, internal records, names and branding), and the third-party material vendored into Case with each item's licence and required attribution.
read_when: Adding, updating or removing a vendored font, image or other third-party file, or answering a licensing question.
---

# Third-party notices

## What the MIT licence covers

MIT covers the original software, technical documentation and reusable interface styles. Case and iatrogenic names, logos and marks are reserved. No trademark permission is granted.

Newly authored synthetic workshop fixture text is CC0-1.0 as identified by adjacent licence files. This does not dedicate third-party schema, assets, or historical source material. Clinical source material and private teaching, pilot, procurement and research records are excluded from the intended public repository. Only individually vetted small clinical test examples may be included in an admitted publication. New examples require fresh owner review.

Permission to disclose and permission to license for reuse are separate gates. First-party ownership declarations do not waive third-party terms, personal-data confidentiality or metadata review. Exclude unknown inputs; keep dated admission and provenance records separately. Original audio and third-party assets keep their separate notices below.

## Third-party files

These files come from elsewhere and keep their own licences. Every item is a static file served from Case's own origin: no page fetches it from the third party at runtime, so no participant's address reaches them.

| Material | Files | Source | Licence | Attribution required |
|---|---|---|---|---|
| **DiceBear "Shadows" avatar style**, 16 avatars rendered once with `@dicebear/core` 10.7.0 and `@dicebear/styles` 10.6.0 (`scripts/gen-avatars.mjs`, CASE-120) | `prototypes/room/lib/avatars/shadows-01.svg` … `shadows-16.svg` | [dicebear.com](https://www.dicebear.com), style definition [src/shadows.json](https://github.com/dicebear/styles/blob/main/src/shadows.json), artist DiceBear | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public-domain dedication) | None. Credited here as a courtesy: "Shadows" (https://www.dicebear.com) by "DiceBear", licensed under "CC0 1.0". Each SVG keeps this in its `<metadata>`. |
| DiceBear generator libraries (`@dicebear/core`, `@dicebear/styles`), used at dev time only, not shipped | none in the repo | [github.com/dicebear/dicebear](https://github.com/dicebear/dicebear) | Code MIT; each style carries its own licence (Shadows: CC0 1.0) | Not distributed, so none. |
| **Montserrat** (variable, weights 400–700; latin and latin-ext subsets), CASE-112 | `prototypes/room/lib/fonts/montserrat-latin.woff2`, `prototypes/room/lib/fonts/montserrat-latin-ext.woff2`; licence text `prototypes/room/lib/fonts/ofl-montserrat.txt` | [Google Fonts](https://fonts.google.com/specimen/Montserrat), by Julieta Ulanovsky and the Montserrat Project Authors | [SIL Open Font License 1.1](https://openfontlicense.org) | Keep the copyright and licence notice with the font: "Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git)", licensed under the SIL Open Font License, Version 1.1. The font may not be sold by itself. |
| **JetBrains Mono** (variable, weights 500–700; latin subset), for codes and vital-sign numerals | `prototypes/room/lib/fonts/jetbrains-mono-latin.woff2`; licence text `prototypes/room/lib/fonts/ofl-jetbrains-mono.txt` | [Google Fonts](https://fonts.google.com/specimen/JetBrains+Mono), by JetBrains | [SIL Open Font License 1.1](https://openfontlicense.org) | "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)", licensed under the SIL Open Font License, Version 1.1. |
| **Noto Sans** Regular, Greek subset (81 code points: µ, U+0384–038A, U+038C, U+038E–03A1, U+03A3–03CE, ϐ ϑ ϒ ϕ ϖ ϰ ϱ ϵ), for Greek in PDF records only | `public/fonts/noto-sans-greek.woff2`; licence text `public/fonts/ofl-noto-sans.txt` | [notofonts](https://github.com/notofonts/latin-greek-cyrillic), by the Noto Project Authors; see §Greek PDF font for the pinned source | [SIL Open Font License 1.1](https://openfontlicense.org) | "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)", licensed under the SIL Open Font License, Version 1.1. "Noto is a trademark of Google LLC." |
| **Lucide icons**, 24 icons from `lucide-static` 1.59.0 (released 2026-10-17), node data copied unchanged from its `icon-nodes.json` (CASE-344); also the `split` branch badge (CASE-313) | `src/shared/icons.mjs`; `BRANCH_ICON_PATH` in `src/shared/decision-branches.mjs` | [lucide.dev](https://lucide.dev), [github.com/lucide-icons/lucide](https://github.com/lucide-icons/lucide); some icons derive from [Feather](https://github.com/feathericons/feather) (MIT) | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE); the Feather-derived icons MIT | Keep the notice: "ISC License, Copyright (c) 2026 Lucide Icons and Contributors" with the ISC permission notice; for the Feather-derived ones, "The MIT License (MIT), Copyright (c) 2013-present Cole Bemis". |

The served shell keeps identical vendored font binaries, licence texts and inert avatar SVGs in `public/fonts/` and `public/avatars/`. `scripts/build-client.mjs` copies and hashes these into `dist/assets/`; no runtime third-party font or avatar request is added.

## Updating

- **Avatars:** never call the DiceBear HTTP API from a page. Regenerate with `npm i --no-save @dicebear/core@10.7.0 @dicebear/styles@10.6.0 && node scripts/gen-avatars.mjs`, check the result, and commit the files. The ids in `src/shared/participant.mjs` (`AVATARS`) are stable: a stored room refers to them, so never reuse an id for a different drawing. `tests/avatars.test.mjs` checks the set, the licence metadata and that each file is inert SVG.
The shared runtime/Studio interface also vendors twenty-five exact icons from the same `lucide-static` 1.59.0 release in `src/client/ui-icons.mjs`, re-exported by `prototypes/design/studio-icons.mjs`, under the same ISC notice. These are presentation-only icons, not additional saved callout keys.

- **Icons:** never load Lucide from a CDN or add it as a dependency. `npm pack lucide-static@<exact version, at least two weeks old>` into a fresh directory outside the repo, copy the needed entries of `icon-nodes.json` into `src/shared/icons.mjs` unchanged, and update `LUCIDE_VERSION` and this table. A saved callout names its icon by Case's own key, so renaming the Lucide source never changes a case; `tests/callout-icons.test.mjs` checks the set.
- **Fonts:** download the `woff2` files once from Google Fonts (the `css2` API lists the current file URLs) and commit them. Pages load them from `prototypes/room/lib/tokens.css` or its shipped snapshot `src/client/tokens.css`, never from `fonts.googleapis.com`.

## PDF font instance (CASE-200)

`src/client/session-pdf-font.mjs` embeds a static weight400 TrueType instance derived from the existing `public/fonts/montserrat-latin.woff2`, under the same [Montserrat OFL](public/fonts/ofl-montserrat.txt). The original font name and copyright/licence records remain in the binary. This is private lazy PDF data, never a remote request or a new runtime dependency.

The same module carries **CaseSymbols**, a small fallback TrueType subset the writer embeds only when a record uses one of its characters. It is derived only from the bundled fonts, under their OFL licences ([Montserrat](public/fonts/ofl-montserrat.txt), [JetBrains Mono](public/fonts/ofl-jetbrains-mono.txt)): JetBrains Mono's arrow and comparison glyphs (← → ↔ ⇒ ⇔ ≠ ≤ ≥), ≈ built from two Montserrat tildes, and ✓ ✔ ✗ ✘ stroked at Montserrat's stem width. It is renamed (no Reserved Font Name applies to either source), and its name table keeps both copyright notices, the OFL 1.1 licence description and the licence URL. The writer also maps Montserrat's own unmapped Greek mu glyph to U+03BC μ.

Two script subsets are cut from committed files by the same generator, each embedded as its own font only when a record uses it: Latin Extended-A (U+0100–017F, plus Ș ș Ț ț † ℓ) from `public/fonts/montserrat-latin-ext.woff2` at weight 400, under the Montserrat OFL, and Greek from `public/fonts/noto-sans-greek.woff2`, under the Noto OFL. Each keeps only the code points the primary font lacks, and the original copyright and licence name records.

Regenerate with `node scripts/gen-session-pdf-font.mjs` using a development Python environment containing fonttools4.66.1 and brotli1.2.0. The generator never downloads a font. It retains the source font timestamp for deterministic output, serializes glyph IDs/advance widths and preserves the original licence. Characters in no embedded font (for example Cyrillic, CJK, emoji) refuse PDF generation with an explicit HTML/JSON fallback, without substitution. Re-run size and real PDF rendering/text-extraction checks after regeneration.

## Greek PDF font (Julian, 2026-10-17)

`public/fonts/noto-sans-greek.woff2` is a subset of Noto Sans Regular, version 2.015 (name table: `2.015;GOOG;NotoSans-Regular`), downloaded once with the owner's approval and never fetched at runtime or by a script:

- Font: `https://raw.githubusercontent.com/notofonts/notofonts.github.io/28b15b4b43b7bed62b5cf6e6b0b5ff5846270535/fonts/NotoSans/unhinted/ttf/NotoSans-Regular.ttf` (official Noto distribution, commit `28b15b4b43b7bed62b5cf6e6b0b5ff5846270535`), 431,364 B, sha256 `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8`. The full TTF is not committed.
- Licence: `https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/4bc63d7ebca1faed49c6c685f380ba0abc2c1941/OFL.txt` (commit `4bc63d7ebca1faed49c6c685f380ba0abc2c1941`), sha256 `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a`, committed unchanged as `public/fonts/ofl-noto-sans.txt`.
- Subset (fonttools 4.66.1): `pyftsubset NotoSans-Regular.ttf --unicodes="U+00B5,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03CE,U+03D0-03D2,U+03D5-03D6,U+03F0-03F1,U+03F5" --layout-features='' --no-hinting --name-IDs='*' --name-legacy --name-languages='*' --notdef-outline --flavor=woff2`, giving 4,604 B, sha256 `91c28dc813f80dc0193489aff0ff5bdc37c7d7df4ea5dd9e33fdcad02c7626d7`. All name records, including the copyright, licence and trademark notices, are kept.

Like every file in `public/fonts/`, the build copies and hashes it into `dist/assets/` and the service worker precaches it, although no page stylesheet uses it.

## Complete vendored notices

The exact Lucide 1.59.0 package licence, including its Feather attribution, accompanies this source in [the package licence](licenses/lucide-static-1.59.0-package-LICENSE.txt). The sample provenance references preserve their [VCSL licence](prototypes/sound-stage/sources/vcsl-license.txt) and [Karoryfer licence](prototypes/sound-stage/sources/karoryfer-license.txt). These notices do not clear Case-authored work or disclosure rights.

Every generated static distribution includes `third-party-notices.txt`, carrying the complete Lucide/Feather and bundled font licence texts from fixed build-tool inputs. It is served as a static notice, outside the executable route graph and service-worker shell; no existing client budget is changed. The legacy source archive retains its own pinned provenance and is distributed alongside this enclosing notice packet.
