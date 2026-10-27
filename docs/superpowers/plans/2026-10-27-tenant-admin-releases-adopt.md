# Tenant Admin: Releases + Adopt wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenant-portal Releases page (offer cards + which-environment-runs-what matrix) and a hive-wide Adopt wizard, wired into the Releases nav section, over the existing rollout reads and the one `SelectTarget` adopt operation — no backend changes.

**Architecture:** Portal-only. A new `Steps` kit primitive, a `ReleasesViewModel` (Observable) that lifts the reusable rollout derivations from `HiveDetailViewModel` (version badging, current-version resolution, restart-impact text) and adds offers/matrix/adopt-outcome, an inline-hosted `AdoptWizard` driven by `Steps`, a `ReleasesView` (cards + matrix + states), and one `ShowSection` wiring. The dead `hive-detail-view*.ts` is left untouched.

**Tech Stack:** TypeScript, Mural (`StackPanel`/`TextBlock`/`Button`/`DataGrid`), portal kit (`ScreenHost`, `Section`, `KeyValueGrid`, `Act`, `StatusPill`, new `Steps`), node:test.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-releases-adopt-design.md`

## Global Constraints

- **EOL (never flip):** `admin/tenant-portal/src/tenant-app.ts` = **CRLF**; `admin/tenant-portal/src/tenant-api-client.ts` = **CRLF**; `tenant-types.ts`, all `kit/*`, and all new view/VM/wizard files = **LF**; new test files = **LF**. New `.ts` code is ASCII (`—` em dash, `·` middot as escapes).
- OOP: no free functions, no module-level mutable state. Allman braces. PascalCase public methods/interfaces. Enums over string-literal unions. VMs extend `Observable`. No inline string literals — hoist to `private static readonly`. Teardown via `Dispose()` where needed.
- **No backend, no DTO changes:** do NOT extend `ManifestDto` / `HiveRolloutDto` / `RolloutEnvDto` and add no server route. Reads: `ListManifests()`, `GetRollout(hiveId)`, `ListEnvironments()`; adopt: `SelectTarget(hiveId, version)` — all already on `TenantApiClient`.
- Do NOT modify or delete `hive-detail-view.ts` / `hive-detail-view-model.ts` (kept dead + compiling). Lift logic by copying the needed derivations into the new VM.
- Adopt is **hive-wide** (spec R1): the Environments wizard step is informational, not a selector.
- Hive id source: `Navigator.Profile?.hive?.id`, falling back to the first `ListHives()` id; the view supplies it to the VM.
- Tests live under `admin/tenant-portal/tests/**`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Empty offers** (all non-withdrawn manifests are the current target, or only withdrawn exist) → ScreenHost empty state, not blank/error. → Task 4 tests.
- **Adopt refused (409)** → Outcome shows the server's generic message verbatim; reload proves the hive stayed on its current target; no success claim. → Task 2 + Task 3 tests.
- **Adopt unavailable (503)** → Unavailable outcome with the server message; no fabricated success. → Task 2 + Task 3 tests.
- **Version withdrawn before Adopt** → never a valid target; Adopt not offered on a withdrawn card and a direct confirm is a no-op; clean outcome, no exception. → Task 2 tests.
- **No environments bound to the hive** → Environments step + impact text handle the empty case; adopt still sets the target. → Task 2 + Task 3 tests.
- **Adopt denied** (`Capabilities.adopt === false`) → Adopt visible-but-disabled naming the permission (never hidden); enabled when `adopt !== false`. → Task 4 tests.

---

### Task 1: Kit `Steps` primitive

**Files:**
- Create: `admin/tenant-portal/src/kit/steps.ts` (LF)
- Modify: `admin/tenant-portal/src/kit/index.ts` (LF) — export `Steps` (+ inputs type)
- Test: `admin/tenant-portal/tests/kit/steps.test.ts` (LF)

**Interfaces:**
- Produces: `Steps extends StackPanel`, constructed from `{ labels: string[] }`; renders an ordered strip of step labels with the active one marked (icon+text, not colour alone — reuse `KitGlyph`/a `ButtonVariant`/`Tones`); `get ActiveIndex(): number`; `Select(index: number): void`; `Advance(): void` / `Back(): void` (clamped, no-op at ends); optional `onChange?: (index: number) => void` on a real change. No branching/validation.

- [ ] **Step 1: Write failing tests** — three labels start at `ActiveIndex === 0`; `Advance()` → 1, `Back()` → 0, `Back()` at 0 is a no-op, `Advance()` past the last is a no-op; `Select(2)` → 2 and marks step 2 active; `onChange` fires only on a real change. (Themed `Application` if a brush resolves — mirror `kit/tabs.test.ts`.)
- [ ] **Step 2: Run to verify fail.** `npx tsx --test admin/tenant-portal/tests/kit/steps.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `kit/steps.ts`; export from `kit/index.ts`.
- [ ] **Step 4: Run to verify pass** + `npm run typecheck:tools`.
- [ ] **Step 5: Commit.** `feat(tenant-portal): kit Steps primitive`.

---

### Task 2: `ReleasesViewModel`

**Files:**
- Create: `admin/tenant-portal/src/releases-view-model.ts` (LF)
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF) — add `IReleasesSource` (the client slice) and any shared row/outcome types
- Test: `admin/tenant-portal/tests/releases-view-model.test.ts` (LF)

**Interfaces:**
- Consumes: `IReleasesSource { ListManifests(): Promise<ManifestDto[]>; GetRollout(hiveId): Promise<HiveRolloutDto>; ListEnvironments(): Promise<EnvironmentDto[]>; SelectTarget(hiveId, version): Promise<void> }` (`TenantApiClient` satisfies it structurally).
- Produces on `ReleasesViewModel extends Observable` (constructed with `(source, hiveId)`):
  - `Load(): Promise<void>` — `Promise.all` of ListManifests + GetRollout + ListEnvironments; generation newer-wins.
  - Derivations LIFTED from `HiveDetailViewModel` (copy, do not import): version rows with `VersionBadge` (Current/Previous/Available/Withdrawn), current-version resolution (`targetVersion` is truth; else the single running image only if every env agrees), restart-impact text (incl. the "no environments are bound to this hive" case).
  - `get Offers(): readonly Offer[]` where an offer is a non-withdrawn, non-current manifest; `Offer = { manifest, version, notBehindCount }` with `notBehindCount` = number of `rollout.environments` whose `runningImage !== manifest.image` ("N environments not on this version").
  - `get Matrix(): MatrixModel` — rows = environments (name + status), columns = the known versions, cell = Running when the env's `runningImage` matches the column version else none.
  - `EnvSteps(version): readonly EnvStepInfo[]` for the wizard step 2 — per env: `onVersion` (already running it), `willRestart` (running, not on it), `startsLater` (stopped) from `EnvironmentDto.status` + the env's running image.
  - Adopt flow: `BeginAdopt(version)` (guarded: a withdrawn version is a no-op), `ConfirmAdopt(): Promise<AdoptOutcome>` → calls `SelectTarget`, maps the result to `enum AdoptOutcome { Adopted, Refused, Unavailable, Unknown }` using the `TenantApiError.Status` (204→Adopted after reload; 409→Refused with the server message; 503→Unavailable with the server message; 404→Unknown/reload) — expose the server message string for Refused/Unavailable without augmenting it; on success `await Load()`.
  - `ApplyEvent(ev): Promise<boolean>` — reload on a change/delete for one of the hive's environments (mirror `HiveDetailViewModel.ApplyEvent`).

- [ ] **Step 1: Write failing tests** (fake `IReleasesSource`):
  - Offers exclude the current target and withdrawn manifests; `notBehindCount` counts envs not on the version.
  - Matrix marks Running only where `runningImage` matches the column version.
  - Current-version resolution: `targetVersion` wins; with none, unanimous running image resolves, mixed → none.
  - `EnvSteps`: a running env not on the version → `willRestart`; a stopped env → `startsLater`; an env already on it → `onVersion`.
  - `BeginAdopt` on a withdrawn version is a no-op.
  - `ConfirmAdopt`: source resolves → `Adopted` and rollout reloaded; source throws `TenantApiError(409, msg)` → `Refused` + the message, hive target unchanged (no reload mutation of target); `TenantApiError(503, msg)` → `Unavailable` + message.
  - Empty environments: impact text uses the "no environments" copy; adopt still submits.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `releases-view-model.ts` + `IReleasesSource` in `tenant-types.ts`.
- [ ] **Step 4: Run to verify pass** + typecheck.
- [ ] **Step 5: Commit.** `feat(tenant-portal): ReleasesViewModel (offers, matrix, hive-wide adopt outcomes)`.

---

### Task 3: `AdoptWizard`

**Files:**
- Create: `admin/tenant-portal/src/adopt-wizard.ts` (LF)
- Test: `admin/tenant-portal/tests/adopt-wizard.test.ts` (LF)

**Interfaces:**
- Consumes: `ReleasesViewModel` (Task 2), kit `Steps` (Task 1), `KeyValueGrid`, `Section`, `Button`.
- Produces: `AdoptWizard extends StackPanel`, constructed with `{ vm: ReleasesViewModel, version: string, onClose: () => void }`. Drives the five steps with `Steps`: (1) Version summary; (2) `EnvSteps(version)` informational list; (3) Review impact + fixed trust note; (4) Roll out — on entry calls `vm.ConfirmAdopt()`, shows "Rolling…" while pending; (5) Outcome — renders the `AdoptOutcome` (Adopted / Refused + server message / Unavailable + server message), with a Close that calls `onClose`. Back/Next advance steps 1–3; step 4 auto-runs; no step renders fabricated per-step progress. Expose test seams: `get ActiveStep(): number`, `Next()`/`Back()`, and the outcome text.

- [ ] **Step 1: Write failing tests:** Next walks Version → Environments → Review; from Review, proceeding runs step 4 then lands on Outcome; a fake VM returning `Adopted` shows the adopted copy; a fake VM returning `Refused` with a message shows that message and NOT an adopted claim; Close calls `onClose`. The trust note text is present on Review.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `adopt-wizard.ts`.
- [ ] **Step 4: Run to verify pass** + typecheck.
- [ ] **Step 5: Commit.** `feat(tenant-portal): AdoptWizard (hive-wide, Steps-driven, honest outcomes)`.

---

### Task 4: `ReleasesView`

**Files:**
- Create: `admin/tenant-portal/src/releases-view.ts` (LF)
- Test: `admin/tenant-portal/tests/releases-view.test.ts` (LF)

**Interfaces:**
- Consumes: `ReleasesViewModel` (Task 2), `AdoptWizard` (Task 3), kit `ScreenHost`/`Section`/`KeyValueGrid`/`Act`/`StatusPill`/`DataGrid`, `TenantViewBase`.
- Produces: `ReleasesView extends TenantViewBase` built with `(source, hiveId, capabilities)` (or reads caps via `Navigator`). Renders: offer cards (version, published, notes, withdrawn badge, "N environments not on this version", Adopt via `Act` gated on `adopt !== false`); the matrix `DataGrid`; the `ScreenHost` states (loading / empty "No new versions offered. New versions arrive when your hive checks in." / populated / error / denied). The Adopt action opens an `AdoptWizard` hosted inline (AddChild; `onClose` removes it; guard against two open at once). `Refresh()` loads; `ApplyEvent` forwards to the VM (shell wiring in Task 5). `Dispose()` if needed.

- [ ] **Step 1: Write failing tests** (fake source + fake navigator with `Capabilities`): offer cards render per offer with the not-on count; empty offers → empty state; matrix renders env rows and Running cells; Adopt opens an `AdoptWizard` child; `adopt === false` → Adopt disabled naming the permission; a load error → error state.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `releases-view.ts`.
- [ ] **Step 4: Run to verify pass** + typecheck.
- [ ] **Step 5: Commit.** `feat(tenant-portal): ReleasesView (offer cards + runs-what matrix + Adopt)`.

---

### Task 5: Wire Releases into the shell

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF)
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (extend; CRLF — match the file)

**Interfaces:**
- Consumes: `ReleasesView` (Task 4); `NavSection.Releases`; `Navigator.Profile`.
- Produces: `ShowSection(NavSection.Releases)` builds a `ReleasesView` with the resolved hive id (from `this.profile?.hive?.id`, else `await this.client.ListHives()` first id) and shows it; live `TenantEvent`s route to it while active (mirror the Environments `environments` marker pattern, or the generic `this.current?.Refresh()` path if simpler — but prefer forwarding `ApplyEvent` to avoid a full refresh). Keep the ComingSoon default for the still-unbuilt sections.

- [ ] **Step 1: Write a failing test:** selecting the Releases nav section shows a `ReleasesView` (not ComingSoon). (Mirror the Environments nav test in `tenant-app.test.ts`.)
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** the `NavSection.Releases` case + any live-event routing; preserve CRLF.
- [ ] **Step 4: Run the FULL portal suite** `npx tsx --test admin/tenant-portal/tests/*.test.ts admin/tenant-portal/tests/kit/*.test.ts` + `npm run typecheck:tools`. Expected: all PASS, clean.
- [ ] **Step 5: Commit.** `feat(tenant-portal): Releases nav section wiring`.

---

## Self-review notes

- **Spec coverage:** offer cards + matrix (T2 derivations, T4 view), hive-wide Adopt wizard with the five stops (T3 over T1+T2), empty/denied/error states (T4), adopt gating (T4), nav wiring (T5), `Steps` primitive (T1). Non-goals (per-env target, channel/migrations, fine progress, distinct outcome codes, Refused cell) are out.
- **Type consistency:** `SelectTarget(hiveId, version)`, `AdoptOutcome`, and `IReleasesSource` are used identically across VM, wizard, and view. `VersionBadge` reused from `tenant-types.ts`.
- **Review Focus:** empty offers, 409 refused, 503 unavailable, withdrawn-before-adopt, no-environments, adopt-denied each have an owning task + test above.
- **Proportion:** server untouched; the weight is the VM derivations (largely lifted) and the two views + wizard — inherent to two linked screens.
