# Platform Admin Fleet (G8 slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Platform Admin Fleet home on an honest G8 read model: a thin `GET /api/fleet` join over existing hive/observation data (no internal refs), a view model that derives connection state / issues / tiles client-side, a dense Fleet table + needs-attention list + stat tiles, and the `ObservedPanel` kit primitive - deferring (as Features) every part the backend cannot yet substantiate.

**Architecture:** Server is a thin, testable join (`directory.ListHives()` + `observations.Get(hiveId)` + tenant/client names) serving a ref-free `FleetHiveDto`. The portal mirrors the DTO, adds `ListFleet()`, builds the `ObservedPanel` kit primitive, derives connection/issues/tiles in `FleetViewModel` (injectable clock + quiet threshold), and renders `FleetView` into the PA-2 shell at `ShowSection(Fleet)`. Fleet observes only; it refreshes on the existing `environments-changed` event.

**Tech Stack:** TypeScript (control-plane Node host + imperative Mural portal), PA-1 kit (`DataTable`, `StatusPill`/`PillKind`, `ScreenHost`, `Section`, `PageHeader`), `Observable` VMs, `node:test` + `tsx`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-fleet-design.md`

## Global Constraints

- Never fabricate a backend. Build only the honest G8 slice (Ruling 1); every deferred item (Ruling 2) is left out cleanly, not faked: no `disconnected` state, no semantic app/version/status/health-grade beyond `ready` + the running image, no components/agent-rollout column or tile, no "Stand up a hive" action, no hive-detail navigation, no dedicated fleet socket push.
- Fleet OBSERVES, never commands: no write/command; `ObservedPanel` carries no actionable control.
- The fleet DTO leaks NO internal ref (no configRef/credentialRef/trustRootRef/agentTokenRef).
- OOP; Allman braces; PascalCase public API; no inline user-facing literals (hoist to `private static readonly`); enums over unions (`FleetConnection`/`FleetIssueKind`/`Segment`); VMs extend `Observable`; components extend their Mural base; `IDisposable` not lambdas; tests under `tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after each write -> `0 0 N`. Existing files touched (`control-plane-host.ts`, `portal-types.ts`, `api-client.ts`, `app.ts`, `kit/index.ts`): check + MATCH current EOL, never flip. Escape non-ASCII as `\uXXXX`; re-scan after the Write tool.
- **Two gates, both green on the merged result.** Control plane (root `npm test` does NOT cover `admin/control-plane/tests`): from repo root `npx tsx --test admin/control-plane/tests/*.test.ts` AND `npm run typecheck:tools`. Portal: in `admin/portal`, `npm test` AND `npm run typecheck`.
- `admin/portal` must NEVER import `admin/tenant-portal`.

## Review Focus

- Hive with no observation -> `lastSeen: null` -> Awaiting, never a false Connected or a crash. (Tasks 1, 3.)
- `reportedAt` just over vs just under the quiet threshold -> Quiet vs Connected (injected `now` both sides). (Task 3.)
- `ready === false` -> EnvironmentNotReady issue + Failing pill; needs-attention ordered danger > warning > info. (Task 3.)
- Missing tenant/client record -> `client: null` / safe label, never a crash. (Tasks 1, 3.)
- Fleet DTO carries no internal ref. (Task 1.)
- `ObservedPanel` renders no actionable control; empty fleet -> honest empty state. (Tasks 2, 4.)
- No `admin/tenant-portal` import; no inline user-facing literal. (All + diff review.)

---

### Task 1: Server - GET /api/fleet read model

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (route + `FleetHiveDto` + `BuildFleet`)
- Test: `admin/control-plane/tests/control-plane-host.test.ts` (new fleet cases)

**Interfaces:**
- Consumes: `this.directory` (`ListHives()`, `GetTenant(id)`, `GetClient(id)`), `this.observations` (`Get(hiveId)` -> `{ environments: HiveHealthDto[], reportedAt } | undefined`), `HiveHealthDto { environmentName, ready, runningImage, detail }`.
- Produces:
  - `export type FleetEnvDto = { name: string; ready: boolean; image?: string; detail: string }`
  - `export type FleetHiveDto = { id: string; displayName: string; tenant: { id: string; displayName: string } | null; client: { id: string; displayName: string } | null; clusterBackend: string; clusterMode: string; lastSeen: string | null; environments: FleetEnvDto[] }`
  - `GET /api/fleet` (session-gated) -> `FleetHiveDto[]`; a `private BuildFleet(): FleetHiveDto[]`. Hoist the route path `/api/fleet`. Map `HiveHealthDto` -> `FleetEnvDto` (`name: environmentName`, `image: runningImage`). Resolve tenant via `GetTenant(hive.tenantId)` (null if missing) and client via `GetClient(tenant.clientId)` (null if tenant or client missing). `lastSeen` = observation `reportedAt` or `null`. NO ref fields.

- [ ] **Step 1: Write the failing test** - add fleet cases to `control-plane-host.test.ts` using the existing Harness/fakes: seed a hive WITH an observation (assert `lastSeen` set, env mapped `{name,ready,image,detail}`, tenant+client names joined) and a hive WITHOUT one (assert `lastSeen: null`, `environments: []`); assert the response JSON has no `configRef`/`credentialRef`/`trustRootRef`/`agentTokenRef` key anywhere; assert a hive whose tenant is missing yields `client: null` without throwing.
- [ ] **Step 2: Run to verify it fails** - `npx tsx --test admin/control-plane/tests/control-plane-host.test.ts` from repo root. Expected: FAIL (no /api/fleet route).
- [ ] **Step 3: Implement** the route + `FleetHiveDto`/`FleetEnvDto` + `BuildFleet`. Match the file's EOL.
- [ ] **Step 4: Run both server gates** - `npx tsx --test admin/control-plane/tests/*.test.ts` and `npm run typecheck:tools`, from repo root. Expected: all green.
- [ ] **Step 5: Commit** `feat(control-plane): GET /api/fleet cross-hive read model`.

---

### Task 2: Portal - fleet client + ObservedPanel kit primitive

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (mirror `FleetHiveDto`/`FleetEnvDto`)
- Modify: `admin/portal/src/api-client.ts` (`ListFleet()`)
- Create: `admin/portal/src/kit/observed-panel.ts`
- Modify: `admin/portal/src/kit/index.ts` (export `ObservedPanel`)
- Test: `admin/portal/tests/kit-screen.test.ts` (ObservedPanel cases)

**Interfaces:**
- Consumes: `StatusPill`, `PillKind` (`.Observed`), `IconCatalog` from the kit; `Visual`, `StackPanel`, `TextBlock`.
- Produces:
  - `portal-types.ts`: `FleetEnvDto` and `FleetHiveDto` exactly mirroring Task 1's wire shape.
  - `api-client.ts`: `public async ListFleet(): Promise<FleetHiveDto[]>` (a GET to `/api/fleet`, same pattern as `ListHives`).
  - `kit/observed-panel.ts`: `export interface ObservedPanelInputs { title: string; note?: string; body: Visual }`; `export class ObservedPanel extends StackPanel` ctor `(inputs)`; renders a dashed container, a `StatusPill` of `PillKind.Observed`, the note (hoisted default, e.g. 'Read from the hive’s last check-in. No break-glass.' - use an ASCII apostrophe or \u escape), and the body. NO actionable control. Seams `get Title()`, `get NoteText()`.

- [ ] **Step 1: Write the failing tests** - `ObservedPanel` renders its title and an Observed `StatusPill`; it contains NO `KeyActivatedButton`/`Act`/`Button` descendant (assert by walking children or by a documented "no actions" contract test); `NoteText` returns the default when none given. (Keep the `node:test` + `Application.current` setup.)
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/kit-screen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the DTO mirror, `ListFleet()`, `observed-panel.ts`, barrel export. New file ASCII + LF; others keep EOL. Byte-scan.
- [ ] **Step 4: Run the portal gate** - `cd admin/portal && npx tsx --test tests/*.test.ts && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `feat(admin-portal): fleet client and ObservedPanel kit primitive`.

---

### Task 3: Portal - FleetViewModel derivations

**Files:**
- Create: `admin/portal/src/fleet-view-model.ts`
- Test: `admin/portal/tests/fleet-view-model.test.ts` (new)

**Interfaces:**
- Consumes: `FleetHiveDto`/`FleetEnvDto` (Task 2), `Observable`.
- Produces:
  - `export enum FleetConnection { Connected, Quiet, Awaiting }`
  - `export enum FleetIssueKind { Quiet, Awaiting, EnvironmentNotReady }`
  - `export enum FleetSegment { All, NeedsAttention, NotCheckingIn }`
  - `export interface FleetIssue { kind: FleetIssueKind; summary: string }`
  - `export interface FleetRow { id: string; displayName: string; ownerLabel: string; connection: FleetConnection; lastSeenLabel: string; envCount: number; notReadyCount: number; issues: FleetIssue[] }`
  - `export class FleetViewModel extends Observable`: ctor `(rows: FleetHiveDto[], now: () => Date = () => new Date(), quietThresholdMs?: number)`; getters `Rows(): readonly FleetRow[]` (derived), `NeedsAttention(): readonly FleetRow[]` (rows with issues, ordered by max severity danger>warning>info), `HiveCount`, `NeedAttentionCount`, `NotCheckingInCount` (Quiet + Awaiting), `EnvironmentsObserved` (sum of envCount); `Segment` get/set with `Visible(): readonly FleetRow[]` applying the filter; `Update(rows)`. Connection: `lastSeen === null` -> Awaiting; `now - Date(lastSeen) < quietThresholdMs` -> Connected; else Quiet. `ownerLabel` from `client`/`tenant` display names (safe when null). `lastSeenLabel` like 'Last check-in 3 min ago' / 'Never dialled in'. Hoist labels + `QuietThresholdMs` (6h) to `private static readonly`.

- [ ] **Step 1: Write the failing tests** - `lastSeen: null` -> Awaiting + an Awaiting issue + lastSeenLabel 'Never dialled in'; `reportedAt` = now-(threshold-1min) -> Connected, now-(threshold+1min) -> Quiet (inject `now`); an env `ready:false` -> `notReadyCount`>=1 + an EnvironmentNotReady issue; `NeedsAttention` excludes all-Connected/ready hives and orders a danger-bearing hive before a warning-only one; tile counts (HiveCount/NeedAttentionCount/NotCheckingInCount/EnvironmentsObserved) correct on a mixed set; `Segment = NotCheckingIn` -> `Visible()` is the quiet+awaiting rows; a DTO with `client: null` and `tenant: null` -> a safe `ownerLabel`, no throw.
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/fleet-view-model.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `fleet-view-model.ts`. ASCII + LF; byte-scan.
- [ ] **Step 4: Run the portal gate** - `cd admin/portal && npx tsx --test tests/*.test.ts && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `feat(admin-portal): FleetViewModel connection and issue derivations`.

---

### Task 4: Portal - FleetView and shell wiring

**Files:**
- Create: `admin/portal/src/fleet-view.ts`
- Modify: `admin/portal/src/app.ts` (route `ShowSection(PaSection.Fleet)` -> `FleetView`; refresh on `OnChanged`)
- Test: `admin/portal/tests/fleet-view.test.ts` (new), `admin/portal/tests/shell-app.test.ts` (Fleet mounts FleetView)

**Interfaces:**
- Consumes: `FleetViewModel`/`FleetConnection`/`FleetSegment` (Task 3), `ControlPlaneClient.ListFleet()` (Task 2), `ObservedPanel` (Task 2), PA-1 `DataTable`/`TableColumn`/`TableDensity`, `StatusPill`/`PillKind` (Connected/Quiet/Awaiting, Healthy/Failing), `ScreenHost`/`ScreenState`, `PageHeader`, `Section`; `IPortalView`/`IPortalNavigator` (shape as `ComingSoonView`).
- Produces:
  - `fleet-view.ts`: `export class FleetView extends StackPanel implements IPortalView` ctor `(client: ControlPlaneClient)`. `AttachNavigator(nav)` stores the nav; `Refresh(): Promise<void>` calls `client.ListFleet()`, builds/updates a `FleetViewModel`, and renders through a `ScreenHost` (loading -> empty when no hives -> populated). Populated: a `PageHeader` ('Fleet', the hoisted sub, NO primary action), a stat-tile row (Hives / Need attention / Not checking in / Environments observed from the VM counts), the needs-attention list (ordered; informational rows, no navigation), and a `DataTable<FleetRow>` with columns Hive / Client-tenant / Connection (StatusPill) + last-seen / Health (StatusPill from notReadyCount) / Envs / Issues, with search, per-row tone, and the three `FleetSegment` filters. Test seams: `get Model()`, `get Host(): ScreenHost`. Hoist all labels.
  - `app.ts`: `ShowSection` routes `PaSection.Fleet` to `this.MountFleet()` (a `FleetView` into the content host, `SetActive(Fleet)`) instead of the placeholder; `OnChanged` refreshes the current view (already wired) so the Fleet view re-pulls. Keep all other sections on `ComingSoonView`.
- Builder's call: a minimal `StatTile` (value + label) view-local or in kit; keep it text, not colour-only. Saved segments as simple buttons; column controls deferred.

- [ ] **Step 1: Write the failing tests** - with a fake client whose `ListFleet()` returns a mixed set, `FleetView.Refresh()` leaves the `ScreenHost` populated and `Model.HiveCount` matches; `ListFleet()` returning `[]` -> empty state; the DataTable renders a row per hive with a connection pill. In `shell-app.test.ts`, `ShowSection(PaSection.Fleet)` (or boot) mounts a `FleetView` (not `ComingSoonView`) and `ActiveSection === Fleet`. (Update the shell `FakeClient` to implement `ListFleet()`.)
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/fleet-view.test.ts tests/shell-app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `fleet-view.ts` + the `app.ts` routing. Match `app.ts` EOL; new file ASCII + LF; byte-scan.
- [ ] **Step 4: Run the full portal gate** - `cd admin/portal && npx tsx --test tests/*.test.ts && npm run typecheck`. Expected: all green (whole suite; update any PA-2/PA-3 shell test whose fake client now needs `ListFleet()` - intended, note it).
- [ ] **Step 5: Commit** `feat(admin-portal): Fleet overview home wired into the shell`.
