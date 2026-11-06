---
doc: CASE-PERMISSIONS
status: living
purpose: The canonical permissions model for Case (deployment admins, workspace roles, room capabilities), its permission matrix with enforcement points, invariants, edge cases, red-team findings and the best-practice comparison. Card 35 generates its matrix test from this file.
read_when: Before adding or changing any route, RPC, role, capability, admin action or audit event, and before reviewing cards 30–35.
---

# Case permissions model

Rulings: Julian, 2026-10-06/07 (CASE-137, CASE-141, CASE-168; access by place and level, workspace policies and managers approving, 2026-11-02, CASE-336–CASE-338; private historical reference (not distributed) R3, R5, R7–R10). Enforcement: card 35 (private historical reference (not distributed)). Code citations are against branch docs/domain-workspaces-design at 244e199 unless marked *main*; after card 29 merged, `src/worker/facilitator-api.mjs` on main is about 39 lines longer.

## Teaching inventory adapters — 4 November 2026

CASE-359’s new `query_teaching_session_portfolio` and `personal_teaching_portfolio_stats` preserve P-32’s existing own/case/workspace/admin rules while filtering Lobby-only attempts before paging/totals. HTTP-v2 opt-in keeps legacy readers intact. Distinct join counts are anonymous aggregate evidence, never names, credentials or per-person responses. `purge_abandoned_lobbies` is a service-only, bounded scheduled operation with no user-selected target or human grant. No permission-matrix cell or client table grant changes; the signature witness classifies both P-32 reads and the system cleanup.

## Navigation read adapters — 4 November 2026

CASE-356 adds two service-only helpers in the `navigation_reads` migration, applied 2026-11-04 under CASE-357 with metadata/privilege readback: neutral catalogue bookmark resolution under existing P-11, and exact-case Sessions filtering under existing P-32 with unchanged record visibility and twenty-row paging. Existing permission cells, write operations and legacy query signatures remain unchanged. The generator classifies their signatures and the SQL witness is regenerated from that authority. No client receives direct table access.

## 1. Model in one paragraph

**Current explanation — 5 November 2026 (CASE-373/374).** An **account** identifies a signed-in person; its profile Role is a label, not authority. **Workspace access** is Can run, Can edit or Can manage within one named workspace (stored as facilitator, author or owner). **Case access** permits running or editing one canonical case. **Administrator** is separate deployment authority, derived only from the verified identity and current configured allowlist; it is never granted by an invitation or an ordinary membership. Groups organise content and grant no access. Participants/projectors/shared computers use bounded session capabilities, separately from account roles.

A case has one **home workspace**, draft and publication history. Additional workspaces point to that same case with explicit Can run or Can edit access. Their members receive the lower of their membership level and that sharing level. Across independent valid sources the highest applicable **case** access wins. This never yields home-workspace management, member administration or access to another person's session records. Publishing continues to follow the home workspace's policy. Removing one source of access does not remove another independently valid source.

Adding workspace access composes P-17 in home with P-14 in destination; removing it requires home management. Moving home composes P-17 in both workspaces. Configured global administrators may perform either. The transaction rechecks scope and revision, preserves case/version/draft/invitation identities and historical session workspaces, and refuses a home move during active sessions or unresolved review. Queued authoring writes recheck access and refuse a changed home after their shared lock. Renaming changes the display name and details revision only; UUID, slug and compatibility links stay stable. Existing room capability lifecycles remain; this change does not introduce per-frame database authorization.

Examples: Can manage in Albany does not manage a Teaching case shared to Albany as Can run. A direct Can edit grant on one case can exceed a Can run membership for that case, while granting nothing on its neighbours. Admin settings, membership changes, publication review and session records keep their existing separate matrix cells and policies. Every action is checked from current server-side facts; no UI selection, URL, cached profile or client claim grants authority.

### Clear refusals and administrator escalation

For a resource already visible to the caller, explain the required **action and scope**, retain unsaved entries, offer Account → Your access, and tell the caller whether a home-workspace manager or Case administrator can resolve it. An unknown/hidden resource uses the same unavailable response; never disclose its owner, existence or membership list. A 401 asks for sign-in, 403 explains access recovery, a revision conflict asks for a fresh read, `case_in_use` identifies the active-session/review prerequisite, and an unavailable/uncertain result asks for reconciliation before retrying. Do not claim no change after an uncertain write.

The separate beta reporting kickoff (private historical reference; not distributed) specifies a future Admin Issues escalation. Until built, a copied diagnostic is a manual handoff, not a submitted report. Never attach credentials, invitation/join links, query/fragment values, raw network bodies, case content or participant data automatically. See the dated clarity review (private historical reference; not distributed).

## 2. Scopes and principals

| Scope | Principal | Identity source | Authority source | Lifetime |
|---|---|---|---|---|
| Deployment | Deployment admin | Supabase JWT (verified, `src/worker/auth.mjs`) | JWT email ∈ `ADMIN_EMAILS` (`src/worker/admin/gate.mjs`), read per request | While listed |
| Workspace | Owner, author, facilitator | Supabase JWT | `case_app.workspace_members.role`, read per request | Until membership ends |
| Room | Room starter ("console") | Supabase JWT at start and at every mint | Room DO `owner_user_id` + a hashed facilitator credential | Room life (≤ 24 h) |
| Room | Shared computer | none (approved device) | Facilitator credential minted by the starter's approval | Room life; revocable |
| Room | Projector | none (paired device) | Display credential | Room life; revocable |
| Room | Participant | none (anonymous-capable, CASE-119) | Participant credential from the join code | Room life + recap (24 h) |

Staging shares the production Supabase project and Auth (CASE-159), so a staging Worker is a second door into production data. Staging admins keep full reach there by Julian's ruling (accepted risk A2, §12).

## 3. Roles

| Role | Scope | Grants (in addition to the role below it) | Never |
|---|---|---|---|
| Deployment admin | All workspaces | Create workspaces and choose presets; invite, change roles, remove members; author, publish, run rooms anywhere without membership; all audit; all live rooms; end any room; account lifecycle | Act without a verified JWT; skip step-up on destructive actions; be granted by the database |
| Owner | One workspace | Workspace name and suggestion lists; groups (create, retint, archive, assign); withdraw and republish versions (step-up); approve and release its candidates (CASE-338); share a case; invite as author or facilitator while `managers_invite` is on (CASE-337) | Make anyone an owner, change roles, remove members; change the preset; create workspaces; set policies; read the audit |
| Author | One workspace | Create cases; read and save drafts; publish versions | Withdraw or republish; manage groups or settings |
| Facilitator | One workspace | Browse the library; start and run rooms; approve a shared computer and pair a display for their own room | Read drafts; publish |

A person can hold different roles in different workspaces. The role is always resolved for the (person, workspace) pair named by the request, never globally.

## 4. Permission matrix

Cells: `yes` allowed · `step` allowed with a fresh scoped step-up · `own` only for a room the principal started (P-47: the principal’s own report) · `cap` holder of that room capability (P-46: of the invitation reference; P-49: explicit incident designation intersected with current deployment administration) · `pol` refused unless the row's workspace policy is on · `own+pol` `own`, and every room in the workspace while the policy is on · `no` refused. Columns describe what the role itself grants; **Case author** and **Case facilitator** are a grant of Can edit or Can run on one case and describe what that grant gives on that case only (§4.3); anyone can also hold a participant capability by joining with a code. Enforcement codes: **W** Worker check in the one authorization core · **R** RPC check (`case_app.authorize`, today `assert_member`) · **D** room Durable Object credential check · **S** scoped step-up · **G** GoTrue. Every listed point must refuse on its own (card 35 sabotage tests). Status: OK (enforced today), GAP (rule ruled, code missing or wrong), NEW (lands with a card).

<!-- permission-matrix: card 35 parses this table; keep the columns and tokens exactly. -->
| ID | Action | Admin | Owner | Author | Facilitator | Case author | Case facilitator | Participant | Projector | Shared PC | Enforced at | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P-01 | Create a workspace and choose its preset | yes | no | no | no | no | no | no | no | no | W, R | OK |
| P-02 | Change a workspace's preset | yes | no | no | no | no | no | no | no | no | W, R | NEW (31) |
| P-03 | Invite a person into a workspace with a role (an owner: into their own workspace, as author or facilitator only) | yes | pol | no | no | no | no | no | no | no | W, R, G | OK |
| P-04 | Change a member's role | step | no | no | no | no | no | no | no | no | W, R, S | OK |
| P-05 | Remove a member | step | no | no | no | no | no | no | no | no | W, R, S | OK |
| P-06 | Disable, soft-delete, restore an account | step | no | no | no | no | no | no | no | no | W, S, G | OK |
| P-07 | Read the deployment audit | yes | no | no | no | no | no | no | no | no | W, R | OK |
| P-08 | List every live room | yes | no | no | no | no | no | no | no | no | W | OK |
| P-09 | End any live room | step | no | no | no | no | no | no | no | no | W, S, D | OK |
| P-10 | See the workspace in the picker (`/me`) | yes | yes | yes | yes | no | no | no | no | no | W, R | OK |
| P-11 | Browse the library, versions and case detail | yes | yes | yes | yes | yes | yes | no | no | no | W, R | OK |
| P-12 | Read workspace settings and groups | yes | yes | yes | yes | no | no | no | no | no | W, R | OK |
| P-13 | Create a case | yes | yes | yes | no | no | no | no | no | no | W, R | OK |
| P-14 | Read and save a draft | yes | yes | yes | no | yes | no | no | no | no | W, R | OK |
| P-15 | Release an approved Pending candidate as a version | yes | yes | pol | no | pol | no | no | no | no | W, R | GAP |
| P-16 | Withdraw or republish a version | step | step | no | no | no | no | no | no | no | W, R, S | NEW (32) |
| P-17 | Edit the workspace name and suggestion lists | yes | yes | no | no | no | no | no | no | no | W, R | NEW (32) |
| P-18 | Create, edit or retint a group | yes | yes | no | no | no | no | no | no | no | W, R | OK |
| P-19 | Archive a group | step | yes | no | no | no | no | no | no | no | W, R, S | OK |
| P-20 | Assign a case to a group | yes | yes | no | no | no | no | no | no | no | W, R | OK |
| P-21 | Start a room from a published version | yes | yes | yes | yes | yes | yes | no | no | no | W, R | OK |
| P-22 | Read the workspace audit | yes | no | no | no | no | no | no | no | no | W, R | OK |
| P-23 | Run a room's console (reveal, lock, select path, rename, remove, end) | own | own | own | own | own | own | no | no | cap | D | OK |
| P-24 | Mint a fresh console credential for a room | own | own | own | own | own | own | no | no | no | W, D | OK |
| P-25 | Approve a shared computer for a room | own | own | own | own | own | own | no | no | no | W, D | OK |
| P-26 | Pair or revoke the room's projector | own | own | own | own | own | own | no | no | cap | D | OK |
| P-27 | Revoke one console credential (shared computer) | own | own | own | own | own | own | no | no | no | W, D | OK |
| P-28 | Join a room with its code | no | no | no | no | no | no | cap | no | no | W, D | OK |
| P-29 | Submit or change one's own answer | no | no | no | no | no | no | cap | no | no | D | OK |
| P-30 | Watch the public projection | no | no | no | no | no | no | no | cap | no | D | OK |
| P-31 | Read one's own recap (24 h) | no | no | no | no | no | no | cap | no | no | D | OK |
| P-32 | Read own room history summaries | yes | own+pol | own | own | own | own | no | no | no | W, R | GAP |
| P-33 | Inspect and approve a Pending candidate | yes | yes | pol | no | pol | no | no | no | no | W, R | GAP |
| P-34 | Read/export participant-deidentified session record | yes | own+pol | own | own | own | own | no | no | no | W, R | GAP |
| P-35 | Submit or change one's own session feedback until the room's cutoff (a participant credential, or the room's public feedback code) | no | no | no | no | no | no | cap | no | no | W, D | OK |
| P-36 | Page the ended projector's debrief (a bounded grant minted by the room's console after End; card 40d) | no | own | own | own | own | own | no | no | cap | D | OK |
| P-37 | Read a room's participant feedback (distributions, the joined/QR split, comments) | yes | own+pol | own | own | own | own | no | no | no | W, R | GAP |
| P-38 | Read pooled case-content feedback for one version of a case | yes | yes | yes | no | yes | no | no | no | no | W, R | OK |
| P-39 | Read app feedback and all feedback pooled (Administration → Feedback) | yes | no | no | no | no | no | no | no | no | W, R | OK |
| P-40 | Set one's own facilitator Name & role (the first-sign-in step and Account; printed on the participant record) | yes | yes | yes | yes | yes | yes | no | no | no | W | OK |
| P-41 | Correct another account's facilitator Name & role (Administration → Facilitators) | step | no | no | no | no | no | no | no | no | W, S | OK |
| P-42 | Archive a never-published draft case (Builder) | yes | yes | no | no | no | no | no | no | no | W, R | OK |
| P-43 | Share one case with a person as Can run or Can edit (an owner: either level; a runner or editor under the policy: Can run only) | yes | yes | pol | pol | pol | pol | no | no | no | W, R | OK |
| P-44 | List, resend or revoke a workspace's invitations | yes | pol | no | no | no | no | no | no | no | W, R | OK |
| P-45 | Set a workspace's policies (§4.3) | yes | no | no | no | no | no | no | no | no | W, R | OK |
| P-46 | Read an invitation by its reference (`/i/#<ref>`: the address, inviter, place and level only) | cap | cap | cap | cap | cap | cap | cap | cap | cap | W | OK |
| P-47 | Submit a beta issue and read own submitted evidence/public follow-ups | own | own | own | own | own | own | cap | no | no | W, D | OK |
| P-48 | Read and triage ordinary beta issues (deployment allowlist only) | yes | no | no | no | no | no | no | no | no | W | OK |
| P-49 | Read and triage restricted incidents (designated deployment admin only) | cap | no | no | no | no | no | no | no | no | W | OK |

**P-23 room system actors (CASE-319).** The room's Durable Object finalises a closing window at its deadline (`finalise_lock` as `system:lock`) and opens one when everyone connected has answered (`lock` as `system:auto`, refused when the room's auto-lock setting is off). Both act for the console under P-23 and are set by the Worker, never by a client; `finalise_lock` (Lock now), `cancel_lock` (Keep open) and `set_auto_lock` are console commands under P-23 like `lock`.

CASE-193 deliberately reuses P-21 for a non-room pack read: only an active account that can run that exact published version can rehearse it. Worker authorization and `get_case_version_for_workspace` both recheck it; withdrawn/foreign/nonmember reads are refused. The no-store GET creates no session and accepts no room capability. P-32 remains summary room history. No new role, matrix cell, RPC grant or public pack access is introduced.

P-15 is the release of an exact approved Builder candidate; the legacy first-publication route and RPC refuse. P-33 is the separate candidate inspection and approval action. Since CASE-338 both belong to the workspace's owners as well as admins, and to its authors (workspace or case) while `editors_publish` is on; P-33 no longer covers images, whose approval is removed (Julian, 2026-11-02, plan §0.2). Withdraw and republish stay P-16 with step-up. Rows marked GAP are ruled and not yet enforced everywhere: the Worker reads policies and case grants from step A3. The SQL side landed in step A2 (`20261111000000_access_invitations_images.sql`): `case_app.authorize` decides policy cells, `case_app.authorize_case` adds case grants, the candidate RPCs audit an owner as `owner` and an author as `author`, and `SQL_PENDING` in `scripts/gen-permissions.mjs` is empty (inventory: private historical reference (not distributed)). Candidate submission/cancellation and draft work remain P-14. Rows P-10 to P-14 and P-21 gained the admin path in card 35 (`src/worker/authorize.mjs`, `case_app.authorize`); `tests/permissions-matrix.test.mjs` drives each enforced row as every principal. Card 30 enforced P-12 (groups; card 31 adds the workspace settings to the same read), P-18, P-19 and P-20 (`src/worker/groups.mjs`, the `case_api` group RPCs in `20261009000000_case_groups.sql`). P-19's owner archive keeps type-to-confirm without step-up; an admin archive needs the session's admin elevation at the Worker and a matching recorded elevation in SQL. Step-up for owners is ruled only for P-16.

### 4.1 Where each check lives

```text
request ─► Worker: verify JWT ─► account active? ─► actor = { userId, email, admin }   (admin from ADMIN_EMAILS only)
                                   │
                                   ├─► authorize(actor, place, action)   one core; place = workspace or { workspaceId, caseId | anyCase };
                                   │       membership, grant and policies read once (get_me, or get_access for a case alone)
                                   │       └─ step-up actions: verify a scoped elevation
                                   ├─► RPC (service role) with p_user_id, p_admin, p_admin_email
                                   │       └─ case_app.authorize(user, workspace, action, admin) ─ binds child ids ─ writes audit in the same transaction
                                   └─► Room DO (capability mint only after the two checks above; every frame checks the hashed credential)
```

- The Worker check gives the right HTTP status and keeps work off the database; the RPC check is the backstop against a Worker bug (CASE-076). Both read the same matrix.
- The DO never sees a JWT. It trusts the Worker for mints and checks its own hashed credentials for everything inside the room.
- Admin-only deployment actions (P-01 to P-09) go through `src/worker/admin/` routes, which already re-check the verified email in each handler, and their RPCs refuse without the admin flag.

### 4.2 Adding an action

1. Add a row to the §4 table with an unused `P-NN` id, every column filled, its enforcement points and status.
2. Map the action key to its row in the shared matrix module (card 35); the generated test fails until it does.
3. Call the one Worker core and `case_app.authorize`; bind every child id to the workspace; write the audit row in the same transaction for any write an admin can perform.
4. Add an edge case to §7 if the action has a lifecycle, cross-workspace or capability angle, and a sabotage test that removes each enforcement point in turn.

### 4.3 Case grants and workspace policies (CASE-336, CASE-337)

**Case grants.** A grant gives one person Can edit (Case author) or Can run (Case facilitator) on one case; Can manage is never a grant. Each case column mirrors the workspace role of its level: its cell is that role's cell or `no`, and a policy cell is copied exactly (the generator refuses any other shape). Actions on the workspace itself (P-10 picker, P-12 settings and groups, P-13 create a case, P-17 to P-20, P-22, P-42) are `no` for both case columns, so a case-only editor edits that case and cannot create one. On a case a person holds the strongest cell of every column they hold there (`decide` in `src/shared/permissions.mjs`), which equals the cell of their highest level (`effectiveLevel`; SQL `case_app.effective_role`, step A2). A grant on one case never reaches another, and a grant never lowers a workspace role. SQL: `case_app.action_case_roles(action)` lists the levels a grant reaches.

**Workspace policies.** Four switches per workspace, set by an admin (P-45) and readable by its members with the settings (P-12). Each flips only the `pol` and `own+pol` cells of its rows, for everyone in that workspace; there are no per-person switches. SQL: `case_app.policy_allows(action, role, policies)` is true when the role's cell is a policy cell and the policy is a JSON `true` in the workspace's policies (missing or any other value is off).

| Policy | Default (every existing workspace too) | Rows and cells it flips |
|---|---|---|
| `managers_invite`: managers can invite people | on | P-03 and P-44, owner `pol`: an owner invites into their own workspace as author or facilitator, never owner, and manages those invitations |
| `editors_publish`: editors publish without review | off | P-15 and P-33, author and case author `pol`: an editor approves and releases new versions; off, Send for review goes to the workspace's owners. Withdraw and republish are never covered (P-16) |
| `runners_share`: anyone who can run a case can share it to run | off | P-43, author, facilitator and both case columns `pol`: they share one case as Can run only, never Can edit |
| `managers_see_records`: managers see every session record | on | P-32, P-34 and P-37, owner `own+pol`: an owner reads every room's history, record and feedback in the workspace; off, only their own |

**Invitation routes (facilitator-UX A4, CASE-339 to CASE-341).** `POST /api/v1/invitations` is P-03 for a workspace place and P-43 for one case: the Worker authorizes first (an owner never invites an owner; below Can manage a case is shared as Can run only), and only then asks GoTrue for the account. `GET /api/v1/workspaces/<id>/invitations` and `POST …/invitations/<id>/resend|revoke` are P-44 on the workspace the path names; SQL decides again on the invitation's own workspace. `POST /api/v1/invitations/peek` is P-46: no sign-in, rate-limited per address (`INVITE_PEEK`), the reference in the body and only its SHA-256 sent to SQL. Acceptance needs no action: `GET /api/v1/me` accepts the verified address's own invitations. The per-inviter daily cap is 50 creations and resends (ruling R6). A case-only holder (scope `case`) asking for a version of a case they hold no grant on is refused 403 in the Worker before the version read (`version_case`, ruling R7); a member's refusal still comes from SQL.

**Share routes (facilitator-UX A6, CASE-336).** `GET /api/v1/cases/<id>/access` is P-43 on the case (`authorize` with the case place): `case_api.list_case_access` answers the workspace's members, the case's live grants and its pending invitations, and the Worker adds `you`: the levels the caller may grant (Can run and Can edit for an owner or administrator, Can run only below that), whether the whole workspace can be shared (P-03) and whether pending invitations can be resent or revoked (P-44). `POST /api/v1/cases/<id>/access/<grant>/revoke` is P-43 for owners and administrators only; a runner or editor under `runners_share` gets 403 before SQL, and SQL refuses again (audited `case_grant_revoke`). `GET /api/v1/shared-cases` is the caller's own live grants (`list_shared_cases`; self, no place). Case detail (`GET /api/v1/cases/<id>/versions/<n>`) now reads the caller's access once: a person who holds the case alone has no workspace-only group read (P-12 stays `no`; their group is Ungrouped), and the answer carries `scope` and `share` (null when P-43 is not theirs). `GET /api/v1/builder/cases/<id>/draft` carries `publishes` (P-15 for the caller, so the Builder says Publish update or Send for review). The case place's image registration takes a description and the uploader's confirmation (`attested`) with an optional `credit`; the workspace place keeps every detail it always required.
**Administration routes (facilitator-UX A5).** `POST /api/v1/admin/workspaces/<id>/settings` is P-45: an admin sets any subset of the four policies (JSON booleans) and optionally the image quota (whole bytes, 0 to 10 GB) against the policy revision (`admin_set_workspace_policies`; a stale revision is 409 `conflict`); it needs no step-up. `GET …/storage` now carries `policies` and `policyRevision`. `GET /api/v1/admin/facilitators` carries each account's workspace roles and live case grants (`admin_read_access`, a deployment read behind the admin gate that authorizes nothing); `access: null` means unreadable, never "holds nothing". A step-up code GoTrue refuses is 422 `code_rejected` (wrong or expired: GoTrue does not tell them apart), a rate limit 429 `rate_limited`, an outage 503 `admin_unavailable`. Cases and Rooms use the existing routes; the deployment-wide case and audit list routes (`cases_list`, `audit_list`) have no client any more.

## 5. Room capabilities

| Capability | Issued by | Scope | Stored | Expires | Revoked by | Survives a demotion? |
|---|---|---|---|---|---|---|
| Participant token | `POST /api/v1/join` with a live code (Turnstile after failures) | One room, one participant | SHA-256 in the DO `credentials` table | Room end + recap window (24 h) | Facilitator removal | n/a (no account) |
| Projector pass | Display pair code, approved by a console, single use, 5 min (`src/worker/directory-do.mjs`) | One room, read-only public projection | SHA-256 | Room deletion (end + 24 h; the code always behaved this way, corrected 2026-10-17, card 40 ruling I2). After End it shows only the ended panel, and debrief results only while a P-36 grant is live | Console "revoke displays"; re-pair | Yes, until revoked or the room ends (public material only) |
| Console credential (starter's device) | Room start, or a re-mint with the starter's JWT | One room, full console | SHA-256, `user_id` recorded | Room end | Takeover, admin end, account disable (CASE-141) | Yes: the existing credential runs to the room's end; no new mint (card 35: the DO records the room's workspace and the Worker rechecks an active account with membership or admin before every mint) |
| Console credential (shared computer) | Number-matched console pair, approved by the signed-in starter (`src/worker/console-pairs.mjs`); marked shared in the DO (`shared_consoles`) | One room, full console | SHA-256 | Room end | Takeover, admin end, account disable; the signed-in starter revokes one from Room setup (P-27, card 35b, CASE-177) | Same as above |

Required on every capability: one room only; never in a URL (rule 4); bearer only in the Authorization header or the first WebSocket frame; refused after revocation on the next read, write or socket frame (`src/worker/room-do.mjs` `#who`, socket recheck).

Room images (card 59 M3, CASE-269): `GET /api/v1/sessions/<id>/media/<handle>/<rendition>` (display or phone) with any of the room capabilities above. The room mints one opaque handle per image at start; a projector pass or participant token reaches an image only once a step showing it has been released in some timeline entry (`releasedMediaHandles`), and a console credential reaches every image of its room (it already holds the whole case, CASE-092). Unknown, unreleased, foreign and malformed handles all answer the same 404; a released image whose bytes are gone answers 410. Room start reads the version's images with `case_api.room_media_manifest` (P-21). The same-PC projector has no capability; its console relays released images' bytes over the local channel. A GIF's or video's `poster` rendition is reached the same way (a still has none).

Participant feedback (P-35, CASE-284 slice 4): the Worker routes `GET/PUT /api/v1/feedback/<code>` and `/mine` take the respondent only from the Authorization header. `Participant <token>` is verified by the room DO (`feedbackRespondent`), which refuses facilitator, display and other rooms' tokens and returns only an HMAC-SHA-256 of the participant id under a random per-room salt that is deleted with the room (R8); `Feedback <key>` is a random browser key the Worker hashes. The SQL RPCs trust the Worker's respondent (no R column). A browser key's first response passes Turnstile where it is configured.

Participant feedback results (P-37 to P-39, card 40 + feedback integration slice 9): each read is authorized twice. SQL first (`case_app.authorize`, the generated `action_roles` rows in `20261102000000_feedback_results.sql`): P-37's `case_api.session_feedback_summary` applies P-34's starter rule (the room's starter with current membership and an active account, or a configured admin); P-38's `case_api.case_feedback_summary` admits the case's workspace owners and authors and the admin; P-39's `case_api.admin_feedback_page` uses `case_app.authorize_admin`. The Worker then checks the exact result shape and the same matrix row (`src/worker/feedback-results.mjs`; P-39 through the admin route gate). A shared computer never reads P-37: the console's ended summary shows `Feedback · N so far` only on the starter's signed-in console (R9). Results carry comments, which may contain names; every results view says so.

Video playback (card 59 M3, Julian 2026-10-15): the `media_control` room command (Play, Pause, Restart a released video the projector shows now) is facilitator-only, like every other presentation command; the projector follows it and phones never receive it. Session record images (J10): `POST /api/v1/portfolio/media` `{sessionId, assetId}` answers one image the session's own version pins, as a JPEG, under P-34 and the starter rule exactly as the record read (`case_api.session_media_rendition`); a withdrawn image answers 410. No new matrix row.

## 6. Invariants (each is a test in card 35)

1. Authority has exactly two sources: a verified Supabase JWT plus the person's live places (`workspace_members`, live `case_grants`, and membership-capped `case_workspace_access` under CASE-373/375) read with the workspace's policies, or a verified JWT email in `ADMIN_EMAILS` (CASE-336, CASE-337). No body field, header, query, cookie, client storage, cached `/me` value or invitation reference contributes; an invitation grants nothing until it is accepted at sign-in by the verified email it names.
2. One authorization core. Every workspace- or case-scoped Worker route calls one function with (actor, { workspace, case }, action); every RPC calls `case_app.authorize` for a workspace action or `case_app.authorize_case` for a case action, deriving the case from the version, draft or session row it binds, never from the request. Policy cells are decided only through `case_app.policy_allows`. No inline membership or grant joins and no ad-hoc role lists remain.
3. The admin flag is computed in exactly one Worker function from the verified JWT and `ADMIN_EMAILS`; nothing named `admin`, `isAdmin` or `p_admin` is read from a request.
4. Every RPC write that accepts the admin flag writes its audit row with `actor_kind = 'admin'` in the same transaction; no audit row, no write.
5. Admin-only RPCs refuse in SQL without the admin flag and a non-null admin email (defence in depth, CASE-076), not only behind the Worker gate.
6. Every child id an RPC receives (case, version, group, asset, session, member) is bound to the workspace it authorizes; a foreign id is refused, never silently filtered into a write.
7. No membership write leaves a workspace with zero owners. Account hard-deletion of a last owner is allowed, audited as `workspace_ownerless` and alerted; admins keep reach.
8. Groups never appear in any authorization predicate.
9. Role, membership, admin status and account activity are read per request. The client may cache them for display only and treats any 403 as a reason to reload `/me`.
10. Room capabilities are per room, hashed at rest, expire with the room, and are revocable. Minting a console credential (start, re-mint, shared-PC approval) requires an active account and, on the case the room was started from, current membership, a live grant, or admin.
11. Every destructive admin action needs a step-up. One email code opens a window that covers every destructive admin action type for the rest of that sign-in session (Julian, 2026-10-07, R-a): the elevation is bound to the admin's email, the `admin` scope and the session (the JWT `session_id`), is refused for any other email, scope or session, is never replayable across sessions, and ends at sign-out on that device and at the latest when that session's access token expires (≤ 1 h): JWTs are verified locally, so a copied access token plus its elevation keeps the same `sid` until its `exp`. Every issued elevation is recorded, and a SQL write that needs one (withdraw, republish) names it and is refused unless it matches a recorded elevation for that admin and scope. An admin elevation never satisfies an owner scope, and an owner elevation (card 32) never satisfies an admin route.
12. Audit rows are append-only (`forbid_change` trigger), fixed scalars, and never contain participant data, free text or a join code.
13. Workspaces are created only through the admin path.
14. Admin writes are audited identically whichever environment's Worker performs them (staging admins reach production data, accepted risk A2).
15. The matrix in §4, the shared matrix module and the SQL role arrays agree; card 35's generated test fails on any drift.
16. Admins are not marked (Julian, 2026-10-07, R-b): an admin shows by name like anyone else, and the workspace audit is the record of every admin action. A profile-less admin gets the neutral name an invited facilitator gets, `Facilitator`.
17. A person's live-room list (`/me/rooms`) shows the rooms they started while they can still run that room's case (a membership in its workspace or a live grant on the case), or every room for an admin (Julian, 2026-10-07, R-c, widened by CASE-336).

## 7. Edge-case catalogue

Test ids are the card 35 suite (`PM-NN`). Status as in §4.

| # | Scenario | Required behaviour | Enforced at | Status | Test |
|---|---|---|---|---|---|
| E01 | An `ADMIN_EMAILS` entry is upper case or malformed | The whole list is rejected (fail closed, `gate.mjs` L8-12); predeploy refuses the deploy so admins are not silently locked out | W, predeploy | OK | PM-01 |
| E02 | A JWT email differs from a listed admin only by case or a Unicode lookalike | Not admin: both sides must match the ASCII lower-case pattern exactly (`gate.mjs` L5-6, L15-18) | W | OK | PM-02 |
| E03 | An admin is taken off the list while holding a valid JWT and an elevation | The next request is non-admin; the elevation is useless because the gate runs first | W | OK | PM-03 |
| E04 | A user changes their account email to an admin address | Only possible by confirming from the admin inbox; Supabase secure email change must be on (owner evidence) | G | NEW | PM-04 |
| E05 | A client sends `admin`, `isAdmin` or `p_admin` in a body, header or query | Ignored; a non-admin is refused; a Worker sabotage that forwards it fails the test | W | OK | PM-05 |
| E06 | The only admin loses their mailbox or is compromised | Break-glass is a reviewed PR to `ADMIN_EMAILS` plus a production deploy by Julian; one admin stays listed (accepted risk A1) | ops | ACCEPTED | PM-06 |
| E07 | A staging Worker has `ADMIN_EMAILS` set (shared production database) | Admin reach as on production, including production workspaces; every write audited as admin (accepted risk A2) | W, R | ACCEPTED | PM-07 |
| E08 | An admin with no membership creates, saves and publishes a case | Allowed; each write audited `actor_kind = 'admin'`; the admin shows by name (R-b) | W, R | OK | PM-08 |
| E09 | An admin starts a room in a workspace they do not belong to | Allowed; audited; the admin is the room starter | W, R | OK | PM-09 |
| E10 | A facilitator in X lists versions of Y by workspace id | 403 at the Worker and 42501 at the RPC | W, R | OK | PM-10 |
| E11 | A facilitator in X starts a room in X with a version id from Y | Refused: the version is bound to the workspace (`20261002040000_admin_server.sql` L620-650) | R | OK | PM-11 |
| E12 | An author in X saves or publishes a case of Y by case id | 403: the workspace is derived from the case, never supplied | W, R | OK | PM-12 |
| E13 | An author in X publishes with asset ids from Y | Refused: assets must belong to the case's workspace | R | OK | PM-13 |
| E14 | An owner of X assigns a case of X to a group of Y | Refused by the composite foreign key and the RPC | R | OK | PM-14 |
| E15 | An owner of X withdraws a version of Y | Refused: the owner RPC binds the version to the workspace; `admin_set_version_state` stays admin-only | W, R | NEW | PM-15 |
| E16 | A facilitator or author writes a group or the workspace details | Refused | W, R | OK | PM-16 |
| E17 | An author withdraws or republishes | Refused | W, R | NEW | PM-17 |
| E18 | An owner invites, changes a role or removes a member by any route | No route accepts an owner; the SQL admin-only RPCs refuse without the admin flag | W, R | OK | PM-18 |
| E19 | A signed-in non-admin calls `POST /api/v1/workspaces` | 403 at the Worker; the RPC refuses without the admin flag; each check shown alone | W, R | OK | PM-19 |
| E20 | An admin demotes or removes the last owner | Refused with `last_owner` by a trigger, whatever the RPC | R | OK | PM-20 |
| E21 | The last owner's account is hard-deleted (membership cascades) | Deletion proceeds; `workspace_ownerless` is audited and alerted; admins assign a new owner | R, alerts | OK | PM-21 |
| E22 | A member loses membership while running a room | The room and its existing console credentials run to the room's end; re-mint and new shared-PC approvals are refused; the removal dialog lists their live rooms with End (Julian, 2026-10-07) | W, D | OK | PM-22 |
| E23 | A member is disabled while running a room | Owned rooms end and console credentials are revoked (CASE-141) | W, D | OK | PM-23 |
| E24 | An owner is demoted while the Groups screen is open | The next write is 403; the client reloads `/me` and hides owner controls | W, R | OK | PM-24 |
| E25 | One person is owner in X and facilitator in Y, in one console | Every request names its workspace; the role is resolved per pair; Y's library never offers owner actions | W, R | OK | PM-25 |
| E26 | A shared computer takes over and revokes the starter's console | The starter re-mints with their JWT and takes back; both journaled | D | OK | PM-26 |
| E27 | A shared computer should stop now, before the room ends | Room setup lists console credentials (kind and issue time only); the signed-in starter revokes one shared computer; its socket closes, every read and write with it is refused, and it cannot mint again; the starter's own device and other consoles carry on (card 35b, CASE-177). Transitional: a room live when the shared-console tracking build deploys lists consoles minted before it as `unknown`, with no Stop (Take over or End removes them). A display a PC approved before it was stopped keeps working (public projection only) until `revoke displays`; an approval granted just before a stop can still be picked up, minting a new shared credential that can be stopped in turn | W, D | OK | PM-27 |
| E28 | A projector pass is copied to another machine | It shows public projection only; "revoke displays" ends every copy; it dies with the room | D | OK | PM-28 |
| E29 | Join-code guessing at scale | 32^6 codes, per-prefix attempt limits, Turnstile after failed codes, correct codes never challenged | W | OK | PM-29 |
| E30 | An old QR is scanned after its room ended | `room_ended` or `unknown_code`; recovery needs the matching session and code (`room-do.mjs` `recoverParticipant`) | W, D | OK | PM-30 |
| E31 | Two participants pick the same name and avatar | Allowed (CASE-119); the console shows both; the facilitator can rename or remove; never a public identity | D | OK | PM-31 |
| E32 | An admin wants another facilitator's live console | Not in V1: admins end rooms with step-up but do not take over (Julian, 2026-10-07) | D | OK | PM-32 |
| E33 | An author leaves or is hard-deleted; a case is shared, withdrawn or archived | Cases stay in the workspace; `owner_id` and `published_by` go null; any workspace author continues. A case grant (CASE-336) is to the case, not a version: a withdrawn shared case stays listed and cannot be started, a republish brings it back, and archiving a case ends its grants (audited). Removing a member lists their grants in that workspace for removal too; a disabled or revoked grant is inert | R | GAP | PM-33 |
| E34 | An admin who published versions is later taken off the list | Versions and audit remain; no reach remains | W, R | OK | PM-34 |
| E35 | An admin invites someone who is already a member | Invite never lowers a role; a role change goes through P-04 with its step-up | W, R | OK | PM-35 |
| E36 | One person has two accounts (two emails) | Two independent identities; no linking; an admin removes the unwanted one | — | OK | PM-36 |
| E37 | The audit insert fails during an admin write inside a workspace | The whole write rolls back | R | OK | PM-37 |
| E38 | One elevation token is replayed in another session or scope, or by another admin | Refused: elevations are bound to (admin email, scope, sign-in session) and recorded when issued; within its own session one code covers every destructive admin action (R-a) | W, S | OK | PM-38 |
| E39 | An owner withdraws without a fresh code, or with an admin's elevation | Refused | W, S | NEW | PM-39 |
| E40 | A Worker bug calls an admin-only RPC without the flag | SQL refuses | R | OK | PM-40 |

Counts: OK 34, GAP 0, NEW 4, ACCEPTED 2 (40 cases). ACCEPTED marks a risk Julian accepted (§12). Card 35 closed E01, E05, E08, E09, E13, E18 (SQL refusal; no owner member route exists), E19, E20, E21, E22 (Worker recheck at re-mint, shared-PC approval and pickup; card 32's removal dialog offers End), E34, E35, E37, E38 and E40. Card 30 closed E14 (`db/tests/case-groups.test.sql` PM-14) and E16 for groups (`tests/groups.test.mjs` PM-16, `db/tests/case-groups.test.sql` G-5); E16's workspace-details half is card 32's route, which does not exist yet. Card 35b closed E27 (`tests/worker/console-revoke.test.mjs` PM-27, `e2e/console.spec.mjs` AS-109). Open: E04 (owner evidence); E15, E17 and E39 (card 32).

### 7.1 Deployment-scope functions and the expand/contract rollout (card 35)

**Worker places (facilitator-UX A3, CASE-336/337).** `authorize(client, actor, place, action)` in `src/worker/authorize.mjs` reads the person's membership, live case grants and the workspace's policies in one RPC (`get_me`, whose memberships and grants each carry `policies`; a case named without its workspace reads `get_access`, which takes the workspace from the case row). It answers the existing role vocabulary plus `scope` (`workspace` or `case`); the strongest held principal whose cell allows the row wins, a tie keeps the workspace. A workspace place counts the membership only; a case place adds the live grant on that case; `anyCase` (record lists, and the pre-check of a start) adds the strongest grant in the workspace, and `onCase` then decides a start on the version's own case from the same read. `seesEveryRoom` is the `own+pol` reading (admins, and owners under `managers_see_records`). Re-mint and shared-PC approval decide on the case the room was started from (the room DO records it). The route-by-route fates are in private historical reference (not distributed) §8.

Since card 35 (2026-10-07), workspace RPCs authorize through `case_app.authorize`, and `db/tests/permission-matrix.test.sql` calls every one of them as admin, owner, author, facilitator, non-member, removed member and disabled account. The remaining service-callable `case_api` functions are listed there as unbound, each with its reason, and the test fails on any function in neither list. They differ because they authorize no workspace action:
- **Account lifecycle (P-06).** `admin_transition_profile` and `admin_revert_profile` take the admin flag and email in SQL (invariant 5). The deployment audit (`admin_audit_log`, intent and outcome written by the Worker, CASE-141) is their record, because the action is deployment-wide, not inside one workspace.
- **Facilitator Name & role (P-40, P-41; Julian, 2026-10-18).** `PUT /api/v1/me/profile` writes the JWT subject's own Name and Role through `set_own_facilitator_label` (unbound: the Worker passes only the subject), which also confirms them; an account with no workspace, no live case grant and no admin reach is refused (a case-only runner names themselves at first sign-in, CASE-336). The first-sign-in step is this route. `POST /api/v1/admin/facilitators/<id>/label` needs this session's step-up, CAS-checks `admin_revision` (`admin_set_facilitator_label`, admin flag and email in SQL) and writes the `facilitator_label_edit` intent and outcome; an admin correction leaves the account unconfirmed, so the facilitator still sees the step, prefilled. Start room's this-session override travels in the `POST /api/v1/sessions` body under P-21 and never changes the profile; the room's label is written once to `sessions.facilitator_label` by `set_session_facilitator_label` (unbound) for the room just created.
- **Scheduled hard deletion.** `list_admin_due_profiles`, `admin_claim_due_profile_deletion` and `admin_delete_due_profile` run in the Worker's cron with no human actor. The claim needs a matching intent row already in the deployment audit.
- **Audit writers and the rate limiter.** `write_admin_audit` and `claim_admin_stepup_attempt` carry the actor's email themselves.
- **Deployment reads behind the Worker admin gate.** `admin_read_profiles`, `admin_read_case_version`, `list_admin_case_versions`, `list_admin_audit` and `admin_teaching_workspace_exists`.
- **Others.** Own-profile, room-runtime, retention and keepalive functions.

**Expand/contract.** `20261008000000_permissions_core.sql` is the expand step, applied while the previous Workers still run:
- Member RPCs take the admin arguments with fail-closed defaults, so old named-argument calls resolve with non-admin semantics.
- The old admin-only signatures (`admin_provision_facilitator(uuid,uuid)`, `admin_set_version_state(uuid,bigint,text)`, `admin_transition_profile(uuid,bigint,text)`, `admin_revert_profile(…5 args)`) stay unchanged. Only the old Worker's admin routes call them, after its own `ADMIN_EMAILS` gate and step-up.
- The old open `bootstrap_workspace(uuid,text,text)` now refuses.

Card 30 (`20261009000000_case_groups.sql`) is expand-only as well: the 11-argument `list_case_catalogue` the running Workers call (and whose rows they check key by key) stays unchanged beside a 13-argument overload with `p_group_id` and `p_ungrouped` and no defaults, so a named call resolves to exactly one; `get_case_version_for_workspace` and `list_admin_case_versions` keep their arguments and only append columns, which the running Workers ignore. The 11-argument signature is on `EXPAND_WINDOW` until the contract migration drops it.

Card 62 (`20261103000000_asset_review_fence.sql`) was an expand step too. It kept the six-argument `admin_review_asset` unchanged and unfenced beside the eight-argument fenced overload, on `EXPAND_WINDOW`, until every Worker served the fenced call (eaadd02, 2026-10-18). Its contract step, `20261105000000_asset_review_contract.sql`, drops the old signature and empties `EXPAND_WINDOW` again. Rolling a Worker back past eaadd02 after it leaves image approval failing, so fix forward.

The contract migration is `20261010000000_permissions_contract.sql` (card 35b, 2026-10-07). It folds the old bodies into `case_app`, drops the old signatures and card 30's 11-argument `list_case_catalogue`, and drops the retired `publish_draft`, `get_case_version` and 5-argument `create_session`; `EXPAND_WINDOW` in `scripts/gen-permissions.mjs` is empty, so the generated PM-rpc test fails if any of them returns. It is applied only after both Workers serve card 35 (production redeployed to main first); rolling a Worker back past it is unsafe. Until it is applied, a Worker bug could still reach an old admin-only signature without the flag; that window is accepted. Steps: `docs/RUNBOOK-INCIDENT.md` §Card 35 database rollout.

**Workspace deletion.** `workspace_audit` has no foreign key to `workspaces`. Deleting a workspace (no route does today) is never blocked by its audit, and the trail stays archived under the old id. Its writers validate the workspace on insert.

## 8. Red-team findings (ranked)

Severity reflects the ruled model once implemented, not only today's exposure.

| # | Severity | Finding | Evidence | Fix (card 35 unless noted) |
|---|---|---|---|---|
| 1 | High | **Staging is a second door into production.** Staging shares production Supabase and Auth (CASE-159), agents may dispatch staging deploys of any `origin/main` SHA (CASE-160), and production JWTs verify on staging. An admin flag honoured on staging would give deployment-wide reach into production workspaces from a less-guarded environment. | `wrangler.toml` L129-132 (production list), L198-205 (staging uses production Supabase) | **Accepted risk A2** (Julian, 2026-10-07); admin writes audited on every environment (invariant 14) |
| 2 | High | **Authorization exists in four shapes,** so adding the admin path to one leaves the others refusing (or, worse, a future copy allowing). `assert_member`; `get_case_authoring_access` (inline join); `get_catalogue_case` (inline join, *main*); the Worker's `memberPreflight` and route-local role lists. | `db/supabase/migrations/20261001000000_case_init.sql` L380-394; `db/supabase/migrations/20261002010000_published_rooms.sql` L63-72; *main* `20261007000000_case_catalogue.sql` L139-180; `src/worker/published-rooms.mjs` L39-44; `src/worker/facilitator-api.mjs` L151 | One core (invariant 2), one shared matrix module, generated matrix test |
| 3 | High | **One admin, one factor, full reach.** `ADMIN_EMAILS` holds a single address; sign-in and step-up are both email codes to the same inbox; admin identities cannot be disabled in-app. With R8, a compromised mailbox now authors, publishes and runs rooms everywhere, not just the admin surface. | `wrangler.toml` L132; `src/worker/admin/handler.mjs` L43-65; `src/worker/admin/stepup.mjs` L18-24; `docs/HANDOFF.md` §Administrator server | **Accepted risk A1** (Julian, 2026-10-07); predeploy still shows any `ADMIN_EMAILS` change |
| 4 | High (live today) | **Open workspace creation.** Any invited facilitator can create unlimited workspaces and become their owner, with no audit; slugs can be squatted. | `src/worker/facilitator-api.mjs` L125-141; `db/supabase/migrations/20261002000000_phase_1b_rpcs.sql` L17-31 | Admin-only at the Worker and in SQL (moved from card 30) |
| 5 | Medium | **Console capabilities outlive membership.** Re-mint and shared-PC approval check only the room's `owner_user_id`; the owned-rooms list has no membership check. A former member keeps minting consoles for up to 24 h. Ruled 2026-10-07: the room runs to its end, with no new consoles or approvals. | `src/worker/room-do.mjs` L243-261; `src/worker/index.mjs` L297-302; `src/worker/console-pairs.mjs` L121-127; `db/supabase/migrations/20261002020000_console_pair_rooms.sql` L5-28 | Membership-or-admin recheck at every mint (invariant 10); the DO records the room's workspace |
| 6 | Medium (latent) | **Cross-workspace assets in publish.** `publish_draft` checks only that assets are approved, not that they belong to the case's workspace, and the asset ids come from the request body. Once uploads exist, an author can put another workspace's media into their rooms. | `db/supabase/migrations/20261001000000_case_init.sql` L476-493; `src/worker/facilitator-api.mjs` L180-195 | Bind `assets.workspace_id` to the case's workspace (invariant 6) |
| 7 | Medium | **Elevation is unscoped.** The token is `email|expiry`, stateless and reusable for any destructive action for 5 minutes. R9 adds owner step-up; reusing this format would let one code cover several workspaces' actions. | `src/worker/admin/stepup.mjs` L18-41; `src/worker/admin/cases.mjs` L41; `src/worker/admin/room-handler.mjs` L18 | Bind scope and action class; record the token id on use (invariant 11). The email-only factor is accepted risk A1; this binding is hardening, not a new factor |
| 8 | Medium | **Admin reach would be unaudited on today's routes.** The facilitator write RPCs write no audit at all, and the admin audit is written in separate calls (write-then-audit). The design names two audit tables for the same event. | `src/worker/facilitator-api.mjs` L143-204; `db/supabase/migrations/20261002040000_admin_server.sql` L366-449 | In-transaction `workspace_audit` row for every admin write in a workspace (invariant 4); one table for in-workspace events, the admin log for deployment events |
| 9 | Medium | **Admin-only RPCs trust the Worker alone.** `admin_provision_facilitator` and `admin_set_version_state` take no actor at all, contrary to CASE-076's defence in depth. | `db/supabase/migrations/20261002040000_admin_server.sql` L46-66, L539-567 | SQL refusal without the admin flag and admin email (invariant 5) |
| 10 | Low | **`/me` cannot express admin reach.** It returns memberships only, so an admin sees no workspaces; a client that caches roles could show stale controls. | `db/supabase/migrations/20261002010000_published_rooms.sql` L5-41; `src/client/console.mjs` L94 | `/me` adds `admin: true` and every workspace for admins; display-only (invariant 9) |
| 11 | Low | **Fail-closed admin list can lock everyone out silently.** One bad entry nulls the whole set. | `src/worker/admin/gate.mjs` L8-12 | Predeploy validation (E01) |
| 12 | Info | JWTs are not revoked on sign-out (no session check); identity lives until `exp`. Membership, admin and activity are re-read per request, so role changes are immediate. | `src/worker/auth.mjs` L117-150 | Accepted; keep per-request reads (invariant 9) |

Checked and sound: clients never reach Postgres and every `case_api` function is revoked from `anon`/`authenticated` and granted to `service_role` by exact signature (`db/supabase/migrations/20261002000000_phase_1b_rpcs.sql` L188-218); the user id always comes from the verified JWT subject; `create_session` binds the version to the workspace; drafts derive the workspace from the case; deployed environments refuse HS256 and require an issuer (`src/worker/supabase-keys.mjs` L14-15); room credentials are hashed and rechecked on every frame; admin writes require the canonical origin and JSON.

## 9. Best-practice comparison

Vendor rows describe each product's documented capability in general terms; check current vendor documentation before quoting them externally.

| Practice | GitHub orgs/enterprise | Slack | Notion | Google Workspace | Case (ruled) | Case action |
|---|---|---|---|---|---|---|
| Least privilege, stacked roles | Org member/owner; repo read → admin | Member, admin, owner | Member, membership admin, owner | Delegated admin roles | owner ⊇ author ⊇ facilitator per workspace | Matrix test (invariant 15) |
| Separation of duties | Member management separable from content | Admins vs owners | Membership admin separate from content | Delegated roles | Members only by deployment admins; owners curate content | Owners refused on every member route (E18) |
| Platform-admin reach into tenants | Enterprise owners elevate into an org explicitly, and it is logged | Org admins over workspaces | — | Super admin sees all | Full reach without membership (R8) | Audit every admin write, mark admin content (invariants 4, 16) |
| At least two top admins | Recommended | Primary owner plus owners | Several owners possible | Recommended | One admin | Accepted risk A1 |
| Break-glass | Recovery paths for enterprise owners | Support-assisted | Support-assisted | Break-glass super admin accounts recommended | Reviewed PR plus production deploy | Document in `docs/RUNBOOK-INCIDENT.md` (card 35) |
| Admin MFA | Org-wide 2FA requirement | 2FA enforcement | 2-step verification; SAML SSO (Enterprise) | 2-Step Verification enforcement | Email code only | Accepted risk A1 |
| Step-up for sensitive actions | Sudo mode re-authentication | — | — | Re-auth prompts | Email code; one code per sign-in session (R-a) | Bind the elevation to the admin and session (finding 7) |
| Last-owner protection | The last org owner cannot be dropped | Primary owner must transfer | Workspace keeps an owner | — | Ruled | DB trigger (E20) |
| Scoped device capability | Fine-grained tokens with expiry and repo scope | — | — | — | One room, hashed, expiring, revocable | Per-credential revoke of a shared computer (E27, card 35b) |
| Revocation on role change | Access re-checked per request | Deactivation signs out | Removal revokes | Suspension signs out | Per-request reads; room capabilities survive | Recheck at mint (finding 5) |
| Reviewed admin list | Owners listed and audited | Admin list visible | Admin list visible | Admin roles audited | Tracked in `wrangler.toml` | Predeploy diff of `ADMIN_EMAILS` (finding 3) |
| Append-only audit | Audit log | Audit logs (Enterprise) | Audit log (Enterprise) | Admin audit | `forbid_change` trigger; CASE-141 retention | Same trigger on `workspace_audit` |

## 10. Audit

| Event | Who | Table | Scope | Fields |
|---|---|---|---|---|
| Workspace create, preset change | Admin | `admin_audit_log` | Deployment | action, workspace id, preset key and version |
| Member invite, role change, removal | Admin | `admin_audit_log` | Deployment | action, workspace id, user id, before/after role |
| Invite, resend, revoke an invitation; accept it at sign-in | Admin, owner (`managers_invite`), editor sharing (`runners_share`); the invitee for accept | `workspace_audit` (the actor's real kind; `system` for accept). A runner sharing under `runners_share` has no audit kind yet (open ruling); the invitation row records them | Workspace | action, invitation id (the row holds place and level); never the address |
| Case grant (at acceptance), grant revoke, grants ended by archiving | System for a grant created at acceptance; admin or owner for revoke and archive | `workspace_audit` (real kind) | Workspace | action, grant id (the row holds case, grantee and level) |
| Workspace policy set (P-45), image quota set | Admin | `workspace_audit` (`actor_kind = 'admin'`) | Workspace | action, workspace id, policy revision |
| Delete unused images | Admin, with step-up | `workspace_audit` (`actor_kind = 'admin'`, `elevation_id`) | Workspace | action, asset id |
| Candidate approve, release (P-15, P-33) | Admin, owner, or author under `editors_publish` | `workspace_audit` (real kind; CASE-338) | Workspace | action, candidate or version id, revision |
| Any admin write inside a workspace (case, draft, publish, room start, group, settings, withdraw) | Admin | `workspace_audit` (`actor_kind = 'admin'`) | Workspace | action, target id, revision |
| Owner settings, groups, withdraw/republish | Owner | `workspace_audit` (`actor_kind = 'owner'`) | Workspace | action, target id, revision |
| `workspace_ownerless` | System | `workspace_audit` | Workspace | workspace id |
| Step-up start/verify, account lifecycle, room end | Admin | `admin_audit_log` | Deployment | as today (CASE-141) |
| Facilitator Name & role correction (P-41) | Admin | `admin_audit_log` (`facilitator_label_edit`) | Deployment | account id, `admin_revision` before and after; never the words (CASE-075) |

`workspace_audit.actor_kind` records the actor's real kind (steps A2–A3 widen it to `admin`, `owner`, `author`, `facilitator`, `system`; `facilitator` is a runner who shares under `runners_share`, ruling R2), never `admin` for an owner; only an admin row carries an email (CASE-338). Owners still do not read the audit (P-22). Audit is append-only and same-transaction for workspace events. It holds facilitator user ids and, in the admin log, admin and facilitator emails (CASE-141, indefinite); that is personal data about staff, not participants. Rule 8's 24-hour limit covers participant data, which never enters audit (invariant 12). `workspace_audit.actor_user_id` has no foreign key, so it becomes pseudonymous when the account is hard-deleted.

## 11. Rulings on the open questions (Julian, 2026-10-07)

| # | Question | Ruling | Where |
|---|---|---|---|
| 1 | Do owners see their workspace's audit? | No. Audit is admins only. | P-22 |
| 2 | A member running a room is taken off the workspace | The room runs to its end. No new consoles or shared-PC approvals; the removal dialog offers End. | E22, finding 5, card 35 |
| 3 | May an admin take over another person's live console? | No. Admins can end the room (with step-up), never take over. | E32 |
| 4 | Second factor for admin step-up? | No. Admin authentication stays as is. | Accepted risk A1 |

## 12. Accepted risks (Julian, 2026-10-07)

| ID | Risk | Residual risk, plainly | Kept mitigations |
|---|---|---|---|
| A1 | One deployment admin; sign-in and step-up are both email codes to the same inbox (findings 3, 7; E06) | Whoever controls that mailbox controls the whole deployment: every workspace, every publish, every live room, account deletion. Losing the mailbox locks admin out until a reviewed `ADMIN_EMAILS` change is deployed. Step-up proves freshness, not a second factor. | Per-request `ADMIN_EMAILS` check; session-bound, recorded elevation (card 35, R-a); same-transaction admin audit; predeploy diff of `ADMIN_EMAILS`; break-glass runbook |
| A2 | Staging admins have full reach, including production workspaces, through the shared Supabase project (finding 1; E07; CASE-159) | A staging Worker, which agents may deploy from any `origin/main` SHA, can author, publish, withdraw and manage members in production data under an admin's identity. A staging defect in the admin path affects production data. | Same code and gates as production; staging `ADMIN_EMAILS` set only by Julian; every admin write audited as admin (invariant 14) |
| A3 | Facilitator sign-in persists on the device (localStorage refresh token) across tab and browser restarts, on by default, no cap, no opt-out, until an explicit Sign out (card 38) | On a shared hospital PC the next user of the same browser profile inherits the facilitator's session until someone signs out: their workspaces and library, starting rooms, and rejoining the facilitator's running room, which re-mints a console credential and delivers the private case pack (P-24). | Prominent Sign out on every facilitator surface; Sign out in one tab clears every tab and fences late refresh writes under Web Locks; deliberate later sign-in survives queued cleanup (AS-111), while offline server revocation remains best effort; server-side revocation and account disable (CASE-141) end it at the next refresh; the case pack, mirror and console credential stay memory-only (CASE-092, CASE-103); phone approval for shared PCs (Card 11, CASE-166) keeps the account off the PC |
| A4 | Local display privacy confirmation is advisory and never blocks Start case (Julian, 2026-10-07) | A facilitator can start while their private console is mirrored to the room; Case cannot prevent someone projecting the entitled facilitator window. Julian accepts this as visible and correctable. | Optional display advice and topology/pairing reminders remain; a separately rendered projector receives revealed public material only; server authority, private pack isolation and CSP are unchanged |

## Builder drafts qualification (CASE-195)

P14 covers paired draft reads/saves, explicit save-window issue/status, and named checkpoint create/list/delete/restore. SQL and Worker recheck active account and current workspace author/owner or configured admin entitlement on every operation, including receipt replay; admin reach does not require membership. The service-only expiry cleanup has no caller-selected actor authority. Checkpoint admin audit actions are fixed `draft_checkpoint_create`, `draft_checkpoint_delete`, `draft_checkpoint_restore`, with IDs/revision only and no source/content/name payload. P14 also covers the bounded private draft/case-shell inventory. CASE-196 changes first-publication P15 to exact approved-candidate admin release and adds P33 admin review/approval. Neither a source hash nor a draft-level legacy approval grants either action. The legacy first-publish route refuses for all roles; withdrawn immutable-version restoration stays separate.

### Fast-follow read and mutation boundaries

CASE-198 enables existing P04/P05 through service-only elevated/CAS membership changes. Deployment administrators alone inspect the workspace workbench; workspace owners are not admins. P34 permits bounded participant-deidentified pinned session detail and export to the original starter with active current membership, or deployment admin. P32 remains summary authority; personal dashboard statistics always filter the signed-in starter, even for administrators. Every page/export activation rechecks authority; cursor and historical source availability grant none.

## Archiving a draft (P-42, CASE-316)

P-42 is the owner's, or a configured admin's, archive of a Builder case with no published version and no open review submission. The Worker checks the case role it read for P-14 before any write. `case_api.builder_archive_case` re-checks P-42 in SQL before it reads the case (so an unentitled caller cannot tell a missing case from a refused one), confirms the draft's title as the drafts list normalises it (an untitled draft confirms with an empty title), stamps `cases.archived_at` and writes a `case_archive` `workspace_audit` row (owner, or admin with its email). Admins need no step-up, matching P-14 draft saves. Refusals other than authorisation (published, in review, title) are returned as outcomes and named by the Worker as `case_published`, `review_open` and `title_mismatch`. A trigger on `builder_candidates` refuses a submission for an archived case.

## Builder images (card 59 M2, CASE-268)

No new matrix row. Storing a rendition, registering an image, listing images and reading a rendition's bytes are P-14 in two places. The workspace place (`/api/v1/builder/workspaces/<id>/media/<rendition>` and `/assets[/<id>/<rendition>]`, the deployed Builder) checks the membership before it reads a byte, and `case_api.builder_create_asset`, `builder_list_assets` and `builder_asset_rendition` check P-14 again in SQL. The case place (`/api/v1/builder/cases/<id>/media/<rendition>` and `/assets[/<id>/<rendition>]`, step A3) checks P-14 on that case (a membership or a Can edit grant, through `get_access`), takes the workspace and every storage key from the case row, requires the uploader's confirmation (`invalid_details:attested`), and calls `builder_case_media_put_allowance`, `builder_create_case_asset`, `builder_list_case_assets` and `builder_case_asset_rendition`; a case-only editor sees only that case's images (plan §0.5). Image approval is removed (Julian, 2026-11-02, facilitator-UX plan §0.2): P-33 covers candidates only, uploaded images are usable at once, and release, rooms and session records exclude only taken-down images. The Worker's review route was removed 2026-11-02 in step A3; `case_api.admin_review_asset` is admin-only and called by nothing until a later migration drops it. A full workspace is refused with 507 `storage_full` naming `usedBytes` and `quotaBytes` (the one SQL message the Worker reads, `rpc.mjs`). Admin storage (`GET /api/v1/admin/workspaces/<id>/storage`, `admin_workspace_storage`, P-45 admin) and Delete unused (`POST …/storage/delete-unused`, `admin_delete_unused_assets`, the P-16 admin path with this session's step-up) are admin routes. Every asset id is bound to its workspace in each RPC; release already refuses an asset from another workspace or one not approved (finding 6, enforced since card 35). Rooms never use these routes; room delivery is reveal-gated (M3). Withdrawing an image (`/assets/<id>/withdraw`, `case_api.admin_withdraw_asset`, card 59 M4) is the admin path of P-16: a configured admin with this sign-in session's recorded step-up (`X-Admin-Elevation`), audited as `asset_withdraw` with the elevation id; the owner path of P-16 stays with card 32. The hourly sweep's `media_purge_claim`, `media_purge_complete` and `media_known_keys` are system calls with no user authority.

Publication readiness uses P-14, with the same configured admin, workspace owner and author authorization as reading/editing the draft. It provides no approval or publication authority. The single publishing confirmation still uses P-33 approval and P-15 release as separate server operations (candidates only).

CASE-273: pending image de-identification changes use P-14 through `builder_set_asset_attestation` (workspace place only; on a case place the confirmation is part of the upload). Author changes never alter an approved asset.

Card 62 (CASE-285 R1; image approval removed 2026-11-02 by plan §0.2, its Worker route removed 2026-11-02 in step A3, AS-172 retired; kept below as the record): approval was P-33, fenced on what the admin was shown. `/assets/<id>/review` accepts only `{decision:'reject'}` or `{decision:'approve', expected, acknowledged}`, where `expected` is the image's seven shown attestation and rights fields and `acknowledged` lists its open-warning codes. Any other body is a 400; an old client's bare approve never reaches SQL. The eight-argument `case_api.admin_review_asset(…, p_expected jsonb, p_acknowledged text[], …)` works out the open warnings itself (`case_app.asset_open_warnings`). It refuses with 40001, which the Worker returns as 409 `asset_details_changed`, if the stored state differs from `expected`, if the acknowledged codes differ from the open ones, or if the image is no longer pending. It takes the same row lock as `builder_set_asset_attestation`, so an approval and an author's tick change are serialised. The `asset_approve` audit row records the acknowledged codes in `workspace_audit.acknowledged` (an empty list when nothing was open; null on every other action). The fence compares values, not history. An author who unticks and then re-ticks between the admin's look and the click leaves the state the admin saw, so that approval stands. Warnings stay soft: acknowledged, never blocking. The unfenced six-argument signature was kept for the Worker deployed before the fence, then dropped by `20261105000000_asset_review_contract.sql` (§7.1).
CASE-274: `list_case_catalogue_current` and `get_catalogue_case_current` are additive P-11 reads, with the same actor/workspace checks as the legacy catalogue. Both generations remain in the generated permission matrix.

## Own records after case moves — 5 November 2026 (CASE-375)

The original starter retains their own historical records while current canonical-case access remains, including membership in the case’s new home. Other readers remain governed by the session’s original workspace membership and managers-see-records policy. Destination management never confers that old policy. Record, pinned-media and session-feedback admission use one session-bound helper; every fallback is own-only. Sessions discovers historical workspaces through separate paged self-only reads; this is not membership, case access or start authority. Removing current case access removes this fallback, while independently valid original-workspace access retains its existing reach. No session identifier, workspace binding, participant data or retention changes.

Per-session feedback uses this same historical-record boundary. Pooled case feedback retains its existing P-38 case-level authorization; this change does not redefine its scope or collect new information.


## Beta issue boundary — implementation pending release (CASE-376)

P-47 applies to active signed-in accounts regardless of workspace membership, or a current participant capability verified by the room DO. It grants only own reports and public follow-ups; Feedback/browser keys, join codes, projector and shared-computer credentials confer no admission. The Worker derives the principal and scope; it never accepts client authority. P-48 is deployment administration, never workspace ownership. P-49 additionally intersects the current deployment allowlist with a single explicitly configured INCIDENT_ADMIN_EMAILS address, initially Julian alone; unset or ambiguous designation denies all incident reads. No external incident notifications. Ordinary list/search/count/detail/file/brief paths exclude incidents; a known incident ID answers not_found. Reporters can still read their own incident under P-47 while their authority lasts.

Every read/write checks current account/capability authority. The service-only beta_issue_dispatch RPC repeats account state and scope checks; dedicated SQL/Worker/DO tests witness this internal JSON envelope (the extra SQL scope guard is not the workspace-role R core) rather than pretending it is a workspace role. Private R2 keys are returned only inside Worker/RPC traffic. Search/filter/cursor data use a bounded POST body, never personal data in URLs. Evidence expiry is checked at read time and joins the participant purge. Contact is a separate unchecked choice. Triage is revisioned and original evidence is immutable except retention deletion. Deployment configuration and all release steps remain separately authorised.
