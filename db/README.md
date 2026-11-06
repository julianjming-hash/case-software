---
doc: CASE-DB
status: living
purpose: How the Case databases are laid out, tested, and applied. Covers Postgres on the separate Supabase project, and the SQLite inside each live-room Durable Object.
read_when: Before writing a migration, changing the room schema, or applying anything to Supabase.
---

# Case databases

The design is in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). This file covers the mechanics.

| Path | What |
|---|---|
| `db/supabase/migrations/` | Postgres migrations for the Case Supabase project, in Supabase CLI layout |
| `db/tests/supabase-stub.sql` | The roles and `auth.users` a Supabase project provides, for local testing only |
| `db/tests/*.test.sql` | SQL assertions; each block raises on failure |
| `db/durable-object/room-schema.sql` | SQLite schema applied inside every live-room Durable Object |

## Draft summary read applied — 2026-11-04

CASE-368 release receipt: Codex applied the reviewed summary migration once after Julian authorised the release and the exact-head PR gates passed. Source SHA-256 `2a981bbe6f4db81ca93fa3a45bcb83d1d4984eb5127bd8d03b2592faabacb6c9`; one stored statement, 3,432 bytes, MD5 `880cec1c285eb8cbeceff6a68fa94fb8`. The connector stamped `20261104143027`; after an initial automatic-review rejection, Julian explicitly approved the exact history-only alignment to repository version `20261114000000`. A guarded one-row metadata update succeeded and retained the same statement identity; no SQL was replayed and no application data changed.

Readback confirms the new stable SECURITY DEFINER summary RPC is service-only, empty search path / 2s timeout; the private immutable art helper is invoker with no service/anon/authenticated execution. The legacy draft reader MD5 remains `9bd91cdf52c36f7311075a5feaaeaf69` with unchanged ACL/search path. Security advisories are unchanged from the preflight. Runtime deployment/live evidence belongs to the release receipt (private historical reference; not distributed). The 2026-11-04 applied-state receipt supersedes the historical unapplied checkpoint below.

## Draft summary read pending — 4 November 2026

CASE-364 adds `20261114000000_draft_summary_inventory.sql`, generated with pinned Supabase CLI 3.0.0 and numbered after the existing logical migration chain. **Unapplied; no remote application is authorised in this follow-up.** It adds only a bounded P-14 service read and private numbers-only artwork helper. No existing migration/function/table or permission cell is replaced. `builder-draft-summary.test.sql` covers private-field exclusion, current art, paired publication intent, stale review evidence, withdrawn history, paging and grants; the generated permission matrix classifies the new RPC under P-14. Apply the reviewed migration before rolling out the v2 Worker/client, only after separate release authorisation. Old draft inventory callers remain compatible.

## Teaching inventory follow-up — 4 November 2026

**Release receipt — 2026-11-04:** applied once to Case after the full local gate passed (2,724 Node / four existing todos, 186 DO, all SQL / eleven real PostgreSQL tests). Source SHA-256 `11555c4fa2ddcac01c1de31a60ef593d2cce9e8b3092b265d52863e81bafc559`; stored statement MD5 `e9ef2ebcafb9f0efeea5317b37e9ab23`. The connector stamped `20261104003607`; after exact statement verification, a guarded metadata-only update aligned it to repository version `20261113000000`. No SQL was replayed. All three new RPCs are SECURITY DEFINER with empty search path / 2s timeout, service-role execution only, and the partial index exists. The four legacy portfolio/privacy function fingerprints are unchanged. No live domain rows were read or purge invoked as a test. This supersedes the unapplied checkpoint below; CI/Worker deployment receipts remain on PR 372.

2026-11-04: Owner-approved CASE-359 adds `20261113000000_teaching_session_inventory.sql`: new service-only teaching query/statistics, cumulative anonymous join totals and bounded 30-day abandoned-Lobby cleanup. It is **not yet applied** at this checkpoint. Local `teaching-session-inventory.test.sql` and the generated permission witness exercise teaching-before-limit paging, date alignment, removed identities/personal purge, old-reader compatibility and cleanup exclusions/limits/idempotency. Required full verification precedes application; no applied migration is edited or replayed. Live/DO and personal-data lifetimes remain the stricter existing 24h contracts. Worker/client/cron rollout must follow the migration.

## Navigation reads applied — 4 November 2026

Julian authorised the runtime release on 2026-11-04 (CASE-357). After a green mandatory local verification, Codex applied `20261112000000_navigation_reads.sql` through the Case Supabase connector: neutral bookmark metadata and case-scoped Sessions paging, both service-only under existing P-11/P-32 authority. Source SHA-256: `8eff05c64ccc5d9dc75329123dd0ecb5599f596d5f0b02d178d603bc942ee514`. The CLI 3.0.0 remote dry run stalled and was stopped before any application; the connector applied the exact repository SQL once.

Metadata readback confirms SECURITY DEFINER/empty search paths, service-role execution and no public/anon/authenticated execution for both new helpers. The legacy session-query definition remains unchanged (MD5 `7bdab91587968ac43365c4832b98b9db`). After matching the single tracked SQL statement to the source, connector timestamp `20261103214535` was guardedly aligned to repository version `20261112000000` without replaying SQL; the stored statement MD5 remains `e8cf2cc331ce223a96a3b3c911450c64`. No live test rows or personal-data reads were used. Tests remain throwaway/local, including `navigation-reads.test.sql`. The Worker deployment follows through CI after all required PR/main checks.

## Test

```sh
npm run test:db
```

This creates a throwaway local Postgres, applies the stub and every migration in order, runs every `*.test.sql`, and deletes the database. It needs Postgres 15 or later (`brew install postgresql@16`) and skips cleanly without it. Use `CASE_REQUIRE_DB=1 npm run test:db` to require the database gate locally. The Durable Object schema is tested by `npm test` (`tests/room-schema.test.mjs`) on Node's built-in SQLite.

## Apply to Supabase

The production project is `mmlrxmrcoacuvfrsiffu`, in Sydney, in Case’s own free-tier organisation (CASE-126). Staging shares this database under CASE-159, using a separate Worker key and the dedicated Load testing workspace; it has separate Durable Object namespaces. Applied migration files are immutable. Julian normally applies reviewed migrations; his explicit 2026-10-08 release authorization also covers Codex applying the two merged live-repair migrations through the Supabase connector.

Applied-state readback on 2026-10-08 confirms all fourteen repository migrations, through `20261012000000_room_history.sql`, including the preceding permissions contract. The correction/history files were applied byte-for-byte from merged main `cd91f00701e00d2e7b1edc09e5e3651fc6bb16a3`; generated connector tracking timestamps were identity-checked and aligned with the repository versions without rerunning their SQL. Five correction provenance columns and the new history RPC are present; history execute is allowed for `service_role` and refused for `anon` and `authenticated`. This release preflight used schema/privilege metadata only, with no live test rows. See the audio and release record (private historical reference; not distributed) for file hashes and Worker deployment provenance.

Applied-state on 2026-10-17/18: `20261027000000`–`20261031000000` were applied in production but missing from the CLI's migration history; a read-only marker check confirmed all five, so they were marked applied with `supabase migration repair` without re-running their SQL. Julian then applied `20261101000000_participant_feedback.sql` (M1, CASE-284) and `20261102000000_feedback_results.sql` (M2, CASE-284) with `npx supabase --workdir db db push`.

Applied-state on 2026-11-02: `20261110000000_room_music_journal_kind.sql` (CASE-334) applied by Claude with `npx supabase --workdir db db push` after a dry run, before the Worker that writes `music_set` deployed (Julian authorised the deploy); a second dry run reports the remote database up to date.

Applied-state on 2026-10-18, applied by Julian with `npx supabase --workdir db db push` after a dry run each time:
- `20261103000000_asset_review_fence.sql`, then `20261105000000_asset_review_contract.sql`. The contract drops the unfenced six-argument `admin_review_asset`, so a Worker older than `eaadd02` can no longer approve images: fix forward rather than rolling back past it.
- `20261104000000_feedback_subject_comments.sql`, `20261106000000_facilitator_label.sql` and `20261107000000_feedback_at_debrief.sql`, with `--include-all` because `20261104` sorts before the already-applied `20261105`.

The Card 05 migration `20261002010000_published_rooms.sql` adds three exact service-role-only RPCs: bounded `get_me`, workspace-scoped `get_case_version_for_workspace`, and owner/author-only `get_case_authoring_access`. It does not grant `anon` or `authenticated` execution or any access to `case_app`. It is included in the applied-state readback above.

The Card 11 migration `20261002020000_console_pair_rooms.sql` adds `list_owned_active_sessions(p_user_id, p_limit, p_after)` for the signed-in phone's bounded, owner-only active-room picker. It returns session IDs, join codes and expiry only, rejects foreign or expired cursors, and grants execution to `service_role` alone. Its assertions are in `db/tests/z-console-rooms.test.sql`; It is included in the applied-state readback above.

For the recorded production project, from the Case root:

```sh
npx supabase --workdir db link --project-ref mmlrxmrcoacuvfrsiffu
npx supabase --workdir db db push --dry-run
npx supabase --workdir db db push
```

Julian verifies these settings; repository tests cannot confirm the deployed dashboard:
- [ ] **Data API → Exposed schemas** contains `case_api` only.
- [ ] `pg_cron` is enabled and `select jobname, schedule from cron.job` includes `case-purge-participant-data`. If absent, enable the extension and apply the reviewed schedule block.

Keep the Supabase secret key only as Worker secret `SUPABASE_SECRET_KEY`. Disable legacy API keys after cards 04 and 11 are deployed and every caller uses the replacement keys (see `docs/SETUP-SECRETS.md`).

## Archive schema and RPCs

The Card 06 migration `20261002030000_archive_retention.sql` adds nullable `case_app.sessions.personal_data_delete_at` and an index. It replaces the implementations of `archive_session_batch(uuid,jsonb)`, `end_session(uuid,bigint,integer)` and `purge_expired_participant_data(interval)` without changing their signatures or service-role-only execute privileges. It is included in the applied-state readback above.

Archive metadata accepts paired absolute ISO `ended_at` and `personal_data_delete_at` strings (UTC or explicit offset), validates the end against the database receipt clock, and clamps the cutoff to the earliest known boundary. A clock difference may require retrying the same immutable metadata later. The independent metadata-only acknowledgement precedes personal data. Expiry/finalization preserve actual end timestamps; late batches immediately purge/skip personal rows, preserve tombstones, and recheck the deadline after writes. Scheduled purge cadence remains 15 minutes.

Durable Object schema version 2 adds `pending_at` to participant, round, response and journal rows, and `row_version` to the three mutable tables. Existing local v1 state is preserved by additive, idempotent column migration. No historical identifiers are invented; Julian confirmed no deployed rooms used the old storage format. Server end, effective deletion cutoff, metadata acknowledgement and retry watchdog live in `meta`. Only acknowledged row versions are marked archived. During live rooms, personal rows stay pending but ineligible; round/journal delivery continues. Unsent personal data is deleted with the room even if SQL never recovers.

## Administrator migration (Card 21a)

The `20261002040000_admin_server.sql` adds fixed-field immutable audit, bounded service-only profile/version reads and CAS operations, atomic step-up admission and durable due-deletion claims. Assertions are in `db/tests/zz-admin-server.test.sql`. It grants no public `case_app` access and does not change participant purge cadence or retention. It is included in the applied-state readback above; existing migrations remain unchanged.

A claim binds the expected profile revision to a durable hard-delete audit intent before Auth deletion. Uncertain deletion is not automatically repeated; claimed profiles cannot be restored or compensated. See `docs/OPERATIONS.md` for reconciliation limitations. SQL tests use throwaway local Postgres only.

## Art descriptor migration (Card 28; CASE-164)

The `20261006000000_case_version_art.sql` adds the immutable `case_app.case_version_art` row (one per published version, RLS on, no grants) and `case_api.publish_draft_with_art`, which publishes exactly like `publish_draft` but first derives the draft's structure in SQL (`case_app.art_structure`, a port of `describeCase`) and refuses any descriptor that differs or is not the exact numbers-only shape. It stores the renderer version beside the descriptor, guards the table against UPDATE, DELETE and TRUNCATE (`case_versions` itself has no TRUNCATE guard: a pre-existing gap), and revokes service_role's execute on the art-less `publish_draft`, which stays installed for `publish_draft_with_art` to call as its definer. `list_published_versions` and `get_case_version_for_workspace` are recreated with one extra `art` column (null for versions published without art). Assertions are in `db/tests/case-version-art.test.sql`; `tests/art-sql-parity.test.mjs` holds the SQL and JS derivations to the same expectations. `npm run test:db` now runs from the Case root so SQL tests can read the fixture. It is included in the applied-state readback above.

**Pre-deploy check for this migration (read-only; Julian runs it against production before deploying the Worker).** The case validator now refuses a non-boolean `recommended`, and stored versions are re-validated when a room starts and inside the room Durable Object, so any such row would fail integrity. Expect zero rows:

```sql
select v.id as version_id, v.case_id, v.version_no, d ->> 'id' as decision_id, p ->> 'id' as path_id,
       jsonb_typeof(p -> 'recommended') as recommended_type
  from case_app.case_versions v
  cross join lateral jsonb_array_elements(coalesce(v.document -> 'decisions', '[]'::jsonb)) d
  cross join lateral jsonb_array_elements(coalesce(d -> 'paths', '[]'::jsonb)) p
 where p ? 'recommended' and jsonb_typeof(p -> 'recommended') <> 'boolean'
 order by v.case_id, v.version_no;
```

## Permissions contract migration (card 35b)

The `20261010000000_permissions_contract.sql` (card 35b, 2026-10-07) is the contract step of the card 35 expand/contract rollout (`docs/PERMISSIONS.md` §7.1). It moves the old admin-only bodies (`admin_provision_facilitator`, `admin_set_version_state`, `admin_transition_profile`, `admin_revert_profile`) into `case_app` under the same names, with no grant, recreates the `case_api` admin wrappers to call them, and drops the expand-window overloads (the 2-, 3- and 5-argument admin signatures, `bootstrap_workspace(uuid,text,text)`, the 11-argument `list_case_catalogue`) and the retired `publish_draft`, `get_case_version` and `create_session(uuid,uuid,uuid,text,interval)`. Functions only: no table or row changes. Assertions are in `db/tests/permissions-contract.test.sql`; the older test files now drive the surviving signatures.

**Apply it only after BOTH the production and the staging Workers serve a build that contains card 35 (production must be redeployed to main first).** A Worker older than card 35 calls the dropped signatures and fails. Rolling either Worker back past this migration is unsafe; fix forward. Order: `docs/RUNBOOK-INCIDENT.md` §Card 35 database rollout, step 4.

## Access, invitations and images migration (facilitator-UX A2)

Applied on 2026-11-03 by Codex after Julian renewed release authorisation: the linked-project dry run listed only `20261111000000_access_invitations_images.sql`; application succeeded and a second dry run reported the database up to date. Vault updates were disabled. Access PR 368 then merged as `c92b330d`.

`20261111000000_access_invitations_images.sql` is additive and backward-compatible with the deployed Worker, so it may be applied before the Access PR's Worker deploys (staging and production share this database, CASE-159). `case_app.authorize` keeps its signature (the case-level core is the new `case_app.authorize_case`, which has no defaults so no existing call becomes ambiguous); every existing `case_api` signature is kept, and `get_me` is recreated with one more result column (`grants`), so it is re-granted to `service_role` in the same file. It adds `case_grants`, `workspace_policies` (a row for every workspace, `managers_see_records` on; new workspaces from a trigger), `invitations` and `invitation_events`, `case_assets` and `workspaces.media_quota_bytes` (2 GB). Every function and its fate: private historical reference (not distributed). Assertions: `db/tests/access-invitations-images.test.sql` and the regenerated `db/tests/permission-matrix.test.sql`.

Rolling the Worker back past it is safe. Two behaviours change for the deployed Worker as well: images no longer need approval in release, readiness and the session-record image route (the deployed room start still filters approved images until A3 ships), and the hourly sweep no longer closes images left unapproved for 30 days.

## Pilot free tier

CASE-126 selects the free tier for the pilot. Card 07 configures keep-alive and heartbeat checks; their owner-managed secrets, deployment and drill are still pending. Treat a paused project as an incident (`docs/RUNBOOK-INCIDENT.md`). The recorded free-plan limitation is no PITR; card 16 adds a case-version export, and card 19 must verify the actual backup retention before procurement sign-off. Do not promise a restore from an export that has not been built and tested.

## Rules

- **Never edit an applied migration.** Add a new `YYYYMMDDHHMMSS_snake_case.sql`.
- **Every migration ships with assertions** in `db/tests/`.
- **Tables go in `case_app`, functions in `case_api`** (`SECURITY DEFINER`, `search_path = ''`, execute granted to `service_role` only).
- **Never grant anything on `case_app` to `anon` or `authenticated`.** A `42501` means an RPC is missing.
- **The room schema must stay idempotent.** It runs on every Durable Object start (`CREATE … IF NOT EXISTS`). Changing an existing table needs a `meta.schema_version` step in the Durable Object code.


## Builder migration state and authorized follow-up

The prior Builder release applied migrations13–17 in order. The authorized follow-up applied `20261018000000_admin_workbench.sql` then `20261019000000_session_portfolio.sql` once from merged main49e77f3 on2026-10-10 (Perth). All21 repository migrations are now applied. Exact stored SQL identity, new columns and service-only RPC privileges were read back; direct public table grants remain zero and security/performance advisors show no new findings. Connector-generated tracking timestamps were guardedly aligned to the repository versions after exact statement identity checks, without replaying SQL. The500-character change has no SQL length constraint and requires no migration. See release evidence and rollback limits (private historical reference; not distributed).

`20261101000000_participant_feedback.sql` (CASE-284 working number; design on branch docs/participant-feedback) is additive. Each room gets a six-character Crockford `feedback_code` from an insert trigger, unique forever, so `create_session` keeps its signature. It adds the linked `session_feedback` table, which lives until the room's cutoff, and the long-term `session_feedback_tallies`, `session_feedback_totals` and `session_feedback_comments`. It also adds an https-only `feedback_form_url` on sessions and case groups, the service-only `feedback_resolve`, `feedback_upsert` and `feedback_mine` RPCs, and the fold step in `purge_expired_participant_data`. Rooms already past their cutoff are closed; rooms still inside it get a code. Assertions are in `db/tests/participant-feedback.test.sql`. **Not applied.** Julian applies it after the Monday 19 October freeze.
