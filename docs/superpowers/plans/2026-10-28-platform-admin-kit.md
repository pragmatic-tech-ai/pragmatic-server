# PA-1 Platform Admin design-system kit (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Platform-Admin-owned Mural component kit under `admin/portal/src/kit/` - status Pill (full PA vocabulary), keyboard-activated button, visible-but-denied Act, Screen-state host + panels, Section/KV, Banner, and the PA-centerpiece DataTable - re-implemented from the proven tenant kit (NOT imported), with the TA-16 accessibility fix baked in from the start. No backend, no shell, no coupling to the tenant app.

**Architecture:** Each component extends its Mural base (`StackPanel`; `KeyActivatedButton extends Button`) under `admin/portal/src/kit/`, exported from a barrel `index.ts` that grows per task. Primitives are ported from `admin/tenant-portal/src/kit/` (proven reference, same Mural APIs) adapted to PA - but PA-owned, with NO import from the tenant app. Actionable controls derive from `KeyActivatedButton` (focusable + Enter/Space, no double-fire). Specialized primitives (OnceSecret/SecretTable/ObservedPanel/Steps/OpsDrawer/ConfirmDialog/Toast/Drawer/CodeBlock/Activity) are OUT of scope - they land with the screen specs that first need them.

**Tech Stack:** TypeScript. Portal: `admin/portal` (package `pragmatic-admin-portal`; Mural kit, `node:test` via `tsx --test tests/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-kit-design.md`

## Global Constraints

- OOP, Allman braces, PascalCase public methods/interfaces, enums over string-literal unions, `IDisposable` not lambdas. NO inline string literals: hoist every user-facing/registry literal to `private static readonly` (test-data literals in tests are fine).
- NO import from `admin/tenant-portal` anywhere in `admin/portal` (the separation spec forbids coupling). Re-implement; reference the tenant kit only as a reading source.
- Every actionable control derives from `KeyActivatedButton` (focusable, one activation path for pointer + Enter/Space, no double-fire). Every status is icon + text (via `PillKinds`), never colour alone.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`). `index.ts` is new (LF). Escape non-ASCII as `\uXXXX`, re-scan after the Write tool.
- Gate: `npm test` + `npm run typecheck` in `admin/portal`, BOTH green on the merged result. No server change.
- Each component extends its Mural base and follows the tenant kit's construction pattern: constructor-inputs-object, `private static readonly` constants, test-seam getters. Tests under `admin/portal/tests/` matching the existing PA test harness (`node:test`, the `Application.current` + `app.initialize({theme:Pragmatic, scheme:PragmaticLight})` setup used by `tests/client-tenant-views.test.ts` / `tests/hive-views.test.ts`).

## Review Focus

- Every `PillKind` in the note's vocabulary (connected, quiet, awaiting, disconnected, healthy, degraded, failing, unknown, published, signing, withdrawn, held, rolling, paused, updated, pending, failed, observed) has a `PillKinds` entry with glyph + label (not colour alone). (Task 1.)
- `ScreenHost` resolves loading > denied > error > empty > populated; denied/empty/error actions are keyboard-reachable. (Task 2.)
- `Act` stays visible-but-disabled when denied with a needed-role hint, never fires when denied, is Enter/Space-activatable when allowed with no double-fire. (Task 2.)
- `DataTable` renders empty honestly, search filters, sort orders, selection + bulk track, a row is keyboard-focusable and Enter opens it, density toggles. (Task 3.)
- No kit control is keyboard-dead; no status is colour-only; no import from `admin/tenant-portal`. (All.)

---

### Task 1: Foundations - icons, tones, pill vocabulary, keyboard button

**Files:**
- Create: `admin/portal/src/kit/icon-catalog.ts`, `tones.ts`, `pill-kinds.ts`, `status-pill.ts`, `key-activated-button.ts`, `index.ts`
- Test: `admin/portal/tests/kit-foundations.test.ts`

**Interfaces (produced, consumed by Tasks 2-3 and later specs):**
- `icon-catalog.ts`: `export enum KitGlyph { ... }` + `export class IconCatalog` with `static Definition(glyph: KitGlyph)` (port the needed glyphs from the tenant `icon-catalog.ts`; include at least those the pill vocabulary needs plus Search/Check/ChevronUp/ChevronDown for the table).
- `tones.ts`: `export enum PillTone { ... }` + `export class Tones` (tone -> brushes/affordance; port from tenant `tones.ts`).
- `pill-kinds.ts`: `export enum PillKind { Connected, Quiet, Awaiting, Disconnected, Healthy, Degraded, Failing, Unknown, Published, Signing, Withdrawn, Held, Rolling, Paused, Updated, Pending, Failed, Observed }`; `export interface PillEntry { glyph: KitGlyph; label: string; tone: PillTone }`; `export class PillKinds` with `static For(kind: PillKind): PillEntry` backed by a registry mapping EVERY kind (labels hoisted).
- `status-pill.ts`: `export class StatusPill extends StackPanel` - `new StatusPill(kind: PillKind)`; icon + text from `PillKinds.For`; `LabelOverride` setter; test seams `Kind`, `Label`.
- `key-activated-button.ts`: `export class KeyActivatedButton extends Button` - `constructor(onActivate?: () => void)`, sets `Focusable=true`, one click handler -> `Activate()`, `OnKeyDown` fires `Activate()` on Space/Return; `protected Activate()` overridable; no double-fire. (Port the TA-16 version verbatim-equivalent.)
- `index.ts`: barrel exporting all of the above (+ their types).

- [ ] **Step 1: Write failing tests** (`kit-foundations.test.ts`): `PillKinds.For` returns an entry (glyph+label) for EVERY `PillKind` value (iterate `Object.values(PillKind)` - fails if any kind missing); `StatusPill` renders the kind's label and honors `LabelOverride`; `KeyActivatedButton` is `Focusable`, activates once on a simulated click and once on Enter/Space (no double-fire - count activations).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the five files + barrel, porting from the tenant kit. Hoist all literals. ASCII/LF.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck` in `admin/portal`. Byte-scan the 6 files (`0 0 N`).
- [ ] **Step 5: Commit** `feat(admin-portal): kit foundations - glyphs, tones, pill vocabulary, keyboard button`.

---

### Task 2: Screen states, layout, and the visible-but-denied action

**Files:**
- Create: `admin/portal/src/kit/state-panels.ts`, `screen-host.ts`, `section.ts`, `kv.ts`, `banner.ts`, `act.ts`
- Modify: `admin/portal/src/kit/index.ts` (add exports)
- Test: `admin/portal/tests/kit-screen.test.ts`

**Interfaces:**
- Consumes: Task 1's `KitGlyph`/`IconCatalog`, `PillTone`/`Tones`, `KeyActivatedButton`.
- Produces:
  - `state-panels.ts`: `export enum SkeletonKind { ... }`; `SkeletonPanel`, `EmptyStatePanel`, `ErrorStatePanel`, `DeniedStatePanel` with their config types (`EmptyStateConfig { glyph?; title; action? }`, `ErrorStateConfig { title; body? ; onRetry? }`, `DeniedStateConfig { what; need; ask? }`); the Error Retry and Empty action are `KeyActivatedButton`/`Act` (keyboard-reachable). (Port from tenant `state-panels.ts`, but ensure Retry is keyboard-reachable from the start.)
  - `screen-host.ts`: `export enum ScreenState { Loading, Empty, Error, Denied, Populated }`; `export interface ScreenHostInputs { loading; allowed; isEmpty; error; skeleton?; empty?; errorConfig?; denied?; content? }`; `export class ScreenHost extends StackPanel` with `get State()`, `Update(inputs)`, `static Resolve(inputs)` (loading > denied > error > empty > populated). (Port from tenant.)
  - `section.ts`: `export class Section extends StackPanel` - `new Section({ title; sub?; actions?: Visual; body: Visual })`.
  - `kv.ts`: `export class KeyValueGrid extends StackPanel` - `new KeyValueGrid({ items: { key; value }[] })`.
  - `banner.ts`: `export enum BannerTone { Info, Warning, Danger }`; `export class Banner extends StackPanel` - `new Banner({ tone; text; action? })`.
  - `act.ts`: `export enum ActVariant { Primary, Secondary, Danger }`; `export class Act extends KeyActivatedButton` - `new Act({ can; need?; ask?; disabledReason?; onClick; label; variant? })`; visible-but-disabled when `!can` with a hoisted needed-role hint as tooltip; `override Activate()` -> gated `Fire()` (fires only when `can`); test seams `Enabled`, `DisabledHint`, `Press()`. No double-fire.
- Modify `index.ts`: add all exports.

- [ ] **Step 1: Write failing tests** (`kit-screen.test.ts`): `ScreenHost.Resolve` returns each state for the matching inputs and honors the precedence (e.g. loading+error -> Loading; !allowed+error -> Denied); the Error panel's Retry invokes `onRetry` and is a `KeyActivatedButton`; `Act` with `can:false` is disabled, exposes the hint, and `Press()` does NOT fire; `Act` with `can:true` fires exactly once on `Press()` and once on Enter (no double-fire).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the six files + barrel exports. Port from tenant kit; keep Retry/empty-action keyboard-reachable. Hoist literals. ASCII/LF.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck` in `admin/portal`. Byte-scan touched files.
- [ ] **Step 5: Commit** `feat(admin-portal): kit screen-state host, panels, section/kv, banner, and visible-but-denied Act`.

---

### Task 3: DataTable (dense/comfortable, search, sort, selection + bulk, keyboard)

**Files:**
- Create: `admin/portal/src/kit/data-table.ts`
- Modify: `admin/portal/src/kit/index.ts` (add exports)
- Test: `admin/portal/tests/kit-data-table.test.ts`

**Interfaces:**
- Consumes: Task 1 `KeyActivatedButton`/`StatusPill`/icons; Task 2 nothing required (standalone), but may reuse `Section` for framing if useful.
- Produces (generic over a row type `T`):
  - `export enum TableDensity { Comfortable, Dense }`
  - `export interface TableColumn<T> { key: string; header: string; cell(row: T): string; sort?(a: T, b: T): number; tone?(row: T): PillTone | undefined }`
  - `export interface DataTableInputs<T> { columns: readonly TableColumn<T>[]; rows: readonly T[]; density?: TableDensity; searchText?(row: T): string; onOpen?(row: T): void; selectable?: boolean; bulk?: { label: string; onRun(rows: readonly T[]): void }[]; emptyText: string }`
  - `export class DataTable<T> extends StackPanel`: renders a header row (sortable columns via `KeyActivatedButton` headers) + body rows; a search box (`TextBox`) filtering via `searchText`; a density toggle; selectable rows with a checkbox column and a bulk-action bar (shown when a selection exists); per-row tone; keyboard - j/k move the focused row, Enter calls `onOpen(focusedRow)`, "/" focuses search; the focused row is visibly indicated. Honest empty rendering (`emptyText`) when no rows match. Test seams: `get Rows()` (rendered row visuals in order), `get Density()`, `get SortKey()`, `get Selection(): readonly T[]`, `get FocusedIndex()`, and methods to drive from tests (`SetSearch(text)`, `ToggleDensity()`, `SortBy(key)`, `Select(row)`, `FocusRow(i)`, `ActivateFocused()`).
- Modify `index.ts`: add exports.

- [ ] **Step 1: Write failing tests** (`kit-data-table.test.ts`): empty rows -> `emptyText` shown, zero data rows; a 3-row table renders 3 rows; `SetSearch` filters to matching rows; `SortBy` reorders by the column's `sort`; `ToggleDensity` flips `Density`; `Select` adds to `Selection` and the bulk bar appears; `FocusRow`/`ActivateFocused` calls `onOpen` with the focused row; the sort header and bulk buttons are `KeyActivatedButton`s (keyboard-reachable).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `DataTable` + barrel export. Keyboard map at minimum j/k/Enter/"/" (x-select and g+letter may defer with a `// deferred` note). Hoist literals. ASCII/LF.
- [ ] **Step 4: Run green.** `npm test` + `npm run typecheck` in `admin/portal`. Byte-scan touched files.
- [ ] **Step 5: Commit** `feat(admin-portal): kit DataTable - density, search, sort, selection + bulk, keyboard`.
