# TA-16 States matrix, accessibility, e2e hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Acceptance hardening for Tenant Admin - a states-matrix coverage test over every ScreenHost-backed full-page view (in the default gate), and a refreshed Playwright e2e spec for the nav shell that also exercises keyboard/focus - fixing any real a11y/view gap surfaced. No new product feature, view, route, or backend.

**Architecture:** UI-only, mostly test code. The states-matrix test reuses each view's existing fake-source construction to force each `ScreenState` and assert the view's `Host`/`StateHost` resolves it. The e2e spec is rewritten for the nav shell (TA-2) over the existing `FakeTenantControlPlane` (extended as needed) and adds real-browser keyboard assertions. Reduced-motion is an honest N/A (no animations; no Mural hook).

**Tech Stack:** TypeScript. Portal: `admin/tenant-portal` (Mural kit, tsx `node:test` unit harness; Playwright e2e gated behind `npm run build` + `npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-states-a11y-e2e-design.md`

## Global Constraints

- OOP, Allman braces, PascalCase public, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas. Product-code literals hoisted to `private static readonly`; test-data literals inline in tests are fine.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`). CHECK and PRESERVE the EOL of any existing file touched (`tenant-portal.spec.ts`, `fake-tenant-control-plane.ts`); never `sed -i` a CRLF file. Escape non-ASCII as `\uXXXX`, re-scan after the Write tool.
- Default gate unchanged: `npm test` + `npm run typecheck` in `admin/tenant-portal`, both green on the merged result (the new states-matrix test runs here). The e2e is NOT added to the default gate; it is verified by running `npm run build` then `npm run test:e2e` and recording the result.
- UI-only: no server change, no new route, nothing cross-tenant. Reduced-motion is an honest N/A - no stub.

## Review Focus

- The states-matrix asserts only states a view can genuinely reach (no false coverage); every ScreenHost-backed full-page view appears. (Task 1.)
- The e2e references the nav shell only (no retired `TenantTreeView`/`HiveDetailView`); it boots, navigates every section, toggles the Activity drawer, and asserts a forced empty/error state. (Task 2.)
- A focused nav item and a focused action are Enter/Space-activatable and Tab-reachable; an unreachable control is fixed, not asserted away. (Task 2.)
- The e2e was actually run (build + `test:e2e`) with the result recorded - no passing claim without evidence. (Task 2 report.)
- EOL/ASCII preserved on every touched file; default unit gate stays green. (Both.)

---

### Task 1: States-matrix coverage test (in the default gate)

**Files:**
- Create: `admin/tenant-portal/tests/states-matrix.test.ts`
- (Possibly) Modify: a view ONLY if the matrix reveals a ScreenHost-backed view that cannot reach a state it should (unlikely; if so, fix minimally and note it).

**Interfaces:**
- Consumes: each ScreenHost-backed full-page view and its state seam - Overview (`OverviewView.Host`), Environments (`EnvironmentsView.Host`), Releases (`ReleasesView.Host`), Connection status (`ConnectionStatusView.StateHost`), Settings (`SettingsView.StateHost`), Security model (`SecurityModelView.StateHost`), ComingSoon (`ComingSoonView.Host`); the kit `ScreenState` enum (`Loading`/`Empty`/`Error`/`Denied`/`Populated`); each view's existing fake-source/navigator pattern (copy from that view's own `*-view.test.ts`).
- Produces: a test file; no product interface.

- [ ] **Step 1: Write the matrix test.** For EACH listed view, in its own describe block: read the view's own `*-view.test.ts` to reuse the exact fake source + navigator + Application setup, then construct the view in each state it genuinely reaches and assert `view.<Host|StateHost>.State === ScreenState.<expected>`:
  - Loading: before/without resolving the source (initial state).
  - Populated: source returns data.
  - Empty: source returns empty (only for views with an empty state).
  - Error: source rejects with a generic error.
  - Denied: source rejects with a 403 `TenantApiError` (only for views that map 403 -> Denied).
  Assert only the states the view's own `Inputs()` wiring supports (inspect the view). Keep each view's triggers explicit; a shared helper is optional and must not hide the triggers.
- [ ] **Step 2: Run, verify the new test file executes** (it asserts existing behavior, so it should pass once written correctly; if any assertion fails, that is either a wrong expectation to correct or a genuine view gap to fix minimally - decide and note).
- [ ] **Step 3: If a genuine gap was found,** fix the view minimally; otherwise no product change.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck` in `admin/tenant-portal`. Byte-scan the new test file (`0 0 N`, LF).
- [ ] **Step 5: Commit** `test(tenant-portal): states-matrix coverage over every ScreenHost-backed view`.

---

### Task 2: Refresh the Playwright e2e for the nav shell + keyboard/focus pass

**Files:**
- Rewrite: `admin/tenant-portal/tests/tenant-portal.spec.ts` (drop the retired tree-shell flows; cover the nav shell)
- Modify (as needed): `admin/tenant-portal/tests/fake-tenant-control-plane.ts` (extend to serve the nav shell's reads - profile, environments, manifests, rollout, health - and the Activity/events the drawer and Overview cards need; keep responses honest and minimal; PRESERVE its EOL)
- Modify (only if the keyboard pass surfaces a real gap): the offending kit component or view to make a control keyboard-reachable/activatable.

**Interfaces:**
- Consumes: the nav shell (`TenantApp` booted via `main.ts`/the built `dist/`), `NavModel`/`NavSection` (the six sections + labels), the Activity drawer + top-bar toggle (TA-14), the Overview cards, `FakeTenantControlPlane`, Playwright `page` + `page.keyboard`.
- Produces: a gated e2e spec; no product interface.

- [ ] **Step 1: Rewrite the spec** for the nav shell. Study the current `tenant-portal.spec.ts` boot/serve pattern and `FakeTenantControlPlane`. Cover: boots to Overview; the six nav sections + identity plate are present; navigating each section swaps the content (assert a landmark per section); the Activity drawer toggles open/closed from the top-bar control; the Overview recent-activity and connection cards render; and at least one forced empty OR error state (drive the fake to return empty/reject) renders the honest state. Remove all retired `TenantTreeView`/`HiveDetailView` references.
- [ ] **Step 2: Add the keyboard/focus pass** (real browser): Tab from load reaches the nav items and a primary action in a sensible order; Enter (or Space) on a focused nav item navigates; Enter/Space on a focused action activates it; focus is visibly indicated (assert the focused element / a focus style). Pick the shell's primary path (nav rail + one action + the drawer toggle). Record reduced-motion as N/A in a comment - no stub.
- [ ] **Step 3: Run the e2e.** `npm run build` then `npm run test:e2e` from `admin/tenant-portal` (Playwright + headless chromium are installed). If a keyboard/focus assertion fails because a control is genuinely not reachable, FIX the control (kit/view) - do not weaken the assertion; if the gap is a Mural-framework limitation, record it honestly and file it as a Feature. Paste the `test:e2e` summary (pass/fail counts) into the report.
- [ ] **Step 4: Confirm the default gate still green.** `npm test` + `npm run typecheck` in `admin/tenant-portal` (unaffected, but verify). Byte-scan touched files; confirm `tenant-portal.spec.ts` and `fake-tenant-control-plane.ts` EOL preserved and any new file is LF/ASCII.
- [ ] **Step 5: Commit** `test(tenant-portal): nav-shell e2e coverage + keyboard/focus accessibility pass`.
