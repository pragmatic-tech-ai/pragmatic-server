# PA-2 - Platform Admin shell and information architecture - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The SECOND Platform Admin spec - a UI-only shell with no backend dependency, built on the PA-1 kit.
**Area:** Platform Admin portal (`admin/portal/`) - the application shell: grouped left nav, top bar, page header, "Internal" tag, and the nine-item information architecture that replaces the bare `app.ts` drill-down.
**Builds on:** PA-1 kit (`admin/portal/src/kit/`: KeyActivatedButton, Act, ScreenHost/ScreenState, Section, Banner, StatusPill, DataTable, IconCatalog, Tones). Informed by the proven tenant-portal shell (`admin/tenant-portal/src/{tenant-app,nav-model,nav-rail,top-bar}.ts`), re-implemented here - NOT imported.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 0 (bare shell, no nav/top-bar/page-header today), section 4(a) (shell + grouped left nav + top bar + page header + "Internal" tag + theme), section 5 (legacy dev-environment/graph views out of the nav), section 6 spec 1.
**Separation spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` - the platform admin is the internal operator console; `admin/portal` must never import from `admin/tenant-portal`.

## Context: where PA-2 sits

PA-1 built the component kit. PA-2 builds the shell those components live in: the grouped nine-item nav, the top bar, and the reusable page header. It does not build any screen's real content - every destination lands on an honest placeholder until its own spec (PA-4 Fleet, PA-5/6/7 Clients/Tenants/Hives, etc.) fills it. It is the frame; the pictures come later. UI-only, zero backend change.

## The scope decision (recon finding + ruling)

Recon found the built portal shell (`app.ts`) is a bare `StackPanel`: a title, a Logout button, and a swap-in host. It boots to the legacy dev-environment list (`environment-list-view.ts`) and drills down Clients -> Tenants (per client) -> Hives (per tenant) -> graphs/promote. There is no left nav, no top bar, no page header, and the IA is a drill-down chain, not the designed nine-item nav (recon section 0).

**Ruling 1 (scope): PA-2 rewrites the shell (`app.ts`) to the designed grouped IA and boots to a Fleet landing, routing every not-yet-built destination to an honest placeholder.** The designed Fleet home, Clients/Tenants/Hives list+detail, Registry, Policy, Channel, Components, and Settings screens are each their own later spec (recon section 6). PA-2 does not port or restyle any of them; it stands up the frame and the routing so those specs each drop one screen into a finished shell. This mirrors how the tenant shell (TA, `tenant-app.ts`) shipped with `ComingSoonView` placeholders and let later specs fill sections.

**Ruling 2 (legacy views, resolving recon section 5's owner decision): the legacy environment/graph and client/tenant/hive drill-down views leave the primary nav, but stay reachable behind a single dev-only entry.** Recon section 5 recommends removing the dev-edit environment/graph tooling (which *commands* environments, violating "observe, never command") from the Platform Admin nav, keeping the code behind a dev-only entry until the tenant-admin app covers it, and making Fleet the landing page. PA-2 does exactly that: the new nav exposes only the nine designed sections; the shell still implements the legacy `IPortalNavigator` surface so the old views keep working unchanged, reached only through one "Legacy environment tools (dev)" entry in the operator menu. Nothing working is deleted; it is demoted. `LoginView`, the `ControlPlaneClient` session/events plumbing, and `PortalViewBase` are reused as-is (recon section 5 calls them reusable).

**Ruling 3 (honesty over the designed top-bar search): the top-bar search is a destination jump, not a dead global search.** The design shows a search in the top bar, but there is no backend index to search in PA-2 and a search box that hits nothing is a dead/fake control (forbidden by the honesty invariant). The honest realization that needs no backend is a *destination* search: typing filters the nine nav destinations by label and Enter jumps to the first match. It is real, keyboard-friendly, and useful from day one. Fuller content/global search is deferred to a spec that has something to index (filed as a Feature).

**Ruling 4 (theme toggle is real): include a working light/dark toggle.** Recon confirmed `PragmaticDark` exists alongside `PragmaticLight` and `ThemeManager.ApplyScheme(scheme)` performs a runtime scheme swap. So a top-bar theme toggle genuinely switches schemes - it is not a dead control. PA-2 includes it. This does NOT author a new theme or tokens file; the greens/surfaces come from the existing shared Pragmatic Mural theme (PA-1 deferred "the full theme tokens pass" and that stays deferred). "Pragmatic theme tokens" in this spec means the shell *composes against* the existing theme's resources (paper rail `Bg0`, raised bar `Bg1`, the action-primary green for the one primary action), exactly as the PA-1 kit and the tenant shell already do via `Application.ResolveDefaultResource`.

## Goals

A Platform Admin application shell, OOP imperative `.ts`, that:

- **Grouped left nav** (recon 4a IA): an ink/paper sidebar with brand "Platform Admin", an **"Internal" tag**, and the nine destinations in their groups:
  - **Fleet** (top, landing page; no group heading)
  - **Provisioning**: Clients, Tenants, Hives
  - **Releases**: Registry & Releases, Release Policy
  - **Channel & software**: Agent Channel, Platform Components
  - **Settings** (no group heading)
  Each row is a `KeyActivatedButton` (keyboard-reachable from PA-1), the active row is marked, and boot focuses the active row (Mural enters its Tab order only from a focused control).
- **Top bar**: a context label, a **destination search** (ruling 3), a **theme light/dark toggle** (ruling 4), and an **operator menu** (operator email from the session + Logout; role is PA-3, not here). A `BannerSlot` below the bar that later specs (quiet-hive banner, etc.) fill.
- **Page header** (new kit component): breadcrumb, title, sub, one optional primary action (`Act`), and an optional tabs row. Reusable by every screen; rendered by the PA-2 placeholders now.
- **Shell composition**: auth-gated boot (session probe -> `LoginView` when signed out, or build chrome + Fleet landing when signed in); a nav rail on the left and, on the right, the top bar over a content host; `ShowSection` routes each destination; a dev-only "Legacy environment tools" entry preserves the old views (ruling 2).
- **Honest placeholders**: a `ComingSoonView` that renders the page header plus a PA-1 `ScreenHost` empty/coming-soon state ("This screen arrives in a later release.") for every destination whose real content is a later spec.
- **IconCatalog extension**: add the nav and top-bar glyphs PA-1's catalog lacks (it has only status/pill + Search/Check/chevrons), porting path definitions from the tenant `icon-catalog.ts` where equivalent and adding PA-specific ones.

## Non-goals

- Any screen's real content (Fleet tiles/table, Clients/Tenants/Hives lists/details, Registry, Policy, Channel, Components, Settings) - each is its own later spec; PA-2 ships placeholders.
- Any backend, route, or data call beyond what the shell already uses (`Session`, `Logout`, `OnChanged`). No new control-plane work.
- Operator role / visible-but-denied behavior (PA-3, G7). The operator menu shows the email only; no role gating in the nav yet.
- Deleting or restyling the legacy environment/graph/CRUD views - they are demoted to a dev-only entry, not touched.
- Authoring a new theme or `tokens.json`, or a Toast/Dialog/Drawer/OpsDrawer/ConfirmDialog/SecretTable/OnceSecret/ObservedPanel/Steps/Activity/States-matrix (PA-1 deferred these to their first screen).
- A global/content search (ruling 3 defers it); the top-bar search jumps to nav destinations only.

## Anti-goals (a failure even if it "works")

- A nav row, search box, theme toggle, or operator-menu control that is not keyboard-reachable/activatable (repeats the TA-16 debt).
- A dead/fake control: a search that searches nothing, a theme toggle that does not switch, a primary action that does nothing. If a control cannot honestly act in PA-2, it is omitted, not faked.
- The legacy drill-down (environment/graph/CRUD) reachable from the new primary nav (contradicts recon section 5 and re-imports "command, not observe").
- Coupling `admin/portal` to `admin/tenant-portal` (separation spec).
- Inline string literals for user-facing/nav/registry text (must be hoisted to `private static readonly`).
- A page header whose breadcrumb/title/tabs cannot be exercised by a test (no seams).

## Information architecture (the decided shape)

- **`nav-model.ts`** (PA-owned, top-level `src/`, mirroring TA): an enum `PaSection` with the nine destinations, and a grouped model `NavModel` exposing `readonly Groups: NavGroup[]` where `NavGroup { heading?: string; items: NavItem[] }` and `NavItem { Label; Glyph; Section }`. Groups in order: Fleet (no heading, one item), Provisioning (Clients/Tenants/Hives), Releases (Registry & Releases/Release Policy), Channel & software (Agent Channel/Platform Components), Settings (no heading, one item). `NavModel.ActiveFor(section)` returns the section itself (detail views later pass their owning section). All labels/headings are hoisted constants.
- **`nav-rail.ts`** (PA-owned): `NavRail extends StackPanel`. Brand header "Platform Admin" + `InternalTag`; for each group, an optional heading `TextBlock` then a `KeyActivatedButton` per item (icon + label); footer optional. `SetActive(section)` tags the current row (the `current` role marker from TA); `FocusActive()` focuses the active row on boot; `Select(section)` is the click path and the test seam. Paper surface `Bg0`.
- **`internal-tag.ts`** (new, PA-owned kit or `src/` - builder's call; recommend `kit/` since it is a reusable badge): `InternalTag extends StackPanel`, a small bordered "Internal" badge (icon optional + text), hoisted label, a `Label` seam. Conveys by text, never colour alone.
- **`top-bar.ts`** (PA-owned): `TopBar extends StackPanel`, vertical host of a bar row over a `BannerSlot`. Bar row: a context label (left), a spacer, a search box (`TextBox` + `onJump(section)` seam that matches `NavModel` item labels, Enter jumps to the first match, empty/no-match is a no-op), a theme-toggle `KeyActivatedButton`/`Act` (`onToggleTheme` seam; switches `PragmaticLight`/`PragmaticDark` via `ThemeManager.ApplyScheme`; exposes `CurrentScheme`), and an operator menu (email + Logout; a `KeyActivatedButton`-based menu or inline row). Raised surface `Bg1`. Seams: `Context`, `SearchText`, `CurrentScheme`, `BannerSlot`.
- **`kit/page-header.ts`** (new kit primitive, PA-owned): `PageHeader extends StackPanel` taking `PageHeaderInputs { breadcrumb: readonly string[]; title: string; sub?: string; primaryAction?: Act; tabs?: readonly PageTab[] }` where `PageTab { label; onSelect }`. Renders breadcrumb trail, title, optional sub, optional primary action (right), optional tabs row (each tab a `KeyActivatedButton`, active tab marked). Seams for the rendered breadcrumb text, title, and tab controls. Exported from `kit/index.ts`.
- **`coming-soon-view.ts`** (PA-owned): `ComingSoonView` takes a section's breadcrumb + title + sub and renders a `PageHeader` above a `ScreenHost` resolved to an empty/coming-soon state with honest copy ("This screen arrives in a later release.") - no fake primary action.
- **`app.ts`** (rewritten shell, class `App` kept so `main.ts` is untouched): `extends StackPanel implements IPortalNavigator`. Owns `ControlPlaneClient`, a `NavRail`, and a right column (top-host over content-host). Boot: `Session()` -> null/throw -> `ShowLogin()` (full screen, chrome hidden); else build `TopBar` + nav, then `ShowSection(PaSection.Fleet)` and `navRail.FocusActive()`. `ShowSection` sets active + routes each of the nine to its `ComingSoonView` (until later specs replace the arm). The legacy `IPortalNavigator` methods (`ShowList/ShowDetail/ShowGraphs/.../ShowHives/...`) remain implemented, mounting the old views into the content host WITHOUT touching the new nav active-state; they fire only from within the legacy content, reached via the operator menu's dev-only "Legacy environment tools" entry. `OnChanged` refreshes the current view as today.
- **`icon-catalog.ts`** (extend): add nav glyphs (Fleet/home or gauge, Clients, Tenants, Hives, Registry/package, Release Policy/shield, Agent Channel [RadioTower exists], Platform Components/cube, Settings) and top-bar glyphs (search exists; theme sun/moon; operator/user). Port path strings from the tenant `icon-catalog.ts` for the equivalents (Home, Users, Package, Settings, Layers); add PA-specific glyphs as needed. New `KitGlyph` members + their `IconCatalog` definitions.
- Tests under `admin/portal/tests/` (`node:test`, the `Application.current` + `Pragmatic`/`PragmaticLight` setup used by the existing kit/view tests).

## What's left to the builder (plan + implementation calls)

- Whether `InternalTag` lands in `kit/` (recommended, reusable + testable) or `src/`.
- The precise `KitGlyph` additions and which tenant path defs to port vs. author (keep each glyph a real icon, never a placeholder box).
- The operator-menu construction (inline row vs. a small popup) - keep it keyboard-reachable; email + Logout only (no role).
- The destination-search match rule (prefix vs. substring; case-folding) and how it surfaces the jump target - keep it honest (jumps only to a real nav destination) and testable.
- Exactly how the dev-only "Legacy environment tools" entry mounts `EnvironmentListView` and whether it shows a one-line "dev tooling, leaving the designed console" note.
- Page-header tabs API details (how active is tracked) given no PA-2 screen uses tabs yet - ship the seam, exercise it with a test, let detail specs consume it.
- Whether to keep `ThemeManager.Density = Density.Compact` (main.ts sets it today) or expose density in the shell - recommend leaving density as-is (compact) and NOT adding a density control here (DataTable already has its own density toggle).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline string literals (hoist to `private static readonly`; test-data literals in tests are fine), enums over unions, view models extend `Observable` (shell components extend their Mural base), `IDisposable` not lambdas, tests under `admin/portal/tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` must be `0 0 N`). Match the EOL of any existing file touched (`app.ts`, `icon-catalog.ts`, `kit/index.ts` already exist - check before editing; never flip EOL). Escape non-ASCII as `\uXXXX`, re-scan after the Write tool.
- Gate: `npm test` + `npm run typecheck` in `admin/portal`, both green on the merged result. No server change (no control-plane gate for PA-2). E2e (`npm run test:e2e`) is separate/gated; update `portal.spec.ts` only if the shell rewrite breaks its selectors, else leave e2e to PA-15.
- UI-only, PA-owned, no coupling to the tenant app, no backend call beyond `Session`/`Logout`/`OnChanged`. Every actionable control keyboard-reachable; every state conveyed by icon + text, not colour alone; no dead/fake controls; the legacy drill-down never in the primary nav.

## Review focus (inputs no happy-path test exercises)

- Boot when `Session()` throws or returns null renders the login view with the shell chrome hidden; boot when signed in builds the top bar, shows Fleet, and focuses the active nav row. (Shell tests.)
- Every one of the nine `PaSection` values has a nav row in the correct group and routes `ShowSection` to a view (no section falls through to a blank host). (Nav/shell tests.)
- The destination search jumps only to a real nav destination; an empty query and a no-match query are no-ops (never a blank screen, never a thrown error). (Top-bar tests.)
- The theme toggle actually calls `ApplyScheme` and flips `CurrentScheme` between the two real schemes; it is keyboard-activatable with no double-fire. (Top-bar tests.)
- The legacy drill-down is NOT reachable from the new primary nav, and the dev-only entry still mounts the legacy view with its internal navigation intact. (Shell tests + diff review.)
- Every nav row, tab, search, theme toggle, and operator-menu control is keyboard-reachable; the "Internal" tag and every status read by icon + text. (All.)
- No import from `admin/tenant-portal`; no inline user-facing literal. (Diff review.)
