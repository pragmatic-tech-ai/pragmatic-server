# TA-16 - States matrix, accessibility, e2e hardening - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The LAST Tenant Admin spec (closes the brief acceptance checklist).
**Area:** Tenant Admin - cross-cutting test + accessibility hardening over the whole portal (no new product feature).
**Builds on:** the kit `ScreenHost`/`ScreenState` (loading/empty/error/denied/populated), every full-page view's state seam, the TA-2 nav shell, the TA-14 Activity drawer + Overview cards, the existing `FakeTenantControlPlane` + the gated Playwright harness.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 4 item 16, and section 5 (prototype `StatesMatrix` tenant.jsx:505, `Screen`/`EmptyState`/`DeniedState` in shared.jsx).

## The scope decision (recon finding + ruling)

TA-16 is the acceptance-hardening spec: a forced-state harness for every list/detail, a keyboard/focus/reduced-motion accessibility pass, and Playwright coverage of the new shell. Recon established what is genuine:

- **State handling already exists.** The kit `ScreenHost` resolves exactly one of loading > denied > error > empty > populated, and every full-page view already wires it with per-view unit tests. What is missing is a single **coverage gate** that systematically drives every ScreenHost-backed view through each applicable state - catching a view that silently can't reach one (the prototype's `StatesMatrix`). That is a test-level deliverable, not new product code.
- **Mural has a real keyboard/focus model** (`FocusManager`, `KeyboardNavigation`, `OnKeyDown`, `dispatchKey`, `InjectKeyDown`; `Button` handles Enter/Space activation). The nav rail is built from `Button`s, the kit actions (`Act`) wrap `Button`, tabs and the drawer toggle are focusable controls. So a keyboard/focus accessibility pass is **genuinely testable** (best in a real browser via Playwright `page.keyboard`), and any control found not keyboard-reachable is a real fix.
- **Reduced-motion has nothing to honor.** The kit uses no animations/transitions, and Mural exposes no `prefers-reduced-motion` hook. There is nothing to toggle and nothing to fake. Reduced-motion is recorded as **not applicable** (an honest N/A, not a fabricated setting).
- **The e2e spec is stale.** `tenant-portal.spec.ts` drives the pre-TA-2 tree-first shell (`TenantTreeView`/`HiveDetailView`), which the nav shell replaced. It is gated (`npm run test:e2e`, needs `npm run build` + Playwright browsers) and out of the default unit gate, so it rotted unseen. Playwright 1.64.1 + headless chromium are available in this environment, so the refreshed spec can actually be run here.

**Ruling: TA-16 is UI-only test + accessibility hardening.** It adds (1) a states-matrix coverage test over the ScreenHost-backed views, and (2) a refreshed Playwright spec for the nav shell that also exercises keyboard/focus. It fixes any real view/control gap the hardening surfaces. It invents no product feature and no backend. Reduced-motion is an honest N/A. This is the brief's section 7 acceptance pass, applied honestly: verify what the software does, fix what is actually broken, and do not fabricate coverage for behavior the framework does not have.

## Goals

- A **states-matrix coverage test** (`tests/states-matrix.test.ts`, in the default `tsx --test` gate) that constructs each ScreenHost-backed full-page view with fakes that force each applicable `ScreenState` and asserts the view's `Host`/`StateHost` resolves to it. Views covered: Overview, Environments, Releases, Connection status, Settings, the consolidated Security model editor, and ComingSoon. Each asserts the states it genuinely has (e.g. denied only where a 403 maps to Denied; empty where the view has an empty state).
- A **refreshed Playwright e2e spec** (`tenant-portal.spec.ts`, gated) for the nav shell: boot to Overview; assert the six nav sections and the identity plate; navigate across sections; toggle the Activity drawer; assert the Overview cards render; and drive at least one forced empty/error state through the `FakeTenantControlPlane`.
- A **keyboard/focus accessibility pass** inside the e2e spec (real-browser keyboard): Tab reaches the nav items and the primary actions in a sensible order; Enter/Space activates a focused nav item (navigates) and a focused action; focus is visibly indicated. Any control that cannot be reached or activated by keyboard is fixed.
- Honest recording of **reduced-motion as not applicable** (no animations; no framework hook) in the spec/design, with no fabricated toggle.

## Non-goals

- **Any new product feature, view, route, or backend** - TA-16 is pure hardening.
- **A generic runtime "states harness" shipped in the app** - the matrix is a test, not a product screen (the prototype's `StatesMatrix` was a dev aid).
- **Reduced-motion handling** - nothing to honor; honest N/A, not a stub.
- **ARIA/screen-reader semantics beyond what Mural's model provides** - if Mural lacks a needed a11y primitive (e.g. roles/labels), that is a framework GAP filed as a Feature, not faked in the portal.
- **Re-testing per-view state logic already covered** - the matrix is a coverage gate over the ScreenHost resolution, not a duplication of each view's bespoke tests; views without a ScreenHost (Environment detail, Users & Access page) keep their existing per-view state tests and are out of the matrix's scope.
- **Running the gated e2e inside the default unit gate** - it stays a separate `test:e2e` run (browsers + build); the default gate remains `npm test` + `npm run typecheck`.

## Anti-goals (a failure even if it "works")

- A states-matrix test that asserts a view "has" a state it cannot actually reach (false coverage).
- A reduced-motion stub that toggles nothing.
- An e2e spec that still references the retired tree shell, or that passes only because it asserts nothing meaningful.
- Claiming the e2e passes without running it (build + `test:e2e` must be run and the result recorded).
- "Fixing" an a11y gap by weakening an assertion instead of making the control reachable.

## Information architecture (the decided shape)

- `tests/states-matrix.test.ts` (new, in-gate): one describe per ScreenHost-backed view; reuses that view's existing fake-source pattern (copy the construction from the view's own test) to force each state and assert `view.Host.State` / `view.StateHost.State` equals the expected `ScreenState`. A small shared helper may reduce duplication, but each view's state triggers stay explicit.
- `tests/tenant-portal.spec.ts` (rewritten, gated): nav-shell flows over the `FakeTenantControlPlane` (extended if the new shell needs profile/manifests/rollout/health the old spec didn't serve); plus keyboard/focus assertions via `page.keyboard` and focus queries.
- Any a11y fix lands in the offending kit component or view (e.g. making a control focusable/activatable); no new kit primitive is expected, but one is permitted if a control genuinely needs it.

## What's left to the builder (plan + implementation calls)

- Exactly which `ScreenState`s each view can reach (read each view's `Inputs()`/state wiring; assert only the real ones - e.g. a view with no denied path is not asserted to reach Denied).
- Whether a small shared matrix helper is worth it versus explicit per-view blocks - prefer clarity; no inline literals (hoist any shared label/text).
- Which sections/flows the e2e drives and in what order; how much the `FakeTenantControlPlane` must be extended to serve the nav shell's reads (profile, environments, manifests, rollout, health) and the Activity drawer; keep the fake's responses honest and minimal.
- The keyboard assertions: the specific Tab order checked and which controls' Enter/Space activation is asserted - choose the shell's primary path (nav rail + one action + the drawer toggle).
- If a control is found not keyboard-reachable, the minimal fix in the kit/view (and a note in the report); if the gap is a Mural-framework limitation, file it as a Feature and record the honest limitation rather than faking it.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline string literals (hoist to `private static readonly`; test-data literals in tests are fine), enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `admin/tenant-portal/tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`0 0 N`). Any file touched that is CRLF stays CRLF (check; the existing `tenant-portal.spec.ts` and `fake-tenant-control-plane.ts` EOL must be checked and preserved); never `sed -i` a CRLF file. Escape non-ASCII as `\uXXXX`, re-scan after the Write tool.
- Default gate unchanged: `npm test` + `npm run typecheck` in `admin/tenant-portal`, both green on the merged result (the new states-matrix test runs here). The e2e is verified separately by running `npm run build` then `npm run test:e2e` and recording the result; it is NOT added to the default gate.
- UI-only: no server change, no new route, nothing cross-tenant. Reduced-motion is an honest N/A.

## Review focus (inputs no happy-path test exercises)

- The states-matrix asserts only states a view can genuinely reach; no view is asserted into a state it lacks (false coverage). (Matrix test.)
- Every ScreenHost-backed full-page view is present in the matrix; a newly added view without a state is caught. (Matrix test completeness.)
- The e2e spec references the nav shell only - no retired `TenantTreeView`/`HiveDetailView` imports; it boots, navigates every section, toggles the drawer, and asserts a forced empty/error state. (E2e run.)
- A focused nav item and a focused action are activatable by Enter/Space, and Tab reaches them; a control that is not keyboard-reachable is fixed, not asserted away. (E2e keyboard.)
- Reduced-motion is recorded as N/A with no stub. (Design/spec.)
- The e2e was actually run (build + `test:e2e`) and its result recorded; no passing claim without evidence. (Report.)
- EOL/ASCII preserved on every touched file; the default unit gate stays green. (Diff review + gate.)
