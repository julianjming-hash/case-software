#!/usr/bin/env node
// Initial per-entry Brotli limits are measured + 10% on 2026-10-02. Includes imported shared code.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { init, parse } from 'es-module-lexer';
import { buildClient } from './build-client.mjs';

// Card 10 check, Card 21a projector, Card 15 phone and Card 12 console/pair/app/SW
// measured feature closures. The app entry includes the current eager static graph.
// Every measured entry retains the same 10% ceiling headroom.
// Card21a projector46515 includes its central URL contract; narrow equivalent
// optimizations could not meet the former cap without obscuring source semantics.
// Card15 phone65704 replaces its prior59089 baseline; Card12's larger implemented
// console/pair/app/SW closures supersede their earlier sign-in-only placeholders.
export const BUDGET_DATE = '2026-10-09';
// Card21b standalone Admin measured24400 on reviewed21a+23 (2026-10-03);
// shared Auth/routes included, existing generic SW precaches public Admin assets.
// Card24 measured console90839/pair92419/app145723 replaces the actual implemented
// Card12 feature baselines. Versus reviewed f45 main, eager closures grow3194/3198/5288
// Brotli bytes for aggregate/paging/privacy authority and strict projection validation.
// Card25 measured projector52235 replaces46515 after actual full-text geometry and
// independent source review; reviewed Card24 main50087 grows2148 Brotli bytes.
// Public-only validation and layout co-location retain full text, strict checks and
// legacy summary; separate equivalent optimization or feature revert is the reversal.
// Card20 owner-approved measured SW9868 includes the reviewed public asset graph (CASE-151).
// Only its measured baseline changes; the same10% ceiling and all other entries stay fixed.
// CASE-158 (Julian, 2026-10-05): rebaseline console/projector/phone/pair/app/SW to their measured
// closures on the final Card20 + RT01-03 source, restoring the same 10% headroom (console and phone
// were within 0.3% of their caps). Admin and check are unchanged; the 10% formula is unchanged.
// CASE-166 (card 29; Julian, 2026-10-06, "trim first"): no baseline is raised. Each surface is a lazily
// imported chunk measured as its own static closure. `app` (the shared first load) is lowered to its
// measured size; home (room-code entry and splash) and library (catalogue and case detail) are budgeted at
// their measured closures. Route unions count each module once over the chunks a route loads: `/` (app ∪
// home) takes its measured size, and `/cases` (app ∪ console ∪ library) keeps the pre-split app ceiling
// 169381, so splitting cannot grow what a page loads. The 10% formula is unchanged for every baseline.
// CASE-171 (Julian, 2026-10-07, console UI tones): no existing cap is raised. The tones are a lazy chunk the console
// imports on first toggle, so they cost the console only its wiring; the chunk is its own entry (and a /cases route member).
// CASE-173 (card 36a, Julian's parity pass): no existing cap is raised. Help is a lazy page chunk and the braid renderer is a lazy
// `splash` chunk the phone imports only when it paints art, so neither enters the phone's first load. Each is its own entry,
// measured on its static closure (shared modules counted once per entry) with the same 10% formula.
// Card 30 (under CASE-166's rule; no existing cap raised): the Groups screen is a new lazy chunk, loaded by the
// library (owners at /cases, so it joins that union under the unchanged /cases ceiling) and by Administration,
// whose page now has its own union (`route:/admin`). Both new baselines are their measured closures; the 10%
// formula is unchanged.
// CASE-174 (card 36b, console and projector parity): no existing cap is raised. The console's cover and the
// projector's lobby and ended splash use 36a's shared lazy `splash` chunk (CASE-173), so the console lists it in
// /cases, and the projector's route, /display (app ∪ projector ∪ splash), is budgeted at its measured union. The console's Room tab (rendered only when that tab opens; preloaded at mount and
// precached) is a lazy chunk, `console-room-tab`, a /cases member at its measured closure, so the console fits its cap.
// Card 38 (CASE-175; no existing cap raised): facilitator session resilience (cross-tab session sharing, the
// console's rejoin, and the magic-link start moved out of auth.mjs) is one lazy `account-session` chunk, its own
// entry measured on its static closure with the 10% formula, and a member of the /cases and /admin routes. Two
// small console modules were folded into their importers so the service worker's shell list did not grow.
// CASE-192: Julian approved the new lazy music cap4096B and selected PCM inventory3801776B on2026-10-08.
// Measured modular closure3656B; charge it to the display union. All existing caps stay fixed.
// Builder editor is a separate /cases/:id/edit route: it is lazy from library and excluded from
// the catalogue union until navigation. Workflow and private preview views defer their heavier closures
// until explicit navigation while keeping the editor mounted. Hashed
// emitted sources: 06916d3f…9a870e17, ebc32b74…79c1f397, 7e228116…a024f55, ed296dc9…150961e9,
// CSS 3f78b8b4…96c43065.
// These
// are Brotli closures from the emitted hashed assets; new chunk caps retain 10% headroom. Edit
// route is capped at the existing 169381B catalogue ceiling; no existing route cap is raised.
// CASE-200: Julian explicitly approved measured private allocations plus 10% on2026-10-09:
// Admin30190, Admin union104549, Account/History unions138386 and their new lazy chunks.
// Existing Cases, Builder, teaching-room and public-client ceilings remain unchanged.
// Card 51 (CASE-166 rule): the new lazy chunks builder-slide-check, builder-slides and builder-slides-css carry their own
// measured baselines (2026-10-11); builder-slides loads only in the editor view. No existing cap is raised.
// Card 52: builder-inspection (the private inspection window) has its own measured baseline and loads only from the
// editor view's Inspect button. No existing cap is raised.
// Builder redesign to the Round 4 study (Julian, 2026-10-11): builder-shell (app bar, menus, contexts, overview, history
// wiring) and builder-shell-css are new lazy chunks of every edit route; builder-fit (the projector-frame measurement the
// preview window and the Builder's fit status share) is a lazy chunk the shell loads on first measurement. Each carries its
// measured closure as baseline (CASE-166 rule). No existing cap is raised; studio code moved out to stay inside its cap.
// Builder parity (CASE-218, Julian 2026-10-11: per-PR rebaseline of Builder chunks and edit routes to measured + 10%):
// builder-studio 27,059, builder-shell 8,421, builder-shell-css 3,707 and the /edit/preview union (174,242 → cap 191,667).
// CASE-219 (same approval): builder-shell-css 4,554 and builder-route 43,915 for the polish, rehearsal and preview-notice round.
// CASE-221 (same approval): builder-workflows 43,834 now that transfer carries slide drafts.
// CASE-223 (same approval): builder-shell-css 5,250 for the critical-review polish round (cap 5,776).
// CASE-225 (same approval): builder-studio 31,334 (Case's accessible dropdown now loads with the Builder) and
// builder-slides-css 1,379 (fill and text colour from the tokenised slide palette).
// CASE-226 Run preview (Julian 2026-10-12: real phone screen, route caps for /cases, facilitate and /edit/preview may rise to
// measured + 10%; Builder chunks and edit routes under the CASE-218 per-PR approval): builder-inspection is now the Run
// preview — room machine, projector and phone renderers, console teaching controls — at 91,322 (cap 100,455); its layout
// ships in console.css. Route caps (measured → cap): /cases 191,864 → 211,051, /edit 250,636 → 275,700, /edit/preview
// 229,524 → 252,477, facilitate 214,535 → 235,989. console-preview, builder-preview and builder-preview-popout are gone.
// CASE-229 Builder rounds 7–8 (same CASE-218 approval): builder-shell-css 5,819 (cap 6,401) for the audit's polish rules;
// builder-fit 34,390 (cap 37,829): the fit check draws a decision's results with the room's own results renderer.
// CASE-241 Builder polish round 17 (same CASE-218 approval, confirmed for this PR): builder-shell-css 6,752 (cap 7,428).
// CASE-249 Builder round 25 (Julian, 2026-10-14): route:/cases/:id/edit rebaselined CASE-218-style to measured + 10% (276,619 → cap 304,281);
// the new lazy keymap-sheet chunk (the ? sheet of the shared keymap) budgeted at measured + 10% (1,661 → 1,828).
// CASE-227 presentation themes (same CASE-218 approval): builder-slide-check 6,604 (cap 7,265) now that the slide validator
// knows the named themes. The served slide chunks (slide-render, projector-slides) are unchanged: themes live in their own module.
// Card 57 served slides: projector-slides (display route) and slide-render (phone) are lazy entries with measured
// baselines; the console preview's slide check loads for slide cases and is charged to /cases, facilitate and preview. No cap is raised.
// CASE-258 Builder round 27 (Julian, 2026-10-15): D15/D16 clarification slides live in the studio chunk. builder-studio
// rebaselined to 39,062 (cap 42,969) and route:/cases/:id/edit/workflows capped at 171,267 + 10% = 188,394; no other cap changes.
// CASE-263 (Julian, 2026-10-15, measured + 10%): slide-render 4,005 → 4,406; projector-slides 4,769 → 5,246; builder-slide-check 8,036 → 8,840; builder-inspection 100,557 → 110,613; builder-fit 38,914 → 42,806; builder-slides 43,158 → 47,474; pair 110,785 → 121,864; route:/cases/:id/edit/preview 254,412 → 279,854.
// CASE-264 hero slides (Julian, 2026-10-15, "Approve 5,400"): projector-slides 5,246 → 5,400 (measured 5,367: the hero fit pass,
// its grid-column span for exact parity, and the font-load refit). No other cap changes.
// CASE-268 (Julian, 2026-10-15, measured + 10%): slide-render 4,711 → 5,183; projector-slides 5,478 → 6,026; builder-media 11,177 → 12,295.
// CASE-269 (Julian, 2026-10-15, measured + 10%): projector 60,451 → 66,497; route:/display 89,773 → 98,751.
// CASE-269 video playback, GIF and recap images (Julian, 2026-10-15, measured + 10%): session-export 22,475 → 24,723; session-detail 22,680 → 24,948; projector-slides 6,321 → 6,954; phone 79,251 → 87,177; route:/cases/:id/edit 305,538 → 336,092.
// CASE-269 with the hero merged (Julian, 2026-10-15, measured + 10%): slide-render 5,332 → 5,866; projector-slides 6,930 → 7,623 (supersedes 6,699).
// CASE-268 GIF and video (Julian, 2026-10-15, measured + 10%): builder-media 13,779 → 15,157; new lazy media-gif 1,070 → 1,177 and media-mp4 2,556 → 2,812 (loaded only when a GIF or video is chosen).
// CASE-268 with CASE-264 hero merged (Julian, 2026-10-15, measured + 10%): projector-slides 6,090 → 6,699 (supersedes 5,400 and 6,026); builder-slide-check 9,238 → 10,162; builder-slides 48,387 → 53,226; route:/cases/:id/edit 304,952 → 335,448.
// CASE-268 red-team S1-S4 and re-check (Julian, 2026-10-16, approved 3,335; measured + 10%): media-mp4 2,812 → 3,335 (bounded, exact box walk; identifiers compacted).
// Slide structure (Julian, 2026-10-17, I7: "New lazy 'slide menu' chunk", measured + 10%): new lazy builder-structure 10,610 → 11,672,
// loaded when the pointer or focus first reaches the Outline; the studio sheds its old Stage tools (45,983 → 44,318). No other cap changes.
// CASE-284 participant feedback page (slice 4; I6, measured + 10%): new lazy feedback-page 11,415 -> 12,557 and new route:/F
// 37,485 -> 41,234; the shell's /F route and feedbackUrl grow the facilitate union by the slice's measured growth + 10%.
// CASE-284 participant feedback page (slice 4; Julian's I6 ruling, 2026-10-17: one combined byte table at measured + 10%):
// new lazy feedback-page 11,415 → 12,557 and new route:/F 37,485 → 41,234. A new top-level route adds one hashed lazy import
// to the shell, and the shared URL module gains feedbackUrl, so route:/sessions/:id/facilitate grows by this slice's measured
// +128 B (app +64, shared modules +64): 236,501 → 236,629, keeping its previous 75 B of headroom. No other cap changes.
// Card 40 + feedback stack, slices 3–5 (I6): the ended projections, the feedback page and paging together, then the ended
// projector (slice 5b: the feedback card and debrief panel in projector-render, which the console's same-PC preview and the
// Builder's Run preview also load) measure route:/cases 211,884 (+833) and facilitate 237,546 (+917). Each cap grows by that
// growth + 10%: route:/cases 211,051 → 211,967; route:/sessions/:id/facilitate 236,629 → 237,638.
// Card 40 + participant feedback integration, slice 8 (Julian, 2026-10-17, I6): the facilitator briefing is a new lazy chunk, `briefing`
// (21,456 + 10%), loaded from case detail and the console Room tab; it loads the tagged PDF writer only on Download, so `briefing` and
// `session-pdf` join route:/cases and route:/sessions/:id/facilitate, each union raised by its measured growth + 10%.
// Card 40 + feedback integration, slice 7 (I6): the recap journey and its built-in PDF; new lazy recap-pdf (9,825 + 10%), loaded only
// by phone.mjs inside Download; the unions it reaches grow by slice 7's measured growth + 10%.
export const BASELINE = Object.freeze({'case-workspace-access':24788,'admin-css':2840, 'case-share': 4730, 'admin-people': 27476, 'admin-workspaces': 23145, 'admin-invitations': 19167, 'invite-page': 11836, 'invite-landing': 5339, 'facilitator-label-form': 15681, 'finish-block': 6629, 'feedback-client': 6101, 'record-summary': 3143, 'recap-pdf': 9825, briefing: 21456, 'participant-record': 7614, 'route:participant-record': 62898, 'builder-structure': 10610, 'feedback-results': 17680, 'ended-summary': 15836, 'debrief-render': 18869, 'route:ended-summary': 76238, 'feedback-page': 11415, 'route:/F': 37485, 'builder-media': 13779, 'media-gif': 1070, 'media-mp4': 3031, 'case-map': 27220, 'room-music': 3656, admin: 30190, check: 21935, console: 99663, projector: 60451, phone: 79251, pair: 110785, app: 31085, sw: 9934, home: 27464, library: 42384, 'console-tones': 1546, 'route:/': 52807,
  'groups-screen': 42458, 'route:/admin': 117019, 'route:/history': 150639, 'route:/account': 150639,
  'admin-workbench': 23855, 'portfolio-page': 31541, 'session-detail': 26073, 'session-export': 22475, 'session-pdf': 48131, help: 11191, splash: 18719, 'route:/display': 89773, 'console-room-tab': 25711, 'account-session': 11469, 'console-room': 100748,
  'builder-page-css': 578, 'builder-page': 21546, 'builder-route': 43915, 'builder-studio': 39062, 'builder-api': 2399, 'builder-templates': 1814, 'builder-studio-css': 1451, 'builder-preview-snapshot': 14488, 'builder-workflows': 43834, 'builder-slide-check': 9238, 'builder-slides': 48387, 'builder-gas': 28984, 'builder-gas-css': 916, 'builder-slides-css': 1379, 'builder-inspection': 100557, 'builder-shell': 8421, 'builder-shell-css': 6752, 'builder-fit': 38914, 'keymap-sheet': 1661, 'projector-slides': 6930, 'slide-render': 5332,
  'route:/cases/new': 50892, 'route:/cases/:id/edit': 129462, 'route:/cases/:id/edit/workflows': 166713, 'route:/cases/:id/edit/preview': 166713, 'route:/sessions/:id/facilitate': 214535 });
const CORE_ROUTES = Object.freeze({ 'route:participant-record': Object.freeze(['feedback-page', 'finish-block', 'participant-record', 'session-pdf']), 'route:/': Object.freeze(['app', 'home', 'splash']), 'route:ended-summary': Object.freeze(['ended-summary', 'debrief-render', 'session-pdf', 'account-session']), 'route:/cases': Object.freeze(['case-detail', 'menu-account', 'facilitator-label-form', 'invite-landing', 'keymap-sheet', 'app', 'console', 'library', 'console-tones', 'groups-screen', 'case-share', 'splash', 'console-room-tab', 'account-session', 'builder-inspection', 'builder-preview-snapshot', 'projector-slides', 'slide-render', 'builder-slide-check', 'feedback-results', 'briefing', 'session-pdf', 'icons','admin-invitations']),
  'route:/admin': Object.freeze(['app','console','facilitator-label-form','invite-landing','admin-css','menu-account', 'splash', 'admin', 'admin-invitations', 'admin-people', 'admin-workspaces', 'admin-workbench', 'groups-screen', 'account-session', 'session-detail', 'session-export', 'session-pdf', 'feedback-results']), 'route:/display': Object.freeze(['app', 'projector', 'splash', 'room-music', 'projector-slides', 'icons']),
  'route:/cases/new': Object.freeze(['menu-account', 'app', 'builder-page-css', 'builder-page', 'builder-api', 'builder-templates', 'account-session']),
  'route:/cases/:id/edit': Object.freeze(['menu-account', 'keymap-sheet', 'app', 'builder-page-css', 'builder-page', 'builder-route', 'builder-api', 'builder-templates', 'builder-studio', 'builder-studio-css', 'builder-slide-check', 'builder-slides', 'builder-gas', 'builder-gas-css', 'builder-media', 'media-gif', 'media-mp4', 'builder-structure', 'builder-slides-css', 'builder-inspection', 'builder-preview-snapshot', 'splash', 'projector-slides', 'slide-render', 'builder-shell', 'builder-shell-css', 'builder-fit', 'account-session', 'builder-sources', 'builder-overview', 'icons']),
  // CASE-321: the Overview's address also loads the console's case map.
  'route:/cases/:id/edit/overview': Object.freeze(['menu-account', 'keymap-sheet', 'app', 'builder-page-css', 'builder-page', 'builder-route', 'builder-api', 'builder-templates', 'builder-studio', 'builder-studio-css', 'builder-slide-check', 'builder-slides', 'builder-gas', 'builder-gas-css', 'builder-media', 'media-gif', 'media-mp4', 'builder-structure', 'builder-slides-css', 'builder-inspection', 'builder-preview-snapshot', 'splash', 'projector-slides', 'slide-render', 'builder-shell', 'builder-shell-css', 'builder-fit', 'account-session', 'builder-sources', 'builder-overview', 'case-map', 'icons']),
  // CASE-208 (Julian, 2026-10-10): each Builder view lists only the chunks a direct load of it requests, proven by the
  // served e2e/builder-preview.spec.mjs [AS-133]. The other view's chunks stay deferred through DEFERRED_ROUTES. No cap changes.
  'route:/cases/:id/edit/workflows': Object.freeze(['menu-account', 'keymap-sheet', 'app', 'builder-page-css', 'builder-page', 'builder-route', 'builder-api', 'builder-templates', 'builder-studio', 'builder-studio-css', 'builder-slide-check', 'builder-workflows', 'builder-shell', 'builder-shell-css', 'account-session']),
  'route:/cases/:id/edit/preview': Object.freeze(['menu-account', 'keymap-sheet', 'app', 'builder-page-css', 'builder-page', 'builder-route', 'builder-api', 'builder-templates', 'builder-studio', 'builder-studio-css', 'builder-slide-check', 'builder-inspection', 'builder-preview-snapshot', 'splash', 'projector-slides', 'slide-render', 'builder-shell', 'builder-shell-css', 'builder-fit', 'account-session', 'icons']),
  // CASE-284 participant feedback page: the shell plus its own lazy chunk; it imports no other surface.
  'route:/history': Object.freeze(['menu-account', 'facilitator-label-form', 'invite-landing', 'app', 'console', 'portfolio-page', 'session-detail', 'session-export', 'session-pdf', 'account-session', 'splash', 'feedback-results']),
  'route:/account': Object.freeze(['facilitator-label-form', 'invite-landing', 'app', 'console', 'account-page', 'account-session', 'splash', 'menu-account']),
  // CASE-282 participant feedback page: the shell plus its own lazy chunk; it imports no other surface.
  'route:/F': Object.freeze(['app', 'feedback-page', 'finish-block']),
  // Room entry uses history.replaceState from the loaded catalogue, so the union retains that JS graph.
  'route:/sessions/:id/facilitate': Object.freeze(['case-detail', 'menu-account', 'facilitator-label-form', 'invite-landing', 'keymap-sheet', 'app', 'console', 'library', 'console-room', 'ended-summary', 'account-session', 'splash', 'console-room-tab', 'console-mirror', 'console-tones', 'case-map', 'groups-screen', 'case-share', 'builder-inspection', 'builder-preview-snapshot', 'projector-slides', 'slide-render', 'builder-slide-check', 'briefing', 'session-pdf', 'icons','admin-invitations']) });
// A route-specific lazy boundary may be measured on its own route rather than charged to the
// route that merely exposes the navigation action. The target route must also contain both entries.
const CORE_DEFERRED_ROUTES = Object.freeze({ 'route:/F': Object.freeze({ 'feedback-page': Object.freeze({ 'participant-record': 'route:participant-record' }) }),
  'route:/cases': Object.freeze({ app: Object.freeze({ 'builder-page': 'route:/cases/:id/edit' }), library: Object.freeze({}), console: Object.freeze({ 'account-page': 'route:/account', 'ended-summary': 'route:/sessions/:id/facilitate', 'console-room': 'route:/sessions/:id/facilitate', 'portfolio-page': 'route:/history' }),
    // Console Debrief: the room chunk's Debrief record loads the ended summary's PDF and print only on a press.
    'console-room-tab': Object.freeze({ 'ended-summary': 'route:/sessions/:id/facilitate' }) }),
  'route:/cases/new': Object.freeze({ 'app': Object.freeze({ 'builder-page': 'route:/cases/new' }), 'builder-page': Object.freeze({ 'builder-route': 'route:/cases/:id/edit' }) }),
  'route:/cases/:id/edit': Object.freeze({ 'app': Object.freeze({ 'builder-page': 'route:/cases/:id/edit' }),
    'builder-page': Object.freeze({ 'builder-route': 'route:/cases/:id/edit', 'builder-api': 'route:/cases/new', 'builder-templates': 'route:/cases/new' }),
    'builder-route': Object.freeze({ 'builder-studio': 'route:/cases/:id/edit', 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    // CASE-344: the ⋯ menu's Import and export loads the transfer tools from the publishing chunk, on a press.
    'builder-studio': Object.freeze({ 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    'builder-overview': Object.freeze({ 'case-map': 'route:/cases/:id/edit/overview' }) }),
  'route:/cases/:id/edit/overview': Object.freeze({ 'app': Object.freeze({ 'builder-page': 'route:/cases/:id/edit/overview' }),
    'builder-page': Object.freeze({ 'builder-route': 'route:/cases/:id/edit/overview', 'builder-api': 'route:/cases/new', 'builder-templates': 'route:/cases/new' }),
    'builder-route': Object.freeze({ 'builder-studio': 'route:/cases/:id/edit/overview', 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    'builder-studio': Object.freeze({ 'builder-workflows': 'route:/cases/:id/edit/workflows' }) }),
  'route:/cases/:id/edit/workflows': Object.freeze({ 'app': Object.freeze({ 'builder-page': 'route:/cases/:id/edit/workflows' }),
    'builder-page': Object.freeze({ 'builder-route': 'route:/cases/:id/edit/workflows', 'builder-api': 'route:/cases/new', 'builder-templates': 'route:/cases/new' }),
    'builder-route': Object.freeze({ 'builder-slides': 'route:/cases/:id/edit', 'builder-inspection': 'route:/cases/:id/edit', 'builder-studio': 'route:/cases/:id/edit/workflows', 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    'builder-studio': Object.freeze({ 'builder-structure': 'route:/cases/:id/edit', 'builder-sources': 'route:/cases/:id/edit', 'builder-overview': 'route:/cases/:id/edit', 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    'builder-shell': Object.freeze({ 'builder-fit': 'route:/cases/:id/edit' }) }),
  'route:/cases/:id/edit/preview': Object.freeze({ 'app': Object.freeze({ 'builder-page': 'route:/cases/:id/edit/preview' }),
    'builder-page': Object.freeze({ 'builder-route': 'route:/cases/:id/edit/preview', 'builder-api': 'route:/cases/new', 'builder-templates': 'route:/cases/new' }),
    'builder-route': Object.freeze({ 'builder-slides': 'route:/cases/:id/edit', 'builder-inspection': 'route:/cases/:id/edit', 'builder-studio': 'route:/cases/:id/edit/preview', 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    'builder-studio': Object.freeze({ 'builder-structure': 'route:/cases/:id/edit', 'builder-sources': 'route:/cases/:id/edit', 'builder-overview': 'route:/cases/:id/edit', 'builder-workflows': 'route:/cases/:id/edit/workflows' }),
    'builder-shell': Object.freeze({ 'builder-fit': 'route:/cases/:id/edit' }) }),
  'route:/history': Object.freeze({ console: Object.freeze({ 'account-page': 'route:/account', 'ended-summary': 'route:/sessions/:id/facilitate', 'console-room': 'route:/sessions/:id/facilitate', library: 'route:/cases' }) }),
  'route:/account': Object.freeze({ console: Object.freeze({ 'account-page': 'route:/account','portfolio-page':'route:/history', 'ended-summary': 'route:/sessions/:id/facilitate', 'console-room': 'route:/sessions/:id/facilitate', library: 'route:/cases' }) }),
  'route:/sessions/:id/facilitate': Object.freeze({ library: Object.freeze({}), 'case-detail':Object.freeze({'feedback-results':'route:/cases'}), 'ended-summary': Object.freeze({ 'session-pdf': 'route:ended-summary', 'debrief-render': 'route:ended-summary' }), console: Object.freeze({ 'account-page': 'route:/account', 'ended-summary': 'route:/sessions/:id/facilitate', 'portfolio-page': 'route:/history', 'console-room': 'route:/sessions/:id/facilitate', splash: 'route:/sessions/:id/facilitate', library: 'route:/sessions/:id/facilitate', 'groups-screen': 'route:/sessions/:id/facilitate', 'console-room-tab': 'route:/sessions/:id/facilitate', 'console-tones': 'route:/sessions/:id/facilitate', 'case-map': 'route:/sessions/:id/facilitate' }), 'console-room': Object.freeze({ splash: 'route:/sessions/:id/facilitate', 'console-room-tab': 'route:/sessions/:id/facilitate', 'console-tones': 'route:/sessions/:id/facilitate', 'case-map': 'route:/sessions/:id/facilitate' }) }) });
// CASE-356: canonical destinations and compatibility aliases share the same measured graph
// and ceilings. #menu is an interaction state, not a new application address.
export const ROUTE_ALIASES=Object.freeze({'route:/present':'route:/cases','route:/create':'route:/cases','route:/create/new':'route:/cases/new','route:/sessions':'route:/history','route:/sessions/:id':'route:/history'});
const NAVIGATION_ROUTES={...CORE_ROUTES,...Object.fromEntries(Object.entries(ROUTE_ALIASES).map(([alias,source])=>[alias,CORE_ROUTES[source]]))};
const ADMIN_BOUNDARIES=Object.fromEntries(Object.entries(CORE_ROUTES).map(([route,members])=>[route,{...CORE_DEFERRED_ROUTES[route],...(members.includes('console')?{console:{...CORE_DEFERRED_ROUTES[route]?.console,admin:'route:/admin'}}:{})}]));
ADMIN_BOUNDARIES['route:/admin']={console:{'account-page':'route:/account','portfolio-page':'route:/history',library:'route:/cases','console-room':'route:/sessions/:id/facilitate','ended-summary':'route:/sessions/:id/facilitate'}};
const NAVIGATION_DEFERRED={...ADMIN_BOUNDARIES,...Object.fromEntries(Object.entries(ROUTE_ALIASES).map(([alias,source])=>[alias,ADMIN_BOUNDARIES[source]??{}]))};
// Public identity recovery stays off the initial request path; the complete on-press union is charged.
const MENU_ROUTES = Object.freeze({...NAVIGATION_ROUTES,...Object.fromEntries(Object.entries(NAVIGATION_ROUTES).filter(([,members])=>!members.includes('menu-account')).map(([route,members])=>[route+'#menu',Object.freeze([...new Set([...members,'menu-account','account-session'])])]))});
const MENU_DEFERRED_ROUTES = Object.freeze({...NAVIGATION_DEFERRED,...Object.fromEntries(Object.entries(NAVIGATION_ROUTES).filter(([,members])=>!members.includes('menu-account')).flatMap(([route,members])=>{
 const base=NAVIGATION_DEFERRED[route]??{},first={...base};for(const member of members)first[member]={...base[member],'menu-account':route+'#menu'};
 return [[route,Object.freeze(first)],[route+'#menu',base]];
}))});
// CASE-359: audition stays off cold imports; its complete JS/CSS/menu union is measured on explicit Music activation.
export const MUSIC_ROUTE_SOURCES=Object.freeze(Object.fromEntries(Object.keys(NAVIGATION_ROUTES).map(route=>[route+'#music',MENU_ROUTES[route+'#menu']?route+'#menu':route])));
const FEEDBACK_MENU_ROUTES=Object.fromEntries(Object.entries(MENU_ROUTES).map(([route,members])=>[route,[...members,...(members.includes('feedback-results')?['feedback-presentation-css']:[]),...(members.includes('case-detail')?['case-workspace-access']:[])]]));
const EXISTING_ROUTES=Object.freeze({...FEEDBACK_MENU_ROUTES,...Object.fromEntries(Object.entries(MUSIC_ROUTE_SOURCES).map(([route,source])=>[route,Object.freeze([...new Set([...FEEDBACK_MENU_ROUTES[source],'music-audition','music-audition-css'])])]))});
// The authenticated report trigger is loaded with account recovery; the form remains click-deferred.
const BASE_ROUTES=Object.fromEntries(Object.entries(EXISTING_ROUTES).map(([route,members])=>[route,[...members,...(members.includes('admin')?['admin-issues','issues-css']:[]),...(members.includes('menu-account')?['issue-entry']:[])]]));
export const ROUTES=Object.freeze({...BASE_ROUTES,...Object.fromEntries(Object.entries(BASE_ROUTES).map(([route,members])=>[route+'#report',[...members,'issue-entry','issue-reporter','issues-css']]))});
export const DEFERRED_ROUTES=Object.freeze(Object.fromEntries(Object.entries(ROUTES).map(([route,members])=>{
 const original=route.replace(/#report$/,''),source=MUSIC_ROUTE_SOURCES[original]??original,base=MENU_DEFERRED_ROUTES[source]??{},music=original.endsWith('#music')?original:original.replace(/#menu$/,'')+'#music';
 return [route,Object.freeze(Object.fromEntries(members.map(member=>[member,Object.freeze({...base[member],'music-audition':music,'issue-entry':route.endsWith('#report')?route:route+'#report','issue-reporter':route.endsWith('#report')?route:route+'#report'})])))];
})));
// Card 40 + participant feedback integration, slice 1 (Julian, 2026-10-17, ruling I6: one combined byte table at measured + 10%): the
// tagged PDF writer session-pdf 29,581 → 33,988; route:/history and route:/account 138,386 → 142,793 and route:/admin 104,549 → 108,956,
// each union by the writer's growth only. The CASE decision is appended in merge order.
// Slice 4 on main after #279/#280 (I6): route:/sessions/:id/facilitate measures 236,652 (slice growth about 151 B over main); cap 236,668.
// Card 40 + feedback integration, slice 3 (I6): the ended projections (room machine and the projector's view shape) add 380 B to
// route:/cases (210,827 → 211,207) and to route:/sessions/:id/facilitate (236,501 → 236,881); each cap grows by that + 10% (+418).
// Card 40d pagination (Julian, 2026-10-17: "page it and shrink text"; I6 measured + 10%): the shared page rule
// (debrief-pages.mjs) joins the room machine and the projector: console-room +215 (110,823 → 111,060), route:/cases +360
// (211,967 → 212,363), route:/sessions/:id/facilitate +362 (237,638 → 238,037).
// Slices 3-5 on today's main (I6): the shell's shared URL and /F route growth measures route:/ 58,083 -> 58,220 (+137); cap +10%: 58,234.
// Card 40 + feedback integration, slice 2 (Julian, 2026-10-17, I6): the History record reads as the counts-only debrief
// (debrief-model.mjs, debrief-render.mjs): session-detail 22,680 → 26,073 and portfolio-page 26,041 → 31,541 at measured size; the
// history, account and admin unions grow by this slice's measured union growth only (3,416 B).
// PDF scripts (Julian, 2026-10-17, rulings a–c: CaseSymbols, Latin Extended-A, Greek; measured + 10%): session-pdf 33,988 → 48,131 at measured size; route:/history and route:/account 146,209 → 160,282 and route:/admin 112,372 → 126,463, each by its measured union growth.
// Slices 3 and 4 together on main (I6): facilitate = main's 236,668 (slice 4) + slice 3's 418 = 237,086.
// Slice 5 on main (pagination and the ended projector; I6, measured growth + 10%): route:/cases 212,363, facilitate 238,037,
// console-room 111,060, route:/ 58,234.
// Card 40 + feedback integration, slice 3 (I6): the ended projections (room machine and the projector's view shape) add 380 B to
// route:/cases (210,827 → 211,207) and to route:/sessions/:id/facilitate (236,501 → 236,881); each cap grows by that + 10% (+418).
// Card 40d pagination (Julian, 2026-10-17: "page it and shrink text"; I6 measured + 10%): the shared page rule
// (debrief-pages.mjs) joins the room machine and the projector: console-room +215 (110,823 → 111,060), route:/cases +360
// (211,967 → 212,363), route:/sessions/:id/facilitate +362 (237,638 → 238,037).
// Slices 3-5 on today's main (I6): the shell's shared URL and /F route growth measures route:/ 58,083 -> 58,220 (+137); cap +10%: 58,234.
// Slice 10 on the script fonts (Julian 2026-10-17, rulings b-d, measured + 10%): route:participant-record, which charges the
// on-tap writer, measures 48,822 -> 62,898; its cap follows (69,188).
// Slices 3-5 on today's main (I6): route:/ 58,083 -> 58,220 (+137); cap +10%: 58,234.
// Card 40 + feedback integration, slice 6 (I6, measured + 10%): the console's ended summary. New lazy chunks ended-summary
// 15,836 and debrief-render 18,869 (the renderer the summary fetches as it mounts; History keeps importing it), and the
// route:ended-summary row (62,126) that charges the screen's on-click PDF writer. console-room derives the End model before
// the purge (+1,485: 110,823 → 112,457), and the facilitate union grows by the summary shell and that derivation
// (+4,086, over the plan's ~2 KB estimate: 237,638 → 242,133); route:/cases +216 → 212,205; route:/ +90 (the shell's
// transport gains the grant call) → 58,315.
// Embedded CaseSymbols fallback font (Julian, 2026-10-17: draw the real symbols; I6): the writer grows 1,808 B, so each union
// carrying it grows by that + 10% (+1,991).
// Slice 6 on the script fonts (Julian 2026-10-17, rulings a-d; I6): history, account and admin take slice 2's font caps; route:ended-summary,
// which charges the writer, measures 62,126 -> 76,238 and its cap follows at measured + 10% (83,862).
// Card 40 + feedback integration, slice 9 (I6, measured + 10%): the results views. New lazy chunk feedback-results 17,680 (its
// static closure; the History, Account, Administration and case detail surfaces load it on demand). Unions by measured growth:
// route:/history and route:/account +4,430 (146,209 → 150,639), route:/admin +4,647 (112,372 → 117,019), route:/cases +4,412
// (cap 212,205 → 217,059), and the facilitate union +398 for the ended summary's feedback line and case detail's disclosure
// (cap 242,133 → 242,571; the chunk itself is deferred there to route:/cases).
// Slice 9 on the script fonts and slice 6 (I6, growth + 10%): over slice 6's measured history/account 173,283 and admin 135,889,
// slice 9 adds 4,472 and 4,640 B: history/account 176,311 -> 181,231, admin 139,110 -> 144,214; console-room +28 (main #279) -> 112,488.
// Slice 8 on main 887fac7 (I6, growth + 10% over main's measured sizes; help per Julian's Option A): /cases +55,801 -> 278,441;
// facilitate +55,795 -> 303,946; route:/ +54 -> 58,375; console-room +31 -> 112,523; help 12,396.
// Slice 7 on main d31ca4a (I6): console-room +104 over main's measured 112,516 -> 112,638; /cases and facilitate fit main's caps.
// Card 61 on main 1e04bb4 (Julian's rule, previous cap + 1.1 × growth): ordinary questions go Lock -> Continue with no route card; the room
// machine's facilitator-only decision.directContinue and the console's Continue branch add 138 B over main's measured 112,620
// -> 112,758; cap 112,638 + 152 = 112,790. builder-inspection, console, /cases and facilitate fit main's caps.
// Card 62 PUBLISH-01 (Julian, 2026-10-18, standing rule: previous cap + 1.1 x growth): naming each refused image in Readiness
// adds 836 B to builder-route over main's measured 48,747 -> 48,819 + 920 = 49,739. No other cap changes.
// Console layout v2 (Julian, 2026-10-18; standing rule: previous cap + 1.1 x growth, a one-off rise within 10%): one screen with a side
// rail, Room setup sheet, three resizable panels, the presentation strip and in-place confirms add 2,290 B to console-room over main's
// measured 112,758 -> 115,048; cap 112,790 + 2,519 = 115,309 (+2.2%). console-room-tab, /cases and facilitate fit main's caps.
export const BUDGETS = Object.freeze({ ...Object.fromEntries(Object.entries(BASELINE).map(([name, bytes]) => [name, Math.ceil(bytes * 1.1)])),
  'route:/cases/:id/edit': 336092, 'route:/cases/:id/edit/workflows': 188394, 'route:/cases/:id/edit/preview': 279854, 'room-music': 4096,
  // Julian's exact approvals: CASE-279 route ceilings and CASE-280 Builder entries.
  // Card 40 + feedback integration, slice 10 (I6, measured + 10%): the participant's participant record on /F (D7). New lazy
  // participant-record 7,614 → 8,376, loaded only on tap; it loads the tagged writer only on Download. Both are charged to their
  // own row, route:participant-record (48,822 → 53,705: the page, the record and the writer), so route:/F keeps its first-load
  // cap (37,637 of 41,234). No other cap changes.
  'route:/': 58375, 'route:/sessions/:id/facilitate': 303946, 'console-room': 115309,
  'route:/history': 181231, 'route:/account': 181231, 'route:/admin': 144214, 'help': 12396, 'builder-templates': 2764, 'builder-studio': 46041, 'builder-fit': 43318,
  'builder-shell': 9776, 'builder-workflows': 49242, 'builder-route': 49739,
  'projector-slides': 7623,
  // Room PDFs v2 (CASE-289, Julian 2026-10-18; standing ruling: a cap may rise by up to 10% as a one-off): each cap below is the
  // previous cap + 1.1 × this change's growth over main 351742a, never above the previous cap + 10%. Why: the restyled PDFs
  // (pdf-chrome, pdf-glance, the list symbol column and foot card in the writer), the shared renderer's pdfBand/bandArt (the braid for every band, so
  // splash and the routes that load it grow), the debrief's route glance, and the Finish block on /F and the ended phone screen.
  // console-room stacks this change's increment (+1,117) on #304's cap (115,309); pair 121,864 + 1.1 × 983 (measured over main e605fbb) = 122,945.
  // New lazy chunks at measured + 10% via BASELINE: finish-block, feedback-client, record-summary.
  // Facilitator Name & role (CASE-290, Julian 2026-10-18; the same standing rule over room PDFs v2's final head 8285e0c): the new lazy
  // facilitator-label-form (15,681 + 10%; the first-sign-in step) is loaded by the console and imported by case detail, Account and
  // Administration, so each surface carrying the Name & role fields grows about 2.4 KB: admin 31,355 -> 34,027 (cap 33,209 -> 36,149),
  // portfolio-page 35,139 -> 37,480 (37,246 -> 39,822), route:/admin 147,219 -> 149,686 (149,343 -> 152,057), the facilitate union
  // 308,131 -> 310,596 (308,917 -> 311,629). console-room, pair, library, route:/cases, /history and /account fit their caps.
  admin: 36149,
  // Console Debrief (CASE-291, Julian 2026-10-18; the same rule over Facilitator Name & role's final head 6af9ee4): the room machine's
  // Debrief phase, the console's Debrief dock, strip and rail and the review panel in the lazy room chunk (which fits its cap). pair
  // 122,697 -> 124,919 (cap 122,945 -> 125,390), console-room 116,131 -> 118,354 (116,426 -> 118,872), route:/cases 282,603 -> 285,986
  // (283,287 -> 287,009), /history and /account 186,381 -> 187,168 (186,604 -> 187,470), the facilitate union 310,596 -> 315,021
  // (311,629 -> 316,497). builder-inspection (Run preview shares the dock and its actions) 109,623 -> 110,973 (110,613 -> 112,098).
  // Each is within 2% of its previous cap.
  'builder-inspection': 112098,
  briefing: 25377, 'console-room': 118872, pair: 125390, 'debrief-render': 22831, 'groups-screen': 47822, 'participant-record': 9209, 'portfolio-page': 39822, 'recap-pdf': 11888, 'route:/': 59654, 'route:/F': 45357, 'route:/account': 187470, 'route:/history': 187470, 'route:/admin': 152057, 'route:/cases': 287009, 'route:/sessions/:id/facilitate': 316497, 'route:participant-record': 76106, 'session-detail': 31229, 'session-pdf': 54537, 'splash': 21869,
  // Blood gas, slide fill and branch badge (CASE-311 to CASE-313; the standing CASE-289 rule over main 0c410ffc): each cap below is
  // the previous cap + 1.1 × this change's growth, within the previous cap + 10%. Why: the gas renderer and its shared view module in
  // every slide surface, the Builder's gas grid and fill swatches, the fill and badge in the projector, phone and recap.
  'builder-inspection': 113960, 'builder-fit': 45963, 'builder-slides': 58206, 'builder-workflows': 51318, 'recap-pdf': 12708,
  'console-room': 120268, pair: 126790, 'builder-slides-css': 1626, 'route:/cases': 290840, 'route:/cases/:id/edit': 342281,
  'route:/history': 189119, 'route:/account': 189119, 'route:/sessions/:id/facilitate': 320327,
  // Blood gas compare mode and the redesigned gas editor (CASE-317; the standing CASE-289 rule over main 90ee1cda): each cap
  // below is the previous cap + 1.1 × this change's measured growth, within the previous cap + 10%. Why: the compare table in the
  // shared slide renderer and the compare contract in the validator reach every Builder chunk that draws or checks slides; the
  // editor itself is the new lazy builder-gas chunk and its stylesheet (measured + 10% via BASELINE), charged to the edit route.
  'builder-fit': 46836, 'builder-workflows': 51888, 'route:/cases/:id/edit': 351266, 'route:/cases/:id/edit/preview': 280755,
  // The same change, approved by Julian 2026-10-30 ("Approve all four") past the 10% ceiling, at previous cap + 1.1 × growth:
  // slide-render 5,866 → 6,950 (5,461 → 6,446) and projector-slides 7,623 → 8,716 (7,076 → 8,069), the gas renderer and its view
  // module; builder-slide-check 10,162 → 12,284 (9,214 → 11,143), the gas validator and starter rows; record-summary 3,458 → 4,269
  // (2,907 → 3,644), the recap's gas lines.
  'slide-render': 6950, 'projector-slides': 8716, 'builder-slide-check': 12284, 'record-summary': 4269,
  // CASE-322 (Julian, 2026-10-30, "Yes, raise caps"; the standing rule over main dfb5dad5: previous cap + 1.1 × growth,
  // new lazy chunks at measured + 10%). CASE-318–320 room work: builder-inspection, console-room, pair and the /cases,
  // /display, /history, /account and facilitate unions (the room machine's closing window, text pages and timer length).
  // CASE-321 Builder: new lazy builder-sources and builder-overview, builder-studio, builder-route, builder-shell-css and the
  // edit, workflows and preview unions, plus the new route:/cases/:id/edit/overview (the edit route with the console case map).
  'builder-inspection': 116030, 'builder-overview': 3978, 'builder-sources': 8906, 'builder-studio': 48735, 'builder-route': 50320, 'console-room': 121678, 'pair': 128198, 'builder-shell-css': 8245, 'route:/cases': 293392, 'route:/display': 99602, 'route:/cases/:id/edit': 362601, 'route:/cases/:id/edit/overview': 401855, 'route:/cases/:id/edit/workflows': 189935, 'route:/cases/:id/edit/preview': 284061, 'route:/history': 190201, 'route:/account': 190201, 'route:/sessions/:id/facilitate': 322907,
  // Main-red fix after #353 (the standing CASE-289 rule over main c37c4882: previous cap + 1.1 × measured growth, within
  // + 10%): the Builder fit check now fits a free-text results page with the projector's own fitTextAnswers (CASE-318),
  // moved into projector-result.mjs so both renderers share it. builder-fit 46,704 → 47,004 measured.
  'builder-fit': 47166,
  // CASE-325 question slot fit (the standing CASE-289 rule over main 0634cf0f: previous cap + 1.1 × measured growth, within
  // + 10%): fitSlide gives closed responses their rows, then the slide. projector-slides 8,551 → 8,996, builder-fit
  // 47,004 → 47,460 and the preview union 283,620 → 284,101 measured.
  'projector-slides': 9206, 'builder-fit': 47668, 'route:/cases/:id/edit/preview': 284591,
  // CASE-326 (the same rule over main 8153aa41): a publishing refusal names each problem once with its count.
  // builder-workflows 51,727 → 51,994 measured.
  'builder-workflows': 52182,
  // CASE-327 (Julian, 2026-11-01, "ship all as one PR"; the standing rule over main a722b5a7: previous cap + 1.1 × measured
  // growth, a new lazy chunk at measured + 10%): Room sees draws the projector (new lazy console-mirror, 35,117 measured, the
  // projector renderer), the facilitate union 322,203 → 323,717, builder-slides-css 1,609 → 1,640 (tables never narrow a
  // column past its longest word), and pair 127,608 → 128,199 and the /cases union 293,142 → 293,395 (the vitals font as
  // longhands, the compact ranked result).
  'console-mirror': 38629, 'route:/sessions/:id/facilitate': 324573, 'builder-slides-css': 1661, 'pair': 128849, 'route:/cases': 293671,
  // CASE-334 room music integration: PROPOSED, awaiting Julian's approval (the round8 sound approval, CASE-333, approves no
  // budget). Measured over feat/room-sound-redesign 8dca3285 (brotli, static closures). New lazy music closure (the round8
  // engine, the adapter, the shipped library's metadata and the shared timeline) at measured + 10%: room-music 11,326 -> 12,459,
  // replacing the CASE-192 4,096 ceiling. The room machine now carries the music state and timeline (+2.9-3.1 KB in every
  // chunk that bundles it), the console the clock and the two music controls, and /display the music closure: each cap below
  // is the previous cap + 1.1 x growth (all within +10% except room-music, which is new work).
  'room-music': 12459, 'builder-inspection': 119460, 'console-room': 124888, 'console-room-tab': 30170, pair: 132055,
  'route:/account': 193184, 'route:/history': 193184, 'route:/cases': 298456, 'route:/cases/:id/edit/preview': 288040,
  'route:/display': 108778, 'route:/sessions/:id/facilitate': 329593,
  // CASE-335 (Julian, 2026-11-01: "I approve raising the ceiling by up to 14%"): the console's player widget (console-player.mjs,
  // its SVG covers and controls) in console-room-tab and the unions that carry it. Previous cap + 1.1 x growth, each within
  // main's cap + 14%: console-room-tab 30,170 -> 32,243 (main 28,283 + 14%; measured 31,332), route:/cases 298,456 -> 301,073,
  // route:/cases/:id/edit 362,601 -> 363,127, route:/sessions/:id/facilitate 329,593 -> 332,224.
  'console-room-tab': 32243, 'route:/cases': 301073, 'route:/cases/:id/edit': 363127, 'route:/sessions/:id/facilitate': 332224,
  // CASE-343 (facilitator-UX A4; the standing rule over 05baca88: previous cap + 1.1 × measured growth, new lazy chunks at
  // measured + 10% via BASELINE). New lazy admin-invitations (Administration -> Invitations), invite-page (/i/) and
  // invite-landing (the first-sign-in landing, charged to every route that lists the console). The invite URL builders in
  // the shared urls.mjs reach every chunk that imports it (about 160-250 B each): groups-screen 47,738 -> 47,949, session-pdf
  // 54,405 -> 54,570, builder-route 50,215 -> 50,427, help 12,354 -> 12,513, console-room 124,734 -> 124,966, route:/ 59,522 ->
  // 59,766, /cases 300,121 -> 301,631, /admin 149,760 -> 153,046, edit 362,937 -> 363,227, preview 287,869 -> 288,159,
  // /history and /account 192,719 -> 194,211. Each within +2.4% of its previous cap.
  'groups-screen': 48055, 'session-pdf': 54719, 'builder-route': 50554, help: 12571, 'console-room': 125144, 'route:/': 59923,
  'route:/cases': 302735, 'route:/admin': 155672, 'route:/cases/:id/edit': 363446, 'route:/cases/:id/edit/preview': 288359,
  'route:/history': 194826, 'route:/account': 194826,
  // CASE-343 (facilitator-UX A5, the same rule over the A4 head 05baca88; new lazy chunks admin-people and admin-workspaces at
  // measured + 10% via BASELINE). People, Workspaces and the shared confirmation leave the admin entry (34,157 -> 29,315, inside
  // its cap). Measured growth over 05baca88: admin-workbench +157 (Cases, Rooms, Activity and the confirmation), groups-screen +417
  // (the step-up wording), the facilitate union +431 (it carries groups-screen) and /admin +9,443 (the two new chunks). Each cap is
  // its previous cap + 1.1 x growth: admin-workbench 26,241 -> 26,413, groups-screen 48,055 -> 48,513, facilitate 332,224 ->
  // 332,698, /admin 155,672 -> 166,059.
  'admin-workbench': 26413, 'groups-screen': 48513, 'route:/sessions/:id/facilitate': 332698, 'route:/admin': 166059,
  // CASE-343 (facilitator-UX A6, the same rule over the A5 head 47e3d2ef; Share is a new lazy chunk, case-share, at measured + 10%
  // via BASELINE). The shared-cases list, Share and the case-only gating grow library (44,280 -> 45,435, inside its cap), and the
  // unions that carry case detail by case-share's closure: /cases 302,058 -> 307,156 (+5,098) and the facilitate union 332,613 ->
  // 337,705 (+5,092). Each cap is its previous cap + 1.1 x growth: /cases 302,735 -> 308,343, facilitate 332,698 -> 338,299.
  'route:/cases': 308343, 'route:/sessions/:id/facilitate': 338299,
  // CASE-345 integration over Access c92b330d: previous cap + floor(1.1 × measured Brotli growth);
  // new lazy icons at measured + 10%. Values and before/after measurements are recorded in DECISIONS.md.
  'session-pdf': 57758, 'slide-render': 7511, 'projector-slides': 9769, 'builder-preview-snapshot': 16526, 'builder-workflows': 52558, 'builder-studio': 50117, 'builder-fit': 48453, 'builder-slides': 62909, 'builder-route': 51155, 'recap-pdf': 12766, 'builder-slides-css': 1711, 'builder-shell-css': 8896, 'icons': 1435, 'route:ended-summary': 86900, 'route:/cases': 312244, 'route:/display': 110776, 'route:/cases/:id/edit': 371973, 'route:/cases/:id/edit/workflows': 192401, 'route:/cases/:id/edit/preview': 292731, 'route:/history': 197974, 'route:/account': 197974, 'route:/sessions/:id/facilitate': 342197,

  // CASE-348, rich controls and Cases consolidation over fc588690: previous cap + floor(1.1 × measured growth).
  'admin-workbench': 28650, 'admin-people': 35583, 'admin-invitations': 26373, 'groups-screen': 50736, 'builder-inspection': 121695, 'builder-studio': 52369, 'builder-media': 20398, 'builder-page': 28917, 'console-room': 127366, 'portfolio-page': 42070, 'library': 48848, 'pair': 134275, 'route:/admin': 167286, 'route:/cases/new': 61190, 'route:/cases/:id/edit/workflows': 194758, 'route:/cases/:id/edit/preview': 293649, 'route:/history': 198772, 'route:/account': 198772, 'route:/sessions/:id/facilitate': 343100,

  // CASE-356 / 2026-11-04: bounded standing-rule growth, new lazy/menu entries at measured + 10%.
  // CASE-357: Julian approves the six final measured exceptions on 2026-11-04.
  ...{
  "admin-workbench": 32753,
  "admin-invitations": 36815,
  "help": 14653,
  "portfolio-page": 49748,
  "case-share": 8699,
  "route:/admin": 189902,

  "admin": 39763,
  "menu-account": 23284,
  "admin-people": 39141,
  "admin-workspaces": 28006,
  "groups-screen": 53700,
  "projector": 66784,
  "builder-route": 51454,
  "builder-page": 31359,
  "console-room": 130385,
  "account-page": 23281,
  "case-detail": 38060,
  "invite-page": 14322,
  "recap-pdf": 13041,
  "phone": 89253,
  "pair": 137285,
  "unavailable": 13999,
  "route:/": 62236,
  "route:/cases": 322428,
  "route:/cases/new": 65593,
  "route:/cases/:id/edit": 376392,
  "route:/cases/:id/edit/workflows": 199166,
  "route:/cases/:id/edit/preview": 298080,
  "route:/history": 204734,
  "route:/sessions/:id/facilitate": 353280,
  "route:participant-record#menu": 105082,
  "route:/#menu": 81498,
  "route:ended-summary#menu": 99885,
  "route:/display#menu": 134797,
  "route:/F#menu": 61786,
  "route:/present": 322428,
  "route:/create": 322428,
  "route:/create/new": 65593,
  "route:/sessions": 204734,
  "route:/sessions/:id": 204734
},
  // CASE-359 / 2026-11-04 owner-authorised measured growth. Fixed caps; measured values never rewrite ceilings.
  // Existing: previous cap + floor(1.1 × positive growth from verified 2e802936). New audition closures/unions: measured + 10%.
  ...{
  "music-audition": 24502,
  "admin-workbench": 33556,
  "groups-screen": 54763,
  "builder-inspection": 123869,
  "builder-studio": 54576,
  "builder-media": 22576,
  "help": 15640,
  "console-room": 131386,
  "case-share": 9505,
  "invite-page": 15335,
  "pair": 138291,
  "music-audition-css": 9390,
  "route:/": 63244,
  "route:/cases/:id/edit": 377439,
  "route:participant-record#music": 137884,
  "route:/#music": 113160,
  "route:ended-summary#music": 132656,
  "route:/cases#music": 376174,
  "route:/admin#music": 235658,
  "route:/display#music": 155495,
  "route:/cases/new#music": 101206,
  "route:/cases/:id/edit#music": 442448,
  "route:/cases/:id/edit/overview#music": 450191,
  "route:/cases/:id/edit/workflows#music": 249671,
  "route:/cases/:id/edit/preview#music": 355759,
  "route:/history#music": 253790,
  "route:/account#music": 165690,
  "route:/F#music": 94606,
  "route:/sessions/:id/facilitate#music": 409880,
  "route:/present#music": 376174,
  "route:/create#music": 376174,
  "route:/create/new#music": 101206,
  "route:/sessions#music": 253790,
  "route:/sessions/:id#music": 253790
},
  // CASE-362: shared Music error toast; fixed owner-approved growth over e1da9fd1, after compaction.
  ...{
  "groups-screen": 55777,
  "builder-page": 32408,
  "help": 16688,
  "console-room": 132432,
  "invite-page": 16364,
  "phone": 90287,
  "pair": 139337,
  "unavailable": 15046,
  "route:/": 64287,
  "route:/cases/:id/edit": 378488,
  "route:/cases/:id/edit/workflows": 200215,
  "route:/cases/:id/edit/preview": 299129,
  "route:/history": 205754,
  "route:/sessions": 205754,
  "route:/sessions/:id": 205754
},
  // CASE-366: fixed measured-growth allocation over 688b362c; imports remain lazy and fully charged.
  "route:/cases": 336887,
  "route:/history": 206228,
  "route:/sessions/:id/facilitate": 367733,
  "route:/present": 336887,
  "route:/create": 336887,
  "route:/sessions": 206228,
  "route:/sessions/:id": 206228,
  // CASE-364: fixed measured-growth allocation; owner-approved caps after eager-engine trimming.
  ...{
  "admin": 40041,
  "library": 50559,
  "route:/admin": 217410,
  "route:/cases/:id/edit/workflows": 200463,
  "route:/cases/:id/edit/preview": 299439,
  "route:/sessions/:id/facilitate": 370507,
  "route:/admin#music": 263166
},
  // CASE-365: fixed measured-growth caps for shared feedback graphics, metadata dialogs and CSS-independent Sessions exports.
  ...{
  "portfolio-page": 50623,
  "feedback-results": 20872,
  "admin": 40837,
  "feedback-presentation-css": 1369,
  "route:/cases": 340720,
  "route:/present": 340720,
  "route:/create": 340720
},
  // CASE-366 integration: preserve main email/URL code; fixed +1.1 times measured delta over the verified UI source.
  "recap-pdf":13092,"route:/cases/:id/edit/workflows":200579,
  // CASE-367: approved measured growth over a1e1b8c7: Admin 217307 -> 217497, previous cap + ceil(190 * 11 / 10).
  "route:/admin":217619,
  // 2026-11-05 CASE-371: approved fixed measured growth over deployed eb4f596d; only exceeded entries.
  // Workspaces 27658 -> 28689, cap 28006 + floor(1031 * 1.1) = 29140;
  // Admin union 217534 -> 217826, cap 217619 + floor(292 * 1.1) = 217940.
  ...{"admin-workspaces":29140,"route:/admin":217940},
  // CASE-372: shared workbench state/date/apply/clear tools and aligned disclosure.
  // Exact 3ed45c36 baseline: Admin 217826 -> 217975 (+149); approved cap 217940 + floor(149 * 1.1) = 218103.
  // All other caps stay fixed; the facilitator route measures 370499 under its existing 370507 cap.
  ...{"route:/admin":218103},
  // CASE-373: owner-authorised exact measured growth over cc2e5cf4; only exceeded caps.
  // New case-workspace-access entry uses its fixed measured baseline + 10%; no unbudgeted lazy import.
  ...{"admin-workbench":36040,"admin-people":41699,"admin-workspaces":32018,"admin":40871,"admin-css":3463,"route:/cases":343508,"route:/admin":221845,"route:/sessions/:id/facilitate":373295,"route:/present":343508,"route:/create":343508},
  // CASE-376: Julian approved these fixed measured values on 2026-11-05; the 10% formula is unchanged.
  ...{"builder-route":51776,"builder-page":33056,"help":17107,"briefing":25690,"console-room-tab":32564,"console-room":133067,"groups-screen":56341,"admin":41683,"portfolio-page":51249,"phone":90929,"unavailable":15456,"route:/":65027,"route:/cases":346396,"route:/admin":234875,"route:/display":111110,"route:/cases/new":68411,"route:/cases/:id/edit":381305,"route:/cases/:id/edit/workflows":203396,"route:/cases/:id/edit/preview":302256,"route:/sessions/:id/facilitate":376176,"route:/present":346396,"route:/create":346396,"route:/create/new":68411,"issue-reporter":15605,"issue-entry":4088,"admin-issues":15757,"issues-css":533,"route:participant-record#report":95114,"route:/#report":83652,"route:ended-summary#report":107944,"route:/cases#report":389831,"route:/admin#report":260080,"route:/display#report":136565,"route:/cases/new#report":85600,"route:/cases/:id/edit#report":429576,"route:/cases/:id/edit/overview#report":437319,"route:/cases/:id/edit/workflows#report":234053,"route:/cases/:id/edit/preview#report":342859,"route:/history#report":200792,"route:/account#report":108146,"route:/F#report":63474,"route:/sessions/:id/facilitate#report":423179,"route:/present#report":389831,"route:/create#report":389831,"route:/create/new#report":85600,"route:/sessions#report":200792,"route:/sessions/:id#report":200792,"route:participant-record#menu#report":120561,"route:/#menu#report":97602,"route:ended-summary#menu#report":115359,"route:/display#menu#report":150719,"route:/F#menu#report":77627,"route:participant-record#music#report":150394,"route:/#music#report":126487,"route:ended-summary#music#report":145192,"route:/cases#music#report":411649,"route:/admin#music#report":288965,"route:/display#music#report":168431,"route:/cases/new#music#report":114485,"route:/cases/:id/edit#music#report":455806,"route:/cases/:id/edit/overview#music#report":463549,"route:/cases/:id/edit/workflows#music#report":262938,"route:/cases/:id/edit/preview#music#report":369090,"route:/history#music#report":229677,"route:/account#music#report":137031,"route:/F#music#report":107461,"route:/sessions/:id/facilitate#music#report":444998,"route:/present#music#report":411649,"route:/create#music#report":411649,"route:/create/new#music#report":114485,"route:/sessions#music#report":229677,"route:/sessions/:id#music#report":229677}
});
const SHELL = 'app';
// Julian's 2026-10-07 ruling (CASE-179): measure SW structure without generated digest entropy.
// Match only builder-shaped asset URLs and shell cache identities; preserve names, extensions,
// wire versions and all other source. The deployed worker and its cache keys are never rewritten.
const normaliseSwHashes = bytes => bytes.toString()
  .replace(/(\/assets\/[a-z0-9-]+\.)[a-f0-9]{64}(\.(?:mjs|css|woff2|svg|txt|wav|mp3)\b)/g, (_, prefix, suffix) => `${prefix}${'0'.repeat(64)}${suffix}`)
  .replace(/(case-shell-wire[0-9]+-)[a-f0-9]{64}\b/g, (_, prefix) => `${prefix}${'0'.repeat(64)}`);
export async function measureEntries(outDir, entries, routes = {}, deferredRoutes = {}) {
  await init;
  const results = {}, named = new Set(Object.values(entries)), closures = {}, lazies = {}, fileSizes = new Map();
  // CASE-166 (Julian, 2026-10-06, "trim first"): an entry is measured as its static closure, the bytes a
  // page must load before it runs. A literal dynamic import() starts a separate chunk, which must itself be a
  // named, budgeted entry (or already inside the importer's static closure); an unbudgeted lazy chunk fails,
  // so no byte escapes a budget.
  for (const [name, path] of Object.entries(entries)) {
    const seen = new Set(), lazy = new Set(); let size = 0;
    const visit = async file => {
      if (seen.has(file)) return; seen.add(file);
      if (file.includes('..') || !/^(assets\/|sw\.mjs$)/.test(file)) throw new Error('invalid_budget_asset');
      const bytes = await readFile(join(outDir, file));
      const compressed = brotliCompressSync(file === 'sw.mjs' ? normaliseSwHashes(bytes) : bytes).length;
      size += compressed; fileSizes.set(file, compressed);
      if (file.endsWith('.mjs') && file !== 'sw.mjs') for (const dependency of parse(bytes.toString())[0]) {
        if (dependency.d === -2) continue;
        if (!dependency.n?.startsWith('/assets/')) throw new Error('invalid_budget_import');
        if (dependency.d > -1) { lazy.add(dependency.n.slice(1)); continue; }
        await visit(dependency.n.slice(1));
      }
    };
    await visit(path); results[name] = size; closures[name] = seen; lazies[name] = lazy;
    for (const chunk of lazy) if (!seen.has(chunk) && !named.has(chunk)) throw new Error(`unbudgeted_dynamic_chunk:${chunk}`);
  }
  // A route's total counts each module once across the chunks the route loads. Card 29 re-check (CASE-166): a route must list every
  // member (a missing one fails), and a member other than the shell may lazily import only chunks the route lists,
  // so a lazy import can never pull another route's chunk in without being charged. The shell (`app`) is the
  // dispatcher that lazily imports every surface by design, so it is exempt.
  for (const [route, members] of Object.entries(routes)) {
    for (const member of members) if (!closures[member]) throw new Error(`route_member_missing:${route}:${member}`);
    const listed = new Set(members.map(member => entries[member]));
    for (const member of members) if (member !== SHELL) for (const chunk of lazies[member]) {
      if (closures[member].has(chunk) || listed.has(chunk)) continue;
      const deferred = Object.entries(deferredRoutes[route]?.[member] ?? {}).find(([name]) => entries[name] === chunk);
      if (!deferred || !routes[deferred[1]]?.includes(member) || !routes[deferred[1]]?.includes(deferred[0]))
        throw new Error(`route_dynamic_escape:${route}:${member}:${chunk}`);
    }
    const union = new Set(members.flatMap(member => [...closures[member]]));
    results[route] = [...union].reduce((sum, file) => sum + fileSizes.get(file), 0);
  }
  return results;
}
export function assertBudgets(measured, budgets = BUDGETS) {
  for (const [name, bytes] of Object.entries(measured)) {
    if (!Object.hasOwn(budgets, name)) throw new Error('unbudgeted_entry');
    if (bytes > budgets[name]) throw new Error(`bundle_budget_exceeded:${name}:${bytes}>${budgets[name]}`);
  }
  for (const name of Object.keys(budgets)) if (!Object.hasOwn(budgets, name) || !Object.hasOwn(measured, name)) throw new Error(`stale_budget:${name}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildClient();
  const measured = await measureEntries(fileURLToPath(new URL('../dist', import.meta.url)), { ...result.entries, sw: 'sw.mjs' }, ROUTES, DEFERRED_ROUTES);
  assertBudgets(measured);
  console.log(`client size: ok (${Object.entries(measured).map(([name, bytes]) => `${name}=${bytes}`).join(', ')})`);
}
