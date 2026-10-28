# TA-12 Connection status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Connection status page that honestly reports whether the hive can currently reach Pragmatic (from the existing rollout 503 signal) and what is running in the hive (from rollout data), with an outbound-only diagram and a quiet-hive banner - no fabricated check-in cadence, history, or component-version plate.

**Architecture:** Portal-only. A thin `IConnectionSource` (satisfied by the existing `TenantApiClient` - `GetHives` + `GetRollout`, no new client code) feeds a `ConnectionStatusViewModel` (Observable) that owns the honest state mapping (a successful rollout read -> Connected; a 503 `TenantApiError` -> Quiet; 401 -> rethrow to login; 403 -> Forbidden; else -> Error; no hive -> NoHive). A `ConnectionStatusView` renders the hero, the outbound-only diagram, the "what's running" list, the quiet banner, and the ScreenHost states; `tenant-app.ts` swaps the ConnectionStatus ComingSoon placeholder for it.

**Tech Stack:** TypeScript (admin/tenant-portal), Mural kit components, Observable VMs, tsx test runner.

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-connection-status-design.md`

## Global Constraints

- OOP only; no module-level free functions or mutable module state. Allman braces. PascalCase public methods/interfaces. VMs extend `Observable`. `IDisposable`, not disposer lambdas.
- No inline string literals: hoist every user-facing/reused literal to `private static readonly`. Enums over string-literal unions (the connection state is an enum).
- New `.ts` files pure ASCII + LF. Byte-scan after every write (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"`) - 0 non-ASCII, 0 CR. Never `sed -i` a CRLF file.
- No new backend route or DTO wire shape. Add only the portal-side `IConnectionSource` interface + the derived `ConnectionStatus` view type in `tenant-types.ts` (types only). `tenant-app.ts` is CRLF: change only the one nav case and keep CRLF.
- Honesty: "Connected" means a read just succeeded this session (initial state is Loading, never a default-true Connected); never show a fabricated timestamp/cadence/history; the quiet state is calm (environments keep running), not an alarm.
- Tests under `admin/tenant-portal/tests/`. Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Merged gate: server-root `npm test` + `npm run typecheck:tools` green.

## Review Focus

- A **503** from the rollout read -> `Quiet` state (calm), quiet banner, diagram still shown; NOT an Error state. (Task 1 tests.)
- A **401** -> rethrow to login, not a connection error. (Task 1 tests.)
- A **non-503/401** failure -> `Error` state, not a fake `Quiet`. (Task 1 tests.)
- **No hive / no environments** -> `NoHive`/empty state, not a crash or a misleading `Connected`. (Task 1 tests.)
- The **initial** state is `Loading`; `Connected` is reached only after a successful probe. (Task 1 tests.)
- The quiet copy states environments keep running (view copy); the diagram preserves outbound-only. (Task 2 tests.)

---

### Task 1: `ConnectionStatusViewModel` + `IConnectionSource` + honest state mapping

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (add `IConnectionSource` interface + `ConnectionStatus` + `ConnectionEnvironment` types - TYPES ONLY, no DTO wire change)
- Create: `admin/tenant-portal/src/connection-status-view-model.ts`
- Test: `admin/tenant-portal/tests/connection-status-view-model.test.ts`

**Interfaces:**
- Consumes: `HiveDto`, `HiveRolloutDto`, `RolloutEnvDto`, `TenantApiError` (`.Status`, `UnauthorizedStatus`/`ForbiddenStatus`) from the existing portal code; `Observable`.
- Produces (used by Task 2):
  - In `tenant-types.ts`: `export interface IConnectionSource { GetHives(): Promise<HiveDto[]>; GetRollout(hiveId: string): Promise<HiveRolloutDto> }` (the existing `TenantApiClient` already implements both - no client change); `export interface ConnectionEnvironment { name: string; runningImage: string | undefined; ready: boolean }`; `export interface ConnectionStatus { reachable: boolean; detail: string; targetVersion: string | undefined; environments: readonly ConnectionEnvironment[] }`.
  - `export enum ConnectionState { Loading, Connected, Quiet, NoHive, Error, Forbidden }`
  - `class ConnectionStatusViewModel extends Observable` with: property-changed constants `StateProperty`/`StatusProperty`/`ErrorProperty`; `get State(): ConnectionState`; `get Status(): ConnectionStatus | undefined`; `get Error(): string`; `async Load(): Promise<void>` (resolves the hive via `GetHives` - empty -> `NoHive`; else probe). Probe maps: `GetRollout` success -> `Connected` + a `ConnectionStatus` derived from the rollout (reachable true, `targetVersion`, `environments` mapped from `RolloutEnvDto`); catch `TenantApiError` where `.Status === 503` -> `Quiet` + a `ConnectionStatus { reachable:false }` with an honest detail (and empty/last-known environments); `.Status === UnauthorizedStatus` (401) -> rethrow; `.Status === ForbiddenStatus` (403) -> `Forbidden`; any other error -> `Error` with the message. 503 is the quiet signal, NOT an error. Guard against a stale async result if `Load` is re-entered (a load token, mirroring the other VMs).

- [ ] **Step 1: Write failing tests** (`tests/connection-status-view-model.test.ts`, with a fake `IConnectionSource`):
  - Initial `State === Loading` before any `Load`.
  - `Load` with a hive + a succeeding `GetRollout` -> `Connected`, `Status.reachable === true`, `targetVersion` and `environments` match the rollout.
  - `GetRollout` rejects with a `TenantApiError` status 503 -> `Quiet`, `Status.reachable === false`, state is NOT `Error`.
  - `GetRollout` rejects 401 -> `Load` rethrows (assert it throws).
  - `GetRollout` rejects 403 -> `Forbidden`.
  - `GetRollout` rejects a generic error -> `Error` with the message.
  - `GetHives` returns [] -> `NoHive`.
- [ ] **Step 2: Run tests, verify fail** (`cd admin/tenant-portal && npm test`).
- [ ] **Step 3: Implement** the types + VM with the state mapping + load token. Hoisted literals; enum state.
- [ ] **Step 4: Run tests green.** Byte-scan the new + modified files.
- [ ] **Step 5: Commit** `feat(tenant-portal): ConnectionStatusViewModel - honest reachability from the rollout signal`.

---

### Task 2: `ConnectionStatusView` + outbound diagram + quiet banner + nav wiring

**Files:**
- Create: `admin/tenant-portal/src/connection-status-view.ts`
- Modify: `admin/tenant-portal/src/tenant-app.ts` (swap the `NavSection.ConnectionStatus` ComingSoon placeholder for `ConnectionStatusView`; CRLF preserved; one case only)
- Test: `admin/tenant-portal/tests/connection-status-view.test.ts`

**Interfaces:**
- Consumes: Task 1 VM; the kit (`ScreenHost`, `Banner`, `Section`, `StatusPill`/`PillKind`, `TenantViewBase` or the base the other views use); the `TenantApiClient`.
- Produces: test seams - `get Vm(): ConnectionStatusViewModel`; `get StateHost(): ScreenHost`; `get QuietBanner(): Banner | undefined` (present only in `Quiet`); a `get Hero()` text/pill seam; a running-list host seam.

- [ ] **Step 1: Write failing tests** (`tests/connection-status-view.test.ts`):
  - `Connected` -> a Connected `StatusPill`/hero, the outbound-only diagram present, the "what's running" list shows each environment's running image, no quiet banner.
  - `Quiet` -> a Quiet hero + the quiet banner whose copy says environments keep running; diagram still present; no Error host.
  - `Error` -> the error ScreenHost; `NoHive` -> the empty/NoHive state; `Loading` -> the loading host.
  - The diagram/copy preserves outbound-only (assert the Pragmatic-never-connects-in line is present).
  - `Dispose` tears down subscriptions.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** the view (hero from `State`/`Status`; a three-node outbound diagram from kit primitives - Your hive -> outbound HTTPS -> Pragmatic, with the never-connects-in copy; the running list from `Status.environments` + `targetVersion`; the quiet `Banner` on `Quiet`; `ScreenHost` for Loading/Error/NoHive/Forbidden). Subscribe to the VM state properties and re-render; track subscriptions in an `IDisposable[]` and dispose. Then wire `tenant-app.ts`: the `NavSection.ConnectionStatus` case constructs `ConnectionStatusView` (resolving the hive like `ShowOverview`/`ShowReleases`; no hive -> keep ComingSoon). Keep `tenant-app.ts` CRLF; change only that case + the import.
- [ ] **Step 4: Run tests green.** Portal `npm test` + `npm run typecheck`. Byte-scan the view + test (LF, ASCII); verify `tenant-app.ts` stayed CRLF (`python` byte-scan: CR count == LF count).
- [ ] **Step 5: Commit** `feat(tenant-portal): Connection status page, outbound-only diagram, quiet-hive banner`.
