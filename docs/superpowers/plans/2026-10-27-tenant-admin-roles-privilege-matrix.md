# Tenant-Admin Roles & Privileges Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visual security-role privilege matrix in the tenant portal — pick a security-model role, edit each concept's access level per privilege action in a `DataGrid`, and save the whole model back — reusing existing REST routes.

**Architecture:** UI-only in `admin/tenant-portal` (the GET/PUT `security-model` routes already exist). A pure `SecurityModelDraft` owns the loaded `SecurityModelDto`, derives the concept set, applies per-cell edits to `roles[].privileges[]`, and emits the full model to PUT (every other section preserved). An `Observable` VM drives an imperative Mural view whose matrix uses the Mural `DataGridTemplateColumn` (first app use) with cycling `AccessLevel` cells.

**Tech Stack:** TypeScript, `@pragmatic-tech-ai/mural` (TS) `DataGrid`/`DataGridTemplateColumn`/`DataTemplate`, `@pragmatic-tech-ai/todl-runtime` `Observable`, `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-roles-privilege-matrix-design.md`

## Global Constraints

- **No server changes.** Use only `GET`/`PUT /tenant-api/environments/:name/admin/security-model` (R1).
- **Round-trip integrity (R3, load-bearing):** load→edit→save preserves every section the matrix does not edit (`businessUnits`, `teams`, `membership`, `ownershipRules`, `roleAssignment`, `fieldSecurity`) byte-for-byte; only `roles[].privileges[]` of the edited role changes.
- **Portal copies wire shapes (R4):** the full nested `SecurityModelDto` tree is declared in `tenant-types.ts`; never import `pragmatic-protocol` types in the portal.
- **8 privilege actions, fixed order:** `create, read, update, delete, append, appendTo, assign, share`. **5 access levels, cycle order:** `none → user → businessUnit → businessUnitAndChildren → organization → none`. Wire values are the exact lowercase strings from `todl-identity` (`PrivilegeAction`/`AccessLevel`).
- **House style:** OOP, Allman braces, PascalCase public members/interfaces, no inline string literals (hoist to `private static readonly`), enums over string unions, VMs extend `Observable`, teardown via `Dispose()` not lambdas. `.mu` not used.
- **EOL:** new files LF. Modified files match pre-existing endings — `tenant-api-client.ts` is **CRLF** (and its test); `tenant-types.ts` and `tests/fake-tenant-control-plane.ts` are **LF**; `tenant-app.ts` is **CRLF** (and its test). Verify after every edit with `tr -cd '\r' < f | wc -c` vs `wc -l`; restore with perl. (The subagent Edit tool silently flips EOL — bit B1-1/B1-2 repeatedly.)
- **Gates:** `npm --prefix admin/tenant-portal test` and `npm --prefix admin/tenant-portal run typecheck`; `npm run typecheck:tools` at repo root. No mural rebuild (DataGrid already in `dist`). Never run `npm install` at repo root (breaks workspace symlinks).
- **Secrets:** none in this slice; the security model is configuration.
- **Branch off `master`; merge-local at finish; NEVER push.** Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Dropped model section on save** — editing a role must not wipe `fieldSecurity`/`roleAssignment`/BUs. → pinned by Task 2's round-trip test and Task 3's save test.
- **`roles` absent/empty** — a model with no `roles` (optional field) must render an empty matrix with a working Add-role, not crash. → Task 2 (`AddRole` into an empty/absent list) + Task 3 (empty-state) tests.
- **Cycle wrap** — advancing past `organization` returns to `none`; an unknown/garbage stored level reads as `none` and cycles forward from there. → Task 2 cycle tests.
- **Concept appearing only in ownership/field-security, not in any privilege** — still gets a matrix row (all `none` for the selected role). → Task 2 concept-derivation test.
- **Stale/overlapping env or role switch** — a slow `LoadModel` resolving after the operator switched env/role does not overwrite newer state. → Task 3 load-token test (mirror B1-2).

---

### Task 1: DTOs, client methods, and fake routes

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF)
- Modify: `admin/tenant-portal/src/tenant-api-client.ts` (CRLF)
- Modify: `admin/tenant-portal/tests/fake-tenant-control-plane.ts` (LF)
- Test: `admin/tenant-portal/tests/tenant-api-client.test.ts` (CRLF)

**Interfaces:**
- Produces: the full nested `SecurityModelDto` (and all nested DTOs: `BusinessUnitDto`, `TeamDto`, `MembershipClaimRuleDto`, `MembershipOverrideDto`, `MembershipDto`, `OwnershipSourceDto`, `OwnershipRuleDto`, `PrivilegeDto`, `RoleConfigDto`, `RoleClaimRuleDto`, `RoleOverrideDto`, `TeamRoleGrantDto`, `RoleAssignmentDto`, `SecuredFieldDto`, `FieldGrantDto`, `FieldProfileDto`, `FieldProfileClaimRuleDto`, `FieldProfileOverrideDto`, `FieldProfileTeamGrantDto`, `FieldProfileAssignmentDto`, `FieldSecurityDto`) copied verbatim from `node_modules/@pragmatic-tech-ai/pragmatic-protocol/dist/dto/wire-dtos.d.ts`; `ISecurityModelSource { GetSecurityModel(env): Promise<SecurityModelDto | null>; SetSecurityModel(env, model: SecurityModelDto): Promise<void> }`; `ITenantNavigator.ShowRolesPrivileges(): void`.
- Consumes: `TenantApiClient.Send<T>`, `EnvRoute(env)` (existing).

- [ ] **Step 1:** In `tenant-types.ts`, add the nested `SecurityModelDto` tree verbatim (field names/optionality exactly as in `wire-dtos.d.ts` lines 202–311) and `ISecurityModelSource`. Add `ShowRolesPrivileges(): void` to `ITenantNavigator`.
- [ ] **Step 2:** In `tenant-api-client.ts`, add `private static readonly AdminSecurityModelLeaf = '/admin/security-model'` and, if absent, `private static readonly MethodPut = 'PUT'`. Add to the `implements` clause `, ISecurityModelSource`. Implement `GetSecurityModel(env)` = `Send<SecurityModelDto | null>(this.EnvRoute(env) + AdminSecurityModelLeaf, undefined)` and `SetSecurityModel(env, model)` = `Send<unknown>(…, { method: MethodPut, body: JSON.stringify({ securityModel: model }) })`. (Mirror the `ListTokens`/`RevokeToken` shape exactly.)
- [ ] **Step 3:** Write failing client tests: `GetSecurityModel` issues `GET …/admin/security-model` and returns the parsed body (and returns `null` when the body is `null`); `SetSecurityModel` issues `PUT` with body `{ securityModel: <model> }`.
- [ ] **Step 4:** In `fake-tenant-control-plane.ts`, add `GET`/`PUT` handlers for the `security-model` leaf under an owned env: GET returns a stored seed model (seed one with ≥1 role, ≥1 privilege, a `fieldSecurity` block, and an `ownershipRules` entry so later concept-derivation and round-trip tests have material); PUT reads `{ securityModel }`, stores it, returns `200`. Match the existing route-dispatch style in the fake.
- [ ] **Step 5:** Run `npm --prefix admin/tenant-portal test` (client tests pass) and `typecheck`. Verify EOL on all three modified files. Commit.

---

### Task 2: `SecurityModelDraft` (state, concept derivation, round-trip)

**Files:**
- Create: `admin/tenant-portal/src/security-model-draft.ts` (LF)
- Test: `admin/tenant-portal/tests/security-model-draft.test.ts` (LF)

**Interfaces:**
- Consumes: `SecurityModelDto`, `PrivilegeDto`, `RoleConfigDto` (Task 1); `PrivilegeAction`/`AccessLevel` **as local enums/const tuples declared here** (do not import `todl-identity` into the portal — declare `enum PrivilegeAction`/`enum AccessLevel` mirroring the wire strings, plus the ordered action list `Actions` and the ordered level cycle `LevelCycle`).
- Produces: `class SecurityModelDraft` with `static From(model: SecurityModelDto | null): SecurityModelDraft` (null/absent → an empty model with `roles: []`); `get Roles(): readonly RoleConfigDto[]`; `SelectedRoleId: string | undefined`; `get Concepts(): readonly string[]` (sorted dedup union per R2); `LevelFor(concept: string, action: PrivilegeAction): AccessLevel`; `SetLevel(concept, action, level): void`; `CycleLevel(concept, action): AccessLevel` (returns the new level); `AddRole(name: string): string` (returns new id); `DeleteRole(id: string): void`; `AddConcept(name: string): void`; `get Dirty(): boolean`; `ToDto(): SecurityModelDto` (deep copy of the original with only the edited role's `privileges[]` rebuilt). Role id generator: `role-<lowercased-name-slug>-<n>` deduped against existing ids.

- [ ] **Step 1:** Write failing tests:
  - `From(null)` yields empty `Roles`, empty `Concepts`, `Dirty === false`.
  - concept derivation = sorted union of `roles[].privileges[].concept` ∪ `ownershipRules[].concept` ∪ `fieldSecurity.securedFields[].concept`, deduped (include a concept that appears only in `ownershipRules`).
  - `LevelFor` returns the stored level; an absent (concept,action) privilege and an unrecognized stored level both read as `AccessLevel.None`.
  - `CycleLevel` advances `none→user→…→organization→none` and sets `Dirty`.
  - `AddRole` on an absent/empty `roles` creates a selectable role with empty privileges; `AddConcept` adds a row at `none` for every action; `DeleteRole` removes it.
  - **Round-trip:** `From(full)`, cycle one cell of one role, `ToDto()` → every section except the edited role's `privileges` deep-equals the input; the edited role's privileges reflect the change; no other role changed.
- [ ] **Step 2:** Run tests to verify they fail.
- [ ] **Step 3:** Implement `SecurityModelDraft` and the local `PrivilegeAction`/`AccessLevel` enums + `Actions`/`LevelCycle` tuples. Model edits as a `Map<roleId, Map<concept, Map<action, level>>>` overlay or by mutating a deep-cloned model — choose one; `ToDto` must deep-copy so the original is never mutated and untouched sections are preserved. Levels not in `LevelCycle` normalize to `None` on read.
- [ ] **Step 4:** Run tests to verify they pass.
- [ ] **Step 5:** `typecheck`; verify LF; commit.

---

### Task 3: `RolesPrivilegesViewModel` + `PrivilegeRow`

**Files:**
- Create: `admin/tenant-portal/src/privilege-row.ts` (LF)
- Create: `admin/tenant-portal/src/roles-privileges-view-model.ts` (LF)
- Test: `admin/tenant-portal/tests/roles-privileges-view-model.test.ts` (LF)

**Interfaces:**
- Consumes: `SecurityModelDraft`, `PrivilegeAction`/`AccessLevel`/`Actions` (Task 2); `ISecurityModelSource` (Task 1); `Observable` + `IEnvironmentListSource`/env-list idiom (reuse whatever `ServiceTokensViewModel` uses for the env picker).
- Produces: `class PrivilegeRow` — plain row object: `get Concept(): string`; `LevelFor(action): AccessLevel`; `Cycle(action): AccessLevel` (delegates to the draft, returns new level). Built per (role, concept). `class RolesPrivilegesViewModel extends Observable` with `static readonly` property keys and methods `LoadEnvironments()`, `SelectEnvironment(name)`, `LoadModel()`, `SelectRole(id)`, `AddRole(name)`, `DeleteRole(id)`, `AddConcept(name)`, `Save()`, `Revert()`; exposes `Environments`, `SelectedEnvironment`, `Roles`, `SelectedRoleId`, `Rows: PrivilegeRow[]`, `Busy`, `Error`, `State`, `Dirty`.

- [ ] **Step 1:** Write failing VM tests against a fake `ISecurityModelSource`:
  - `LoadModel` populates `Roles` + `Rows` (one per derived concept) and auto-selects the first role; empty model → empty `Roles`, empty-state.
  - `SelectRole` rebuilds `Rows` for the new role; `AddConcept` appends a row; `AddRole` adds + selects; `DeleteRole` removes.
  - cycling a row's cell (`Rows[i].Cycle(action)`) sets `Dirty`.
  - `Save` calls `source.SetSecurityModel(env, draft.ToDto())` with untouched sections equal to the loaded model and the edited role's privileges reflecting the cycles; clears `Dirty`.
  - `Revert` reloads from source and clears `Dirty`.
  - error sets `Error` + error-state; a 401 rethrows (mirror B1-2 `FailWith`).
  - **load-token:** a `LoadModel` that resolves after a newer `SelectEnvironment`/`SelectRole` does not overwrite state (mirror `ServiceTokensViewModel`'s guard).
- [ ] **Step 2:** Run to verify failures.
- [ ] **Step 3:** Implement `PrivilegeRow` and the VM. Reuse `ServiceTokensViewModel`'s busy-counter (`EnterBusy`/`ExitBusy`), `loadToken` stale-guard, and `FailWith` (401 rethrow, else `Error`) verbatim in shape. `SelectEnvironment` resets role selection + draft; `LoadModel` builds the draft via `SecurityModelDraft.From`.
- [ ] **Step 4:** Run to verify passes.
- [ ] **Step 5:** `typecheck`; verify LF; commit.

---

### Task 4: `RolesPrivilegesView` — matrix, cycling cells, legend, states

**Files:**
- Create: `admin/tenant-portal/src/roles-privileges-view.ts` (LF)
- Test: `admin/tenant-portal/tests/roles-privileges-view.test.ts` (LF)

**Interfaces:**
- Consumes: `RolesPrivilegesViewModel`/`PrivilegeRow` (Task 3); `TenantViewBase` (MakeButton, ShowError, Act helper — mirror `ServiceTokensView`); Mural `DataGrid`, `DataGridTextColumn`, `DataGridTemplateColumn` from `@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js` + `/data-grid-column.js`; `DataTemplate` from `@pragmatic-tech-ai/mural/basic/templates/data-template.js`; `TextBox`/`Button` from the basic barrel; `GridLength`/`GridUnitType` from `…/basic/panels/grid.js`.
- Produces: `class RolesPrivilegesView extends TenantViewBase` ctor `(source: ISecurityModelSource)`; `get Grid(): DataGrid` seam; `Dispose()`.

- [ ] **Step 1:** Write failing view tests against a fake source (mirror `service-tokens-view.test.ts` altitude):
  - the matrix renders one `DataGridRow` per concept; the Concept text column shows the concept; there are 8 action columns (assert via the `Grid` seam: `Grid.Columns.length === 9`).
  - a cell renders a `Button` whose label is the level symbol; invoking its click advances the label and sets the VM `Dirty` indicator.
  - role picker renders one button per role; add-concept `TextBox` + button; a legend listing the 5 level symbols→names; Save + Revert buttons.
  - states: loading / empty (no roles) / populated / error / permission-denied render distinctly.
- [ ] **Step 2:** Run to verify failures.
- [ ] **Step 3:** Implement the view. `Render()` tears down + rebuilds chrome; the `DataGrid` is a **field**, re-fed via `ItemsSource` only when role/concept-set changes (suppress-selection discipline from B1-1/B1-2); per-cell edits mutate in place. Build columns once per feed: a `DataGridTextColumn` (`BindingPath` `'Concept'`) then eight `DataGridTemplateColumn`s — for each `action` in `Actions`, `col.Header = <action label>`, `col.CellTemplate = new DataTemplate(data => …)` where the factory casts `data` to `PrivilegeRow`, builds a `Button` with content = symbol for `row.LevelFor(action)`, and on click calls `row.Cycle(action)`, updates the button content in place, and notifies the VM (dirty). Hoist all labels/symbols to `private static readonly` (action headers, level symbols + names, legend text, Save/Revert/Add labels). `Dispose()` calls grid `dispose()` + removes listeners.
- [ ] **Step 4:** Run to verify passes.
- [ ] **Step 5:** `typecheck`; `typecheck:tools`; verify LF; commit.

---

### Task 5: Navigation wiring

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF)
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF)

**Interfaces:**
- Consumes: `RolesPrivilegesView` (Task 4); `ITenantNavigator.ShowRolesPrivileges` (Task 1).

- [ ] **Step 1:** Write a failing test: `TenantApp` has a **Roles & Privileges** top-bar button; `ShowRolesPrivileges()` shows a `RolesPrivilegesView`. Mirror the `ServiceTokens` nav test.
- [ ] **Step 2:** Run to verify failure.
- [ ] **Step 3:** Add `public static readonly RolesPrivilegesLabel = 'Roles & Privileges'`, the top-bar button, and `ShowRolesPrivileges()` = `this.Show(new RolesPrivilegesView(this.client))`.
- [ ] **Step 4:** Run full `npm --prefix admin/tenant-portal test` + `typecheck` + `typecheck:tools`. Verify EOL on `tenant-app.ts` + test. Commit.

---

## Self-review notes

- **Spec coverage:** R1 (no server) → whole plan UI-only; R2 concept derivation → Task 2; R3 round-trip → Task 2 round-trip test + Task 3 save test (Global Constraint + Review Focus); R4 verbatim DTOs → Task 1; R5 cycling cell → Task 4; R6 `SecurityModelDraft` → Task 2 (shaped for B1-4 reuse: pure, owns whole model); R7 nav → Task 5.
- **Type consistency:** `SecurityModelDto`/`PrivilegeAction`/`AccessLevel`/`Actions`/`LevelCycle` defined in Tasks 1–2 and consumed unchanged in 3–4; `ISecurityModelSource` defined in Task 1, consumed by VM (3) and view ctor (4) and implemented by the client (1).
- **Proportion:** plan carries decisions (interfaces, test names, the round-trip property, EOL map) and defers bodies to the implementer, who mirrors the B1-1/B1-2 house files.
