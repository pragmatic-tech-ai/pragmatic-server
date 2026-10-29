# Public Button Activation Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public `Press()` activation method to `KeyActivatedButton` (routing through the existing `Activate()` so `Act`'s can-gate is preserved), then remove `Act`'s redundant `Press()` and migrate the 6 portal test sites off the private `_clickHandlers` cast - leaving zero such references.

**Architecture:** Portal `kit` only. `KeyActivatedButton` gains `public Press(): void { this.Activate() }`. `Act` (which overrides `Activate()` to route through the gated `Fire()`) inherits `Press()` and drops its own. Tests activate buttons via `.Press()` instead of reaching into mural `Button`'s private `_clickHandlers`. No production behavior change, no backend/route/authz/mural change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); portal `@pragmatic-tech-ai/mural` `Button` + the portal `kit` + `node:test` with the `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-activation-seam-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods; `IDisposable` not lambdas; tests under `tests/`.
- Edited `.ts`: pure ASCII, LF. Byte-scan each written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. Match EOL (all LF).
- BINDING can-gate invariant: `Press()` on a disabled `Act` (`can: false`) is a NO-OP. `Press` must route through `Activate()` (which `Act` gates), never bypass it. A bypass is a security regression (a disabled/denied action becoming activatable).
- No cross-app import; no backend/route/authz change; no mural change. Gate (from `admin/portal`): `npm test` + `npm run typecheck`; then root `npm run typecheck:tools`. Full portal suite green; ZERO `_clickHandlers` references remain under `admin/portal` at the end.

## Review Focus

- A DISABLED `Act` -> `Press()` is a no-op (the gate holds through the base path). -> Task 1 (load-bearing).
- A plain `KeyActivatedButton` with no `onActivate` -> `Press()` does not throw. -> Task 1.
- Every migrated site still exercises its real behavior (retry re-fetches, cancel navigates) with identical assertions. -> Task 2.
- No `_clickHandlers` reference remains anywhere under `admin/portal`. -> Task 2 (grep check).
- Enter/Space + pointer-click still activate unchanged. -> Task 1 (existing kit tests stay green).

---

### Task 1: `Press()` on the base; `Act` inherits it

**Files:**
- Modify: `admin/portal/src/kit/key-activated-button.ts`, `admin/portal/src/kit/act.ts`
- Test: `admin/portal/tests/kit-foundations.test.ts` (and/or the kit test that covers `Act`/`KeyActivatedButton`)

**Interfaces:**
- Produces: `KeyActivatedButton.Press(): void` (public; calls `this.Activate()`). `Act` inherits `Press()`; its `Activate()` override still routes to the gated `Fire()`. `Act.Press()` (the explicit override) is removed.

- [ ] **Step 1: Confirm no collision** - check mural `Button` has no `Press` member that this would shadow/override unexpectedly (read the `Button` type or grep its d.ts). If one exists, reconcile (note it in the report); otherwise proceed.
- [ ] **Step 2: Write failing/verifying unit tests** in the kit test file:
  - a base `KeyActivatedButton` built with an `onActivate` spy -> `Press()` invokes the spy once.
  - a base `KeyActivatedButton` with NO `onActivate` -> `Press()` does not throw.
  - an ENABLED `Act` (`can: true`) -> `Press()` calls its `onClick` once.
  - a DISABLED `Act` (`can: false`) -> `Press()` does NOT call `onClick` (gate preserved).
  (Some may already exist via the old `_clickHandlers` path or `Act.Press`; rewrite them to call `Press()`.)
- [ ] **Step 3: Run, verify the new/changed assertions fail** where `Press()` doesn't yet exist on the base / before the `Act` change.
- [ ] **Step 4: Implement** - add `public Press(): void { this.Activate() }` to `KeyActivatedButton`; remove the `public Press()` override from `Act` (it inherits the base; `Act.Activate()` still calls `Fire()`). Change nothing else.
- [ ] **Step 5: Run the kit tests -> PASS.** Byte-scan both files -> `0 0 N`.
- [ ] **Step 6: `npm test` + `npm run typecheck` in `admin/portal`; commit** (`refactor(portal): public Press() activation on KeyActivatedButton; Act inherits it`).

---

### Task 2: Migrate the 6 test sites off `_clickHandlers`

**Files:**
- Modify (tests only): `admin/portal/tests/kit-foundations.test.ts`, `admin/portal/tests/kit-screen.test.ts`, `admin/portal/tests/clients-view.test.ts`, `admin/portal/tests/release-policy-view.test.ts`, `admin/portal/tests/releases-view.test.ts`
- Possibly modify (type-only): a kit component whose test-seam getter returns a button now `Press()`ed (e.g. `admin/portal/src/kit/state-panels.ts` `RetryButton`) - widen the declared return type to `KeyActivatedButton`/`Act` if needed so `.Press()` type-checks. No runtime change.

**Interfaces:**
- Consumes: `KeyActivatedButton.Press()` (Task 1).

- [ ] **Step 1: Find every site** - `grep -rn _clickHandlers admin/portal` (expect 6 occurrences across 5 files: `clients-view`, `kit-foundations`, `kit-screen`, `release-policy-view` x2, `releases-view`).
- [ ] **Step 2: Migrate each** - replace the `for (const h of (btn as unknown as { _clickHandlers: ... })._clickHandlers) { h(...) }` loop with a single `btn.Press()`. If a button is reached through a getter typed as bare `Button`, widen that getter's declared type to `KeyActivatedButton` (or `Act`) in the kit source (type-only; the instance already is one) so `Press()` type-checks.
- [ ] **Step 3: Run the full portal suite** - `npm test` in `admin/portal`; every migrated test passes with its ORIGINAL assertions (retry re-fetches, cancel navigates, etc. - only the activation call changed).
- [ ] **Step 4: Prove none remain** - `grep -rn _clickHandlers admin/portal` returns nothing. Byte-scan each touched file -> `0 0 N`.
- [ ] **Step 5: `npm run typecheck` in `admin/portal` + root `npm run typecheck:tools`; commit** (`test(portal): activate buttons via Press() instead of private _clickHandlers`).
