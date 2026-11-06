---
doc: CASE-ARCHITECTURE
status: living
purpose: The data architecture of Case. Covers storage tiers, the Postgres and Durable Object schemas, the case document, identifiers, URLs and QR codes, media layout, retention, and when to revisit each choice.
read_when: Before touching the database, the live-room runtime, IDs, URLs, media storage, or anything that scales with users.
---

# Case architecture

Implemented, tested sources:
- `db/supabase/migrations/20261001000000_case_init.sql`
- `db/supabase/migrations/20261002000000_phase_1b_rpcs.sql`
- `db/durable-object/room-schema.sql`
- `src/shared/ids.mjs`
- `src/shared/urls.mjs`

Decisions: CASE-046 to CASE-054 in [`DECISIONS.md`](./DECISIONS.md).

## Teaching inventory and abandoned Lobby cleanup — 4 November 2026

CASE-359 adds HTTP-v2 opt-in P-32 query/statistics readers. Teaching evidence is a recorded first slide/start, a round or retained manual/debrief teaching event; returning to Lobby does not erase it. The predicate applies before paging and totals. Counts are cumulative distinct pseudonymous participant identities, preserved by the existing final manifest or retained anonymous participant rows; incomplete evidence is a lower bound/unknown. Teaching-date filtering follows the date shown in the UI. Legacy HTTP/RPC shapes, own/case/workspace/admin visibility and identifiers remain unchanged.

The existing hourly administrative sweep calls service-only `purge_abandoned_lobbies` with a maximum of 200. Eligibility requires age ≥30 days, expiry+24h already elapsed, no teaching/round evidence and only known Lobby journal kinds. A partial cleanup index and row locks bound work; repeat calls are idempotent and a counts-only job heartbeat records progress. Session child/archive rows cascade; separate audit records remain. Unknown events and anomalous unexpired rows stay available for investigation. Existing ≤24h live expiry, SQL expiry maintenance and end/expiry+24h personal/DO deletion are unchanged and earlier than the new metadata cleanup.

Settings Music reuses the public shipped music assets/player/engine only after deliberate activation. Its AudioContext, timer selection, dragging state, scene and countdown are isolated from the live room and stored console timer choice; playback is gesture-gated and torn down on close/pagehide/reduced motion. It reads no private pack and sends no room/API commands.

## Canonical workspace placement — 5 November 2026

CASE-373 adds private `case_workspace_access` rows keyed by canonical case and additional workspace, with run/edit only. Home stays `cases.workspace_id`; role resolution caps each extra workspace source by its membership and sharing level, then chooses the strongest applicable case access. No recipient workspace management or session-wide record rights follow. Catalogue/draft metadata include eligible shared cases without copying content or exposing home groups. Case detail and starts retain canonical home context; past session rows retain their original workspace.

Workspace names have an independent `details_revision`; case placement has `placement_revision`. Service-only RPCs recheck both scopes and compare revisions, update audit transactionally, preserve UUID/slug/document/hash identities and cascade only existing case-grant/invitation home bindings. Home moves hold the shared Builder lock, refuse active sessions/unresolved review, clear home grouping and retain immutable publication/session history. Waiting writers recheck access/home after that lock. Linked image references remain case-scoped at their original storage keys; readiness, release, rendition and unused-image checks preserve those pins without admitting guessed foreign assets. No new personal fields or retention change.

## 1. Goals

| Goal | Design answer |
|---|---|
| A 50-person room feels instant on bad hospital Wi-Fi | The whole live room runs inside one Durable Object close to its users. A vote is one local SQLite write plus fan-out, with no database round trip. |
| Cost scales with *rooms*, not with *votes* | Postgres takes **zero writes per vote**. The Durable Object archives in batches at phase changes, and once more at room end. |
| A room survives any single dependency failing | Supabase down: the room carries on and the archive queue retries. Durable Object evicted: its SQLite is durable and rebuilds on next request. Network down: manual mode (see `HANDOFF.md`). |
| No personal data outlives its purpose | Names, per-person answers and free text are deleted 24 h after the room ends. Aggregates and pseudonymous ids remain. |
| Nothing secret reaches a public client | Clients never touch Postgres. The Worker projects per role, and the display and phones receive revealed material only. |
| Horizontal scale with no re-architecture | Every room is an independent Durable Object. Authoring is low-volume, document-shaped Postgres traffic. |

## 2. Storage tiers

| Tier | Holds | Why here |
|---|---|---|
| **Browser** (memory, sessionStorage, localStorage, Cache Storage) | Participant: the capability token in localStorage until its recap expires, then purged on load (CASE-106); pending votes with idempotency keys in memory. Display: its paired token in sessionStorage. Facilitator: the token, the prefetched case pack and the room-state mirror **in memory only** (CASE-092, CASE-103), and the manual segment in sessionStorage (CASE-093), room capabilities and private case memory purged at end, sign-out or tab close, while a validated manual segment survives navigation (CASE-175). The account refresh token persists in localStorage until account-ending cleanup (CASE-175, accepted risk A3). Any device: the long-poll pin `case:transport:pin` (`{network: untilMs}`, no token or personal data, CASE-100), and the offline app shell in Cache Storage: public HTML, code, styles, fonts and avatars only, never `/api/` responses or case data (CASE-101). | Offline tolerance; private case data stays out of persistent storage, while account persistence on shared profiles is accepted risk A3. |
| **Durable Object + SQLite** (one per live room) | Authoritative live state: phase, epoch, revision, participants, rounds, responses, receipts, journal. | Single-threaded writer, so votes, locks and reveals serialise with no locks. Strongly consistent, co-located with fan-out, and durable. |
| **Postgres** (separate Supabase project) | Authoring (workspaces, cases, drafts, versions, assets, sources, agent runs) and the session **archive**. | Relational integrity and a durable history. The load is small and document-shaped. |
| **R2** (`MEDIA`, card 59, CASE-268) | Builder images, GIFs and videos: a still's two JPEG renditions, or a GIF's or video's cleaned file and JPEG poster, content-addressed (`media/<workspace_id>/<sha256>` with `.jpg`, `.gif` or `.mp4`). No case packs. | Private bucket the Worker alone reads; immutable bytes; no public URL. |
| **Cache API** (edge) | Public app-shell assets only. | Case packs remain out of the cache. |

There is no KV: nothing in Case needs eventually consistent global reads.

**Scoped browser persistence (CASE-186).** Participant capability keys include their exact room UUID; ordinary navigation keeps only strictly validated credentials and bounded known owner rows. Legacy main-slot migration validates identity before committing. A single origin Web Lock serializes destructive cleanup and queue commits. The non-personal generation fence invalidates late current-document operations immediately and other documents after durable commit. Security cleanup remains queued and completes after caller timeout; native IndexedDB deletion keeps the barrier until its actual settlement. Expired-key removal rechecks captured token, expiry and exact current key inside the queue transaction so a valid replacement survives. Every live phone store update also checks its captured credential inside the locked queue transaction before invoking the change callback; delayed storage events cannot authorize an old owner to filter, enqueue, admit, rewrite or erase a replacement owner's rows.

### Request paths

```text
Author edits    Builder ─HTTPS→ Worker ─RPC→ case_api.save_draft (CAS on revision)
Publish         Author ─→ Worker ─RPC→ case_api.publish_draft ─→ immutable Postgres case_version
Start room      Facilitator ─→ Worker ─RPC→ get_me + get_case_version_for_workspace ─→ verify exact document hash
                ─→ Directory DO registers the code ─→ case_api.create_session ─→ room DO initialised (alarm at expires_at; locationHint 'oc')
                Facilitator device ─GET room case-pack in memory       ← only the facilitator gets the full pack
Join            Phone ─GET /J/<code>─→ Worker ─→ Directory DO (code → session_id; no Postgres) ─→ room DO issues participant id + capability token
Vote            Phone ─POST (client_event_id)─→ Worker ─→ Durable Object: upsert response, write receipt, journal, fan-out
Phase change    Durable Object journals it, then enqueues an archive batch (alarm retries with backoff)
Archive         Durable Object ─→ Worker ─RPC→ case_api.archive_session_batch (idempotent; replay-safe)
End             Durable Object final batch ─→ case_api.end_session; recap served from the DO for 24 h; then an alarm deletes DO storage
Expire          Room DO alarm at expires_at force-ends a room nobody ended (same path as End)
Purge           pg_cron every 15 min ─→ case_api.purge_expired_participant_data (writes a job heartbeat)
```

## 3. Postgres

**Release commit boundary.** `builder_release_candidate` drains the named deferred `case_versions_asset_set` trigger after inserting the version's asset pins, while still inside its existing authorized `SECURITY DEFINER` scope, then restores deferred mode. The trigger remains invoker-only; private-table grants remain closed. This avoids a commit-time permission failure after PostgREST regains `service_role`. `20261027000000_builder_release_commit.sql` patches only that point in the installed definition, preserving digest bytes and all other guards. See rollout evidence (private historical reference; not distributed).


Two schemas (CASE-053):
- **`case_app`** holds the private tables. RLS is enabled with no policies, and every privilege is revoked from `anon`, `authenticated` and `public`.
- **`case_api`** holds `SECURITY DEFINER` functions with `search_path = ''`, executable only by `service_role`, which only the Case Worker holds. Expose `case_api` in the Supabase API settings, and never `case_app`.

> 🔴 A `42501 permission denied` on a `case_app` table means a caller is going around `case_api`. Add or fix an RPC. **Never** fix it with a `GRANT`. This carries forward the iatrogenic `content_items` lockdown lesson.

| Table | Role | Key constraints |
|---|---|---|
| `workspaces`, `profiles`, `workspace_members` | Tenancy. `profiles.id` = `auth.users.id`. | `slug` is lower-kebab |
| `cases` | Identity, visibility, and future-library state of a case | `visibility`, `submission_state` CHECKs; `forked_from_version_id` |
| `case_drafts` | One mutable **document** per case | `revision` optimistic concurrency; ≤ 1 MiB |
| `case_versions` | Immutable published documents | `unique(case_id, version_no)`; update/delete trigger-blocked; `content_sha256` |
| `assets`, `case_version_assets`, `case_assets` | Media metadata (R2 holds the bytes); which cases an image was added for (CASE-342) | `unique(workspace_id, content_sha256)` (one image per file per workspace); legacy approval CHECK on rows still `approved` |
| `case_grants` | Can run or Can edit on one case for one person (CASE-336) | level `run`/`edit` only; one live grant per case and person; `(case_id, workspace_id)` references the case's own workspace |
| `workspace_policies` | The four per-workspace policies (CASE-337), with `workspaces.media_quota_bytes` (2 GB) | a row per workspace from a trigger; read only through `case_app.policies_of` |
| `invitations`, `invitation_events` | Invitations as records (CASE-339, CASE-341) and the per-inviter daily cap | reference stored as SHA-256 only; 90-day expiry; one pending per place and address; address nulled 30 days after the end |
| `sources`, `source_fragments`, `agent_runs`, `agent_proposal_groups` | AI authoring provenance | Fragment excerpt hash; per-group accept/reject |
| `sessions` | One row per room | Join code unique **among active rooms only** (partial index), so codes recycle |
| `session_participants` | Pseudonymous ids; name and token hash until purge | Purge nulls name and token |
| `session_rounds` | One per decision round; aggregate and resolution | `unique(session_id, decision_id, round_no)` |
| `session_responses` | Final answer per participant per round | `unique(round_id, participant_id)`; deleted at purge |
| `session_events` | Append-only journal copy | PK `(session_id, seq)`; `event_id` unique; update-blocked |
| `_lockdown_alerts`, `job_heartbeats` | Privilege backstop alerts and operational heartbeats | The event trigger and hourly sweep revoke stray `case_app` grants; `ping` writes the `keepalive` heartbeat |

**RPCs:**
- `save_draft`
- `get_draft`
- `publish_draft`
- `get_case_version`
- `create_session`
- `resolve_join_code`
- `archive_session_batch`
- `end_session`
- `purge_expired_participant_data`
- `ensure_profile`, `bootstrap_workspace`, `create_case`, `list_published_versions` (member checked; published list is keyset paged, 100 rows maximum)
- `get_me(p_user_id, p_limit, p_after, p_workspace_id)` returns only the caller's profile and at most 100 keyset-paged memberships; a workspace filter supports an authorization preflight
- `get_case_version_for_workspace(p_version_id, p_workspace_id, p_user_id)` returns the published document and exact hashed `document_text` only after workspace membership and version ownership checks
- `get_case_authoring_access(p_case_id uuid, p_user_id uuid)` returns only `(case_id, workspace_id)` for an owner or author of that case's workspace; a facilitator, outsider or missing case receives no row before draft or publish writes
- `builder_list_draft_summaries` (CASE-364, additive/unapplied) uses existing P-14 admission and the legacy draft inventory predicates/order, materialising at most limit+1 rows (limit 1–50, offset+limit ≤10000). A service-only SECURITY DEFINER function with empty search path/2s timeout emits explicit summary scalars and a ≤4096-byte numbers-only graph structure; bodies, sources, metadata, identities and digests never cross the response. Latest-publication relation uses the retained released paired-intent digest; current pending/approved review must match both draft revision and paired intent. Withdrawn versions remain publication-history facts, never availability claims. The Worker opts in only for `v=2` on the existing draft-list endpoint, validates/projects fields and adds `summaryVersion:2`; unversioned readers retain the exact old RPC/shape. The browser solves art lazily, yielding between cards, generation-fences rendering and clears retained summaries on retirement. No table, write, retention, privacy or permission-cell change.
- `list_owned_active_sessions(p_user_id uuid, p_limit integer, p_after uuid)` returns at most 100 caller-owned, unexpired active rooms as `(session_id, join_code, expires_at)` in stable keyset pages; a foreign or expired cursor is refused, and `service_role` alone may execute it
- `create_session(p_session_id, …)` accepts the Durable Object UUIDv7; the old id-minting overload is revoked from `service_role`
- `ping`, `heartbeats`, `lockdown_alerts_since(p_since, p_limit, p_after)` (ordered keyset pages of at most 100 alerts)

The lockdown backstop runs after relevant DDL and hourly through `pg_cron` where it is available. It revokes `case_app` privileges from `public`, `anon` and `authenticated` and records any removal in `_lockdown_alerts`. The migration also removes the function creator's global default `PUBLIC EXECUTE` for future functions; each exposed RPC needs an explicit `service_role` grant. The local database test runs the sweep without `pg_cron` and pages more than 1,000 alerts without omissions or duplicates.

The Worker has a weekly keepalive cron (`37 3 * * 1` UTC) and an hourly catch-up cron (`17 * * * *`) in both deployed environments. Each due run reads `heartbeats` before `ping`, then checks one bounded lockdown-alert page using the **previous** keepalive timestamp as its cursor; the hourly cron does nothing until that timestamp is more than six days old. The Worker clock decides whether catch-up is due. The timestamp returned by `ping` is validated within five minutes of the Worker clock and drives reported heartbeat ages: purge is stale after 30 minutes, keepalive after 14 days. A run makes at most three RPCs, with 2.5-second RPC timeouts and a ten-second total deadline that reserves time for the alert hook. The dead-man URL is called only after successful RPCs and acknowledged alert delivery (or acknowledged six-hour deduplication); busy or uncertain delivery keeps it silent. No URL or response body enters logs. Card 16 wires the required AlertDO transport; local native tests use fake delivery. See `docs/OPERATIONS.md` for owner configuration and staging drills.

Conflicts raise SQLSTATE `40001` with a message starting `revision_conflict`, which the Worker maps to HTTP 409.

**Performance notes:**
- **UUIDv7 primary keys** append to the right-hand edge of the btree, like bigserial. Random UUIDv4 would scatter across it.
- **Every foreign key has an index**, either the leading column of a PK or unique constraint, or an explicit one (completed after the 2026-10-01 red team). Hot list queries have composite `(owner, updated_at desc)` partial indexes.
- **Authorisation is checked inside every RPC**: `case_app.authorize` for a workspace action, `case_app.authorize_case` for a case action (the case derived from the bound row; a membership or a live grant on that case, with the workspace's policy cells), so a `case_api` function never trusts that the Worker already checked. Inventory: private historical reference (not distributed).
- **The case document is `jsonb`, read and written whole.** No query filters inside it, so it needs no GIN index; add one only when a query needs it.
- **Enumerations are `text` plus CHECK constraints**, so adding a value doesn't need an `ALTER TYPE` migration.
- **The Worker reaches Postgres through PostgREST RPC over HTTPS.** That needs no TCP pool and no `nodejs_compat`. Revisit Hyperdrive only if authoring latency is measured as a problem.

**Summary room history (CASE-190/P-32).** `GET /api/workspaces/<UUID>/history` uses bounded `limit` (default20/max100), `all|running|ended`, and an opaque ≤512-character actor/workspace/filter-bound cursor. The cursor anchors descending microsecond `created_at` and UUID ordering and grants no access. The Worker revalidates the account and current membership/admin entitlement for each page; `case_api.list_room_history` repeats authorization and returns metadata only. The additive `20261012000000_room_history.sql` migration makes visibility End+90days without destructive legacy changes. `archive_state=pending` remains honest until the separately scheduled contiguous final archive foundation. Existing P-23/end exports and24-hour personal-data purge remain unchanged.

### Credentials (red team P1)

The current Worker uses an `sb_secret_` key from its secret store through the single `supabaseConfig` accessor, and calls only `case_api` PostgREST RPCs. That key has broader authority than these RPCs need, so `case_app` remains private, function execution is explicitly granted to `service_role`, the lockdown sweep checks stray privileges, and the key follows the rotation runbook. CASE-127 defers a dedicated `case_worker` Postgres role and Hyperdrive until before procurement; direct connections are not part of the current Worker path. Facilitator sign-in uses Supabase Auth from the browser. The AI gateway (Phase 4) remains separate future work.

### Worker RPC client (card 04)

`src/worker/rpc.mjs` reads configuration only through `supabaseConfig`. It sends the secret key only in `apikey`, with `Content-Profile` and `Accept-Profile` set to `case_api`; no user JWT is forwarded. The configured URL must be an HTTPS origin. Fetch uses `redirect: 'manual'` because workerd rejects `redirect: 'error'`; a 3xx response is refused before any Location is followed. RPC names and named arguments match the current service-role signatures; the obsolete id-minting session overload is excluded.

`call` returns a success/data or sanitized failure result. Conflict and unique violations map to 409; permission code `42501` maps to 500 and an optional alert hook; missing-function `PGRST202` and unavailable results also invoke the fixed observer hook without changing their HTTP/result mapping; not-found maps to 404; invalid requests to 400; network, 5xx, paused-project and timeout failures to 503. The default five-second deadline covers both fetch and reading the response body, even if an injected fetch ignores abort. Callers choose retries; the client never retries. Raw bodies and exception messages are not logged or returned. Only known upstream codes survive; the trusted alert hook receives fixed kind/code and an allowlisted RPC name and is invoked immediately. Its promise is never awaited and its failures cannot replace the result. The caller retains asynchronous delivery with its Worker context (for example `ctx.waitUntil`); synchronous hook work must stay short because JavaScript cannot preempt arbitrary callback CPU work.

**Request deadline (CASE-282, 2026-10-17 reliability audit).** Every routed `/api/*` request answers within 8 s (`src/worker/request-deadline.mjs`), inside the 10 s at which `accountRequest` and one room-transport attempt give up. Inner deadlines compose serially (JWKS 3 s, then several 5 s RPCs), so before this a route could still be waiting when its client left, and Workers Logs showed only `canceled`. The deadline answers a fixed `503 {"error":"request_timeout"}` with `retry-after: 2` and logs `request_deadline` with the stage: `rpc` (one in flight), `before_rpc` (JWT, JWKS or a Durable Object before any RPC) or `after_rpc`. It cannot cancel work already started, so a cut-off write is uncertain to its client, as a client timeout was; clients already treat `request_timeout` and 5xx so (receipts and operation ids are idempotent). Long-poll `/updates`, `/ws`, `/check/*` and the Builder image upload `PUT` keep their own deadlines. Request-body reads use one shared 7 s deadline (`BODY_READ_DEADLINE_MS`), so a stalled upload still answers its specific `408`. The request-scoped RPC proxy logs `rpc_failure` (fixed reason: `timeout`, `network`, `redirect`, `invalid_response`, `response_too_large`, `forbidden`, `missing_function` or `unavailable`) and `rpc_slow` (over 2 s); before this, RPC failures reached only Analytics Engine.

The JWKS cache shares one in-flight fetch between requests. That fetch is the I/O of the request that started it, and Workers cancel a request's I/O and timers when it finishes or its client disconnects. So each waiter keeps its own 3 s deadline, and an in-flight fetch older than its own deadline plus 1 s is replaced rather than awaited.

`page` yields rows with keyset pages of at most 100: published versions use `version_id`, lockdown alerts use `id`. Unsupported 1000-row listings, duplicate/missing cursors, oversized pages and RPC failures throw a sanitized `RpcPageError` rather than silently truncate. `tests/helpers/fake-postgrest.mjs` mirrors active argument names and table fields, uses memory only, and refuses any host except its reserved fake origin.

The service-only `case_api.retention_status(p_session_id uuid)` RPC returns zero rows for an unknown archived room and one fixed counts/timestamps row for a known room. It exposes no names, token hashes, answers, event payloads or case document. The operator route requires a same-session immutable archived `room_ended` event before addressing the named Durable Object. Current-store evidence cannot attest to provider backups, Point-in-Time Recovery or physical media erasure.

### Administrator service boundary (Card 21a; CASE-141)

The unapplied `20261002040000_admin_server.sql` migration adds service-role-only administrative RPCs, profile CAS revisions, soft-deletion state, atomic step-up admission and immutable audit. Audit snapshots accept only fixed scalar fields/statuses; no answer, participant name, pack, arbitrary note or provider body is recorded. Hard deletion preserves anonymous historical rows. The separate audit retains its approved admin/facilitator emails indefinitely.

Ordinary facilitator JWT routes consult `admin_account_active` before returning profile/workspace/room metadata or creating/minting access. False is 403; absent, malformed or unavailable authority is 503. This JWT preflight does not add a database read to every live capability command. A partition after profile disable can prevent owned-room revocation until its DO is reachable; the administrative operation returns reconciliation, not success. RoomDO `adminEnd` checks the current session/owner and uses the existing server-clock end lifecycle. It revokes facilitator capabilities and closes their sockets/waiters with the existing unauthorised error, including already-ended rooms; participant recap/display and personal retention stay unchanged. Directory inventory exposes bounded code registration age (null for unknown historic age), phase, aggregate count and owner email only. Live inventory admits the canonical active room phases, including consequence and terminal teaching, while refusing inconsistent live/ended summaries. Each administrative room adapter operation uses a monotonic ten-second deadline; owned-room loops share it across summary, paging, admission, audit and native end awaits, and no end is invoked after expiry. The single-room HTTP handler first performs a separately bounded preliminary summary, so two sequential adapter operations are not a ten-second whole-route guarantee. An admitted operation may finish after the wrapper times out, so durable intent remains and the response requires reconciliation rather than retry.

Hard deletion atomically claims a server-due profile under its expected revision and matching durable audit intent before Auth DELETE. Auth 2xx/404 precedes profile deletion. Unknown provider outcomes retain the claim and reconciliation status; claimed profiles cannot be enabled, restored or compensated and are excluded from later sweeps. No automatic claim expiry or V1 release operation exists. Administrative profiles may remain beyond thirty days pending reconciliation; participant retention does not change.

Dedicated cron `47 * * * *` runs administrative due deletion in each environment. Weekly `37 3 * * 1` and hourly `17 * * * *` health paths remain unchanged. A run reads at most 100 records per page, starts at most ten irreversible actions and stops admitting actions after sixty seconds; an admitted one-shot stage finishes or records reconciliation. Backlog waits for later hourly ticks. Audit actor `system@case.iatrogenic.app` denotes scheduled purge, never a human, with no address prefix.

### Administrator UI (Card 21b; AS-087)

The separate noindex `/admin` document offers Facilitators, Cases, Live rooms and Audit, with explicit paging and a metadata-only drawer. It shares Case Auth and central bounded same-origin URL builders; clients never call Auth admin endpoints or Postgres. Searches and captured typed-confirm email are JSON-only. Destructive actions require the selected target, expected revision and fresh own-email code; elevation is memory-only. Unknown writes show reconciliation instead of an automatic retry or false reversal.

Private rows, queries, codes, confirmation and elevation live in memory only. Common sign-out/401/account-change/pagehide teardown empties retained DOM and generation-fences late callbacks. Ten minutes idle pauses reads without locking Auth or the UI; user activity refreshes, and active form editing preserves drafts and focus. No claim-release, settings, arbitrary note or raw audit-payload UI exists. Static Admin assets are public and eagerly installed by the existing generic service-worker precache; API data remains excluded. Local actual-Worker and strict-provider tests do not prove owner email delivery, deployed settings or hospital/device rehearsal.

## Private non-room case reads (CASE-193)

`src/worker/facilitator-api.mjs` adds a no-store GET for an exact workspace/version pack. Worker active-account and P-21 authorization precede `readIntactVersion`, whose existing SQL RPC repeats workspace/version/membership/admin and withdrawn checks. No new database grant, migration, room/DO or persistence is needed. `accountRequest` retains its 64KiB default; only this explicit private preview read opts into the existing intact-pack 1MiB ceiling. Its generation fence, bounded streaming/timeout and 401 cleanup remain shared.

`src/shared/case-map.mjs` owns private authored topology and the canonical route adapter. `src/client/preview-rehearsal.mjs` owns a disposable reducer state; it never instantiates the persistent/broadcasting Manual room class. `src/client/teaching-controls.mjs` provides private-only shared rendering; transport and local commands remain adapters. The lazy `console-preview` and `case-map` entries are charged to the unchanged `/cases` union. Their CSS is scoped to `.case-map`; no API response is a shell cache asset.

## 4. Durable Object (live room)

Card24 uses the existing aggregate JSONB contract without a migration or per-vote Postgres writes. Ranking closure durably freezes rankCount, authored eligibleOptionIds and anonymous positionCounts; explicit authored rank_count remains fixed. Default legacy/restored one/zero-eligible state is compatibility data, not a fresh DSL ranking path. Complete retained answers alone can recover old positions; zero eligible is count-only only with current all-disabled eligibility and zero accepted answers, never fabricated history. Both projector clients call the same text-only closed-result helper, included in the prototype offline shell.

Schema: `db/durable-object/room-schema.sql`, with STRICT tables.

**State and rebuild (CASE-072).**
- `meta.state` holds compact reducer control state, minus the case document and closed personal response bodies, as JSON. It is written in the same SQLite transaction as the command's journal rows. CASE-185 keeps immutable round/response evidence and response_evidence_keys in private SQLite; cold hydration validates every required known-owned record before releasing a view. Legacy evidence is validated before compaction. Missing or corrupt evidence fails closed without rewriting control state.
- An evicted or redeployed DO rebuilds by reading it back. The case document comes from the `case_doc` table, keyed by content hash.
- Lobby `arrivalCount`, closed-chart `resultsShown` and bounded ranking `resultsPage` are reducer state in the same durable record. Fresh joins increment the count; a new response round resets chart visibility and page zero. Hide/replay preserve page choice. Closing with visible results and explicitly showing responses clear play names; Show names is refused while a chart is actually visible. Display projections fail closed on legacy states: either count-bearing result suppresses names and avatar chips, including Return live from replay. Public projections contain the complete anonymous option-by-position matrix and only its bounded presentation-page index; no participant discriminator, answer-linked name or private suggestion is added. Ranking `rankCount`/`positionCounts` remain JSON aggregate fields in the existing idempotent archive contract; no database migration is needed.
- A test proves a JSON round trip gives identical projections, and that a terminal reset still works afterwards.
- Measured on the reference case, the state is about 43 KB, and one row is rewritten per command.

Cold loading reads SQLite and normalizes presentation state in memory. Schema migration and normalized-state persistence are deferred to once-only maintenance on ordinary authentication, mutation, lifecycle, archive or alarm access. A malformed or orphan store refuses creation with `unavailable`; it is never reused or silently repaired. The operator retention probe bypasses maintenance and reads only table/KV/alarm/state presence. A never-created object can be empty, so a corroborated SQL-known archived end is required before an empty probe counts as a deletion observation.

The additive `20261011000000_correction_seed_provenance.sql` migration records correction/source IDs and seed time separately from genuine participant submission fields. The existing 24-hour row purge covers this linkage. Seed lineage is immutable, and a seed is not archived until its source row is acknowledged. No participant payload enters correction journal records. The shared interpretation distinguishes the corrected active spine, disclosed detours, inherited answers and explicit legacy evidence gaps. Scalar Undo metadata is limited to 64 actions/64 KiB within the unchanged whole-state limit; the 300-person/280-CJK/12-cycle local proof peaked at 470,456 bytes.

**Hot-path rules:**
- **Single writer.** Every mutation is handled inside the Durable Object, so there are no races between lock and vote.
- **Idempotency.** `dispatch(state, event, ledger)` uses the `receipts` table as its ledger. Join recovery (CASE-153) adds no schema: the `join:<capability SHA-256>` receipt stores the SHA-256 of the normalized name/avatar input and its first-acceptance time, inside the same transaction as the participant, credential, journal and archive outbox. It keeps the existing 24-hour receipt window; a replay never refreshes it.
  - The key is the sender plus the `client_event_id`; a payload fingerprint goes with it.
  - The same payload returns `already_accepted`. A different payload is rejected as `client_event_id_reused`.
  - Rows are pruned by age, never by count. Receipts are not part of reducer state, so copying state stays cheap.
- **Journal.** Every committed transition appends one `journal` row with `seq = session_revision`. It is trigger-protected as append-only, and payloads carry ids and counts only.
- **Fencing.**
  - A command carrying an older `epoch` is rejected. `takeover` bumps the epoch when a new facilitator device claims the room.
  - Facilitator commands may carry `expectRevision`, so a stale tab or a double tap cannot skip a beat.
- **Time.** The reducer rejects unparseable or out-of-range times, and clamps every event time to at least the previous one, so a device clock can never move the room backwards.
- **Manual segments.** `applySegment()` replays a manual segment all-or-nothing and refuses a reused segment id. A partial recovery cannot leave the room half-applied.
- **Broadcast.**
  - Votes and joins re-project only the facilitator and display views; a voting phone learns from its receipt.
  - Broadcasts are coalesced on a trailing 250 ms timer.
  - Measured on the 50-person reference room: facilitator snapshot about 28 KB at peak, participant up to about 19 KB with every surface revealed, display about 2 KB.
- **Archive.**
  - Eligible rows with `archived = 0` go to `case_api.archive_session_batch` on phase changes and alarms, at most 200 rows and 256 KiB for the complete UTF-8 RPC envelope. Published rooms persist their successful SQL-session association; inline development rooms never archive to Postgres.
  - While live, only round aggregates and the text-free journal are eligible. Complete participant rows (names and token hashes) and per-person responses remain in the Durable Object until Postgres acknowledges the actual server end and fixed deletion deadline in an independent metadata-only batch. The same immutable metadata accompanies later data batches.
  - Intentionally deferred personal rows cause neither delivery lag nor retry loops. After end, their eligibility clock starts at the server end; metadata itself is pending from that instant. The lag hook reports seconds only, with no content or identity.
  - A single-flight send uses a durable ten-second watchdog for eviction recovery. The alarm handler queues work without awaiting it, rearms the earliest lifecycle/retry deadline, and retries failures with jittered backoff from one second to a five-minute cap.
  - A row is marked sent only for the version that was sent, and any later edit re-arms it.
  - Batches are replay-safe, so a lost acknowledgement just resends.
  - JSON columns are parsed before sending, so Postgres receives objects, not strings.
- **Lifecycle (CASE-073).**
  - An alarm at `expires_at` force-ends a room nobody ended.
  - After `end`, the DO keeps serving the private recap for 24 h. An alarm then deletes all its storage, whether or not the archive has caught up.
  - At deletion, the DO invokes a counts-only alert hook for every unsent row, including deferred personal rows, and deletes without awaiting archive or alert delivery. AlertDO receives the fixed counts through a nonblocking observer hook. Unsent personal data is discarded; retention never depends on Postgres being reachable.
- **WebSocket hibernation.** Heartbeats use fixed `ping`/`pong` frames, answered by `setWebSocketAutoResponse`, so a 10 s heartbeat does not wake the DO.
- **Transport fallback.** Long-poll on `revision` or `displayRevision`.
- **App-level sync (CASE-100).** Under hibernation the runtime answers the ping at the edge without waking the object, so a pong proves only that the socket is open. The room answers the fixed `sync` frame itself with its revisions, which proves the whole path and exposes a missed broadcast.
- **Presence (CASE-106).** The room keeps, in memory only, which participants have an open socket or made an HTTP request in the last 60 s, and passes that set into the facilitator and display projections (`project(state, role, pid, { present })`). The reducer stays pure; the answered count's `m` is the connected participants plus anyone who has answered.
- **Placement (CASE-107).** Every room and directory object is requested with `locationHint: 'oc'`. A hint applies when an object is first created and is best effort: Cloudflare offers no Australian jurisdiction for Durable Objects.
- **Hardening (runtime red team; CASE-097 to CASE-099):**
  - At most 300 participants per room.
  - A command, its receipt, the state and the journal commit in one transaction, under a 1 MB state budget.
  - Deletion is timed from the server clock, with a hard delete at expiry + 24 h.
  - Long-poll waiters wake from the same scoped, coalesced flush as sockets.
  - A takeover revokes the other facilitator tokens; display tokens can be revoked; a display token is minted at pickup.
  - Up to 400 sockets per room, with a 10 s hello deadline.
  - A token bucket per credential.
  - The schema is created only on `create()`.
  - The directory is sharded, with rate-limit bindings keyed by IPv6 /64 or IPv4 address. The coarse `JOIN_ATTEMPTS` flood limit counts every attempt, so it sits far above any real room (600 a minute per address, CASE-108); only failed lookups are limited tightly, by the Directory (20 a minute).

### Wire protocol

Defined and validated in `src/shared/wire.mjs`, which both server and clients import:

- **HTTP** (same origin, `/api/v1`):
  - `POST /join`
  - `POST /sessions/:id/commands`
  - `GET /sessions/:id/snapshot`
  - `GET /sessions/:id/updates?after=<rev>&afterDisplay=<drev>&wait=<s>`, a long-poll capped at 25 s. It returns on either revision, so a projector on long-poll sees presentation replay.
  - `POST /sessions/:id/manual-segment` (facilitator)
  - `GET /check/ws` and `GET /check/poll?wait=<s>`: the network self-test (served at `/check`; the prototype remains `prototypes/room/check.html`). No room, no state, no token; rate-limited per address by `CHECK_ATTEMPTS` (CASE-102).
  - `GET /health`: the public uptime probe (CASE-282). No token, rate-limited per address by `CHECK_ATTEMPTS` like `/check`. It makes one read-only `heartbeats` RPC with a 2.5 s deadline (never `ping`, which would refresh the keepalive and hide a dead weekly cron) and checks the sign-in keys through the shared JWKS cache. It answers `200 {"ok":true}`, `503 {"ok":false,"reason":"database"|"auth_keys"}` or `429 {"ok":false,"reason":"rate_limited"}`, `no-store`, with no build, timing or upstream detail. Setup: `OPERATIONS.md` §Uptime monitor.
  - `GET /ops/live-rooms`: the live-room count for `scripts/deploy-guard.mjs`. It answers only when the Worker's `DEPLOY_GUARD_TOKEN` secret matches the bearer token (constant-time comparison; never from a URL), and is a 404 otherwise (CASE-109).
- **WebSocket** `/sessions/:id/ws`:
  - The first frame is `hello` and carries the token, so the token never appears in the URL.
  - After that, a fixed `ping` frame every 10 s. The client treats any inbound frame as a sign of life, and counts the socket as dead after 25 s of silence.
  - Every 60 s, the fixed `sync` frame. The room object answers `{t:'sync', revision, displayRevision, epoch}`; no answer within 15 s means the socket is dead, and a newer revision makes the client refetch its snapshot (CASE-100).
  - Command frames, plus server `snapshot` and `receipt` frames.
- **Full snapshots, not deltas.** Every broadcast sends each targeted connection its full role projection, so there is nothing to drift. The 16 KB limit applies to client frames only; server snapshots are measured above.
- **The server stamps the event.** It sets `actor` from the authenticated token and `at` from its own clock, and generates any round id and response id. The per-command allowlist rejects unknown fields, so a client cannot forge role, time or ids. The one exception is the manual segment: there the facilitator device's own timestamps are trusted, because the server was unreachable.

### Client transport

`src/client/transport.mjs` is the one client for the facilitator console, the display and the phone. It has the same API as the stage C lab bus, so the windows run unchanged against either; `prototypes/room/lib/link.mjs` picks the real one when the page URL has `?api=<origin>&session=<uuid>`. Running it locally: `docs/RUNBOOK-LOCAL.md`.

- **Snapshots: WebSocket first, then long-poll, then short poll.** The socket sends `hello` with the token as its first frame, then the fixed ping every 10 s and the room-answered `sync` every 60 s. Any inbound frame counts as life, and a socket silent for 25 s, or whose `sync` goes unanswered for 15 s, is closed and replaced even if it still reports OPEN (AS-022). Two sockets in a row that fail to open, or close within a minute, switch the client to long-poll (`/updates`, 25 s). Two failed long-polls switch it to short polling of `/snapshot` every 3 s ± 50 %. On a fallback it probes the better transport again: long-poll every 30 s, the socket every 60 s. `link.mode` reports `ws`, `long-poll` or `poll`.
- **Stalling sockets are pinned out (CASE-100, AS-060).** A socket that the heartbeat or the sync finds dead counts as a failure however long it lived; before, a proxy that stalled every socket at 90 s made the client reconnect forever, because only sockets younger than a minute counted. Two such deaths within 10 minutes pin this network to long-poll for 24 h: no more socket probes, remembered in localStorage under `case:transport:pin` as `{ [network]: untilMs }`, where the network is the browser's connection type where it exposes one. The pin holds no token, room or personal data. `link.pinned` reports it.
- **A display starts on long-poll.** Behind a hospital proxy long-poll is the expected path for the projector (HANDOFF §Network resilience), so the display starts there and tries the socket only after 2 minutes of healthy long-poll, and then only from a healthy long-poll.
- **Only the room's own frames count as life (2026-10-17 reliability audit).** An HTTP read is live only when it returns a `snapshot` or `unchanged` frame, and only the Worker's JSON refreshes the last-contact time. A proxy or portal page answering `200` (often HTML) fails the read and backs off, as a network error would. Before this, a long-poll display behind a TLS-inspecting proxy re-requested at network speed while showing `online`.
- **Commands always go over HTTPS.** `POST /commands` returns the receipt, and the client retries with the same `clientEventId` until one arrives. So it never claims success without a receipt, and a retry the server already applied comes back `already_accepted` (AS-021, AS-023). Console commands carry `expectRevision`, as on the bus.
- **Resume.** On `visibilitychange` to visible and on `online`, the client fetches a fresh snapshot to check its revision, replaces a socket that has gone quiet, and resends pending commands at once (AS-021). An `offline` event drops the socket straight away rather than waiting 25 s.
- **Credentials (CASE-103, CASE-106).** Never in a URL. Keys are `case:<role>:<slot>:token`.
  - Participant: localStorage, with `expiresAt`, until the recap expires: at most 48 h at join (room life plus recap), tightened to `recapExpiresAt` once the room ends. Expired entries are purged on load, so a closed browser reopens the recap and a cleared one loses it.
  - Display: sessionStorage, for its one paired window.
  - Facilitator room token: memory only. The case pack (`GET /case-pack`) and the mirror are memory-only too (CASE-092). The served sign-in path uses an invited Supabase Auth account: its access token stays in memory, its refresh token persists in localStorage on every device until explicit account-ending cleanup (CASE-175), shared between tabs under the Auth Web Lock. Sign out clears it synchronously and fences late rotations; deliberate subsequent sign-in commits after that fence and survives it (AS-111). A shared PC `/P` holds only a single-use pair secret and then a room token, both in memory; it never receives the phone's account session. The older sessionStorage room-token handoff remains for local lab and test routes. Config and Auth REST response bodies are limited to 32 KiB of UTF-8 bytes during streaming, within the existing ten-second whole-request deadline; refusal cancels the reader without waiting for cancellation to finish.
  - On the served account and shared-PC surfaces, one bounded teardown clears private room memory, Case keys, private caches and known IDB stores. Account-ending reasons remove the stored refresh token; room end keeps it and returns to the library. Pagehide and next load preserve the refresh token, a well-formed pending same-tab PKCE verifier for at most ten minutes, the console room marker and a validated manual segment (CASE-175); all room capabilities and private case data remain memory-only. Sign out additionally queues a refresh-key-only removal behind running rotations under Web Locks. OTP, PKCE and broadcast adoption commits share that lock; the fence preserves their Auth generation, and delayed old removal events cannot erase a currently stored session; a tab still holding a different old token drops its previous account memory without removing the new stored token. Without Web Locks cross-tab mutual exclusion is unavailable. The room-owner lock belongs to the mounted console and releases on end, sign-out, access loss, leave, replacement or failed mount/re-mint (AS-110). Non-personal transport pin and appearance preferences survive cleanup. The participant capability separately persists until recap expiry under CASE-106; the participant-route adapter preserves only exact known same-room, unexpired credentials and a bounded validated vote database on navigation (Card 13).

- **Served phone outbox and recovery (Card 13).** `case:phone-outbox` stores at most twenty validated vote envelopes per room, keyed by `clientEventId`. The latest answer supersedes older answers in its round; overflow removes the oldest superseded answer in that round first. Uncertain retries keep their id; changed payloads receive a fresh UUIDv7. A closed IDB handle reopens once. Only the actual server `view.you.id` authorizes filtering/restoring a private draft or sending a queue; before confirmation the UI exposes counts only.
  - `POST /api/v1/join/recover` receives a bearer participant capability and only `{code, sessionId}` (1 KiB, whole-body seven-second deadline, CASE-282). It performs no Postgres call, mint or join. A recent UUID guard precedes room lookup; a reused code mapping cannot resume the old room. With no directory mapping, that authorized room may validate its own code for an unexpired recap. The recovery contract (2026-10-02) refuses facilitator/display capabilities, revoked/removed/deleted participants and expired recaps even before the deletion alarm. Replies contain only the bound session id; unavailable storage remains 503.
  - The phone prevalidates exact capability/room/expiry, bounded queue and known storage inventory before common next-load cleanup. Validated participant navigation (`pagehide`/`next_load`) preserves strictly owned unexpired room keys and bounded known outboxes across rooms, while only the selected room can restore its private draft. Sign-out and account/security cleanup use the origin destructive barrier. Confirmed401, token loss, mismatch and recap expiry remove only the captured room capability and owner rows after committed revalidation; a replaced token or another valid room survives. Unavailable validation exposes public Retry/count state and rechecks inventory before activation. A valid public code draft alone may survive the explicit same-tab privacy return. Unknown inventory or failed validation fails closed; no account refresh or private cache gains an exception. The phone injects a lazy participant-only telemetry adapter into the shared transport. Before actual same-room server identity and owner-IDB filtering, it retains only a fixed current mode and constructs no reporter or POST. Confirmation emits that mode, then fixed mode/pin/sync events; closing transport fences the reporter and late confirmation. Room/participant identifiers are never passed to analytics.
  - Closing a phone transport drops its in-memory capability, participant snapshot, case pack and pending command bodies while leaving the approved stored navigation capability unchanged. Closed-response fences prevent late snapshot, join, pack or 401 responses from restoring private memory or changing a newer credential. Terminal removal,401 and recap expiry clear private memory and retained DOM, then use captured-room cleanup for its exact stored capability/owner queue before showing a text-only public status. Bootstrap disposal releases capability bindings and prevents held recovery from activating after navigation. A restored BFCache phone reloads its existing token-free route before rendering again.
- **Display pairing.** `prototypes/room/pair-display.html` calls `POST /display-pairs`, shows the code, and polls with the secret as its bearer. The console approves the code from Room setup → Use another screen. A re-paired display's first snapshot is the latest public one (AS-025).
- **Same origin.** The Worker sends no CORS headers. For local runs, `scripts/serve-prototypes.mjs` proxies `/api/*`, WebSocket upgrades included, to a local Worker.

### Local load proof (Card20; AS-093)

`scripts/load-room.mjs` exercises 50 and 150 simulated phones against local workerd. Its local-only response-loss fixture inspects phone 0’s first vote event, selecting one actual HTTP 200 `accepted` or `already_accepted` receipt only when `v: 1`, `t: receipt`, the UUIDv7 event ID and integer epoch match the command, and revision is a nonnegative integer. `selected_receipt` records which positive receipt was withheld: `already_accepted` proves the event was recorded earlier, not that its original `accepted` response was observed. A later matching `already_accepted` receipt and the same sent event ID are still required. Expected receipts must remain unique, complete and positive; a real HTTP 200 rejection is terminal under the existing transport contract, never converted into acceptance or an automatic retry.

The new native Response clone inspection uses the harness’s existing 64 KiB and ten-second constants as consumed-byte and inspection bounds; the request’s existing abort can terminate it sooner. Pre-aborted attempts acquire no clone or reader, and terminal checks prevent late reads from selecting a loss. Clone and original-sibling cancellation are best effort and never awaited. Nonqualifying/rejected/unknown/malformed/mismatched original responses are forwarded unchanged; abort or inspection deadline cancels the original without awaiting and raises a fixed transport-visible failure. Consumed-byte bounds do not bound upstream/native tee chunk or heap allocation and cannot preempt synchronous decoding or JSON parsing. The success report or fixed replay failure carries only bounded counts, fixed enums, booleans and one last observation, never raw receipt bodies, event IDs, tokens, names, answers or snapshots.

The 8 ms local vote latency, join waves of 25 for 150 phones, concurrent voting, transport rates/retries/deadlines and runtime test limits of 120/180 seconds are unchanged. Zero loss remains required for both sizes; only the 50-phone target requires p95 below one second. The 150-phone target reports finite timings without that SLO. Fan-out lag observes the facilitator mirror, not every phone. Staging has neither local loss injection nor time scaling and remains owner-only; production is refused before credentials/network access. Earlier local measurements and proofs retain their original producer/test identity; none proves a later producer or a deployed/device/pilot result.

### Pending image attestation (CASE-273)

`case_api.builder_set_asset_attestation` reauthorizes P-14, scopes the asset to the workspace and locks the asset row shared with review. It changes only a quarantined image/video’s de-identification tick; false remains a warning. Requests carry the expected tick, identical retries preserve the attester and timestamp, and approved/closed rows refuse. The Worker bounds the body to 2 KB. Card 62: `admin_review_asset`'s fenced overload takes the same row lock, so an approval and a tick change are serialised. Whichever commits second sees the other's change and is refused with `asset_details_changed`. No direct table grant is added. Room projections remove credits from slide media and append them only to facilitator notes; the shared slide renderer never paints attribution.

## 5. Case document

A case version is one JSON document, validated by the Worker with `validateCaseDocument` in `src/shared/case-document.mjs`, a dependency-free validator of structure and semantics keyed on `schema_version` (CASE-065). A JSON Schema export for the AI authoring contract is deferred to Phase 4. Every item has a UUIDv7 `id`, **stable across versions**, so journals, recaps and analytics can join across versions.

```json
{
  "schema_version": 1,
  "title": "Pressure on the Right",
  "flags": [{ "id": "…", "key": "workshop_flag_01" }],
  "surfaces": [{ "id": "…", "kind": "update", "headline": "…", "asset_ids": ["…"] }],
  "beats": [
    { "id": "…", "kind": "surface", "surface_id": "…", "requires_flags": [] },
    { "id": "…", "kind": "decision", "decision_id": "…" }
  ],
  "decisions": [{
    "id": "…", "prompt": "Synthetic workshop prompt 275. Record a",
    "interaction": { "type": "single_choice", "options": [{ "id": "…", "label": "…" }] },
    "rules": [], "fallback_path_id": "…",
    "paths": [{ "id": "…", "classification": "sound", "set_flags": ["workshop_flag_01"],
                "reveal_surface_id": "…", "next_beat_id": "…", "cue": "…" }]
  }]
}
```

For the pilot, a published case version is immutable in Postgres (CASE-128). The Worker reads `document_text`, verifies its SHA-256 against `content_sha256`, parses that exact text and gives the document to the room Durable Object. The full case pack is served only to the facilitator from the room. Each revealed timeline entry persists its count of publicly shared text groups, under a presentation version marker. Public phone/display projections and their timelines contain only scene, observations, findings and investigations already shared in that order; asset IDs remain withheld because this version has no media delivery contract. A replay selects an exact timeline entry and uses that entry's own group count. The facilitator receives a separate public display projection for its room-visible card; its full timeline and live notes remain private to the console. Pre-version stored entries normalize to the text groups already public under the older whole-surface behavior; a new-version entry missing progress fails closed. R2 pack storage is deferred with media or the Builder.

## Public email branding · 4 November 2026

`public/email/` contains generic mosaic branding only, not case graphs, names, addresses or credentials. The build admits only digest-named JPEGs whose bytes match their twelve-hex SHA-256 prefix and copies every version to `/email/` with immutable caching. These images never join the service-worker shell or private media pipeline. URLs come from `emailArtUrl` in `src/shared/urls.mjs`, carry no query/recipient information and are public so mail image proxies can fetch them. Old published versions are retained for old emails. Worker invitations/resends and alert HTML use the shared email renderer; hosted Auth templates remain a separate reviewed body-application step with native Supabase delivery. No database or retention contract changes. Details: [email release guidance](SETUP-SECRETS.md#case-email-family--apply-and-release).

## 6. Identifiers (CASE-050, CASE-051)

| Identifier | Format | Used for | Never used for |
|---|---|---|---|
| Row / item id | UUIDv7, lower case (`ids.mjs uuidv7`, `case_app.uuid_v7()`) | Every PK and every document item | Anything a person reads or types |
| Join code | 6 × Crockford base32, upper case (`newJoinCode`) | Joining a room; QR | Primary keys; anything long-lived |
| Pairing code | 8 × Crockford base32, 5-minute TTL (`newPairCode`) | Display pairing (`/D`), shared-PC sign-in approval (`/P`) | Anything else |
| Capability token | 256-bit random, base64url | Participant authority | URLs, logs, the database (only the SHA-256 is stored) |

**Why these choices:**
- **UUIDv7** ids sort by creation time and are unique without coordination. A phone offline in manual mode can mint valid ids.
- **Crockford base32** drops I, L, O and U, and `normalizeCode` reads O as 0 and I or L as 1. That removes the common "is that an O or a zero" failure when codes are read off a projector.
- **Join-code space and abuse.**
  - There are 32⁶ ≈ 1.07 × 10⁹ codes, unique only among active rooms.
  - The Directory DO resolves codes, so joining a running room never depends on Postgres.
  - It rate-limits failed lookups only, keyed by IP and by IP /64 for IPv6. Successful joins are only under the coarse flood limit (600 a minute per address, CASE-108), because a whole hospital can share one egress address.
  - After three wrong codes in a ten-minute address or IPv6 /64 window, another wrong code requires Turnstile. A valid code, including verified same-room recovery, bypasses that challenge and the failed-code fallback; the coarse 600-per-minute flood limit remains. Successful verification clears the strikes and starts a fresh window. Missing configuration or provider unavailability after a three-second whole-response deadline retains the legacy 20-wrong-codes-per-minute fallback and emits a fixed anonymous fail-open metric.
  - Only actual `/join` and valid `/J/<code>` entry documents permit the Turnstile script/frame origin and its exact ScriptURL Trusted Types policy. The Worker replaces their strict asset CSP once; all other documents stay strict. Before private play, a validated join or QR recovery loads a fresh token-free session document, preserving the original credential expiry and validated queue through the existing cleanup contract. Join-entry responses never replace the service worker's shared strict shell cache. This adds one document load and Worker handling for entry traffic; removing the isolated challenge routing and handoff restores the earlier flow but loses the vendor isolation boundary.
  - Each room caps participants at 300 (CASE-097).
  - The facilitator can `close_joining` and rotate the code.

## 7. URLs and QR codes (CASE-051, CASE-052)

| Route | Example | Case | Purpose |
|---|---|---|---|
| `/J/<join>` | `https://case.iatrogenic.app/J/7K3QX9` | any (normalised) | Participant join (QR and printed) |
| `/F/<code>` | `https://case.iatrogenic.app/F/7K3QX9` | any (normalised) | Participant feedback for an ended room (CASE-284). The code is the room's own feedback code, unique forever and never reused, so an old link can only read *closed*. Built by `feedbackUrl` (kept out of `SHORT` and `parseRoute` so no other bundle grows); the API is `apiPath('feedback', code[, 'mine'])` with the respondent in the Authorization header |
| `/D/<pair>` | `/D/ABCD2345` | any | Pair a projector/display window |
| `/P` | `/P` | any | Shared PC shows a one-use approval code; an eligible phone may explicitly switch to signed-in approval and type that code |
| `/P/<pair>` | `/P/ABCD2345` | any | Reserved short-code parse route; the current approval UI requires typed number matching on `/P` |
| `/present`, `/create`, `/create/new` | `/create?workspace=<UUIDv7>` | lower | Published catalogue, editable inventory and entitled workspace creation; old `/cases[?view=drafts]` and `/cases/new` remain browser aliases (CASE-356) |
| `/sessions`, `/sessions/<session_id>` | `/sessions?workspace=<UUIDv7>&case=<UUIDv7>` | lower | Bounded private records and direct authorised reader; old `/history` remains an alias. Case filter requires workspace context. No live-room claim on entry |
| `/account`, `/admin` | `/account` | lower | Profile/scoped access and deployment administration; authority is verified independently of menu discovery |
| `/cases/<case_id>[/edit\|/map\|/v/<n>]` | `/cases/0199…/edit` | lower | Authoring |
| `/sessions/<session_id>/<facilitate\|display\|play\|recap>` | `/sessions/0199…/display` | lower | Live roles |
| `/api/v1/…` | `/api/v1/sessions/0199…/commands` | lower | Same-origin API; no CORS needed |

**QR rules** (enforced by `urls.mjs` and its tests):
- **QR payloads are upper case**, so every character is in the QR alphanumeric set. `HTTPS://CASE.IATROGENIC.APP/J/7K3QX9` is 36 characters, which fits a **version 2** code (25 × 25) at error-correction level M (capacity 38). The same URL in lower case is byte-mode and needs version 3 (29 × 29). Larger modules scan from the back of a room. Scheme and host are case-insensitive, and the Worker matches short routes case-insensitively.
- **Codes stay out of query strings.** Short paths let the QR stay small, and a code in a path is never mistaken for a tracking parameter.
- **No token, name, or personal datum in any URL.** Capability tokens travel in the `Authorization` header, and the Worker sends `Referrer-Policy: no-referrer`.
- **Projector rendering.** Error-correction level M, a 4-module quiet zone, dark on light even in dark mode, at least 25 % of screen height. The printed URL and spaced code (`7K3 QX9`) sit beside it.

- **Pairing (`/D`, `/P`) is number-matched.**
  - The code is shown on the device being paired and typed or scanned on the approving device; it is never sent as a clickable link.
  - The approval screen names the requesting device's browser, coarse location and time.
  - Codes are single-use and expire after 5 minutes.
  - Display pairing confirms `Display paired`. A shared PC receives a room-scoped credential only once and sends an accepted `takeover`; a signed-in phone chooses from its own active rooms in bounded pages.

## 8. Media storage (card 59 M2, CASE-268)

The Access migration serializes unused-image deletion with all callable draft/reference writers through advisory lock `(4242,42)` before `(4242,59)`. Draft save, restore and legacy save associate existing, already-visible images with that case; the private helper receives the SQL-derived actor role and never grants visibility merely because an untrusted draft names an image. Missing references remain valid incomplete drafts and block publication readiness.

Images are workspace assets (`case_app.assets`) with exactly two stored renditions (`case_app.asset_renditions`): `display` (longest edge ≤ 2400 px, ≤ 600 KB) and `phone` (≤ 1280 px, ≤ 300 KB; an ECG ≤ 2000 px, ≤ 500 KB). The Builder decodes the author's file, crops it, paints covered areas black into the pixels, re-encodes both renditions as JPEG and strips every segment but JFIF before upload; the original file never leaves the browser. The Worker accepts only a JPEG whose segment walk (`src/shared/media.mjs` `inspectJpeg`) finds no Exif, XMP, ICC, IPTC, comment or trailing byte, stores it at `media/<workspace_id>/<sha256>.jpg` with its pixel size as object metadata, and registers the image from that stored metadata, never from the request. An image is quarantined until a configured admin approves it; its rights and bytes are then immutable. Builder reads stream the bytes with `private, no-store`, `nosniff`, `same-origin` resource policy and a sandboxed CSP; the page shows them through a `blob:` handle (`urls.mjs` `mediaObjectUrl`), which is why HTML `img-src` admits `blob:`. **Room delivery (M3, CASE-269).** Release pins every image a slide version shows (`case_version_assets`; only approved images of the case's workspace). At room start the Worker reads them with `case_api.room_media_manifest` and the room Durable Object mints an opaque UUIDv7 handle per image, keeping the storage keys in its own `media` table and only `{ handle, width, height, credit }` (or `withdrawn`) in room state. An image block reaches a public role only inside a released step, with that `media` object in place of its asset id. `GET /api/v1/sessions/<id>/media/<handle>/<rendition>` asks the room, which answers a key only when the caller's role has had the handle released (the facilitator: any image of its room); every other case is the same 404, and a missing object is 410. Screens fetch with their own credential in the header (transport `mediaBytes`), keep at most eight images as `blob:` handles in memory and revoke them at teardown; nothing enters Cache Storage, IndexedDB or the service worker (it ignores `/api/`). The same-PC projector has no credential, so its console, which may see every image of its room, relays the bytes of released images over the local channel and keeps them in memory so manual mode still shows them. Phones open an image full size with native pinch-zoom. Room storage, handles included, is deleted with the room.

**Animated GIFs and video (Julian, 2026-10-15).** An animated GIF (≤ 12 MB) or an H.264 video in MP4 or MOV (≤ 25 MB, ≤ 2 minutes, sound kept) is not re-encoded. The Builder cleans it in place: a GIF loses its comment, plain-text and non-loop application extensions (`media-gif.mjs`); a video loses its `udta`, `meta` and `uuid` boxes, any track that is not picture or sound with its samples, its creation times, and every media byte no kept track references (`media-mp4.mjs`). No offset moves. The Worker re-walks the result and refuses anything else (HEVC, fragments, external data references, more than one video or sound track). It is stored once at `media/<workspace_id>/<sha256>.gif` or `.mp4`, serving both display and phone, with a JPEG `poster` rendition drawn from a frame. A version pins at most 64 images or videos and 150 MiB of stored objects, each object counted once. HTML `media-src` admits `blob:` for playback.

**Room delivery of GIF and video (card 59 M3).** The room manifest carries each medium's stored type, poster key and length; the room's media table keeps `poster_key` and `type`, and the media route serves `display`, `phone` or `poster` with the stored type under the same image response policy. Room state holds `playback` `{ blockId, playing, at, since }`, set only by the facilitator's `media_control` command for a released video the projector shows now; the display and facilitator views carry it while that video is on screen, phones never. The projector keeps an unchanged slide's DOM across renders and syncs its videos to `playback` (seeking past half a second of drift); a phone moves a playing video into each rebuilt slide, so nothing restarts it. Screens hold up to 32 media and 160 MiB each. The session record lists, per part, the images on the slides its publications reached (the archive keeps occurrences, not later step counts), and the session PDF embeds each as an unchanged JPEG (`/DCTDecode`) tagged as a Figure with its text alternative.

**Rights and de-identification warn, never refuse (Julian, 2026-10-15).** Any source can be named, including NC and ND licences, an unlicensed textbook or journal figure, or an unknown source. A missing credit or licence note and an unticked de-identification check are recorded and shown as warnings, to the author and to the approving admin. For images and video, approval no longer requires the tick, which supersedes Card 21a's re-attestation gate for them. The row reports `attested` truthfully: a changed asset never inherits a deleted attester's tick. Any other asset kind still needs the attestation.

**Images without approval; storage (CASE-342).** Since the A2 migration an upload is usable at once: release, readiness and room media refuse only a missing, foreign or taken-down image, and no image is closed for age. Each workspace has a quota (`workspaces.media_quota_bytes`, 2 GB by default; `storage_full` names used and allowed bytes); `case_api.admin_workspace_storage` reports usage and the unused images, and `admin_delete_unused_assets` queues their files for the hourly sweep. The case-keyed media RPCs (`builder_create_case_asset` and its siblings) link each image to its case, and a person holding only a case grant sees only those images.

### Earlier proposal (CASE-128, superseded for media on 2026-10-15)

```text
assets/<asset_id>/<sha256hex>.<ext>        immutable; Cache-Control: private, max-age=31536000, immutable
packs/<case_version_id>/<sha256hex>.json   immutable; facilitator-only, authorised per request
```

This is a proposed layout for a future media or Builder phase, not the pilot case-pack path. The pilot stores published documents in Postgres. If R2 is adopted, keys are content-addressed so a changed file gets a new key and caches never need purging. Media for a revealed surface would be served through the Worker, and only to roles entitled to it at that revision.

## 9. Retention (CASE-043)

**Images (card 59 M4, CASE-270).** Images are authored content, not participant data, so the 24-hour rule does not apply; their bytes still have short lives. A rejected image's renditions are queued for deletion when it is rejected; an image left unapproved for 30 days is closed and queued by the hourly sweep; an upload stored but never registered is deleted once a day old. A configured admin's takedown (P-16 with this session's step-up, audited with the elevation) marks the image withdrawn and deletes its bytes at once; rooms that hold it then answer 410 and show "Image withdrawn". A key another live image still uses is never queued or deleted. Rows stay as tombstones for audit. The sweep (`runMediaSweep`, on the hourly admin purge cron) leases at most 100 queued keys, deletes them, marks them done, and samples one page of stored objects for orphans; it logs counts only. If R2 backups or versioning are ever enabled, non-current copies must expire within seven days so a takedown completes inside the CASE-123 window.

`case_api.purge_expired_participant_data()` runs every 15 minutes via pg_cron, in batches of 200, and writes a `job_heartbeats` row. Personal data in Postgres therefore lives at most about 24 h 15 min after a room ends. Its steps:
1. Expire rooms past `expires_at`, preserving any actual end already recorded.
2. For rooms at their immutable personal-data cutoff (the earlier of actual server end + 24 h and expiry + 24 h):
   - delete `session_responses`
   - null `display_name` and `token_sha256`
   - stamp `retention_purged_at`, which also nulls the room's `facilitator_label` (the facilitator's "Name, Role" fixed at start; trigger `sessions_purge_facilitator_label` and check `sessions_facilitator_label_purged`, `20261106000000_facilitator_label.sql`, not yet applied)
3. Fold participant feedback (CASE-284 working number, `20261101000000_participant_feedback.sql`, not yet applied) for rooms at that cutoff, keyed on `feedback_closed_at` rather than `retention_purged_at`, because an archive batch can purge personal rows without this job:
   - count the ratings into `session_feedback_tallies` and the joined/QR responses into `session_feedback_totals`
   - copy each take-away (Take home), form 1 improvement and form 2 subject comment (`comment_session`, `comment_case`, `comment_app`, kind `comment`; `20261104000000_feedback_subject_comments.sql`, not yet applied) into `session_feedback_comments` in random order, with no link to a phone, a rating or another comment
   - delete that room's `session_feedback` rows (the respondent hashes), then stamp `feedback_closed_at`; the room's `feedback_code` stays reserved forever, so an old link reads closed

Feedback results (card 40 + feedback integration slice 9, `20261102000000_feedback_results.sql`, not yet applied) read both sides of that fold through one set of `case_app` helpers: an open room aggregates its `session_feedback` rows on read; a folded room reads `session_feedback_tallies`, `session_feedback_totals` and `session_feedback_comments`. The shape and the order are the same either way (comments sort by kind, subject and text, never by phone or time), so the fold changes nothing a reader sees but `closed`. No result carries a respondent hash, a participant id, a name, a response-level row of ratings or a time finer than the session's date. Three service-role reads: `case_api.session_feedback_summary` (P-37, `GET /api/v1/portfolio/sessions/<id>/feedback`), `case_api.case_feedback_summary` (P-38, `GET /api/v1/cases/<id>/versions/<n>/feedback`, take-aways and case improvements pooled across that version's rooms, at most 300 comments) and `case_api.admin_feedback_page` (P-39, `POST /api/v1/admin/feedback`, scopes `app`, `rooms`, `session` and `case`, 20 rows a page). The exact shapes are `src/shared/feedback-results.mjs`; the Worker refuses any other shape.

The room sends its server-clock end and deletion deadline before any personal rows become eligible for SQL. Postgres lowers the stored cutoff on replay, preserves purge tombstones, and immediately removes/skips personal writes when a batch arrives at or beyond that cutoff, even before the next scheduled purge. A post-write check also handles a batch crossing its cutoff. The three-argument finalizer records monotonic revision/epoch without restamping a known end. Replaying a batch cannot restore personal data or extend retention; local SQL tests prove these paths. The scheduled physical purge retains its existing 15-minute cadence; it is not an exact-at-cutoff guarantee during database downtime.

The Durable Object keeps its own copy for the recap until the earlier of its actual server end + 24 h and expiry + 24 h. Its deletion alarm never waits for archive delivery. Manual-marker text never leaves the DO.

`POST /api/v1/ops/retention-status` is a read-only operator check. The existing `DEPLOY_GUARD_TOKEN` is compared in constant time from its Authorization header before parsing the exact `{sessionId}` body (UUIDv7, one key). A 1 KiB body cap and ten-second whole-operation deadline bound the check. Unknown rooms, incomplete archives, malformed observations and unavailable stores never count as deletion success. `scripts/verify-deletion.mjs` accepts only an explicit loopback origin or the exact acknowledged staging origin, and always refuses production.

A successful owner observation requires the SQL purge stamp, zero current response/name/token counts and an empty current DO store. Both independent server observations must fall after the personal deletion cutoff and within 25 h of the earlier of the two corroborated end markers. A late observation can show current absence but cannot prove when DO deletion occurred. SQL and DO retention policies are unchanged; provider recovery history and the deployed seven-day backup/log contract require separate owner evidence.

## 10. Security and privacy rules

- **Text only.** All case content, names and answers are rendered as text, never as HTML or Markdown: no `innerHTML`, a strict CSP with Trusted Types, and NFC normalisation. Control and bidi characters are refused at authoring time and cleaned at runtime.
- **Shared hospital PC (CASE-102, CASE-103).**
  - The projector window opens with `noopener`: it gets no handle on the console, starts with empty sessionStorage and receives only the display projection; a separate display pairs for itself, while the served same-PC renderer can run without a display credential; the case pack never reaches it. Console and projector coordinate over BroadcastChannel only: the projector announces itself (`projector_hello`), the console sends the display check and, in manual mode, the local display projection. `window.open` with `noopener` returns null whether or not a pop-up blocker stopped it, so a projector that has not said hello within 3 s gets an inline link to open by hand.
  - **Served same-PC receiver contract (card 14 → card 12).** Only `topology=same-pc` opens `case-room-local` and sends `{t:'projector_hello', sessionId}`. The sender must send `{t:'local_snapshot', view, epoch, revision, displayRevision}` with a display-only public projection, never a case pack, facilitator mirror or full document. The receiver rejects unknown/private nested keys, foreign sessions, metadata unequal to the projection, and a non-increasing `(epoch, revision, displayRevision)` tuple. Exact two-key `{t:'show_projector', sessionId}` and `{t:'local_end', sessionId}` controls show the display check or clear the local projection; they carry no content. A higher server epoch clears the older local projection. Separate displays do not listen to this channel.
  - **Same-PC sound control.** The console can request mute only through a bounded, exact room-scoped BroadcastChannel message and waits for an acknowledgement. It cannot remotely enable audio. A separate paired display uses its own local sound chip; the console's mute request does not reach it.
  - The facilitator token is held in memory only, never in web storage. Julian ruled out automatic and explicit console locking on 2026-10-02; the generic idle-lock cleanup reason has no product caller.
  - The console and display hold a Screen Wake Lock while visible (a refusal is tolerated) and take it again on `visibilitychange`.
  - When `screen.isExtended` is `false` (one screen, or Windows "Duplicate"), the console suggests running the console on a phone. It is a hint, never a block or the default. Continuous screen-change detection that blanks the console is planned for the Phase 2 console.
  - Interactive room windows carry a `<script nomodule>` notice: `Open this page in Microsoft Edge or Google Chrome`. The static privacy page works without JavaScript.
- **Australian Privacy Act.**
  - The join footer links to the offline-capable APP 5 collection notice at `prototypes/room/privacy.html` (`docs/SCREENS.md` §Join flow): who sees what, deletion within 25 hours, backups and connection logs expiring within 7 days (CASE-123), Cloudflare possibly processing outside Australia with records stored in Sydney, and no patient details. Card 13 serves the same headed notice at `/privacy` with a same-tab public-code return; card 10 serves `/check` and the shell.
  - The Supabase project is pinned to `ap-southeast-2`.
  - Durable Objects are created with `locationHint: 'oc'` (CASE-107). That is best effort; there is no Australian jurisdiction option, so the notice says Cloudflare may process data outside Australia.
  - The Postgres archive keeps names and per-person answers until the 24 h purge, as planned (Julian, 2026-10-01). Encrypted backups and point-in-time recovery can hold them for the backup window after that, which the notice states.
  - Closed free text is projected in anonymous pages of up to six response chips, at most 500 characters per page (CASE-275, superseding that part of CASE-105); open rounds and peer phones never receive these pages. Removing a participant removes their current answer from these pages and recomputes their displayed total; the frozen review aggregate stays unchanged. The phone warns softly when a name or free-text answer looks like a patient identifier, and the facilitator sees such answers flagged (kinds only, never the matched text).
- **Operations (CASE-109).** The incident runbook is `docs/RUNBOOK-INCIDENT.md`. Workers observability is on (`[observability]` in `wrangler.toml`). Every deploy (the CI workflows of CASE-160, or Julian's break-glass `npm run deploy`) runs `scripts/predeploy.mjs`, whose live-room check (`scripts/deploy-guard.mjs`) refuses while any room is live. Card 16 writes anonymous Analytics Engine events through a fixed schema and admits only three transport event kinds at the rate-limited client telemetry endpoint. AlertDO delivers fixed-category/counts-only emails with durable six-hour success deduplication; uncertain deliveries retain the same pending key/body. Eligible archive lag is sampled on existing archive attempts/alarms and alerts above 120 seconds, with deferred personal eligibility beginning at server end. Deletion never awaits delivery. Metrics retain no IDs, names, tokens, answers, IPs or URLs. Analytics Engine retains these anonymous events for three months; the seven-day backup/log contract remains separate (CASE-123). `docs/OPERATIONS.md` records the schema, dashboard queries, configuration and unexecuted owner drills. Still to build before production:
  - Paid-tier point-in-time recovery plus a nightly export of `case_versions` and asset metadata.
  - R2 object versioning.
  - A DO schema migration ladder keyed on `meta.schema_version`.
  - A wire-version overlap window.
  - No Worker deploys during a booked session (now enforced by the deploy guard).

### Response security policy (card 09, CASE-075)

`src/worker/headers.mjs` is the common response wrapper for the Worker and both Durable Objects, including direct HTTP refusals and successful WebSocket upgrades. JSON and refusals use `default-src 'none'; frame-ancestors 'none'`. API, HTML and ordinary assets are `no-store`; only explicit `immutable-asset` classification, after the caller verifies a content-hashed path, permits immutable caching. The card 10 static pipeline derives `_headers` from this wrapper for the selected environment and public build SHA; only final-byte content-hashed `/assets/` paths use immutable classification.

HTML CSP is exactly:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types case-default
```

Fonts and scripts are self-hosted. Responses also set HSTS (`max-age=63072000; includeSubDomains`), `Permissions-Policy: camera=(), screen-wake-lock=(self), window-management=(self)`, `Cross-Origin-Opener-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Camera access stays disabled until a QR scanner is implemented. The local Chromium fixture verifies blocked HTML sinks and same-origin BroadcastChannel exchange; the room e2e suite covers the projector.

## 11. Limits and when to revisit

| Signal | Revisit |
|---|---|
| `session_events` above ~50 M rows, or purge taking more than 1 s | Partition by month on `occurred_at`. |
| Measured authoring p95 above 300 ms from PostgREST | Hyperdrive with pooled connections, in the Case Worker only. |
| Queries needing fields inside case documents | Generated columns or a GIN index on the specific path, not document normalisation. |
| Postgres 18 available on Supabase | Replace `case_app.uuid_v7()` with native `uuidv7()`. |
| Supabase plan | Use a paid plan for production. Free projects pause when idle, which would break a room's archive and the Postgres-backed authoring path (joins resolve through the Directory DO, not Postgres). |

## 12. Cost

At the modelled load (20 sessions a week, about 52 connections for 90 minutes each, 20 commands per participant a minute), the live rooms fit inside the **Workers Paid minimum, about US$5 a month**: incoming WebSocket messages bill at 20:1, outgoing messages are free, hibernated objects accrue no duration, and SQLite writes come to about 7.8 M rows a month against 50 M included. **The Workers Free plan is not enough:** its 100,000 rows-written-per-day cap is nearly used up by one session. Message-metered alternatives come to roughly US$30 to more than US$1,000 a month for the same load. The evidence is private historical reference (not distributed).

## Card25 complete-order aggregate and projection (2026-10-03)

CASE-145–147 add aggregate.completeOrders as sorted compact [authored-index tuple,count] pairs, at most300×8 positions. Latest accepted valid answers freeze at close; deterministic authored-index ties ignore labels/arrival. Existing anonymous positionCounts/rankCount/eligibleOptionIds and private suggestion are preserved. SQLite meta and existing JSONB aggregate archive already serialize the addition: no migration, per-vote Postgres write or new retention field. Native tests preserve idempotent archive batches and held-ack row-version protection.

Durable rankedSelection stores group/position only. Display ranked metadata exposes at most two selected complete orders; the full compact inventory and rankedRoundId semantic target are facilitator-only. Public strict validation bounds result rank/rows/total before allocation, checks joint marginal contributions and necessary hidden positive/sorted-prefix/permutation/residual tie bounds; it cannot reconstruct the unknown hidden histogram. Absent legacy meaning alone normalizes to neutral null. Same-PC/manual uses the same strict public projection; phone/recap stays after-consequence marginal-only. Legacy completeOrders absent/null never fabricates tuples; historical explicit count above eligible length retains inherited marginal fallback.

ranked_page keeps mandatory closedRoundId in fingerprint plus mandatory online expectRevision. The ordinary endpoint is strict. The authenticated manual-upload endpoint alone uses the relaxed parser; trusted local restore consumes mirror/segment, and only manual-active staged replay stamps current revision. Serialized ranked events omit transient revision. ConsoleManualRoom and prototype LocalAuthority preserve parity, late-arrival replay, atomic bad-target rollback and duplicate-upload receipts without changing generic results_page.

Clean typed native300 measurements admit300 credentials but restore normalized response history before native lock/cold projection/archive; core18 uses actual accepted vote commands and pure300 uses legal reducer joins/votes. Native UTF-8 bytes: persisted meta state215048 (case_doc separate), case pack8372, facilitator HTTP/WS serializer421297, display9849, phone6045, same-PC9849, resolved manual frame10098/saved470/upload453; deferred archive47155/personal43739. These are measured fixtures, not a universal maximum for accepted unknown observation baggage or repeated history. The16KiB frame cap is inbound only; it is not a facilitator-outbound cap. State≤1,000,000 and archive200-row/256KiB bounds remain; exact state-boundary RT01 proof is separate.

Dated supersession: earlier Card24 two-option table/pager statements above remain historical; grouped display replaces that presentation while full public marginal data, phone results, privacy, Hide prerequisite, replay and clinical path authority remain unchanged.


## Modular projector audio (CASE-192)

The audio engine receives only accepted public view phase, surface kind and the existing bounded canonical publication descriptor. The context/event map is separate from that interpreter, the generic Web Audio lifecycle and the projector-local permission adapter. Reflection uses configured one-shot semantics and fresh UUIDv7 occurrence identity; a track filename, clinical text, epoch/revision or last-slide position cannot create an event. Current live publication remains the authority during replay; corrections/restores/checkpoints and recovered baselines do not replay effects. No music state, command or private data is added to the room or transport.

Selected music is build-validated configuration: at most four configured safe slugs; exact manifest fields, immutable source attribution, licence, PCM format, duration, per-file/aggregate size and SHA256; no unselected extra files. The builder emits hashed public URLs plus bytes/duration/loopability only. All WAVs remain outside shell precache and boot fetch. The4096B lazy music limit is the only new JavaScript budget; all21 previous limits remain fixed and the display union includes the module. Decode caches use asset URLs, bounded to four entries; changing a reviewed waveform under a reused slug cannot reuse the old decode. Pending fetch and uncancellable decode are fenced against mute, hidden/reduced state, replacement context, End and disposal.

Music/effects levels use the existing exact device preference keys, with legacy master-volume fallback for effects. Stored levels and cross-tab preference events never grant sound permission; only this projector's deliberate gesture resumes its context. Unset music gain remains unset until deliberate adjustment. Manual/local and server public views share the existing strict raw-public validation before playback; ended views always silence it. The separate console tone player and participant silence remain unchanged.

## Builder validation boundary (CASE-194)

`src/shared/builder-json.mjs` parses bounded raw JSON and rejects duplicate decoded object keys before ordinary parsing/JSONB. `src/shared/builder-document.mjs` validates preservation types and known keys, then calls the existing graph validator on the same document with an explicit schema profile for readiness. The default remains schema1. No repaired document enters the graph checks. Unknown schema/capability/fields refuse preservation rather than disappear.

Logical serialized UTF-8 limits are1MiB document and128KiB metadata, beneath a2MiB transport envelope; depth32,100000 values and200 visible diagnostics bound traversal/reporting. Case formatting uses paragraph/list blocks with text runs and optional bold. Plain-text derivation is for length/search only, never replacement of the canonical value. Sources and provenance remain private metadata with independent version1; source SHA claims require server recomputation. This card changes no database table, immutable version or runtime admission.

## Builder persistence (CASE-195)

The additive Builder migration pairs authoring metadata with case drafts and adds save windows, content-free receipts and named checkpoints. The Worker uses bounded duplicate-key-aware parsing, preservation validation and recomputed UTF-8 source hashes. SQL derives actor/case/workspace authority and recomputes `builder-intent-v1` over its JSONB document/authoring_metadata object; clients treat that digest as opaque and distinct from document-only publication content_sha256.

A transaction advisory lock serializes storage admission and exact operation replay; case row locks enforce CAS. Windows live24hours (8 open per actor/case,32 open per case; a consumed window stops counting, CASE-240); receipts live7days (10000 per case,100000 per workspace); checkpoints cap at3. Checkpoint deletion removes the payload. Payload accounting includes current drafts/live checkpoints plus conservative scalar receipt/window charges, capped at100MiB/workspace and250MiB/global; admission refuses rather than evicts. Physical index/TOAST overhead and existing account headroom remain rollout measurements, not claims that these thresholds fit the account. Later Pending storage must join this same accounting/lock.

The existing hourly administrative sweep calls service-only cleanup with a bounded deadline, independently of account purge. Case deletion cascades Builder state. RPCs recheck current entitlement before receipt reads/replay; administrators do not require workspace membership. No case_app grants are added.
## Schema2 runtime compatibility (CASE-194)

`validateRuntimeDocument` admits legacy schema1 through the unchanged default validator and schema2 through strict Builder validation. HTTP room snapshot/updates/pack/command/manual-segment callers advertise `x-case-schema: 2`; WebSocket hello uses `supportedSchema: 2`. Missing/unsupported advertisement on schema2 receives `client_upgrade_required` without content. This is capability negotiation, not authentication; all existing credential/entitlement checks remain. Clients must ship before schema2 publication is enabled.

Recovery state stores only the current confirmation's occurrence/path IDs and boolean, never the private prompt in journals. Clarification stores a prior timeline index and its own publication occurrence; its return appends an exact context copy with a fresh occurrence and restoration identity. Shared group progression, online reducer and manual replay are the same authority. Existing room state/receipt budgets remain unchanged.

## Builder transfer boundary (card 47)

Transfer bundles are bounded proposals over canonical Builder values. Revises bind the exact saved revision and paired digest; unselected fields are reconstructed from that base. New copies use one stable UUIDv7 identity/reference mapping and do not inherit approval. Source text is excluded unless explicitly selected; source hashes are recomputed and rights flags remain author claims. Provenance paths use the shared lowercase dotted grammar with bracketed numeric indices and verified collection prefixes. Malformed paths remain unresolved rather than normalized or marked stale. The transfer model itself has no network, filesystem, database, publication or release authority; card48 owns end-to-end workflow acceptance.

## Builder Pending review (CASE-196)

Submission captures the exact current paired draft and its revision, `builder-intent-v1` and document-only content digest. A partial unique index allows one active pending/approved candidate per case. Any real draft revision advance supersedes that candidate under the same transaction lock; approval is bound to both digests and cannot survive a changed snapshot. A no-op save does not alter the revision or candidate.

P14 permits entitled authors to submit/cancel; P33 review/approval and P15 release are configured-admin only and recheck account/current entitlement on every request. The release RPC requires the unchanged approved candidate and live paired draft, server-verifiable sources and resolvable confirmed provenance, valid art and approved workspace assets. It writes the immutable version, art descriptor, candidate receipt and audit in one transaction. Legacy first-publish is revoked at Worker and SQL; the separate admin restoration of a withdrawn immutable version is unchanged.

Candidate bodies are private and capped; status history refuses at its limit rather than evicting. Supersession, cancellation and release preserve minimal identity/digest/status evidence while dropping large bodies only through explicit lifecycle transitions. Current drafts, live checkpoints, windows, receipts, candidate bodies/history, immutable version documents and art descriptors share the transaction-locked workspace/global payload budget. Admission refuses over-budget growth without deleting retained evidence. The isolated card’s required verification, SQL assertions and three real two-session release/edit races pass. Integrated served acceptance remains tracked in the Builder execution record.


## Builder route context and inventory (card48)

Migrations15–17 bind checkpoint creation to an expected revision, add the P14 bounded private-case inventory, and expand the existing entitled authoring-context RPC to return title and latest available published-source identity. The inventory includes revision0 case shells without a saved document, making uncertain case creation inspectable. It excludes archived and foreign-workspace cases; it returns no document, source or provenance content. The context refuses archived cases and omits withdrawn source versions. Exact-source routes additionally verify the requested version belongs to the case before reading its pack.

The standalone `/create/new` (compatibility `/cases/new`) and `/cases/:id/edit` pages use the existing account refresh/session contract. Canonical `/present` and `/create`, legacy catalogue `view=drafts`, and optional `workspace=<UUIDv7>` select collection/context only; central URL builders validate them, and Worker P13/P14 independently authorize every operation. Draft inventory stays content-free and explicitly paged; direct/restored Builder menus read the same verified account identity as the editor. Draft data is never placed in navigation storage, browser databases, channels or URLs. Subviews keep the original editor mounted; private Preview captures its exact pair and runs shared local rehearsal authority without a room or server mutation. Migrations and complete schema2 readers must be deployed before enabling writers; reverting to a schema1-only reader after schema2 publication is unsafe.

Builder integration loads the room console only when entering a room. Browser history retains only the originating public case/version IDs and the room UUID in `caseReturn`/`ownedSessionId`, never content or a capability. Same-tab session-route restoration requires the history marker, existing tab-local room marker and ownership lock; a direct session URL remains a deliberate Rejoin. Room end restores the prior entitled case-detail URL and clears the history marker.

## Long-term teaching portfolio and membership workbench (CASE-198/199/200)

Additive migrations20261018/19 provide service-only bounded RPCs; clients never touch Postgres. Membership changes authorize deployment admin first, lock workspace membership revision and atomically preserve last-owner/audit constraints. Member revisions advance for legacy writes too. Workspace/member/case/room/audit inventories have actor/query-bound continuation and current entitlement checks.

Session portfolio retains deidentified journal/closed aggregate evidence with pinned immutable source and a versioned final manifest. Finalization follows acknowledged archive and end, proves contiguous seq==revision/final epoch/closed rounds and freezes source/evidence. Joined count is captured before personal purge. Legacy records without proof stay limited; active boundaries changing between pages refuse. P34 reads allowlist teaching payload and aggregate projection, excluding participant identity, credentials, free-text/per-person answers. Summary/statistics use own-session scope and long-term visibility; earlier end/expiry+24h personal purge remains unchanged.

See data contract (private historical reference; not distributed) for bounds and storage lifetime. Private pages hold one100-item/256KiB page; export rechecks unchanged access before/after generation, allows2MiB/100-page PDFs and labels ordered continuation. Font is a static OFL Montserrat Regular derivative from the existing Latin variable WOFF2, instantiated at weight400 with fontTools; runtime has no dependency. Unknown glyphs fail visibly to HTML/JSON. PDF tags are structural evidence, not full PDF/UA certification.

**CASE-201 text bounds.** Shared scene and response ceilings are 500 characters under the existing JavaScript string-length convention, while authoring preservation/transport/document/room byte budgets remain unchanged. The reducer rejects over-ceiling responses instead of truncating them. The 300-person 500-CJK 12-cycle capacity proof peaks at 668,456 UTF-8 bytes beneath the existing 1,000,000-byte whole-state bound. No SQL scene/response-length constraint changes; this needs no text-bound migration. Older 320/280 readers can refuse newly saved longer content, so code rollback is permitted only after every affected persisted draft and published version is compatible with the older bounds; restoring a draft alone does not alter immutable published versions. Otherwise fix forward.

## Planned Builder slide contract (CASE-205; not activated)

The refined workspace spec (private historical reference; not distributed) adds proposed versioned stable content blocks, semantic headings, occurrence-binding compositions, grid placement, independent reading order and grouped reveal memberships. Shared text/type/paragraph styles propagate with explicit ownership; layout/padding/alignment/background/reveal are local to a composition binding. Current schema1/schema2 and fixed text-group runtime above remain implemented behaviour.

Card56 must settle exact schema/capability/admission, legacy adapter/explicit conversion, source/provenance/transfer/Pending/CAS/SQL and bounds; card57 must prove occurrence-bound grouped progress, safe public projections, timeline/manual/clarification/reset compatibility and unchanged state/payload caps. Card58 history is memory-only bounded draft transactions; it cannot restore server authority. Card59 media needs explicit delivery/storage/entitlement/rights/lifetime/cache/recap review before implementation; asset IDs are currently withheld publicly. No schema number, SQL/R2 migration, new permission or activation is approved by this planning entry.

### Publication readiness and submission identities

`case_api.builder_publication_readiness` is an authenticated P-14 read-only check of the saved revision and server resources. The Worker combines its codes with the same document/provenance and source-digest validation used by submission. A check is a point-in-time report; existing mutation RPCs recheck authority and invariants.

`case_app.builder_submission_receipts` privately binds an additional submitter/request identity to an existing candidate. It carries no second document body, exposes no direct service-role table access, and is deleted with its candidate/case. Candidate identities plus aliases remain bounded to 1,000 per case. Alias receipts are charged 128 bytes in Builder usage. The global admission lock serializes deduplication, request binding and quota admission.

### Catalogue compatibility and art presentation (CASE-274)

The additive `list_case_catalogue_current` and `get_catalogue_case_current` RPCs retain P-11 authorization and output shapes and use `catalogue_duration_current` for schema2/3's15–90 minute range. Legacy RPCs retain their15/45 duration contract, allowing the shared database migration before production deploy. Both generations derive titles from the selected version, with a missing-title fallback. No version rows, art rows or grants on private tables change.

`art-presentation.mjs` is a client presentation adapter, never a publication or Worker derivation. It preserves healthy art and the frozen geometry engine. A failed layout can reclaim spacing from branchless decisions; only a solution passing every existing geometry check is adopted. Full detail requests unsummarised strands. Its64-entry cache and16-attempt bound do not change storage or runtime caps.

### Navigation metadata reads — CASE-356

`20261112000000_navigation_reads.sql` was applied on 2026-11-04 under CASE-357; exact SQL identity and service-only privileges are recorded in `db/README.md`. `resolve_catalogue_case` performs an active-account and P-11 check before returning workspace, effective role and latest published version number (a withdrawn latest version yields no startable version). It returns no case body. `query_case_session_portfolio` retains the existing P-32 and `record_visible` predicates, adds an exact case filter before LIMIT 20, and binds continuation to that case. The old unfiltered RPC remains unchanged. The Worker accepts the optional UUIDv7 case filter only on the existing private POST query, fences response case identities, and includes it in cursor context; old request/cursor shapes remain valid. These reads add no personal fields, retention exception or public capability.

### Alert presentation replay · 4 November 2026

New AlertDO reservations freeze subject/text/HTML alongside their admitted fixed-field facts in the existing pending JSON. Legacy pending JSON without a message stays text-only on replay, preserving the exact provider body and idempotency key across this deployment. No recipient address, credential, free text, database schema or retention rule is added. Success already clears the whole pending payload; safe presentation rollback retains the new reader. Regression evidence: `tests/alert-store.test.mjs`.

## Own records after case moves — 5 November 2026 (CASE-375)

The original starter retains their own historical records while current canonical-case access remains, including membership in the case’s new home. Other readers remain governed by the session’s original workspace membership and managers-see-records policy. Destination management never confers that old policy. Record, pinned-media and session-feedback admission use one session-bound helper; every fallback is own-only. Sessions discovers historical workspaces through separate paged self-only reads; this is not membership, case access or start authority. Removing current case access removes this fallback, while independently valid original-workspace access retains its existing reach. No session identifier, workspace binding, participant data or retention changes.

Per-session feedback uses this same historical-record boundary. Pooled case feedback retains its existing P-38 case-level authorization; this change does not redefine its scope or collect new information.


## Beta issue storage — release pending (CASE-376)

The additive beta_issue_reporting migration adds private beta_issues, beta_issue_files, beta_issue_events, beta_issue_deletes and beta_issue_sweep_state tables; no browser table grants. Worker-only beta_issue_dispatch accepts an internally derived verified principal/account or participant HMAC envelope, current admin/designation booleans and bounded action input. A room-specific random issue salt separates reporter hashes from teaching Feedback. Reservations lock the principal for atomic rolling hourly/daily quotas; a short deployment lock bounds flood reservations. UUIDv7 operation age is checked before create (24h replay, 5min skew), and frozen digest replay returns the same reference and acceptance receipt. Reserve is pending; acceptance follows verified attachment storage. SQL CAS and a serialized duplicate graph protect triage. Client drafts, blobs and previews are memory only and retired on identity/capability/page teardown. <!-- removal-stamp-exempt: generic rule: beta-report retention policy, not a completed-removal claim -->

Screenshots are at most three PNG/JPEG objects of 5,000,000 bytes each, in the existing private MEDIA R2 binding under issues/<server issue UUID>/<file UUID>. Worker checks manifest digest/size/MIME and strict structure, dimensions and PNG decompression. Private JPEG validation ignores framed opaque metadata only in a bounded coding-validation copy; stored originals remain byte-identical (CASE-379). Public Builder metadata exclusions are unchanged; no content masking/classification or extra scanner service. The browser native picker precedes the modal, one frame is encoded and every track is stopped. Upload starts only on Send. Private serving repeats authorization and expiry after the R2 read, with no-store/nosniff. No signed public evidence links. Unfinished uploads expire after 24h; read-time TTL prevents access while bounded SQL/R2 deletion retries complete. A periodic orphan sweep handles a crash between object write and metadata commit.

Unresolved evidence remains; Fixed/Closed resolution sets a 30-day evidence deadline and Duplicate follows the canonical issue. Reopen cannot restore already deleted evidence. Participant originals, derived titles, follow-up/internal prose, attachment associations, operation digest and principal/account/session/resource links obey the earlier session end/expiry+24h cutoff through purge_expired_participant_data. Original evidence is removed and private object keys enter a durable retry queue. Session deletion purges linked originals before unlinking; reopening after a deadline first retires evidence and never revives it. Failed screenshots cannot block text acceptance: exact receipt attachment outcomes name stored or missing slots. Only an explicitly reviewed nonpersonal summary may survive the participant cutoff, until resolution+30d; nonpersonal issue/reference/build/status/timestamp metadata may remain after that. Current reads enforce the deadline independently of sweep lag. API traffic and objects are never service-worker cached; only static reporter chunks join the existing static shell build. <!-- removal-stamp-exempt: generic rule: beta-report retention policy, not a completed-removal claim -->
