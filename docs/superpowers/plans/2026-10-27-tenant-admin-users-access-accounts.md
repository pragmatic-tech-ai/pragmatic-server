# Tenant-Admin "Users & Access" — Accounts & Grants (B1-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an environment-scoped **Users & Access** screen to the tenant portal — an accounts `DataGrid` with create/disable and role grant/revoke, no secrets, with loading/empty/error/conflict states — using only existing `/tenant-api` routes.

**Architecture:** A new `UsersAccessView` (imperative Mural view extending `TenantViewBase`) paired with a `UsersAccessViewModel` (extends `Observable`), reached from a new top-bar nav entry. The view hosts the Mural `DataGrid` (display + single-row selection only); row selection drives a below-grid "Selected account" section where Disable (inline confirm) and the roles grant/revoke editor live. The client gains `/tenant-api/environments/:name/admin/*` methods; the test fake gains the matching routes. No server changes.

**Tech Stack:** TypeScript, Mural UI framework (imperative controls, DP/`Observable` INPC, `DataGrid`), `tsx --test` (node:test), Vite. Repo `pragmatic-server`, package `admin/tenant-portal`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-users-access-accounts-design.md`

## Global Constraints

- Work only in `admin/tenant-portal/`. Branch off `master`. Merge locally when done; **never push**.
- **No server changes** — consume only the existing `/tenant-api/environments/:name/admin/*` routes and `GET /tenant-api/environments`.
- **No secrets:** the create-account password is input-only — never rendered to any visible `TextBlock`, never retained in the VM past the `CreateAccount` call, cleared on success.
- **Error handling:** surface the backend's generic `error` strings verbatim; never synthesize internal detail. `401` is handled by `TenantViewBase.ShowError` → `Navigator.ShowLogin()` (do not duplicate). `409` (self-lockout / last-admin / other RBAC) → show the backend's generic conflict message on the action area; do not mutate local state optimistically. `404` on a snapshot load → an "environment not available" state. Any other non-2xx → the generic error line.
- **DataGrid imports** via package subpaths: `@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js` (`DataGrid`), `@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js` (`DataGridTextColumn`), `@pragmatic-tech-ai/mural/framework/list/selector.js` (`SelectionMode`), `@pragmatic-tech-ai/mural/basic/panels/grid.js` (`GridLength`, `GridUnitType`). Existing barrel imports (`.../basic`, `.../framework`) stay as the current files use them.
- Style: OOP (methods on classes, no free functions/module state); Allman braces; `PascalCase` public members & interfaces; **no inline string literals** — every label/message/route/property-key is a `private static readonly` (or module `const` enum); enums over string unions for fixed value sets; VMs extend `Observable`; teardown via `dispose()`/`Dispose()`, not retained lambdas where a Disposable fits. Tests live under `admin/tenant-portal/tests/`. LF line endings.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

### Plan rulings (decided here; reviewers may challenge)

- **RP1 — text columns only; actions below the grid.** B1-1 uses `DataGridTextColumn` exclusively. Disable (inline confirm) and roles grant/revoke live in a below-grid section driven by `grid.SelectedItem`. `DataGridTemplateColumn`'s first in-app use is deferred to a later slice (the roles×privilege matrix). *Why:* keeps stateful/confirm UI in the view's `Render()` per the proven house pattern and avoids an unproven imperative `DataTemplate`-construction path in the first shipping use. *Cost if wrong:* template columns get their first app proof one slice later.
- **RP2 — button strips, not ComboBox.** The environment picker and the role selector render as click-to-select button rows. *Why:* matches the portal's all-buttons house pattern and is fully testable with the existing `Fixtures.Click` helper; the role set is 5 items. *Cost if wrong:* a later swap to ComboBox is isolated to the view.
- **RP3 — plain `AccountRow`, wholesale refresh.** `AccountRow` is a plain class rebuilt on each snapshot load; the grid refreshes by reassigning `ItemsSource` to the new array. *Why:* every mutation reloads the snapshot, so per-row INPC buys nothing. *Cost if wrong:* if partial live-cell updates are later wanted, make `AccountRow` observable then.
- **RP4 — no distinct permission-denied state.** The tenant REST endpoint emits `401`/`404`/`409`, never `403`; a 403 branch would be dead code. The brief's "permission-denied" is represented by the generic error state.
- **RP5 — operator principal injected.** `TenantApp` stores `principalId` from the Boot session and passes it into `UsersAccessView`/VM, enabling self-lockout detection without a new whoami call.

## Review Focus

- **409 conflict on disable/revoke** (self-lockout / last-admin): the backend's generic conflict message is surfaced and local state is unchanged (no optimistic removal). → Task 2 VM test + Task 3 view test.
- **Snapshot load returns 404** (env not owned/unknown): renders the "environment not available" state, no crash. → Task 2 VM test.
- **Password is never retained or rendered:** after a successful `CreateAccount` the draft password is cleared and never appears in any rendered text. → Task 2 VM test (cleared) + Task 3 view test (no visible echo).
- **Empty environment list:** picker shows its empty state and no snapshot load is attempted. → Task 2 VM test.
- **Selected account vanishes after refresh:** a `SelectedPrincipalId` that is absent from the reloaded snapshot clears the selection/section gracefully (no actions fired against a gone principal). → Task 2 VM test.

---

### Task 1: DTOs, client methods, and fake-control-plane routes

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (add DTOs, `TenantRole` enum, `IUsersAccessSource`, extend `ITenantNavigator`)
- Modify: `admin/tenant-portal/src/tenant-api-client.ts` (add admin route constants + methods)
- Modify: `admin/tenant-portal/tests/fake-tenant-control-plane.ts` (add `/admin/*` routes)
- Test: `admin/tenant-portal/tests/tenant-api-client.test.ts` (extend)

**Interfaces:**
- Consumes: existing `TenantApiClient` private `Send<T>(route, init)` helper; existing `ListEnvironments(): Promise<EnvironmentDto[]>`; existing `TenantApiError { Status: number }`.
- Produces (verbatim wire shapes copied from the server — the portal never imports `pragmatic-protocol`):
  - `export type AccountDto = { principalId: string; email: string; disabled: boolean }`
  - `export type GrantDto = { subject: string; role: string; resourceKind: string; resourcePath: string[] }`
  - `export type GrantMutationDto = { subject: string; role: string; resourceKind?: string; resourcePath?: string[] }`
  - `export type CreateAccountParams = { email: string; principalId: string; password: string }`
  - `export type AdminSnapshotDto = { accounts: AccountDto[]; grants: GrantDto[] }` (the portal reads only `accounts` + `grants` from the server's `{ accounts, grants, config }` snapshot; `config` is ignored in B1-1)
  - `export enum TenantRole { ... }` — exact role identifiers discovered in Step 1 (expected set: Owner/Admin/Editor/Viewer/Maker)
  - `export interface IUsersAccessSource` with `PascalCase` methods:
    - `ListEnvironments(): Promise<EnvironmentDto[]>`
    - `GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>`
    - `CreateAccount(env: string, params: CreateAccountParams): Promise<void>`
    - `DisableAccount(env: string, principalId: string): Promise<void>`
    - `GrantRole(env: string, grant: GrantMutationDto): Promise<void>`
    - `RevokeRole(env: string, grant: GrantMutationDto): Promise<void>`
  - `TenantApiClient implements IUsersAccessSource` — the five new methods above (it already has `ListEnvironments`).
  - `ITenantNavigator` gains `ShowUsersAccess(): void`.

- [ ] **Step 1: Discover the canonical role identifiers.** Grep the server/identity engine for the role-name strings the grant API expects (search `pragmatic-server` and the identity engine for `'Owner'`, role enums, `role:` handling). Use the exact identifiers found to populate `TenantRole`. If the engine accepts free-form role strings, keep the expected Owner/Admin/Editor/Viewer/Maker set and note it. Record what you found in the task report.

- [ ] **Step 2: Write failing client tests.** In `tenant-api-client.test.ts`, add tests that stub `globalThis.fetch` (mirror the existing test's fetch-stub style) and assert, for each new method, the exact request and the parsed result:
  - `GetAdminSnapshot('envA')` → `GET /tenant-api/environments/envA/admin/snapshot`, returns the parsed `{ accounts, grants }`.
  - `CreateAccount('envA', {email,principalId,password})` → `POST /tenant-api/environments/envA/admin/accounts` with that JSON body and `content-type: application/json`; resolves on `201`.
  - `DisableAccount('envA','p1')` → `DELETE /tenant-api/environments/envA/admin/accounts/p1`; resolves on `200`.
  - `GrantRole('envA', {subject:'p1',role:'Admin'})` → `POST /tenant-api/environments/envA/admin/grants` with that body.
  - `RevokeRole('envA', {subject:'p1',role:'Admin'})` → `DELETE /tenant-api/environments/envA/admin/grants` with that body.
  - A non-2xx (`409` with `{error:'...'}`) from `DisableAccount` rejects with a `TenantApiError` whose `.Status === 409` and `.message` is the backend `error` string.
  - URL-encode the `env` and `principalId` path segments (assert a segment containing a reserved char is encoded).

- [ ] **Step 3: Run the tests to verify they fail.** Run: `npm --prefix admin/tenant-portal test`. Expected: the new assertions fail (methods undefined).

- [ ] **Step 4: Add the route constants and methods.** In `tenant-api-client.ts` add `private static readonly` route builders (base `'/tenant-api/environments'`, segments `'/admin/snapshot'`, `'/admin/accounts'`, `'/admin/grants'`) and the five methods, each delegating to the existing `Send<T>` helper (GET = no init; mutations = `{ method, body: JSON.stringify(...) }`). Encode path segments with `encodeURIComponent`. `DisableAccount`/`RevokeRole` use method `'DELETE'`.

- [ ] **Step 5: Add DTOs, enum, interface, navigator member.** In `tenant-types.ts` add the types/enum/`IUsersAccessSource` from Interfaces and add `ShowUsersAccess(): void` to `ITenantNavigator`.

- [ ] **Step 6: Add `/admin/*` routes to the fake.** In `fake-tenant-control-plane.ts` add a `path.startsWith('/tenant-api/environments/')` + `'/admin/'` branch dispatching to a new `HandleAdmin` method that: serves `GET .../admin/snapshot` from in-memory `accounts`/`grants` arrays; records `POST/DELETE .../admin/accounts[/:id]` and `POST/DELETE .../admin/grants`; mutates the in-memory arrays; and returns `{ ok: true }` with 200/201. Follow the existing `HandleEnvironment` style and `Json(res,status,body)` helper. Seed a couple of accounts/grants so e2e and view tests have data.

- [ ] **Step 7: Run tests to verify they pass.** Run: `npm --prefix admin/tenant-portal test` and `npm --prefix admin/tenant-portal run typecheck`. Expected: PASS.

- [ ] **Step 8: Commit.** `git add` the four files; `git commit -m "feat(tenant-portal): admin snapshot/account/grant client + DTOs + fake routes"`.

---

### Task 2: `AccountRow` + `UsersAccessViewModel`

**Files:**
- Create: `admin/tenant-portal/src/account-row.ts`
- Create: `admin/tenant-portal/src/users-access-view-model.ts`
- Test: `admin/tenant-portal/tests/users-access-view-model.test.ts`

**Interfaces:**
- Consumes: `IUsersAccessSource`, `AccountDto`, `GrantDto`, `GrantMutationDto`, `CreateAccountParams`, `AdminSnapshotDto`, `TenantRole`, `EnvironmentDto`, `TenantApiError` (from Task 1); `Observable` + `RaisePropertyChanged`/`PropertyChanged` (from `@pragmatic-tech-ai/todl-runtime`).
- Produces:
  - `export class AccountRow` — ctor `(account: AccountDto, grants: GrantDto[])`; readonly `Email: string`, `PrincipalId: string`, `Status: string` (`'Active'`/`'Disabled'` from `disabled`), `RolesText: string` (role names of grants whose `subject === principalId`, de-duped, joined with `', '`), `Disabled: boolean`. Static `AccountRow.FromSnapshot(snapshot: AdminSnapshotDto): AccountRow[]`.
  - `export class UsersAccessViewModel extends Observable` — ctor `(source: IUsersAccessSource, currentPrincipalId: string)`. Property-name keys (`public static readonly XProperty = 'X'`): `EnvironmentsProperty`, `SelectedEnvironmentProperty`, `RowsProperty`, `BusyProperty`, `ErrorProperty`, `StateProperty`, `SelectedPrincipalIdProperty`, `PendingProperty`. Getters: `Environments: readonly string[]`, `SelectedEnvironment: string | undefined`, `Rows: readonly AccountRow[]`, `Busy: boolean`, `Error: string`, `State: UsersAccessState`, `SelectedPrincipalId: string | undefined`, `SelectedGrants: readonly GrantDto[]`, `Pending: PendingAction | undefined`. Create-draft fields with getters/setters: `DraftEmail`, `DraftPrincipalId`, `DraftPassword`, `DraftRole: TenantRole`.
  - `export enum UsersAccessState { Loading, Empty, Ready, Error, NoEnvironment }` and `export type PendingAction = { kind: PendingKind; principalId: string; role?: string }`, `export enum PendingKind { DisableSelf, RevokeSelf }`.
  - Methods: `LoadEnvironments(): Promise<void>`; `SelectEnvironment(name: string): Promise<void>` (sets selection, then `LoadSnapshot`); `LoadSnapshot(): Promise<void>`; `SelectAccount(principalId: string | undefined): void`; `CreateAccount(): Promise<void>` (builds `CreateAccountParams` from draft, calls source, clears draft incl. password, reloads snapshot); `RequestDisable(principalId: string): void` (if `=== currentPrincipalId` sets `Pending={DisableSelf}`, else calls `DisableAccount` directly); `RequestRevoke(grant: GrantDto): void` (if `grant.subject === currentPrincipalId` sets `Pending={RevokeSelf}`, else `RevokeRole` directly); `ConfirmPending(): Promise<void>`; `CancelPending(): void`; `GrantRole(): Promise<void>` (uses `SelectedPrincipalId` + `DraftRole`); plus the underlying `DisableAccount(principalId)`/`RevokeRole(grant)` that issue the call, reload, and on `TenantApiError` set `Error` to `e.message`.

- [ ] **Step 1: Write failing `AccountRow` tests.** `FromSnapshot({accounts:[{principalId:'p1',email:'a@b',disabled:false}], grants:[{subject:'p1',role:'Admin',resourceKind:'tenant',resourcePath:[]},{subject:'p1',role:'Editor',...}]})` yields one row with `Email==='a@b'`, `Status==='Active'`, `RolesText==='Admin, Editor'`; a `disabled:true` account → `Status==='Disabled'`; an account with no grants → `RolesText===''`.

- [ ] **Step 2: Write failing VM tests** against a hand-rolled `FakeSource implements IUsersAccessSource` (records calls, returns canned data/throws canned `TenantApiError`):
  - `LoadEnvironments` with two envs sets `Environments` and auto-selects the first, `State` transitions `Loading`→`Ready` and raises `EnvironmentsProperty`/`StateProperty`.
  - `LoadEnvironments` with an empty list sets `State===NoEnvironment` and does **not** call `GetAdminSnapshot`.
  - `SelectEnvironment('envA')` loads the snapshot and populates `Rows`.
  - `GetAdminSnapshot` throwing `TenantApiError(404,'...')` sets `State===Error` and `Error` to the message; `Rows` stays empty.
  - `CreateAccount` with a full draft calls `source.CreateAccount(env, {email,principalId,password})`, then clears `DraftEmail/DraftPrincipalId/DraftPassword` to `''`, and reloads the snapshot.
  - `RequestDisable(currentPrincipalId)` sets `Pending.kind===DisableSelf` and calls nothing; `ConfirmPending()` then calls `source.DisableAccount`; `CancelPending()` clears `Pending` and calls nothing.
  - `RequestDisable('other')` calls `source.DisableAccount` immediately (no pending).
  - `DisableAccount` throwing `TenantApiError(409,'conflict')` sets `Error==='conflict'` and leaves `Rows` unchanged (no optimistic removal).
  - `RequestRevoke` mirrors disable for `grant.subject === currentPrincipalId`.
  - After a reload whose snapshot omits the previously `SelectedPrincipalId`, `SelectedPrincipalId` becomes `undefined` and `SelectedGrants` is empty.

- [ ] **Step 3: Run tests to verify they fail.** Run: `npm --prefix admin/tenant-portal test`. Expected: FAIL (classes undefined).

- [ ] **Step 4: Implement `account-row.ts`.** Plain class + static `FromSnapshot` per Interfaces (RP3: no `Observable`).

- [ ] **Step 5: Implement `users-access-view-model.ts`.** `extends Observable`; each mutator writes its field then `RaisePropertyChanged(key, old, next)`. `LoadSnapshot` sets `Busy`, calls `source.GetAdminSnapshot(SelectedEnvironment)`, maps to `AccountRow.FromSnapshot`, reconciles `SelectedPrincipalId` against the new rows, sets `State`. Catch `TenantApiError` → `Error`/`State`. Keep all labels/keys as `static readonly`.

- [ ] **Step 6: Run tests to verify they pass.** Run: `npm --prefix admin/tenant-portal test` + `npm --prefix admin/tenant-portal run typecheck`. Expected: PASS.

- [ ] **Step 7: Commit.** `git commit -m "feat(tenant-portal): UsersAccessViewModel + AccountRow"`.

---

### Task 3: `UsersAccessView` (DataGrid + actions)

**Files:**
- Create: `admin/tenant-portal/src/users-access-view.ts`
- Test: `admin/tenant-portal/tests/users-access-view.test.ts`

**Interfaces:**
- Consumes: `UsersAccessViewModel` + its property keys/enums + `AccountRow` (Task 2); `IUsersAccessSource` (ctor injection for tests); `TenantViewBase` (`MakeButton`, `ShowError`, `Run`, `message`, `Navigator`); `TenantRole`; `TextBox` (from the `@pragmatic-tech-ai/mural/basic` barrel — has `Text: string`, `IsPassword: boolean`, `Placeholder: string`); `DataGrid`, `DataGridTextColumn`, `SelectionMode`, `GridLength`, `GridUnitType` (subpath imports per Global Constraints).
- Produces: `export class UsersAccessView extends TenantViewBase` — ctor `(source: IUsersAccessSource, currentPrincipalId: string)`; `public async Refresh(): Promise<void>` (calls `vm.LoadEnvironments()`); `public get Grid(): DataGrid` (test seam, returns the held grid field); `public Dispose(): void` (calls `this.grid.dispose()` and removes the selection listener).

- [ ] **Step 1: Write failing view tests** using a local `Fixtures` walker (copy the shape from `hive-detail-view.test.ts`: `Texts`, `Buttons`, `Click`, `Settle`). **Grid assertions are at the portal's altitude — the DataGrid's internal row realization is mural's own contract (covered by its B0 tests) and does not reliably happen under `tsx --test` (no `Application`/layout pass), so do not walk realized `DataGridRow` containers.** Instead expose the grid via a test seam (e.g. a readonly `Grid` getter on the view) and assert: the grid has four `DataGridTextColumn`s with `BindingPath` `'Email'`/`'PrincipalId'`/`'Status'`/`'RolesText'`; `SelectionMode === SelectionMode.Single`; and `grid.ItemsSource` is an array whose entries' `Email`/`Status`/`RolesText` match the snapshot's accounts. Drive the view with a `FakeSource` and `await view.Refresh()`:
  - `grid.ItemsSource` has one `AccountRow` per account with the expected cell values; the four columns carry the expected `BindingPath`s.
  - The environment picker renders one button per environment; clicking a different one reloads the snapshot (asserts `FakeSource.GetAdminSnapshot` called with that env).
  - Selecting an account via `vm.SelectAccount(principalId)` + `Settle` reveals the "Selected account" section with that account's grants and a Disable button (the grid→VM selection adapter — `AddSelectionChangedListener` reading `grid.SelectedItem` — is a thin wiring asserted by one test that sets `grid.SelectedItem` and fires the listener).
  - Clicking Disable shows **Confirm disable / Cancel** only when the row is the current operator (`currentPrincipalId`); Confirm calls the source; Cancel restores.
  - The create form has an email, principal, and password field plus a Create button; after a successful create the password field is empty and no visible text node equals the entered password.
  - Grant: picking a role button + Grant calls `source.GrantRole` with `{subject, role}`; each existing grant row has a Revoke button.
  - States render distinctly: `Loading` (busy text), `Empty` (no-accounts text), `Error` (the backend message via `message`), `NoEnvironment` (no-environments text).

- [ ] **Step 2: Run tests to verify they fail.** Run: `npm --prefix admin/tenant-portal test`. Expected: FAIL (view undefined).

- [ ] **Step 3: Implement `users-access-view.ts`.** Construct the `DataGrid` once as a field: add four `DataGridTextColumn`s (Email `new GridLength(2,GridUnitType.Star)`, Principal `new GridLength(2,GridUnitType.Star)`, Status `GridLength.Auto`, Roles `new GridLength(3,GridUnitType.Star)`) with `BindingPath` = `'Email'`/`'PrincipalId'`/`'Status'`/`'RolesText'`; set `SelectionMode = SelectionMode.Single`; `AddSelectionChangedListener(() => this.vm.SelectAccount((this.grid.SelectedItem as AccountRow | undefined)?.PrincipalId))`. Subscribe `vm.PropertyChanged(RowsProperty)` → `UpdateGrid()` (sets `this.grid.ItemsSource = [...vm.Rows]`), and `EnvironmentsProperty`/`SelectedEnvironmentProperty`/`StateProperty`/`ErrorProperty`/`SelectedPrincipalIdProperty`/`PendingProperty` → `Render()`. `Render()` rebuilds children (teardown-then-add per house pattern): env picker button strip, the state-appropriate body (the `grid` field when `Ready`, else the state text), the create form (three `TextBox` fields for email/principal/password — each with a `Placeholder`, the password field with `IsPassword = true` — plus a Create button that reads `.Text` off each box into the VM draft, invokes `vm.CreateAccount()`, and never echoes the password to a `TextBlock`), and — when `SelectedPrincipalId` is set — the Selected-account section (Disable with inline confirm from `vm.Pending`, grants list each with Revoke, and a role button-strip + Grant). All labels/messages are `private static readonly`. Destructive confirm uses `vm.Pending` (self) or the local inline pattern (non-self) consistent with `environment-detail-view`.

- [ ] **Step 4: Run tests to verify they pass.** Run: `npm --prefix admin/tenant-portal test` + `typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(tenant-portal): UsersAccessView with accounts DataGrid"`.

---

### Task 4: Navigation wiring

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts`
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (extend)

**Interfaces:**
- Consumes: `UsersAccessView` (Task 3); `ITenantNavigator.ShowUsersAccess()` (Task 1); existing `TenantApp` top-bar/`Show`/`Boot` machinery; `SessionDto.principalId`.
- Produces: `TenantApp` implements `ShowUsersAccess()`; stores the Boot session's `principalId`.

- [ ] **Step 1: Write failing nav tests.** In `tenant-app.test.ts`: after `Boot()` with a session, a **Users & Access** top-bar button exists; clicking it makes `current` a `UsersAccessView`; `Boot` records `principalId` and the constructed view receives it (assert via a seam — e.g. expose a readonly `CurrentPrincipalId` getter on `TenantApp`, or assert the view's behavior).

- [ ] **Step 2: Run tests to verify they fail.** Run: `npm --prefix admin/tenant-portal test`. Expected: FAIL.

- [ ] **Step 3: Implement wiring.** Add a `UsersAccessLabel` `static readonly`; in the ctor add a top-bar button `MakeButton(UsersAccessLabel, () => this.ShowUsersAccess())`; store `principalId` from the `Boot()` session into a `private currentPrincipalId`; implement `ShowUsersAccess()` to `this.Show(new UsersAccessView(this.client, this.currentPrincipalId))`.

- [ ] **Step 4: Run tests to verify they pass.** Run: `npm --prefix admin/tenant-portal test` + `typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(tenant-portal): Users & Access nav entry"`.

---

## Notes for the executor

- The server already implements every `/admin/*` route (`admin/control-plane/tenant-api/tenant-api-endpoint.ts`); this plan adds only the **client, fake, VM, view, and nav**. Do not modify server code.
- Non-2xx mapping is centralized in the client's existing `Send<T>` (`error` field → `TenantApiError.message`); the VM reads `TenantApiError.Status`/`.message` and never invents text.
- The DataGrid already ships in mural `dist` (built locally for B0); no mural rebuild is needed unless mural itself changes. Tenant-portal resolves it through the `file:../../../Mural` dependency + the `./framework/*.js` export wildcard.
- Final gates before finishing: `npm --prefix admin/tenant-portal test`, `npm --prefix admin/tenant-portal run typecheck`, and the repo's `npm run typecheck:tools` if it covers this package.
