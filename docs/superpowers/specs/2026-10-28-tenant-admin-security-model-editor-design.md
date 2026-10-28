# Tenant Admin: consolidated Security model editor (TA-9) — Design

Date: 2026-10-28. Spec TA-9 (B1-5a) of the tenant-admin reconciliation program (`docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`, §2 and §4 item 9). Precedence as the note records: separation spec > brief > prototype (`dev-kit/design/admin-apps/src/tenant2.jsx` `SecurityModel` :131). **The prototype is a design fiction over demo JSON; this spec re-implements its layout/behaviour against the REAL `SecurityModelDto` and the existing shared draft, never inventing a backend.** Governing principle carried from TA-4..TA-8.

## Intent and why

Today the PP security model is edited through two separate top-bar screens — B1-3 **Roles & Privileges** (`roles-privileges-view*.ts`) and B1-4 **Field Security** (`field-security-view*.ts`) — each with its own view-model that builds its **own** `SecurityModelDraft` from its own `GetSecurityModel` load and persists its own `ToDto()` via `SetSecurityModel`. Because `SetSecurityModel` replaces the whole model, editing roles on one screen and fields on the other and saving them independently makes the second save silently drop the first screen's section (each draft round-trips the *other* section as it was at its own load time). This is exactly the silent-drop risk §2 and B1-3 call out.

TA-9 consolidates the two screens into ONE editor on ONE `SecurityModelViewModel` owning ONE `SecurityModelDraft`: a role list, per-role sub-tabs, one sticky save bar, one dirty flag, one `Save`. The design's single "Roles & permissions" surface (tenant2.jsx) is that editor. It lives under **Users & Access > Roles & permissions** (TA-8 embeds the old `RolesPrivilegesView` there now; TA-9 replaces it).

## The reality this is built on (no backend, no DTO changes)

- **One draft, already shared.** `SecurityModelDraft` (`security-model-draft.ts`) already owns BOTH sections of `SecurityModelDto`: roles/privileges (`Roles`, `LevelFor`, `SetLevel`, `CycleLevel`, `AddRole`, `DeleteRole`, `Concepts`, `AddConcept`, `SelectedRoleId`) AND field security (`Profiles`, `SecuredFields`, `FieldGrant`, `SetFieldGrant`, `AddProfile`, `DeleteProfile`, `AddSecuredField`, `RemoveSecuredField`, `SelectedProfileId`), with ONE `Dirty` flag and a deep-clone `ToDto()` that round-trips every untouched section (`businessUnits`, `teams`, `membership`, `ownershipRules`, `roleAssignment`). TA-9 reuses it unchanged.
- **Row projections reused:** `PrivilegeRow` (concept row over the selected role) and `FieldGrantRow` (secured-field row over the selected profile) wrap the draft and are reused unchanged.
- **Reads/writes:** `ISecurityModelSource.GetSecurityModel(env)` / `SetSecurityModel(env, dto)` (via `client`) — already used by both B1 VMs.
- **Per environment.** The model is stored per environment; the editor keeps the environment picker (tenant-wide/apply-to-all is a later decision, as §2 records).
- **Model shape (real, not the prototype's booleans):** privileges are 8 actions (create/read/update/delete/append/appendTo/assign/share) x 5 `AccessLevel`s (none/user/businessUnit/businessUnitAndChildren/organization) per concept per role — the built matrix is a superset of the prototype's four booleans and is kept. Field rules are **profiles** (`read`/`update`/`create` per secured field), which are **separate objects from roles** assigned via `fieldSecurity.profileAssignment` — the editor keeps profiles first-class (§2), it does NOT fake them as per-role.

## Goals

- **`SecurityModelViewModel`** (extends `Observable`) — ONE view-model merging the two B1 VMs over ONE draft:
  - Environment picker (`Environments`, `SelectedEnvironment`, `SelectEnvironment`), load with generation/stale-guard, states `Loading / Empty / Ready / Error / NoEnvironment / Forbidden`.
  - Role side: `Roles`, `SelectedRoleId`, `SelectRole`, `AddRole`, `DeleteRole`, `AddConcept`, privilege `Rows` (`PrivilegeRow[]`).
  - Field side: `Profiles`, `SelectedProfileId`, `SelectProfile`, `AddProfile`, `DeleteProfile`, `AddSecuredField`, `RemoveSecuredField`, field `Rows` (`FieldGrantRow[]`).
  - ONE `Dirty` + `RefreshDirty` (cells edit the draft directly through the row classes), ONE `Save` (single `ToDto()` -> single `SetSecurityModel`, then rebase onto the saved dto so Dirty clears, preserving both selections), ONE `Revert` (reload). 401 rethrows to login; 403 -> `Forbidden`.
- **`SecurityModelView`** (extends `TenantViewBase`) — the consolidated editor:
  - Environment picker + a role list (select / Add role / Delete role).
  - kit `Tabs` with the two real sub-tabs: **What they can do** (the concept x action privilege matrix for the selected role, each cell cycling the access levels in place, reusing `PrivilegeRow`; a legend; Add concept) and **Fields** (a profile selector with Add/Delete profile + the secured-field x permission grid for the selected profile, reusing `FieldGrantRow`; Add/Remove secured field) — profiles kept first-class.
  - A **plain-language sentence** per privilege concept row summarising the selected role's access honestly from the per-action levels (e.g. "Can read across the organization; create and update within the business unit.").
  - ONE sticky **save bar**: "N unsaved changes" / "No unsaved changes", Discard (Revert), Save security model — disabled when not dirty or busy.
  - States via kit `ScreenHost`: loading / empty ("No roles yet. Add a role to start.") / **denied** (Forbidden -> permission-denied naming "the Manage users & access permission") / error. 401 -> login (`ShowError`).
- **Wiring + retirement:** `UsersAccessPageView`'s Roles & permissions tab embeds `SecurityModelView`. The two legacy screens are retired: delete `roles-privileges-view*.ts`, `field-security-view*.ts` and their tests; remove `ShowRolesPrivileges` and `ShowFieldSecurity` from `ITenantNavigator`, `tenant-app.ts`, the test fakes, and the `tenant-app.test` direct-call assertions (now that the area is replaced — the TA-8 R2 deferral ends here).
- **Tests:** the VM (one draft shared across role+field edits; one Save persists both sections together; a role edit + a field edit then one Save round-trips BOTH — the silent-drop regression test; Dirty/Revert; stale-guard; Forbidden/401); the view (role list, both sub-tabs, cell cycling, plain-language sentence, save bar dirty count, Discard, Save, states, 401->login); the page embed + the navigator-method removal.

## Non-goals (deferred — later specs, not faked here)

- **Administration sub-tab + self-lockout confirm — deferred (and currently without referent).** The prototype's "Administration" toggles (Manage environments / Adopt / Manage users & access / Manage tenant settings) and its self-lockout ("none of your roles will include Manage users & access") operate on the prototype's per-role `admin` booleans. The REAL admin capability model is `AdminCapabilitiesDto` (TA-3), which is **not** part of `SecurityModelDto` and is **not** changed by saving the security model — so editing PP roles can never lock the signed-in admin out of the admin UI. The self-lockout confirm therefore has no referent in TA-9; it is deferred to a future tenant-admin-RBAC surface (§0.4), not dropped as a real safety behaviour.
- **Record sharing sub-tab — deferred to TA-10.** It is a plain-language view derived from access levels + `ownershipRules` + the business-unit/team org structure, none of which TA-9 edits.
- **People sub-tab — deferred to TA-11.** It is the assignment half (`roleAssignment` / `fieldSecurity.profileAssignment`).
- **Concept / secured-field catalog** (free-text today) — the GAP already filed from B1-3/B1-4; no catalog op exists.
- **Tenant-wide / apply-to-all-environments** — the model is per environment; the picker stays (§2).

## Anti-goals

- Do **not** add or change a server route, DTO, protocol method, or the `todl-identity` package. TA-9 is portal-only over `GetSecurityModel`/`SetSecurityModel`.
- Do **not** split the draft or keep two save paths — ONE draft, ONE `ToDto()`, ONE `SetSecurityModel`. Re-introducing a second draft re-opens the silent-drop.
- Do **not** fake Administration, Record sharing, or People tabs, nor a self-lockout with no referent. An honest two-tab editor beats fabricated toggles.
- Do **not** reduce the privilege model to the prototype's four booleans, nor present field profiles as per-role data. Keep the 8-action x level matrix and profiles first-class (§2).
- Do **not** flip existing EOL: `tenant-app.ts` and `tenant-app.test.ts` are CRLF; `tenant-types.ts`, `kit/*`, all view/VM/row files, and new files are LF; new files LF. New `.ts` is pure ASCII (escape any level glyph / em dash / middot / ellipsis as `\uXXXX`, never a raw byte — the retired `roles-privileges-view.ts` used raw circle glyphs; the new view must escape them).

## Decisions made (rulings the builder inherits)

- **R1 — One VM, one draft, one save.** `SecurityModelViewModel` owns a single `SecurityModelDraft` loaded once per environment; both the role and field sub-tabs edit that one draft; `Save` emits one `ToDto()` to one `SetSecurityModel`. This is the whole point — it closes the cross-section silent-drop. Cost if wrong: none over the two-screen status quo; this strictly removes a data-loss path.
- **R2 — Two real sub-tabs only.** "What they can do" and "Fields" are built. Record sharing (TA-10), People (TA-11) and Administration (RBAC, §0.4) are not rendered — not even as placeholders — because each needs data/surfaces TA-9 does not touch. Cost if wrong: additive; each lands as a new sub-tab on this same editor when its slice arrives.
- **R3 — Self-lockout is N/A here, deferred with rationale.** Saving the PP security model does not change the admin's own `AdminCapabilitiesDto`, so there is no self-lockout to guard; the confirm returns with the Administration/RBAC surface. Not a dropped safety behaviour — a mis-mapped one in the prototype.
- **R4 — Profiles stay first-class.** The Fields tab presents the real profile objects (a profile selector + secured-field grid), not a per-role field view. §2 mandate.
- **R5 — Plain-language sentence, honest.** A composed helper summarises the selected role's per-action access levels into one sentence per concept row. An "advanced" fold for append/appendTo/assign/share is a presentation nicety: include it if it does not bloat the view, else leave the four columns visible and defer the fold to TA-16.
- **R6 — Retire the legacy screens.** Delete the two views + VMs + their tests; remove `ShowRolesPrivileges`/`ShowFieldSecurity` from the navigator interface, shell, fakes and `tenant-app.test`. Reuse `SecurityModelDraft`, `PrivilegeRow`, `FieldGrantRow` unchanged. The TA-8 R2 deferral (keep the methods) ends now that the area is replaced.
- **R7 — States and gating.** The editor keeps the B1 `Forbidden` -> permission-denied state (403), surfaces 401 to login, and sits inside `UsersAccessPageView`'s existing whole-page `access` gate. Save/Discard disabled when not dirty or busy.

## What's left to the builder

Idiomatic Mural composition within these decisions: the consolidated view layout (role list + `Tabs` + save bar), the two matrices (lifted from the retired views, cells reused via the row classes), the plain-language sentence helper, and the test doubles (reuse/extend `fake-tenant-control-plane.ts`, which already serves the security model). Follow workspace conventions (OOP, Allman braces, PascalCase public members, enums over string unions, VMs extend `Observable`, no inline string literals, `Disposable` not lambdas) and the patterns in the retired `roles-privileges-view*.ts` / `field-security-view*.ts` (for the matrices) and the TA-8 `users-access-page-view.ts` / kit.

## Review focus (inputs the editor implies but a happy path misses)

- **Role edit + field edit then one Save** -> BOTH sections persist in a single `SetSecurityModel`; neither is dropped. This is the silent-drop regression the consolidation exists to kill — assert it directly.
- **Save then re-edit** -> Dirty clears on save (draft rebased onto the saved dto), both the selected role and selected profile survive the rebase.
- **403 on load or save** -> the permission-denied state (naming the permission), not a raw error or a half-rendered editor; **401** -> login.
- **Switch environment with unsaved changes** -> defined behaviour (reload discards the draft); the dirty state and both selections reset to the new environment's model.
- **Empty model** (no roles / no profiles) -> the empty state with a working Add role / Add profile, not a blank grid.
- **Stale load** (env switched or reloaded mid-flight) -> the newer load wins; an older response is discarded (generation guard, as both B1 VMs do).
- **Delete the selected role / profile** -> selection falls back to the first remaining; the matrix follows; Dirty set.
