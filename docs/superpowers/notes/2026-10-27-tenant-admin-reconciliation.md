# Tenant Admin: design vs built reconciliation and spec backlog

Date: 2026-10-27. Planning artifact only; no product code. Precedence: the separation spec (2026-10-25) wins over the brief; the brief wins over the prototype on vocabulary; the prototype (`dev-kit/design/admin-apps/src/tenant.jsx`, `tenant2.jsx`, `shared.jsx`, `tenant-data.js`) is the truth for behaviour, copy and states.

Paths: DESIGN = `C:\Users\Eugene\Projects\architecture-agent\dev-kit\design\admin-apps\src\`; BUILT = `...\pragmatic-server\admin\tenant-portal\src\`; API = `...\pragmatic-server\admin\control-plane\tenant-api\tenant-api-endpoint.ts`; CLIENT = BUILT `tenant-api-client.ts`.

## 0. Structural findings (cut across every screen)

1. **Shell and IA differ from the design.** BUILT `tenant-app.ts` is a top bar (title, a session label, four ad-hoc buttons: Users & Access, Service Tokens, Roles & Privileges, Field Security, plus Logout) over a two-pane body: `tenant-tree-view.ts` (hive > environment tree) and a swappable detail pane. The design (`TenantApp`, tenant.jsx:478) is a left primary nav with six items (Overview, Environments, Users & Access, Releases, Settings, Connection status), badges (degraded/verify-failed count on Environments, offer count on Releases), a fixed identity plate (organisation / tenant / hive), global search, a user menu showing the admin's role, an Operations drawer and a persistent "hive quiet" banner. None of that chrome exists. Replacing the shell is the first enabler: every screen hangs off it.
2. **Environment-scoped vs tenant-wide.** B1 views (users, tokens, roles, field security) each carry their own environment picker (ruling R1/R6 in the four 2026-10-27 B1 specs) because the identity surface is per environment (`/tenant-api/environments/:name/admin/*`). The design presents one tenant-wide Users & Access. B1-1 already committed a later "full-tenant aggregation" slice; it is still outstanding.
3. **No shared component layer for design primitives.** Missing as reusable Mural classes: status Pill (icon + text, never colour alone), Banner (info/warning/danger with action), ConfirmDialog with name-to-confirm and consequences list, OnceSecret ("shown once" + "I have stored it" gate), SecretTable (by-reference rows), Activity list, KV/Section, Tabs, Steps/Progress, Toasts, Operations drawer, a Screen state host (loading skeleton / empty / error / permission-denied), and `Act` (visible-but-denied action naming the needed permission). BUILT uses raw `StackPanel`/`TextBlock`/`Button` via `tenant-view-base.ts` (`MakeButton`, one inline `message` line). Destructive confirmation exists only as inline two-step buttons (stop, disable, revoke).
4. **The admin's own permission model is absent.** The design gates every action with `canDo(t, role, perm)` (tctx.jsx) over `ADMIN_PERMS` (Manage environments, Adopt versions, Manage users & access, Manage tenant settings), showing denied actions with "needs the X permission, ask Y". BUILT has `SessionDto { tenantId, principalId, email? }` only; the roles/field views map a 403 to a `Forbidden` state, nothing more.
5. **Vocabulary leak.** `TenantApp.Boot` sets the top-bar label to `session.email ?? session.tenantId`, i.e. a raw backend tenantId (which is really an environment id per the platform-admin tenant semantics). Brief §2 forbids surfacing it as "tenant".
6. **Test baseline.** BUILT has VM and view unit tests for every view plus `tenant-portal.spec.ts` (playwright) and `tests/fake-tenant-control-plane.ts`; new work extends those.

## 1. Per-screen reconciliation (brief §5.3)

Legend: BUILT / PARTIAL / MISSING. Server route status is detailed in section 3.

### 1.1 Overview (home)
- Design (`Overview`, tenant.jsx:14): header "Overview" + primary "Create environment"; info Banner when a stable offer exists and environments are behind ("Capability Maps X is available... Nothing changes until you choose to adopt.", action "Review and adopt"); environment cards (name, status pill, health pill, verify-failed pill, app + version, `<envId>.<baseDomain>`); Recent activity (5); "Connection to Pragmatic" card (status pill, last check-in, "reports in every 5 minutes. Pragmatic can't connect into your hive."); "Updated by Pragmatic" list ("automatic, no action needed"). States: empty ("No environments yet... Create your first environment"), loading skeleton, error, denied ("an account in this tenant").
- Built: **MISSING.** Nearest is `DetailPlaceholderView` ("Select a hive or environment") in `tenant-app.ts`; `ShowTree` is the landing.
- Delta: new Overview view + VM aggregating `ListEnvironments`, `GetHealth`, `ListManifests`/`GetRollout`; environment card component; offer Banner; activity, connection and component cards need new read routes (section 3). Quick-create reuses the Environments create dialog.

### 1.2 Environments list
- Design (`Environments`, tenant.jsx:100; `CreateEnv`, :66): comfortable DataTable (search "Filter environments", selectable) with Environment (name + id + template), Status pill, Application (app + version; "X was not served (verification failed)"), Health pill, Live URL (link when running with a bundle; else "Stopped" / "Not serving" / "No UI bundle yet"). Bulk Start/Restart/Stop only, "Deleting is one environment at a time." Create dialog: Name (`^[a-z][a-z0-9-]{2,30}$` + duplicate check; "Lowercase letters, digits and hyphens."), Type (Production / Staging / Sandbox with descriptions), version (versions the hive may run), Size, address preview; then an async operation (Namespace and storage reserved / Image pulled and signature verified / Database created and migrated / Services started and healthy) and toast "X is running. Deploy the UI bundle to serve the app."
- Built: **PARTIAL.** `tenant-tree-view.ts` / `tenant-tree-view-model.ts` list environments under hives with live updates over the events socket (created/changed/deleted/health). No table, search, sort or bulk; no live-URL column (`EnvironmentDto.httpUrl`/`wsUrl` are host-port URLs, not `<environmentId>.<baseDomain>/app/<tenant>/<app>/`); no version/health columns; no create UI. CLIENT has **no `CreateEnvironment`** although POST exists in the API.
- Delta: DataTable (search/sort/density/selection) in Mural; Create dialog (name validation, template/type per server enums `Template`/`EnvType`; size and version are design-only, see section 3); bulk start/stop/restart over the existing action routes; async create progress from events plus an operations store; live-URL derivation needs baseDomain and app slug from the server.

### 1.3 Environment detail
- Design (`EnvDetail`, tenant.jsx:144): header with name, status + health pills, sub (app, version, template, id), copyable live URL + "Open app"; actions Start / Stop / Restart / Delete (ConfirmDialog with typed name and consequences: URL stops for N users; DB and files deleted; Production warning). Tabs: Application & version (Deployed now KV: version, adopted, image signature Verified, UI bundle, bundle deployed; Deploy/Redeploy UI bundle; "Newer version offered" panel with notes and "Review and adopt"; or "newest version" note; fail-closed danger Banner "Version X was not served... kept serving Y; your users weren't affected... quote reference ADP-xxxx"); Health & activity (24 h strip, events, "View logs" drawer, "Right now" KV: status, health, pods ready, active users, degraded callout); Access (Address KV; Sign-in as by-reference SecretTable `oidc-client/<id>` with Rotate). Provisioning Banner.
- Built: **PARTIAL.** `environment-detail-view.ts` / `-view-model.ts`: name, status dot, running version, type, Start / Stop (inline "Confirm stop") / Restart, one health line (ready / not ready + detail), live log tail with Pause/Resume. Tested.
- Delta: header + tabs; Delete with name-to-confirm (needs a route); Application & version tab (bundle and adoption metadata, Deploy/Redeploy route, per-environment offer lookup, fail-closed Banner fed from rollout/health detail); Health tab (24 h history and event feed need server data; move logs into a drawer); Access tab (address; OIDC client credential by reference; Rotate has no route); provisioning banner; pills; copy-URL and open-app.

### 1.4 Adopt a version
- Design (`Adopt`, tenant.jsx:242): 5-step wizard (Version, Environments, Review, Roll out, Outcome). Step 1 radio offers (version, channel, published, notes, Early-access warning). Step 2 environment checklist with safe defaults (non-Production pre-selected; environments already on the version disabled; stopped environments "adopt now, start on next start"). Step 3 review (downtime "None expected", data migrations, the six roll steps, trust callout about failing closed). Step 4 per-environment progress with the six steps (Pull image; Verify signature against trust root; Run data migrations; Roll pods; Health check; Switch traffic). Step 5 outcomes per environment: Adopted / Verification failed (not served, keeps serving X, support reference) / Gated out upstream (Banner "on hold for your organisation... reappears when the hold lifts"). Permission "Adopt versions".
- Built: **PARTIAL (different shape).** `hive-detail-view.ts` / `-view-model.ts`: a hive-wide version list with badges (Current / Previous / Available / Withdrawn), "Set target" / "Roll back", an inline confirm strip with impact text, and `FailedRoll` ("stayed on X"). This is hive-level target selection (`POST /tenant-api/hives/:id/target`), not a per-environment multi-select wizard; no progress steps, channel, notes, migrations, gated-out outcome or support reference.
- Delta: wizard UI; per-environment choice needs either a server per-environment target op or an agreed mapping onto the hive target (a decision for the spec); progress can start from `GetRollout`/`GetHealth` plus `environment-changed` events (coarse), fine-grained step names need server status; the three outcomes need distinct secret-free result codes (the API already returns the generic "Requested version is not available for this hive" for a gated target).

### 1.5 Users & Access (including the Security model editor)
- Design (`Users`, tenant2.jsx:54), three tabs:
  - **Users**: table (name + "You" tag, email or "Service account", role chips, status pill, last sign-in); row actions Roles / Issue token / Disable-Enable; Create account dialog (name, work email, role checkboxes with descriptions; "The person receives an email to set up sign-in"); Roles dialog with self-lockout ConfirmDialog ("Remove your own owner role?"); Disable ConfirmDialog ("signed out everywhere... records and history stay... tokens stop working"); empty "No other users yet".
  - **Roles & permissions** (`SecurityModel`, :131): role list (people counts, dirty dot); per-role sub-tabs "What they can do" (CRUD checkbox grid with a plain-words sentence per row), "Fields" (per-object Hidden/Read/Edit with effect copy), "Record sharing" (radio: own / team / all in tenant), "Administration" (four toggles with help), "People (n)"; sticky save bar ("N unsaved changes", Discard, Save security model); self-lockout confirm; Tenant owner locked.
  - **Tokens**: SecretTable of issued tokens (by reference, Revoke); Issue-token dialog (Acts as / Roles / Expires / Scope) then OnceSecret ("shown once", copy, "stored it" gate); empty "No tokens issued".
- Built:
  - `users-access-view.ts` / `-view-model.ts` / `account-row.ts` (B1-1): **PARTIAL.** Environment picker, accounts and grants lists, create account (email + principalId + password), disable with confirm (self-disable guarded, `PendingKind.DisableSelf`), grant/revoke (self-revoke guarded, `RevokeSelf`), Loading/Empty/NoEnvironment states. Roles here are identity grant roles (`TenantRole`: Owner, Admin, Editor, Viewer, Maker) with resource scoping, not the design's named business roles.
  - `service-tokens-view.ts` / `-view-model.ts` / `service-token-row.ts` (B1-2): **BUILT for function** (list, issue with free-text scopes and expiry presets, revoke with confirm, one-time reveal with dismiss). Visual treatment differs.
  - `roles-privileges-view.ts` / `-view-model.ts` / `privilege-row.ts` + `security-model-draft.ts` (B1-3): **PARTIAL.** 8-action x AccessLevel matrix over `roles[].privileges[]`, add/delete role, add concept, dirty/Save/Revert, Forbidden.
  - `field-security-view.ts` / `-view-model.ts` / `field-grant-row.ts` (B1-4): **PARTIAL.** Profile x secured-field read/update/create checkbox matrix, add/delete profile, add/remove secured field.
- Delta (Users): tenant-wide aggregation; invitation-style create (email, role checkboxes) instead of password entry; Enable action; last sign-in; role chips; "You" tag; plain-language disable copy; user-centric Roles dialog bound to whichever assignment mechanism section 2 selects. (Tokens): move into the Tokens tab with SecretTable/OnceSecret; pre-issue summary. (Security): section 2. (Frame): one Users & Access page with Users / Roles & permissions / Tokens tabs replacing the three top-bar buttons.

### 1.6 Releases (adoptable versions)
- Design (`Releases`, tenant.jsx:372): offer cards (version, channel pill, published, notes, "N environments not on this version", migrations, "Adopt..." button; Early access secondary) plus "Which environment runs what" matrix (Running / Refused / dash). Empty "No new versions offered... arrive when your hive checks in". Permission "Adopt versions".
- Built: **PARTIAL.** `ListManifests` (`ManifestDto { id, image, notes?, publishedAt, withdrawn? }`) feeds the version list inside `hive-detail-view.ts`; no channel, no environment-by-version matrix, no entry to a wizard.
- Delta: Releases page (cards + matrix) from `ListManifests` + `ListEnvironments` + per-environment `runningImage` (`GetRollout`); channel and migrations are server gaps. The design assumes a withdrawn version keeps running until another is adopted (flagged "to confirm" in the rationale); the built hive view already models it (withdrawn-but-running keeps the Current badge).

### 1.7 Settings
- Design (`TSettings`, tenant.jsx:408): tabs Tenant profile (display name, tenant, organisation, owner, support contact, time zone; Edit gated on "Manage tenant settings"), Identity provider (issuer, session lifetime, MFA, federation; Credentials SecretTable `idp/signing-ca`, `idp/admin-token`, `idp/smtp-relay` with Rotate/Revoke, references only), Hive & domain (hive, cluster, namespace, region, base domain, address pattern; read-only).
- Built: **MISSING.** Nearest assets: `HiveDto` (`displayName`, `cluster { backend, mode }`, `registry { mode, endpoint? }`) feeding the tree; the PUT `admin/config` route (packId, delegationDepth, groupRoleMap, claimsMapping, securityModel) is exposed server-side and has no client method or view.
- Delta: Settings page with three tabs. Hive & domain is nearly UI-only once `HiveDto` carries baseDomain/region/namespace. Tenant profile and IdP settings need new read/update routes; IdP credentials by reference need a safe reference listing plus Rotate/Revoke (values never returned).

### 1.8 Connection status
- Design (`Connection`, tenant.jsx:443): Home-channel hero (Connected/Quiet pill, "Last check-in X ago, next expected within 5 minutes"), outbound-only diagram (Your hive, outbound HTTPS, Pragmatic), copy that Pragmatic never connects in, last-12 check-ins strip, "Pragmatic components in your hive" list (agent, Tenant Admin, IdP versions with updated-at, "automatic"). Global quiet Banner when check-ins lapse ("Your environments keep running normally...").
- Built: **MISSING.** No UI, no route.
- Delta: read-only page; needs a local agent-status source in the hive (last check-in, history, component versions, last platform-applied upgrade). The separation spec leaves the agent/tenant-admin process boundary to the builder, so the spec must settle what the tenant-admin process can read locally.

## 2. Security-model reconciliation

Design: ONE "Roles & permissions" surface per role with sub-tabs CRUD permissions, Fields, Record sharing, Administration, People. Built: two separate top-bar screens (B1-3 Roles & Privileges, B1-4 Field Security) over one shared `security-model-draft.ts` (`SecurityModelDraft`: deep-clones the whole `SecurityModelDto`, round-trips every section it does not edit; both matrices are DataGrid-template-column grids).

Model fit (important): the real PP model is richer than the prototype's JSON.
- Prototype "What they can do" = four booleans per object. Real = 8 actions (create, read, update, delete, append, appendTo, assign, share) x 5 AccessLevels. The built matrix is a superset; do NOT replace it with four booleans. Take from the design the plain-words sentence per row and an "advanced" fold for append/appendTo/assign/share.
- Prototype "Record sharing" (own / team / all) is a per-role scope toggle. In the real model record scope is the AccessLevel itself (User / Business unit / BU and children / Organization) per concept per action, plus the `share` and `assign` privileges, `ownershipRules[]` and the org structure that makes "team" and "business unit" meaningful. So "Record sharing" is not new data: it is a plain-language view over levels + ownership + org structure.
- Prototype "Fields" = Hidden/Read/Edit per field per role. Real = field profiles with read/update/create per secured field, assigned to principals via `fieldSecurity.profileAssignment`. Profiles are separate objects from roles; the design hides that by treating field rules as per-role. The editor must keep profiles first-class (or present them as "field access sets" attached to roles through assignment).
- Prototype "People" = users holding the role. Real = `roleAssignment` (claimsMapping rules, per-principal overrides, `teamRoles`) + `membership` (claims mapping and overrides to BU/teams). This is the ASSIGNMENT half.

Done: roles x privilege levels (B1-3); field profiles x secured fields (B1-4). Remaining, all inside `SecurityModelDto`:

| Remaining | Model section | Backend? | Home |
|---|---|---|---|
| Org structure: business-unit tree (parent) and teams (owning BU) | `businessUnits`, `teams` | No (PUT whole model) | extend draft |
| Membership: claim-to-BU/teams rules, per-principal overrides | `membership` | No | extend draft |
| Ownership rules: concept -> owning BU source / owner source | `ownershipRules` | No | extend draft (already feeds `Concepts`) |
| Role assignment: claim rules, per-principal overrides, team-role grants | `roleAssignment` | No | extend draft |
| Field-profile assignment: claim rules, overrides, team-profile grants | `fieldSecurity.profileAssignment` | No | extend draft |
| Record-sharing view: plain-language scope per role derived from levels, ownership, share/assign | derived | No | UI over draft |
| One consolidated editor: role list + sub-tabs + one sticky save bar + self-lockout confirm | all | No | merge the two screens, one VM |
| Concept and field catalog (free text today) | n/a | Yes, op missing | deferred Feature (filed from B1-3/B1-4) |
| Administration toggles (envs / adopt / access / settings) | not in PP model | Yes | tenant-admin RBAC (section 0.4), kept separate from PP roles |

Answer: **yes, extend the same `security-model-draft.ts`.** Every remaining piece is a section of the `SecurityModelDto` that `PUT admin/security-model` replaces wholesale, so a single draft (one dirty flag, one Save, one round-trip-integrity test) is the safe owner; splitting reintroduces the silent-drop risk B1-3 calls out. Since the file is already 367 lines, compose section helpers (roles, fields, org, assignment) under the draft facade and add one `SecurityModelViewModel` (Observable) shared by the consolidated editor. The model is stored per environment, so the editor keeps the environment picker until tenant-wide aggregation or an "apply to all environments" operation is decided.

Safety behaviours to carry over from the design: Tenant owner role locked; any save that removes the signed-in admin's own access triggers the self-lockout ConfirmDialog ("only another tenant owner can restore your access"); changed cells visibly marked and counted; Discard/Save in a sticky bar; permission-denied state without "Manage users & access".

## 3. Backend gaps (per screen)

Existing tenant-api routes (API file): GET hives, environments, manifests, hives/:id/rollout, hives/:id/health; POST environments (create), hives/:id/target, environments/:name/(start|stop|restart); per-environment admin: GET snapshot/config/tokens/security-model, POST accounts/grants/tokens, DELETE accounts/:principal, grants, tokens, PUT security-model, config; POST maker-token, app-reader-grant; WS events and logs stream. Session routes in `tenant-auth/`.

| Screen | Needed operation | Status |
|---|---|---|
| Shell / all | "My permissions" for the signed-in admin (envs / adopt / access / settings) | GAP |
| Shell / all | Tenant display name, organisation, hive identity for the plate (session has tenantId only) | GAP |
| Overview | Recent activity / audit feed | GAP |
| Overview, Connection | Home-channel status (last check-in, history), component versions, last platform upgrade | GAP |
| Overview, Releases | Offer metadata: channel, notes, migrations, early-access | PARTIAL (`ManifestDto`: notes?, publishedAt, withdrawn?; no channel/migrations) |
| Environments | Create | EXISTS (`POST environments`: name, template, type); CLIENT lacks the method; size and version choice not in route (GAP) |
| Environments | Live URL, app name/slug, base domain, bundle state, health in list DTO | PARTIAL (`EnvironmentDto` has hostPort/httpUrl only) |
| Environment detail | Delete (name-to-confirm) | GAP (`EnvironmentService.Delete` exists, no tenant route) |
| Environment detail | Deploy / Redeploy UI bundle | GAP (`ui-deploy-actuator.ts` exists on the platform side, no tenant route) |
| Environment detail | Verification-failed reason + support reference; image signature status | GAP (rollout DTO has `ready`/`obsolete`/`runningImage` only) |
| Environment detail | 24 h health history, event history, pod counts, active users | GAP (health is current-state; events socket carries no history) |
| Environment detail | OIDC client credential reference + Rotate | GAP (maker-token/app-reader-grant have different semantics) |
| Adopt | Per-environment adopt, progress steps, outcome codes (adopted / verify-failed / gated-out) | GAP (only hive-wide `POST target`; gated returns a generic 4xx) |
| Users | Invitation-style create (no password) | GAP (route needs email + principalId + password) |
| Users | Enable account, last sign-in, named roles per account | GAP |
| Users | Tenant-wide identity | GAP (per-environment only; client fan-out or aggregate route) |
| Tokens | List / issue / revoke | EXISTS |
| Security model | Read / write whole model | EXISTS; concept/field catalog GAP (deferred Feature) |
| Settings | Tenant profile read / edit | GAP |
| Settings | IdP issuer/session/MFA/federation view, credential references, Rotate/Revoke | PARTIAL (`admin/config` covers pack, delegation depth, group-role map, claims mapping) |
| Settings | Hive and domain (base domain, region, cluster, namespace) | PARTIAL (`HiveDto` lacks baseDomain/region/namespace) |
| Cross-cutting | Durable operations list | GAP (client-side store fed by events is feasible for v1) |

Trust-boundary rules for every new route: session-tenant-scoped (404 not 403 on foreign resources, as the endpoint documents), fixed generic error bodies, no secret material. Connection, component and offer data must come from the in-hive agent, never from the tenant-admin container calling Pragmatic.

## 4. Proposed spec backlog (ordered, smallest shippable first)

All specs: merge-local, never push; Mural stack (Observable view-models, Allman braces, no inline literals, PascalCase public API); every list/detail covers loading / empty / error / permission-denied; secrets by reference only (once-shown exceptions only for issued tokens); name-to-confirm for irreversible actions; new server routes keep session-scoped 404 semantics and generic errors. UI = no server work; BE = needs backend.

1. **TA-1 Design-system components** (UI). Mural classes for Pill, Banner, Section/KV, Tabs, Toast, Screen-state host, ConfirmDialog with name-to-confirm and consequences, OnceSecret, SecretTable, Activity list, Steps/Progress. Screens: all.
2. **TA-2 Shell and IA** (UI). Six-item left nav, identity plate (org / tenant / hive, no switcher, no raw tenantId), user menu, route model, quiet-hive banner slot, drawer host; replaces the top-bar buttons and tree-first layout. Screens: all.
3. **TA-3 Session profile and admin permissions** (BE+UI). Tenant/hive identity for the plate, "my permissions", and the `Act`-style denied affordance. Screens: all, esp. Users & Access, Settings.
4. **TA-4 Environments list and create** (UI; size/version options BE later). Table with search/sort/bulk start-stop-restart, Create dialog, `CreateEnvironment` client method, async progress from the events socket. Screens: Environments.
5. **TA-5 Environment detail redesign and Delete** (small BE + UI). Header and tabs, logs in a drawer, copyable URL, provisioning banner, Delete with name-to-confirm over a new `DELETE environments/:name`. Screens: Environment detail.
6. **TA-6 Releases and Adopt wizard** (BE+UI). Offer cards, environment-by-version matrix, 5-step wizard, three outcomes, fail-closed Banner on Environment detail; decide per-environment vs hive-wide adopt and extend manifest/rollout DTOs (channel, migrations, verify-failed reason). Screens: Releases, Adopt, Environment detail.
7. **TA-7 Overview home** (UI over TA-4/6; activity and connection cards degrade gracefully until TA-12/14). Environment cards, offer Banner, empty state, quick-create. Screens: Overview.
8. **TA-8 Users & Access page: accounts and tokens** (UI + small BE). Users / Roles & permissions / Tokens tabs; invitation-style create, Enable, role chips, "You" tag, self-lockout dialogs; move B1-2 into the Tokens tab with OnceSecret/SecretTable; tenant-wide view via fan-out or aggregate route. Screens: Users & Access.
9. **TA-9 Consolidated Security model editor (B1-5a)** (UI). Merge Roles & Privileges and Field Security into one editor on the shared draft: role list, sub-tabs, one VM, one sticky save bar, self-lockout confirm, plain-language rows, composed section helpers. Screens: Users & Access > Roles & permissions.
10. **TA-10 Org structure, ownership, membership (B1-5b)** (UI). Business-unit tree, teams, membership rules and overrides, ownership rules on the same draft with round-trip tests. Screens: Users & Access > Record sharing.
11. **TA-11 Role and field-profile assignment, People tab (B1-5c)** (UI). `roleAssignment` and `fieldSecurity.profileAssignment` editors, People sub-tab, derived plain-language Record sharing view. Screens: Users & Access.
12. **TA-12 Connection status and "Updated by Pragmatic"** (BE+UI). In-hive agent status source, Connection page, quiet-hive banner, Overview cards. Screens: Connection status, Overview.
13. **TA-13 Settings** (BE+UI). Hive & domain (extend `HiveDto`, read-only) first, then Tenant profile and Identity provider with credential references and Rotate/Revoke, never values. Screens: Settings.
14. **TA-14 Activity feed and Operations drawer** (BE+UI). Tenant-scoped activity read model for Overview and Environment detail; durable operations list for create / adopt / bundle deploy. Screens: Overview, Environment detail, cross-cutting.
15. **TA-15 Environment application operations** (BE+UI). Deploy/Redeploy UI bundle, health history and events, OIDC client credential reference + Rotate. Screens: Environment detail (all tabs).
16. **TA-16 States matrix, accessibility, e2e hardening** (UI). Forced-state harness for every list/detail, keyboard/focus/reduced-motion pass, playwright coverage of the new shell. Screens: all.

Ordering rationale: 1-3 are enablers; 4-7 close the environment/adopt loop (brief §5.4 flows 1, 2, 4); 8-11 finish identity and the security model on the shared draft (work already in flight); 12-15 depend on new server surfaces and their BE halves can start in parallel once TA-2 lands; 16 closes the brief §7 acceptance checklist.

## 5. Screens covered by the prototype PNGs

`dev-kit/design/admin-apps/docs/screens/` tenant-*.png: overview-light and overview-dark (Overview populated, both themes), envdetail-dark (Environment detail), adopt-verify (fail-closed outcome), adopt-gated (gated-out outcome), model (Security model editor), matrix (CRUD permissions grid), selfwarn (self-lockout confirmation), token-dark (issue token / once-shown secret), limited (limited-role, permission-denied affordances). No PNG covers Settings, Connection status, Releases, Environments list, Users list, Create environment, or empty/loading/error states; those are defined only by the prototype's `StatesMatrix` (tenant.jsx:505) and `Screen`/`EmptyState`/`DeniedState` in `shared.jsx`.
