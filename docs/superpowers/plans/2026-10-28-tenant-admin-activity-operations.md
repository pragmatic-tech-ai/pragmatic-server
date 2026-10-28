# TA-14 Activity feed and Operations drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A portal-only, session-scoped activity log fed by the existing tenant events socket, surfaced in a persistent Activity drawer (shell chrome), an Overview recent-activity card, an Overview connection card (wiring TA-12's reserved `ConnectionStatus.detail`), and an Environment-detail activity list - all honest about being activity observed this session, with no new server route.

**Architecture:** Portal-only. A shell-owned `ActivityLog` (extends `Observable`, bounded ring) records each `TenantEvent` the browser observes via the shell's single `OnEvent` subscription, stamping client observed-at time. The shell holds one `ActivityLog` and one kit `Drawer`; the drawer subscribes to the log, and views reach the log through a new `ITenantNavigator.Activity` seam, reading it at their already-triggered renders. New kit primitives `ActivityList` and `Drawer`. No server change, no `TenantEvent` contract change.

**Tech Stack:** TypeScript. Portal: `admin/tenant-portal` (Mural kit, Observable VMs/stores, plain row/value classes, tsx tests under `tests/`).

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-activity-operations-design.md`

## Global Constraints

- OOP only; no module-level free functions or mutable module state. Allman braces. PascalCase public methods/interfaces. Stores/VMs extend `Observable`; row/value classes (`ActivityEntry`) are plain delegating classes, not `Observable`. `IDisposable`, not disposer lambdas.
- No inline string literals: hoist every user-facing/reused literal to `private static readonly`. Enums over string-literal unions (reuse `TenantEventType`, `PillKind`, `KitGlyph`, `NavSection`).
- New portal `.ts` files pure ASCII + LF; byte-scan after every write (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> expect `0 0 N`). Escape `— … · →` etc. as `\uXXXX`; re-scan after the Write tool (it can literalize escapes).
- CRLF files - PRESERVE, never `sed -i`, change only needed lines: `tenant-app.ts`, `tenant-api-client.ts`, `admin/tenant-portal/tests/tenant-app.test.ts`, `admin/tenant-portal/tests/tenant-tree-view.test.ts`. Verify CR==LF after editing.
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`, BOTH green on the merged result. No server change -> no control-plane gate.
- Session-scoped log, cleared on reload, labeled honestly as observed-this-session. No actor, no server timestamp, no secret, nothing cross-tenant in any entry. No new server route; no change to the `TenantEvent` contract.

## Review Focus

- `ActivityLog` past its cap drops oldest and never grows unbounded; `EntriesFor(name)` returns only that environment's entries. (Task 2 tests.)
- The drawer accumulates and stays correct across a view swap - the shell records into the log while a different section is mounted, and the drawer reflects it with no mounted-view log subscription. (Task 3 test.)
- The Overview connection card maps 503 -> Quiet (not Error), 401 -> login, 403 -> denied/absent, no-hive -> empty, reusing `ConnectionStatusViewModel`; it does not re-probe the rollout on every env event. (Task 4 tests.)
- An empty log renders the honest "No activity observed yet this session." state in both the drawer and the Overview card, not a blank panel. (Task 1 + Task 3/4 tests.)
- Observed-at is client time via an injected `now` seam; no entry presents a server timestamp or an actor. (Task 2 test.)
- Environment detail shows only its own environment's activity and adds no 24 h history strip. (Task 5 test.)

---

### Task 1: Kit primitives - `ActivityList` and `Drawer`

**Files:**
- Create: `admin/tenant-portal/src/kit/activity-list.ts`, `admin/tenant-portal/src/kit/drawer.ts`
- Modify: `admin/tenant-portal/src/kit/index.ts` (export both + their input types; LF file)
- Test: `admin/tenant-portal/tests/kit-activity-list.test.ts`, `admin/tenant-portal/tests/kit-drawer.test.ts`

**Interfaces:**
- Consumes: Mural `StackPanel`/`TextBlock`/`Orientation` (`@pragmatic-tech-ai/mural/basic`); kit `StatusPill`, `PillKind`, `KitGlyph`. The `ActivityEntry` shape it renders is defined in Task 2 - for Task 1 depend only on a minimal local render contract (a readonly interface with `Summary: string`, `Pill: PillKind`, `RelativeTime(now?: () => number): string`), so the kit stays data-agnostic and Task 2's `ActivityEntry` satisfies it structurally.
- Produces (used by Tasks 3-5):
  - `export interface ActivityListInputs { entries: readonly ActivityListItem[]; max?: number; emptyText: string }` where `ActivityListItem` is the minimal render contract above. `class ActivityList extends StackPanel`: renders up to `max` entries newest-first (caller supplies order), each a row (pill + summary + relative-time `TextBlock`); renders `emptyText` when `entries` is empty. `Update(inputs: ActivityListInputs): void` to re-render in place. Test seams: `get Rows(): readonly StackPanel[]`, `get IsEmpty(): boolean`.
  - `export interface DrawerInputs { title: string; body: Visual; open: boolean; closeLabel: string; onClose: () => void }`. `class Drawer extends StackPanel`: a header (title + a close affordance calling `onClose`) over `body`, shown only while `Open`. `SetOpen(open: boolean): void` / `Toggle(): void` re-render presence; `get Open(): boolean`. Test seams: `get Open()`, `get BodyHost(): StackPanel`.

- [ ] **Step 1: Write failing tests** - `ActivityList`: given 3 fake items renders 3 rows in order; `max:2` renders 2; empty entries renders the empty text and `IsEmpty` true. `Drawer`: `open:false` shows no body; `SetOpen(true)` shows body; `Toggle()` flips; close affordance invokes `onClose`.
- [ ] **Step 2: Run, verify fail** (`npm test` filtered to the two new tests).
- [ ] **Step 3: Implement** both primitives + the index exports. Hoist all literals. ASCII/LF.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck`. Byte-scan the 3 touched src files (new = LF; `index.ts` stays LF).
- [ ] **Step 5: Commit** `feat(tenant-portal): kit ActivityList and Drawer primitives`.

---

### Task 2: `ActivityEntry` + `ActivityLog` (session-scoped store)

**Files:**
- Create: `admin/tenant-portal/src/activity-log.ts` (both `ActivityEntry` and `ActivityLog`, or split - builder's call; one file is fine)
- Test: `admin/tenant-portal/tests/activity-log.test.ts`

**Interfaces:**
- Consumes: `TenantEvent`, `TenantEventType` (`./tenant-types.js`); `Observable` (`@pragmatic-tech-ai/todl-runtime`); kit `PillKind`, `KitGlyph`.
- Produces (used by Tasks 3-5):
  - `export class ActivityEntry` (plain class, NOT Observable): constructor `(type: TenantEventType, environmentName: string, observedAt: number)`; getters `Type`, `EnvironmentName`, `ObservedAt`, `Summary` (plain-language from a hoisted `type -> template` map, e.g. created/changed/deleted/health-changed phrased with the env name), `Pill` (`PillKind.Observed`); method `RelativeTime(now?: () => number): string` (`just now` under a threshold, else `Nm ago` / `Nh ago`, from `(now?.() ?? Date.now()) - observedAt`). Satisfies Task 1's `ActivityListItem` contract.
  - `export class ActivityLog extends Observable`: `public static readonly EntriesProperty = 'Entries'`; constructor `(cap?: number, now?: () => number)` (default cap ~200, default `now = () => Date.now()`); `Record(ev: TenantEvent): void` (appends an `ActivityEntry` stamped with `now()`, drops oldest past cap, raises `EntriesProperty`); `get Entries(): readonly ActivityEntry[]` (newest-first); `EntriesFor(environmentName: string): readonly ActivityEntry[]`; `get Count(): number`.

- [ ] **Step 1: Write failing tests** - `Record` appends and `Entries` is newest-first; past `cap` oldest is dropped and `Count === cap`; `EntriesFor('a')` returns only env `a`'s entries; `Summary` matches the expected sentence per `TenantEventType`; `RelativeTime` with an injected `now` yields `just now` / `Nm ago` deterministically; `ObservedAt` is the injected `now()` (client time, no server field).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `ActivityEntry` + `ActivityLog`. Hoist all literals. ASCII/LF.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck`. Byte-scan new file(s) (LF).
- [ ] **Step 5: Commit** `feat(tenant-portal): session-scoped ActivityLog fed by tenant events`.

---

### Task 3: Shell wiring - Activity drawer, top-bar toggle, navigator seam

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF - preserve): own one `ActivityLog` + one `Drawer`; in `OnTenantEvent` record into the log BEFORE the existing routing; mount the drawer in the right column; add `get Activity()` and `OpenActivityDrawer()`; dispose the drawer's log subscription in `Teardown`.
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF): add `get Activity(): ActivityLog` and `OpenActivityDrawer(): void` to `ITenantNavigator`; import the `ActivityLog` type.
- Modify: `admin/tenant-portal/src/top-bar.ts` (LF): add an activity toggle affordance (glyph + entry count) to the bar, wired to a supplied `onActivity: () => void`; keep the existing plate/userMenu/BannerSlot.
- Modify: `admin/tenant-portal/src/tenant-view-base.ts` (LF) only if a convenience `protected get Activity()` is wanted (optional; views may read `this.Navigator?.Activity`). Prefer no change unless it removes duplication.
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF - preserve). Add cases.

**Interfaces:**
- Consumes: `ActivityLog` (Task 2), kit `Drawer` + `ActivityList` (Task 1), `TenantApiClient.OnEvent`, `TopBar`.
- Produces: `TenantApp` implements the extended `ITenantNavigator` (`Activity`, `OpenActivityDrawer`). The drawer renders `new ActivityList({ entries: this.activityLog.Entries, emptyText: <hoisted> })` and refreshes via a subscription to `ActivityLog.EntriesProperty`. `OpenActivityDrawer()` sets the drawer open. The top bar's activity toggle calls into the shell to toggle the drawer and shows `activityLog.Count`.

- [ ] **Step 1: Write failing tests** (extend `tenant-app.test.ts`): after `Boot`, emitting a fake `TenantEvent` through the injected socket records an entry visible via `app.Activity.Entries`; the drawer's `ActivityList` reflects it; `OpenActivityDrawer()` opens the drawer; recording while a non-environments section is shown still updates the drawer (view-swap correctness); the activity count on the top bar reflects `Activity.Count`. (Reuse the test's existing fake socket/client harness.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the shell wiring + navigator seam + top-bar toggle. Record-before-route in `OnTenantEvent`. Dispose the log subscription in `Teardown`. Preserve CRLF on `tenant-app.ts` / `tenant-app.test.ts`; LF on `tenant-types.ts` / `top-bar.ts`.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck`. Byte-scan: `tenant-app.ts` + `tenant-app.test.ts` stayed CRLF (CR==LF); `tenant-types.ts` + `top-bar.ts` LF.
- [ ] **Step 5: Commit** `feat(tenant-portal): shell Activity drawer, top-bar toggle, navigator Activity seam`.

---

### Task 4: Overview recent-activity card + connection card

**Files:**
- Modify: `admin/tenant-portal/src/overview-view.ts` (LF): add a "Recent activity" Section (kit `ActivityList` over `this.Navigator?.Activity?.Entries`, capped at 5, with a "See all activity" affordance -> `OpenActivityDrawer()`) and a connection card Section to the Overview body; rebuild both in the existing `Rebuild()`.
- Create: `admin/tenant-portal/src/overview-connection-card.ts` (LF): a compact card owning a `ConnectionStatusViewModel`, loaded once per mount; reachable/quiet `StatusPill` + `ConnectionStatus.detail` + a "View connection status" link (`ShowSection(NavSection.ConnectionStatus)`); honest loading / quiet / error / no-hive / forbidden states.
- Test: `admin/tenant-portal/tests/overview-view.test.ts` (check its current EOL and preserve), `admin/tenant-portal/tests/overview-connection-card.test.ts` (LF new).

**Interfaces:**
- Consumes: `ActivityLog` via `ITenantNavigator.Activity` + `OpenActivityDrawer`; kit `ActivityList`, `Section`, `StatusPill`, `PillKind`; `ConnectionStatusViewModel` + `ConnectionState` (`./connection-status-view-model.js`); `IConnectionSource` (the client satisfies it); `NavSection`.
- Produces: an Overview body with recent-activity and connection cards. `OverviewConnectionCard extends StackPanel` (or `TenantViewBase`-free simple card): `get Vm()`, `get Pill()`, `get DetailText()` test seams; `async Load()`; maps state via the reused VM (503->Quiet, 401 rethrow to login, 403->denied/absent, no-hive->empty).

- [ ] **Step 1: Write failing tests** - Overview: with the navigator providing an `ActivityLog` holding >5 entries, the recent-activity card shows 5 and a "See all" affordance that calls `OpenActivityDrawer`; empty log -> honest empty text. Connection card: Connected -> reachable pill + `detail`; a 503 source -> Quiet pill (not Error); no hive -> empty; the card loads once (not re-probed on a simulated env refresh).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the card + the two Overview sections. Reuse `ConnectionStatusViewModel` wholesale - no duplicated state mapping. Decouple the connection card's load from Overview's env-event `Refresh`. Hoist literals. ASCII/LF.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck`. Byte-scan new/edited files (LF; confirm `overview-view.test.ts` EOL preserved).
- [ ] **Step 5: Commit** `feat(tenant-portal): Overview recent-activity and connection cards`.

---

### Task 5: Environment detail activity list

**Files:**
- Modify: `admin/tenant-portal/src/environment-detail-view.ts` (check EOL and preserve): in the existing "Health & activity" tab, add a "Recent activity" `ActivityList` filtered to this environment via `this.Navigator?.Activity?.EntriesFor(this.env.name)`, rendered below the health line / above or below the logs toggle; honest empty state; no 24 h history strip.
- Test: `admin/tenant-portal/tests/environment-detail-view.test.ts` (check EOL and preserve). Add a case.

**Interfaces:**
- Consumes: `ITenantNavigator.Activity` (Task 3), kit `ActivityList` (Task 1), the existing `EnvironmentDetailView` Health tab builder.
- Produces: the Health & activity tab contains an env-filtered activity list that updates on the view's existing `Render` (which the shell already triggers on each tenant event via `current.Refresh()`).

- [ ] **Step 1: Write failing test** - with a navigator whose `ActivityLog` holds entries for this env and another env, the Health tab's activity list shows only this env's entries; an env with no entries shows the honest empty text; no 24 h strip element is present.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the filtered list in the Health tab. Hoist literals. Preserve the file's EOL.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck`. Byte-scan the touched files (EOL preserved).
- [ ] **Step 5: Commit** `feat(tenant-portal): Environment detail session activity list`.
