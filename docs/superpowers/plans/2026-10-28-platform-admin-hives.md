# PA-7 Platform Admin Hives (list + detail skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Hives placeholder with a kit navigable global Hives list and a hive detail skeleton (header, connection banner, Home-channel KV, observed environments) on existing `ListFleet()` data, deferring all backend-gap features.

**Architecture:** Pure derivation view-models reusing `FleetViewModel`; a self-routing `HivesView` (List/Detail, no Create); a shared `ObservedEnvTable` extracted from PA-6's `TenantDetailView` and reused by both detail views. No backend change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Mural, `Observable` from `@pragmatic-tech-ai/todl-runtime`, `node:test` + `Application.current`.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-hives-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; VMs extend `Observable`; enums over unions.
- No inline user-facing/reused string literals - hoist to `private static readonly` (test literals are fine).
- New `.ts` pure ASCII + LF. Byte-scan after every write `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. Escape non-ASCII `\uXXXX` and RE-SCAN. Match EOL of touched files.
- Tests under `admin/portal/tests/`.
- No change to `admin/control-plane/**`, legacy `hive-list-view.ts`/`create-hive-view.ts`, or `docs/design/`.
- No `admin/tenant-portal` import; never surface `configRef`/`credentialRef`/`trustRootRef`/`agentTokenRef` or any raw internal ref; no token-op control (G4).
- Gate (green on merged result): `admin/portal` `npm test` + `npm run typecheck`; repo-root `npm run typecheck:tools`.
- Every actionable control keyboard-reachable; status icon + text. Stateful views survive a second `Refresh()` in BOTH modes.

## Review Focus

- Awaiting hive (lastSeen null) -> Awaiting + awaiting banner + empty envs, no crash, no doubled Connection label. (Task 2/4/5.)
- Quiet hive -> Warning banner "nothing to retry from here" + still shows last observed envs. (Task 3/4.)
- Observed env `ready === false` -> Failing pill + `image ?? '-'`. (Task 1.)
- No Rotate/Revoke/Re-issue, no Credentials/Components/Activity, no internal ref anywhere in detail. (Task 4 / review.)
- Second `Refresh()` in list and detail -> no double-parent throw. (Task 5.)

---

### Task 1: Shared `ObservedEnvTable` (extract from PA-6)

**Files:**
- Create: `admin/portal/src/observed-env-table.ts`
- Modify: `admin/portal/src/tenant-detail-view.ts` (use the shared table)
- Test: `admin/portal/tests/observed-env-table.test.ts`

**Interfaces:**
- Consumes: kit `DataTable`, `TableDensity`, `PillKind`, `PillKinds`, `PillTone`; type `TableColumn`.
- Produces: `interface ObservedEnvRow { name: string; ready: boolean; image: string; detail: string }` and `class ObservedEnvTable { public static Build(rows: readonly ObservedEnvRow[]): DataTable<ObservedEnvRow> }` - Dense; columns Environment (`name`, sort localeCompare), Status (`PillKinds.For(r.ready ? PillKind.Healthy : PillKind.Failing).label`, `tone` = `r.ready ? undefined : PillTone.Danger`), Image (`image`), Detail (`detail`); `emptyText` 'No environments observed.'; `searchText` = `name`. All literals hoisted.

- [ ] **Step 1: Write failing test** `observed-env-table.test.ts` (`Application.current` harness like the other view tests): build a table from two rows (one ready, one not) -> `Rows.length === 2`; empty rows -> table builds, `Rows.length === 0`, no throw. (Tone is a declarative column accessor; assert via rows length + that a `DataTable` is returned, consistent with sibling view tests.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `observed-env-table.ts`; refactor `tenant-detail-view.ts`** to replace its private env columns/`DataTable` construction with `ObservedEnvTable.Build(this.vm.EnvRows)` (its `TenantEnvRow` is structurally `ObservedEnvRow`). Keep `TenantDetailView`'s `EnvTable` seam working (it returns the DataTable child of the slot). Byte-scan both.
- [ ] **Step 4: Run `npm test` + `npm run typecheck` in `admin/portal` and `npm run typecheck:tools` from root; expect green** (all PA-6 tenant-detail tests still pass). Commit.

---

### Task 2: `HivesViewModel` (global hive list)

**Files:**
- Create: `admin/portal/src/hives-view-model.ts`
- Test: `admin/portal/tests/hives-view-model.test.ts`

**Interfaces:**
- Consumes: `FleetHiveDto` (`./portal-types.js`); `FleetViewModel`, `FleetConnection`, `FleetRow` (`./fleet-view-model.js`).
- Produces: `interface HiveListRow { id: string; displayName: string; ownerLabel: string; cluster: string; connection: FleetConnection; lastSeenLabel: string; envCount: number; notReadyCount: number }` and `class HivesViewModel extends Observable` with `constructor(fleet: FleetHiveDto[], now?: () => Date, quietThresholdMs?: number)`, `get Rows(): readonly HiveListRow[]`, `Update(fleet): void` raising `RowsProperty`.

**Derivation:** build one `FleetViewModel(fleet, now, quietThresholdMs)` and index its `Rows` by `id`. For each `FleetHiveDto` in `fleet`, take `displayName`/`ownerLabel`/`connection`/`lastSeenLabel`/`envCount`/`notReadyCount` from the indexed `FleetRow` and `cluster = dto.clusterBackend + ' / ' + dto.clusterMode` (hoisted separator). Preserve fleet order.

- [ ] **Step 1: Write failing tests**: a fleet of three hives (connected / quiet [stale lastSeen] / awaiting [null]) with a pinned `now` -> assert `Rows.length === 3`, a row's `cluster` ('k8s / managed'), `ownerLabel`, `connection`, `envCount`/`notReadyCount`; `Update(...)` re-derives + raises `RowsProperty`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run tests + typecheck, pass.** Commit.

---

### Task 3: `HiveDetailViewModel`

**Files:**
- Create: `admin/portal/src/hive-detail-view-model.ts`
- Test: `admin/portal/tests/hive-detail-view-model.test.ts`

**Interfaces:**
- Consumes: `FleetHiveDto`, `FleetEnvDto` (`./portal-types.js`); `FleetViewModel`, `FleetConnection` (`./fleet-view-model.js`); `ObservedEnvRow` (`./observed-env-table.js`); `BannerTone` (`./kit/index.js`); `KeyValueItem` (`./kit/index.js`).
- Produces: `interface HiveBannerState { show: boolean; tone: BannerTone; text: string }` and `class HiveDetailViewModel extends Observable` with `constructor(hive: FleetHiveDto, now?: () => Date, quietThresholdMs?: number)`, getters `Hive(): FleetHiveDto`, `OwnerLabel(): string`, `Cluster(): string`, `Connection(): FleetConnection`, `LastSeenLabel(): string`, `Banner(): HiveBannerState`, `HomeChannel(): readonly KeyValueItem[]`, `EnvRows(): readonly ObservedEnvRow[]`.

**Derivation:** a `FleetViewModel([hive], now, quietThresholdMs)` (or over a single-element fleet) gives the `FleetRow` for `connection`/`lastSeenLabel`/`ownerLabel`/`envCount`/`notReadyCount`. `Cluster = backend + ' / ' + mode`. `Banner`: Quiet -> `{ show:true, tone: BannerTone.Warning, text: '<hive> has not checked in for a while. Its last report stands. Pragmatic cannot connect in, so there is nothing to retry from here.' }` (build with the display name); Awaiting -> `{ show:true, tone: BannerTone.Info, text: 'Awaiting first dial-in.' }`; Connected -> `{ show:false, tone: BannerTone.Info, text: '' }`. `HomeChannel` KV: Connection (`FleetPresentation`/pill label + ' - ' + lastSeen OR just the pill label + last-seen text), Last check-in (`lastSeenLabel`), Cluster, Environments observed (`String(envCount)`). `EnvRows` = `hive.environments.map(e => ({ name: e.name, ready: e.ready, image: e.image ?? '-', detail: e.detail }))`. Hoist all literals/templates.

- [ ] **Step 1: Write failing tests**: (a) a quiet hive (stale lastSeen, pinned now) -> `Banner.show === true`, `Banner.tone === BannerTone.Warning`, text contains the hive name and "nothing to retry"; `HomeChannel` has the four keys; (b) an awaiting hive (lastSeen null) -> `Banner.tone === BannerTone.Info`, `EnvRows` empty; (c) a connected hive with 2 envs (one not-ready, one image-less) -> `Banner.show === false`, `EnvRows.length === 2`, not-ready row `ready===false`, image-less row `image==='-'`, `Cluster` formatted.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run tests + typecheck, pass.** Commit.

---

### Task 4: `HiveDetailView`

**Files:**
- Create: `admin/portal/src/hive-detail-view.ts`
- Test: `admin/portal/tests/hive-detail-view.test.ts`

**Interfaces:**
- Consumes: `HiveDetailViewModel` (`./hive-detail-view-model.js`); `ObservedEnvTable`, `ObservedEnvRow` (`./observed-env-table.js`); kit `PageHeader`, `Section`, `KeyValueGrid`, `ObservedPanel`, `Banner`, `ScreenHost`, `ScreenState`, `KeyActivatedButton` + types `ScreenHostInputs`.
- Produces: `class HiveDetailView extends StackPanel`, `constructor(vm: HiveDetailViewModel, onBack: () => void)`, seams `get Host(): ScreenHost`, `get EnvTable(): DataTable<ObservedEnvRow> | undefined`.

**Shape (mirror `tenant-detail-view.ts`):** `ScreenHost` populated; `BuildContent()` rebuilds a fresh env-table slot each call. Order: "Back to hives" `KeyActivatedButton` -> onBack; `PageHeader({ breadcrumb: ['Hives', vm.Hive.displayName], title: vm.Hive.displayName })`; if `vm.Banner.show` a `new Banner({ tone: vm.Banner.tone, text: vm.Banner.text })`; a "Home channel" `Section` body `new KeyValueGrid({ items: vm.HomeChannel })`; an `ObservedPanel({ title: 'Observed environments', body: <fresh slot> })` into which you add `ObservedEnvTable.Build(vm.EnvRows)`. Hoist literals ('Back to hives', 'Home channel', 'Observed environments').

- [ ] **Step 1: Write failing tests** (`Application.current`): a connected VM with 2 envs -> `Host.State===Populated`, `EnvTable?.Rows.length===2`, and the tree contains an `ObservedPanel` titled 'Observed environments'; a quiet VM -> the tree contains a `Banner`; an awaiting VM -> `EnvTable?.Rows.length===0`, no throw; back button invokes `onBack`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`, pass.** Commit.

---

### Task 5: `HivesView` (list + detail routing) and shell wiring

**Files:**
- Create: `admin/portal/src/hives-view.ts`
- Modify: `admin/portal/src/app.ts` (`ShowSection` Hives arm + import)
- Test: `admin/portal/tests/hives-view.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient` (`./api-client.js`); `HivesViewModel`, `HiveListRow` (`./hives-view-model.js`); `HiveDetailViewModel` (`./hive-detail-view-model.js`); `HiveDetailView` (`./hive-detail-view.js`); `FleetPresentation`, `FleetConnection` (`./fleet-*.js`); `FleetHiveDto`, `IPortalNavigator`, `IPortalView` (`./portal-types.js`); kit `PageHeader`, `DataTable`, `TableDensity`, `ScreenHost`, `ScreenState`, `PillKinds`, `PillTone`, `PillEntry` + types `ScreenHostInputs`, `TableColumn`.
- Produces: `class HivesView extends StackPanel implements IPortalView`, `constructor(client: ControlPlaneClient)`, enum `HivesMode { List, Detail }`, `AttachNavigator(nav)`, `Refresh()`, seams `get Host(): ScreenHost`, `get Table(): DataTable<HiveListRow> | undefined`, `get Mode(): HivesMode`.

**Behaviour (copy the hardened `tenants-view.ts`, swapping tenant->hive and dropping the client/tenant fetches - only `ListFleet()` is needed):**
- **List** (`ShowList`): `ListFleet()`; build/`Update` a `HivesViewModel`; ScreenHost loading -> error (reject; `onRetry` -> `Refresh`) -> empty ('No hives yet.') -> populated. Content: `PageHeader({ breadcrumb: ['Provisioning', 'Hives'], title: 'Hives' })` (NO primaryAction) + fresh `DataTable<HiveListRow>`: Hive (`displayName`, sort localeCompare), Client / tenant (`ownerLabel`, sort localeCompare), Cluster (`cluster`), Connection (`PillKinds.For(FleetPresentation.ConnectionKind(r.connection)).label + ' - ' + r.lastSeenLabel`; tone undefined when Connected else the pill tone), Health (`PillKinds.For(r.notReadyCount > 0 ? PillKind.Failing : PillKind.Healthy).label`; tone Danger when `notReadyCount > 0`), Envs (`String(r.envCount)`, sort numeric); `searchText` = `displayName + ' ' + ownerLabel`; `onOpen` -> `ShowDetail(row)`; `emptyText` 'No hives match.'
- **Detail** (`ShowDetail(row: HiveListRow)`): set Mode=Detail, remember row; inside try/catch `await this.client.ListFleet()`, find `fleet.find(h => h.id === row.id)`; on reject OR not-found, respecting the stale-guard, fall back to the list error state (copy `tenants-view` ShowDetail); on success + guard-ok, swap `new HiveDetailView(new HiveDetailViewModel(hive), () => void this.ShowList())`.
- Hoist all literals.

**app.ts:** import `HivesView`; in `ShowSection`, before the `ComingSoon` fallback:
```ts
if (section === PaSection.Hives)
{
    this.Mount(new HivesView(this.client))
    return
}
```
`app.ts` is LF. Update `shell-app.test.ts` Hives routing expectation to expect `HivesView` (like PA-5/PA-6).

- [ ] **Step 1: Write failing tests** (`FakeClient` returning fixed fleet; `Application.current`): list populated (`Mode===List`, `Host.State===Populated`, `Table?.Rows.length` = hive count); empty fleet -> `Host.State===Empty`; rejected fetch -> `Host.State===Error`; open a hive (`Table?.FocusRow(0)`+`ActivateFocused()`, flush) -> `Mode===Detail` and a `HiveDetailView` is mounted; detail fetch rejects -> `Mode===List` + `Host.State===Error`; a SECOND `Refresh()` in list AND after opening detail keeps the right state with no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `hives-view.ts` + wire `app.ts` (+ shell-app.test.ts).** Byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck` in `admin/portal` and `npm run typecheck:tools` from root; expect green.** Commit.

---

## Self-review notes

- Spec coverage: shared env table (T1), list (T2/T5), detail skeleton + banner + ObservedPanel (T3/T4/T5). Deferred items (token ops/components/credentials/activity/tabs/create) carry no task by design.
- Type consistency: `ObservedEnvRow` (T1) consumed by T3/T4; `HiveListRow` (T2) by T5; `HiveDetailViewModel` (T3) by T4/T5.
- Proportion: five focused tasks; code blocks are signatures/assertions only. Honesty: no token/credential/component control; no internal ref; observational banners only.
