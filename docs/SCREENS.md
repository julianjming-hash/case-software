---
doc: CASE-SCREENS
status: living
purpose: Per-role, per-phase screen spec for the facilitator console, projector display and participant phone, derived from the room-machine projections.
read_when: Building or reviewing any Case client screen or prototype.
---

# Case screens

## How to read this

- Every screen renders **only** its role's `project()` output from `src/shared/room-machine.mjs`. It never infers a phase from controls it can see, and never reads another role's projection.
- Field names in backticks (`phase`, `liveSurface`, `decision.status`) are projection fields. A name that is not a projection field is called out as client-local or listed under [Spec gaps](#spec-gaps).
- The facilitator projection carries the canonical phase (`lobby` ... `ended`). The display and participant projections carry a **public phase**: `waiting`, `live`, `decision_open`, `reviewing`, `teaching`, `paused`, `ended`. Two pairs of canonical phases collapse into one public phase each: `surface_live` and `consequence_revealed` both read `live`; `responses_locked` and `path_selected` both read `reviewing`. A display or phone subsection for a collapsed phase says so, and the two must look identical, because a phone or projector must not learn that a route has been chosen before it is revealed.
- The facilitator console renders only the commands listed in `actions` (from `facilitatorActions`). A command not in `actions` is absent, not disabled. Display privacy advice never blocks `Start case` (Julian, 2026-10-07). An available manual `Rejoin online at the next decision` or `Retry manual upload` is temporarily disabled while the actual transport is not online or a console action is busy (Card12 readiness refinement, 2026-10-03); this does not make a phase-unavailable action visible. The bounded results pager is a presentation-navigation exception: Previous stays visible but disabled on the first page, Next stays visible but disabled on the actual last page, and both are disabled while a command is pending. Current-page text explains the boundary. Phase-unavailable clinical actions remain absent.
- The one **primary action** per phase is the facilitator's single dominant control. It is the only element that may use the petrol primary colour as a fill.
- Copy in code font is exact. `{braces}` mark a value from a projection field.
- Wording not given by `docs/HANDOFF.md` is proposed here and is the working copy until a decision changes it. Acceptance behaviour is in `docs/ACCEPTANCE-SCENARIOS.md`.

### Shared rules for every screen

- **No scores, streaks, rankings, leaderboards or celebration** on any role. Reveals of a patient deteriorating use no celebratory motion or sound.
- **A filled petrol is for the one primary action and for selection only** (CASE-114). Petrol as ink is the default text colour, and a petrol tint marks the orientation zone; neither is ever a clinical meaning.
- **Clinical consequence is never colour alone.** Every path classification, receipt and state carries an icon and a text label (see Accessibility).
- The words `Reveal response`, `correct`, `wrong`, `score`, `points` and `winner` never appear as labels.
- A vote never visibly chooses the path. The aggregate is labelled as a suggestion and the facilitator chooses (CASE-042).
- Interface chrome uses structural SVG icons, not emoji.
- **Quiet artwork fallback (CASE-183).** Library Grid/Table/Board, case detail and Groups previews draw the fixed Case brand braid when a stored descriptor is absent or invalid. Brand covers have an `aria-hidden` holder, use the existing group tint and cover footprint, and add no error copy. Valid case artwork retains its generic accessible name and stored rendering inputs. A failed lazy renderer leaves a plain reserved cover; it never blocks browsing or starting a room. Theme changes repaint covers, explicit Light/Dark previews keep their requested theme, and an older yielded paint cannot overwrite a newer paint or a detached canvas.

---

### Visual system (CASE-112 to CASE-122)

The tokens live in `prototypes/room/lib/tokens.css` (light `:root`, dark under `prefers-color-scheme: dark` and `[data-theme="dark"]`). Every colour, size, weight, radius and z-index a window uses is a token there.

- **Type (CASE-112, CASE-134).** No serif face anywhere. Montserrat for all text; JetBrains Mono only for codes (join code, URL, display code) and vital-sign numerals. Both are self-hosted `woff2` files beside their OFL licence text in `prototypes/room/lib/fonts/` (`NOTICE.md`), never a font service. One scale: 12 · 14 · 16 · 20 · 24 px on the console and phone; the projector scales the same steps with the viewport. Projector body and options stay at least 24 px; Findings alone may step down to 18 px at 1280 × 720 with a decision open. Weights 400 (body), 500 (labels), 600 (headings, the primary action); 700 sparingly. Eyebrow labels are 12 px upper case with letter spacing.
- **Colour (CASE-114).** Default text `--ink` is dark petrol (#0f3b47) on the warm off-white `--ground`; the dark theme inverts both. Colour carries three signals only:
  - **Zones.** The orientation band (top row, and the projector's bottom row) is petrol-tinted (`--nav-bg`). The scene and findings sit on neutral cards (`--surface`). Only the decision column carries the option colours: each option tile is its mark's colour mixed into the card (`--tile-tint`).
  - **Phase state.** The phase pill (and a 4–6 px rail on the phase or decision card) uses one accent: open green, locked amber, reveal petrol, consequence coral, paused slate. Never a flood.
  - **Control priority.** One filled primary per screen (petrol); secondary actions tinted (`--petrol-tint`); tertiary actions plain text; destructive actions a coral outline.
- **The QR** sits on a small white card (`--qr-card`) with its own quiet zone, inset in the tinted band: the white is contained, never a slab, in either theme.
- **Gates.** `tests/contrast.test.mjs` checks every text pair (body 7:1, secondary 4.5:1) and non-text pair (3:1) in BOTH themes; a pair whose token is missing in either theme fails. The only exception is the named allow-list entry `yellow-mark-white-glyph` (CASE-115): the yellow mark's glyph is white, like every mark. `tests/z-index.test.mjs` forbids raw z-index literals in the prototypes; stacking uses the `--z-*` bands (raised 1, sticky 100, dock 110, toast 300, overlay 400). `tests/typography.test.mjs` forbids a serif family or a font service.

### Enforced design gates (CASE-125, card 17)

The implementation contract lives here while the consolidated SPEC is absent (Julian approved 2026-10-02). Gates run in the auto-discovered Node tests, so `npm test` and CI verification enforce them. Source stylesheets under `src/client/` and the prototype token stylesheet are scanned. Every other first-party stylesheet must have an explicit classification with a reason; build output under `dist/` is generated from scanned client source, with build provenance checked by card 10. Dependencies, Git metadata and browser/workerd test artifacts are outside the source inventory.

- Both themes: body text is 7:1, secondary labels and disabled text 4.5:1, and meaningful borders/focus rings and SVG fill/stroke 3:1. The existing CASE-115 yellow-glyph exception remains the only contrast exception. System-preference and pinned dark declarations must match in each token file. Colour-only declarations are checked against every neutral ground; background-only declarations carry body text unless a known prototype hover context supplies its inherited label colour. Unknown variables, cycles, gradients and unsupported mixes fail. Exactly resolved `color-mix(in srgb, …)` expressions are measured without rounding channels. Card 17 covers CSS declarations; existing mark tests cover authored mark/tile variants.
- Dark neutral surfaces keep their existing names: `--sunken` < `--ground` < `--surface`, each consecutive relative-luminance step at least **0.0029** (Julian approved 2026-10-02). Baseline luminances are 0.006267034, 0.009180919 and 0.016319536; the minimum step is 0.002913885.
- Disabled buttons use explicit `--ink-muted` text on `--sunken`, with `--field-line` borders and no group-opacity dimming. Both token files are checked after opacity compositing; Chromium checks all four button variants on console, projector and phone in both themes.
- Every fixed/sticky shipped rule requires a known stacking token. Local custom-property overrides are also checked. Every stacking reference must resolve to the preserved table below; raw values, unknown references/fallbacks and values of 1000 or above fail.

| Token | Value | Use |
|---|---:|---|
| `--z-raised` | 1 | Local stacking in a card |
| `--z-sticky` | 100 | Sticky headers |
| `--z-dock` | 110 | Fixed action bars |
| `--z-toast` | 300 | Transient status |
| `--z-overlay` | 400 | Projector display-check overlay |

Stylelint is pinned as a development dependency and runs at error severity: no unknown properties, shipped `@import`, hex colours outside the two token files, or unauthorized `!important`. The only important declarations allowed are `animation: none`, `transition: none`, and `scroll-behavior: auto` on `*, *::before, *::after` inside the token files' reduced-motion media rule. Decorative borders on `.card, .panel`, the information disclosure body and `.opt-tile` do not convey state; their exact token-file rules are excluded from the non-text minimum. Zero/absent borders, transparent paint does not introduce another colour; inherited current colour for icons/borders resolves against the rule text or the known body ink. Visible state borders are checked. Chromium's forced-colours smoke checks actual label, icon and keyboard-focus contrast on all three surfaces; primary buttons and phase pills use system colours in that mode.

### The spatial grid (CASE-113)

Every surface has the same three places, so people know where to look:

| Place | Projector (1920 × 1080) | Console (one screen, console layout v2) | Phone (stacked) |
|---|---|---|---|
| **Top row: orientation** | `Case` and the case title · the phase pill and any layer (manual, replay, connection lost) · `{n} of {m} answered` and the timer while a decision is open | one header row: case title, phase pill and beat · timer · menu · connection; the projector, people and End case sit in the side rail | `Case`, your avatar and name · phase pill · menu |
| **Left: information** | the scene card (surface title + shared `scene`), then the shared vitals, findings (`points`) and investigations tiles | `Room sees` (card 36b, CASE-174): the exact projector-selected public groups, with the presentation strip along the foot; under it, past a divider, `Only you`: the violet private zone (live notes, cue, unavailable-media notice), then the phase card, responses and routes | the shared scene, vitals, findings and investigations; folded under `Situation: {title}` while a decision is open |
| **Right: decision** | the decision card (call to action, prompt, stacked option tiles); after responses close, the anonymous response chart before consequence; otherwise the findings tiles | the phase card (heading, status, answered count, prompt, responses with avatars, secondary actions), the responses aggregate, the routes, the decision path | the decision card, below the information |
| **Bottom row** | `[QR] · [URL / Code] · [In the room] · [sound]` (below) | the action dock: the one primary action, `Back to review` when listed | `Live surface` bar while browsing |

The projector never scrolls. With a decision open, its fit first steps Findings text down from 24 to 18 px, then tightens spacing and scales other type to its 24 px floor. Investigations may give way; Findings remains. If the Findings text still cannot fit, it truncates with a visible `+N more on your phone` line. Options stay at least 24 px (CASE-089, CASE-134). Without a decision, spacing and type tighten, then tiles move between columns or give way if needed.

**Projector bottom row (CASE-113, CASE-133), exactly four cells:** the QR on its white card · the short URL (row 1, mono) over `Code {7K3 QX9}` (row 2) · `In the room`: lobby avatar + name chips by default; during play avatar-only chips with `aria-label="Participant"` until `Show names`, then avatar + name (truncated with an ellipsis at about 12 characters); chips that do not fit on the line become `+{n}` · an icon-only sound chip (`aria-label` `Room sound`, `aria-pressed`). In the lobby, where the join panel is the hero, and once joining is closed or the room has ended, the first two cells give way (`Joining is closed` while closed). The projector carries no phone-connectivity advice (CASE-122). A separately paired display shows its own `Connection lost · follow the facilitator` notice after 15 seconds without transport contact (Projector display).

---

### Projected text, option marks and vitals (CASE-087 to CASE-090)

- **One scene, then points (CASE-087, CASE-116, CASE-117).** A surface may open with `scene`: two or three vivid sentences (at most 320 characters) in one prose card. Its `points` follow as the `Findings` tile, telegraphic clinical fragments, 3–7 bullets, ideally 10 words or fewer each, and its `investigations` (at most five) as the `Investigations` tile. The facilitator shares one populated text group per deliberate press: scene → observations → findings → investigations. The same newly shared group appears on projector and phones with a restrained opacity/position entrance; reduced motion shows it immediately. A late join or replay does not replay that entrance. Asset identifiers remain private and no blank media press appears until a separate media delivery contract exists. A surface's `notes` (the full narrative and mechanism) appear only on the facilitator console, in a separate `Facilitator-only material` card.
- **Option marks.** Options keep ONE authored order on every screen; the builder shuffles that order once, at save or publish, and warns when the recommended option is first everywhere or clearly the longest. Position *n* always carries the same mark: 1 red triangle, 2 blue diamond, 3 yellow circle, 4 green square, then purple star, teal hexagon, orange cross, grey pentagon (`prototypes/room/lib/marks.mjs`). The shape, the colour and the full text always appear together; colour is never the only signal. The room result after a reveal uses the same marks.
- **Vitals strip.** `observations` render as one compact strip of cells, each a small label over the value (mono) and unit, then `↓ 134` when it moved. When a value moved against the last scene the room saw, an arrow (`trend` `up` or `down`) and the earlier value (`previous`) follow it. Arrows are direction only, never colour-coded good or bad. The accessible text reads `HR 118, down from 134`.

## Facilitator console

### Served sign-in and shared-PC approval (Card 11)

The served entry offers invited-email `Send code`, a six-digit code field and `Sign in`, with `Email sign-in link` as the same-origin PKCE fallback. There is no `Keep me signed in` option: since card 38 (CASE-175) every device stays signed in until Sign out, which stays visible on `/cases` and in the room header. Since card 29 (CASE-166) this sign-in lives at `/cases`; `/` is the participant room-code entry for everyone, and the catalogue (Grid, Table, Board) leads to case detail, where `Start room` opens the lobby; the full phase controls below belong to Card 12.

After sign-in, an account whose Name & role are not confirmed sees **`Your name and role`** before anything else: `Name` and `Role` (suggestions as you type from the seniority ladder; any wording), the line `Participants see this on their session record as the facilitator who ran the room. You can change it later in Account.` and `Save and continue`. A missing field says `Enter your name.` or `Enter your role.` beside it and takes focus. The same two fields appear in Account (`Facilitator on record`, `Save name and role`, then `Saved. New rooms use it; rooms already started keep theirs.`), by Start room on case detail (`Facilitator on record: {Name}, {Role}`, a disclosure; `For this session only. Your Account keeps its own name and role.`) and in Administration → Accounts (`Facilitator on record`, `Save name and role`, step-up).

On `/P`, a shared PC shows its eight-character code and waiting status without an account sign-in control. An eligible phone can choose `Use a shared computer` (renamed from `Approve a PC on this phone`, CASE-166), sign in, type the code, inspect browser family, coarse location, request time and expiry, then choose one of its own active rooms. The room list is paged and may be reloaded if a room expires between pages. After approval the PC waits for a room-scoped credential, sends `takeover`, and says `PC ready` only after an accepted receipt. The PC stores neither the phone account token nor the code in a URL. After an actual room end it clears the console and shows `Room ended` with `Approve a new session`. An offline local End instead says `Local presentation ended` and asks the facilitator to confirm server closure from their phone when online; fresh approval is required before another PC session. A revoked capability instead shows `Console access ended` and states that the room may still be running; it never claims an authoritative room end. Approval is one panel-wide request at a time, with stale/closed continuations ignored.

Header row, on every phase: the case title and current `beat.title`, the phase pill, `timer` (advisory, shown as `{m:ss} left` with a pause icon when `remainingS` is set, and `room sees "{words}"`; the room-facing wording is under Accessibility, Advisory timer), `Manual room mode` when on, `Projector: join screen` while it is up, the menu (sound only) and the connection (`Live`). There are no tabs (console layout v2, CASE-287, Julian 2026-10-18; private historical reference (not distributed)). At 1440 × 800 and larger the console is one screen that never scrolls; below 1100 px wide or 600 px tall it stacks and scrolls.

- **Main area**: `Room sees` (the selected public projector surface, or the join screen) over `Only you` (live notes and cue, CASE-174, with `Case map` and `Actual route`), and the decision panel on the right (the phase heading and status, `{n} of {m} responded` while open, the prompt, the round's secondary actions, `Round timer` / `Set timer` while open, results, routes and named responses). `Hide` folds Room sees to one line; `×` (`Hide decision panel`) hides the decision panel and `Show decision` brings it back; two separators (`Resize the left and right panels`, `Resize Room sees and notes`) resize by pointer or arrow keys. The presentation strip (`Projector` · `Back`, `Live surface`, `Forward` · exact-entry rows, newest at the right) appears once `actions` contains `replay`; the phase card, aggregate, routes and `Decision path` remain independent of presentation replay. An active decision does not open responses until its context groups have all been shared.
- **Side rail**: `Projector` (`Connected` · `This computer · second screen`; `Not open` with `Open projector` and, after a missing handshake, `Projector not connected. Allow pop-ups or open it manually.` with `Open projector manually`; `One screen` with `One screen detected. If it is duplicated, the room sees this console: Windows key + P, then Extend.`; always `Use another screen`); while reconnecting, `Connection` (`Reconnecting. Phones keep their answers.`, `Enter manual room mode`) or in manual mode the `Manual room` tray (`Download your notes`, `Add spoken marker`, `Rejoin online at the next decision` / `Retry manual upload`, `Follow current room without manual changes`); `{n} in the room` with faces, `Join code` (or `New joins stopped`), `Stop new joins` / `Allow new joins`, `Show join screen` / `Hide join screen`; `Room setup`; `End case`.
- **Room setup** (a sheet over the main area; open in the lobby, then from the rail; `Close` or Escape folds it): `People · {n}` (avatar, name, joined time, `Rename {name}`, `Remove {name} from room`; `Show names on projector` / `Hide names on projector`), `Facilitator briefing` (`Download briefing (PDF)`, `Print briefing`), `Consoles` (each console; `Stop shared computer`; `Take over this room` only when another console is connected), `Use another screen` (`Display pairing code` / `Connect projector`, `Dismiss display reminder` or `Check display`, optional `Identify screens`), and the amber backup cards `Use a shared computer` (computer code, `Review computer`, then a dialog with code, browser, coarse location, requested and expiry and `Approve room {code}`; card 29) and `Manual room` (`Enter manual room mode`).
- **In-place confirms** (no pop-ups): `End case`, `Void round`, `Enter manual room mode`, `Take over this room`, `Remove {name} from room` and `Stop shared computer` first read `Press again: …` and put what they do in the bottom bar's line (for End case: `Ends the room for everyone. Phones keep their recap for 24 hours.`); a second press after 600 ms and within 3 s acts; Escape disarms.

After an accepted online `End case` the console shows the counts-only ended summary (card 40, CASE-284), and Back to cases returns to the signed-in case view; participants keep their own recaps until their 24-hour expiry. An offline manual End closes only the local presentation and does not claim the server room ended.

Every phase also carries these actions when listed in `actions`: in the decision panel, `Reopen as new round`, `Set timer` while open, `Void round`; in the rail, `Enter manual room mode` (`enter_manual`, while reconnecting), `Stop new joins` or `Allow new joins` (`close_joining` with `closed`, driven by `joiningClosed`), `Show join screen` / `Hide join screen` (`show_lobby`) and `End case` (`end`); in Room setup, `Enter manual room mode`, `Show names on projector` or `Hide names on projector` (`show_names`, driven by `namesShown`), and `Rename` and `Remove` per participant (`rename`, `remove_participant`). They are not repeated below unless a phase changes them.

The primary action keeps **one fixed screen position in every phase**, docked in the lower thumb zone below the feedback row. Longer notices expand above it rather than shifting its target. Opposite Undo, the dock's third slot holds the **Room sound** switch (CASE-255): `aria-pressed`, a speaker glyph and the label `Room sound` (icon only, 44 px, at phone width). Off asks the same-PC projector to mute and turns console sounds off, through the Menu's own two actions; on turns back on the console sounds it turned off and says `Room sound on. Press Room sound on the projector to bring its music back.` Pending progression stays focusable with `aria-disabled` / `aria-busy`; guarded handlers ignore repeated activation. A timeout says `No confirmation from the room. Check the case before continuing.` and resyncs the same room without issuing a fresh command. Display approval separately prevents duplicate sends and preserves the typed code and deliberate later focus movement. The decorative header cover reserves 32 px during lazy loading and uses the shared brand fallback when its descriptor is absent or invalid. Every facilitator command may carry `expectRevision`; a stale one returns `stale_revision`, and the console resyncs without applying it.

### `lobby`

- **Shows:** `joinCode` (spaced: `7K3 QX9`), the short URL built from it, `participants` (names, `joinedAt`), `nextBeat` (as `Opens with: {nextBeat.title}`), `namesShown`, `actions`.
- **Primary action:** `Start case` (`start`). It is available without display-check confirmation; the privacy check is advisory (Julian, 2026-10-07).
- **Secondary actions:** automatic lobby names and avatars (no Show/Hide names control), `Enter manual room mode` (allowed in the lobby, CASE-066), `Rename`, `Remove` (Room setup, which is the lobby's main area), `End case` (rail).
- **Exact UI copy:**
  - Heading: `Lobby`
  - Status: `{n} in the room · Waiting to start`
  - Join panel label: `Join code` · `{spaced code}` · `Scan, open the short URL, or type the code`
  - Projector card (rail): Start room opened the window, so it reads `Connected`, or `Not open` with `Open projector`; `Use another screen` opens its card in Room setup with `Keep these controls off the room screen.`, `Display pairing code` / `Connect projector`, `Dismiss display reminder` (or `Check display` after dismissal) and optional `Identify screens`. The reminder never blocks Start. Dismiss folds the card and focuses the dock action. Popup/handshake failure after Open projector reveals `Projector not connected. Allow pop-ups or open it manually.` and `Open projector manually` beside Open; a late room-bound handshake removes that fallback.
  - `In the room · {n}`: one chip per participant, avatar + name
  - Empty roster: `No one has joined yet`
- **Must never appear:** `Reveal next surface`, `Lock responses & review`, any decision or path (there is no `decision` yet); any hint that the room has started.

### `surface_live`

- **Shows:** `beat` (`title`, `kind`, private `cue`), `nextBeat`, `liveSurface`, `timeline`, `decision` and `paths` when `beat.kind` is `decision` (only after `void_round` or in manual mode), `actions`.
- **Primary action**, by `actions`:
  - `advance` with `nextBeat.kind` `decision`: `Open decision`.
  - `advance` with another `nextBeat.kind`: `Reveal next surface`.
  - `advance` while `decision` is set (round was voided): `Open a new response round`.
  - `select_path` in manual mode with a decision pending: `Select route`.
- **Secondary actions:** `Enter manual room mode` (with `Void round` impossible here, since no round is open), presentation strip.
- **Exact UI copy:**
  - Heading: `Live surface`
  - Subheading: `{liveSurface.title}`
  - Private cue label: `Facilitator cue · not shown to the room`
  - Next line: `Next: {nextBeat.title}`
  - After a void: status `Round cancelled · open a new response round when ready`
- **Must never appear:** a decision's aggregate for a voided round; an action not in `actions`; `Lock responses & review`.

### `responses_open`

- **Shows:** `round` (`no`, `status`, `responseCount`, `participantCount`, `responses` with `name`, `response`, `at`), `decision.prompt` and `interaction.options`, `timer`, `beat.cue`, `actions`. `round.aggregate` and `round.suggestion` are `null` and must not be rendered or computed client-side.
- **Primary action:** `Lock responses & review` (`lock`).
- **Secondary actions:** `Void round` (`void_round`, confirmed: `Cancel this round? Its answers are discarded and never used.`), `Enter manual room mode` (voids the round in the same command, see Manual room mode), `Set timer` (`set_timer`, 10 to 600 s, or `No timer`).
- **Exact UI copy:**
  - Heading: `Team decision open`
  - Round line: `Round {round.no} · {responseCount} of {participantCount} responded`. `participantCount` counts the participants connected now plus anyone who has answered (CASE-106).
  - Prompt: `{decision.prompt}`
  - Roster rows: `{name or "Unnamed"}` and that person's current answer label, or `No answer yet` (text plus an empty-circle icon). A free-text answer whose `identifierFlags` is non-empty carries the tag `May contain patient details · do not read aloud` (CASE-105); the flag names kinds only, never the matched text.
  - Reopened round banner (when `round.no` > 1): `Reopened as round {round.no} · earlier answers are kept privately`
  - While names are shown on the projector, the live `{responseCount} of {participantCount} responded` count is hidden on the console too.
  - Timer ended (advisory): `Time is up · locking is still your call`
- **Must never appear:** a tally, bar chart, percentage or leading option while open; a path list or suggestion; any control that selects a route.

### `responses_locked`

- **Shows:** `round.aggregate` (`counts`, `total`), `round.suggestion` (`pathId`, `reason`), `round.responses`, `decision.paths` (`label`, `classification`, `recommended`, `rationale`, `cue`, `revealPreview`, `terminal`, `explored`), `rounds`, `actions`.
- **Primary action:** `Select route` (`select_path`): focuses the resolution panel; the facilitator confirms one row with `Select this route`. Selection is never implied by the vote.
- **Secondary actions:** `Reopen as new round` (`reopen`), `Void round` (`void_round`, same confirmation as above), `Enter manual room mode` (voids the round).
- **Exact UI copy:**
  - Heading: `Responses locked`
  - Aggregate card: `Responses · {total} answers` with one row per option: label, count, and the share as a number.
  - Suggestion line: `Suggested by responses: {path label} · {suggestion.reason} · you choose the route`. `suggestion.kind` is `plurality`, `tie`, `none` or `rules`.
  - Resolution panel order: recommended path first, then defensible and other authored paths, then the section `Override: any other authored route`.
  - Row template: `[icon] {label}` · classification text · `If revealed: {revealPreview}` · `Private note: {rationale}` · `Ask: {cue}`
  - Classification text: the six labels in the Accessibility table; explored terminal paths read `Already explored` and are not selectable.
- **Must never appear:** `Reveal response`; a button that selects the path from the majority automatically; the aggregate on any other role's screen; a path with `explored: true` as selectable.

### `path_selected`

- **Shows:** `selectedPathId` with that path's `label` and `revealPreview`, `resolutionKind` (`majority`, `minority`, `override`, `manual_room`), `round.aggregate`, `actions`.
- **Primary action:** `Reveal: {path.revealPreview}` (`reveal`), a **two-step control**. The first tap arms it and the label becomes `Show to room?`. A second tap within 3 s confirms and reveals. It disarms by itself after 3 s and returns to `Reveal: {path.revealPreview}`.
- **Secondary actions:** `Back to review` (`back_to_review`) sits on the opposite side of the screen from Reveal, at least 48 px away, so a mis-tap cannot reach it.
- **Exact UI copy:**
  - Heading: `Route chosen · not yet shown to the room`
  - Status: `Chosen route: {path label}` · journal line `Recorded as {Majority | Minority | Override | Manual room}`. `Majority` is recorded only when votes favoured the chosen route; a route chosen with no votes, or after a tie, is `Override` (or `Minority` if anyone chose it)
  - Reassurance: `Phones and the projector have not changed`
- **Must never appear:** any affordance that suggests the room already sees the consequence; `Resume online` (absent from `actions`, and the hint `Reveal or clear the selection first` shows in manual mode).

### `consequence_revealed`

- **Shows:** `liveSurface` (the consequence), `nextBeat`, `flags` (for the facilitator only), `timeline`, `actions`.
- **Primary action:** `advance`, labelled `Open next decision` when `nextBeat.kind` is `decision`, otherwise `Reveal next surface`.
- **Secondary actions:** `Enter manual room mode`, presentation strip.
- **Exact UI copy:**
  - Heading: `Consequence shown`
  - Status: `The room is seeing: {liveSurface.title}`
  - Next line: `Next: {nextBeat.title}`
  - Cue label: `Facilitator cue · not shown to the room`
- **Must never appear:** a score or verdict on the chosen route; the words `correct` or `wrong`.

### `terminal_teaching`

- **Shows:** `terminalPathId` with that path's `label`, `cue` and `rationale`, `liveSurface` (marked in `timeline` as `terminal`), `decision.paths` (to show which options are `explored`), `actions`.
- **Primary action:** `Reset to checkpoint` (`reset_checkpoint`), written `Reset to {checkpoint beat title}` once the field exists (Spec gaps 1).
- **Secondary actions:** `End the case` (`end`, confirmed; `end` does not visit the debrief beat), `Enter manual room mode`, presentation strip.
- **Exact UI copy:**
  - Heading: `Teaching point`
  - Status: `This route led to a serious deterioration. Debrief, then reset to the checkpoint.`
  - Note: `The explored option will be greyed out when the decision reopens`
  - Cue label: `Facilitator cue · not shown to the room`
- **Must never appear:** punishment, failure or game-over framing; a death icon used alone; a score; confetti or celebration of any kind.

### `discussion_paused`

Retired (CASE-255, 2026-10-15): no command enters it; only a room persisted while paused can show it, until M2 removes it.

- **Shows:** `resumePhase`, `timer` (frozen, `remainingS`), `liveSurface`, `timeline`, `round` when `resumePhase` is `responses_open` (answers continue to be held), `actions`.
- **Primary action:** `Resume` (`resume`), written `Resume {resumePhase label}`. Resume labels: `responses_open` becomes `Resume · responses open`, `responses_locked` becomes `Resume · reviewing`, other phases become `Resume discussion`.
- **Secondary actions:** `Enter manual room mode` (only when `actions` lists it, which requires a pause taken from a stable phase), presentation strip, `End case`.
- **Exact UI copy:**
  - Heading: `Discussion pause`
  - Status: `Paused from {resumePhase label} · timer frozen at {m:ss}`
  - Mid-vote status: `Paused · answers are held and cannot change until you resume`
- **Must never appear:** `Lock responses & review` or any command that changes the round; a hidden progression.

### `debrief`

Console Debrief (CASE-291, Julian 2026-10-18; private historical reference (not distributed), Debrief). A reversible phase before End, entered from a shown slide (`surface_live`, `consequence_revealed`, `terminal_teaching`), never inside a round, in manual room mode or with a clarification shown.

- **Shows:** `debrief` (`resumePhase`, `page`, `startedAt`, `expiresAt`, `public`: the projector's debrief, and `questions`: per decided round its slide `entryIndex`, `prompt`, `counts`, `total`, `chosen`, `agreed`, `notTaken` with rationales, and `resultPage`), `publicTimeline`, `timeline`, `participants`, `display.cursor`, `actions` (`replay`, `debrief_page`, `back_to_case`, `takeover`, `remove_participant`, `rename`, `end`).
- **Primary action:** `Next: {slide title}`, stepping the review: the summary (and its second page when it has one), then every slide in entry order, then `Back to the summary`; a question's results page continues from that question's slide. The projector follows.
- **Secondary actions:** `End case` (coral outline beside Next, press again), `Back to the case` (the Undo slot), the `Questions` row (`Summary`, `Q1`…`Qn`), the strip (`Back`, `Forward` and every slide), `Show results on projector` / `Hide results on projector` on a question the room was shown, the rail's Feedback card (`Copy feedback link`) and `Debrief record` (`Debrief PDF`, `Print`), Room setup.
- **Exact UI copy:**
  - Phase pill `Debrief`; heading `Summary` or the replayed slide's title.
  - Right panel, summary: `Debrief`, `{n} people joined · {n} questions`, `The projector shows the summary and a large feedback QR. Phones show their recap and the feedback form.`, `Jump to a question below, or step through every slide with Back and Forward. The projector follows; phones stay on their recap.`
  - Right panel, question: `Question {n} of {m}`, `{n} answers`, the prompt and counts, `Route you chose · most of the room chose it too` (or `· most of the room chose another answer`, or no suffix when it cannot be said), `Not taken · only you`; a result the room was not shown: `The room was not shown these results, so the projector keeps them private.`
  - Right panel, other slides: `Slide`, `{n} of {m} · no question on this slide`.
  - People card: `{n} joined`, `Phones show their recap and the feedback form.` Feedback card: `Feedback` · `Open`, `{n} of {m} joined have sent it`, `On phones now; new joins stopped. Ends by itself at {time}.`
  - The bottom bar's line: `The projector follows`; End case armed: `Ends the room for everyone and closes the projector. Phones keep their recap for 24 hours.`
- **Entering it:** on a complete case the bottom bar's primary is `Debrief` (`Press again: Debrief`; `Phones get their recap and feedback opens. Back to the case undoes it.`); elsewhere the rail's `Debrief now`, greyed inside a round with `Debrief now: lock or void the round first.` (`reveal a route or void the round first` once locked or chosen).
- **Must never appear:** the routes not taken or their rationales anywhere but this console; a new join; a vote control.
- **End case from Debrief:** the room ends, this computer's projector window closes, and the console returns to Cases with `{case title}: case ended. Its debrief and feedback are in History.`

### `ended`

- **Shows:** `rounds`, `timeline`, `participants`, and (once available) the end time and expiry. `actions` is empty.
- **Primary action:** none. A navigation link `Back to cases` is chrome, not a room command.
- **Secondary actions:** none.
- **Exact UI copy:**
  - Heading: `Room ended`
  - Status: `Private recaps are available to participants for 24 hours, then deleted`
  - Note: `Participants keep their recap on their phone for 24 hours; one who clears their browser data loses it` (CASE-106)
- **Must never appear:** any command button; a per-person leaderboard; participant answers beyond what the roster journal already holds.

---

## Projector display

The display renders its projection on the spatial grid (CASE-113): the orientation band, the information and decision columns, and the bottom row carrying the join route (QR, short URL, spaced room code, together) while the room is joinable and `In the room`. It has no interactive controls, with one local exception: the icon-only sound chip (`Room sound`, `aria-pressed`), because browsers require a click before audio; the display is silent until then (see Accessibility, Sound). It never shows an answer or aggregate while responses are open, suggestion, cue, path, classification, `rationale`, unrevealed surface or answer key. After closing responses, the anonymous chart appears by default before path selection; free text appears in anonymous pages of up to twelve separate response chips (CASE-276) (500 characters combined), with facilitator paging controls (CASE-275). After a consequence, the public room result can remain with that consequence under the saved Hide/Show choice. It is not a path-selection control. During play, before `Show names`, the projection carries `avatars` only (no ids or names), and the bottom row renders avatar-only chips labelled `Participant`. After `Show names`, `names` is `[{ name, avatarId }]` and chips show both; `counts.responded` is then null (CASE-104/P2). A closed count-bearing chart takes priority over names and avatar chips; closing or showing responses clears play names, and Show names requires Hide responses first. Chips that do not fit become `+{n}`. Names are cleaned of control and bidi characters before they reach any screen.

A separate display with no credential for this room returns to the display pairing screen. During an established connection, after 15 seconds without a successful transport reply or received frame it shows `Connection lost · follow the facilitator`; successful contact clears the notice, including an unchanged long-poll reply. A same-PC projector can receive its revealed display-only projection over BroadcastChannel without a paired credential.

### `lobby` (public `waiting`)

- **Shows:** `joinCode` (spaced), the short URL built from it, the QR (payload from the same URL), `counts.participants`, `names`, `phase`, `manual`. While `joiningClosed`, the join panel is replaced by `Joining is closed`.
- **Primary action:** none.
- **Secondary actions:** the sound chip (local).
- **Exact UI copy:**
  - Heading: the case title (Spec gaps 2)
  - Join panel (card 36b, CASE-174; slim card, CASE-202: one opaque card about a third wide on the left over the room's splash art, or the brand braid when the room has none, everything stacked and centred): the case title, the QR at `--projector-qr`, `Join the case`, `case.iatrogenic.app/J/7K3QX9`, then `7K3 QX9` at `--projector-code`, one line. There is no status eyebrow and no `Room code` label. A title past two lines steps down to `--projector-title`, then to `--projector-body` if the card would overflow.
  - Count: the bottom row's `In the room` ends with `{counts.participants} joined`; a new arrival's chip and the count update only when its avatar has landed from the art (CASE-202).
  - Under the display check (dual-display, before `Start case`): the single word `Projector`
- **Must never appear:** case content, surfaces, `Team decision open`, names before `Show names`.

### `surface_live` (public `live`)

- **Shows:** `surface` (`title`, `points`, `observations` with `trend`, `assetIds`), `phase`, `manual`, `replay`.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** the scene card (the surface `title` as heading, then `scene`), the vitals strip with trend arrows and the earlier value (CASE-090), and in the right column the `Findings` and `Investigations` tiles (CASE-116, CASE-117). Phase pill `Revealed`. Bottom row: join route while joinable.
- **Must never appear:** the next surface, a decision prompt, any control. A surface revealed in a voided round is not repeated.

### `responses_open` (public `decision_open`)

- **Shows:** `decision` (`prompt`, `status` `open`, `interaction.options`), `counts.responded` and `counts.participants`, `surface` (the scene card, vitals and tiles stay in the left column), `phase`.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:**
  - Phase pill `Decision open`; at the top of the decision card: `Team decision open · Choose on your phone`
  - Prompt: `{decision.prompt}`
  - Options: every option in the one authored order, each with its mark (shape + colour, see Option marks) and its full label, as stacked tiles in the right column (CASE-089). Explored options stay, labelled `Explored`. Free-text decisions show the prompt only.
  - Count, in the top row: `{counts.responded} of {counts.present} answered` (CASE-089). `present` is the participants connected now (an open socket, or activity in the last 60 s) plus anyone who has answered, so a phone that dropped out does not hold the count short (CASE-106). `counts.responded` is `null` while names are shown, so no count appears then.
  - Reopened round (public phase unchanged): the same banner. The display does not carry `roundNo`.
- **Advisory timer:** when `timer` is set, quiet text in the top row beside the count (see Accessibility, Advisory timer).
- **Must never appear:** per-option counts, a tally, bars or percentages before the reveal; any marking of a recommended or leading option; a flashing clock. (The countdown's ring, its milestone pulse and its final-ten pops, CASE-335, are the timer, not a result.)

### `responses_locked` (public `reviewing`)

- **Shows:** `phase`, `surface` (unchanged), `decision` with `status` `locked` (the same option tiles, no count).
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** phase pill `Responses locked`; decision card line `Responses locked · Facilitator reviewing`. The option tiles stay, so the room can keep discussing them.
- **Must never appear:** the aggregate, the suggestion, which route is being considered.

### `path_selected` (public `reviewing`)

- **Shows:** identical to `responses_locked`.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** unchanged: `Responses locked · Facilitator reviewing`. In manual mode, `Manual room mode · facilitator-led discussion`.
- **Must never appear:** any change at all. A chosen but unrevealed route produces no visible difference on the projector.

### `consequence_revealed` (public `live`)

- **Shows:** `surface` (the new consequence), `phase`.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** phase pill `Consequence` (coral; the scene card carries a coral rail); the consequence scene, vitals and tiles as in `surface_live`, with the room result above the tiles in the right column. A surface whose `timelineKind` is `consequence` carries no label that says whether the choice was good.
- **Must never appear:** praise, verdict or consequence-as-score.

### `terminal_teaching` (public `teaching`)

- **Shows:** `surface` (its `timelineKind` is `terminal`), `phase`.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** phase pill `Teaching point`; the surface's scene, vitals and tiles as in `surface_live`.
- **Must never appear:** punishment or game-over framing, a score, celebratory or failure sound or effect, the checkpoint or reset plan before the facilitator acts.

### `discussion_paused` (public `paused`; legacy rooms only, CASE-255)

- **Shows:** `phase`, `surface` (the live surface is retained), `manual`.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** phase pill `Discussion pause`; decision card line `Paused · answers are held`. If a decision is in play (`decision.status` `paused`), its option tiles stay on screen for the discussion, with no count.
- **Must never appear:** the paused-from phase, a vote hint, `counts.responded` (omitted while paused), a running timer.

### `debrief` (public `debrief`, CASE-291)

- **Projection:** `phase`, `debrief` (`route`, `objectives`, the shown choice and ranking `results`, `page`), `feedbackCode`, `surface` only while the facilitator replays a slide; `decision`, `responseResult` and `lastResult` are null.
- **Exact UI copy:** the ended page's pattern under `Debrief` · `Your recap and the feedback form are on your phone`, with the large feedback QR, the summary or the paged result; a replayed slide keeps the feedback QR in the join route's place.
- **Must never appear:** the join route or code, a decision, live counts, private notes, the routes not taken.

### `ended` (public `ended`)

- **Projection:** `phase`, `surface` (last revealed surface), `counts.participants`. The renderer shows only the terminal panel and splash art, without rendering that clinical surface.
- **Primary action:** none.
- **Secondary actions:** none.
- **Exact UI copy:** phase pill `Session ended`; one panel `Session ended` · `Thank you · your private recap is on your phone for 24 hours` over the lobby's splash art (card 36b, CASE-174).
- **Must never appear:** stale scene, findings, decision, responses or join QR; names after the room ends if `names` is `null`; any per-person content.
- **Same-PC lifecycle (CASE-184):** accepted online End sends the validated public frame before private teardown. An already accepted ended local view survives the matching local cleanup message; active views still clear on sign-out, access loss or replacement. Manual End can retain only its accepted local ended view and does not claim server termination. Failed channel publication cannot block cleanup; room and monotonic epoch/revision validation remain unchanged.

---

## Participant phone

The phone shows a persistent orientation band with `Case`, your avatar and `you.name` (or `You're in`), and the phase pill, which always pairs an icon with text. It renders `liveSurface` as the default view and the `timeline` as swipeable earlier material. An earlier surface is read-only. When a participant is viewing earlier material the only persistent control is `Live surface`. It auto-follows to a new shared reveal (the next `liveSurface`), and the browsing position is not lost for later: the timeline stays browsable. `Decision` is reserved for a currently actionable vote.

Participant desktop layout (CASE-182): at 64 rem and wider, use a shell capped at 72 rem with 24 px spacing. During an open, held or locked decision, show all already-revealed information on the left and the participant's private decision card on the right; keep authored option order and a single document scroll. Below that breakpoint, retain the phone stack and situation disclosure. Join/waiting and recovery stay compact; material without a decision, earlier-material browsing and recap stay readable single-column states. Desktop timeline items are 16 rem rather than a percentage of the wider page; the existing Live surface bar aligns with the shell. The full prompt and option labels wrap, including unbroken strings. Below 360 px, ranking controls occupy a separate row so they do not squeeze the label. Screen grid rules do not change print layout.

Crossing the breakpoint rebuilds only information, preserving answer inputs, draft, focus and pending event identity. If a focused information node disappears, focus returns to the replacement information heading or disclosure. Opening or closing the situation remains respected through phase updates and resize, resetting when new material is shared. No participant content, answer state or navigation is duplicated to create the columns.

Before `you` is set the phone shows the join flow. If `you.removed` is true it shows: `You were removed from this room` and no controls.

### `lobby` (public `waiting`)

- **Shows:** `phase`, `you` (`name`, `avatarId`), `manual`.
- **Primary action:** none.
- **Secondary actions:** `Change name or avatar` (a disclosure) holding the name field, the avatar picker and `Save changes` (`rename` with `displayName` and `avatarId`, the same rules as the join, CASE-121).
- **Exact UI copy:** heading `Waiting to start`; `The case starts when the facilitator is ready. Keep this page open.`; your avatar beside `You're in as {name}`.
- **Must never appear:** any case content, a vote control, other participants' names.

### `surface_live` (public `live`)

- **Shows:** `liveSurface`, `timeline`, `decision` is `null`.
- **Primary action:** none.
- **Secondary actions:** swipe or tap earlier material; `Live surface` when viewing earlier material.
- **Exact UI copy:** pill `Live surface`; the scene card (heading `{liveSurface.title}`, then `scene`), the vitals strip, then the `Findings` and `Investigations` tiles. Earlier material banner: `Earlier material · read-only` with the button `Live surface`.
- **Must never appear:** the next surface, a vote control, a decision from a voided round, other branches, the aggregate, presenter controls.

### `responses_open` (public `decision_open`)

- **Shows:** `decision` (`decisionId`, `prompt`, `interaction` with `type`, `options` including `disabled`, `maxLength`, `rankCount`; `roundId`, `roundNo`, `status` `open`, `yourResponse`), `liveSurface`, `timeline`.
- **Primary action:** `Send answer` (the vote control). It posts with a fresh `clientEventId` and the projection's `roundId` and `epoch`. After a send it reads `Change answer` until the receipt returns.
- **Secondary actions:** `Live surface` and earlier material browsing (answers can be edited from the decision card while the round is open).
- **Exact UI copy:**
  - Chip: `Team decision`
  - Heading: `Round {roundNo}` only when `roundNo` > 1: `Responses reopened · round {roundNo}`
  - Prompt: `{decision.prompt}`
  - Controls by `interaction.type`: `single_choice` as radio rows; `multi_select` as checkboxes (`Choose all that apply`); `ranking` as a reorderable list (`Rank {rankCount} options`) whose primary interaction is a `Move up` and `Move down` button on every row, with drag as an optional extra, never the only way; `free_text` as a text area with a counter `{n} of {maxLength}`.
  - Options arrive in the one authored order shared with the projector (CASE-088); render them in that order, each as a tile with its mark (shape + colour) and full label. Never re-sort.
  - Explored options (`explored: true`, always also `disabled: true`) stay visible, locked, with an `Explored` tag and the note `The room has already seen where this leads`. Other `disabled` options read `Not available`.
  - Send states: `Sending…` → see the receipt table. Saved state: `Answer saved · you can change it until responses lock`.
  - Existing answer: `Your answer: {label}` (from `yourResponse`).
- **Advisory timer:** when `timer` is set, a text line (see Accessibility, Advisory timer). It never locks the vote.
- **Must never appear:** other people's answers, a count of responses, a tally, any marking of a recommended or leading option, a ticking or pulsing clock.

### `responses_locked` (public `reviewing`)

- **Shows:** `decision` (`status` `locked`, `yourResponse`), `liveSurface`.
- **Primary action:** none; there is no editable control.
- **Secondary actions:** `Live surface`, earlier material.
- **Exact UI copy:** `Voting locked · Awaiting the next shared surface`; `Your answer (locked): {label}` or `No answer recorded from this phone`.
- **Must never appear:** a send, change or retry control, the aggregate, the route being considered.

### `path_selected` (public `reviewing`)

- **Shows:** identical to `responses_locked`.
- **Primary action:** none.
- **Secondary actions:** `Live surface`, earlier material.
- **Exact UI copy:** unchanged from `responses_locked`. In manual mode: `Facilitator-led discussion · phone answers are off for now`.
- **Must never appear:** any difference from the locked screen. A chosen route is invisible until revealed.

### `consequence_revealed` (public `live`)

- **Shows:** `liveSurface` (the consequence), `timeline`; `decision` is `null`.
- **Primary action:** none.
- **Secondary actions:** `Live surface`, earlier material (earlier decisions read-only).
- **Exact UI copy:** the page moves to the new live surface automatically; chip `Live surface`; a one-line status `New material shared`. Earlier decision cards read `Earlier decision · read-only`.
- **Must never appear:** verdict, praise, or a score. A participant browsing earlier material is returned to the new live surface by the reveal.

### `terminal_teaching` (public `teaching`)

- **Shows:** `liveSurface` (timeline kind `terminal`), `timeline`, `decision` is `null`.
- **Primary action:** none.
- **Secondary actions:** `Live surface`, earlier material.
- **Exact UI copy:** chip `Teaching point`; the surface `title` and `points`, with the vitals strip; line `Read this, then discuss with the room`.
- **Must never appear:** score, failure or punishment framing, celebration, the checkpoint plan.

### `discussion_paused` (public `paused`; legacy rooms only, CASE-255)

- **Shows:** `phase`, `liveSurface`, `timeline`, and `decision.status`. When it reads `held`, a round was open when the pause began.
- **Primary action:** none.
- **Secondary actions:** `Live surface`, earlier material (revealed material stays inspectable).
- **Exact UI copy:**
  - Heading: `Discussion pause`
  - Pause taken mid-vote (`decision.status` is `held`): `Paused · your answer is held`, followed by `Your answer: {label}` when `yourResponse` is set. The vote control is visible but disabled.
  - Pause from any other phase: `Paused · the facilitator will resume the room`
- **Must never appear:** an enabled vote control, a hidden progression, any hint of the facilitator's next step.

### `debrief` (public `debrief`, CASE-291)

As `ended` below: the recap, `Give feedback` and the downloads, with phase chip `Debrief`. The room has not ended, so `expiresAt` is null and the expiry line reads `On this phone for 24 hours after the session`. Back to the case returns the phone to the live room.

### `ended` (public `ended`)

- **Shows:** `recap` (`rounds` with `prompt`, `roundNo`, `yourResponse`, `yourAnswer`, `yourClassification`, `why`, `doDifferently`, `revealIndex`; plus `learningPoints`, `expiresAt`, `feedbackCode`), `you`, `timeline`. Card 40b: the recap is a case journey built only from `timeline` and each round's `revealIndex` (`src/client/recap-journey.mjs`). Every revealed entry is one stop in room order, reset branches included; a question joins its own slide, shows its interaction glyph, your answer in a petrol chip with its option marks, and your classification as glyph and word, then `why` and `doDifferently` when set; the slide it revealed follows. Compact rows on screen; each stop's slide content prints.
- **Primary action:** `Give feedback`, a link to `feedbackUrl(feedbackCode)`, shown only when the room has a feedback code. Then `Download recap (PDF)` (the built-in tagged PDF, a lazy chunk loaded on press) and `Print recap` (browser print, always light).
- **Secondary actions:** `Live surface` browsing of the timeline.
- **Exact UI copy:**
  - Heading: `Your private recap`
  - Expiry, one line: `On this phone until {date and time}` (fallback `On this phone for 24 hours after the session`).
  - Sections: `Objectives`, then `The Case`, with one key: `slide` · `question` · `revealed by a question` · `your answer`.
  - Question rows: `{prompt}` · `Round {roundNo}` only when a question was asked more than once · `{your answer}` or `No answer`.
- **Must never appear:** other participants' names or answers, unused branches or unrevealed slides, a team or personal score, a certificate or CPD claim, how the route was chosen, and (in the PDF or `document.title`) the participant's name, a token or a URL.

---

## Closed responses and final room result

The projector receives a fixed anonymous `responseResult` only after an actual round closes. It contains the prompt, total answered and authored option labels/counts; ranking includes every allowed position and zeros. No suggestion, correctness, classification, rationale, route choice or participant identity is in this chart. Free-text pages contain twelve short answers, six longer answers, two medium answers or one long answer, with at most 500 characters combined. Phones retain their after-consequence `lastResult` timing and their own answer context.

- **Projector:** the chart is visible by default on close, before a clinical route is selected or revealed. Hide responses restores current revealed context. Show responses clears play names to keep its counts anonymous; closing responses does the same when visibility is enabled. Open, abandoned and void rounds have no chart, and replay suppresses it. A new round resets visible-on-close and page zero.
  - Single choice: per-option counts. Multi-select: `selected by {count}` and an explanation that each person could select more than one.
  - Ranking (Card25,2026-10-03): one selected identical complete response is one vertical column, using full authored glyph/colour/label tiles in original rank order and an aligned bottom count. At most two columns; overall total once. Exact18-response Other/Back shows10/5→2/1→10/5, with total18. Other requires two visible leading orders, at least two-thirds coverage and no second/third tie; fragmented/tied data uses ordinary pages. Authenticated direct group selection, Next positions and Next response orders are distinct, receipt-fenced,44px controls with pending/boundary states and useful focus restoration. Optional explicit meaning says Priority order/Action order; absent means Ranked order. Genuine empty says No responses submitted. Legacy missing tuples retain an honest marginal table, never invented orders.
  - Full200-character prompts/full120-character Latin, Unicode and unbroken labels fit loaded fonts at1280×720/1920×1080 in both themes. Ordinary short/long labels use3/2 positions respectively; prompts over100 characters use2/1, shared by authority/validator/control. Rank8 can cost eight deliberate pages. Full label/rank24px floors,40px marks and32px totals stay; no omission, ellipsis, scrolling or automatic cycle. Existing spacing fit can reduce gaps8→2px. Case title, full question, closed phase and footer stay visible; physical projector distance is still owner evidence.
  - Caption: grouped ranking shows `{total} responses overall` once, with original position/order ranges; legacy marginals retain `{total} answered` and honest position-count copy. The chart does not say which clinical route was chosen.
  - Free text: anonymous answer pages; `{total} answered · responses shown without names`, with Previous/Next controls on the facilitator console.
- **Phone:**
  - Single choice: `You chose {yourAnswer} · {count} of {total} chose the same`.
  - Multi-select: `You selected {yourAnswer} · {total} answered`.
  - Ranking: `You ranked {first option} first · {count} of {total} did the same`, followed by every option/position count, including zeros. The complete phone result scrolls normally; projector page choice does not hide phone rows.
  - Free text: `Your answer was submitted for room discussion`.
  - No answer from this phone: `You did not answer this one` (`No one answered this one` when nobody did).
  - Then the private final-result how-chosen line (`The room was split · The facilitator chose the route` for a tie); this line is not in the earlier anonymous projector chart.

## Layers

Manual room mode, presentation replay and (in a legacy room, CASE-255) discussion pause are **layers**, not phases (CASE-037). A layer changes how a phase renders; it never replaces the phase.

### Manual room mode (`manual` is set on the facilitator; `manual` is `true` on display and phone)

Entry needs confirmation. It is allowed at a stable boundary and also inside an open or locked round (or a legacy pause taken from one), where the same command voids that round. It is refused once a path is selected, or in a legacy pause taken from `path_selected`.

- **Facilitator console:** a persistent banner `Manual room mode · phone votes and recap capture are unavailable until connectivity returns`. Entry dialog: `Enter manual room mode?` · `This starts a new epoch on this device. Phones cannot vote. You lead the discussion and choose routes.` Inside a round the dialog adds `This cancels the open round. Its answers are discarded.` Buttons `Enter manual room mode` and `Cancel`. In a decision the primary action becomes `Select route`, listing authored paths only, with `resolutionKind` shown as `Manual room`. A text field `Add marker` (`manual_marker`, 200 characters) records a verbal marker; the marker text stays on this device and is not journaled. `Resume online` (`resume_online`) is shown unless `actions` omits it (never while `path_selected`: `Reveal or clear the selection first`).
- **Projector (dual-display):** the display follows the console locally and shows `Manual room mode · facilitator-led discussion` as a banner, in place of any `Team decision open` banner.
- **Projector (separate display):** freezes on its last surface; after 15 s without contact see the Connection states section.
- **Phone, still online:** once it receives a server-confirmed manual projection, it shows `Facilitator-led discussion · phone answers are off for now`, hides voting, and keeps revealed material browsable. During a facilitator-only local outage, a separate online phone can remain on the server's previous phase until the manual segment is accepted; it must not claim to know the offline facilitator state.
- **Phone, in a total outage:** it cannot learn of manual mode and shows `Connection lost · follow the room`.
- **Connection back (CASE-094):** the manual banner changes to `Connection back · Rejoin online when ready`. Nothing uploads until the facilitator chooses to rejoin. The available Rejoin/Retry control remains disabled until the actual transport is online, and while the upload or another console action is busy; browser connectivity alone does not enable it. During the immutable upload, mutation controls such as `Add spoken marker` are absent; `Download your notes` remains available.
- **Rejoin refused (CASE-095):** a dialog reads `The room moved on while you were offline` · `Another device took over, so your offline choices were not applied.` · buttons `Download your notes` (plain text: markers and route choices, generated on this device) and `Follow the room` (primary). There is no force option.
- **Resume online:** the console shows `Rejoin online at the next decision` as the recovery tray's main control; a fresh decision opens, never the voided one. Phones show a timeline segment marked `Facilitator-led discussion` (from `timeline[].manual`); no spoken choices or votes are reconstructed.

### Presentation replay (`replay` is `true` on display; `display.cursor` on facilitator)

Only `displayRevision` changes. The phones and the facilitator's phase do not.

- **Facilitator console:** every already-public timeline entry is a labelled, keyboard-accessible row button, including repeated checkpoint surfaces. Fixed `Back`, `Live surface`, `Forward` positions and `Presentation replay · phones remain on live surface` identify the selected projector entry. The room-visible card shows precisely that entry's public groups; live notes and cues remain separately private. The primary action is unchanged and still acts on the live phase. Outside focused controls and editors, Left Arrow browses backward; Right Arrow, Space and Enter browse forward in replay or reveal the next group when live. These keys never select a route or advance a clinical consequence automatically.
- **Projector:** a persistent banner `Presentation replay · phones remain on live surface` over the replayed surface, which can be any already-public surface including a terminal one. The `Live surface` return clears it. A new shared reveal advances the live room and phones, while the projector keeps the replayed surface and banner until the facilitator explicitly chooses `Live surface` (AS-038).
- **Phone:** no change. It stays on the live surface and is never forced to replay. Replay is never visible on the phone.

### Discussion pause (`phase` is `discussion_paused`; legacy rooms only, CASE-255)

- **Facilitator console:** see the `discussion_paused` subsection: `Resume`, frozen `timer`, the stored `resumePhase`.
- **Projector:** `Discussion pause` banner over the retained surface. No vote hint.
- **Phone:** `Discussion pause`; revealed material stays browsable. Paused mid-vote, it shows `Paused · your answer is held` and the vote control cannot change until resume. Any answer sent during the pause returns `paused_held` (see the answer lifecycle).

---

## Participant answer lifecycle

The phone never claims success before an explicit receipt. Receipts are announced in a `role=status` region; `rejected` and `locked` use `role=alert`. `Sending…`, `Updating · checking the room…` and `Waiting for connection` are announced too (status, not alert). The in-flight answer is held locally with its `clientEventId` until a receipt resolves it. A receipt reaches the phone by the transport that carried the vote (an HTTPS `POST`; the socket is only for updates).

| Receipt | Exact phone copy | What the phone does next |
|---|---|---|
| (sending) | `Sending…` with a spinner icon and the control disabled | Keep the answer, same `clientEventId`. If offline, show `Waiting for connection · your answer will send automatically` and retry with the same id and backoff. |
| `accepted` | `Answer saved · you can change it until responses lock` | Clear the pending item. Keep the answer visible and editable. A change posts with a new `clientEventId`. |
| `already_accepted` | `Answer saved · already received` | Treat as `accepted`. Never show a duplicate or an error. |
| `locked` | With a saved answer: `Voting locked · your last saved answer stands`. With none: `Voting locked · no answer was recorded from this phone` | Drop the pending item. Disable the control and refetch the snapshot, which carries `status` `locked`. Do not retry. |
| `paused_held` | `Paused · your answer is held` | Keep the pending item with the same `clientEventId`. Do not retry during the pause. Resend automatically when the projection returns `decision.status` `open`. If the round has since locked, show the `locked` copy. |
| `stale_epoch` | `Updating · checking the room…` | Refetch the snapshot. If the same `roundId` is still open under the new `epoch`, resend with the same `clientEventId` and the new `epoch`. If not, drop the pending item and show the copy for the new state. |
| `rejected` | `Answer not saved · check your choice and try again` | Never retry automatically. Keep the choice on screen with the control enabled. The reason changes the copy: `round_voided` shows `Round cancelled · the facilitator will open a new round` and drops the pending item; `client_event_id_reused` refetches the snapshot; `manual_room` shows `Facilitator-led discussion · answers are off for now`; `unknown_participant` shows `You were removed from this room`; `room_ended` shows `This room has ended`; `bad_response` or `unknown_round` refetches the snapshot, then shows the current state. |

A round that is voided mid-answer: the phone drops the pending item and shows `Round cancelled · the facilitator will open a new round`. The state is driven by `lastRound.status === 'abandoned'` (Spec gaps 5) or a `round_voided` receipt. A vote for a voided round is rejected with `round_voided`. A voided round keeps no answers anywhere, so nothing from it reaches a recap.

---

## Connection states

Transport order is WebSocket, then long-poll `updates?after=<revision>&wait=`, then jittered short polling while foregrounded. A display starts on long-poll and tries the socket later; a network whose sockets keep stalling is pinned to long-poll for a day (CASE-100). Every state is shown with an icon and text. A foreground or resume always verifies `revision` against a fresh snapshot before trusting a suspended socket (`Checking the room…`, shown for at most a moment). The heartbeat catches a silent socket that reports open, and the room-answered `sync` frame catches a socket whose room no longer answers.

| State | Facilitator console | Projector display | Participant phone |
|---|---|---|---|
| Connecting | Run strip: `Connecting…`; controls disabled | Footer: `Connecting…` | Chip: `Connecting…`; vote control disabled |
| Live over WebSocket | Run strip: `Live` (icon plus text); no banner | No indicator | No indicator (the participant never sees the facilitator's connection state) |
| Degraded over long-poll | Run strip: `Live · slower updates`; tray notes `Display: long-poll` | No indicator; long-poll is the expected path behind a hospital proxy | Chip: `Connected · updates may lag a few seconds`; votes still post with receipts |
| Reconnecting | Run strip: `Reconnecting…`; the console keeps showing the last `revision`; commands are queued only for the facilitator-local manual flow, otherwise disabled | Footer: `Reconnecting…`; keeps the last surface | Chip: `Reconnecting…`; the pending answer is kept; the control stays disabled until the snapshot returns |
| Connection lost | Banner: `Offline · Switch to manual room`, with the recovery hint `When you reconnect, rejoin online at the next decision`. `Switch to manual room` is one local action, available even mid-vote; it voids the round itself | After 15 s on a separate display: `Connection lost · follow the facilitator`. On a dual display the window follows the console. | `Connection lost · follow the room`; revealed material stays; answering disabled; the held answer is resent on reconnect |
| Re-pair | Tray shows `Display re-paired` and the display's `displayRevision` | New window shows the latest public snapshot, silent until its sound chip is pressed; no case change | Unchanged |

**The facilitator's recovery tray** is the `Manual room` card in the side rail while manual mode is on (console layout v2). It shows three lines: `Display: {Projector is showing | Projector window open | Not paired}` (the window is known from its BroadcastChannel hello), `Revision {revision} · epoch {epoch}`, and `Events: {n} pending · {n} sent`. In manual mode it holds `Rejoin online at the next decision` (`resume_online`) as the single main control (the recovery hint itself lives in the Offline banner, not in this drawer). It never claims `Reconciled`; after recovery it lists what happened: `Round closed as abandoned`, `Manual choices recorded`, `New epoch`. Pending and sent counts are local to the facilitator device (Spec gaps 4).

---

## Stale tab and device takeover

A facilitator who opens the console on a second device sees `Take over this room` with a confirmation. Confirming sends `takeover`, which bumps `epoch` and fences every older facilitator tab. The old tab then shows `This room is now controlled from another device` with no controls. Phones and the projector are unchanged.

---

## Participant feedback page (`/F/<code>`, CASE-284)

- **Shows:** the case title, `Version {n} · {date}`, `Anonymous`, then three rating groups of five numbered buttons (`{n} of 5`, pressed state; pressing the chosen value again clears it): `How useful was this session for you?` (`Not useful` … `Very useful`), `How realistic and relevant was the case?` (`Not at all` … `Very`), `How easy was Case to use on your phone?` (`Very hard` … `Very easy`). A closed `Add a comment (optional)` disclosure holds `One thing you'll do differently` and `One thing to improve` (280 characters each, a live `{k} of 280` counter and the CASE-105 identifier warning), an About choice (`This session` · `The case` · `The app`) and `Please don't include names.`
- **Primary action:** none since room PDFs v2 (CASE-289): ratings save 2 s after the last tap and text on blur (`Saving…`, then `Saved · you can change it until {time}`); `Download participant record (PDF)` (`Making PDF…` while busy). `Organisation evaluation form` with `Opens {host}` when a form link is set.
- **States:** `That code isn't right · check it against the projector` with a `Feedback code` field and `Continue`; `Feedback opens when the session ends.` (rechecks for a few minutes; a room in Debrief counts as ended, CASE-291); `Feedback for this session has closed.`; `Feedback is unavailable · try again shortly` with `Try again`; `Not sent yet · trying again`; `Not sent · check your connection and try again`; `This session isn't taking more responses.`; `This response can't be changed again.`; `Your feedback changed elsewhere · showing the latest`; `Couldn't check this browser · try again`; `Choose a rating or write a comment`.
- **Participant record (D7; room PDFs v2, CASE-289).** The Finish block's white card `Your participant record`: the case's braid, stats (`min`, `decisions`, `objectives`), `You and the room · {n}` folded, `I can now` chips pre-ticked, `My Takehome` with a `Share anonymously` switch (on), and the summary row `Your details · {name} · {hours} · {activity} · Edit`, which opens `Your name`, `Facilitator and organisation` (prefilled with the room's `Name, Role` on record, editable), `Location or group`, `Hours` (prefilled from the session length) and the activity type. Typed fields stay on the phone.
- **Participant record PDF (A4, always light).** A dark mosaic masthead with the CASE chip and `Participant record · {date}`; the title in petrol; the details card (Participant, Facilitator and Location when typed; Date; Hours · activity; Decisions; Case; Format); Objectives, each beside a ticked or empty box in its own column; My Takehome when written; the disclaimer in a grey card above the footer; footer `case.iatrogenic.app · {case title} · n / N`. File `{case title} – Participant record – {date}.pdf`.
- **Must never appear:** a name (other than the one the participant types into their own record), another person's answer, a score or average, a certificate, accreditation or CPD-points claim, or any credential in the URL.

## Join flow

1. **Entry routes.** The projector shows the QR, the short URL and the room code together, as equivalent routes. The short URL is `case.iatrogenic.app/J/7K3QX9` (upper case in the QR). The code is shown spaced: `7K3 QX9`, in a large type size.
2. **Code input.** The field is labelled `Room code`, allows exactly six Crockford characters and has an alphanumeric keyboard. Six placeholder positions and a character count show the required length. Typing and pasting uppercase the input, normalise aliases, remove separators and invalid characters, and cap it at six characters; editing preserves the caret. It accepts lower case, spaces and hyphens; it reads `O` as `0` and `I` or `L` as `1` (the same normalisation as `normalizeCode` in `src/shared/ids.mjs`). Typed `7k3-qx9` joins the same room as `7K3 QX9`. An invalid code reads `That code isn't right · check it against the projector`.
3. **Code and name required; avatar selection optional (CASE-119, CASE-121, CASE-135; Julian, 2026-10-02).** Heading `Join the case`. Field `Your name`: 3 to 20 characters after trimming and collapsing spaces; letters (any script), numbers, spaces, hyphens and apostrophes; at least one letter or number; duplicates allowed. A counter reads `{n} of 20`; the adjacent hint says `Do not enter patient details.` The phone says what is wrong before sending, once you have typed or pressed the button: `Enter a name the room can call you`, `Use at least 3 characters`, `Use at most 20 characters`, `Use letters, numbers, spaces, hyphens or apostrophes`. Then `Choose an avatar`: the 16 vendored DiceBear "Shadows" drawings (CASE-120), each with a spoken label (`Wine, curls`, `Teal, quiff`, …), followed by a final `Randomise` action. A preview shows the chosen avatar beside the name. If none is selected, the phone assigns a random allow-listed avatar on submit; only the valid code and name block joining. One button: `Join case` (primary). There is no nameless join. The server checks both again (`parseJoinRequest`: `bad_display_name`, `unsafe_characters`, `bad_avatar`), and the rename envelope applies the same name rule. The join footer has a tertiary `Privacy` link with a 44 px tap target. It opens `prototypes/room/privacy.html` in the same tab; `Back to join` restores the typed room code from a session-scoped draft.

   The privacy page has headed sections: Who runs Case; What we collect; Who sees it; Where it is stored; How long we keep it; What not to enter; Your choices; Contact. It explains the 25-hour personal-data deletion bound and the 7-day backups and connection-log bound (CASE-107, CASE-123). The archive keeps names and per-person answers until its purge, as planned (Julian, 2026-10-01). Card 13 ports the production `/privacy` route; the prototype page is part of the offline shell. Exact retention copy: `Names and per-person answers in the live room and session records are deleted within 25 hours after the session ends. Encrypted backups and connection logs expire within 7 days.`. Separate anonymous-metrics copy: `Anonymous usage and connection metrics are retained for three months. These analytics points contain no names, answers, room or participant IDs, tokens, IP addresses or URLs.`. Separate join-check disclosure: `After repeated incorrect room codes, Cloudflare Turnstile may check this join page. Its script has access to this document and may read the entered room code, display name, avatar and browser storage. Cloudflare also processes network information such as your IP address. The check does not run in the session play or recap page.`. This is a disclosure contract, not evidence that a live deployment has been configured.

   Before the Join action: `Your name and avatar appear on the projector in the lobby.` No checkbox is added.

   Exact visibility notice: `The facilitator sees your name, avatar and answers. Names and avatars appear in the projector lobby. During play, avatars appear; names require Show names. Closed responses, including free text, appear without names on the projector. The facilitator can hide them.`.

   Names with control or bidi characters are refused before sending, and are cleaned again on every screen. In the waiting lobby and the header menu, `Change name or avatar` offers independent `Avatar colour` (eight named colours) and `Avatar shape` (the sixteen silhouettes) radio groups, a preview, and `Save changes`. The original sixteen IDs remain stable; the 128 colour/shape combinations use allow-listed static local SVGs and are cached offline. A confirmed save updates the participant’s own header immediately and collapses the name/avatar editor back to the previous surface with the saved values. A failed save leaves the editor open. Names and avatars appear on the projector in the lobby. During play, avatars appear anonymously until `Show names`. When a name or a free-text answer looks like a patient identifier (a Medicare or IHI number, a date of birth, `Mr`/`Mrs`/`Ms` with a surname, a record number), a soft warning shows under the field: `This looks like it may contain {kinds}. Do not enter patient details.` It never blocks sending (`src/shared/identifiers.mjs`, CASE-105).
4. **Limited browsers.** In a captive-portal sheet the QR still joins by URL or code. The sheet shows `Open in your browser or use mobile data if this page won't load`. The projector carries no phone-connectivity advice (CASE-122): connectivity is checked before the session with the network check. A separate display does show its own `Connection lost · follow the facilitator` notice after 15 seconds without transport contact (Projector display).
5. **Late join.** A late joiner lands on `Live surface`, with every already-revealed surface on the path available in the `timeline`. There is no replay animation and no separate unlock flow. The first screen is the room's current public phase (a vote in progress shows the decision, with `Round {roundNo}`). No future or unused-branch material is sent.
6. **Joining closed.** The facilitator control is `Close joining` / `Reopen joining` (`close_joining`, driven by the facilitator projection field `joiningClosed`). While closed, a new join is refused and the phone shows `This room is not accepting new participants`. People already in the room are unaffected.
7. **Rejoin.** The phone keeps its capability in localStorage until recap expiry (CASE-106). A returning session URL or the same QR first validates the bounded saved queue and calls the same-origin recovery preflight; successful recovery binds the existing room without a new join or duplicate participant. Only the actual server participant identity permits private draft restoration and replay. While unavailable, it shows `Recovery unavailable`, validated unsent counts and explicit `Retry`; it does not join or display old drafts. Refusal, code reuse, token loss or expiry clears the old capability and queue before fresh join. A cleared browser loses its saved place. A returning session play/recap URL with a missing or expired capability says `This browser no longer has your saved place. To rejoin a room that is still open, enter its code.` (new Card 13 copy accepted in root review, 2026-10-02), alongside the existing limited-browser hint. This guidance is not shown for transient recovery unavailability or an ordinary fresh QR join. Joins are not epoch-fenced. An active participant who is removed sees `You were removed from this room`.
8. **Unsent answers.** A visible `Not sent yet · {n}` accompanies the bounded twenty-envelope per-room queue. Changed answers supersede older answers in the same round; uncertain delivery retries preserve their id. Reloaded offline phones show counts only until server identity confirmation. A closed IndexedDB handle reopens once. Recap expiry invokes the common cleanup path. Ranking up/down/remove controls use named glyph buttons in one row, each at least 44 px.

---

## Display check and `Show names`

### Dual-display check (CASE-034)

The facilitator's console and the projector window share one PC and one browser. Before `Start case`, the second screen shows `Projector`, and the console shows the display check card from the lobby section. The facilitator may confirm that the console is **not** visible to the room, helping identify Windows duplicate mode (which projects cues and rationale). The advice renews when a display disconnects, re-pairs, or changes, but it never blocks Start case (Julian, 2026-10-07).

- Confirm button: `Projector only · ready` dismisses the advisory check; Start case is already available.
- Failure path: `Check projector again` re-shows the word `Projector` on the second screen; `Console visible · fix display` opens the guidance `Switch Windows to "Extend these displays", then check again.`
- The check is a facilitator-device concern. It is not a projection field (Spec gaps 4). On a separate paired display there is no check card; the console shows `Display: {state}` in the tray instead.
- The case pack stays in memory only on this machine and is purged on `ended`, sign-out and tab close.
- **Opening the projector window (CASE-102, CASE-103).** `Open projector window` opens it with `noopener`; the window says hello over BroadcastChannel. If it has not within 3 s (a pop-up blocker), the card shows `The projector window did not open` · `The browser may have blocked it. Open this link in a new window, drag it to the second screen and make it full screen:` and the link. The link carries no token.
- **One screen (`screen.isExtended === false`).** The card adds `This computer is showing one screen` · `If the projector mirrors this screen, the room would see your notes. Either switch Windows to "Extend these displays" (Windows key + P), or run the console on your phone and keep this computer for the projector only.` It is a suggestion, never a block, and the console stays the default (Julian, CASE-102).
- **Screen kept awake.** The console and the projector hold a Screen Wake Lock while visible. Some hospital PCs refuse it, so the pre-session checklist still covers the screensaver.

### Pre-session checklist (facilitator)

Shown on the console's lobby help and in the facilitator guide. Before the room opens:
1. **Run the network check** (`prototypes/room/check.html`, the planned `/check` route) on the projector PC and on a phone on the hospital Wi-Fi. If live updates are blocked, Case still works; send IT the note in `docs/IT-NOTE.md` for next time.
2. **Turn off the screensaver and sleep** for the session, or use the PC's presentation mode (Windows: Mobility Center, `Presentation settings`, or `Settings > System > Power`), so the projector does not dim mid-case. Case asks the browser to keep the screen awake, but some hospital PCs refuse.
3. **Extend, don't duplicate** (Windows key + P, `Extend`), then run the display check. If the PC can only duplicate, run the console on your phone.
4. **Use Edge or Chrome.** Other browsers, and Internet Explorer, show `Open this page in Microsoft Edge or Google Chrome`.
5. **Allow pop-ups** for Case, or be ready to open the projector link by hand.
6. **Keep the console open; do not reload it during an outage.** The case lives only in its memory; a reload during an outage keeps your manual notes but not the case (`docs/RUNBOOK-INCIDENT.md`).

### `Show names` (CASE-038)

- The console toggle reads `Show names on projector` when `namesShown` is false and `Hide names on projector` when it is true (`show_names` with `on`). The automatic lobby roster has no Show/Hide names control. During play, Show names is unavailable while a closed chart is visible: Hide responses first. Hide names remains available for an existing names choice.
- Confirmation on show: `Show participants' display names on the projector?` with a preview of the chips that would appear (avatar + name, at most 12, then `+ {n} more`).
- The lobby always shows cleaned names with avatars. During play, `names` is `null` until the facilitator acts. Show names displays only avatar-and-name chips headed `In the room`; names are never paired with answers.
- The facilitator console always shows names and current answers privately; the toggle governs only the projector.
- While names are shown, the live responded count is hidden. Closing responses with chart visibility enabled clears play names; Show responses also clears names. Hide responses before Show names. Public projections and strict frame validation never combine a named roster with either closed count representation; anonymous avatars are also withheld while a chart is visible. Replay may show names while its chart is suppressed, but returning to Live restores the anonymous chart without a named roster and preserves the saved page/visibility choice.
- The roster has a per-name `Hide name` control that withholds one name from the projector list. It is client-local unless the owner decides it must be shared (Spec gaps 9).

---

## Accessibility

- **Text plus icon, never colour alone.** Each path classification (the six rows below), each receipt, each connection state, and each phase chip pairs a distinct icon shape with its text label. Selection uses a check icon and a label as well as the petrol fill. A greyed `disabled` option also carries the text `Already explored`. Light and dark themes both pass this test with colour removed.

  | `classification` | Exact label | Icon |
  |---|---|---|
  | `sound` | `Sound` | filled circle with a check |
  | `defensible` | `Defensible` | outlined circle with a check |
  | `context-dependent` | `Context-dependent` | fork (two branches) |
  | `unsafe` | `Unsafe · recoverable` | triangle with an exclamation mark |
  | `terminal-unsafe` | `Terminal · needs a checkpoint reset` | octagon with a bar |
  | `discussion-prompt` | `Discussion prompt` | speech bubble |
- **`prefers-reduced-motion`.** With the preference set, reveals cut instead of animating, the decision-window pulse becomes a static `Team decision open` label, auto-follow to a new live surface is an instant swap with the `New material shared` line, and no content depends on animation. The display's reduced-effects setting does the same for effects and audio cues.
- **Focus order.** Facilitator console: the header row, then the main area (Room sees, the divider, Only you, the decision panel with the phase card, its secondary actions and conditional detail, then the presentation strip), the side rail top to bottom, and the bottom bar (Undo, the primary action, Room sound); Room setup, when open, follows the header in reading order. Phone: header, status chip, live surface or decision heading, prompt, answer controls, `Send answer`, `Live surface`, timeline. Opening a dialog or sheet moves focus into it and returns it on close. Ranking uses `Move up` and `Move down` buttons as the primary interaction; drag is optional. A new live surface announces its heading with a polite live region; a lock, a pause and a connection loss use an assertive region only when an action is no longer possible.
- **Touch targets.** Every interactive control on phone and console is at least 44 by 44 px with at least 8 px between targets. Option rows are fully tappable. The `Live surface` control is fixed-position and always reachable.
- **Projector legibility at the back of a room.** Design for a 1920 by 1080 canvas read from about 8 m. Narrative body text and options are at least 24 px (CASE-083), with one 1280 × 720 exception: Findings may step down to 18 px and then truncate visibly (CASE-134). Observation values are at least 28 px (36 px at 1920), the lobby room code at least 96 px with its QR at least 25% of viewport height, and the compact play footer's code at least 28 px (Julian's card 14 clarification). Text never scrolls on the projector. Contrast is at least 7:1 for body text. Avoid light-on-light and thin weights, keep line length near 60 characters, and do not rely on small footers (the bottom row's URL is at least 24 px, its labels 18 px). Light or dark theme may be used; both must meet these limits.

- **Advisory timer.** When `timer` is set the room sees text only: `About {n} minutes left`, `About 1 minute left`, `Less than 30 seconds left`, `10 seconds left`, `Time is up`. Every screen takes the seconds and the words from `src/shared/timer.mjs`: seconds round up, minutes round to the nearest minute, so 1:15 is `About 1 minute left` on the projector and on every phone (walkthrough bug 3). It is announced politely (`role=status`) only at 60 s, 10 s and 0, never every second. There is no pulse and no colour change at any threshold, and the timer never locks anything. **CASE-335 (Julian):** the projector shows the countdown as digits only, top right, with a ring of the time left, a one-shot pulse as 60 s and 30 s pass and a pop on each of the final ten seconds (never flashing; reduced motion keeps every state still), and a `Time up` chip at zero while answers stay open; announcements keep the words above. Phones read `Time is up · you can still answer`. The console's player shows a ring clock with `m:ss` and `of {length}`, read from the deadline every quarter second; at zero `Time up` with `Answers still open`. Room sees refreshes the same countdown.
- **Docked controls never hide focus (WCAG 2.4.11).** The console's sticky run strip and fixed action dock, and the phone's sticky header and fixed `Live surface` bar, are matched by `scroll-padding` so a focused control scrolls clear of them.
- **Option marks meet 3:1 (WCAG 1.4.11), with one recorded exception.** Every mark is at least 3:1 against the ground, surface and sunken backgrounds and its own tile, in both themes (the yellow by its dark edge), and option text is 7:1 on its tile. Every glyph is white; on the true yellow that is under 3:1, the named exception `yellow-mark-white-glyph` (CASE-115) in `tests/contrast.test.mjs`.
- **Contrast.** Console and phone body text is at least 7:1. Disabled text is at least 4.5:1. A forced-colours (`forced-colors: active`) mode keeps every icon, label, border and focus ring visible in system colours.
- **Sound (CASE-171).** Three separate sound surfaces, all silent by default:
  - **Projector event cues (CASE-184, 2026-10-07)** are `decision opened` and `reveal`, nothing else; each plays the library's wood tone (or the old neutral tone if the sample is unavailable), only while the display page is visible and motion is not reduced. Restoring already presented material after showing the join screen is silent, including private phase changes behind it; genuine initial publication remains audible when enabled. The join screen reads `Join the case`, with the room count and no waiting-to-start label. The default is silent until the sound chip (`Room sound`) is pressed on that display. A native range slider named `Room sound volume` beside the chip scales these cues (0-100%, default 100%), persists per device as a local preference, and never overrides mute. During a room the console offers `Mute same-PC projector`; it sends only an off request scoped to that room and reports acknowledgement or failure. It cannot enable sound remotely. On a separately paired display, use that display's own `Room sound` chip to mute it. Pending sound loads are cancelled when the publication is superseded or sound is muted; cached samples remain reusable and count/timer-only updates preserve genuine pending cues.
  - **Console UI tones** (press, panel open, panel close) play only on the facilitator console, gated by the console's own `Console sounds` toggle (off by default; pressing it is the gesture). They respect reduced motion and page visibility, load on demand, and are skipped if a sample fails to load. The toggle itself is silent. Phones and the projector never play them.
  - **Phones** are silent. No music beds exist. No cue is celebratory or punitive.

---

## Spec gaps

These are the gaps the first draft of this document found in `project()`, and how each was resolved on 2026-10-01. Where a screen section above still works around one of them, that section predates the fix; the projection now provides the field.

| # | Gap | Resolution |
|---|---|---|
| 1 | Checkpoint beat for `Reset to {checkpoint}` | **Added.** Facilitator `terminal: { pathId, debriefPrompt, checkpointBeat: { id, title } }`. |
| 2 | `caseTitle` / case version on every role | **Added.** `caseTitle` and `caseVersionNo` on all three projections; `caseVersionNo` comes from `initialState({ caseVersionNo })`. |
| 3 | `endedAt` and recap expiry | **Added.** `endedAt` and `recapExpiresAt` (`endedAt` + 24 h, CASE-043) on all projections, plus `recap.expiresAt`. |
| 4 | Display and facilitator-device health: display check, pairing and transport health, sound enabled, outbox | **Client-local by design.** These describe a device and its connection, not the room. Each client tracks them locally and does not round-trip them through the authority. The recovery tray reads the facilitator device's own outbox. |
| 5 | Phone told its round was voided | **Added.** Participant `lastRound: { roundId, roundNo, status }`; `status: 'abandoned'` shows `Round cancelled`. |
| 6 | Recap content | **Added.** `recap: { caseTitle, caseVersionNo, expiresAt, learningPoints, teamPath, rounds: [{ prompt, roundNo, status, yourResponse, yourAnswer (labels), whatHappened }] }`. No other participant's data appears; a test proves this. |
| 7 | Debrief summary on the display at `ended` | **Covered by the case.** The final beat is a `debrief` surface, and the display shows it as its last `surface`. |
| 8 | Timer on the display and phones | **Added.** Advisory `timer` (`{ paused, endsAt }` or `{ paused, remainingS }`) on display and participant, only while a round is open. It never locks anything by itself. |
| 9 | Per-name `Hide name` on the roster | **Open.** Client-local for now (the projection has no per-name flag); needs an owner decision if it must be shared across tabs. |
| 10 | Open questions for Julian | **Resolved 2026-10-01.** Projector text: smaller type, 24 px minimum body (CASE-083). Named answers stay live on the console (CASE-084). Gap 9 (`Hide name`) remains client-local. |

## Administrator surface (Card 21b; AS-087)

The noindex `/admin` entry uses Case typography, petrol and existing tokens. A left section list selects Facilitators, Cases, Live rooms or Audit. Paged tables show fixed metadata; selecting a row opens its detail panel. Loading, sign-in, admin-only and unavailable states are distinct. No clinical pack or named participant answer is rendered.

Invite and search use labelled email forms. Destructive confirmation captures the selected target email/revision, requires typed confirmation and a fresh own-email code, and remains one flight. Native dialogs return keyboard focus to the invoking/current target control after cancel or completion. Error messages use fixed meanings, including compensation and reconciliation, without provider bodies.

Automatic reads preserve form drafts and stable row focus, pause during editing/selection/action/dialog, and stop after ten minutes idle with visible status. Activity refreshes; this is NEVER LOCK, not an Auth or UI lock. Sign-out/401/account change/pagehide clears private rows and retained DOM. Private data is not persisted or cached. Screenshots and axe cover 1920×1080 and 1366×768 in both themes; physical-device/hospital usability remains owner evidence.


## Beta issue privacy copy — 5 November 2026 (CASE-376)

Issue reports and optional screenshots are visible to deployment administrators and their reporter. Security or privacy incidents are restricted to the designated incident administrator. The browser picker captures a single unfiltered screenshot into a local draft; nothing uploads before Send. Preview or remove it before sending.

Unresolved issues are retained; evidence is deleted thirty days after resolution. Participant original prose, screenshots and identity links follow the room end plus twenty-four-hour deadline. A reviewed nonpersonal engineering summary may remain until thirty days after resolution. Anonymous report access ends with room capability. Contact requires your separate consent. Reports are not automatically sent to AI services.
