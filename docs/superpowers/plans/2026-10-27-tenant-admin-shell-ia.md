# Tenant-Admin Shell & IA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tenant portal's top-bar-buttons + "My Hives" tree shell with the design's IA — a paper six-item left nav, a fixed org/tenant/hive identity plate (no switcher), and a calm top bar — hosting placeholders for unbuilt sections and re-homing the existing B1 screens.

**Architecture:** Pure UI on the TA-1 kit. Leaf components (nav rail, identity plate, top bar, user menu, placeholder + users-access hub views) are built first as new files; then `tenant-app.ts` is rewired from `treeHost | detailHost` to `NavRail | (TopBar over detailHost)` with a `NavSection`/`ShowSection` model. No server changes.

**Tech Stack:** TypeScript, `@pragmatic-tech-ai/mural` (panels, `Button`, `TextBlock`, `Icon`), the TA-1 kit (`admin/tenant-portal/src/kit`), `@pragmatic-tech-ai/todl-runtime` `Observable`, `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-shell-ia-design.md`

## Global Constraints

- **No server changes.** The identity plate takes `{ org?, tenant, hive }` inputs; wire from `session` with honest fallbacks (`tenant = session.tenantId`, `hive` = a placeholder constant, `org` omitted when absent — NEVER invent an org name). Real values are TA-3.
- **Six nav items, exact order + glyph:** Overview (`home`), Environments (`layers`), Users & Access (`users`), Releases (`package`), Settings (`settings`), Connection status (`radio-tower`). One unlabelled group; paper sidebar; comfortable density; exactly one active item; brand "Tenant Admin"; footer "Runs inside your hive. Manages one tenant."
- **Identity plate is non-interactive** — no switcher/caret/disabled dropdown; hover title "This console manages one tenant in one hive".
- **Trust boundary:** nothing hints at other tenants/hives or a "platform" section; remove the four B1 command buttons from the top bar.
- **Reuse the TA-1 kit** (`ScreenHost`, `Act`, `StatusPill`, `Section`, etc.) via `admin/tenant-portal/src/kit/index.js`; add missing glyphs to `kit/icon-catalog.ts` from `dev-kit/design/admin-apps/src/icons.json`.
- **ENCODING (bit TA-1 twice):** every file PURE ASCII — straight apostrophes, any em dash as `—`; verify with a byte scan (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13))"` → `0 0`), NOT grep. **EOL:** new files LF; `tenant-app.ts` + `tenant-app.test.ts` are **CRLF**; `tenant-types.ts` is **LF**; `kit/*` are **LF**; test-nav stubs keep their own endings (`service-tokens-view.test.ts`/`users-access-view.test.ts` LF, `tenant-tree-view.test.ts` CRLF).
- **House style:** OOP, Allman braces, PascalCase public, no inline string literals (hoist copy/labels to `static readonly`; data tables excepted), enums over unions, VMs extend `Observable`, teardown via `Dispose()`.
- **Gates:** `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`. Never `npm install` at repo root. Do NOT edit Mural.
- **Branch off `master`; merge-local (ff) at finish; NEVER push.** Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Identity plate with no `org`** must hide the `/ org` segment, not render an empty slot or a placeholder word. → Task 2 test.
- **Identity plate exposes no interactive control** (it's a label, not a switcher). → Task 2 test asserts no Button/clickable in its tree.
- **Exactly one nav item active**, and the Environments item stays active on an environment/hive **detail** view (not just the Environments section itself). → Task 1 + Task 4 tests.
- **Boot lands on Overview**, and `OnTenantEvent`/`Teardown` no longer assume a tree exists (no crash when the tree pane is gone). → Task 4 test.
- **The four B1 screens stay reachable** after their top-bar buttons are removed (via the Users & Access hub), and `EnvironmentDetailView`/`HiveDetailView` stay reachable (via the interim Environments host). → Task 3 + Task 4 tests.

---

### Task 1: Nav model, `NavRail`, kit glyphs

**Files:**
- Create: `admin/tenant-portal/src/nav-model.ts` (LF), `admin/tenant-portal/src/nav-rail.ts` (LF)
- Modify: `admin/tenant-portal/src/kit/icon-catalog.ts` (LF)
- Test: `admin/tenant-portal/tests/nav-rail.test.ts` (LF)

**Interfaces:**
- Produces: `enum NavSection { Overview, Environments, UsersAccess, Releases, Settings, ConnectionStatus }`; `interface NavItem { Label: string; Glyph: KitGlyph; Section: NavSection }`; `class NavModel` (or a `static readonly Items: readonly NavItem[]`) giving the ordered six items + an `ActiveFor(section)` helper (maps a section — incl. detail-view aliases — to the active item). `class NavRail` — a paper sidebar control: brand, the six item `Button`s (active marker + a `Tag`/`aria-current` equivalent), footer note; invokes a supplied `onSelect(section)` callback. Adds `KitGlyph.Home`, `KitGlyph.Layers`, `KitGlyph.HardDrive` to the catalog from `icons.json`.
- Consumes: TA-1 kit (`KitGlyph`, `IconCatalog`), Mural panels/`Button`/`TextBlock`.

- [ ] **Step 1:** Add `home`, `layers`, `hard-drive` glyphs to `kit/icon-catalog.ts` (element data verbatim from `dev-kit/design/admin-apps/src/icons.json`); extend the TA-1 icon test to cover them.
- [ ] **Step 2: Write failing tests:** `NavModel.Items` is exactly the six sections in order with the right labels + glyphs; `ActiveFor(section)` returns the matching item, and an environment/hive **detail** alias maps to `Environments`; `NavRail` renders six item buttons with the labels + brand + footer note, and marks exactly one active for a given section (asserts the active marker/`Tag`); selecting an item invokes `onSelect` with the section.
- [ ] **Step 3:** Run to verify fail.
- [ ] **Step 4:** Implement `nav-model.ts`, `nav-rail.ts`; hoist all labels/copy to `static readonly`.
- [ ] **Step 5:** Run green; `typecheck`; verify ASCII+LF; commit.

---

### Task 2: `IdentityPlate`, `TopBar`, `UserMenu`

**Files:**
- Create: `admin/tenant-portal/src/identity-plate.ts` (LF), `admin/tenant-portal/src/top-bar.ts` (LF), `admin/tenant-portal/src/user-menu.ts` (LF)
- Test: `admin/tenant-portal/tests/top-bar.test.ts` (LF)

**Interfaces:**
- Produces: `class IdentityPlate` — inputs `{ org?: string; tenant: string; hive: string }`; renders `org / [users] tenant [hard-drive] hive` (hive mono), non-interactive chip, hover title constant; **hides the org segment when `org` is undefined/empty**. `class UserMenu` — inputs `{ email: string; onLogout: () => void }`; avatar initials + email + a Logout action (role label deferred). `class TopBar` — hosts `IdentityPlate` (left), spacer, `UserMenu` (right); exposes a `BannerSlot` (a container above content) for later use.
- Consumes: TA-1 kit (`KitGlyph`, `Act`/`Button`), Mural panels/`TextBlock`/`Icon`.

- [ ] **Step 1: Write failing tests:** `IdentityPlate` renders tenant + hive always, and the org segment only when `org` is set (assert the `/ org` text is ABSENT when `org` omitted); it exposes **no interactive control** (walk its tree: no `Button`/clickable); hover title constant present. `UserMenu` shows the email and a Logout control whose activation invokes `onLogout`. `TopBar` contains the plate + user menu and exposes an (initially empty) banner slot.
- [ ] **Step 2:** Run to verify fail.
- [ ] **Step 3:** Implement; hoist copy (hover title, brand, separators) to `static readonly`; any em dash `—`.
- [ ] **Step 4:** Run green; `typecheck`; verify ASCII+LF; commit.

---

### Task 3: `ComingSoonView` + `UsersAccessHubView`

**Files:**
- Create: `admin/tenant-portal/src/coming-soon-view.ts` (LF), `admin/tenant-portal/src/users-access-hub-view.ts` (LF)
- Test: `admin/tenant-portal/tests/coming-soon-view.test.ts` (LF), `admin/tenant-portal/tests/users-access-hub-view.test.ts` (LF)

**Interfaces:**
- Consumes: `TenantViewBase`, `ITenantNavigator` (existing show-methods `ShowServiceTokens`/`ShowRolesPrivileges`/`ShowFieldSecurity`), `UsersAccessView` (B1-1), TA-1 kit (`ScreenHost`, `Act`/`SegmentedButton`).
- Produces: `class ComingSoonView extends TenantViewBase` — ctor `(title: string)`; renders the kit `ScreenHost` empty state (`EmptyStateConfig`: a glyph, the title, body "This screen arrives in a later release"). Replaces `placeholder-root-view`/`DetailPlaceholderView` usage. `class UsersAccessHubView extends TenantViewBase` — shows `UsersAccessView` by default and a button/segmented row routing to Service Tokens / Roles & Privileges / Field Security via the navigator; a `get Active()` seam for tests.

- [ ] **Step 1: Write failing tests:** `ComingSoonView` renders the kit empty state with the given title + body. `UsersAccessHubView` shows a `UsersAccessView` by default; the hub row has the three routes and invoking each calls the right navigator method (use a fake navigator).
- [ ] **Step 2:** Run to verify fail.
- [ ] **Step 3:** Implement; hoist copy; any em dash `—`.
- [ ] **Step 4:** Run green; `typecheck`; verify ASCII+LF; commit.

---

### Task 4: Frame rewire in `TenantApp` + nav wiring

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF), `admin/tenant-portal/src/tenant-types.ts` (LF)
- Modify: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF); the test `Nav` stubs implementing `ITenantNavigator` (add `ShowSection`) — `service-tokens-view.test.ts`/`users-access-view.test.ts` (LF), `tenant-tree-view.test.ts` (CRLF), `roles-privileges-view.test.ts`/`field-security-view.test.ts` (LF).

**Interfaces:**
- Consumes: Task 1 (`NavSection`, `NavModel`, `NavRail`), Task 2 (`TopBar`/`IdentityPlate`/`UserMenu`), Task 3 (`ComingSoonView`, `UsersAccessHubView`), existing `TenantTreeView`/`EnvironmentDetailView`/`HiveDetailView`.
- Produces: `ITenantNavigator.ShowSection(section: NavSection): void`; `TenantApp.ShowSection`; the new frame.

- [ ] **Step 1: Write failing tests** (`tenant-app.test.ts`): after Boot the app shows the Overview `ComingSoonView` (not a tree); the nav has six items; `ShowSection(UsersAccess)` shows a `UsersAccessHubView`; `ShowSection(Environments)` shows the interim environments host and the Environments item is active; opening an environment detail keeps Environments active; the four old top-bar command buttons are GONE; Logout now lives in the user menu and still logs out; `OnTenantEvent`/`Teardown` do not throw with no tree pane.
- [ ] **Step 2:** Run to verify fail.
- [ ] **Step 3:** Implement. Add `ShowSection` to `ITenantNavigator` (`tenant-types.ts`) + the test-nav stubs. Rewire `tenant-app.ts`: body = `NavRail | detailHost`; top = `TopBar`; `NavSection` active tracker; `ShowSection` maps Overview/Releases/Settings/ConnectionStatus→`new ComingSoonView(<label>)`, Environments→interim `TenantTreeView` host (keep `ShowHiveDetail`/`ShowEnvironmentDetail`; mark Environments active on those), UsersAccess→`UsersAccessHubView`; `Boot()`→`ShowSection(Overview)`; move Logout into `UserMenu`; remove the four top-bar buttons + the `treeHost` pane; `OnTenantEvent` forwards to the active view only. Keep `Show`/`Teardown`/`ShowLogin`.
- [ ] **Step 4:** Run green; `typecheck`; `typecheck:tools`; verify EOL per file (CRLF: tenant-app.ts + its test; LF: tenant-types.ts) + ASCII; commit.

---

### Task 5: Polish & verify (a11y markers, theme toggle feasibility)

**Files:**
- Modify: as needed (`nav-rail.ts`, `tenant-app.ts`) (keep each file's EOL)
- Test: extend existing kit/shell tests.

**Interfaces:** none new.

- [ ] **Step 1:** Add the a11y markers the stack supports: a primary-nav role/label + `aria-current`-equivalent on the active item via `Tag` (match the TA-1 `BusyRole`/`AlertRole` seam approach); visible focus relies on existing `Button` focus. Add a test asserting the active item carries the current marker.
- [ ] **Step 2: Theme toggle feasibility (ruling R5):** check whether the Pragmatic `ThemeManager`/`main.ts` already supports a dark scheme. If yes and cheap, add a `ThemeSwitch` to the `TopBar` (system→light→dark, with a glyph + aria-label) + a test. If not, DEFER it — record the decision in the report; do not fake a second palette.
- [ ] **Step 3:** Run the full `npm --prefix admin/tenant-portal test` + `typecheck` + `typecheck:tools`; verify ASCII+LF across all touched files; commit.

---

## Self-review notes

- **Spec coverage:** R1 (plate inputs + fallbacks) → Task 2/4; R2 (retire tree from nav, interim under Environments) → Task 4; R3 (B1 hub) → Task 3/4; R4 (ComingSoon + land on Overview) → Task 3/4; R5 (defer chrome; theme toggle conditional) → Task 5; R6 (kit glyphs) → Task 1.
- **Type consistency:** `NavSection`/`NavModel` (Task 1) consumed by `TenantApp` (4) + `ITenantNavigator.ShowSection`; `IdentityPlate`/`TopBar`/`UserMenu` (Task 2) hosted by the frame (4); `ComingSoonView`/`UsersAccessHubView` (Task 3) mapped by `ShowSection` (4). Only Task 4 edits `tenant-app.ts`/`tenant-types.ts`; only Task 1 edits `kit/icon-catalog.ts`.
- **Proportion:** the plan carries the nav model, the plate contract + fallbacks, the section→view mapping, the retire/re-home decisions, and the EOL/ASCII map; component bodies are left to the implementer composing the kit + Mural controls.
