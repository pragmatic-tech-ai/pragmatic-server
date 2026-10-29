# Platform Admin Registry Withdraw/Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Full-operator-gated Withdraw/Restore action to the release detail page, wiring the existing `POST|DELETE /api/manifests/:version/withdrawn` endpoints; an Observer sees it disabled with a needed-role hint, and a successful toggle re-fetches (re-shows the detail) rather than patching local state.

**Architecture:** Portal-only. `ControlPlaneClient` gains one write method `SetManifestWithdrawn(version, withdraw)`. `ReleaseDetailViewModel` exposes `Withdrawn`. `ReleaseDetailView` gets `operator` + an async `onToggleWithdrawn` callback and renders a state-driven Full-gated `Act` (Withdraw=Danger / Restore=Secondary). `ReleasesView.BuildDetail` supplies the callback (`SetManifestWithdrawn` then the base's public `ShowDetail(row)`, which re-fetches). No new route, no authorization rule, no kit primitive.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); portal `@pragmatic-tech-ai/mural` + the portal `kit` + `node:test` with the `Application.current` harness; control-plane `node:http` host + `node:test` (`npx tsx --test`) for the gate lock.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-registry-withdraw-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (the `'withdrawn'` path segment, action labels, error text).
- New/edited `.ts`: pure ASCII, LF. Byte-scan each written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. `control-plane-host.ts` is NOT a target (keeps its 6 pre-existing non-ASCII); add none if any CP source is touched. Match EOL (all LF).
- HONESTY: reported == enforced. The action is gated with `operator.MutatingAct` (same gate the server enforces); NO optimistic flag flip; re-fetch (re-show the detail) after the write. No raw internal ref (the route carries only the version).
- No cross-app import (`admin/tenant-portal`). The detail view survives a re-render (fresh slot per render - a Visual holds one parent). Add no kit primitive, no route, no authorization rule.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.

## Review Focus

- An Observer (ReadOnly) on a release detail -> the Withdraw/Restore action is VISIBLE but disabled with the needed-role hint. -> Task 2 (+ Task 3 proves the server 403).
- A published manifest shows "Withdraw version" (Danger, targets withdraw=true); a withdrawn one shows "Restore version" (Secondary, targets withdraw=false) - label/variant/target track `vm.Withdrawn`, not hardcoded. -> Task 2.
- A failing toggle -> one error line, the detail stays, no crash, no local flag flip. -> Task 2.
- After a successful toggle the detail reflects the SERVER's new state via a re-fetch (re-show), not a patched VM. -> Task 2 (ReleasesView wiring).
- A restore `DELETE` carries no body and a version needing URL-encoding is encoded. -> Task 1.
- The detail view re-rendered does not double-parent its action/error Visuals. -> Task 2.

---

### Task 1: `ControlPlaneClient.SetManifestWithdrawn`

**Files:**
- Modify: `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts`

**Interfaces:**
- Consumes: existing `POST /api/manifests/:version/withdrawn` (withdraw) + `DELETE` (restore) -> `ManifestDto`; the private `Send<T>`, `ManifestsRoute`, `MethodPost`/`MethodDelete`, `PathSeparator`, `encodeURIComponent`.
- Produces: `SetManifestWithdrawn(version: string, withdraw: boolean): Promise<ManifestDto>`.

- [ ] **Step 1: Write failing tests** (mirror the PA-R1 `PublishManifest`/`Ungate` cases with the fetch fake): `SetManifestWithdrawn('1.0.0', true)` issues `POST /api/manifests/1.0.0/withdrawn` (no body needed) and returns the parsed `ManifestDto`; `SetManifestWithdrawn('1.0.0', false)` issues `DELETE /api/manifests/1.0.0/withdrawn`; `SetManifestWithdrawn('a/b', true)` path-encodes the version (`a%2Fb`).
- [ ] **Step 2: Run the new tests, verify they fail.**
- [ ] **Step 3: Implement** - add a hoisted `WithdrawnSegment = 'withdrawn'` and a `ManifestWithdrawnRoute(version)` = `ManifestsRoute + PathSeparator + encodeURIComponent(version) + PathSeparator + WithdrawnSegment` builder next to the existing route helpers. `SetManifestWithdrawn(version, withdraw)` -> `Send<ManifestDto>(this.ManifestWithdrawnRoute(version), { method: withdraw ? MethodPost : MethodDelete })` (no body).
- [ ] **Step 4: Byte-scan `api-client.ts`** -> non-ASCII 0, CR 0.
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; commit** (`feat(portal): ControlPlaneClient.SetManifestWithdrawn`).

---

### Task 2: Withdraw/Restore action on `ReleaseDetailView` (+ VM getter + `ReleasesView` wiring)

**Files:**
- Modify: `admin/portal/src/release-detail-view-model.ts`, `admin/portal/src/release-detail-view.ts`, `admin/portal/src/releases-view.ts`
- Test: `admin/portal/tests/release-detail-view.test.ts` (and/or the existing releases/release-detail test file), `admin/portal/tests/release-detail-view-model.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.SetManifestWithdrawn` (Task 1); `OperatorContext.MutatingAct`; kit `Act`/`ActVariant`; `SectionContainerView.ShowDetail` (public, re-fetches via `BuildDetail`).
- Produces: `ReleaseDetailViewModel.Withdrawn: boolean`; `ReleaseDetailView` ctor `(vm, onBack, operator: OperatorContext, onToggleWithdrawn: (withdraw: boolean) => Promise<void>)`; the Full-gated toggle action.

- [ ] **Step 1: Read `releases-view.ts` (`BuildDetail`, how it already uses `this.operator`), `release-detail-view.ts` (its `BuildContent`/fresh-slot structure, the existing `WithdrawnBanner` render), and PA-R1's `ReleasesView.Submit`** (the catch -> one error line pattern to mirror).
- [ ] **Step 2: Write failing tests**:
  - VM: `Withdrawn` is `true` for a manifest with `withdrawn: true`, else `false`.
  - Detail view (construct `ReleaseDetailView` directly with a VM, a no-op `onBack`, an operator, and a spy `onToggleWithdrawn`): a PUBLISHED manifest renders an action labelled "Withdraw version" (Danger); a WITHDRAWN manifest renders "Restore version" (Secondary). For an Observer operator the action is disabled (`Enabled === false`) with a non-empty `DisabledHint`. For a Full operator, activating the action calls `onToggleWithdrawn` with `!vm.Withdrawn`. A rejecting `onToggleWithdrawn` leaves one error line and does not throw.
  - ReleasesView wiring: entering a detail (Full operator) then activating withdraw calls `client.SetManifestWithdrawn(row.id, true)` and then re-fetches (`ListManifests` called again). Mirror the existing releases-view test harness + ControlPlaneClient fake.
- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement**:
  - VM: add `get Withdrawn(): boolean { return this.manifest.withdrawn === true }`.
  - Detail view: extend the ctor to `(vm, onBack, operator, onToggleWithdrawn)`; store them. In `BuildContent`, build a FRESH Full-gated `Act` each render via `operator.MutatingAct(vm.Withdrawn ? RestoreLabel : WithdrawLabel, () => void this.Toggle(), vm.Withdrawn ? ActVariant.Secondary : ActVariant.Danger)`, plus a FRESH error `TextBlock`. `Toggle()`: `try { await this.onToggleWithdrawn(!this.vm.Withdrawn) } catch { errorLine.Text = <hoisted FailedText> }`. Place the action near the banner/profile. Hoist all literals; add a test seam getter for the action/error line matching the file's style.
  - ReleasesView: in `BuildDetail(row)`, pass `this.operator` and `async (withdraw: boolean) => { await this.client.SetManifestWithdrawn(row.id, withdraw); await this.ShowDetail(row) }`.
- [ ] **Step 5: Run tests -> PASS.** Byte-scan all three touched files -> `0 0 N`.
- [ ] **Step 6: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`; commit** (`feat(portal): withdraw/restore a manifest version from the release detail (Full-gated)`).

---

### Task 3: Control-plane gate lock (ReadOnly 403 on the withdrawn routes)

**Files:**
- Modify/Test: `admin/control-plane/tests/control-plane-host-rbac.test.ts` (the PA-R1 registry-write 403 test)

**Interfaces:**
- Consumes: the existing `RbacFixture` (role-token send, status constants).

- [ ] **Step 1: Read the PA-R1 `'403s a ReadOnly operator on the registry-write routes'` test** and its `RbacFixture`. Add hoisted fixture constants for the withdrawn paths.
- [ ] **Step 2: Write failing (expected-passing) cases** - extend the loop (or add a focused `it`): a ReadOnly operator sending `POST /api/manifests/1.0.0/withdrawn` and `DELETE /api/manifests/1.0.0/withdrawn` (empty body for the DELETE, matching the portal) each gets 403.
- [ ] **Step 3: Run; they should PASS immediately** (the central gate already enforces this - the test locks it). If a case FAILS it has found a real gate hole; STOP and rule. Byte-scan the test file -> `0 0 N`.
- [ ] **Step 4: `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; commit** (`test(control-plane): manifest withdraw/restore is Full-operator-only`).
