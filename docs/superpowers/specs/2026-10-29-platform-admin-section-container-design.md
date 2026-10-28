# PA-15 - Platform Admin section-container base (DRY the four self-routing views) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). Corresponds to reconciliation backlog spec 15 (states-matrix / resilience polish), scoped to its highest-leverage, lowest-risk core: collapse the four duplicated self-routing section views onto one base and fix the inconsistencies the duplication hides. PURE FRONTEND - no control-plane change, no new backend read.
**Area:** Platform Admin portal (`admin/portal/`) only.
**Builds on:** PA-1 kit (`ScreenHost`, `ScreenHostInputs`, `PageHeader`, `DataTable`, `ErrorStatePanel.RetryButton`), the four section views shipped across PA-2..PA-8R (`ClientsView`, `TenantsView`, `HivesView`, `ReleasesView`).

## Context

The portal has four "section" screens that each route internally between a list and a detail (and, for Clients, a create form): `ClientsView`, `TenantsView`, `HivesView`, `ReleasesView`. They were built one per spec and are ~90% identical line-for-line:

- Identical fields: `content`, `host`, `listSlot`, `model`, `mode`, `listMounted`, `detailRow`, `nav`.
- Identical constructor (vertical `StackPanel` wrapping a `content` `StackPanel` wrapping a loading `ScreenHost`).
- Identical `Host` / `Table` / `Mode` getters, `AttachNavigator`, `Refresh`.
- Identical `ShowList` (remount host if unmounted; set mode + clear detail; loading host while first model is absent; fetch; build-or-`Update` the model; `catch` -> error host; stale-guard mode-recheck on the success path; `LoadedInputs`).
- Identical `Inputs` / `LoadedInputs` / `Swap` / `BuildList` shape (differing only in labels, columns, search text, and the view-model type).
- Near-identical `ShowDetail` (set mode + detailRow; fetch; stale-guard recheck of mode + detailRow identity after the await; not-found/reject -> list-error fallback; else swap in the detail view).

`ClientsView` alone adds a third mode (`Create`) with a form, a `CreateClientViewModel`, `CreateAction` / `SubmitAction` seams, and a `Submit` path.

This duplication is the root of a recurring class of review findings: a fix or guard added to one copy silently fails to reach the other three. Two such divergences exist in the tree today:

1. **`ClientsView.ShowDetail` builds its detail-fetch-failure error screen without an `onRetry`** (`ClientsView.Inputs(false, true, true)` - no retry callback), so the rendered "Try again" button is wired to nothing. `TenantsView`, `HivesView`, and `ReleasesView` all pass `() => void this.Refresh()` in the same spot. A real user-facing defect: a transient failure loading a client's detail leaves a dead retry button.
2. **The `ShowList` `catch` path has no stale-guard mode-recheck** in any of the four, while the success path does. Benign today (after a navigation-away the stale list `host` is detached from the tree, so the `catch`'s `host.Update(error)` paints nothing visible), but asymmetric and fragile - the next person to touch one copy has to re-derive why.

## Recon findings (binding) + rulings

1. **One abstract base, `SectionContainerView<TRow>`, owns the entire list/detail lifecycle; subclasses supply only what differs.** The base (new file `admin/portal/src/section-container-view.ts`) `extends StackPanel implements IPortalView` and holds `content` / `host` / `listSlot` / `nav` / `listMounted` / `detailRow: TRow | undefined` / a protected `SectionState` and concrete `Refresh` / `ShowList` / `ShowDetail` / `Swap` / the `Host` and `Table` getters / `AttachNavigator` / `Inputs` / `LoadedInputs` / `BuildList`. Ruling: the base does NOT know any view-model type - see finding 2.

2. **The base is model-agnostic: subclasses load rows, not models.** The four view-models have different constructors and `Update` signatures and are fed by different `api-client` calls, so the base cannot hold "the model". Instead the base defines two protected abstract hooks the subclass implements:
   - `protected abstract LoadRows(): Promise<readonly TRow[]>` - does the subclass's fetch, builds-or-updates the subclass's own (privately held) view-model, and returns `model.Rows`. All `api-client` and view-model knowledge stays in the subclass.
   - `protected abstract BuildDetail(row: TRow): Promise<Visual | undefined>` - does the subclass's detail fetch and returns the detail `Visual`, or `undefined` to mean not-found / load-failed (the base then renders the shared list-error fallback WITH `onRetry`). The subclass constructs its own detail view-model and `DetailView`, passing `() => void this.ShowList()` as the back callback (exposed as a protected `BackToList` arrow or `this.ShowList` bound).
   The base caches the last loaded `readonly TRow[]` to build the table and to decide `isEmpty`.

3. **Subclasses supply presentation via protected abstract hooks, not inheritance of literals.** `protected abstract Columns(): TableColumn<TRow>[]`, `protected abstract SearchText(row: TRow): string`, and a `protected abstract Labels(): SectionLabels` where `SectionLabels = { listBreadcrumb: readonly string[]; listTitle: string; emptyTitle: string; errorTitle: string; tableEmptyText: string }`. `onOpen` is wired by the base to `row => void this.ShowDetail(row)`. The base's `BuildList` builds a fresh `listSlot` + `DataTable<TRow>` each render (second-`Refresh` safety preserved). An optional `protected ListPrimaryAction(): Act | undefined` hook (default `undefined`) lets a subclass add a header action and an empty-state action (Clients uses it for "Create client"); the base passes it to both `PageHeader.primaryAction` and the empty-state `action`.

4. **`onRetry` is present on EVERY error surface, in one place.** The base is the single author of all error `ScreenHostInputs`: the `ShowList` loading->error transition, the `ShowList` `catch`, and the `ShowDetail` not-found/reject fallback all route through one private helper that always sets `errorConfig.onRetry = () => void this.Refresh()`. This structurally removes the `ClientsView` dead-retry defect (finding, context 1) because no subclass can forget it.

5. **The stale-guard is symmetric and lives only in the base.** `ShowList`: after `await this.LoadRows()`, and also in its `catch`, the base rechecks `if (this.state !== SectionState.List) return` BEFORE touching the host - so a fetch that resolves or rejects after the user has navigated to detail/create paints nothing. `ShowDetail`: after `await this.BuildDetail(row)` the base rechecks `if (this.state !== SectionState.Detail || this.detailRow !== row) return` before swapping (identity guard against a newer detail request). This unifies and fixes the asymmetry (context 2).

6. **Per-subclass `Mode` enums stay the public contract; the base state is internal.** Existing tests assert `view.Mode === TenantsMode.Detail`, `ClientsMode.Create`, etc. The base owns `protected enum`-style state `SectionState { List, Detail, Custom }` and a `protected get State()`. Each subclass keeps its own public `Mode` getter mapping `State` to its own enum (`Detail -> XMode.Detail`, `Custom -> ClientsMode.Create`, else `XMode.List`). The three pure views never enter `Custom`. Ruling: keep the four `XMode` enums exactly as they are (numeric values and all) so no test's enum comparison changes.

7. **`ClientsView` Create stays entirely in `ClientsView` as the `Custom` state.** The base treats `Custom` opaquely: `Refresh` is a no-op in `Custom` (matching today - `ClientsView.Refresh` already ignores Create), and the base never builds a Custom screen. `ClientsView` keeps `CreateClientViewModel`, `ShowCreate` (`this.EnterCustom(); this.SwapScreen(this.BuildCreate())` via protected base seams), `BuildCreate`, `Submit`, and the `CreateAction` / `SubmitAction` getters. Protected base seams it needs: `SwapScreen(v: Visual)` (the `Swap`), `EnterCustom()` (sets `state = Custom`, `listMounted = false`), and `ShowList()` (already public). Ruling: do NOT lift Create into the base - only one of four views has it, so it is a subclass concern (YAGNI).

8. **No behavior change the tests can see, except the two fixed defects.** Every existing seam (`Host`, `Table`, `Mode`, `CreateAction`, `SubmitAction`, `host.State`) keeps its exact meaning. The only observable changes: `ClientsView`'s detail-error screen now has a live retry, and a stale `ShowList` rejection after navigation no longer repaints a detached host. Both get new tests.

## Goals

- One `SectionContainerView<TRow>` base; `TenantsView`, `HivesView`, `ReleasesView` become thin (labels + columns + two load hooks); `ClientsView` becomes thin + its localized Create.
- Fix, in the single shared path: the `ClientsView` dead detail-retry, and the asymmetric `ShowList` stale-guard.
- Preserve every public test seam and all existing behavior otherwise; the four view test suites stay green, plus new tests for the two fixes.

## Non-goals / deferred

- The single-screen views (`FleetView`, `ReleasePolicyView`) - they have no list/detail routing and do not belong on this base. Untouched.
- Any new section, column, filter, sort, or data - this is a structural refactor, not a feature.
- Cross-section navigation, the shared navigator wiring beyond the existing `AttachNavigator` passthrough.
- A11y work beyond what already exists (status is already icon+text via `PillKinds`; actions are already `KeyActivatedButton`/`Act`). The reconciliation "states matrix / a11y" remainder stays filed.
- Any control-plane / backend change.

## Known limitation (pre-existing, not introduced here; carried forward)

A narrow stale-paint race survives the symmetric guard and is identical to the pre-refactor behavior: if a `ShowList` fetch is still in flight when a `ShowDetail` resolves NOT-FOUND (which resets `state = List` and installs a fresh error host), the in-flight `ShowList` passes its `state === List` recheck and repaints the populated list over that not-found error host. The user sees the fresh list instead of the not-found error - both are valid states, so the race is benign. Closing it fully requires a per-load sequence/generation token on `ShowList`/`ShowDetail`; deferred as out of scope for a structural de-duplication (would be a behavior change, not a refactor). Filed as a future hardening if cross-section nav or deletion flows make the not-found error load-bearing.

## Anti-goals (a failure even if it "works")

- The base importing or naming any concrete view-model or `api-client` method (it must be model-agnostic; all data knowledge stays in subclasses).
- An error surface anywhere in the base that omits `onRetry`.
- Changing a `XMode` enum's values or dropping a public seam, breaking the existing suites.
- Lifting `ClientsView` Create into the base "for symmetry" (only one view has it).
- Collapsing the fresh-per-render `listSlot` into a reused one (reintroduces the double-parent class of bugs).
- Inline user-facing literals; importing `admin/tenant-portal`; any non-ASCII or CRLF in a new `.ts`.

## Information architecture (decided shape)

New file `admin/portal/src/section-container-view.ts`:
- `export interface SectionLabels { listBreadcrumb: readonly string[]; listTitle: string; emptyTitle: string; errorTitle: string; tableEmptyText: string }`.
- `export abstract class SectionContainerView<TRow> extends StackPanel implements IPortalView`.
  - Protected state enum `SectionState { List, Detail, Custom }` (module-level `const enum` or exported enum per the enums-over-unions rule).
  - Fields: `content`, `host`, `listSlot`, `nav?`, `listMounted`, `detailRow?: TRow`, `state`, `rows: readonly TRow[]`, `loaded: boolean` (has a model been built).
  - Concrete: `Host`, `Table` getters; `AttachNavigator`; `Refresh`; `ShowList`; `ShowDetail`; protected `State` getter; protected `SwapScreen`, `EnterCustom`; private `Swap`, `BuildList`, `LoadingInputs`, `ErrorInputs`, `LoadedInputs`.
  - Protected abstract: `LoadRows()`, `BuildDetail(row)`, `Columns()`, `SearchText(row)`, `Labels()`; protected virtual `ListPrimaryAction()` returning `Act | undefined` (default `undefined`).

Rewritten (thin) subclasses, each keeping its file name and public class name:
- `tenants-view.ts`, `hives-view.ts`, `releases-view.ts`: keep their `XMode` enum + `Mode` getter (mapping base `State`); implement the five hooks; hold their own view-model privately inside `LoadRows`. All label/column/key constants stay as subclass `private static readonly`.
- `clients-view.ts`: same, plus `Custom`->`Create` mapping, `CreateClientViewModel`, `ShowCreate`/`BuildCreate`/`Submit`, `CreateAction`/`SubmitAction`, and `ListPrimaryAction()` returning the create `Act`.

Unchanged: `app.ts` (constructs the same classes), all detail/create views and view-models, the kit, `portal-types.ts`, every `api-client` method.

Tests (`admin/portal/tests/`, `node:test`, `Application.current` harness):
- All four existing `*-view.test.ts` suites must pass unchanged (the regression harness).
- New `section-container-view.test.ts` OR additions to the per-view suites covering the two fixes:
  - `ClientsView` detail-fetch rejection -> error screen whose `ErrorStatePanel.RetryButton` activation calls `Refresh` and recovers to the list (the previously-dead retry).
  - A `ShowList` whose fetch rejects AFTER the view has navigated to detail does not repaint the (detached) list host over the detail screen - assert the shown screen is still the detail.
  - Re-assert the shared invariants once on the base via one subclass: second `Refresh` in list and in detail re-renders with no double-parent; not-found detail (`BuildDetail` -> `undefined`) falls back to a list-error screen with a live retry.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, `IDisposable` not lambdas, tests under `tests/`.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`). Match EOL of touched files (all are LF).
- Portal gate: `npm test` + `npm run typecheck` in `admin/portal`, both green. (No control-plane change, but run `npm run typecheck:tools` at the root too since it typechecks both portals.)
- No cross-app import (`admin/tenant-portal`); no secret/raw-ref exposure (none handled here); stateful view survives a second `Refresh` (fresh `listSlot` per render preserved in the base).
- Every public test seam preserved; no `XMode` enum value changed.

## Review focus (inputs no happy-path test exercises)

- A detail fetch that REJECTS (not just not-found): base must reach the list-error fallback with a live `onRetry`, for every subclass including Clients. (New test.)
- A `ShowList` fetch that resolves/rejects AFTER navigation to detail or create: base must paint nothing (both success and catch stale-guards). (New test.)
- A second `Refresh` in detail mode (re-runs `BuildDetail`, re-swaps): no double-parent. (Existing per-view tests cover list; add detail.)
- Clients `Custom`(Create) state: `Refresh` is a no-op; `Mode` reports `Create`; `CreateAction`/`SubmitAction` still resolve. (Existing Clients suite.)
- `BuildDetail` returning `undefined` vs throwing: both must land on the same list-error-with-retry screen. (New test.)
