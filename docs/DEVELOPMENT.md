---
doc: CASE-DEVELOPMENT
status: living
purpose: Local setup and repeatable verification for Case development.
read_when: Setting up a Mac checkout, running the local gates, or reviewing dependency audit results.
---

# Development

Work from a Case worktree on a topic branch. Keep local tests against throwaway services; the commands below do not need a Cloudflare account, the live Supabase project, or production secrets. See `AGENTS.md` for branch and deployment rules.

## macOS setup

1. Install Node 22.5 or later, then run `npm ci` without peer-dependency overrides.
2. Install PostgreSQL with `brew install postgresql@16`. Homebrew may keep its binaries outside the default `PATH`; use `PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH CASE_REQUIRE_DB=1 npm run test:db` to require the database gate. The script creates and deletes a local throwaway cluster.
3. Install the browser with `npx playwright install chromium`. Run `PW_PORT=4187 npm run test:e2e` when changing the room UI, shared/client/Worker code, fixture, or browser harness. Playwright starts the local prototype server.

Run `PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH CASE_REQUIRE_DB=1 npm run verify` before pushing. This includes `check`, Node tests, the real workerd Durable Object tests and the PostgreSQL migration assertions. On other systems, put PostgreSQL 15 or later binaries on `PATH` and use the same `CASE_REQUIRE_DB=1` flag.

## Dependency review

Run `npm run audit:deps` after changing dependencies. It reads the npm audit report and the lockfile dependency graph. Every high or critical advisory must have an exact advisory ID, package and dev-only route in `audit-allowlist.json`. A route from a runtime dependency fails even if listed. Each entry needs a reason and a UTC review date no more than 30 days after its added date; expired entries fail. Remove an entry when the upstream package is fixed. The workflow runs a blocking audit on dependency-file PRs and weekly, and reports audit failures on other PRs without blocking those PRs.

The workflow validates its YAML with actionlint and tests that no GitHub workflow references `secrets.*`. The nightly browser run needs no secret; it uses local workerd and a local browser.

## Participant iPhone AS-020 rehearsal (owner-only; pending)

Use a local owner-controlled test room served over an iPhone-reachable secure test origin, with synthetic names/answers. Do not use a deployed/metered origin from automated tests. Record iPhone model, iOS/Safari version, network and exact build SHA; use the facilitator on a separate screen.

1. Open the room QR in the iOS captive-portal sheet if available. Check the six-character code and the alternative code entry; join with a synthetic name/avatar. Record whether the sheet permits local storage, IndexedDB and WebSocket/long-poll.
2. Leave that sheet and open the same QR in ordinary Safari. Confirm token-loss copy explains that this browser has no saved place and requires a new join, rather than showing a previous browser's private answers. Record storage partition behavior and any duplicate synthetic participant requiring facilitator removal.
3. Open a decision, turn on airplane mode, change three answers, verify Not sent yet count. Reload in the same Safari context while offline: public shell and counts may render, but private answer drafts do not render before server identity confirms. Reconnect; verify only the latest answer saves once per round and indicator clears. Repeat after backgrounding long enough for Safari to close an IDB handle.
4. Pause/resume and confirm held-answer copy and later saved receipt. End the room and check own recap only; close/reopen Safari and confirm same-room recap binding without a duplicate join. Open another room QR and confirm previous capability/queue cannot resume into that room.
5. Test local Download recap(PDF)/Print recap through iOS share/print UI with network off; record actual available PDF save route. Confirm only the owner's answers print.
6. Clear Safari site data and reopen the original QR/session URL. Confirm rejoin/token-loss explanation and no old private answer or another participant's recap. After the recap deadline, reopen and verify capability/queue cleanup.

Expected result stays PENDING until Julian supplies device evidence. Browser UA emulation or partition fakes do not establish captive-portal support or iOS print/PDF behavior. Phone-connectivity advice belongs on the phone; CASE-122 prohibits projector phone-connectivity advice.
