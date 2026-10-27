# Tenant Admin: Overview (home) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenant-portal Overview home — header + Create environment, an offer banner when a newer version is available and environments are behind, a grid of environment cards, and loading/empty/error states — over existing reads, wired into the Overview nav section.

**Architecture:** Portal-only. An `OverviewViewModel` (Observable) aggregating `ListEnvironments`+`GetHealth` (cards, via `EnvironmentRow`) and `ListManifests`+`GetRollout` (offer signal); a reusable `EnvironmentCard`; an `OverviewView` (header/Create/banner/cards/states, inline create dialog); one `ShowSection` wiring. No backend, no DTO changes.

**Tech Stack:** TypeScript, Mural (`StackPanel`/`TextBlock`/`Button`), portal kit (`ScreenHost`, `Section`, `Banner`, `Act`, `StatusPill`), `EnvironmentRow`, `CreateEnvironmentDialog`, node:test.

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-overview-design.md`

## Global Constraints

- **EOL (never flip):** `admin/tenant-portal/src/tenant-app.ts` = **CRLF**; `tenant-types.ts`, all `kit/*`, and new view/VM/card files = **LF**; new test files = **LF**. New `.ts` is ASCII — escape any em dash/ellipsis as `—`/`…`, NEVER a raw multibyte character (this slipped twice in TA-6; verify with a python byte-scan, not `grep -P`).
- OOP: no free functions, no module-level mutable state. Allman braces. PascalCase public methods/interfaces. Enums over string-literal unions. VMs extend `Observable`. No inline string literals — hoist to `private static readonly`. Teardown via `Dispose()`.
- **No backend, no DTO changes.** Reads only: `ListEnvironments()`, `GetHealth(hiveId)`, `ListManifests()`, `GetRollout(hiveId)`, plus `CreateEnvironment(params)` for quick-create — all on `TenantApiClient`.
- Reuse `EnvironmentRow` for card data (do not re-derive name/pills/version/URL). Reuse `CreateEnvironmentDialog` for create (do not rebuild it). Host the create dialog inline (no `ITenantNavigator` change).
- Hive id: `Navigator.Profile?.hive?.id`, else first `ListHives()` (as in `tenant-app.ShowReleases`).
- Tests under `admin/tenant-portal/tests/**`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **No environments** → empty state with a working Create action, not blank/error. → Task 1 + Task 3 tests.
- **Offer available vs not** → the VM boolean is true only when a non-withdrawn, non-current version exists AND an environment is behind it; false when all current. → Task 1 tests.
- **Load error** → error state (health may degrade like TA-4 — decide + test), never a half-home. → Task 1 + Task 3 tests.
- **Stopped/Failed/Unknown card** → correct pills via `EnvironmentRow`; URL absent when not Running. → Task 2 tests.
- **Live event after load** (create/start/stop/delete) → cards + offer banner update via `ApplyEvent`. → Task 1 + Task 3 tests.
- **Create/Adopt denied** (future role) → action visible-but-disabled naming the permission; enabled today. → Task 3 tests.

---

### Task 1: `OverviewViewModel`

**Files:**
- Create: `admin/tenant-portal/src/overview-view-model.ts` (LF)
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF) — add `IOverviewSource`
- Test: `admin/tenant-portal/tests/overview-view-model.test.ts` (LF)

**Interfaces:**
- Consumes: `IOverviewSource { ListEnvironments(): Promise<EnvironmentDto[]>; GetHealth(hiveId: string): Promise<HiveHealthDto[]>; ListManifests(): Promise<ManifestDto[]>; GetRollout(hiveId: string): Promise<HiveRolloutDto>; CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto> }` (`TenantApiClient` satisfies it). Reuse `EnvironmentRow`.
- Produces on `OverviewViewModel extends Observable` (ctor `(source, hiveId)`):
  - `Load(): Promise<void>` — `Promise.all` of the four reads; generation newer-wins; join health→environments into `EnvironmentRow`s. Health failure may degrade (rows without health) like TA-4 — pick and test; a `ListEnvironments` failure is a load error.
  - `get Rows(): readonly EnvironmentRow[]`.
  - `get OfferAvailable(): boolean` and `get OfferedVersion(): string | undefined` — the minimal offer derivation (mirror TA-6 `ReleasesViewModel`): a non-withdrawn manifest that is not the current version (current resolved via `targetVersion` else unanimous running image) with at least one environment whose `runningImage` differs from it; `OfferedVersion` = the newest such version's tag.
  - `get ExistingNames(): readonly string[]` — environment names (for the create dup-check).
  - `get Error(): boolean` (or error message) + `get Loaded(): boolean` for the `ScreenHost` state.
  - `ApplyEvent(ev): Promise<boolean>` — reload on any env lifecycle event (mirror the releases/hive VM).

- [ ] **Step 1: Write failing tests** (fake `IOverviewSource`): rows built from envs+health join; `OfferAvailable` true when a newer non-withdrawn version exists and an env is behind, false when all envs current or only withdrawn/current manifests; `OfferedVersion` is the newest offered tag; `ExistingNames` lists env names; a `ListEnvironments` throw → `Error` true; `ApplyEvent` reloads.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `overview-view-model.ts` + `IOverviewSource`.
- [ ] **Step 4: Run to verify pass** + `npm run typecheck:tools`.
- [ ] **Step 5: Commit.** `feat(tenant-portal): OverviewViewModel (env aggregation + offer signal)`.

---

### Task 2: `EnvironmentCard`

**Files:**
- Create: `admin/tenant-portal/src/environment-card.ts` (LF)
- Test: `admin/tenant-portal/tests/environment-card.test.ts` (LF)

**Interfaces:**
- Consumes: `EnvironmentRow`, kit `StatusPill`/`PillKinds`, `Section`.
- Produces: `EnvironmentCard extends StackPanel`, ctor `{ row: EnvironmentRow, onOpen: () => void }` (or `(row, onOpen)`): renders the environment name, a status `StatusPill` (`row.StatusPill`), a health `StatusPill` (`row.HealthPill`), the application/version (`row.Version` / `row.Template`), and the live URL text (`row.Url` when Running, else an empty-state label). The card (or a name button) invokes `onOpen` on click. Test seams as needed (expose the rendered texts / a click entry).

- [ ] **Step 1: Write failing tests:** a card for a Running env shows name, two pills, version, and the URL; a Stopped/Failed env shows the correct pills and no URL (empty-state label); clicking the card/name invokes `onOpen` once. (Themed `Application`, mirror `kit/status-pill.test.ts`.)
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `environment-card.ts`.
- [ ] **Step 4: Run to verify pass** + typecheck.
- [ ] **Step 5: Commit.** `feat(tenant-portal): EnvironmentCard component`.

---

### Task 3: `OverviewView`

**Files:**
- Create: `admin/tenant-portal/src/overview-view.ts` (LF)
- Test: `admin/tenant-portal/tests/overview-view.test.ts` (LF)

**Interfaces:**
- Consumes: `OverviewViewModel` (Task 1), `EnvironmentCard` (Task 2), `CreateEnvironmentDialog`, kit `ScreenHost`/`Section`/`Banner`/`BannerTone`/`Act`/`ActVariant`, `TenantViewBase`.
- Produces: `OverviewView extends TenantViewBase`, ctor `(source, hiveId)` where `source` satisfies both `IOverviewSource` (for the VM) and `IEnvironmentsSource` (for `CreateEnvironmentDialog`) — type the param as `IOverviewSource & IEnvironmentsSource` (`TenantApiClient` and the test fake satisfy both). Renders:
  - header "Overview" + a primary Create `Act` (gated `Navigator?.Capabilities?.envs !== false`).
  - an offer `Banner` (Info) shown only when `vm.OfferAvailable`, with a Review-and-adopt `Act` (gated `adopt !== false`) → `this.Navigator?.ShowSection(NavSection.Releases)`.
  - a grid of `EnvironmentCard`s from `vm.Rows`, each `onOpen` → `this.Navigator?.ShowEnvironmentDetail(row.Dto)`.
  - `ScreenHost` states: loading / empty ("No environments yet. Create your first environment." + Create) / populated / error.
  - Create opens a `CreateEnvironmentDialog(source, vm.ExistingNames, onCreated)` hosted INLINE (AddChild; dismiss/close removes it; guard one-at-a-time); `onCreated` → `this.Navigator?.ShowEnvironmentDetail(env)`.
  - `Refresh()` → `vm.Load` + rebuild; `ApplyEvent(ev)` → `vm.ApplyEvent` + rebuild; property subscription rebuilds; `Dispose()` closes an open dialog + disposes subscriptions.

- [ ] **Step 1: Write failing tests** (fake source + fake navigator with `Capabilities`): header + Create render; offer banner shows when `OfferAvailable` and is ABSENT otherwise; cards render per `vm.Rows`; empty rows → empty state; a load error → error state; clicking Create opens a `CreateEnvironmentDialog` child; the banner's Review-and-adopt calls `Navigator.ShowSection(Releases)`; a card click calls `Navigator.ShowEnvironmentDetail`; `envs === false` / `adopt === false` disable the respective actions naming the permission.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `overview-view.ts`.
- [ ] **Step 4: Run to verify pass** + typecheck.
- [ ] **Step 5: Commit.** `feat(tenant-portal): OverviewView (home: cards + offer banner + create)`.

---

### Task 4: Wire Overview into the shell

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF)
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (extend; CRLF)

**Interfaces:**
- Consumes: `OverviewView` (Task 3); `NavSection.Overview`; `Navigator.Profile`.
- Produces: `ShowSection(NavSection.Overview)` builds an `OverviewView` with the resolved hive id (mirror `ShowReleases`: `this.profile?.hive?.id` else async `ListHives()` first id, with the post-await staleness guard and a ComingSoon/empty degrade when no hive) and shows it. Boot already lands on Overview. Live events reach it via the existing generic `this.current?.Refresh()` path.

- [ ] **Step 1: Write a failing test:** after boot/login, the Overview nav section (the landing) shows an `OverviewView` (not `ComingSoonView`). Extend the fake client in `tenant-app.test.ts` if it lacks any of the four reads (it already serves them for other sections).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** the `NavSection.Overview` case + a `ShowOverview()` resolver; preserve CRLF.
- [ ] **Step 4: Run the FULL portal suite** `npx tsx --test admin/tenant-portal/tests/*.test.ts admin/tenant-portal/tests/kit/*.test.ts` + `npm run typecheck:tools`. Expected: all PASS, clean.
- [ ] **Step 5: Commit.** `feat(tenant-portal): Overview nav section wiring`.

---

## Self-review notes

- **Spec coverage:** header + Create (T3), offer banner shown/hidden (T1 signal + T3 render), environment cards (T2 + T3), states (T3), quick-create inline (T3), nav wiring + landing (T4). Non-goals (activity/connection/components cards, verify-failed pill, baseDomain address) are out.
- **Type consistency:** `IOverviewSource`, `OfferAvailable`/`OfferedVersion`, `EnvironmentCard` ctor used identically across tasks; `EnvironmentRow` reused, not re-derived.
- **Review Focus:** empty, offer-both-ways, load error, non-Running pills, live event, denied — each has an owning task + test.
- **Proportion:** server untouched; weight is the VM aggregation + the view; the card is small and reusable.
