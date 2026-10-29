# Interactive Per-Hive Policy Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline forms to the operator portal's hive-detail page to set a hive's channels, min-version floor, and hold, driving the per-hive policy client methods D4 already shipped.

**Architecture:** Mirror the tenant-policy form machine in `ReleasePolicyView` on the hive-detail page, scoped to the on-screen hive (`vm.Hive.id`, no hive-id input). Every mutating control is built through `OperatorContext.MutatingAct` (reported == enforced). After a successful mutation the view calls an injected reload callback (`SectionContainerView.Refresh`) to re-fetch and re-render the hive's policy. No backend, route, evaluator, or client method is added — this is portal-only.

**Tech Stack:** TypeScript, `@pragmatic-tech-ai/mural` basic controls + portal `kit`, `node --test` via `npm --prefix admin/portal test`.

**Spec:** `docs/superpowers/specs/2026-10-29-per-hive-policy-editing-design.md`

## Global Constraints

- New/modified `.ts`: **ASCII only, LF only**. Every touched file
  (`hive-detail-view.ts`, `hives-view.ts`, `app.ts`) is LF + 0 non-ASCII at
  base — keep it so; byte-scan each on the way out
  (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` → expect `0 0 N`).
- OOP + Allman braces (opening brace on its own line for every block).
- **No inline string literals** — every label, key, placeholder, and message is
  a `private static readonly` constant on the class, referenced at each use.
- Enums over string unions; VMs extend `Observable`; PascalCase public members;
  no module-level free functions or state.
- `admin/portal` must not import from `admin/control-plane`. `admin/portal` and
  `admin/tenant-portal` stay separate apps (no cross-import).
- Every mutating control is built via `OperatorContext.MutatingAct` — a ReadOnly
  operator gets the gated affordance, never a live mutation path.
- The forms act on `vm.Hive.id` only; the operator never types a hive id.
- Gates (run sequentially, all must pass): `npm --prefix admin/portal test`,
  `npm --prefix admin/portal run typecheck`, and `npm run typecheck:tools`
  (typechecks both portals).
- Merge locally (ff-only); **NEVER push.**

## Review Focus

- **ReadOnly operator gets no live mutation.** A `HiveDetailView` built with a
  ReadOnly `OperatorContext` must expose no working path to any of the five hive
  mutations — Task 1 tests assert the edit actions are gated (not live).
- **First-ever policy.** Setting a floor/hold/channels on a hive that has **no**
  existing per-hive policy must work (the form must not assume a record exists)
  — Task 1 tests a hive whose `vm.HivePolicy` reads the "Inherits tenant"
  defaults, then applies.
- **Correct hive id on apply.** Each apply must call the client with
  `vm.Hive.id`, not a stale/other id — Task 1 asserts the id the fake client
  received.
- **Reload only on success.** A failed apply keeps the form open with the error
  line and does NOT call the reload callback; a successful apply leaves edit
  mode and calls it exactly once — Task 1 asserts both.
- **Existing construction sites compile untouched.** `new HiveDetailView(vm,
  onBack)` with no client/operator must still render the read-only page exactly
  as today — Task 1 keeps the existing read-only tests passing unchanged.

---

### Task 1: Per-hive policy edit forms on `HiveDetailView`

**Files:**
- Modify: `admin/portal/src/hive-detail-view.ts`
- Test: `admin/portal/tests/hive-detail-view.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient` methods (already shipped) — `SetHiveChannels(hiveId, channels: string[])`, `SetHiveMinVersion(hiveId, version)`, `ClearHiveMinVersion(hiveId)`, `SetHiveHold(hiveId, reason)`, `ClearHiveHold(hiveId)`; `OperatorContext.MutatingAct(label, onClick, variant?)`; `ReleaseChannel.Stable` / `ReleaseChannel.Early`; the `Act`, `KeyActivatedButton`, `Section`, `TextBox`, `TextBlock` kit/basic controls already imported by `release-policy-view.ts`.
- Produces: new constructor
  `constructor(vm: HiveDetailViewModel, onBack: () => void, client?: ControlPlaneClient, operator?: OperatorContext, onPolicyChanged?: () => Promise<void>)`
  (optional-last params); test seams `get Mode(): HivePolicyMode`, `EnterMode(mode: HivePolicyMode): void`, `get ErrorLine(): string`; exported `enum HivePolicyMode { Normal, SetChannels, SetMinVersion, Hold }`.

Pattern source: `admin/portal/src/release-policy-view.ts` (`GatingMode`,
`EnterMode`, `BuildPolicyForm`, `ChannelToggle`, `ApplyPolicy`). The hive form is
that machine with the tenant-id input removed (the hive id is `this.vm.Hive.id`)
and the client calls swapped to the `*Hive*` methods. Editing is rendered only
when `client`, `operator`, and `onPolicyChanged` are all defined; the entry
actions and submit actions are built via `operator.MutatingAct`.

- [ ] **Step 1: Write the failing tests** in `hive-detail-view.test.ts`

Add (constructing `new HiveDetailView(vm, () => {}, fakeClient, operator, reloadSpy)`; a fake client records `(method, hiveId, arg)`; a reload spy counts calls; build `OperatorContext.FromWire('full')` and `FromWire('readonly')`):

```ts
// read-only construction (no client/operator) renders the page and exposes no edit mode
test('without a client the detail stays render-only (Mode Normal, no edit affordance)')
// a Full operator can enter each edit mode
test('EnterMode(SetMinVersion) then apply calls SetHiveMinVersion(hive.id, version) and reloads once')
test('SetMinVersion clear calls ClearHiveMinVersion(hive.id) and reloads')
test('EnterMode(Hold) apply calls SetHiveHold(hive.id, reason); release calls ClearHiveHold(hive.id)')
test('EnterMode(SetChannels) toggling stable+early then apply calls SetHiveChannels(hive.id, [stable, early])')
test('apply with an empty version shows the required error line and does not call the client or reload')
test('a client rejection keeps the form open (Mode unchanged) and shows the failed line and does not reload')
test('cancel returns to Mode Normal without calling the client')
test('first-ever policy: a hive with no per-hive policy can set a floor (apply calls the client)')
// reported == enforced
test('a ReadOnly operator sees gated edit actions and no mutation reaches the client')
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm --prefix admin/portal test -- hive-detail-view.test.ts` (or the repo's node:test invocation). Expected: FAIL (new seams/forms absent).

- [ ] **Step 3: Implement the forms in `hive-detail-view.ts`**

Add the `HivePolicyMode` enum and the constants (mode-form titles, entry labels
`Set channels` / `Set floor` / `Hold`, submit labels `Apply` / `Clear` /
`Hold` / `Release` / `Cancel`, placeholders `Version` / `Reason`, the selected/
unselected channel prefixes, and the error strings `Version is required.` /
`A reason is required.` / `At least one channel is required.` / `The change could
not be saved. Check the values and try again.`) — all `private static readonly`.
Extend the constructor with the optional-last params and store them. Add
`EnterMode` (sets `mode`, resets `pendingChannels`/error, re-renders via
`this.host.Update(this.Inputs())`), `Mode`, and `ErrorLine` seams. In
`BuildContent`, when `this.CanEdit` (all three injected deps present), append a
mutating action row (`operator.MutatingAct(...)` entry buttons; Hold uses
`ActVariant.Danger`) and, when `mode !== Normal`, a `Section` with the
mode-specific form (`BuildPolicyForm`). `ApplyPolicy(valid, requiredText, call)`
mirrors `ReleasePolicyView.ApplyPolicy` minus the tenant id: clear error line;
if `!valid` show `requiredText` and return; `await call(this.vm.Hive.id)`; on
throw show the failed line and keep the form open; on success set `mode =
Normal` and `await this.onPolicyChanged?.()`. Keep every brace Allman; keep the
file ASCII + LF.

- [ ] **Step 4: Run to verify they pass**

Run: `npm --prefix admin/portal test -- hive-detail-view.test.ts`. Expected: PASS (new + pre-existing read-only tests).

- [ ] **Step 5: Byte-scan + commit**

Byte-scan `hive-detail-view.ts` → expect `0 0 N`. Then:
```bash
git add admin/portal/src/hive-detail-view.ts admin/portal/tests/hive-detail-view.test.ts
git commit -m "feat(portal): interactive per-hive policy forms on hive detail"
```

---

### Task 2: Thread operator + client + reload through `HivesView` and `app.ts`

**Files:**
- Modify: `admin/portal/src/hives-view.ts`
- Modify: `admin/portal/src/app.ts`
- Test: `admin/portal/tests/hives-view.test.ts`

**Interfaces:**
- Consumes: `HiveDetailView` constructor from Task 1
  `(vm, onBack, client?, operator?, onPolicyChanged?)`; `OperatorContext`.
- Produces: `HivesView` constructor `constructor(client: ControlPlaneClient, operator: OperatorContext)`.

- [ ] **Step 1: Write the failing tests** in `hives-view.test.ts`

```ts
test('HivesView constructed with a Full operator builds a detail whose edit mode can be entered')
test('HivesView constructed with a ReadOnly operator builds a detail with gated (non-live) edit actions')
```

Drive: construct `new HivesView(fakeClient, OperatorContext.FromWire('full'))`,
`ShowDetail(row)` (or the existing detail-entry seam the suite already uses),
reach the `HiveDetailView`, assert edit mode is reachable for Full and gated for
ReadOnly. Reuse the suite's existing fake client; extend it with the five
`*Hive*` policy methods if the detail path needs them.

- [ ] **Step 2: Run to verify they fail**

Run: `npm --prefix admin/portal test -- hives-view.test.ts`. Expected: FAIL (ctor arity / wiring).

- [ ] **Step 3: Implement the wiring**

In `hives-view.ts`: add `private readonly operator: OperatorContext` constructor
param (keep `client`); in `BuildDetail`, change
`new HiveDetailView(vm, () => void this.ShowList())` to
`new HiveDetailView(vm, () => void this.ShowList(), this.client, this.operator, () => this.Refresh())`.
In `app.ts`: change the Hives mount to the operator-guarded form the other
sections use —
```ts
const operator = this.operator
if (operator !== undefined)
{
    this.Mount(new HivesView(this.client, operator))
}
```
(match the exact guard shape already used for ClientsView/ReleasesView). Keep
both files ASCII + LF and Allman.

- [ ] **Step 4: Run to verify they pass**

Run: `npm --prefix admin/portal test -- hives-view.test.ts`, then the full
portal suite `npm --prefix admin/portal test`. Expected: PASS (no regression in
`shell-app.test.ts` / `hives-view.test.ts` / `hive-views.test.ts`).

- [ ] **Step 5: Byte-scan + commit**

Byte-scan `hives-view.ts` and `app.ts` → each `0 0 N`. Then:
```bash
git add admin/portal/src/hives-view.ts admin/portal/src/app.ts admin/portal/tests/hives-view.test.ts
git commit -m "feat(portal): wire operator context into Hives section for per-hive policy editing"
```

---

## Final verification (whole branch)

- `npm --prefix admin/portal test` (full portal suite) — green.
- `npm --prefix admin/portal run typecheck` — exit 0.
- `npm run typecheck:tools` — exit 0 (typechecks tools + both portals).
- Byte-scan all three source files → `0 0 N` each.
