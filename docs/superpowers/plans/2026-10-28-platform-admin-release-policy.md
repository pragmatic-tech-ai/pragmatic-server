# Platform Admin Release Policy v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only "Release Policy" screen surfacing the current gating allowlist (by client/tenant) and the current selected target per hive, plus two additive `GET /api/gating` + `GET /api/selections` reads; honestly labelled as the current flat model, silent on the designed scoped-rules/ledger (which do not exist).

**Architecture:** Two small additive, read-only control-plane routes returning all `GatingRecord`s / `SelectionRecord`s. A single-screen portal `ReleasePolicyView` (NOT a self-routing container - no detail drill-in) with one `Observable` view model deriving two table row sets, joining tenant/client/fleet names for display.

**Tech Stack:** TypeScript (ESM, NodeNext), Mural imperative `.ts` views + `Observable` VMs, `node:test`. Control-plane tests via `npx tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-release-policy-design.md`

## Global Constraints

- OOP, Allman braces (opening brace on its own line), PascalCase public methods/interfaces, VMs extend `Observable`, enums over string-literal unions, `IDisposable` not lambdas.
- No inline user-facing / reused string literals: hoist to `private static readonly` PascalCase constants.
- New `.ts` files: pure ASCII + LF. After every write byte-scan `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`; escape non-ASCII as `\uXXXX` and RE-SCAN after the Write. Use ASCII apostrophes. Match the EOL of any file you modify.
- admin/portal must NEVER import admin/tenant-portal. No secret or raw internal ref exposed. NEVER fabricate scoped-rule / channel / min-version / hold / effect-preview / adoption-ledger data (none exists). No edit/Gate/Ungate control.
- Status/text is icon + text where a pill is used; never colour-only. Every actionable control keyboard-reachable.
- Gate asymmetry (BOTH green on the merged result): control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + (root) `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`.
- Tests live under `tests/` subfolders. Do not touch write paths (Gate/Ungate/SelectTarget/rollout), legacy views, `docs/design/`. Stage by explicit path.

## Review Focus

- A gate whose `tenantId` matches no tenant (or tenant with no matching client) -> "(unknown)" owner, not blank. -> Task 3 test.
- A selection whose `hiveId` is not in the fleet -> "(unknown hive)" row STILL shown, not dropped. -> Task 3 + Task 4 tests.
- Both tables empty -> screen shows the empty state (not two silent empty tables). -> Task 4 test.
- Missing/empty `gatedAt`/`selectedAt` -> "Unknown" via `PortalDates.Label`, never "Invalid Date". -> Task 3 test.
- No scoped-rule/channel/min/hold/ledger field and no edit/Gate/Ungate control anywhere. -> Task 4 test/review.
- A second `Refresh()` re-renders with no double-parent throw (fresh table slots). -> Task 4 test.

---

### Task 1: `GET /api/gating` + `GET /api/selections` (control-plane)

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts` (add `AllGating`, `AllSelections`)
- Modify: `admin/control-plane/control-plane-host.ts` (two route constants + two GET arms in `RouteApi`)
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (two accessor units), `admin/control-plane/tests/control-plane-host-rollout.test.ts` (the two GET routes)

**Interfaces:**
- Consumes: `GatingRegistry`/`SelectionRegistry` (PDR private fields `gating`, `selections`), each `extends JsonRecordStore` with `List(): readonly TRecord[]`. `GatingRecord { id, tenantId, version, gatedAt }`, `SelectionRecord { id, hiveId, targetVersion, selectedAt }`.
- Produces: `PlatformDeploymentRegistry.AllGating(): readonly GatingRecord[]` and `AllSelections(): readonly SelectionRecord[]`; HTTP `GET /api/gating` -> `200` `GatingRecord[]` and `GET /api/selections` -> `200` `SelectionRecord[]` (both incl. all records, `[]` when none), operator-gated by the existing central `authorization.Authorize` (GET allowed for every role), authenticated like every `/api` route.

- [ ] **Step 1: Failing unit tests** in `platform-deployment-registry.test.ts`: after `Gate(t1, v1)` + `Gate(t1, v2)`, `AllGating()` returns both records (correct tenantId/version); after `SelectTarget(h1, v1)` then `SelectTarget(h1, v2)` (same hive re-selected), `AllSelections()` returns one record with `targetVersion === v2` (latest wins); both return `[]` fresh. Mirror the file's existing PDR construction. (Note: `SelectTarget` requires the version to be gated for the hive's tenant first - set that up as the file's existing selection tests do, or use `RecordAdoption`/the existing helper; match the file.)
- [ ] **Step 2: Run, verify fail.** `npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts`.
- [ ] **Step 3: Implement** `AllGating()` -> `this.gating.List()` and `AllSelections()` -> `this.selections.List()` in `platform-deployment-registry.ts` (import `GatingRecord`/`SelectionRecord` types).
- [ ] **Step 4: Failing host tests** in `control-plane-host-rollout.test.ts`: as an authenticated operator, after gating two versions for a tenant and selecting a target for a hive (via the file's existing POST helpers), `GET /api/gating` returns `200` + an array containing both gates, and `GET /api/selections` returns `200` + the hive's selection; each returns `200` + `[]` when none; an UNAUTHENTICATED `GET /api/gating` is rejected (match the file's existing unauth assertion, e.g. `Harness.Send(..., false)` -> 401). Mirror the harness exactly.
- [ ] **Step 5: Run, verify fail.** `npx tsx --test admin/control-plane/tests/control-plane-host-rollout.test.ts`.
- [ ] **Step 6: Implement the GET arms.** Add `private static readonly GatingAllPath = '/api/gating'` and `SelectionsAllPath = '/api/selections'`; in `RouteApi`, before the fallthrough, add two arms: `if (path === ControlPlaneHost.GatingAllPath && method === PlaneHttp.MethodGet) { PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.AllGating()]); return true }` and the analogous one for selections. Place them near the existing `ManifestsPath`/fleet GET arms. Do not alter the per-scope gating/rollout routes.
- [ ] **Step 7: Full control-plane gate.** `npx tsx --test admin/control-plane/tests/*.test.ts` + (root) `npm run typecheck:tools`. Both green.
- [ ] **Step 8: Commit** (stage the four explicit paths).

---

### Task 2: Portal `GatingDto`/`SelectionDto` + `ListGating`/`ListSelections`

**Files:**
- Modify: `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts`

**Interfaces:**
- Consumes: Task 1 routes.
- Produces: `GatingDto = { tenantId: string; version: string; gatedAt: string }`; `SelectionDto = { hiveId: string; targetVersion: string; selectedAt: string }`; `ControlPlaneClient.ListGating(): Promise<GatingDto[]>` (GET `/api/gating`), `ListSelections(): Promise<SelectionDto[]>` (GET `/api/selections`).

- [ ] **Step 1: Failing tests** in `api-client-platform.test.ts` mirroring the `ListManifests` test: `ListGating()` issues `GET /api/gating` (no body, `credentials: 'same-origin'`) and returns the parsed `GatingDto[]`; `ListSelections()` issues `GET /api/selections` and returns `SelectionDto[]`. Assert routes, GET method (undefined), and a round-tripped payload.
- [ ] **Step 2: Run, verify fail** (in `admin/portal`): `npm test`.
- [ ] **Step 3: Add the two DTOs** to `portal-types.ts` (near `ManifestDto`). The server records also carry an `id`; omit it from the portal DTOs (unused composite key).
- [ ] **Step 4: Implement** `ListGating`/`ListSelections` in `api-client.ts` with hoisted `GatingRoute = '/api/gating'` / `SelectionsRoute = '/api/selections'` constants, each `return await this.Send<T[]>(route, undefined)`; import the DTO types.
- [ ] **Step 5: Run `npm test` + `npm run typecheck`** in `admin/portal`. Green.
- [ ] **Step 6: Commit.**

---

### Task 3: `ReleasePolicyViewModel`

**Files:**
- Create: `admin/portal/src/release-policy-view-model.ts`
- Test: `admin/portal/tests/release-policy-view-model.test.ts`

**Interfaces:**
- Consumes: `GatingDto`, `SelectionDto` (Task 2); `ClientDto { id, displayName }`, `TenantDto { id, clientId, displayName }`, `FleetHiveDto` (portal-types); `PortalDates.Label`; `FleetViewModel.OwnerLabel(hive: FleetHiveDto): string` (`./fleet-view-model.js`); `Observable`.
- Produces: `ReleasePolicyViewModel extends Observable`, constructor `(gating: readonly GatingDto[], selections: readonly SelectionDto[], tenants: readonly TenantDto[], clients: readonly ClientDto[], fleet: readonly FleetHiveDto[])`, getters `GatedRows: readonly GatedRow[]` and `TargetRows: readonly TargetRow[]`, `Update(...)` (same arg list) raising `GatedRowsProperty` and `TargetRowsProperty` (public static readonly keys). `export interface GatedRow { ownerLabel: string; version: string; gatedLabel: string }`; `export interface TargetRow { hiveName: string; ownerLabel: string; targetVersion: string; selectedLabel: string }`.

Derivation:
- GatedRow owner: find tenant by `gate.tenantId`; if found, `client.displayName + ' / ' + tenant.displayName` (client found via `tenant.clientId`), else if tenant found but client missing just `tenant.displayName`; if no tenant, `'(unknown)'`. `version = gate.version`; `gatedLabel = PortalDates.Label(gate.gatedAt)`. (Build a `tenantId -> TenantDto` and `clientId -> ClientDto` map; hoist the `' / '` separator and `'(unknown)'` constants.) Sort by ownerLabel then version (stable).
- TargetRow: find the hive in `fleet` by `sel.hiveId`; if found `hiveName = hive.displayName`, `ownerLabel = FleetViewModel.OwnerLabel(hive)`; else `hiveName = '(unknown hive)'`, `ownerLabel = '(unassigned)'` (match FleetViewModel's unassigned text) - DO NOT drop the row. `targetVersion = sel.targetVersion`; `selectedLabel = PortalDates.Label(sel.selectedAt)`. Sort by hiveName (stable).

- [ ] **Step 1: Failing tests** `release-policy-view-model.test.ts` (plain `node:test`, like `releases-view-model.test.ts`; no Application harness needed):
  - gates for a known tenant -> ownerLabel "Client / Tenant"; a gate whose tenantId matches no tenant -> "(unknown)"; a gate whose tenant has an unmatched clientId -> just the tenant name;
  - selections: one for a hive in the fleet -> hiveName + owner label; one for a hiveId NOT in the fleet -> a row with "(unknown hive)" / "(unassigned)" is STILL present (not dropped);
  - missing `gatedAt`/`selectedAt` -> label "Unknown";
  - `Update(...)` with new sets replaces both row getters and raises both change keys;
  - ordering: gated by owner then version, targets by hive.
- [ ] **Step 2: Run, verify fail.** `npm test`.
- [ ] **Step 3: Implement** per the interface; reuse `PortalDates.Label` + `FleetViewModel.OwnerLabel`; hoist all literals + the two change-key constants. Allman, ASCII, LF; byte-scan.
- [ ] **Step 4: `npm test` + `npm run typecheck`.** Green.
- [ ] **Step 5: Commit.**

---

### Task 4: `ReleasePolicyView` + app wiring

**Files:**
- Create: `admin/portal/src/release-policy-view.ts`
- Modify: `admin/portal/src/app.ts`, `admin/portal/tests/shell-app.test.ts`
- Test: `admin/portal/tests/release-policy-view.test.ts`

**Interfaces:**
- Consumes: `ReleasePolicyViewModel` + `GatedRow`/`TargetRow` (Task 3); `ControlPlaneClient.ListGating`/`ListSelections` (Task 2) + `ListTenants`/`ListClients`/`ListFleet`; kit `ScreenHost`/`ScreenHostInputs`, `PageHeader`, `Section`, `Banner`/`BannerTone`, `DataTable`/`TableColumn`/`TableDensity`; `IPortalView`/`IPortalNavigator`. STRUCTURAL TEMPLATE: `admin/portal/src/fleet-view.ts` - a single-screen `IPortalView` (NOT a self-routing container) that fetches, builds a VM, and renders a `ScreenHost` with a fresh content slot per render, surviving a second `Refresh()`. Mirror its fetch/ScreenHost/fresh-slot shape (it also builds tables).
- Produces: `ReleasePolicyView extends StackPanel implements IPortalView`, `constructor(client: ControlPlaneClient)`, `Refresh(): Promise<void>` (re-fetch + re-render), `AttachNavigator`. Seams `Host`, `GatedTable` (`DataTable<GatedRow> | undefined`), `TargetTable` (`DataTable<TargetRow> | undefined`).

Layout: `ScreenHost` loading -> fetch `Promise.all([ListGating(), ListSelections(), ListTenants(), ListClients(), ListFleet()])` -> on reject, error state with `onRetry` -> Refresh; else build/Update the VM; `isEmpty` when `GatedRows.length === 0 && TargetRows.length === 0`. Populated content (fresh each render): `PageHeader({ breadcrumb: ['Releases', 'Release Policy'], title: 'Release Policy' })` + a `Banner({ tone: BannerTone.Info, text: CurrentModelNote })` + a "Gated versions" `Section` wrapping a FRESH `DataTable<GatedRow>` (cols Client / tenant [`ownerLabel`], Version [`version`], Gated [`gatedLabel`]; Dense; `searchText` = ownerLabel + ' ' + version; emptyText 'No versions are gated yet.') + a "Selected targets" `Section` wrapping a FRESH `DataTable<TargetRow>` (cols Hive [`hiveName`], Client / tenant [`ownerLabel`], Target version [`targetVersion`], Selected [`selectedLabel`]; Dense; `searchText` = hiveName + ' ' + ownerLabel + ' ' + targetVersion; emptyText 'No hive has a target selected yet.'). `CurrentModelNote` (hoisted): "This is the current gating and selection model: the versions each tenant may adopt, and the target each hive is set to. Scoped rules, channels, minimum versions, holds, and the adoption ledger are not yet available." Hoist every literal (breadcrumb, title, section titles, column keys/headers, empty texts, search separator, the note).

- [ ] **Step 1: Failing tests** `release-policy-view.test.ts` (`Application.current` harness like `fleet-view.test.ts`):
  - populated: both `GatedTable` and `TargetTable` have the expected rows; the Banner is present with `CurrentModelNote`; PageHeader title 'Release Policy';
  - both-empty fetch -> `ScreenHost` empty state (assert the state, tables absent);
  - fetch-reject -> error state with a working `onRetry` (second fetch succeeds -> populated);
  - a selection for a hive not in the fleet still yields a `TargetTable` row ("(unknown hive)");
  - a SECOND `Refresh()` re-renders without a double-parent throw;
  - assert NO edit/Gate/Ungate control and no channel/min/hold/ledger text (e.g. collect rendered `TextBlock` texts and assert none contain 'channel', 'minimum', 'blocked', 'hold', 'ledger', 'rule').
- [ ] **Step 2: Run, verify fail.** `npm test`.
- [ ] **Step 3: Implement `release-policy-view.ts`** mirroring `fleet-view.ts` (fresh content slot + fresh table slots per render). Then wire `app.ts`: `if (section === PaSection.ReleasePolicy) { this.Mount(new ReleasePolicyView(this.client)); return }` beside the `PaSection.Registry` arm, before the `ComingSoon` fallback; import `ReleasePolicyView`. Update `shell-app.test.ts`: the routing test must now assert Release Policy -> `ReleasePolicyView` (it currently expects ComingSoonView for it) - add a branch mirroring the Registry one, do not weaken the other-sections `else`. Allman, ASCII, LF; byte-scan the new file; match `app.ts`/`shell-app.test.ts` EOL.
- [ ] **Step 4: Portal gate** (`npm test` + `npm run typecheck` in `admin/portal`) and (root) `npm run typecheck:tools`. All green.
- [ ] **Step 5: Commit.**

---

## Self-review notes

- Spec coverage: server reads (T1), client+types (T2), VM (T3), view+wiring (T4) - every IA item mapped. Deferred items (scoped rules, channel/min/hold, effect preview, ledger, editing, per-env rollout, cross-nav) are explicitly out and must not appear.
- Type consistency: `GatingDto`/`SelectionDto` identical server-vs-portal (minus `id`). `GatedRow`/`TargetRow`/the two `*Property` keys fixed above and reused by T4. Owner-label join and the "(unknown)"/"(unknown hive)"/"(unassigned)" fallbacks consistent across T3 and T4.
- Review Focus: unknown tenant (T3), unknown hive not dropped (T3/T4), both-empty state (T4), date degrade (T3), no fabricated fields/controls (T4), second Refresh (T4) - each pinned.
- Proportion: plan carries the decisions (routes, signatures, derivations, literals, test assertions); bodies left to the implementer mirroring the named siblings (`ListManifests`, `releases-view-model.ts`, `fleet-view.ts`).
