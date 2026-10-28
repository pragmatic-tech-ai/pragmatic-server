# Platform Admin Registry & Releases (read side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Registry placeholder with a Registry & Releases list + release detail over existing data, plus one additive `GET /api/manifests` read endpoint; honest about observed adoption and silent on signing/channel/digest (which do not exist).

**Architecture:** One small additive, read-only control-plane route (`GET /api/manifests` -> all `ManifestRecord`s) and a portal section view `ReleasesView` (self-routing list/detail, mirroring `HivesView`) with two `Observable` view models. Observed adoption is derived client-side by matching each manifest `image` against observed `FleetEnvDto.image` from `ListFleet()`.

**Tech Stack:** TypeScript (ESM, NodeNext), Mural imperative `.ts` views + `Observable` VMs, `node:test`. Control-plane tests run via `npx tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-registry-design.md`

## Global Constraints

- OOP, Allman braces (opening brace on its own line), PascalCase public methods/interfaces, VMs extend `Observable`, enums over string-literal unions, `IDisposable` not lambdas.
- No inline user-facing / reused string literals: hoist to `private static readonly` PascalCase constants.
- New `.ts` files: pure ASCII + LF. After every write byte-scan `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> must be `0 0 N`; escape any non-ASCII as `\uXXXX` and RE-SCAN after the Write (the tool literalizes escapes). Use ASCII apostrophes. Match the EOL of any file you modify.
- admin/portal must NEVER import admin/tenant-portal. No raw internal ref (`configRef`/`credentialRef`/`trustRootRef`/`agentTokenRef`) or secret exposed. Never fabricate signing / channel / digest / provenance data (none exists).
- Status is icon + text (via `StatusPill`/`PillKinds`), never colour-only. Every actionable control keyboard-reachable.
- Stateful views MUST survive a SECOND `Refresh()` in BOTH list and detail modes: build a FRESH content/table slot each render (the PA-4 double-parent guard).
- Gate asymmetry (BOTH must be green on the merged result):
  - Control-plane: `npx tsx --test admin/control-plane/tests/*.test.ts` AND (repo root) `npm run typecheck:tools`. Root `npm test` does NOT run control-plane tests.
  - Portal: in `admin/portal` run `npm test` AND `npm run typecheck`.
- Tests live under `tests/` subfolders (`admin/control-plane/tests/`, `admin/portal/tests/`).
- Do not touch the publish/withdraw write paths, legacy views, `docs/design/`, or any mural WIP. Stage by explicit path.

## Review Focus

- A withdrawn version shows the Withdrawn pill AND the withdrawn Banner (honest "keep running until the tenant adopts another version" copy) and still lists where it runs. -> Tasks 3, 4, 5, 6 tests.
- A version no observed env reports running shows "Not observed running" (not "0") in the list and an empty "Where it runs" panel in detail, no crash. -> Tasks 3, 4, 5 tests.
- Empty/missing `notes` -> "(none)" for What's new; missing/empty `publishedAt` -> "Unknown" (via `PortalDates.Label`), never "Invalid Date". -> Task 4 test.
- No Signed pill, channel label, digest, provenance block, or publish/withdraw control appears anywhere. -> Task 5/6 tests + review.
- A `FleetEnvDto.image` that is `undefined` must NOT match a manifest (no false adoption). -> Task 3 test.
- A second `Refresh()` in list and in detail re-renders without a double-parent throw. -> Task 6 test.

---

### Task 1: `GET /api/manifests` read endpoint (control-plane)

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts` (add `AllManifests`)
- Modify: `admin/control-plane/control-plane-host.ts` (serve GET at the existing `ManifestsPath` branch)
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (AllManifests unit), `admin/control-plane/tests/control-plane-host-rollout.test.ts` (the GET route; this file already exercises the manifests/rollout routes)

**Interfaces:**
- Consumes: `ManifestRegistry.List(): readonly ManifestRecord[]` (already exists via `JsonRecordStore`); the existing `ManifestsPath` branch in `RouteApi` that currently delegates only to `RoutePublishManifest` (POST).
- Produces: `PlatformDeploymentRegistry.AllManifests(): readonly ManifestRecord[]`; HTTP `GET /api/manifests` -> `200` with `ManifestDto[]` (`ManifestDto = ManifestRecord`), including withdrawn versions, `[]` when none. Operator-gated by the existing `authorization.Authorize(role, method, path)` call (GET is allowed for every role), authenticated like every other `/api` route.

- [ ] **Step 1: Write the failing unit test** in `platform-deployment-registry.test.ts`: after `Publish('v1','img1')`, `Publish('v2','img2')` then `SetWithdrawn('v2', true)`, `AllManifests()` returns both records (v2 with `withdrawn === true`); on a fresh registry it returns `[]`. Mirror the existing harness/construction in that file.
- [ ] **Step 2: Run it, verify it fails** (`AllManifests` not a function). Run: `npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts`.
- [ ] **Step 3: Implement `AllManifests(): readonly ManifestRecord[]`** in `platform-deployment-registry.ts` returning `this.manifests.List()`.
- [ ] **Step 4: Write the failing host test** in `control-plane-host-rollout.test.ts`: as an authenticated operator, publish two versions (one then withdrawn) via the existing POST helpers, then `GET /api/manifests` returns `200` and a JSON array containing both version ids with the withdrawn flag on the withdrawn one; GET with no versions returns `200` and `[]`. Mirror that file's request harness and auth/session setup exactly.
- [ ] **Step 5: Run it, verify it fails** (GET currently falls through / 404 or false). Run: `npx tsx --test admin/control-plane/tests/control-plane-host-rollout.test.ts`.
- [ ] **Step 6: Implement the GET branch.** In the `if (path === ControlPlaneHost.ManifestsPath)` block of `RouteApi`, serve GET before delegating to `RoutePublishManifest`: on `method === PlaneHttp.MethodGet`, `PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.AllManifests()])` and `return true`; otherwise delegate to `RoutePublishManifest` as today. Do not change the POST path or add fields. Keep `ManifestDto` as the response element type.
- [ ] **Step 7: Run the full control-plane gate.** `npx tsx --test admin/control-plane/tests/*.test.ts` then (repo root) `npm run typecheck:tools`. Both green.
- [ ] **Step 8: Commit** (stage only the four explicit paths).

---

### Task 2: Portal `ManifestDto` + `ListManifests()` client method

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (add `ManifestDto`)
- Modify: `admin/portal/src/api-client.ts` (add `ManifestsRoute` + `ListManifests`)
- Test: `admin/portal/tests/api-client-platform.test.ts` (ListManifests hits GET /api/manifests, returns the parsed array)

**Interfaces:**
- Consumes: Task 1 `GET /api/manifests`.
- Produces: `export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string; withdrawn?: boolean }`; `ControlPlaneClient.ListManifests(): Promise<ManifestDto[]>`.

- [ ] **Step 1: Write the failing test** in `api-client-platform.test.ts` mirroring the existing fetch-stub pattern there: `ListManifests()` issues `GET /api/manifests` (no body, `credentials: 'same-origin'`) and returns the parsed `ManifestDto[]`; assert the route string and that a stubbed `[{id:'v1',image:'img1',publishedAt:'2026-01-01T00:00:00.000Z'}]` round-trips.
- [ ] **Step 2: Run it, verify it fails.** Run (in `admin/portal`): `npm test`.
- [ ] **Step 3: Add `ManifestDto`** to `portal-types.ts` (placement near the other platform DTOs).
- [ ] **Step 4: Implement `ListManifests`** in `api-client.ts`: add `private static readonly ManifestsRoute = '/api/manifests'`; `public async ListManifests(): Promise<ManifestDto[]> { return await this.Send<ManifestDto[]>(ControlPlaneClient.ManifestsRoute, undefined) }`. Import `ManifestDto` in the type import list.
- [ ] **Step 5: Run `npm test` + `npm run typecheck`** in `admin/portal`. Green.
- [ ] **Step 6: Commit** (explicit paths).

---

### Task 3: `ReleasesViewModel` (list)

**Files:**
- Create: `admin/portal/src/releases-view-model.ts`
- Test: `admin/portal/tests/releases-view-model.test.ts`

**Interfaces:**
- Consumes: `ManifestDto` (Task 2), `FleetHiveDto`/`FleetEnvDto` (`{ environments: { image?: string }[] }`), `PortalDates.Label`, `Observable`.
- Produces: `ReleasesViewModel extends Observable` with `public get Rows(): readonly ReleaseListRow[]`, `public Update(manifests: readonly ManifestDto[], fleet: readonly FleetHiveDto[]): void` raising `ReleasesViewModel.RowsProperty` (public static readonly string), constructor `(manifests, fleet)`. `export interface ReleaseListRow { id: string; image: string; withdrawn: boolean; publishedLabel: string; observedEnvCount: number }`.

Derivation: rows sorted newest-first by `publishedAt` (descending string compare on the ISO value; stable for equal/empty). `publishedLabel = PortalDates.Label(m.publishedAt)`. `withdrawn = m.withdrawn === true`. `observedEnvCount` = count across ALL `fleet[].environments` of envs whose `image !== undefined && image === m.image` (an `undefined` env image never matches).

- [ ] **Step 1: Write failing tests** `releases-view-model.test.ts` (`Application.current` harness like `hives-view-model.test.ts`):
  - two manifests + a fleet where one hive env runs `img1` and another runs `img2` -> rows carry the matching `observedEnvCount` (1 each);
  - a manifest whose image no env runs -> `observedEnvCount === 0`;
  - a fleet env with `image: undefined` does NOT increment any count;
  - a withdrawn manifest -> `withdrawn === true`;
  - missing `publishedAt` -> `publishedLabel === 'Unknown'`;
  - `Update(...)` with a new set raises `RowsProperty` and replaces `Rows`;
  - ordering is newest-first by `publishedAt`.
- [ ] **Step 2: Run, verify fail.** `npm test` (admin/portal).
- [ ] **Step 3: Implement `releases-view-model.ts`** per the interface; hoist all literals ('Unknown' comes from `PortalDates.Label`, so none needed there) and the `RowsProperty` key to constants. Allman, ASCII, LF; byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`.** Green.
- [ ] **Step 5: Commit.**

---

### Task 4: `ReleaseDetailViewModel`

**Files:**
- Create: `admin/portal/src/release-detail-view-model.ts`
- Test: `admin/portal/tests/release-detail-view-model.test.ts`

**Interfaces:**
- Consumes: `ManifestDto`, `FleetHiveDto`, `PortalDates.Label`, `BannerTone` (`./kit/index.js`), `KeyValueItem` (`./kit/index.js`), `Observable`.
- Produces: `ReleaseDetailViewModel extends Observable`, constructor `(manifest: ManifestDto, fleet: readonly FleetHiveDto[])`, with:
  - `public get Profile(): readonly KeyValueItem[]` -> items Version (`id`), Image (`image`), Published (`PortalDates.Label(publishedAt)`), Status (`withdrawn ? 'Withdrawn' : 'Published'`), "What's new" (`notes && notes.length > 0 ? notes : '(none)'`). Use hoisted key constants.
  - `public get WithdrawnBanner(): { show: boolean; tone: BannerTone; text: string }` -> `withdrawn === true` -> `{ show: true, tone: BannerTone.Warning, text: WithdrawnText }`; else `{ show: false, tone: BannerTone.Warning, text: '' }`.
  - `public get AdoptionRows(): readonly ReleaseAdoptionRow[]` where `export interface ReleaseAdoptionRow { hiveName: string; ownerLabel: string; envName: string; ready: boolean }` -> for each fleet hive, each env whose `image !== undefined && image === manifest.image`, emit `{ hiveName: hive.displayName, ownerLabel, envName: env.name, ready: env.ready }`. `ownerLabel` = `client.displayName + ' / ' + tenant.displayName` when both present, else the present one, else '(unassigned)' (mirror how `HivesViewModel`/`FleetViewModel` build their owner label; match that exact fallback text).
- `WithdrawnText` constant (hoisted): "This version is withdrawn. Hives stop seeing it as adoptable after their next check-in. Environments already running it keep running it until their tenant adopts another version."

- [ ] **Step 1: Write failing tests** `release-detail-view-model.test.ts`:
  - a published manifest with notes -> Profile has the 5 items in order with Status 'Published' and the notes text; WithdrawnBanner.show === false;
  - a withdrawn manifest -> Status 'Withdrawn', WithdrawnBanner.show === true with the exact `WithdrawnText`;
  - missing/empty notes -> What's new value '(none)'; missing publishedAt -> Published value 'Unknown';
  - a fleet with two hives each running the manifest image in one env -> AdoptionRows has 2 rows with correct hiveName/ownerLabel/envName/ready; a hive env with `image: undefined` or a different image is excluded;
  - a manifest no env runs -> AdoptionRows is empty.
- [ ] **Step 2: Run, verify fail.** `npm test`.
- [ ] **Step 3: Implement** per interface. Reuse `PortalDates.Label`; match the owner-label fallback of `hive-detail-view-model.ts`/`fleet-view-model.ts` verbatim. Allman, ASCII, LF; byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`.** Green.
- [ ] **Step 5: Commit.**

---

### Task 5: `ReleaseDetailView`

**Files:**
- Create: `admin/portal/src/release-detail-view.ts`
- Test: `admin/portal/tests/release-detail-view.test.ts`

**Interfaces:**
- Consumes: `ReleaseDetailViewModel` + `ReleaseAdoptionRow` (Task 4); kit `ScreenHost`, `PageHeader`, `Section`, `KeyValueGrid`, `Banner`/`BannerTone`, `ObservedPanel`, `DataTable`/`TableColumn`/`TableDensity`, `PillKinds`/`PillKind`, `PillEntry`; `StackPanel`/`Orientation`. Mirror `hive-detail-view.ts` structure (Back button, PageHeader, conditional Banner, Section/KeyValueGrid, ObservedPanel wrapping a table) and its fresh-table-slot-per-render discipline.
- Produces: `ReleaseDetailView extends StackPanel`, constructor `(vm: ReleaseDetailViewModel, onBack: () => void)`, seams `public get Host(): ScreenHost` and `public get AdoptionTable(): DataTable<ReleaseAdoptionRow> | undefined`.

Detail layout (populated): Back control + `PageHeader` (breadcrumb ['Registry & Releases', version id], title = version id) + CONDITIONAL `Banner` (only when `vm.WithdrawnBanner.show`, `{ tone, text }`) + "Release" `Section` wrapping `KeyValueGrid({ items: vm.Profile })` + `ObservedPanel` "Where it runs" wrapping a FRESH `DataTable<ReleaseAdoptionRow>` built each render. Table columns (text cells): Hive (`hiveName`), Client / tenant (`ownerLabel`), Environment (`envName`, sort localeCompare), Status (`PillKinds.For(ready ? PillKind.Healthy : PillKind.Failing).label`, `tone` = Danger when `!ready` else undefined); `density: Dense`; `emptyText` = 'No running environment observed on this version.'; `searchText` = `envName`. Hoist every literal (breadcrumb head 'Registry & Releases', panel titles 'Release' and 'Where it runs', section/column headers, empty text).

- [ ] **Step 1: Write failing tests** `release-detail-view.test.ts` (`Application.current` harness like `hive-detail-view.test.ts`):
  - populated view renders PageHeader with the version id, the Release KeyValueGrid, and the "Where it runs" ObservedPanel; `AdoptionTable` has the expected rows;
  - a withdrawn vm renders a Banner (assert present + its text); a published vm renders NO Banner;
  - an empty AdoptionRows renders the table empty-text and does not throw;
  - calling the render path a SECOND time (re-invoke the populated content builder / a `Render()` seam) does NOT throw a double-parent (fresh slot);
  - grep-style assertion: the view exposes no token/credential/signature/channel/digest text (assert the KeyValueGrid keys are exactly Version/Image/Published/Status/What's new).
- [ ] **Step 2: Run, verify fail.** `npm test`.
- [ ] **Step 3: Implement** mirroring `hive-detail-view.ts`; fresh `tableSlot` per `BuildContent`. Allman, ASCII, LF; byte-scan.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`.** Green.
- [ ] **Step 5: Commit.**

---

### Task 6: `ReleasesView` container + app wiring

**Files:**
- Create: `admin/portal/src/releases-view.ts`
- Modify: `admin/portal/src/app.ts` (mount at `PaSection.Registry`)
- Test: `admin/portal/tests/releases-view.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.ListManifests` + `ListFleet` (Tasks 2); `ReleasesViewModel` (Task 3); `ReleaseDetailView` + `ReleaseDetailViewModel` (Tasks 4, 5); kit `ScreenHost`/`ScreenHostInputs`, `PageHeader`, `DataTable`/`TableColumn`/`TableDensity`, `PillKinds`/`PillKind`/`PillEntry`; `IPortalView`/`IPortalNavigator`. COPY the hardened `hives-view.ts` (self-routing List/Detail, single fetch, ShowDetail try/catch -> list error fallback with `onRetry`, stale guard on mode + detail id after await, fresh content slot per render, second-Refresh safe).
- Produces: `ReleasesView extends StackPanel implements IPortalView`, constructor `(client: ControlPlaneClient)`, enum `ReleasesMode { List, Detail }`, seams `Host`, `Table` (`DataTable<ReleaseListRow> | undefined`), `Mode`.

List layout: `ScreenHost` (loading / error[`onRetry` -> Refresh] / empty['No versions published yet.'] / populated). Populated: `PageHeader` (breadcrumb ['Releases', 'Registry & Releases'], title 'Registry & Releases') + a FRESH list slot with `DataTable<ReleaseListRow>`: columns Version (`id`, sort localeCompare), Status (`PillKinds.For(withdrawn ? PillKind.Withdrawn : PillKind.Published).label`, `tone` = that entry's tone when withdrawn else undefined), Image (`image`), Published (`publishedLabel`, sort by underlying value is fine via label), Running (`observedEnvCount > 0 ? observedEnvCount + ' environment(s)' : 'Not observed running'`, sort by `observedEnvCount`); `density: Dense`; `searchText` = `id + ' ' + image`; `onOpen` -> `ShowDetail`. Detail: `Promise.all([ListManifests(), ListFleet()])`, find manifest by `row.id`; if missing OR fetch rejects -> list error fallback (same as `HivesView` hive-not-found path); build `ReleaseDetailViewModel`/`ReleaseDetailView`. Hoist all literals (breadcrumb, titles, empty/error text, 'environment(s)' suffix, 'Not observed running', column keys/headers, search separator).

- [ ] **Step 1: Write failing tests** `releases-view.test.ts` (mirror `hives-view.test.ts`): list populated (Table has rows) / empty ('No versions published yet.') / fetch-reject -> error state with working `onRetry`; row-open -> Detail mode + ReleaseDetailView mounted; detail fetch-reject (or manifest vanished between list and detail) -> list error fallback; a SECOND `Refresh()` in List mode AND a second `Refresh()` in Detail mode both re-render with no double-parent throw.
- [ ] **Step 2: Run, verify fail.** `npm test`.
- [ ] **Step 3: Implement `releases-view.ts`** by copying `hives-view.ts` and swapping fleet->manifests+fleet, the VM, the detail view, and the columns. Then wire `app.ts`: in `ShowSection`, add `if (section === PaSection.Registry) { this.Mount(new ReleasesView(this.client)); return }` before the `ComingSoon` fallback (place beside the existing `PaSection.Hives` branch). Allman, ASCII, LF; byte-scan the new file; match `app.ts` EOL.
- [ ] **Step 4: Run the portal gate** (`npm test` + `npm run typecheck` in `admin/portal`) and, because `app.ts` is typechecked by tools too, (repo root) `npm run typecheck:tools`. All green.
- [ ] **Step 5: Commit.**

---

## Self-review notes

- Spec coverage: server read (Task 1), client+type (Task 2), list VM (3), detail VM (4), detail view (5), container+wiring (6) - every IA item in the design maps to a task. Deferred items (publish/withdraw/signing/channel/digest/provenance/wizard) are explicitly out and must not appear.
- Type consistency: `ManifestDto` shape identical in Tasks 1 (server DTO = `ManifestRecord`) and 2 (portal). `ReleaseListRow`/`ReleaseAdoptionRow`/`RowsProperty` names fixed above and reused by consumers. `observedEnvCount` and the `image !== undefined` guard are consistent across Tasks 3 and 4.
- Review Focus: withdrawn (3/4/5/6), not-observed (3/4/5), notes/publishedAt degrade (4), no-fabricated-fields (5/6), undefined image no false match (3), second-Refresh (6) - each pinned to a task test.
- Proportion: plan carries decisions (routes, signatures, derivations, literals, test assertions); bodies are left to the implementer, who mirrors the named sibling files.
