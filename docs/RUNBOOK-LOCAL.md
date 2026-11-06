---
doc: CASE-RUNBOOK-LOCAL
status: evolving
purpose: How to run a Case room against the real Worker on your own machine (local workerd, no Cloudflare account, no Supabase), and how the client transport behaves while you do.
read_when: Running or debugging the room windows against the real Worker, the transport tests, or the Phase 1 exit-gate e2e.
---

# Running a room against a local Worker

Everything here is local: `wrangler dev` runs the Worker and its Durable Objects in workerd (Miniflare), with storage in a directory you choose. Nothing touches Cloudflare or Supabase (AGENTS.md hard rule 12). Never point any of this at a deployed Worker.

## The automated way

| Command | What it runs |
|---|---|
| `npm run test:runtime` | `tests/transport.test.mjs`: the client transport against a local Worker, with injected network faults. It is also part of `npm test` and so of `npm run verify`. |
| `npm run test:real` | `e2e/room-real.spec.mjs`, the Phase 1 exit gate: every room window, through its own UI, against a local Worker. It is also part of `npm run test:e2e`. |

Both start the Worker themselves through `tests/helpers/local-worker.mjs`: a free port, a throwaway storage directory, and test-only vars passed on the command line (`SUPABASE_JWT_SECRET` set to a throwaway value, `CASE_ALLOW_HS256=1`, `CASE_DEV_INLINE_CASES=1`, `BROADCAST_COALESCE_MS=0`). The HS256 path is local-only and is refused whenever `CASE_ENV` is set. Deployed sign-in uses `SUPABASE_JWT_ISSUER` and `SUPABASE_JWKS_URL`, with ES256 or RS256 keys. Set `CASE_WORKER_LOG=1` to see the Worker's log. The e2e also starts `scripts/serve-prototypes.mjs` with an `/api` proxy, so the windows and the API share one origin.

## By hand

1. **Start the Worker** in a terminal, with a throwaway secret and storage outside the repo:
   ```sh
   npx wrangler dev --ip 127.0.0.1 --port 8787 --persist-to "$(mktemp -d)" \
     --var SUPABASE_JWT_SECRET:dev-only-throwaway --var CASE_ALLOW_HS256:1 --var CASE_DEV_INLINE_CASES:1
   ```
2. **Serve the windows on the same origin.** The Worker is same-origin only (no CORS), so the prototype server forwards `/api/*` (WebSocket upgrades included) to it:
   ```sh
   CASE_API_PROXY=http://127.0.0.1:8787 PORT=4180 node scripts/serve-prototypes.mjs
   ```
3. **Create a room** as a facilitator. Sign a JWT with the throwaway secret and post the fixture:
   ```sh
   node --input-type=module -e '
     import { signTestJwt } from "./src/worker/auth.mjs";
     import { uuidv7 } from "./src/shared/ids.mjs";
     import { readFileSync } from "node:fs";
     const jwt = await signTestJwt({ sub: uuidv7(), aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, "dev-only-throwaway");
     const r = await fetch("http://127.0.0.1:4180/api/v1/sessions", { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ caseDocument: JSON.parse(readFileSync("src/fixtures/synthetic-workshop.case.json", "utf8")) }) });
     console.log(await r.json());'
   ```
   It prints `{ sessionId, joinCode, facilitatorToken, expiresAt }`.
4. **Open the console.** The facilitator token reaches the page through sessionStorage, never a URL. **Dev only**, until Phase 1b's sign-in UI. Open `http://127.0.0.1:4180/prototypes/room/facilitator.html?api=http://127.0.0.1:4180&session=<sessionId>`, then run this in that tab's devtools console and reload:
   ```js
   sessionStorage.setItem('case:facilitator:main:token', JSON.stringify({ sessionId: '<sessionId>', token: '<facilitatorToken>' }))
   ```
5. **Pair a display.** Open `display.html?api=http://127.0.0.1:4180` in another window. It goes to `pair-display.html` and shows an 8-character code. On the console, open the Room tab and enter the code under Displays → Pair a display. The display then opens the room.
6. **Join phones.** Open `phone.html?api=http://127.0.0.1:4180&slot=A` (and `B`, `C`, …) and type the join code.

Add `&scale=0.2` to any window URL to shrink the transport timings, so heartbeats and dead-link detection happen in seconds. Without `?api=`, every window runs the stage C lab bus exactly as before (`prototypes/room/index.html`).

## What the transport does

`src/client/transport.mjs` has the same API as the lab bus (`prototypes/room/lib/bus.mjs`), and `prototypes/room/lib/link.mjs` picks one or the other from the page URL. Its design is in `docs/ARCHITECTURE.md` §4 (Client transport). What you can watch:

- `link.mode` is `ws`, `long-poll` or `poll`, and is passed with every `status` event.
- `link.status` is `connecting`, `online` or `lost`. A socket that stays OPEN but sends nothing for `DEAD_AFTER_MS` turns `lost`, and is replaced.
- In the console, `window.casePhone.link` (phone) exposes the link for inspection. It never exposes the token.
- `link.pinned` is true once two stalled sockets have pinned this network to long-poll (AS-060). The pin lives in localStorage as `case:transport:pin` for 24 h. To clear it while debugging, run `localStorage.removeItem('case:transport:pin')`. A display starts on long-poll on purpose.
- The network check runs against the local Worker too: open `http://127.0.0.1:4180/prototypes/room/check.html?api=http://127.0.0.1:4180`. Add `&hold=5000&wait=2` to shorten it.
- Real-room windows register the offline shell (`prototypes/room/shell-sw.mjs`); the lab never does. If a stale shell gets in the way, unregister it in devtools (Application, Service workers). It caches shell files only, never `/api/` or case data.

## Built shell (card 10)

The manual Wrangler command runs `scripts/build-client.mjs` before local workerd starts, then serves generated `dist/` assets on the Worker's origin. Automated helpers instead prebuild a private asset directory inside each Worker's throwaway storage directory and use a derived config with absolute main/assets paths and no root custom build; original bindings and migrations stay intact. Parallel tests cannot rebuild or remove another Worker's assets. Using the local Worker from §By hand, open `http://127.0.0.1:8787/check` for the real network check or `/` for the shell. `PW_PORT=4189 npm run test:e2e -- e2e/client-shell.spec.mjs` exercises static headers, cache privacy and an actual waiting/accepted update against throwaway local workerd.

`npm run build:client` defaults to the local environment. The build accepts `--env staging` or `--env production` with an exact public `--build-sha`; Wrangler selects these through each environment's build command. The generated `_headers` uses the shared policy, and only hashed `/assets/` paths are immutable. HTML handling is disabled: exact `/` and `/check` rewrites and named room/session rewrites use generated HTML, with no catch-all SPA route. Room routes target the non-index `room.html` alias because pinned Wrangler rejects wildcard proxies to `index.html` as loops. Unknown paths stay 404.

The service worker writes only `case-shell-wire<version>-<SHA-256>` Cache Storage, hashing the public shell paths and final bytes. It does not intercept `/api/`, mutations, case data or other origins. Cache failures preserve healthy online responses; real 5xx stays an error. A waiting version is offered; declining does not reload, and accepting reloads after `controllerchange`. Registration uses a `case-default` Trusted Types policy restricted to the exact `/sw.mjs` path; browsers without Trusted Types use that same constant. No HTML/script creation policy is added.

The served Card 11 console keeps account access and room credentials in memory. Its default refresh token uses tab sessionStorage; an eligible phone may explicitly opt into localStorage. The same-tab PKCE verifier has a bounded ten-minute navigation exception. Shared-PC `/P` keeps its pair secret and room credential in memory only. `idb.mjs` remains the generic reopen-once helper; Card 11 does not write an IDB store. Card 14 has ported the projector, while the rich console and participant phone remain Cards 12 and 13 work. The approved measured Brotli baselines for Card 11 are console 13,019, pair 32,211 and app 55,819 bytes, each still capped at 110%; the other entries retain their earlier baselines. Full served-room AS-061 and AS-036 case-pack teardown remain pending their client ports.

## Node test-file scheduling (CI65 preparation, 2026-10-04)

`npm test` selects the complete `tests/*.test.mjs` suite and explicitly gives Node one test-file worker with `--test-concurrency=1`. This serializes files that create local Workers; it does not limit the number of Workers, connections or concurrent operations inside a file. `npm run test:runtime`, native Vitest tests and Playwright retain their existing commands and limits.

`tests/node-worker-scheduling.test.mjs` executes the actual parsed package options over two distinct generated fixture files sharing an exclusive filesystem lease. An explicit two-worker control must overlap the fake lifetimes; the package-policy run must execute both files without overlap. The finite fixture observation window is controlled test infrastructure, not native workerd capacity, hosted timing or a production timeout. No live service is contacted.

Card20 source032 failed exact CI37180121033 on Linux joins and macOS load/receipt assertions. Concurrent test-file Workers are a hypothesis, not an established cause. On a two-CPU Node runner the original default may already be one test-file worker. This scheduling follow-up therefore needs its own fresh-main gates and exact CI; Card20 must subsequently consume reviewed main and pass fresh gates/exact CI. Reversal restores the previous implicit scheduler through review. No retries, skips, runtime or expectation limits, rate limits or assertions are relaxed.

## Ranked-projector fixture scheduling (2026-10-04)

The Card25 loaded-font geometry fixture keeps four normal local Workers and sixteen distinct rooms, browser contexts and capabilities per count; since 2026-10-06 each count runs as four tests, one per authored-text kind (one Worker and four rooms each), because a whole count reached 39-60 s against Playwright's 60 s timeout on 2-vCPU hosted runners (about 1 s Worker start, 3 s pairing and font setup and under 0.6 s of measurement per kind locally). Within each Worker, its four already-independent pages now measure concurrently; each room still advances its rank positions serially. All full prompts, labels, glyphs, ranks, totals, geometry checks and captures remain required: 496 measured states across112 ordinary pages and220 captures for counts2–8. Successful pages close after all their measurements; all callbacks settle before remaining page cleanup and Worker stop. A primary assertion is rethrown unchanged when cleanup succeeds; combined assertion/cleanup errors report both and cannot earn intended-fault proof credit. This is a reversible test-harness scheduling proposal, not a product transport fix, performance guarantee or provider/device measurement. The actual a551 CI run failed six unchanged60-second geometry targets (count2 passed57.5s), with33/39 shard targets passing; the single count3 trace records late measurement work around the test deadline without proving a resource cause. Current-source proofs, full gates and exact published CI remain pending at this checkpoint. Existing commands, one Playwright worker, 60-second test and10-second expectation limits, zero retries, rate limits and eight size budgets stay unchanged.

## Omitted-avatar fixture sensitivity (2026-10-04)

(2026-10-05 documentation checkpoint) The room-lab names/joining target still joins without choosing an avatar and validates the allowlisted automatic assignment. A legacy Teal/quiff avatar already checks those two edit controls; checking them again raises no change event and legitimately preserves its original ID. The fixture now selects Blue before the final Teal/quiff selection so Save exercises an actual edit for every possible initial legacy avatar. The original final IDs, roster/privacy checks and all timing/retry limits remain unchanged. Exact ac0 CI37195841406 failed this target after rename retained `shadows-05`; acceptance is inferred from the trace revision/journal and collapsed editor, while the exact receipt enum was not captured; seven other jobs passed. This is test sensitivity evidence, not an application transport defect. The controlled negative fixture pinned only the prototype join-picker selection to legacy index4 and removed the intermediate change; its intended mismatch, exact two-file restoration and same-target pass were independently admitted. Carrier source `198928a` passed its source-bound local six gates and all eight exact-CI jobs in run37200358565; the proof and source/CI bindings are recorded in [PR67](https://github.com/julianjming-hash/case/pull/67). Those completed carrier checks do not prove the later Card20 source or its CI.

## Card20 local load evidence (2026-10-05)

**Manual 150-phone gate (CASE-154).** CI runs only the 50-phone load test. Before any release, run `npm run test:load150` on an otherwise idle Mac; it must pass with every original assertion. The harness runs phones at real product timings (CASE-154), so the earlier compressed-deadline retry storm (`load_loss_replay_missing`, `load_recorded_vote_count_mismatch`) should no longer occur; treat any such failure as a regression to investigate.

The 50/150-phone harness still requires a qualified positive HTTP receipt loss and same-event `already_accepted` replay. Both sizes require zero loss; only 50 phones has the one-second p95 criterion. Fixed diagnostic buckets distinguish first-phone HTTP outcomes, fetch failures and the final receipt without logging bodies, IDs, URLs, credentials or answers. They diagnose controlled probes. The macOS/Linux CI failures were traced to the harness's compressed 1 s request deadline under CPU load (CASE-154); see the manual 150-phone gate below.

The local-only `runLoad` signal follows the existing Node test timeout. It prevents new phases after abort and retains ownership through finite startup/stop cleanup; it adds no timer, retry, rate or concurrency change. A never-settling injected factory remains unverified ownership. Current source, proof and exact-CI records belong to [PR64](https://github.com/julianjming-hash/case/pull/64); canonical operator measurements remain in the operations runsheet (private historical reference; not distributed). Deployment and owner rehearsal are separate.
