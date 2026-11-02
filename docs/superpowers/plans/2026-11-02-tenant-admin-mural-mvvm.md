# Tenant Admin on Mural markup + MVVM + EditorShell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `admin/tenant-portal` as a Mural-markup MVVM app whose root is a bare `EditorShell` composed from one shell module per section, following `dev-kit/design/admin-apps` (tenant) against the unchanged `/tenant-auth` + `/tenant-api` surface.

**Architecture:** mirrors the Platform Admin (`2026-11-02-platform-admin-mural-mvvm.md`), with tenant-side names:
- `login.mu` and `app.mu` are two compiled `.mu` Applications, both `Scheme = PragmaticDark`. `main.ts` runs `TenantBoot`: no session -> `BeginLogin()` (IdP redirect, as today); probe failure -> `login.mu`; session -> `app.mu`. Logout or any 401 reloads the page.
- `app.mu` registers app-root services: `TenantSessionService`, `ContentHostService`, `TenantNavigationService -> NavigationService`, `ClipboardService`. It composes six section modules: Overview, Environments, UsersAccess, Releases, Settings, Connection.
- Each section is a `TenantSectionService` (a page stack presented through `ContentHostService`) with page view-models rendered by implicit-by-type `.mu` DataTemplates. Forms run as dialogs through `DialogService`; the token reveal and the adopt wizard are pages.

**Tech Stack:** TypeScript, Mural (`.mu` compiled by the Mural CLI, framework shell and services), todl-runtime `Observable` / `ServiceBase`, Vite, node:test via `tsx --test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-tenant-admin-mural-mvvm-design.md` (authoritative; its Rules section is binding).

## Global Constraints

- All UI is `.mu` markup. No TS code constructs a Visual tree. View-models extend `Observable`; section/shell services extend `ServiceBase`.
- Stock Mural only; no edits to the Mural repo. If something can't be expressed without a Mural change, stop and report it; don't work around it with imperative Visual code.
- Stay inside `admin/tenant-portal/` (plus these docs and the tenant paragraphs of `admin/README.md`). Never import from `admin/portal/`.
- Backend unchanged: `TenantApiClient` + `tenant-types.ts` only. Never invent a route or field.
- Secrets: the issued token value is shown once on a reveal page, gated on "I've saved it", cleared on confirm, never logged or kept elsewhere.
- Denied, not hidden: every mutating command's `CanExecute` is false without its `AdminCapability`; the page binds the reason (`TenantSessionService.DeniedReason(capability)`).
- Conventions (CLAUDE.md): OOP, Allman braces, PascalCase public members/interfaces, no inline TS string literals (`private static readonly` PascalCase), enums over string unions, tests in `tests/` subfolders, new `.ts` ASCII + LF, generated `*.mu.js` committed.
- Mural pitfalls: explicit `ItemTemplate` on every ListBox over Observable rows; no bare ItemsControl filled after first layout (use ListBox); replace (don't mutate) a ComboBox's ItemsSource collection after realization and raise the property; tabs are a `SegmentedButton` over string labels with content swapped by `Visibility` or `ContentControl`.
- Layout: shared shell code in `src/shell/` (tests in `src/shell/tests/`); sections in `src/sections/<section>/` (`<section>.module.mu`, `<section>.resources.mu`, `*-section-service.ts`, page/dialog VMs, `tests/`).
- Gates for every task: `npm --prefix admin/tenant-portal test`, `npm --prefix admin/tenant-portal run typecheck`, root `npm run typecheck:tools`; Task 7 adds `run build` and `run test:e2e`.
- Git: stage by explicit path; commit per task with the `Co-Authored-By` trailer; never merge, never push.

## Review Focus

1. **Rail round-trip:** open an environment's detail, switch section, come back: the detail is shown again.
2. **Denied:** without a capability, every command needing it is disabled, executing it never opens a dialog, and the reason is bindable.
3. **One-time token lifetime:** after "I've saved it" + Done, the reveal VM no longer holds the value; leaving through the rail before confirming keeps the reveal as the section's current page.
4. **Session expiry:** a 401 from any load or command calls `TenantSessionService.Expire()`, which reloads exactly once.
5. **Live update:** an event refreshes only the active section's current page and keeps the operator on it; a deleted environment's open detail returns to the list.
6. **Unsaved security model:** switching environment or leaving with unsaved changes never silently discards them.

---

### Task 1: Build plumbing, shell core, Connection status section

**Files:** `scripts/compile-mu.mjs`, `vite.config.ts` (ThemeFontCopy), `package.json` scripts, `src/mu-modules.d.ts`; `src/shell/`: `page-reloader.ts`, `admin-capability.ts`, `tenant-session-service.ts`, `tenant-page-view-model.ts`, `tenant-dialog-view-model.ts`, `name-confirm-dialog-view-model.ts`, `confirm-dialog-view-model.ts`, `one-time-secret-page-view-model.ts`, `holds-pending-secret.ts`, `holds-pending-work.ts`, `option-view-model.ts`, `tenant-section-service.ts`, `tenant-navigation-service.ts`, `shell.resources.mu`, `tenant-icons.mu` + `icons/*.svg`; `src/sections/connection/` (module, resources, `ConnectionSectionService`, `ConnectionPageViewModel`); `src/app.mu`; tests under `src/shell/tests/` and `src/sections/connection/tests/`.

**Interfaces (later tasks rely on these names):**
- `enum AdminCapability { Environments, Adopt, Access, Settings }`; `AdminCapabilities.NameOf(cap)`.
- `TenantSessionService` (Key `'TenantSessionService'`): `Initialize(client, session, profile | undefined, reloader)`, `Client`, `Profile`, `PrincipalId`, `Email`, `RoleLabel`, `OrganisationLabel`, `HasOrganisation`, `TenantLabel`, `HiveLabel`, `OwnerContact`, `Can(cap)`, `DeniedReason(cap)`, `ResolveHiveId()`, `Activity: ActivityLog`, `ActivityCountText`, `RecordEvent(ev)`, `Expire()`, `Logout()`, `LogoutCommand`, `LogoutError`.
- `enum PageState`; `abstract TenantPageViewModel` with `Refresh()` / `LoadCore()` / `LoadGeneration` / `Guard()` / `MutatingCommand(cap, run, enabled?)` / `OpenCreate()` / `ConfirmByName()` / `Confirm()` (plain confirm) and bindables `State`, `IsLoading/IsEmpty/IsPopulated/IsError`, `IsDenied` (403), `ErrorText`, `CommandErrorText`, `DeniedReason` (for `protected get PageCapability()`).
- `abstract TenantDialogViewModel<T>` (capability-gated confirm), `NameConfirmDialogViewModel`, `ConfirmDialogViewModel` (title, message, consequences, warning, confirm label).
- `abstract TenantSectionService` (no Key): `Current`, `Present`, `Replace`, `PresentOverRoot`, `Back`, `BackAndRefresh`, `BackCommand`, `BringToFront`, `OnActivated`, `RefreshCurrent`, `OnTenantEvent(ev)` (default: refresh current), `Dialogs`, `Clipboard`; pages implementing `IShownPage` get `OnShown()` / `OnHidden()`.
- `TenantNavigationService extends NavigationService` (side pane forced closed).

- [ ] Step 1: failing tests (section stack + round-trip, page state machine + 401 + 403, session capabilities and denied text, navigation side pane, connection page states incl. Quiet on 503).
- [ ] Step 2: implement; Step 3: gates; Step 4: commit `feat(tenant-portal): mu build, shell core, Connection status section`.

### Task 2: Boot, sign-in, header, live updates, section skeletons

**Files:** `src/shell/tenant-boot.ts`, `login-host-service.ts`, `login-page-view-model.ts`, `live-update-bridge.ts`; `src/login.mu`; header + identity plate template in `shell.resources.mu`; `src/main.ts`; skeleton modules for Overview, Environments, UsersAccess, Releases, Settings (section service + root page with its states, wired into `app.mu` in rail order); the Activity page in Overview.

- Boot decision `TenantBoot.Decide(probe)` -> `Login | Shell`; 401/null -> Login (`BeginLogin`), other failure rethrows (Run shows `login.mu` with "Can't reach the tenant admin service: ...").
- `LoginPageViewModel`: `ErrorText`, `SignInCommand` (BeginLogin), `RetryCommand` (reload).
- `LiveUpdateBridge(nav, session)`: `OnEvent(ev)` records the event, then calls `OnTenantEvent(ev)` on the active section.
- Header: identity plate, `Activity (N)` (opens the Activity page in Overview), email, role, Log out.
- [ ] Tests: boot decision, bridge (records + refreshes only the active section's current page, keeps detail), login VM, activity page rows.
- [ ] Gates; commit `feat(tenant-portal): boot, sign-in, header, live updates, section skeletons`.

### Task 3: Overview + Environments

**Files:** `src/sections/overview/**`, `src/sections/environments/**`.
- Overview page (offer banner, cards, recent activity, connection card, Create environment), Activity page.
- Environments list (filter, selection, bulk Start/Restart/Stop, Create environment dialog with the existing name rules and 409 handling), Environment detail (Start/Stop (confirm)/Restart, Delete (name-to-confirm, consequences), tabs, newer version offered, live logs with Pause/Resume closed when the page hides), deleted-environment event returns to the list.
- [ ] Tests for each VM incl. denied and the delete/stop confirms; gates; commit `feat(tenant-portal): Overview and Environments sections`.

### Task 4: Releases + adopt wizard + Settings

**Files:** `src/sections/releases/**`, `src/sections/settings/**`.
- Releases page (offers with Adopt, what-runs-where, version history), `AdoptWizardPageViewModel` (Version / Environments / Review / Outcome; `SelectTarget` once; outcome texts for 409 / 503 / other), opened from Releases, the Overview banner and environment detail.
- Settings page with three read-only tabs; 403 -> denied.
- [ ] Tests; gates; commit `feat(tenant-portal): Releases, adopt wizard and Settings sections`.

### Task 5: Users & Access: page, Users, Tokens

**Files:** `src/sections/users-access/**` (not `security-model/`).
- `UsersAccessPageViewModel`: environment ComboBox, tab strip, whole-page denied without `access`; tab VMs are `EnvironmentScopedPageViewModel`s receiving the environment.
- Users tab (accounts table, Create account dialog), Account detail page (grants + Revoke with self-warning confirm, Grant role, Disable with self-warning confirm, Issue token), Tokens tab (table, Revoke confirm, Issue token dialog -> `TokenRevealPageViewModel`).
- [ ] Tests incl. Review Focus 3 and self-lockout confirms; gates; commit `feat(tenant-portal): Users & Access users and tokens`.

### Task 6: Users & Access: security-model editor

**Files:** `src/sections/users-access/security-model/**`.
- Editor VM over the kept model classes; Roles / Organization modes, all sub-tabs listed in the spec, one save bar; unsaved-change guard on environment switch and section navigation (`IHoldsPendingWork`).
- [ ] Tests (matrix cycling, add/remove cascades through the VM, save/discard, dirty guard); gates; commit `feat(tenant-portal): security-model editor`.

### Task 7: Delete the old UI; e2e; docs

- Delete `tenant-app.ts`, every `*-view.ts`, `kit/`, `nav-*`, `top-bar.ts`, `user-menu.ts`, `identity-plate.ts`, `environment-card.ts`, `overview-connection-card.ts`, the tree, placeholder and coming-soon views, unused VMs/helpers, and their tests under `tests/`; move surviving tests next to their code.
- Rewrite `tests/tenant-portal.spec.ts` against `tests/fake-tenant-control-plane.ts` (add the ledger route and an OIDC-begin stub): boot to Overview, every rail entry, environment row -> detail -> Back, Create environment dialog opens and cancels, Users & Access tabs, Releases -> Adopt wizard, Log out -> IdP redirect, theme fonts served.
- `admin/README.md` tenant-portal paragraph: `compile:mu` in build.
- [ ] Gates incl. build + e2e; commit `refactor(tenant-portal): remove hand-built shell, kit and imperative screens`.

### Task 8: Whole-branch review, screenshots, report

- Self-review against the spec and rules; fix everything incl. minors. Grep: no `new (TextBlock|StackPanel|Button|Border|Grid|ListBox|TextBox)` under `src/`; LF/ASCII byte-scan of new `.ts`; no import from `admin/portal`.
- Headless dark screenshots of each section against the e2e fake; check legibility.
- Write `docs/superpowers/plans/2026-11-02-tenant-admin-mural-mvvm-report.md`.
