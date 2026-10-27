# Tenant-Admin Field-Security Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A field-security designer in the tenant portal — manage secured (concept, field) pairs and field-security profiles, edit a selected profile's read/update/create grants as a checkbox matrix, and save the whole model back — reusing existing REST routes and the shared `SecurityModelDraft`.

**Architecture:** UI-only in `admin/tenant-portal` (GET/PUT `security-model` + the client methods exist from B1-3). The B1-3 `SecurityModelDraft` is extended to also own field-security edits; its `ToDto()` emits both `roles` and `fieldSecurity`, preserving every other section. An `Observable` VM parallel to B1-3's drives a Mural view whose matrix uses `DataGridTemplateColumn` with `Checkbox` cells.

**Tech Stack:** TypeScript, `@pragmatic-tech-ai/mural` `DataGrid`/`DataGridTemplateColumn`/`DataTemplate`/`Checkbox`, `@pragmatic-tech-ai/todl-runtime` `Observable`, `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-field-security-designer-design.md`

## Global Constraints

- **No server changes.** Reuse GET/PUT `admin/security-model` and the client's existing `GetSecurityModel`/`SetSecurityModel` (R1).
- **Round-trip integrity (R2, load-bearing):** on the SHARED draft, editing field security preserves every other section (`businessUnits, teams, membership, ownershipRules, roles, roleAssignment`, and `fieldSecurity.profileAssignment`) byte-for-byte; and a role edit must still preserve `fieldSecurity` (regression). The original input object is never mutated.
- **Field-security edit surface:** `fieldSecurity = { securedFields: SecuredFieldDto[]; profiles: FieldProfileDto[]; profileAssignment: FieldProfileAssignmentDto }`; `SecuredFieldDto{concept,field}`; `FieldProfileDto{id,name,grants:FieldGrantDto[]}`; `FieldGrantDto{concept,field,read?,update?,create?}`. These DTOs already exist in `tenant-types.ts` (copied in B1-3).
- **3 field permissions, fixed order:** `read, update, create` (wire-string values exactly). A grant with all three false is dropped from the profile (absent == no access). Removing a secured field strips its matching grants from every profile.
- **House style:** OOP, Allman braces, PascalCase public members/interfaces, no inline string literals (hoist to `static readonly`), enums over string unions, VMs extend `Observable`, teardown via `Dispose()`. `.mu` not used.
- **EOL:** new files LF. Modified files match pre-existing endings — `security-model-draft.ts` + its test are **LF**; `tenant-types.ts` + `tests/fake-tenant-control-plane.ts` are **LF**; `tenant-app.ts` + `tenant-app.test.ts` are **CRLF**. Verify after every edit with `tr -cd '\r' < f | wc -c` vs `wc -l`; restore with perl. (The Edit tool silently flips EOL.)
- **Gates:** `npm --prefix admin/tenant-portal test` and `npm --prefix admin/tenant-portal run typecheck`; `npm run typecheck:tools` at repo root. No mural rebuild. Never `npm install` at repo root.
- **Secrets:** none.
- **Branch off `master`; merge-local at finish; NEVER push.** Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Dropped `roles`/`roleAssignment`/`profileAssignment` when saving field edits** — the shared draft must not lose B1-3's sections. → Task 1 round-trip test + Task 2 save test.
- **Role edit regression** — a B1-3 role edit on the extended draft must still preserve `fieldSecurity`. → Task 1 regression test (keep all existing B1-3 draft tests green + add one).
- **`fieldSecurity` absent/empty** — a model with no `fieldSecurity` (optional) renders empty, with working Add-profile and Add-secured-field, and `ToDto()` keeps it absent if it was absent and nothing was added. → Task 1 + Task 2 tests.
- **Remove secured field leaves orphan grants** — removing `{c,f}` must strip every profile's `{c,f}` grant. → Task 1 test.
- **All-false grant persists** — toggling a cell off such that read/update/create are all false must drop the grant entry, and the row must remain. → Task 1 test.

---

### Task 1: Extend `SecurityModelDraft` with field-security editing

**Files:**
- Modify: `admin/tenant-portal/src/security-model-draft.ts` (LF)
- Modify: `admin/tenant-portal/tests/security-model-draft.test.ts` (LF)

**Interfaces:**
- Consumes: existing `SecurityModelDto`, `SecuredFieldDto`, `FieldProfileDto`, `FieldGrantDto`, `FieldSecurityDto` from `./tenant-types.js`.
- Produces (new on `SecurityModelDraft`): `enum FieldPermission { Read='read', Update='update', Create='create' }` + `const FieldPermissions: readonly FieldPermission[] = [Read, Update, Create]` (exported from this module); `get SecuredFields(): readonly SecuredFieldDto[]`; `get Profiles(): readonly FieldProfileDto[]`; `SelectedProfileId: string | undefined`; `FieldGrant(concept, field, permission): boolean`; `SetFieldGrant(concept, field, permission, value): void`; `AddProfile(name): string`; `DeleteProfile(id): void`; `AddSecuredField(concept, field): void`; `RemoveSecuredField(concept, field): void`; `ToDto()` extended to emit edited `fieldSecurity` with a `fieldSecurityAbsent` guard mirroring `rolesAbsent`. Profile id generator reuses the role-id slug approach (prefix `profile-`).

- [ ] **Step 1:** Write failing tests (keep ALL existing B1-3 role/round-trip tests unchanged and passing):
  - `FieldGrant` reads the selected profile's grant for (concept,field,permission); an absent grant or absent profile → false.
  - `SetFieldGrant(true)` on an absent grant creates the grant entry; setting a permission such that all three flags become false drops the grant entry; the secured-field row still exists in `SecuredFields`.
  - `AddProfile` on absent/empty `fieldSecurity.profiles` creates a selectable profile with empty grants (and creates `fieldSecurity` if absent); `DeleteProfile` removes it.
  - `AddSecuredField(c,f)` adds `{c,f}` to `securedFields` (dedup); `RemoveSecuredField(c,f)` removes it AND strips every profile's matching `{c,f}` grant.
  - **Round-trip:** load a full model with both `roles` and a non-empty `fieldSecurity` (securedFields + ≥1 profile with grants + a non-empty `profileAssignment`); toggle one field grant; `ToDto()` → `businessUnits, teams, membership, ownershipRules, roles, roleAssignment`, and `fieldSecurity.profileAssignment` deep-equal the input; only the edited profile's grants changed; input unmutated.
  - **Regression:** on the same extended draft, a `SetLevel` role edit (B1-3) leaves `fieldSecurity` deep-equal to input in `ToDto()`.
  - **Absent:** `ToDto()` keeps `fieldSecurity` absent when it was absent and nothing was added; a present `fieldSecurity` is preserved.
- [ ] **Step 2:** Run tests to verify the new ones fail (and all B1-3 tests still pass).
- [ ] **Step 3:** Implement the extension. Keep the deep-clone discipline: edits mutate `this.model` (the private clone); `ToDto()` deep-copies. Mirror `SetLevel`'s none-removes-entry logic for the all-false-grant case. `AddSecuredField`/`AddProfile` create `this.model.fieldSecurity` if absent (and record `fieldSecurityAbsent` so a no-op `ToDto()` keeps it absent). Hoist all new string literals (id prefix, etc.) to `static readonly`.
- [ ] **Step 4:** Run tests to verify all pass.
- [ ] **Step 5:** `typecheck`; verify LF on both files; commit.

---

### Task 2: `FieldSecurityViewModel` + `FieldGrantRow`

**Files:**
- Create: `admin/tenant-portal/src/field-grant-row.ts` (LF)
- Create: `admin/tenant-portal/src/field-security-view-model.ts` (LF)
- Test: `admin/tenant-portal/tests/field-security-view-model.test.ts` (LF)

**Interfaces:**
- Consumes: the extended `SecurityModelDraft`, `FieldPermission`/`FieldPermissions` (Task 1); `IRolesPrivilegesSource` from `./roles-privileges-view-model.js` (= `ISecurityModelSource` + `ListEnvironments`; the client satisfies it); `Observable`.
- Produces: `class FieldGrantRow` — `get Concept()`, `get Field()`, `get Label()` (concept · field), `IsGranted(permission): boolean`, `Toggle(permission, value): void` (delegates to the draft). `class FieldSecurityViewModel extends Observable` with `static readonly` property keys and methods `LoadEnvironments`, `SelectEnvironment`, `LoadModel`, `SelectProfile`, `AddProfile`, `DeleteProfile`, `AddSecuredField`, `RemoveSecuredField`, `Save`, `Revert`, `RefreshDirty`; exposes `Environments`, `SelectedEnvironment`, `Profiles`, `SelectedProfileId`, `Rows: FieldGrantRow[]`, `Busy`, `Error`, `State` (incl. `Forbidden`), `Dirty`.

- [ ] **Step 1:** Write failing VM tests against a fake `IRolesPrivilegesSource` (mirror `roles-privileges-view-model.test.ts`):
  - `LoadModel` populates `Profiles` + `Rows` (one `FieldGrantRow` per secured field), auto-selects the first profile; empty model → empty Profiles + empty-state.
  - `SelectProfile` rebuilds the checkbox state the rows report; `AddSecuredField` appends a row; `RemoveSecuredField` removes it; `AddProfile` adds+selects; `DeleteProfile` removes.
  - toggling a row (`Rows[i].Toggle(FieldPermission.Read, true)`) sets `Dirty` (after `RefreshDirty`).
  - `Save` calls `source.SetSecurityModel(env, draft.ToDto())` with non-fieldSecurity sections equal to the loaded model; clears `Dirty`.
  - `Revert` reloads; a non-401 error sets `Error`+error-state; a 401 rethrows; a 403 sets `State=Forbidden`.
  - **load-token guard:** a `LoadModel` resolving after a newer `SelectEnvironment`/`SelectProfile` does not overwrite state.
- [ ] **Step 2:** Run to verify failures.
- [ ] **Step 3:** Implement `FieldGrantRow` and the VM. Reuse `RolesPrivilegesViewModel`'s busy-counter, `loadToken` guard, `FailWith` (401 rethrow / 403→Forbidden / else Error), and `RefreshDirty` verbatim in shape. `SelectEnvironment` resets profile+draft then loads; `LoadModel` builds the draft via `SecurityModelDraft.From`.
- [ ] **Step 4:** Run to verify passes.
- [ ] **Step 5:** `typecheck`; verify LF; commit.

---

### Task 3: `FieldSecurityView` — checkbox matrix, add/remove, states

**Files:**
- Create: `admin/tenant-portal/src/field-security-view.ts` (LF)
- Test: `admin/tenant-portal/tests/field-security-view.test.ts` (LF)
- Modify (optional seed enrichment): `admin/tenant-portal/tests/fake-tenant-control-plane.ts` (LF)

**Interfaces:**
- Consumes: `FieldSecurityViewModel`/`FieldGrantRow` (Task 2); `TenantViewBase` (MakeButton, ShowError, the `Act`/`WhenIdle` helpers — mirror `roles-privileges-view.ts`); Mural `DataGrid` from `@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js`, `DataGridTextColumn`/`DataGridTemplateColumn` from `…/data-grid-column.js`, `DataTemplate` from `@pragmatic-tech-ai/mural/basic/templates/data-template.js`, `Checkbox` from the framework toggles path (`@pragmatic-tech-ai/mural/framework/toggles/checkbox.js` — confirm the export path from the B0 data-grid-cells test imports), `TextBox`/`Button` from the basic barrel, `GridLength`/`GridUnitType` from `…/basic/panels/grid.js`.
- Produces: `class FieldSecurityView extends TenantViewBase` ctor `(source: IRolesPrivilegesSource)`; `get Grid(): DataGrid` seam; `Dispose()`.

- [ ] **Step 1:** Write failing view tests against a fake source (mirror `roles-privileges-view.test.ts`, including the realized-grid walk that themes an `Application` like `main.ts`):
  - the matrix renders one `DataGridRow` per secured field; `Grid.Columns.length === 4` (Field + Read/Update/Create).
  - a cell renders a `Checkbox` reflecting `row.IsGranted(permission)`; invoking its click flips the state and sets the VM `Dirty` indicator.
  - profile picker renders one button per profile; add-secured-field (concept `TextBox` + field `TextBox` + button); remove-secured-field on the selected row; Save + Revert buttons; dirty indicator.
  - mutating controls (profile select, add/delete profile, add/remove secured field, cell toggle) are no-ops while a save is in flight (hold `SetSecurityModel` open).
  - states: loading / empty (no profiles) / populated / error / permission-denied render distinctly.
- [ ] **Step 2:** Run to verify failures.
- [ ] **Step 3:** Implement the view, mirroring `roles-privileges-view.ts`. `Render()` rebuilds chrome; the `DataGrid` is a field re-fed via `ItemsSource` only on profile/secured-field-set change; per-cell toggles mutate in place. Build columns once per feed: a `DataGridTextColumn` (`BindingPath` `'Label'`) then three `DataGridTemplateColumn`s — for each `permission` of `FieldPermissions`, `col.Header = <permission label>`, `col.CellTemplate = new DataTemplate(data => …)` casting `data` to `FieldGrantRow`, building a `Checkbox` with `IsChecked = row.IsGranted(permission)` and `AddClickHandler(() => this.WhenIdle(() => { row.Toggle(permission, cb.IsChecked); this.vm.RefreshDirty(); }))`. Gate every mutating handler via `WhenIdle`. Hoist all labels (3 permission headers, Field header, Add/Remove/Save/Revert/Add-profile labels, dirty text, state messages) to `public static readonly`. `Dispose()` calls grid `dispose()` + removes listeners (match the sibling views).
- [ ] **Step 4:** Run to verify passes.
- [ ] **Step 5:** `typecheck`; `typecheck:tools`; verify LF; commit.

---

### Task 4: Navigation wiring

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF)
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF)
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF)
- Modify (interface implementors): the test `Nav` stubs that implement `ITenantNavigator` (`tests/*.test.ts`) — add `ShowFieldSecurity(): void {}` wherever adding the interface method breaks typecheck (mirror how B1-3's `ShowRolesPrivileges` was added to `service-tokens-view.test.ts`, `tenant-tree-view.test.ts`, `users-access-view.test.ts`).

**Interfaces:**
- Consumes: `FieldSecurityView` (Task 3); `ITenantNavigator.ShowFieldSecurity` (added here).

- [ ] **Step 1:** Write a failing test (mirror the B1-3 Roles & Privileges nav test in `tenant-app.test.ts`): `TenantApp` has a **Field Security** top-bar button; clicking it shows a `FieldSecurityView`.
- [ ] **Step 2:** Run to verify failure (and note which test-nav stubs now fail typecheck).
- [ ] **Step 3:** Add `ShowFieldSecurity(): void` to `ITenantNavigator` in `tenant-types.ts`; add `public static readonly FieldSecurityLabel = 'Field Security'`, the top-bar button (next to Roles & Privileges), and `ShowFieldSecurity()` = `this.Show(new FieldSecurityView(this.client))` in `tenant-app.ts`; add the empty `ShowFieldSecurity(): void {}` to each test `Nav` stub that needs it.
- [ ] **Step 4:** Run full `npm --prefix admin/tenant-portal test` + `typecheck` + `typecheck:tools`. Verify EOL (`tenant-types.ts` LF; `tenant-app.ts` + its test CRLF; touched test files keep their own existing endings). Commit.

---

## Self-review notes

- **Spec coverage:** R1 (no server) → whole plan UI-only; R2 shared-draft round-trip → Task 1 (round-trip + regression tests, Global Constraint + Review Focus); R3 secured-field free-text + strip-on-remove → Task 1; R4 checkbox cells + all-false==absent → Task 1 (draft) + Task 3 (cells); R5 profile picker, profileAssignment preserved → Tasks 1–3; R6 nav → Task 4; R7 VM plumbing + `IRolesPrivilegesSource` reuse → Task 2.
- **Type consistency:** `FieldPermission`/`FieldPermissions` defined in Task 1, consumed in 2–3; `FieldGrantRow`/`FieldSecurityViewModel` in Task 2, consumed by the view (3); `IRolesPrivilegesSource` reused from B1-3, satisfied by the client.
- **Proportion:** the plan carries interfaces, the round-trip/regression properties, the checkbox-cell contract, and the EOL map; bodies are left to the implementer, who mirrors the B1-3 house files directly.
