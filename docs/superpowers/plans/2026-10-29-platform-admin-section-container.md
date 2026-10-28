# Platform Admin section-container base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the four duplicated self-routing section views (`Clients`, `Tenants`, `Hives`, `Releases`) onto one model-agnostic `SectionContainerView<TRow>` base, fixing the `ClientsView` dead detail-retry and the asymmetric `ShowList` stale-guard in the single shared path.

**Architecture:** A new abstract `SectionContainerView<TRow> extends StackPanel implements IPortalView` owns the list/detail lifecycle (host state, fresh-per-render table slot, stale-guards, always-wired `onRetry`). Subclasses stay thin: they hold their own view-model privately and implement five protected hooks (`LoadRows`, `BuildDetail`, `Columns`, `SearchText`, `Labels`) plus an optional `ListPrimaryAction`. `ClientsView` keeps its Create form entirely locally as an opaque `Custom` state.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@pragmatic-tech-ai/mural` basic/runtime, the portal `kit`, `node:test` with the `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-section-container-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods and interfaces; enums over string-literal unions; `IDisposable` not lambdas.
- No inline user-facing / reused string literals - hoist to `private static readonly` constants (labels, column keys/headers, empty/error/table-empty text). Base-level shared text lives on the base; per-view text stays on the subclass.
- New `.ts` files: pure ASCII, LF only. Byte-scan every written `.ts` with `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> must be `0 0 N`. All touched files are already LF; do not flip EOL.
- Do NOT change any `XMode` enum's members or numeric values. Do NOT drop or rename any public seam: `Host`, `Table`, `Mode`, `CreateAction`, `SubmitAction` (Clients), and `host.State`.
- Do NOT touch `app.ts`, the detail/create views or view-models, the kit, `portal-types.ts`, `api-client.ts`, or anything under `admin/control-plane/` or `admin/tenant-portal/`.
- The base must be model-agnostic: it must NOT import or reference any concrete view-model class or any `api-client` method. All data knowledge stays in subclasses.
- Every error `ScreenHostInputs` the base produces MUST set `errorConfig.onRetry`.
- Preserve fresh-`listSlot`-per-render (second-`Refresh` safety).
- Gate: `npm test` + `npm run typecheck` in `admin/portal` green on the merged result; also `npm run typecheck:tools` at repo root (it typechecks both portals).

## Review Focus

- A detail fetch that REJECTS (throws), not merely returns not-found: base reaches the list-error fallback with a live `onRetry`, for every subclass incl. Clients. -> Task 1 (Releases, via `BuildDetail` throw) + Task 4 (Clients).
- A `ShowList` fetch resolving/rejecting AFTER navigation away (to detail or create): base paints nothing - both the success-path and the `catch`-path stale-guards. -> Task 1.
- A second `Refresh` in detail mode (re-runs `BuildDetail`, re-swaps): no double-parent throw. -> Task 1.
- `BuildDetail` returning `undefined` vs throwing: both land on the same list-error-with-retry screen. -> Task 1.
- Clients `Custom`(Create): `Refresh` is a no-op; `Mode` reports `Create`; `CreateAction`/`SubmitAction` resolve. -> Task 4 (existing Clients suite + one assertion).

---

### Task 1: `SectionContainerView<TRow>` base + re-seat `ReleasesView`

**Files:**
- Create: `admin/portal/src/section-container-view.ts`
- Rewrite: `admin/portal/src/releases-view.ts`
- Test: `admin/portal/tests/releases-view.test.ts` (keep all existing cases green; add the base-invariant cases below)

**Interfaces:**
- Produces (consumed by Tasks 2-4):
  - `export interface SectionLabels { listBreadcrumb: readonly string[]; listTitle: string; emptyTitle: string; errorTitle: string; tableEmptyText: string }`
  - `export enum SectionState { List, Detail, Custom }`
  - `export abstract class SectionContainerView<TRow> extends StackPanel implements IPortalView` with:
    - `public get Host(): ScreenHost`
    - `public get Table(): DataTable<TRow> | undefined` (first child of `listSlot` if a `DataTable`, else `undefined`)
    - `public AttachNavigator(nav: IPortalNavigator): void`
    - `public async Refresh(): Promise<void>` (Detail+detailRow -> `ShowDetail`; List -> `ShowList`; Custom -> no-op)
    - `public async ShowList(): Promise<void>`
    - `public async ShowDetail(row: TRow): Promise<void>`
    - `protected get State(): SectionState`
    - `protected SwapScreen(screen: Visual): void`
    - `protected EnterCustom(): void` (sets state `Custom`, `listMounted = false`)
    - `protected abstract LoadRows(): Promise<readonly TRow[]>`
    - `protected abstract BuildDetail(row: TRow): Promise<Visual | undefined>`
    - `protected abstract Columns(): TableColumn<TRow>[]`
    - `protected abstract SearchText(row: TRow): string`
    - `protected abstract Labels(): SectionLabels`
    - `protected ListPrimaryAction(): Act | undefined` (virtual; default `return undefined`)
- Base behavior (exact, so re-seats need not re-derive it):
  - ctor (NO args): `this.Orientation = Vertical`; `content` vertical `StackPanel`; `host = new ScreenHost({ loading: true, allowed: true, error: false, isEmpty: false })` - a bare loading host that needs NO labels, so the ctor never calls the subclass `Labels()` hook (avoids invoking an override during `super()`); `AddChild(content)`; `content.AddChild(host)`; `listMounted = true`; `state = List`; `rows = []`; `loaded = false`. `Labels()` is first read only inside `ShowList` (via `ErrorInputs`/`LoadedInputs`), long after construction.
  - `ShowList`: if `!listMounted` -> new loading host, `Swap`, `listMounted = true`. Set `state = List`, `detailRow = undefined`. If `!loaded` -> `host.Update(loading)`. `try { this.rows = await this.LoadRows(); this.loaded = true } catch { if (this.state !== List) return; this.host.Update(this.ErrorInputs()); return }`. Then `if (this.state !== List) return`. `host.Update(this.LoadedInputs())`.
  - `ShowDetail(row)`: `state = Detail`, `detailRow = row`. `let detail: Visual | undefined; try { detail = await this.BuildDetail(row) } catch { detail = undefined }`. `if (this.state !== Detail || this.detailRow !== row) return`. If `detail === undefined` -> `state = List`, `detailRow = undefined`, `listMounted = true`, `host = new ScreenHost(this.ErrorInputs())`, `Swap(host)`, return. Else `listMounted = false`, `Swap(detail)`.
  - `LoadingInputs` / `ErrorInputs` / `LoadedInputs` build `ScreenHostInputs` from `Labels()`; `ErrorInputs` and the empty/loaded error config ALWAYS set `onRetry: () => void this.Refresh()`. `LoadedInputs`: `isEmpty = this.rows.length === 0`; empty `action = this.ListPrimaryAction()`; `content = () => this.BuildList()`.
  - `BuildList`: fresh `root` vertical `StackPanel`; `PageHeader({ breadcrumb: labels.listBreadcrumb, title: labels.listTitle, primaryAction: this.ListPrimaryAction() })`; fresh `this.listSlot`; `DataTable<TRow>({ columns: this.Columns(), rows: this.rows, density: Dense, searchText: r => this.SearchText(r), onOpen: r => void this.ShowDetail(r), emptyText: labels.tableEmptyText })`; append slot to root; return root.
  - `Swap`: remove all `content` children, add `screen`.

- [ ] **Step 1: Write the base.** Create `section-container-view.ts` with the interface/enum/class above. Hoist the base-shared literals it needs (none are user-facing except via `Labels()`; the only base constant is the `DataTable` density). Pure ASCII, LF.

- [ ] **Step 2: Byte-scan the base.** Run the scan; expect `0 0 N`.

- [ ] **Step 3: Rewrite `ReleasesView` onto the base.** `export class ReleasesView extends SectionContainerView<ReleaseListRow>`. Keep `ReleasesMode { List, Detail }` and `public get Mode(): ReleasesMode { return this.State === SectionState.Detail ? ReleasesMode.Detail : ReleasesMode.List }`. Keep all `private static readonly` label/key/header constants. Implement: `Labels()` (breadcrumb `['Releases','Registry & Releases']`, title/empty/error/table-empty from the existing constants); `Columns()` (move the existing `Columns()` + `StatusPill`); `SearchText(r) => r.id + ' ' + r.image`; `LoadRows()` = `const [manifests, fleet] = await Promise.all([this.client.ListManifests(), this.client.ListFleet()]); if (this.model === undefined) this.model = new ReleasesViewModel(manifests, fleet); else this.model.Update(manifests, fleet); return this.model.Rows` (hold `private model?: ReleasesViewModel`); `BuildDetail(row)` = fetch manifests+fleet, `find(m => m.id === row.id)`; return `undefined` if not found, else `new ReleaseDetailView(new ReleaseDetailViewModel(manifest, fleet), () => void this.ShowList())`. ctor takes `(private readonly client: ControlPlaneClient)` and calls `super()` (no args). The base ctor builds only a bare loading host, so `Labels()`/`Columns()` are never invoked during `super()`; initialize the private `model` field as `undefined` (field initializer or in the ctor body after `super()`).

- [ ] **Step 4: Byte-scan `releases-view.ts`.** Expect `0 0 N`.

- [ ] **Step 5: Add base-invariant tests to `releases-view.test.ts`** (new `void test(...)` cases, same harness):
  - detail fetch rejects (make `ListManifests` throw on the detail call) -> `host.State === ScreenState.Error`, its `ErrorStatePanel.RetryButton` is present; activating it (with the API restored) recovers to `State === List` populated.
  - `BuildDetail` not-found (a row id absent from manifests) -> same list-error-with-retry screen.
  - `ShowList` rejects after navigating to detail: start a `ShowList` whose promise is pending, switch to `ShowDetail` (resolves), then let the `ShowList` reject -> the mounted screen is still the detail view (assert the detail view instance / not an error host).
  - second `Refresh` in detail mode re-renders with no throw.

- [ ] **Step 6: Run portal gate.** `cd admin/portal && npm test && npm run typecheck`; then root `npm run typecheck:tools`. All green. Commit (`refactor(platform-admin): SectionContainerView base; re-seat ReleasesView`).

---

### Task 2: Re-seat `HivesView`

**Files:**
- Rewrite: `admin/portal/src/hives-view.ts`
- Test: `admin/portal/tests/hives-view.test.ts` (existing cases stay green; no new cases required - Task 1 owns the base invariants)

**Interfaces:**
- Consumes: `SectionContainerView`, `SectionLabels`, `SectionState` from Task 1.

- [ ] **Step 1: Rewrite `HivesView extends SectionContainerView<HiveListRow>`.** Keep `HivesMode { List, Detail }` + `Mode` getter mapping. Keep all label/key/header constants and `ConnectionPill`. Implement `Labels()`, `Columns()` (move existing + `ConnectionPill`/health pill), `SearchText(r) => r.displayName + ' ' + r.ownerLabel`, `LoadRows()` (fetch `ListFleet`, build/`Update` a private `HivesViewModel`, return `Rows`), `BuildDetail(row)` (fetch fleet, `find(h => h.id === row.id)`, `undefined` if missing else `new HiveDetailView(new HiveDetailViewModel(hive), () => void this.ShowList())`).
- [ ] **Step 2: Byte-scan** `hives-view.ts` -> `0 0 N`.
- [ ] **Step 3: Portal gate green** (`npm test` + `npm run typecheck`; root `typecheck:tools`). Commit.

---

### Task 3: Re-seat `TenantsView`

**Files:**
- Rewrite: `admin/portal/src/tenants-view.ts`
- Test: `admin/portal/tests/tenants-view.test.ts` (existing cases stay green)

**Interfaces:**
- Consumes: `SectionContainerView`, `SectionLabels`, `SectionState` from Task 1.

- [ ] **Step 1: Rewrite `TenantsView extends SectionContainerView<TenantListRow>`.** Keep `TenantsMode { List, Detail }` + `Mode` getter. Keep all constants + `ConnectionPill`. Implement `Labels()`, `Columns()` (move existing), `SearchText(r) => r.displayName + ' ' + r.id + ' ' + r.clientName`, `LoadRows()` (fetch `ListTenants`+`ListClients`+`ListFleet`, build/`Update` a private `TenantsViewModel`, return `Rows`), `BuildDetail(row)` (build `TenantDto` from the row, fetch `ListClients`+`ListFleet`, return `new TenantDetailView(new TenantDetailViewModel(dto, clients, fleet), () => void this.ShowList())`; if the detail fetch throws, let it propagate so the base renders list-error - matching today's catch-to-list behavior, now with a live retry).
- [ ] **Step 2: Byte-scan** `tenants-view.ts` -> `0 0 N`.
- [ ] **Step 3: Portal gate green.** Commit.

---

### Task 4: Re-seat `ClientsView` (List/Detail via base + localized Create)

**Files:**
- Rewrite: `admin/portal/src/clients-view.ts`
- Test: `admin/portal/tests/clients-view.test.ts` (existing cases stay green; add ONE new case: detail-fetch rejection -> live retry recovers to list)

**Interfaces:**
- Consumes: `SectionContainerView`, `SectionLabels`, `SectionState`, plus the base protected seams `SwapScreen`, `EnterCustom`, `State`.

- [ ] **Step 1: Rewrite `ClientsView extends SectionContainerView<ClientListRow>`.** Keep `ClientsMode { List, Create, Detail }` unchanged (values intact). `Mode` getter: `this.State === SectionState.Custom ? ClientsMode.Create : this.State === SectionState.Detail ? ClientsMode.Detail : ClientsMode.List`. Keep `CreateClientViewModel`, `createModel`, `errorText`, `createAction`, `submitAction`, and the getters `CreateAction` / `SubmitAction`. Implement `Labels()`, `Columns()` (move existing), `SearchText(r) => r.displayName + ' ' + r.id`, `LoadRows()` (fetch `ListClients`+`ListTenants`+`ListFleet`, build/`Update` a private `ClientsViewModel`, return `Rows`), `BuildDetail(row)` (build `ClientDto`, fetch `ListTenants(row.id)`+`ListFleet`, return `new ClientDetailView(new ClientDetailViewModel(dto, tenants, fleet), () => void this.ShowList())`; a thrown detail fetch propagates to the base -> list-error with live retry, fixing the old dead-retry). Override `ListPrimaryAction()` to return the create `Act` (via `this.operator.MutatingAct(CreateActionLabel, () => this.ShowCreate())`, cached in `createAction`). Keep `ShowCreate` (`this.EnterCustom(); this.SwapScreen(this.BuildCreate())`), `BuildCreate`, `Box`, `Submit` (on success `await this.ShowList()`). ctor `(client, private readonly operator: OperatorContext)`; construct `createModel` after `super(...)`.
- [ ] **Step 2: Byte-scan** `clients-view.ts` -> `0 0 N`.
- [ ] **Step 3: Add the fixed-defect test** to `clients-view.test.ts`: enter detail with a failing `ListTenants(id)` -> `host.State === Error` with a present `RetryButton`; restore the API, activate the retry, assert recovery (`Mode === List`, populated).
- [ ] **Step 4: Portal gate green** (`npm test` + `npm run typecheck`; root `typecheck:tools`). Commit (`refactor(platform-admin): re-seat ClientsView; fix dead detail-retry`).
