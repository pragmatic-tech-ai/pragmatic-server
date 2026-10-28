# Platform Admin Shell and IA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `admin/portal` drill-down shell with the designed Platform Admin shell: grouped nine-item left nav, top bar (context, destination search, theme toggle, operator menu), reusable page header, "Internal" tag; boot to a Fleet landing with honest placeholders; demote the legacy views to a dev-only entry.

**Architecture:** PA-owned, UI-only, built on the PA-1 kit. The shell (`app.ts`, class `App`) is auth-gated: `NavRail` on the left, a right column of `TopBar` over a content host. `NavModel` holds the grouped IA; each destination routes to a `ComingSoonView` (page header + ScreenHost empty state) until its own later spec replaces the arm. The legacy `IPortalNavigator` views stay implemented but are reached only through a dev-only operator-menu entry. New kit primitive `PageHeader`; new `InternalTag`; `IconCatalog` extended with nav/top-bar glyphs.

**Tech Stack:** TypeScript (imperative Mural `.ts` views), `@pragmatic-tech-ai/mural` (basic/runtime/framework/visual-engine), `node:test` + `tsx`, `tsc --noEmit`. No backend.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-shell-design.md`

## Global Constraints

- OOP; Allman braces (opening brace on its own line for class/interface/enum/method/getter/ctor/control-flow; object literals and one-line blocks stay inline).
- PascalCase public methods/interfaces/members; private members and JSON-shape fields keep their casing.
- No inline user-facing/registry string literals - hoist to `private static readonly` constants (test-data literals in tests are fine).
- Enums over string-literal unions; shell components extend their Mural base (`StackPanel`/`Button`); any VM extends `Observable`.
- `IDisposable` over disposer lambdas where a lifecycle exists.
- Tests under `admin/portal/tests/` using `node:test`; set up `Application.current` with `Pragmatic`/`PragmaticLight` as the existing kit/view tests do.
- New `.ts` files pure ASCII + LF; after every write byte-scan `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> must be `0 0 N`. For an existing file touched (`app.ts`, `kit/icon-catalog.ts`, `kit/index.ts`), match its current EOL - check first, never flip. Escape non-ASCII as `\uXXXX`; re-scan after the Write tool.
- `admin/portal` must NEVER import from `admin/tenant-portal` (separation spec). Port code by re-implementing, not importing.
- Gate (run in `admin/portal`): `npm test` AND `npm run typecheck`, both green on the merged result. No control-plane change. E2e is separate (PA-15) - touch `portal.spec.ts` only if the rewrite breaks its selectors.
- Every actionable control is a `KeyActivatedButton` (or `Act`, which extends it) - keyboard-reachable, single activation, no double-fire. Every status/tag reads by icon + text, never colour alone. No dead/fake controls: a control that cannot honestly act in PA-2 is omitted.

## Review Focus

- Boot with `Session()` returning null or throwing -> login view, shell chrome hidden; signed-in boot -> top bar built, Fleet shown, active nav row focused. (Task 5 tests.)
- All nine `PaSection` values appear as rows in the correct groups and `ShowSection` routes each to a mounted view - none falls through to a blank host. (Task 3 + Task 5 tests.)
- Destination search jumps only to a real nav destination; empty query and no-match query are no-ops (no blank screen, no throw). (Task 4 tests.)
- Theme toggle calls `ThemeManager.ApplyScheme` and flips `CurrentScheme` between the two real schemes; keyboard-activatable, no double-fire. (Task 4 tests.)
- Legacy drill-down is unreachable from the primary nav but still mounts (with internal nav intact) from the dev-only entry. (Task 5 tests + diff review.)
- Every nav row, tab, search, theme toggle, operator-menu control keyboard-reachable; "Internal" tag + every status read by icon + text; no `admin/tenant-portal` import; no inline user-facing literal. (All tasks + diff review.)

---

### Task 1: Extend IconCatalog with nav and top-bar glyphs

**Files:**
- Modify: `admin/portal/src/kit/icon-catalog.ts`
- Test: `admin/portal/tests/kit-foundations.test.ts` (add cases; file exists)

**Interfaces:**
- Consumes: the existing `KitGlyph` enum + `IconCatalog.Definition(glyph)` + `SvgText(glyph)` pattern in the file.
- Produces: new `KitGlyph` members, each with a non-empty SVG definition: `Server`, `Building`, `Users`, `HardDrive`, `Package`, `Shield`, `Layers`, `Settings`, `Home`, `User`, `Sun`, `Moon`. (`RadioTower`, `Search`, `Check`, `ChevronUp`, `ChevronDown` already exist and are reused.)

Port the SVG path strings for `Users`, `HardDrive`, `Package`, `Shield`, `Layers`, `Settings`, `Home`, `User`, `Server` verbatim from `admin/tenant-portal/src/kit/icon-catalog.ts` (same lucide names). Author lucide-style paths for the PA-specific `Building`, `Sun`, `Moon`. Keep the existing per-glyph SVG format exactly.

- [ ] **Step 1: Write the failing test** - extend the glyph-resolution test so every new `KitGlyph` member resolves to a definition whose rendered path markup is non-empty.

```ts
it('resolves a definition for every nav and top-bar glyph', () =>
{
    const glyphs = [KitGlyph.Server, KitGlyph.Building, KitGlyph.Users, KitGlyph.HardDrive, KitGlyph.Package, KitGlyph.Shield, KitGlyph.Layers, KitGlyph.Settings, KitGlyph.Home, KitGlyph.User, KitGlyph.Sun, KitGlyph.Moon]
    for (const g of glyphs)
    {
        const def = IconCatalog.Definition(g)
        assert.ok(def !== undefined)
    }
})
```

- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/kit-foundations.test.ts`. Expected: FAIL (members undefined / no SvgText case).
- [ ] **Step 3: Add the enum members and their `SvgText` cases** in `icon-catalog.ts` (port from tenant catalog; author Building/Sun/Moon). Match the file's existing EOL (check with the byte-scan).
- [ ] **Step 4: Run to verify it passes** - same command. Expected: PASS. Byte-scan the modified file.
- [ ] **Step 5: Commit** `feat(admin-portal): add nav and top-bar glyphs to IconCatalog`.

---

### Task 2: PageHeader kit primitive + InternalTag

**Files:**
- Create: `admin/portal/src/kit/page-header.ts`
- Create: `admin/portal/src/kit/internal-tag.ts`
- Modify: `admin/portal/src/kit/index.ts` (barrel exports)
- Test: `admin/portal/tests/kit-screen.test.ts` (add cases; file exists)

**Interfaces:**
- Consumes: `Act` (`kit/act.js`), `KeyActivatedButton`, `IconCatalog`/`KitGlyph` (Task 1), `StackPanel`/`TextBlock`/`Icon`.
- Produces:
  - `export interface PageTab { label: string; onSelect: () => void }`
  - `export interface PageHeaderInputs { breadcrumb: readonly string[]; title: string; sub?: string; primaryAction?: Act; tabs?: readonly PageTab[] }`
  - `export class PageHeader extends StackPanel` with ctor `(inputs: PageHeaderInputs)`; seams `get BreadcrumbText(): string` (joined trail), `get Title(): string`, `get TabControls(): readonly KeyActivatedButton[]`, `SetActiveTab(index: number): void` (tags the active tab, the `current` role marker).
  - `export class InternalTag extends StackPanel` with ctor `()`; `static readonly LabelText = 'Internal'`; `get Label(): string`.

Breadcrumb joins the trail with a hoisted separator constant (e.g. `' / '`). Tabs render only when provided (each a `KeyActivatedButton` calling its `onSelect`); primary action and sub render only when provided. InternalTag is a small bordered badge: icon (optional) + the hoisted "Internal" text (text, not colour alone).

- [ ] **Step 1: Write the failing tests** - `PageHeader` renders the breadcrumb trail and title; with no tabs `TabControls` is empty; with two tabs there are two `KeyActivatedButton`s and `SetActiveTab(1)` marks the second; a provided `primaryAction` Act is present as a child. `InternalTag.Label === 'Internal'`.
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/kit-screen.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `PageHeader` and `InternalTag`**; export both (and `PageHeaderInputs`, `PageTab`) from `kit/index.ts`. New files LF + ASCII; `index.ts` keep its EOL.
- [ ] **Step 4: Run to verify it passes** - same command. Expected: PASS. Byte-scan new files (`0 0 N`).
- [ ] **Step 5: Commit** `feat(admin-portal): kit PageHeader and InternalTag`.

---

### Task 3: NavModel (grouped IA) + NavRail

**Files:**
- Create: `admin/portal/src/nav-model.ts`
- Create: `admin/portal/src/nav-rail.ts`
- Test: `admin/portal/tests/shell-nav.test.ts` (new)

**Interfaces:**
- Consumes: `KitGlyph` (Task 1), `InternalTag` (Task 2), `KeyActivatedButton`, `IconCatalog`, `Application.ResolveDefaultResource<Brush>`.
- Produces:
  - `export enum PaSection { Fleet = 'fleet', Clients = 'clients', Tenants = 'tenants', Hives = 'hives', Registry = 'registry', ReleasePolicy = 'release-policy', AgentChannel = 'agent-channel', PlatformComponents = 'platform-components', Settings = 'settings' }`
  - `export interface NavItem { Label: string; Glyph: KitGlyph; Section: PaSection }`
  - `export interface NavGroup { heading?: string; items: readonly NavItem[] }`
  - `export class NavModel` with `static readonly Groups: readonly NavGroup[]` (order: Fleet [no heading]; Provisioning [Clients, Tenants, Hives]; Releases [Registry & Releases, Release Policy]; Channel & software [Agent Channel, Platform Components]; Settings [no heading]); `static ActiveFor(section): PaSection` returns the section; `static LabelFor(section): string`.
  - `export class NavRail extends StackPanel` ctor `(onSelect: (s: PaSection) => void, active?: PaSection)`; `static readonly BrandText = 'Platform Admin'`; `get Active(): PaSection | undefined`; `Select(section)`; `SetActive(section)` (tags `current` role on the active row); `FocusActive()`; test seam `get Rows(): ReadonlyMap<PaSection, KeyActivatedButton>`. Paper surface `Bg0`. Glyph-to-section mapping: Fleet=Server, Clients=Building, Tenants=Users, Hives=HardDrive, Registry=Package, ReleasePolicy=Shield, AgentChannel=RadioTower, PlatformComponents=Layers, Settings=Settings.

All labels/headings are hoisted `private static readonly` on `NavModel`.

- [ ] **Step 1: Write the failing tests** - `NavModel.Groups` flattens to exactly the nine `PaSection` values in order, with the four group headings present and Fleet/Settings heading-less; `NavRail` builds a row per section (`Rows.size === 9`), `SetActive(PaSection.Clients)` tags that row `current` and no other, `Select` invokes the callback with the section.
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/shell-nav.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `nav-model.ts` then `nav-rail.ts`** (rail groups: optional heading `TextBlock` then a `KeyActivatedButton` row per item; brand + `InternalTag` at top). ASCII + LF; byte-scan.
- [ ] **Step 4: Run to verify it passes** - same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin-portal): grouped nav model and nav rail`.

---

### Task 4: TopBar (context, destination search, theme toggle, operator menu)

**Files:**
- Create: `admin/portal/src/top-bar.ts`
- Test: `admin/portal/tests/shell-top-bar.test.ts` (new)

**Interfaces:**
- Consumes: `NavModel`/`PaSection`/`NavItem` (Task 3), `KeyActivatedButton`, `Act`/`ActVariant`, `IconCatalog`/`KitGlyph`, `ThemeManager`, `Pragmatic`/`PragmaticLight`/`PragmaticDark` from `@pragmatic-tech-ai/mural/resources/pragmatic`, `TextBox` (from `@pragmatic-tech-ai/mural/framework` - confirm the import path during implementation), `Application.ResolveDefaultResource<Brush>`.
- Produces:
  - `export interface TopBarInputs { context: string; onJump: (section: PaSection) => void; onLogout: () => void; operatorEmail: string }`
  - `export class TopBar extends StackPanel` ctor `(inputs: TopBarInputs)`; `static readonly LogoutLabel = 'Logout'`, `static readonly SearchPlaceholder`, `static readonly ThemeLabel`; surface `Bg1`.
  - Seams: `get Context(): string`; `get SearchText(): string` / `SetSearch(text)`; `Jump(): void` (runs the current query's match, the Enter path and test seam); `get CurrentScheme(): 'light' | 'dark'`; `ToggleTheme(): void`; `get OperatorEmail(): string`; `Logout()` (invokes `onLogout`); `get BannerSlot(): StackPanel`.
  - Destination search: `TopBar.MatchSection(query): PaSection | undefined` - case-folded substring over `NavModel` item labels, first match; `Jump` calls `onJump` only when a match exists (empty/no-match = no-op).
  - Theme toggle: `ToggleTheme` flips an internal `light`/`dark` flag and calls `ThemeManager.ApplyScheme(PragmaticLight)` / `ThemeManager.ApplyScheme(PragmaticDark)`; the toggle control is a `KeyActivatedButton`/`Act`.

- [ ] **Step 1: Write the failing tests** - `SetSearch('rele'); Jump()` calls `onJump` with `PaSection.Registry` (first label match for "Registry & Releases") [pick a query that is unambiguous; assert the resolved section]; `SetSearch(''); Jump()` and `SetSearch('zzz'); Jump()` do NOT call `onJump`; `ToggleTheme()` flips `CurrentScheme` from `'light'` to `'dark'` and back; `Logout()` invokes the `onLogout` callback; `OperatorEmail` echoes the input.
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/shell-top-bar.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `top-bar.ts`** (bar row: context label, spacer, search `TextBox` with Enter -> `Jump`, theme toggle, operator menu [email + Logout, keyboard-reachable]; `BannerSlot` below). ASCII + LF; byte-scan. Verify the `TextBox` import/activation path against Mural; keep activation single-fire.
- [ ] **Step 4: Run to verify it passes** - same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin-portal): top bar with destination search, theme toggle, operator menu`.

---

### Task 5: ComingSoonView + shell rewrite (boot, routing, legacy dev entry)

**Files:**
- Create: `admin/portal/src/coming-soon-view.ts`
- Modify: `admin/portal/src/app.ts` (rewrite the `App` body; keep the class name and `./app.js` export so `main.ts` is untouched)
- Test: `admin/portal/tests/shell-app.test.ts` (new)

**Interfaces:**
- Consumes: `NavRail`/`NavModel`/`PaSection` (Task 3), `TopBar` (Task 4), `PageHeader` (Task 2), `ScreenHost`/`ScreenState`/`SkeletonKind` + `EmptyStateConfig` (PA-1 kit), `ControlPlaneClient` (`api-client.js`), `LoginView` (`login-view.js`), the legacy views + `IPortalNavigator`/`IPortalView` (`portal-types.js`), `EnvironmentListView` (`environment-list-view.js`).
- Consumes from Task 2/3/4: `PageHeaderInputs`, `NavModel.Groups`, `TopBarInputs`.
- Produces:
  - `export class ComingSoonView extends StackPanel implements IPortalView` ctor `(breadcrumb: readonly string[], title: string, sub?: string)`; renders a `PageHeader` above a `ScreenHost` with `{ loading: false, allowed: true, error: false, isEmpty: true, empty: { title: ComingSoonView.ComingSoonText } }`; `ComingSoonText = 'This screen arrives in a later release.'`; `AttachNavigator`/`Refresh` no-ops (satisfy `IPortalView`).
  - `App` (rewritten): `extends StackPanel implements IPortalNavigator`. Boot probes `Session()`; null or throw -> `ShowLogin()` (nav + top bar hidden, `LoginView` mounted); else build `TopBar` + show nav, then `ShowSection(PaSection.Fleet)` and `navRail.FocusActive()`. `ShowSection(section)` sets active + mounts the section's `ComingSoonView` (breadcrumb from the group heading + item label). The legacy `IPortalNavigator` methods stay implemented, mounting the legacy views into the content host WITHOUT changing the nav active-state. A dev-only operator-menu entry "Legacy environment tools (dev)" calls a shell method that mounts `EnvironmentListView`. `OnChanged` -> refresh current view.
  - Test seams on `App`: `get ActiveSection(): PaSection | undefined`, `get CurrentView(): IPortalView | undefined`, and whatever the boot test needs (e.g. inject a fake client).

Keep `App.TitleText` only if still used; move the brand to `NavRail.BrandText`. Do not change `main.ts`.

- [ ] **Step 1: Write the failing tests** - with a fake client whose `Session()` returns null, boot mounts a `LoginView` and no `NavRail`; with `Session()` returning `{ email }`, boot mounts the `NavRail`, a `TopBar`, and the Fleet `ComingSoonView`, and `ActiveSection === PaSection.Fleet`; `ShowSection` for each of the nine sections mounts a `ComingSoonView` and sets `ActiveSection`; the legacy `ShowClients()` mounts the legacy client view without changing `ActiveSection` away from its current nav section. Keep async boot deterministic (await the boot promise / expose a `Boot()` the test can await).
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/shell-app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `coming-soon-view.ts`, then rewrite `app.ts`** - match `app.ts`'s current EOL (check first; it is an existing file - never flip). ASCII; escape any non-ASCII; byte-scan after writing.
- [ ] **Step 4: Run the full gate** - `cd admin/portal && npx tsx --test tests/*.test.ts && npm run typecheck`. Expected: all green (the whole portal suite, not just the new file). If the rewrite broke an existing test that asserted old-shell behavior, update that test to the new shell contract (intended change) and note it.
- [ ] **Step 5: Commit** `feat(admin-portal): platform admin shell - grouped nav, top bar, page header, Fleet landing, legacy demoted`.
