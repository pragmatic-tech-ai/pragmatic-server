# Tenant-Admin Environments List & Create (TA-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the interim hive-tree under the Environments nav with a searchable, selectable environments DataGrid (status/health/version/live-URL, bulk Start/Restart/Stop, row-opens-detail) plus a Create-environment dialog, backed by existing reads joined + a new `CreateEnvironment` client method.

**Architecture:** Pure portal (plus one client method; the server POST route already exists). The list VM joins `ListEnvironments` with per-hive `GetHealth` (no `EnvironmentDto` change). Capability gating (`envs`, undefined=permissive) via kit `Act`. Live updates reuse the tree VM's reload logic. The old tree/hive-detail leave navigation.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Mural controls (`DataGrid`, `DataGridTextColumn`, `DataGridTemplateColumn`+`DataTemplate`, `SelectionMode`, `TextBox`, `Checkbox`, `ComboBox`, `Dialog`), TA-1 kit (`StatusPill`/`PillKind`, `ScreenHost`, `Act`, `Section`, state panels), `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-environments-list-create-design.md`

## Global Constraints

- Merge-local only; **never push**. Branch off `master`.
- **Pure ASCII** every `.ts`: straight apostrophes, em dash `—`, no smart quotes — verify with a python byte scan, NOT grep.
- **Preserve each touched file's existing EOL** (all new files LF; `tenant-app.ts` + `tenant-app.test.ts` are CRLF — match them; never flip). Verify CR==LF for CRLF files, CR==0 for LF files.
- OOP, Allman braces, PascalCase public methods/interfaces, NO inline string literals (hoist to `private static readonly`; plain data-object literals OK), enums over string unions, VMs extend `Observable`.
- DTO/enum wire shapes mirrored BY HAND into `tenant-types.ts` (portal never imports pragmatic-protocol); server enum VALUES (`Template`/`EnvType`/`EnvStatus`) copied verbatim from `admin/control-plane/environment-record.ts`.
- Fix ALL review findings incl. Minors. Stage only TA-4 files by explicit path; never `git add -A`; never stage `docs/design/` or any sibling Mural repo.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Global values (verbatim)

- `enum Template { DevBlank='dev-blank', DemoContoso='demo-contoso', RuntimePostgres='runtime-postgres' }`
- `enum EnvType { Development='development', Runtime='runtime' }`
- `enum EnvStatus { Running='running', Stopped='stopped', Failed='failed', Unknown='unknown' }`
- Create POST `/tenant-api/environments` body `{ name, template, type }` → 201 `EnvironmentDto`; 409 dup = "An environment with this name already exists"; 400 bad fields.
- Name validation regex `^[a-z][a-z0-9-]{2,30}$`; dup error "An environment with this name exists."; format error "Use 3-31 lowercase letters, digits or hyphens, starting with a letter."
- `HiveHealthDto = { environmentName, ready, runningImage, detail }` via `GetHealth(hiveId)`. `TenantEventType`={environment-created,environment-changed,environment-deleted,health-changed}; `TenantEvent={type,environmentName}`.
- PillKind map: status running→Running, stopped→Stopped, failed→Failed, unknown→Unknown (+ starting/stopping/restarting/provisioning already in the enum); health ready:true→Healthy, false→Failing.
- Capability gate: `this.Navigator?.Capabilities?.envs !== false` (undefined=permissive).

## Review Focus

- **Health-join degradation:** a failed/empty `GetHealth` for a hive must leave Status (from the DTO) and the URL rendering, with Health/version "—" — never blanks the list or throws. Test. (Task 2.)
- **Bulk eligibility:** Start acts only on selected AND stopped; Stop/Restart only on selected AND running — a mixed selection must not start a running env or stop a stopped one. Test. (Task 2.)
- **Create dup race:** a name passing the client regex+list check can still 409 at the server (another admin created it) — the dialog must surface the 409 message inline, not throw. Test. (Task 4.)
- **Live-update newer-wins:** overlapping reloads (two quick events) must not render stale rows; the load-token guard drops the older. Test. (Task 2.)
- **Capabilities undefined = permissive:** Create/bulk `Act`s enabled when `Capabilities` is undefined (failed profile) — never a fabricated denial. Test. (Task 3.)

---

### Task 1: Enums, CreateEnvironment client, fake POST

**Files:** Modify `admin/tenant-portal/src/tenant-types.ts`, `admin/tenant-portal/src/tenant-api-client.ts`, `admin/tenant-portal/tests/fake-tenant-control-plane.ts`. Test: `admin/tenant-portal/tests/tenant-api-client.test.ts` (extend).

**Interfaces — Produces:**
- `tenant-types.ts`: `enum Template`/`EnvType`/`EnvStatus` (values above); retype `EnvironmentDto.template: Template`, `.type: EnvType`, `.status: EnvStatus`; `type CreateEnvironmentParams = { name: string; template: Template; type: EnvType }`; extend the environments source interface with `CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>` (define `IEnvironmentsSource` = `ListEnvironments` + `GetHealth` + `Start/Stop/RestartEnvironment` + `CreateEnvironment` for Task 2/3 to consume; the client structurally satisfies it).
- `tenant-api-client.ts`: `public async CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>` — POST `/tenant-api/environments` with `{ name, template, type }` body (hoisted route/keys), returns the DTO; non-2xx throws `TenantApiError` (409 carries `.Status`).

- [ ] **Step 1:** Add the three enums to `tenant-types.ts`; retype the three `EnvironmentDto` fields to them; confirm no existing consumer breaks on the narrowed types (status/template/type were `string`; `tsc` will flag any mismatch — fix at call sites by comparing to enum members). Add `CreateEnvironmentParams` + `IEnvironmentsSource`.
- [ ] **Step 2:** Write a failing client test: `CreateEnvironment({name,template,type})` POSTs `/tenant-api/environments` with that JSON body and returns the parsed `EnvironmentDto`; a 409 response throws `TenantApiError` with `.Status===409`.
- [ ] **Step 3:** Run, verify fail.
- [ ] **Step 4:** Implement `CreateEnvironment` (follow the `Action`/`Send` POST pattern; hoist route + body keys).
- [ ] **Step 5:** Extend the fake: a POST `/tenant-api/environments` branch — read the JSON body, validate `name` non-empty + `template`/`type` are known enum values (400 else), push a `TenantEvent{type:'environment-created',environmentName:name}`, return 201 with a new `EnvironmentDto` (reuse the `Env(...)` builder with the posted name/template/type, a fresh environmentId, status running or provisioning). Record created names on a public field for e2e assertions.
- [ ] **Step 6:** Run client test + `npm --prefix admin/tenant-portal test` + `typecheck` + `typecheck:tools`; byte-scan (LF, 0 non-ASCII); commit.

### Task 2: EnvironmentsViewModel + EnvironmentRow

**Files:** Create `admin/tenant-portal/src/environment-row.ts`, `admin/tenant-portal/src/environments-view-model.ts`. Test: `admin/tenant-portal/tests/environments-view-model.test.ts`.

**Interfaces — Consumes:** `IEnvironmentsSource` (Task 1); `EnvironmentDto`, `HiveHealthDto`, `TenantEvent`/`TenantEventType`, enums; kit `PillKind` (map status/health). **Produces:**
- `EnvironmentRow` — `{ Name, EnvironmentId, Template, Status: EnvStatus, Health: PillKind, Version: string, Url?: string, IsRunning, IsStopped, Dto: EnvironmentDto }` + `Selected: boolean` reflecting VM membership.
- `EnvironmentsViewModel extends Observable` — static property keys (`RowsProperty`, `BusyProperty`, `ErrorProperty`, `SelectionProperty`); `get Rows(): readonly EnvironmentRow[]` (filtered); `get AllRows()`; `Filter` get/set (raises Rows); `Selected: ReadonlySet<string>`; `Toggle(name)`, `SelectAllFiltered()`, `ClearSelection()`; `async Load()`; `async StartSelected()/StopSelected()/RestartSelected()`; `async ApplyEvent(ev): Promise<boolean>`; `get Busy`, `get Error`.

- [ ] **Step 1:** Write failing VM tests (fake source): Load joins envs + `GetHealth` per distinct hiveId → row Status from DTO, Health pill from `ready`, Version from `runningImage` (trailing tag after last `:`), Url from `httpUrl` when running; an env with no health entry → Health `Unknown`/version "—"; a `GetHealth` that throws for a hive → that hive's envs still list with Status/URL and "—" health (degrade, don't fail). Filter by name/id/version. Toggle/SelectAllFiltered/ClearSelection over filtered rows. `StartSelected` calls `StartEnvironment` only for selected+stopped; `StopSelected`/`RestartSelected` only for selected+running; then clears + reloads. `ApplyEvent`: created→reload, changed/deleted→reload only if name present, health-changed→reload. Two overlapping Loads: newer wins (older's result dropped).
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement `EnvironmentRow` + `EnvironmentsViewModel` (busy-counter, load-token/generation guard, FailWith→Error, PillKind mapping as static maps, version parse as a static helper).
- [ ] **Step 4:** Run tests, verify pass; byte-scan; commit.

### Task 3: EnvironmentsView (grid + search + bulk + states)

**Files:** Create `admin/tenant-portal/src/environments-view.ts`. Test: `admin/tenant-portal/tests/environments-view.test.ts`.

**Interfaces — Consumes:** `EnvironmentsViewModel`/`EnvironmentRow` (Task 2); `TenantViewBase`, `ITenantNavigator` (`ShowEnvironmentDetail`, `Capabilities`); kit `Section`/`ScreenHost`/`StatusPill`/`Act`/state panels; Mural `DataGrid`/`DataGridTextColumn`/`DataGridTemplateColumn`/`DataTemplate`/`TextBox`/`Checkbox`/`GridLength`/`StackPanel`. **Produces:** `EnvironmentsView extends TenantViewBase` with `Refresh()`, `ApplyEvent(ev)` (delegates to VM + rebuilds), `Dispose()`, and a `Grid`/`Rows` test seam.

- [ ] **Step 1:** Write failing view tests (themed Application, fake nav): populated grid has the checkbox col + Environment/Status/Application/Health/Live-URL columns; empty state (no rows) shows the "No environments yet" empty panel with a Create action; Create `Act` + bulk `Act`s disabled when `Capabilities.envs===false`, enabled when `true` or `undefined`; opening a row calls `Navigator.ShowEnvironmentDetail(row.Dto)`; typing in the search box filters rows; the bulk toolbar is present only when a selection exists; a header checkbox selects all filtered.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the view: `Section` (title/sub + Create `Act` in actions) over a `ScreenHost` (loading Table skeleton / empty / error / populated); populated = search `TextBox` (two-way to `vm.Filter`) + bulk toolbar (`Act`s gated on `envs`, acting via `vm.StartSelected`/etc, shown when `vm.Selected.size>0`) + `DataGrid` (SelectionMode handled by the VM set via a checkbox `DataGridTemplateColumn`; Status/Health cells are `DataGridTemplateColumn` → `StatusPill`; Environment/Application/Live-URL cells as template or text columns; a row-activate handler → `ShowEnvironmentDetail`). Gate reading via `AttachNavigator` (capabilities known then). Subscribe to VM `PropertyChanged` → rebuild grid ItemsSource; `Dispose` unsubscribes.
- [ ] **Step 4:** Run tests, verify pass; byte-scan; commit.

### Task 4: CreateEnvironmentDialog

**Files:** Create `admin/tenant-portal/src/create-environment-dialog.ts`. Test: `admin/tenant-portal/tests/create-environment-dialog.test.ts`.

**Interfaces — Consumes:** `IEnvironmentsSource.CreateEnvironment` (Task 1), `CreateEnvironmentParams`, enums; Mural `Dialog`/`DialogAction`/`TextBox`/`ComboBox`; kit `Act`. **Produces:** `CreateEnvironmentDialog extends Dialog` — ctor `(source, existingNames: readonly string[], onCreated: (env: EnvironmentDto) => void)`; Name `TextBox`, Template + Type pickers, Cancel + Create; test seams `CreateEnabled`, `SetName`, `Error`, `Submit`.

- [ ] **Step 1:** Write failing tests: Create disabled until the name matches `^[a-z][a-z0-9-]{2,30}$` AND is not in `existingNames`; the two error messages render for format vs duplicate; Template defaults to `dev-blank`, Type to `runtime` (or chosen defaults), and both change; `Submit` calls `CreateEnvironment({name,template,type})` and fires `onCreated(env)` on success; a thrown `TenantApiError{Status:409}` shows "An environment with this name exists." inline and does NOT fire `onCreated`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the dialog (validation as a static regex const + a dup check; pickers via `ComboBox` bound to enum values with human labels; Create `Act` disabled on invalid/busy; catch 409 → inline error; hoist all copy).
- [ ] **Step 4:** Run tests, verify pass; byte-scan; commit.

### Task 5: Shell rewire + retire tree

**Files:** Modify `admin/tenant-portal/src/tenant-app.ts` (CRLF — preserve); `admin/tenant-portal/src/tenant-types.ts` (if `ITenantNavigator.ShowTree` is removed). Test: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF).

**Interfaces — Consumes:** `EnvironmentsView` (Task 3), `CreateEnvironmentDialog` (Task 4). **Produces:** `ShowEnvironments()` builds `EnvironmentsView`; `OnTenantEvent` forwards to it; `ShowEnvironmentDetail`/`MarkEnvironmentsActive` unchanged; tree host removed.

- [ ] **Step 1:** Write/adjust failing tests: after `ShowSection(Environments)` (or Boot→Overview then Environments), the shown view is an `EnvironmentsView` (not `TenantTreeView`); an `environment-created` event while Environments is active reloads the list (VM reload observed); `ShowEnvironmentDetail(env)` still works and keeps Environments active; the shell no longer references `TenantTreeView`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Rewire `ShowEnvironments` to build `EnvironmentsView(new EnvironmentsViewModel(this.client))`; set the live-event host marker to the new view (replace the `this.tree` mechanism with an `environments` reference or generalize to the active view's `ApplyEvent`); route `OnTenantEvent` to `environments?.ApplyEvent(ev)` when Environments is active, preserving the deleted-open-env→Environments fallback; remove `tree`/`ShowTree` usage. Leave `tenant-tree-view*.ts` and `hive-detail-view.ts` files in place but unreferenced (R6). Open the Create dialog from the view (wire `onCreated`→`ShowEnvironmentDetail`).
- [ ] **Step 4:** Run the full portal suite + `typecheck` + `typecheck:tools`; byte-scan (tenant-app.ts stays CRLF); commit.

## Self-review notes

- Spec coverage: enums+client+fake (T1), VM+row join/search/selection/bulk/events (T2), view grid/search/bulk/states/gating (T3), create dialog (T4), shell rewire + tree retire (T5). All design goals mapped.
- Type consistency: `IEnvironmentsSource` defined in T1 consumed by T2/T3; `EnvironmentRow.Dto` feeds `ShowEnvironmentDetail`; enums are the single source for status/template/type across VM, view, dialog, fake.
- Proportion: plan carries the enum values, create body/errors, PillKind map, capability gate, and health-join rules verbatim; bodies left to the implementer.
