# PA-6 Platform Admin Tenants (list + detail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tenants placeholder with a kit global Tenants list and a tenant detail page (with the one-tenant-one-hive relationship and an ObservedPanel environment inventory) on existing control-plane data.

**Architecture:** Pure derivation view-models over existing DTOs (mirror `FleetViewModel`/PA-5); a self-routing `TenantsView` (List/Detail, no Create - creation defers to the PA-8 wizard); connection state reuses `FleetViewModel`; a shared `PortalDates.Label` date formatter. No backend change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Mural, `Observable` from `@pragmatic-tech-ai/todl-runtime`, `node:test` + `Application.current`.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-tenants-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; VMs extend `Observable`; enums over unions; `IDisposable` not lambdas.
- No inline user-facing/reused string literals - hoist to `private static readonly` (test-data literals in tests are fine).
- New `.ts` pure ASCII + LF. After every write byte-scan `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. Escape non-ASCII `\uXXXX` and RE-SCAN. Match the EOL of touched files.
- Tests under `admin/portal/tests/`.
- No change to `admin/control-plane/**`, legacy `tenant-list-view.ts`/`create-tenant-view.ts`, or `docs/design/`.
- No `admin/tenant-portal` import; never surface `ownerEmail`/`ownerPrincipalId` or any raw internal ref.
- Gate (green on merged result): `admin/portal` `npm test` + `npm run typecheck`; repo-root `npm run typecheck:tools`.
- Every actionable control keyboard-reachable; status icon + text via `StatusPill`.
- Stateful views MUST survive a second `Refresh()` (fresh content slot each render).

## Review Focus

- Tenant with no hive -> "No hive yet"/Awaiting + empty Environments, no crash. (Task 3 + Task 4.)
- Tenant whose `clientId` matches no client -> "(unknown client)". (Task 2.)
- Observed env `ready === false` -> Failing (not Healthy) pill; `image` absent -> "-". (Task 4.)
- Missing/empty `createdAt` -> "Unknown", not "Invalid Date". (Task 1.)
- Second `Refresh()` re-renders list and detail, no double-parent throw. (Task 5.)

---

### Task 1: Shared `PortalDates` + `TenantDto.createdAt` + PA-5 delegation

**Files:**
- Create: `admin/portal/src/portal-dates.ts`
- Modify: `admin/portal/src/portal-types.ts` (`TenantDto`)
- Modify: `admin/portal/src/client-detail-view-model.ts` (`ClientSinceLabel` delegates)
- Test: `admin/portal/tests/portal-dates.test.ts`

**Interfaces:**
- Produces: `class PortalDates { public static Label(iso: string | undefined): string }` - returns `'Unknown'` when `iso` is undefined/empty or `Number.isNaN(new Date(iso).getTime())`, else `new Date(iso).toISOString().slice(0, 10)`. `TenantDto` gains `createdAt?: string` (OPTIONAL).
- Consumes: `ClientDetailViewModel.ClientSinceLabel(iso: string)` becomes `return PortalDates.Label(iso)`.

- [ ] **Step 1: Write failing test** `portal-dates.test.ts`:
```ts
assert.equal(PortalDates.Label('2026-01-02T03:04:05.000Z'), '2026-01-02')
assert.equal(PortalDates.Label(''), 'Unknown')
assert.equal(PortalDates.Label(undefined), 'Unknown')
assert.equal(PortalDates.Label('not-a-date'), 'Unknown')
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Create `portal-dates.ts`; add `createdAt?: string` to `TenantDto`; change `ClientDetailViewModel.ClientSinceLabel` body to delegate to `PortalDates.Label`.** Keep `ClientSinceLabel` (PA-5 call sites + tests depend on it). Byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck` in `admin/portal` and `npm run typecheck:tools` from root; expect green** (all existing client tests still pass). Commit.

---

### Task 2: `TenantsViewModel` (global list roll-up)

**Files:**
- Create: `admin/portal/src/tenants-view-model.ts`
- Test: `admin/portal/tests/tenants-view-model.test.ts`

**Interfaces:**
- Consumes: `TenantDto`, `ClientDto`, `FleetHiveDto` (`./portal-types.js`); `FleetViewModel`, `FleetConnection` (`./fleet-view-model.js`); `PortalDates` (`./portal-dates.js`).
- Produces:
  `interface TenantListRow { id: string; displayName: string; clientId: string; clientName: string; hiveName: string; connection: FleetConnection; lastSeenLabel: string; observedEnvCount: number; createdAt: string | undefined }`
  `class TenantsViewModel extends Observable` with `constructor(tenants: TenantDto[], clients: ClientDto[], fleet: FleetHiveDto[], now?: () => Date, quietThresholdMs?: number)`, `get Rows(): readonly TenantListRow[]`, `Update(tenants, clients, fleet): void` raising `RowsProperty`.

**Derivation:** a `clientId -> displayName` map from `clients` ("(unknown client)" fallback via a hoisted constant); a `FleetViewModel(fleet, now, quietThresholdMs)` indexed by hive id for `connection`/`lastSeenLabel`. For each tenant: hive = `fleet.find(h => h.tenant?.id === tenant.id)`; when found -> `hiveName` = hive.displayName, connection/lastSeen from the indexed row, `observedEnvCount` = `hive.environments.length`; when absent -> `hiveName` = `'No hive yet'`, `connection` = `FleetConnection.Awaiting`, `lastSeenLabel` = `'Awaiting first dial-in'`, `observedEnvCount` = 0. Hoist all labels.

- [ ] **Step 1: Write failing tests**: three tenants (connected hive / awaiting-no-hive / hive on another tenant), one tenant with an unknown clientId -> assert `Rows` length, a row's `clientName`, `hiveName`, `connection`, `observedEnvCount`, the `'(unknown client)'` fallback, and `Update` re-derivation.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run tests + typecheck, pass.** Commit.

---

### Task 3: `TenantDetailViewModel`

**Files:**
- Create: `admin/portal/src/tenant-detail-view-model.ts`
- Test: `admin/portal/tests/tenant-detail-view-model.test.ts`

**Interfaces:**
- Consumes: as Task 2, plus nothing new.
- Produces:
  `interface TenantEnvRow { name: string; ready: boolean; image: string; detail: string }`
  `interface TenantBinding { hasHive: boolean; hiveName: string; connection: FleetConnection; lastSeenLabel: string; cluster: string }`
  `class TenantDetailViewModel extends Observable` with `constructor(tenant: TenantDto, clients: ClientDto[], fleet: FleetHiveDto[], now?: () => Date, quietThresholdMs?: number)`, `get Tenant(): TenantDto`, `get ClientName(): string`, `get Binding(): TenantBinding`, `get EnvRows(): readonly TenantEnvRow[]`.

**Derivation:** `ClientName` from the clients map ("(unknown client)"). hive = `fleet.find(h => h.tenant?.id === tenant.id)`. `Binding`: when hive present -> `hasHive: true`, `hiveName`, connection/lastSeen from a `FleetViewModel` indexed row, `cluster` = `hive.clusterBackend + ' / ' + hive.clusterMode`; when absent -> `hasHive: false`, `hiveName: 'No hive yet'`, `FleetConnection.Awaiting`, `'Awaiting first dial-in'`, `cluster: '-'`. `EnvRows` = `(hive?.environments ?? []).map(e => ({ name: e.name, ready: e.ready, image: e.image ?? '-', detail: e.detail }))`. Hoist labels (`'No hive yet'`, `'Awaiting first dial-in'`, `'-'`, `' / '`, `'(unknown client)'`).

- [ ] **Step 1: Write failing tests**: a tenant with a hive that has one ready + one not-ready env -> `EnvRows` length 2, the not-ready row `ready === false`, `image === '-'` when the DTO image is undefined, `Binding.hasHive === true`, `cluster` formatted; a tenant with no hive -> `Binding.hasHive === false`, `hiveName === 'No hive yet'`, `EnvRows` empty; unknown client -> `ClientName === '(unknown client)'`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run tests + typecheck, pass.** Commit.

---

### Task 4: `TenantDetailView` (ObservedPanel first consumer)

**Files:**
- Create: `admin/portal/src/tenant-detail-view.ts`
- Test: `admin/portal/tests/tenant-detail-view.test.ts`

**Interfaces:**
- Consumes: `TenantDetailViewModel`, `TenantEnvRow` (`./tenant-detail-view-model.js`); `FleetPresentation` (`./fleet-presentation.js`); `FleetConnection` (`./fleet-view-model.js`); kit `PageHeader`, `Section`, `KeyValueGrid`, `ObservedPanel`, `DataTable`, `TableDensity`, `ScreenHost`, `ScreenState`, `PillKinds`, `PillKind`, `PillTone`, `KeyActivatedButton` + types `ScreenHostInputs`, `TableColumn`.
- Produces: `class TenantDetailView extends StackPanel`, `constructor(vm: TenantDetailViewModel, onBack: () => void)`, seams `get Host(): ScreenHost`, `get EnvTable(): DataTable<TenantEnvRow> | undefined`.

**Shape (mirror `client-detail-view.ts`):** `ScreenHost` populated (VM preloaded); content built by `BuildContent()` which REBUILDS a fresh env-table slot each call. Content order: a "Back to tenants" `KeyActivatedButton` -> `onBack`; `PageHeader({ breadcrumb: ['Tenants', vm.Tenant.displayName], title: vm.Tenant.displayName })`; a "Hive binding" `Section` whose body is a `KeyValueGrid` with items Client (`vm.ClientName`), Hive (`vm.Binding.hiveName`), Connection (`PillKinds.For(FleetPresentation.ConnectionKind(vm.Binding.connection)).label + ' - ' + vm.Binding.lastSeenLabel`), Cluster (`vm.Binding.cluster`); then an `ObservedPanel({ title: 'Environments', body: <fresh DataTable> })`. The env `DataTable<TenantEnvRow>` (Dense) columns: Environment (`name`, sortable localeCompare), Status (`PillKinds.For(r.ready ? PillKind.Healthy : PillKind.Failing).label`; `tone` = `r.ready ? undefined : PillTone.Danger`), Image (`image`), Detail (`detail`); `emptyText` `'No environments observed.'`; `searchText` = `name`. Hoist every literal.

- [ ] **Step 1: Write failing tests** (`Application.current` harness): a VM with a hive + 2 envs -> `Host.State === ScreenState.Populated`, `EnvTable?.Rows.length === 2`; a no-hive VM -> `EnvTable?.Rows.length === 0`, no throw; back button invokes `onBack`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`, pass.** Commit.

---

### Task 5: `TenantsView` (list + detail routing) and shell wiring

**Files:**
- Create: `admin/portal/src/tenants-view.ts`
- Modify: `admin/portal/src/app.ts` (`ShowSection` Tenants arm + import)
- Test: `admin/portal/tests/tenants-view.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient` (`./api-client.js`); `TenantsViewModel`, `TenantListRow` (`./tenants-view-model.js`); `TenantDetailViewModel` (`./tenant-detail-view-model.js`); `TenantDetailView` (`./tenant-detail-view.js`); `FleetPresentation`; `FleetConnection`; `PortalDates`; `TenantDto`, `IPortalNavigator`, `IPortalView` (`./portal-types.js`); kit `PageHeader`, `DataTable`, `TableDensity`, `ScreenHost`, `ScreenState`, `PillKinds`, `PillTone` + types `ScreenHostInputs`, `TableColumn`.
- Produces: `class TenantsView extends StackPanel implements IPortalView`, `constructor(client: ControlPlaneClient)`, enum `TenantsMode { List, Detail }`, `AttachNavigator(nav)`, `Refresh(): Promise<void>`, seams `get Host(): ScreenHost`, `get Table(): DataTable<TenantListRow> | undefined`, `get Mode(): TenantsMode`.

**Behaviour (mirror `clients-view.ts`, minus Create):** a content host rebuilt fresh per render; `Refresh()` re-runs the active mode (List -> reload; Detail -> reload the open tenant). 
- **List** (`ShowList`): fetch `ListTenants()` + `ListClients()` + `ListFleet()` via `Promise.all`; build/`Update` a `TenantsViewModel`; `ScreenHost` loading -> error (on reject; `onRetry` -> `Refresh`) -> empty (`'No tenants yet.'`) -> populated. Populated content: `PageHeader({ breadcrumb: ['Provisioning', 'Tenants'], title: 'Tenants' })` (NO primary action) + a fresh `DataTable<TenantListRow>` with columns Tenant (`displayName`, sortable), Client (`clientName`, sortable), Hive (`hiveName`), Connection (pill label + ' - ' + lastSeen, tone undefined when Connected else the pill tone), Envs (`String(observedEnvCount)`, sortable numeric), Created (`PortalDates.Label(createdAt)`); `searchText` = `displayName + ' ' + id + ' ' + clientName`; `onOpen` -> `ShowDetail(row)`; `emptyText` `'No tenants match.'`.
- **Detail** (`ShowDetail(row: TenantListRow)`): build a `TenantDto` from the row (`{ id, displayName, clientId, createdAt }`); fetch `ListClients()` + `ListFleet()` inside a try/catch (on reject -> stale-guard then fall back to the list error state, like `ClientsView.ShowDetail`); construct a `TenantDetailViewModel` and swap in `new TenantDetailView(vm, () => void this.ShowList())`; set `Mode = Detail`. Keep a stale-guard (`mode`/`detailRow` identity) after the await.

**app.ts:** import `TenantsView`; in `ShowSection`, before the `ComingSoon` fallback:
```ts
if (section === PaSection.Tenants)
{
    this.Mount(new TenantsView(this.client))
    return
}
```
`app.ts` is LF - match it. Update `shell-app.test.ts` if it asserts Tenants routes to the placeholder (expect `TenantsView` now, like the PA-5 Clients change).

- [ ] **Step 1: Write failing tests** (`FakeClient as unknown as ControlPlaneClient`, `Application.current`): list populated (`Mode===List`, `Host.State===Populated`, `Table?.Rows.length` = tenant count); empty tenants -> `Host.State===Empty`; a rejected fetch -> `Host.State===Error`; open a row (`Table?.FocusRow(0)`+`ActivateFocused()`, flush) -> `Mode===Detail`; detail fetch rejects -> falls back to `Mode===List` + `Host.State===Error`; a SECOND `Refresh()` keeps `Host.State===Populated`, no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `tenants-view.ts` + wire `app.ts` (+ shell-app.test.ts expectation).** Byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck` in `admin/portal` and `npm run typecheck:tools` from root; expect green.** Commit.

---

## Self-review notes

- Spec coverage: shared date (T1), list (T2/T5), detail + ObservedPanel (T3/T4/T5), 1:1 binding (T3/T4), no-create deferral (by design, no task). Deferred items carry no task.
- Type consistency: `TenantListRow`/`TenantEnvRow`/`TenantBinding` produced in T2/T3 consumed verbatim in T4/T5; `PortalDates.Label` (T1) used in T2/T5 and T1 retrofit; `FleetPresentation.ConnectionKind` (PA-4) used in T4/T5.
- Proportion: five focused tasks; code blocks are signatures/assertions only.
