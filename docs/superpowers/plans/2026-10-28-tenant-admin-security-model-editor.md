# Tenant Admin: consolidated Security model editor (TA-9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two PP-security screens (B1-3 Roles & Privileges, B1-4 Field Security) into ONE editor on ONE `SecurityModelViewModel` owning ONE `SecurityModelDraft` with ONE sticky save bar, closing the cross-section silent-drop; embed it in the Users & Access > Roles & permissions tab and retire the legacy screens.

**Architecture:** A new `SecurityModelViewModel` (Observable) owns a single `SecurityModelDraft` (reused unchanged — it already holds both roles and field-security) and exposes both the role/privilege and field-profile surfaces, one `Dirty`, one `Save` (single `ToDto()` -> single `SetSecurityModel`). A new `SecurityModelView` renders a role list + kit `Tabs` [What they can do, Fields] + a sticky save bar + `ScreenHost` states, reusing `PrivilegeRow`/`FieldGrantRow`. The two legacy views/VMs are deleted and the `ShowRolesPrivileges`/`ShowFieldSecurity` navigator methods removed. No server/DTO/protocol change.

**Tech Stack:** TypeScript, Mural, Observable view-models (`@pragmatic-tech-ai/todl-runtime`), node:test + the existing `fake-tenant-control-plane.ts`.

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-security-model-editor-design.md`

## Global Constraints

- **Portal-only.** No change to any server route, DTO, `AdminProtocol`, or the `todl-identity` package. Build on `GetSecurityModel`/`SetSecurityModel` and the existing `SecurityModelDraft`/`PrivilegeRow`/`FieldGrantRow` as they are (do not modify the draft or row classes unless a reused method is genuinely missing — if so, note it).
- **One draft, one save.** The whole point: a single `SecurityModelDraft`, a single `ToDto()`, a single `SetSecurityModel`. Never two drafts or two save paths.
- **Deferred, never faked:** no Administration sub-tab, no self-lockout confirm (no referent — saving the PP model does not change the admin's own `AdminCapabilitiesDto`), no Record sharing tab (TA-10), no People tab (TA-11), no concept/field catalog, no tenant-wide/apply-to-all. The per-environment picker stays.
- **Model fidelity:** keep the 8-action x 5-level privilege matrix (not the prototype's four booleans) and keep field **profiles first-class** (a profile selector + secured-field grid), not a per-role field view.
- **401 drops to login** (`ShowError` / VM rethrow); **403 -> Forbidden** permission-denied state naming "the Manage users & access permission". Never swallow a 401.
- **EOL:** `tenant-app.ts` and `tenant-app.test.ts` are **CRLF**; `tenant-types.ts`, all `kit/*`, all view/VM/row files and new files are **LF**. Byte-scan every new/edited file; never flip an existing file's EOL.
- **ASCII only** in `.ts`: escape level glyphs / em dash / middot / ellipsis as `\uXXXX` (e.g. the circle level glyphs the retired view used raw must be `○`/`◔`/`◑`/`◕`/`●`). Byte-scan every new file (nonascii 0, CR 0 for LF files).
- **Conventions:** OOP (no free functions/module state), Allman braces, PascalCase public members and interfaces, enums over string unions, VMs extend `Observable`, no inline string literals (hoist to `private static readonly`), `Disposable` not lambdas, tests under `tests/`.
- **Verify green:** `npm test` + `npm run typecheck` in `admin/tenant-portal` clean before each task's commit.

## Review Focus

- **Role edit + field edit then one Save** -> both sections persist in a single `SetSecurityModel`; neither dropped. (Task 1 VM test — the silent-drop regression.)
- **Save rebase** -> Dirty clears on save; selected role AND selected profile both survive the rebase. (Task 1 test.)
- **403 on load/save -> Forbidden; 401 -> login.** (Task 1 VM + Task 2 view tests.)
- **Environment switch with unsaved changes** -> reload discards the draft; dirty + both selections reset to the new env's model. (Task 1 test.)
- **Empty model** (no roles / no profiles) -> empty state with working Add role / Add profile, not a blank grid. (Task 2 test.)
- **Stale load** (env switched/reloaded mid-flight) -> newer load wins, older discarded. (Task 1 test.)
- **Delete selected role/profile** -> selection falls back to first remaining; matrix follows; Dirty set. (Task 1 test.)

---

### Task 1: `SecurityModelViewModel` (one VM over one draft)

**Files:**
- Create: `admin/tenant-portal/src/security-model-view-model.ts` (LF)
- Test: `admin/tenant-portal/tests/security-model-view-model.test.ts` (LF)

**Interfaces:**
- Consumes: `SecurityModelDraft`, `PrivilegeRow`, `FieldGrantRow`, `ISecurityModelSource` + `ListEnvironments` (reuse the existing `IRolesPrivilegesSource` from `roles-privileges-view-model.ts` — but that file is deleted in Task 3; so DECLARE a local `ISecurityModelEnvSource extends ISecurityModelSource { ListEnvironments(): Promise<EnvironmentDto[]> }` in this new file and export it, and have Task 3 point everything at it). `TenantApiError` (`UnauthorizedStatus`, `ForbiddenStatus`).
- Produces: `class SecurityModelViewModel extends Observable` with ctor `(source: ISecurityModelEnvSource)`. Public surface (merge of the two B1 VMs over ONE draft):
  - Env: `Environments`, `SelectedEnvironment`, `SelectEnvironment(name)`, `LoadEnvironments()`, `LoadModel()`.
  - Role: `Roles`, `SelectedRoleId`, `SelectRole(id)`, `AddRole(name)`, `DeleteRole(id)`, `AddConcept(name)`, `PrivilegeRows: readonly PrivilegeRow[]`.
  - Field: `Profiles`, `SelectedProfileId`, `SelectProfile(id)`, `AddProfile(name)`, `DeleteProfile(id)`, `AddSecuredField(concept, field)`, `RemoveSecuredField(concept, field)`, `FieldRows: readonly FieldGrantRow[]`.
  - Shared: `Dirty`, `RefreshDirty()`, `Busy`, `Error`, `State` (enum `SecurityModelState { Loading, Empty, Ready, Error, NoEnvironment, Forbidden }`), `Save()`, `Revert()`. Property-name constants as `public static readonly` (as the B1 VMs do).

- [ ] **Step 1: Write failing tests** in `security-model-view-model.test.ts` (reuse the fake source serving `GetSecurityModel`/`SetSecurityModel`/`ListEnvironments`):
  - `loads one draft and exposes both role and field surfaces` — Roles + Profiles populated from one model; State Ready.
  - `one Save persists BOTH a role edit and a field edit together` — set a privilege level on a role AND a field grant on a profile, then `Save()`; assert the single captured `SetSecurityModel` dto contains BOTH changes (the silent-drop regression — a two-draft design would drop one).
  - `Save rebases: Dirty clears and both selections survive` — after Save, `Dirty === false`, `SelectedRoleId` and `SelectedProfileId` unchanged.
  - `Revert reloads and clears Dirty`.
  - `SelectEnvironment discards the draft and resets dirty+selections` to the new env's model.
  - `stale load is discarded` — a newer `SelectEnvironment`/reload wins over an in-flight older one.
  - `DeleteRole / DeleteProfile fall back to the first remaining and set Dirty`.
  - `403 on load -> Forbidden; 403 on save -> Forbidden; 401 rethrows` (assert it throws for login routing).
- [ ] **Step 2: Run tests, verify they fail** (VM not defined).
- [ ] **Step 3: Implement `SecurityModelViewModel`** by merging the two B1 VMs (`roles-privileges-view-model.ts` + `field-security-view-model.ts`) over ONE `SecurityModelDraft`: one `draft` field, one `loadToken`/stale-guard, one `busyCount`, one `dirty`, one `Refresh()` that rebuilds Roles+PrivilegeRows+Profiles+FieldRows+selections+Dirty+State, one `Save` (`draft.ToDto()` -> `SetSecurityModel` -> rebase `SecurityModelDraft.From(dto)` restoring both `SelectedRoleId` and `SelectedProfileId`), one `Revert`. 401 rethrow, 403 -> Forbidden. State Empty when BOTH roles and profiles are empty (else Ready). Allman; literals hoisted; ASCII; LF.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Byte-scan** both files (nonascii 0, CR 0).
- [ ] **Step 6: Commit** (`feat(tenant-portal): SecurityModelViewModel unifies roles + field security on one draft`).

### Task 2: `SecurityModelView` (consolidated editor)

**Files:**
- Create: `admin/tenant-portal/src/security-model-view.ts` (LF)
- Test: `admin/tenant-portal/tests/security-model-view.test.ts` (LF)

**Interfaces:**
- Consumes: `SecurityModelViewModel` + `SecurityModelState` + `ISecurityModelEnvSource` (Task 1); `PrivilegeRow`, `FieldGrantRow`; `AccessLevel`, `Actions`, `LevelCycle`, `PrivilegeAction`, `FieldPermission`, `FieldPermissions` from `security-model-draft.js`; kit `Tabs`, `ScreenHost`, `Section`. `TenantViewBase`.
- Produces: `class SecurityModelView extends TenantViewBase` ctor `(source: ISecurityModelEnvSource)`. Test seams: `get Tabs(): Tabs`, `get Vm(): SecurityModelViewModel` (or targeted seams `RoleListHost`, `PrivilegeHost`, `FieldHost`, `SaveBar`, `DeniedHost`), and a `SentenceFor(row: PrivilegeRow): string` (the plain-language helper, as a `public static`/method so it is unit-testable). `Refresh()` loads environments; `Dispose()`.

- [ ] **Step 1: Write failing tests** in `security-model-view.test.ts` (initialise the Pragmatic theme as the TA-8 view tests do, since `ScreenHost`/pills resolve theme brushes):
  - `renders a role list and two sub-tabs (What they can do / Fields)` — tab labels in order.
  - `the privilege matrix cycles a cell level in place` — press a cell, assert the draft level advanced one step and Dirty set.
  - `SentenceFor summarises the selected role's access in plain words` — a role with read@organization + update@businessUnit yields a sentence naming both honestly; a role with no access yields the "can't see" phrasing.
  - `the Fields tab shows a profile selector and the secured-field grid` — profiles listed; toggling a grant updates the draft + Dirty.
  - `the save bar shows the unsaved-change state and Save persists` — after an edit, bar reads unsaved; Save calls the source once; Discard reverts.
  - `empty model -> empty state with Add role` ; `403 -> denied state naming the permission` ; `401 -> login` (navigator `ShowLogin`).
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement `SecurityModelView`** lifting the two matrices from the retired `roles-privileges-view.ts` (concept x action grid; cells cycle `AccessLevel` via `PrivilegeRow.Cycle`; a legend; Add concept; Add/Delete role; role picker) and `field-security-view.ts` (profile picker; secured-field x `FieldPermission` grid via `FieldGrantRow`; Add/Remove secured field; Add/Delete profile), hosted in a kit `Tabs` [What they can do, Fields] under a role list, with ONE sticky save bar (dirty count text, Discard->Revert, Save->Save, both disabled when `!Dirty || Busy`) and kit `ScreenHost` states (loading / empty / denied[Forbidden] / error). Level glyphs escaped `○◔◑◕●`. The plain-language `SentenceFor` iterates `Actions` reading `row.LevelFor(action)` and composes an honest sentence (hoist every fragment/connector to `private static readonly`). An "advanced" fold for append/appendTo/assign/share is optional (R5): include only if it does not bloat the view; else leave all 8 columns. 401 via `ShowError`->login. Allman; literals hoisted; ASCII; LF.
- [ ] **Step 4: Run full portal suite, verify pass.**
- [ ] **Step 5: Byte-scan** both files (nonascii 0, CR 0).
- [ ] **Step 6: Commit** (`feat(tenant-portal): SecurityModelView consolidated roles + fields editor`).

### Task 3: Wire into the page and retire the legacy screens

**Files:**
- Modify: `admin/tenant-portal/src/users-access-page-view.ts` (LF) — embed `SecurityModelView` as the Roles & permissions tab instead of `RolesPrivilegesView` (swap the `roles` field type, its construction, the `Roles` getter return type, and the `ViewAt` union). Its ctor source type currently includes `IRolesPrivilegesSource` (imported from the deleted `roles-privileges-view-model.js`) — change that import+intersection to `ISecurityModelEnvSource` from `security-model-view-model.js` (the `client` satisfies it: it already serves `GetSecurityModel`/`SetSecurityModel`/`ListEnvironments`).
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF) — remove the `ShowRolesPrivileges` and `ShowFieldSecurity` methods and the `RolesPrivilegesView`/`FieldSecurityView` imports.
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF) — remove `ShowRolesPrivileges()` and `ShowFieldSecurity()` from `ITenantNavigator`.
- Delete (`git rm`): `admin/tenant-portal/src/roles-privileges-view.ts`, `roles-privileges-view-model.ts`, `field-security-view.ts`, `field-security-view-model.ts`; and the tests `admin/tenant-portal/tests/roles-privileges-view.test.ts`, `roles-privileges-view-model.test.ts`, `field-security-view.test.ts`, `field-security-view-model.test.ts`. KEEP `security-model-draft.ts` (+ its test), `privilege-row.ts`, `field-grant-row.ts` (all reused by Tasks 1-2).
- Modify (remove the two now-dead no-op fake methods `ShowRolesPrivileges`/`ShowFieldSecurity`, KEEP `ShowServiceTokens`): the fake navigators in `admin/tenant-portal/tests/environments-view.test.ts`, `overview-view.test.ts`, `releases-view.test.ts`, `service-tokens-view.test.ts`, `tenant-tree-view.test.ts`, `users-access-view.test.ts`, `users-access-page-view.test.ts`, `tenant-app.test.ts`.
- Modify: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF) — remove the `RolesPrivilegesView`/`FieldSecurityView` imports and the `app.ShowRolesPrivileges()/ShowFieldSecurity()` assertion block (lines ~443-446); KEEP the `app.ShowServiceTokens()` assertion; add/keep an assertion that the Users & Access section still shows `UsersAccessPageView` and that its Roles tab is a `SecurityModelView`.

**Interfaces:**
- Consumes: `SecurityModelView` (Task 2).

- [ ] **Step 1: Update tests first** — point the `users-access-page-view.test.ts` Roles-tab assertion at `SecurityModelView`; remove the two retired-method fake declarations across the 8 test files; remove the retired-view imports + assertion block from `tenant-app.test.ts`. Run the suite; expect failures only where the retired views are still imported by `src` (Task 3 fixes those next).
- [ ] **Step 2: Retire + wire** — `git rm` the 4 source files + 4 test files; swap `UsersAccessPageView` to construct/host `SecurityModelView`; remove the two methods from `ITenantNavigator` and `tenant-app.ts` (preserve CRLF). Confirm no remaining `src` reference to the deleted files/methods (`grep`), and that the `access` whole-page gate + lazy-load still wrap the tab.
- [ ] **Step 3: Run full portal suite + typecheck, verify pass** (no dangling imports; the consolidated editor shows under Roles & permissions).
- [ ] **Step 4: Byte-scan** touched files — `tenant-app.ts` + `tenant-app.test.ts` stay CRLF (CR==LF), the rest LF (CR 0), all nonascii 0.
- [ ] **Step 5: Confirm retirement** — `grep -rn "RolesPrivilegesView\|FieldSecurityView\|ShowRolesPrivileges\|ShowFieldSecurity\|roles-privileges-view\|field-security-view" admin/tenant-portal/src admin/tenant-portal/tests` returns nothing.
- [ ] **Step 6: Commit** (`feat(tenant-portal): embed consolidated Security model editor; retire Roles & Field Security screens`).
