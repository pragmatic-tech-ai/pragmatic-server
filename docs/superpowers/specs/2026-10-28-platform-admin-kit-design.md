# PA-1 - Platform Admin design-system kit (core) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The FIRST Platform Admin spec - a UI-only enabler with no backend dependency.
**Area:** Platform Admin portal (`admin/portal/`) - a reusable Mural component kit, owned by this app.
**Builds on:** nothing in the PA portal (it has no kit today); informed by the proven tenant-portal kit (`admin/tenant-portal/src/kit/`), re-implemented here - NOT imported.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 0 (bare shell, no kit), section 4 (cross-cutting UX foundations), section 1 (per-screen needs).

## Context: the derived Platform Admin backlog

The PA reconciliation note is not pre-numbered; this run derives the backlog, mirroring the Tenant Admin arc (kit -> shell -> session/role -> per-screen -> hardening). Working order (each its own spec, merge-local):

1. **PA-1 Platform Admin kit (core)** - THIS spec (UI). 2. PA-2 Shell + grouped nav + top bar + page header + theme. 3. PA-3 Operator session + role + visible-but-denied (G7 whoami). 4. PA-4 Fleet overview (G8). 5. PA-5 Clients list + detail. 6. PA-6 Tenants list + detail (1:1; G10). 7. PA-7 Hives list + detail. 8. PA-8 Provisioning wizard (G1). 9. PA-9 Registry & Releases (G2/G3). 10. PA-10 Release Policy (G5). 11. PA-11 Agent Channel (G4). 12. PA-12 Platform Components (G6, agent-blocked). 13. PA-13 Settings (operators/config/audit; G7/G9). 14. PA-14 Observed/trust-boundary panels (cross-cutting). 15. PA-15 States matrix / a11y / e2e. Backend-gap specs will apply the same never-invent-a-backend / defer-as-Feature discipline proven across TA.

## The scope decision (recon finding + ruling)

Recon found the PA portal (`admin/portal`, package `pragmatic-admin-portal`) is a **separate app** from the tenant portal: its own `package.json` (deps: mural + todl-runtime only), its own tsconfig that includes only its own `src`/`tests`, and **no kit directory**. It cannot import the tenant-portal kit, and the governing **separation spec deliberately keeps the two admin apps uncoupled**.

**Ruling: PA-1 builds a Platform-Admin-owned core kit in `admin/portal/src/kit/`** - not a shared-package extraction. Extracting a shared kit would mean refactoring the shipped, merged tenant portal (~20 files + its full gate/e2e) to import a new package - high-risk and premature before the two kits' divergence is known (PA genuinely needs primitives tenant lacks: `DataTable`, and later `OpsDrawer`/`ObservedPanel`, over a different shell). A PA-owned kit respects the separation boundary and keeps PA's cadence independent. A future shared-kit extraction, once both kits are stable and their overlap proven, is a cleaner low-risk consolidation and is noted as a deferred option, not done here. The primitives are re-implemented from the **proven** tenant kit as the reference (same Mural APIs), adapted to PA's needs.

**Second ruling: the TA-16 accessibility lesson is baked in from the start.** The tenant kit shipped buttons that were not keyboard-reachable until TA-16 retrofitted `KeyActivatedButton`. PA-1's action primitives derive from a `KeyActivatedButton` from day one, so PA does not repeat that a11y debt.

**Scope boundary (what PA-1 includes vs. defers).** PA-1 is the CORE kit the earliest screens (shell, Fleet, the provisioning lists) need. Specialized primitives land with the screen that first needs them (as TA did: SecretTable/OnceSecret arrived with tokens, Steps with the wizard): deferred to their specs are Toast, Dialog, Drawer, OpsDrawer, ConfirmDialog (name-to-confirm), OnceSecret, SecretTable, ObservedPanel, CodeBlock/Copy, Steps, Activity list, the States-matrix page, and the full theme tokens pass.

## Goals

A Mural component kit under `admin/portal/src/kit/`, OOP, imperative `.ts`, with a barrel `index.ts`, covering:

- **Icons + tones**: a `KitGlyph` catalog + `IconCatalog` (the glyph subset PA needs), and `PillTone`/`Tones` (icon + text tone mapping; colour is never the only signal).
- **Status Pill** (note 4b): `PillKind` enum covering the full PA vocabulary - `connected, quiet, awaiting, disconnected, healthy, degraded, failing, unknown, published, signing, withdrawn, held, rolling, paused, updated, pending, failed, observed` - a `PillKinds` registry (glyph + label + tone per kind), and `StatusPill` (icon + text, never colour alone; `LabelOverride`).
- **Keyboard-activated button**: `KeyActivatedButton` (focusable, single activation path for pointer click AND Enter/Space, no double-fire) - the base for every actionable control.
- **Act** (note 4d, visible-but-denied): a permission-gated action that stays VISIBLE but disabled when denied, carrying a "needs <role>, ask <who>" hint; derives from `KeyActivatedButton`.
- **Screen state host** (note 4d): `ScreenState` (Loading/Empty/Error/Denied/Populated) + `ScreenHost` (resolves exactly one: loading > denied > error > empty > populated) + state panels (loading skeleton; empty with a primary action; error retryable with no raw internals; permission-denied naming the needed role and who to ask - Retry/actions keyboard-reachable).
- **Section + KV**: a titled `Section` (title/sub/actions/body) and a `KeyValueGrid`.
- **Banner** (+ `BannerTone` Info/Warning/Danger): an inline message with an optional action.
- **DataTable** (note 4c, the PA centerpiece): columns with headers; rows; a dense/comfortable density toggle; a search box; column sort; selectable rows with a bulk-action bar; per-row tone; keyboard navigation (at least j/k row move, Enter to open, "/" to focus search) with a visibly indicated focused row; and honest empty rendering. Built on `KeyActivatedButton` for its interactive controls so it is keyboard-usable from the start. (Saved filter segments and full column controls may be a follow-on within this spec or deferred to the screen that first needs them - builder's call.)

## Non-goals

- **Importing or sharing the tenant-portal kit**, or extracting a shared package - deferred option; PA-owned here.
- The specialized primitives listed in the scope boundary (Toast/Dialog/Drawer/OpsDrawer/ConfirmDialog/OnceSecret/SecretTable/ObservedPanel/CodeBlock/Steps/Activity/States-matrix page) - each lands with its first screen.
- The **shell, nav, top bar, page header** (PA-2) and the **full theme tokens** pass - PA-1 is the component kit, not the shell.
- Any backend, route, or data wiring - PA-1 has zero backend dependency; components take plain inputs and expose test seams.
- Re-skinning or touching the legacy PA views (`environment-*`, `graph-*`) - out of scope (note section 5).

## Anti-goals (a failure even if it "works")

- A pill, action, or table control that colour-codes without an icon/text label (accessibility + the note's "icon + text" rule).
- Any actionable control that is not keyboard-reachable/activatable (the TA-16 debt, not to be repeated).
- Coupling `admin/portal` to `admin/tenant-portal` (violates the separation spec).
- A DataTable that silently drops its empty/loading contract or whose selection/bulk state is untestable.
- Inline string literals for user-facing/registry text (must be hoisted).

## Information architecture (the decided shape)

- All files under `admin/portal/src/kit/`, exported from `admin/portal/src/kit/index.ts`. Each component extends the appropriate Mural base (`StackPanel` for composites; `KeyActivatedButton extends Button`), matching the proven tenant-kit construction pattern (constructor-inputs-object, `private static readonly` constants, test-seam getters).
- `PillKind`/`PillKinds` is the single registry of the status vocabulary; `StatusPill` renders a kind (glyph + label) via it.
- `ScreenHost` takes a `ScreenHostInputs` (loading/allowed/isEmpty/error + per-state configs + content) and resolves one state; the denied/empty/error panels carry keyboard-reachable actions.
- `DataTable` takes columns (key, header, optional sort/tone accessors) and rows (typed row objects) plus inputs for density, search, selection, and per-row open/bulk callbacks; exposes test seams for the rendered rows, the current density, the sort state, the selection set, and the focused row.
- Tests under `admin/portal/tests/` (the dir exists), matching the existing PA test harness (`node:test`, the `Application.current` setup used by `client-tenant-views.test.ts`/`hive-views.test.ts`).

## What's left to the builder (plan + implementation calls)

- The exact `KitGlyph` subset and tone mapping (port the needed ones from the tenant `icon-catalog.ts`/`tones.ts`; add any PA-specific glyph the pill vocabulary needs).
- The precise `PillKinds` label/glyph/tone per kind (the note lists the kinds; copy honest labels, hoisted).
- The `DataTable` API shape (generic over a row type; how columns declare sort/tone), how much of the keyboard map to implement now (j/k/Enter/"/" minimum; x for select and g+letter may defer), and whether saved filter segments ship now or with Fleet (PA-4). Keep it keyboard-usable and testable.
- Whether to port `state-panels`/`screen-host`/`section`/`kv`/`banner` near-verbatim from the tenant kit (recommended - they are proven) or adapt; either way, PA-owned, no cross-app import.
- Reuse of the proven `Act`/`KeyActivatedButton` design from the tenant kit's TA-16 state (the a11y-correct version), not the pre-TA-16 one.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline string literals (hoist to `private static readonly`; test-data literals in tests are fine), enums over unions, VMs extend `Observable` (components extend their Mural base), `IDisposable` not lambdas, tests under `admin/portal/tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`0 0 N`). Match the EOL of any existing file touched (check; `index.ts` is new). Escape non-ASCII as `\uXXXX`, re-scan after the Write tool.
- Gate: `npm test` + `npm run typecheck` in `admin/portal`, both green on the merged result. No server change (no control-plane gate for PA-1).
- UI-only, PA-owned, no coupling to the tenant app, no backend. Every actionable control keyboard-reachable; every status conveyed by icon + text, not colour alone.

## Review focus (inputs no happy-path test exercises)

- Every `PillKind` in the note's vocabulary is present in `PillKinds` with a glyph + label (not colour alone); a kind with no registry entry is caught. (Pill tests.)
- `ScreenHost` resolves the documented precedence (loading > denied > error > empty > populated) and its denied/empty/error actions are keyboard-reachable. (Screen tests.)
- `Act` stays visible-but-disabled when denied, shows the needed-role hint, and never fires when denied; it is Enter/Space-activatable when allowed with no double-fire. (Act tests.)
- `DataTable` renders its empty state honestly; search filters; sort orders; selection + bulk bar track; a row is keyboard-focusable and Enter opens it; density toggles. (DataTable tests.)
- No kit control is keyboard-dead, and no status is colour-only. (All.)
- No import from `admin/tenant-portal`. (Diff review.)
