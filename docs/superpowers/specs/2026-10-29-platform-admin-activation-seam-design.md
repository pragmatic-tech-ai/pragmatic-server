# PA-P1 - Public Button Activation Seam (retire private `_clickHandlers` poking) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; at the backend-build-vs-polish fork the user chose the activation-seam polish - the only no-backend, no-new-surface slice left). Proceeds to plan + SDD. Pure portal test-hygiene refactor; no backend, no route, no new user-facing behavior.
**Area:** Platform Admin portal (`admin/portal/`) only - the `kit` `KeyActivatedButton`/`Act` and the 6 view/kit test sites that currently reach into a private field.
**Builds on:** every PA view-test (they drive buttons); the `Act` gating model (PA-13+), whose can-gate this seam must preserve.

## Context

`KeyActivatedButton` (the portal's focusable, keyboard-activatable button) runs one activation path for pointer-click and Enter/Space via a `protected Activate()`. `Act` extends it and overrides `Activate()` to route through a private `Fire()` that gates on `inputs.can` (a disabled `Act` does nothing). `Act` already exposes a public `Press()` (-> `Fire()`), so `Act` is test-activatable through its gate.

The BASE `KeyActivatedButton` has NO public activation method. So tests that must activate a plain button (retry buttons, cancel buttons, kit foundation/screen buttons) reach into mural `Button`'s private `_clickHandlers` array via an `as unknown as { _clickHandlers: ... }` cast and invoke the handlers by hand. This appears in 6 test files (`clients-view`, `kit-foundations`, `kit-screen`, `release-policy-view` x2, `releases-view`) and has been flagged as a brittle smell in multiple PA reviews (a mural-internal rename silently breaks every such test; the cast also bypasses the real activation path).

## Recon findings (binding) + rulings

1. **Add one public activation method to the base.** Ruling: add `public Press(): void` to `KeyActivatedButton` that calls `this.Activate()` - the SAME single activation path pointer-click and keyboard already use. It is a legitimate public activation entry (primarily a test seam, but sound to expose). Verify there is no `Press` on mural `Button` to collide with/shadow (if there is, reconcile - prefer overriding cleanly or a distinct name, but `Press` is expected to be free).

2. **`Act` keeps its gate, loses its redundant override.** `Act.Press()` currently calls `Fire()`. With base `Press()` calling `this.Activate()`, and `Act` overriding `Activate()` to call `Fire()`, an inherited `Press()` on an `Act` routes `Press -> Activate (Act override) -> Fire (gated)` - identical behavior. Ruling: REMOVE `Act.Press()` (inherit the base); the can-gate is preserved because `Press` goes through `Activate`, which `Act` gates. This MUST be proven by a unit test: a disabled `Act`'s `Press()` is a no-op; an enabled `Act`'s `Press()` fires `onClick`.

3. **Migrate all 6 sites; leave none behind.** Ruling: replace every `(btn as unknown as { _clickHandlers: ... })._clickHandlers` loop with a direct `btn.Press()` call. The buttons at those sites are `KeyActivatedButton` (or `Act`) instances - confirm each site's button type exposes `Press()` after Task 1 (e.g. a state panel's `RetryButton` getter must be typed as `KeyActivatedButton`/`Act`, not a bare `Button`; widen the getter's type or expose `Press` if needed, without changing runtime behavior). After this spec, `grep -r _clickHandlers admin/portal` returns nothing.

4. **No behavior change in production.** The seam only ADDS a public method routing through the existing activation path. No view changes, no new user-facing anything, no gate relaxation.

## Goals

- Give `KeyActivatedButton` a public activation method so tests activate buttons through the real path, not a private mural field.
- Remove all 6 `_clickHandlers` casts; unify `Act`'s activation on the base `Press()` while preserving its can-gate.

## Non-goals / deferred (filed as Features)

- Cross-view form-draft preservation across an events-WS auto-refresh (the separate deferred; unrelated to this seam).
- Any new button behavior, styling, or a programmatic-activation feature beyond the test seam.
- Touching mural itself (the base `Button`); this stays within the portal `kit`.

## Anti-goals (a failure even if it "works")

- A `Press()` that BYPASSES `Act`'s gate (it MUST go through `Activate()` so a disabled `Act` stays a no-op) - a gate bypass would be a security regression (an Observer's disabled action becoming pressable).
- Leaving any `_clickHandlers` poke behind, or widening a test-only concern into production behavior.
- Changing what pointer-click / Enter / Space do.

## Information architecture (decided shape)

Portal (`admin/portal/src/kit/`):
- `key-activated-button.ts` - add `public Press(): void { this.Activate() }`. (Confirm no mural `Button.Press` collision.)
- `act.ts` - remove the now-redundant `public Press()` (inherit the base; `Act.Activate()` override still routes to the gated `Fire()`).
- Any kit component whose test-seam getter returns a button the tests now `Press()` (e.g. `state-panels.ts` `RetryButton`) - ensure the getter's declared type is `KeyActivatedButton`/`Act` (so `.Press()` type-checks); no runtime change.

Tests (`admin/portal/tests/`):
- `kit-foundations.test.ts`, `kit-screen.test.ts`, `clients-view.test.ts`, `release-policy-view.test.ts` (x2), `releases-view.test.ts` - replace the `_clickHandlers` cast loops with `.Press()`.
- Kit unit tests - add/confirm: base `KeyActivatedButton.Press()` invokes its `onActivate`; an ENABLED `Act.Press()` fires `onClick`; a DISABLED `Act.Press()` does NOT (gate preserved); Enter/Space and pointer-click paths unchanged.

## Constraints (inherited, binding)

- OOP; Allman braces; PascalCase public methods; `IDisposable` not lambdas; tests under `tests/`.
- No inline reused literals (n/a here - no new strings expected).
- Edited `.ts`: pure ASCII, LF. Byte-scan each written `.ts` -> `0 0 N`. Match EOL (all LF).
- The can-gate invariant is binding: `Press()` on a disabled `Act` is a no-op (reported == enforced - a disabled action must not be activatable through any public path).
- No cross-app import; no backend/route/authz change; no mural change.
- Gate asymmetry: portal `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`. control-plane unaffected (re-run `npx tsx --test` only if any shared file is touched - it is not, so a typecheck:tools pass suffices). Full portal suite green with ZERO `_clickHandlers` references remaining.

## Review focus (inputs no happy-path test exercises)

- A DISABLED `Act` (`can: false`) - `Press()` must be a no-op (the gate holds through the base path). (Kit unit test - the load-bearing security check.)
- A plain `KeyActivatedButton` with no `onActivate` - `Press()` must not throw. (Kit unit test.)
- Every migrated site still exercises what it did (retry re-fetches, cancel navigates, etc.) - the suite stays green with identical assertions, only the activation call changed. (The 6 migrated tests.)
- No `_clickHandlers` reference remains anywhere under `admin/portal`. (A grep check in the final task.)
- Enter/Space keyboard activation and pointer-click still route through `Activate()` unchanged (no regression from adding `Press`). (Existing kit tests.)
