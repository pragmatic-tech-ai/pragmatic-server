# PA-5 Platform Admin Clients (list, create, detail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Clients placeholder with a kit-based Clients list, create form, and detail page, all on existing control-plane data, with mutations gated for Observers.

**Architecture:** Pure derivation view-models (take DTOs, mirror `FleetViewModel`); a self-routing `ClientsView` section container swaps list/create/detail; connection state reuses `FleetViewModel`; the `FleetConnection -> PillKind` mapping is extracted to one shared home. No backend change - `createdAt` is already on the wire.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Mural (`@pragmatic-tech-ai/mural`), `Observable` from `@pragmatic-tech-ai/todl-runtime`, `node:test` + `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-clients-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; VMs extend `Observable`; enums over unions; `IDisposable` not lambdas.
- No inline user-facing/reused string literals - hoist to `private static readonly` on the class (test-data literals in tests are fine).
- New `.ts` pure ASCII + LF. After every write byte-scan with `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> must be `0 0 N`. Escape non-ASCII as `\uXXXX` and RE-SCAN after the Write tool. Match the EOL of any existing file touched; never flip it.
- Tests live under `admin/portal/tests/`.
- No change to `admin/control-plane/**`, to the legacy `client-list-view.ts`/`create-client-view.ts`, or to `docs/design/`.
- No cross-app import (`admin/portal` must not import `admin/tenant-portal`); never expose a raw server-side internal ref.
- Gate (green on the merged result): in `admin/portal`, `npm test` and `npm run typecheck`; from repo root, `npm run typecheck:tools` (typechecks both portals).
- Every actionable control keyboard-reachable (derive from `KeyActivatedButton`/`Act`); every status icon + text via `StatusPill`, never colour alone.
- Stateful views MUST survive a second `Refresh()` - build a fresh content slot each render (a Visual holds exactly one parent).

## Review Focus

- A client with zero tenants/hives -> counts of 0 and an honest empty "Tenants and hives" table, no crash. (Task 3 + Task 4 tests.)
- A tenant with no hive -> an Awaiting connection and "No hive yet", never an undefined/blank row. (Task 3 test.)
- "Create client" visible-but-disabled with the needed-role hint for an Observer, never submits. (Task 5 test.)
- A second `Refresh()` re-renders list and detail with no double-parent throw. (Task 5 test.)
- Absent/malformed `createdAt` -> a readable "Client since" label, not `Invalid Date`. (Task 3 test.)

---

### Task 1: Foundations - `ClientDto.createdAt`, `FleetPresentation`, Fleet reuse

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`ClientDto`)
- Create: `admin/portal/src/fleet-presentation.ts`
- Modify: `admin/portal/src/fleet-view.ts` (reuse the shared mapping)
- Test: `admin/portal/tests/fleet-presentation.test.ts`

**Interfaces:**
- Consumes: `FleetConnection` (`./fleet-view-model.js`), `PillKind` (`./kit/index.js`).
- Produces: `ClientDto = { id: string; displayName: string; subscriptionRef?: string; createdAt: string }`. `class FleetPresentation { public static ConnectionKind(c: FleetConnection): PillKind }` mapping `Connected -> PillKind.Connected`, `Quiet -> PillKind.Quiet`, else (`Awaiting`) `-> PillKind.Awaiting`.

- [ ] **Step 1: Write the failing test** `admin/portal/tests/fleet-presentation.test.ts`

```ts
// asserts all three FleetConnection values map to the matching PillKind
assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Connected), PillKind.Connected)
assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Quiet), PillKind.Quiet)
assert.equal(FleetPresentation.ConnectionKind(FleetConnection.Awaiting), PillKind.Awaiting)
```

- [ ] **Step 2: Run it, verify it fails** (`FleetPresentation` not defined). From `admin/portal`: `npm test`.
- [ ] **Step 3: Add `createdAt: string` to `ClientDto`** in `portal-types.ts` (it is already serialised server-side; the type merely omitted it).
- [ ] **Step 4: Create `fleet-presentation.ts`** with `FleetPresentation.ConnectionKind` (hoist nothing - it is a pure switch over the enum).
- [ ] **Step 5: Rewire `fleet-view.ts`** - `FleetView.ConnectionKind` delegates to `FleetPresentation.ConnectionKind` (behaviour unchanged; keep `HealthKind` as-is). Byte-scan touched/new files.
- [ ] **Step 6: Run `npm test` + `npm run typecheck` in `admin/portal`; expect green** (existing fleet-view tests still pass). Commit.

---

### Task 2: `ClientsViewModel` (list roll-up)

**Files:**
- Create: `admin/portal/src/clients-view-model.ts`
- Test: `admin/portal/tests/clients-view-model.test.ts`

**Interfaces:**
- Consumes: `ClientDto`, `TenantDto`, `FleetHiveDto` (`./portal-types.js`); `FleetViewModel`, `FleetConnection` (`./fleet-view-model.js`).
- Produces:
  `interface ClientListRow { id: string; displayName: string; subscriptionRef: string | undefined; createdAt: string; tenantCount: number; hiveCount: number; connectionSummary: string }`
  `class ClientsViewModel extends Observable` with
  `constructor(clients: ClientDto[], tenants: TenantDto[], fleet: FleetHiveDto[], now?: () => Date, quietThresholdMs?: number)`,
  `get Rows(): readonly ClientListRow[]`,
  `Update(clients: ClientDto[], tenants: TenantDto[], fleet: FleetHiveDto[]): void` (re-derives, raises `RowsProperty`).

**Derivation:** build one `FleetViewModel(fleet, now, quietThresholdMs)` and index its `Rows` by hive `id` to read each hive's `connection`. For each client: `tenantCount` = tenants with `clientId === client.id`; the client's hives = `fleet.filter(h => h.client?.id === client.id)`; `hiveCount` = that length; `connectionSummary` = non-zero counts of Connected/Quiet/Awaiting joined by `", "` using templates `"{n} connected"`, `"{n} quiet"`, `"{n} awaiting"`, or `"No hives"` when `hiveCount === 0`. All labels/separators/templates are `private static readonly`.

- [ ] **Step 1: Write failing tests** `clients-view-model.test.ts`:
  - three clients, mixed tenants/hives with fixed `now` and `lastSeen` -> asserts `Rows` length, and a client's `tenantCount`, `hiveCount`, and `connectionSummary` (e.g. `"1 connected, 1 quiet"`).
  - a client with no hives -> `connectionSummary === "No hives"`, `hiveCount === 0`.
  - `Update(...)` with a new fleet changes a row's `connectionSummary`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `clients-view-model.ts`.** Byte-scan.
- [ ] **Step 4: Run tests, expect pass.** Commit.

---

### Task 3: `ClientDetailViewModel`

**Files:**
- Create: `admin/portal/src/client-detail-view-model.ts`
- Test: `admin/portal/tests/client-detail-view-model.test.ts`

**Interfaces:**
- Consumes: `ClientDto`, `TenantDto`, `FleetHiveDto` (`./portal-types.js`); `FleetViewModel`, `FleetConnection` (`./fleet-view-model.js`); `KeyValueItem` (`./kit/index.js`).
- Produces:
  `interface ClientTenantRow { tenantId: string; tenantName: string; hiveName: string; connection: FleetConnection; lastSeenLabel: string; observedEnvCount: number }`
  `class ClientDetailViewModel extends Observable` with
  `constructor(client: ClientDto, tenants: TenantDto[], fleet: FleetHiveDto[], now?: () => Date, quietThresholdMs?: number)`,
  `get Client(): ClientDto`, `get Profile(): readonly KeyValueItem[]`, `get Rows(): readonly ClientTenantRow[]`.

**Derivation:** `Profile` = KV items `Client id`/`id`, `Display name`/`displayName`, `Subscription ref`/`subscriptionRef ?? "(none)"`, `Client since`/`ClientSinceLabel(createdAt)`. `ClientSinceLabel(iso)`: if `iso` is empty or `new Date(iso)` is `NaN` -> `"Unknown"`; else `new Date(iso).toISOString().slice(0, 10)`. `Rows`: index a `FleetViewModel(fleet, now, quietThresholdMs)`'s `Rows` by hive id; for each tenant in `tenants`, find its hive `fleet.find(h => h.tenant?.id === tenant.id)`; when found -> `hiveName` = hive.displayName, `connection`/`lastSeenLabel` from the indexed `FleetRow`, `observedEnvCount` = `hive.environments.length`; when absent -> `hiveName` = `"No hive yet"`, `connection` = `FleetConnection.Awaiting`, `lastSeenLabel` = `"Awaiting first dial-in"`, `observedEnvCount` = 0. Hoist all literal labels.

- [ ] **Step 1: Write failing tests**:
  - client with two tenants (one hive connected, one tenant no hive) -> `Rows` length 2; the no-hive row has `connection === FleetConnection.Awaiting`, `hiveName === "No hive yet"`, `observedEnvCount === 0`.
  - `Profile` contains the four KV keys and `Subscription ref` falls back to `"(none)"` when undefined.
  - `ClientSinceLabel`: a valid ISO -> `"2026-01-02"` shape; `""` and `"not-a-date"` -> `"Unknown"`.
  - zero tenants -> `Rows` empty, no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run tests, pass.** Commit.

---

### Task 4: `ClientDetailView`

**Files:**
- Create: `admin/portal/src/client-detail-view.ts`
- Test: `admin/portal/tests/client-detail-view.test.ts`

**Interfaces:**
- Consumes: `ClientDetailViewModel`, `ClientTenantRow` (`./client-detail-view-model.js`); `FleetPresentation` (`./fleet-presentation.js`); `PageHeader`, `Section`, `KeyValueGrid`, `DataTable`, `TableColumn`, `TableDensity`, `PillKinds`, `PillTone`, `ScreenHost`, `ScreenState`, `ScreenHostInputs`, `KeyActivatedButton` (`./kit/index.js`); `FleetConnection` (`./fleet-view-model.js`).
- Produces: `class ClientDetailView extends StackPanel` with `constructor(vm: ClientDetailViewModel, onBack: () => void)`, test seams `get Host(): ScreenHost`, `get Table(): DataTable<ClientTenantRow> | undefined`.

**Shape:** a `ScreenHost` (populated here - the VM arrives loaded). Content: a "Back to clients" `KeyActivatedButton` (-> `onBack`); `PageHeader({ breadcrumb: ["Clients", vm.Client.displayName], title: vm.Client.displayName })`; `Section` "Contract & profile" body `KeyValueGrid({ items: vm.Profile })`; `Section` "Tenants and hives" with the observed caption (`"Connection and environments are observed from each hive's last check-in."`) and body a fresh `DataTable<ClientTenantRow>` (Dense) with columns Tenant (`tenantName`), Hive (`hiveName`), Connection (`PillKinds.For(FleetPresentation.ConnectionKind(r.connection)).label + " - " + r.lastSeenLabel`; `tone` = undefined when Connected else `PillKinds.For(...).tone`), Observed envs (`String(r.observedEnvCount)`), `emptyText` `"No tenants yet."`. Rebuild the table slot fresh each render.

- [ ] **Step 1: Write failing tests** (`Application.current` harness):
  - a VM with tenants -> `Host.State === ScreenState.Populated`, `Table?.Rows.length` equals the tenant count.
  - zero tenants -> table present, `Table?.Rows.length === 0` (empty text path), no throw.
  - clicking the back button invokes `onBack`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`, pass.** Commit.

---

### Task 5: `ClientsView` (list + create + detail routing) and shell wiring

**Files:**
- Create: `admin/portal/src/clients-view.ts`
- Modify: `admin/portal/src/app.ts` (`ShowSection` Clients arm + import)
- Test: `admin/portal/tests/clients-view.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient` (`./api-client.js`); `OperatorContext` (`./operator-context.js`); `ClientsViewModel`, `ClientListRow` (`./clients-view-model.js`); `ClientDetailViewModel` (`./client-detail-view-model.js`); `ClientDetailView` (`./client-detail-view.js`); `CreateClientViewModel` (`./create-client-view-model.js`); `ClientDto`, `IPortalNavigator`, `IPortalView` (`./portal-types.js`); kit (`PageHeader`, `Section`, `DataTable`, `TableColumn`, `TableDensity`, `Act`, `ActVariant`, `ScreenHost`, `ScreenState`, `ScreenHostInputs`, `KeyActivatedButton`).
- Produces: `class ClientsView extends StackPanel implements IPortalView` with `constructor(client: ControlPlaneClient, operator: OperatorContext)`, `AttachNavigator(nav)`, `Refresh(): Promise<void>`, and test seams `get Host(): ScreenHost`, `get Table(): DataTable<ClientListRow> | undefined`, `get Mode(): ClientsMode` (enum `List|Create|Detail`), `get CreateAction(): Act | undefined`.

**Behaviour:** a content host `StackPanel` rebuilt fresh each render (second-`Refresh` safety). `Refresh()` re-runs the active mode's loader. 
- **List**: fetch `ListClients()` + `ListTenants()` + `ListFleet()` in parallel; build/`Update` a `ClientsViewModel`; `ScreenHost` (loading -> error -> empty [`"No clients yet. Create the first client to start onboarding."`] -> populated). Populated content: `PageHeader({ breadcrumb: ["Provisioning", "Clients"], title: "Clients", primaryAction: CreateAct })`; a fresh `DataTable<ClientListRow>` (columns Client=`displayName` sortable, Tenants=`String(tenantCount)` sortable, Hives=`connectionSummary`, Subscription=`subscriptionRef ?? "-"`, Client since=`createdAt.slice(0,10)`; `searchText` = displayName+id; `onOpen` -> `ShowDetail(row)`; `emptyText` `"No clients match."`). `CreateAct` = `new Act(operator.MutatingAct("Create client", () => this.ShowCreate()))`.
- **Create**: a `PageHeader({ breadcrumb: ["Clients", "New client"], title: "New client" })`, a `Section` with three `TextBox`es (id `"Client id"`, display name `"Display name"`, subscription `"Subscription ref (optional)"`), a gated submit `Act` (`operator.MutatingAct("Create", () => void this.Submit())`, Primary) and a `KeyActivatedButton` `"Cancel"` -> `ShowList`. `Submit()` sets the reused `CreateClientViewModel` fields and calls its `Submit()`; on success -> `ShowList()` (reloads); on error show an inline error `TextBlock` (no raw internals).
- **Detail**: `ShowDetail(row: ClientListRow)` builds a `ClientDto` from the row, fetches `ListTenants(row.id)` + `ListFleet()`, constructs a `ClientDetailViewModel`, and mounts a `ClientDetailView(vm, () => this.ShowList())`.

**app.ts:** import `ClientsView`; in `ShowSection`, before the `ComingSoon` fallback, add:
```ts
if (section === PaSection.Clients)
{
    const operator = this.operator
    if (operator !== undefined)
    {
        this.Mount(new ClientsView(this.client, operator))
    }
    return
}
```

- [ ] **Step 1: Write failing tests** `clients-view.test.ts` (Fake `ControlPlaneClient` returning fixed clients/tenants/fleet; `Application.current` harness):
  - list populated: `Mode === List`, `Host.State === Populated`, `Table?.Rows.length` = client count.
  - empty clients -> `Host.State === Empty`.
  - fetch rejects -> `Host.State === Error`.
  - Observer operator -> `CreateAction?.Enabled === false` and `CreateAction?.DisabledHint` names the Operator role; Operator operator -> `Enabled === true`.
  - open a client (invoke the table `onOpen` via the row) -> `Mode === Detail`.
  - a second `Refresh()` keeps `Host.State === Populated` with no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `clients-view.ts` and wire `app.ts`.** Byte-scan both; app.ts already LF - match it.
- [ ] **Step 4: Run `npm test` + `npm run typecheck` in `admin/portal` and `npm run typecheck:tools` from root; expect green.** Commit.

---

## Self-review notes

- Spec coverage: list (T2/T5), create (T5, reused VM), detail (T3/T4/T5), gating (T5), observed caption + connection reuse (T1/T4), `createdAt` surfacing (T1/T3). Deferred items (profile fields/status/activity/add-tenant/dialog/delete) carry no task by design - they are filed Features / later specs.
- Type consistency: `ClientListRow`/`ClientTenantRow` produced in T2/T3 are consumed verbatim in T4/T5; `FleetPresentation.ConnectionKind` defined in T1 used in T4.
- Proportion: five focused tasks; code blocks are signatures/assertions only.
