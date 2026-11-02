# Platform Admin on Mural markup + MVVM + EditorShell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `admin/portal` as a Mural-markup MVVM app whose root is a bare `EditorShell` composed from one shell module per section. The screen structure follows `dev-kit/design/admin-apps`, against the unchanged control-plane API.

**Architecture:**
- `login.mu` and `app.mu` are two compiled `.mu` Applications. `main.ts` probes the session and dynamically imports one of them. Logout or a 401 reloads the page.
- `app.mu` registers app-root services: `PortalSessionService`, `ContentHostService`, and `PortalNavigationService -> NavigationService`. It composes eight section modules.
- Each section is a `PortalSectionService` (a page stack presented through `ContentHostService`) with page view-models rendered by implicit-by-type `.mu` DataTemplates.
- Forms run as dialogs through `DialogService`. One-time reveals and the provision wizard are pages.

**Tech Stack:** TypeScript, Mural (`.mu` markup compiled by the Mural CLI, framework shell and services), todl-runtime `Observable`/`ServiceBase`, Vite, node:test via `tsx --test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-platform-admin-mural-mvvm-design.md`. Read it: it is the authority, and its rules section is binding.

## Global Constraints

- All UI is `.mu` markup. No TS code constructs a Visual tree. View-models extend `Observable` (todl-runtime); shell/section services extend `ServiceBase`. A Visual-needing behavior is a Mural Behavior/control, never VM code.
- **Stock Mural only.** No edits under `Mural/`. Subclassing or re-registering a framework service from the app is allowed. If something can't be expressed without a Mural change: STOP and report BLOCKED. Don't work around it with imperative Visual code.
- Backend unchanged. Use `ControlPlaneClient` (`admin/portal/src/api-client.ts`) and the DTOs in `portal-types.ts`. Don't touch `admin/control-plane/`.
- **Secrets.** No secret value on screen except the one-time Owner password and bootstrap/agent token. Each is shown once on a reveal page and gated on an explicit "I've saved it" confirm. After confirm, the value is cleared from the page VM. It is never logged, never in a test name, never kept elsewhere.
- **Observer = denied, not hidden.** Every mutating command's `CanExecute` is false when `PortalSessionService.CanMutate` is false, and the page shows `PortalSessionService.DeniedReason`.
- Irreversible actions (withdraw release, delete client/tenant/hive, revoke) require typing the target's name to confirm.
- Exact vocabulary: Client, Tenant, Hive, Environment, Application, Version/Release, Agent, Adopt, Bootstrap. Never label a tenantId "tenant".
- **Workspace conventions (CLAUDE.md):**
  - OOP: no module-level functions or mutable state.
  - Allman braces in TS.
  - No inline string literals in TS: hoist to `private static readonly` PascalCase constants. `.mu` labels stay inline.
  - Enums over string unions; PascalCase interfaces and public members.
- **Mural DI conventions** (`dev-kit/docs/projects/mural/shell-architecture.md` section 8):
  - `static readonly Key = new ServiceKey<T>('Name')` on concrete leaf services only; abstract bases carry none.
  - Bindable state raises `RaisePropertyChanged`.
- **Layout.**
  - Sections live in `admin/portal/src/sections/<section>/`: `<section>.module.mu`, `<section>.resources.mu`, `*-section-service.ts`, page VMs, and `tests/` beside them.
  - Shared shell code lives in `admin/portal/src/shell/`, with tests in `src/shell/tests/`.
  - Existing top-level `tests/` stay until Task 7 deletes the obsolete ones.
- **Tables** render as `ListBox` with a row `DataTemplate` (a horizontal `Grid`/`StackPanel` of cells). Mural's `DataGrid` is a self-described skeleton with no markup usage anywhere; don't use it.
- New and touched files are LF and ASCII. Byte-scan with python, never trust a `grep` EOL claim. Generated `*.mu.js` are committed, as in Plexus.
- **Gates for every task:**
  - `npm --prefix admin/portal test`: all pass.
  - From `pragmatic-server/`, `npm run typecheck:tools`: exit 0.
  - `npm --prefix admin/portal run build`: succeeds.
- **Git.**
  - Stage by explicit path. Never `git add -A`.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Merge locally ff-only; NEVER push.

## Review Focus

1. **Rail round-trip.** Open a tenant's detail, switch to Hives, come back to Tenants: the tenant detail is shown again, not Hives' page and not the Tenants list. Pinned by Task 1's section test plus Task 3's tenants test.
2. **Observer.** With `CanMutate=false`, every create/edit/delete/publish/withdraw/gate/invite/stand-up command is disabled, executing it never opens a dialog, and the denied reason is bindable. Each section task carries a test.
3. **One-time secret lifetime.** After the reveal is confirmed, the reveal page VM no longer holds the value and the section's current page is the destination page. Leaving through the rail before confirming keeps the reveal as the section's current page. Pinned in Task 3 (Owner password) and Task 5 (bootstrap).
4. **Session expiry.** A 401 from any page's load or command calls `PortalSessionService.Expire()`, which calls the injected reloader exactly once. Pinned in Task 1 (page base) and Task 2 (boot).
5. **Live update.** A control-plane change notification refreshes only the active section's current page and keeps the operator on it (a detail page stays a detail page). Pinned in Task 2.

---

### Task 1: Build plumbing, shell core services, and the Fleet section

**Files:**
- Create:
  - `admin/portal/scripts/compile-mu.mjs`
  - `admin/portal/src/mu-modules.d.ts`
  - `admin/portal/src/shell/portal-session-service.ts`
  - `admin/portal/src/shell/page-reloader.ts`
  - `admin/portal/src/shell/portal-page-view-model.ts`
  - `admin/portal/src/shell/portal-section-service.ts`
  - `admin/portal/src/shell/portal-navigation-service.ts`
  - `admin/portal/src/sections/fleet/fleet.module.mu`
  - `admin/portal/src/sections/fleet/fleet.resources.mu`
  - `admin/portal/src/sections/fleet/fleet-section-service.ts`
  - `admin/portal/src/sections/fleet/fleet-page-view-model.ts`
  - `admin/portal/src/app.mu`
  - generated `*.mu.js`
- Modify: `admin/portal/package.json` (scripts).
- Test:
  - `admin/portal/src/shell/tests/portal-section-service.test.ts`
  - `admin/portal/src/shell/tests/portal-page-view-model.test.ts`
  - `admin/portal/src/shell/tests/portal-navigation-service.test.ts`
  - `admin/portal/src/shell/tests/portal-session-service.test.ts`
  - `admin/portal/src/sections/fleet/tests/fleet-page-view-model.test.ts`

**Interfaces (produced; later tasks rely on these exact names):**
- `enum PageState { Loading, Empty, Populated, Error }` (in `portal-page-view-model.ts`).
- `interface IPageReloader { Reload(): void }` and `class BrowserPageReloader implements IPageReloader`, which calls `window.location.reload()` (in `page-reloader.ts`).
- `class PortalSessionService extends ServiceBase`:
  - Key `'PortalSessionService'`.
  - `Initialize(client: ControlPlaneClient, email: string, operator: OperatorContext, reloader: IPageReloader): void`.
  - Getters: `Client`, `Email`, `RoleLabel`, `CanMutate: boolean`, `DeniedReason: string` (`''` when CanMutate), `ReadOnlyNotice: string` (`''` when CanMutate).
  - `Expire(): void` calls `reloader.Reload()` at most once.
  - `LogoutCommand: RelayCommand` calls `client.Logout()`, then `Expire()`.
  - Check `api-client.ts` for the logout method's exact name.
- `abstract class PortalPageViewModel extends Observable`:
  - Constructor `(session: PortalSessionService)`.
  - `State: PageState`, `ErrorText: string`.
  - `Refresh(): Promise<void>` sets Loading, awaits `protected abstract LoadCore(): Promise<boolean>` (true = has content -> Populated, false -> Empty), and catches errors.
  - On a caught `ApiError` with `Status === ApiError.UnauthorizedStatus` it calls `session.Expire()`; otherwise it sets `Error` and `ErrorText`.
  - `protected Guard(action: () => Promise<void>): Promise<void>` applies the same 401/error handling to commands.
- `abstract class PortalSectionService extends ServiceBase implements IActivatable` (no Key):
  - `Current: Observable | undefined`.
  - `protected abstract CreateRoot(): PortalPageViewModel`.
  - `Present(page: Observable): void` pushes the page, sets `Current`, `ContentHostService.View(page)`, and calls `page.Refresh()` if it is a `PortalPageViewModel`.
  - `Back(): void` pops to the previous page and re-views it. At the root it is a no-op.
  - `BackCommand: RelayCommand`.
  - `OnActivated(): void`: first activation creates and presents the root; later activations re-view `Current` without reloading.
  - `RefreshCurrent(): Promise<void>` refreshes `Current` if it is a `PortalPageViewModel`.
  - Protected `Session` resolves `PortalSessionService.Key`.
- `class PortalNavigationService extends NavigationService`:
  - Its constructor calls `PopulateFromModules()`, then selects the first destination.
  - Overrides `syncActiveService` and `onDestinationActivated` to call `super` and then force `SidePaneVisible = false`.
- `class FleetSectionService extends PortalSectionService`, Key `'FleetSectionService'`. `class FleetPageViewModel extends PortalPageViewModel` wraps the existing `FleetViewModel` / `fleet-presentation.ts` data (summary counts, needs-attention items, hives rows) as bindable getters.

- [ ] **Step 1: Write the failing shell tests.**
  - A `ServiceProvider` (from `@pragmatic-tech-ai/mural/runtime`) registers a real `ContentHostService` and a `PortalSessionService` initialized with a fake client, operator context and fake reloader. A test `TestSection extends PortalSectionService` creates a stub page.
  - Assertions:
    - `OnActivated()` twice: `CreateRoot` runs once, and `ContentHostService.Content` is the root.
    - `Present(detail)`, then a different section's `OnActivated`, then this section's `OnActivated` again: Content is `detail` (Review Focus 1).
    - `Back()` from detail returns Content to the root. `Back()` at the root leaves it.
    - Page base:
      - `LoadCore` returning false -> `State === PageState.Empty`.
      - `LoadCore` throwing `new ApiError(401, ...)` -> the fake reloader's count is 1. Calling `Expire()` again keeps it at 1.
      - A non-401 throw -> `State === PageState.Error` and `ErrorText` equals the error message.
    - Session:
      - `CanMutate` false -> `DeniedReason !== ''` and `ReadOnlyNotice !== ''`.
      - `CanMutate` true -> both `''`.
      - `LogoutCommand.Execute()` -> the fake client's logout was called and the reloader fired once.
    - Navigation: the subclass with two fake capabilities selects the first. After `SelectedItem` changes and after `onDestinationActivated` is invoked twice on the same destination, `SidePaneVisible === false`.
- [ ] **Step 2: Run the tests; they fail.** Run `npm --prefix admin/portal test`. Expected: FAIL on missing modules.
- [ ] **Step 3: Implement the shell classes to the interfaces above.**
  - Build plumbing: copy Plexus's `apps/plexus/scripts/compile-mu.mjs` approach into `admin/portal/scripts/compile-mu.mjs`. Resolve `node_modules/@pragmatic-tech-ai/mural/dist/tooling/cli.js` app-locally and compile `src/**/*.mu`.
  - In `package.json`, add `"compile:mu": "node scripts/compile-mu.mjs"` and make `dev`, `build`, `test` and `typecheck` run it first (prefix the commands or use `pre*` scripts).
  - `mu-modules.d.ts` declares `module '*.mu.js'` with `export const app: Application` (the type from `@pragmatic-tech-ai/mural/runtime`) and a default export of `unknown`.
- [ ] **Step 4: Fleet section.**
  - `fleet-page-view-model.test.ts` with a fake client returning two hives (one needing attention) asserts: State Populated, the summary count values, the needs-attention list length 1, and rows length 2. An empty fleet -> State Empty.
  - Implement `FleetPageViewModel` and `FleetSectionService`.
  - `fleet.module.mu`: `shell module FleetModule [ Name = "Fleet" ] { .services: { FleetSectionService } Capability [ Name = "Fleet", ServiceKey = FleetSectionService ] resources: { merge FleetResources } }`.
  - `fleet.resources.mu` provides:
    - A `DataTemplate [DataType = FleetPageViewModel]`: a page header (title "Fleet", subtitle "Every hive, read from its last check-in. Exceptions first."), summary counts, a Needs-attention list, and the hives table as `ListBox` + row template.
    - State presentation via `Visibility` bound to State: a Loading text, an Empty text, and `ErrorText`.
    - An empty `DataTemplate [DataType = PortalSectionService]` (an empty `Border`), so the hidden side pane never shows the "can not resolve template" diagnostic.
  - Rail icons are not required.
- [ ] **Step 5: `app.mu`.**
  - `Application [ Theme = Pragmatic, Scheme = PragmaticLight ] { .services: { PortalSessionService ContentHostService PortalNavigationService -> NavigationService } .modules: { FleetModule } resources: { EditorShell x:root { } } }`.
  - Not yet wired into `main.ts` (Task 2 does that). The old app still boots.
- [ ] **Step 6: Run all gates; they pass.** Byte-scan the new files (LF/ASCII).
- [ ] **Step 7: Commit** by explicit paths (sources, tests, generated `.mu.js`, `package.json`, the script): `feat(portal): mu build, shell core services, Fleet section`.

### Task 2: Boot, login, header, live updates

**Files:**
- Create:
  - `admin/portal/src/shell/login-page-view-model.ts`
  - `admin/portal/src/login.mu`
  - `admin/portal/src/shell/shell.resources.mu` (header template)
  - `admin/portal/src/shell/live-update-bridge.ts`
- Modify:
  - `admin/portal/src/main.ts`
  - `admin/portal/src/app.mu` (merge shell resources; `EditorShell x:root [ HeaderContent = ContentControl [ Content = $service(PortalSessionService) ] ]`)
- Test:
  - `src/shell/tests/login-page-view-model.test.ts`
  - `src/shell/tests/live-update-bridge.test.ts`
  - `src/shell/tests/portal-main-boot.test.ts`

**Interfaces:**
- Consumes (Task 1): `PortalSessionService`, `PortalSectionService.RefreshCurrent`, `PortalNavigationService.ActiveService`, `IPageReloader`.
- Produces:
  - `class LoginPageViewModel extends Observable`. Constructor `(client: ControlPlaneClient, reloader: IPageReloader)`. Members: `Email`, `Password`, `ErrorText`, `IsBusy`, `LoginCommand`. On success -> `reloader.Reload()`. On failure -> `ErrorText` = the error message, and the Password is cleared.
  - `class LoginHostService extends ServiceBase`, Key `'LoginHostService'`, exposing `Page: LoginPageViewModel` (constructed with a `new ControlPlaneClient()` and a `BrowserPageReloader`). `login.mu`'s root binds `DataContext = $service(LoginHostService).Page`.
  - `class LiveUpdateBridge`. Constructor `(nav: NavigationService)`. `OnChanged(): Promise<void>` calls `RefreshCurrent()` on `nav.ActiveService` when it is a `PortalSectionService`.
  - `class PortalBoot`, with static `Run(): Promise<void>` in `main.ts`, replacing `PortalMain`:
    - Probes the session with `new ControlPlaneClient()`.
    - No session (401): `await import('./login.mu.js')` and mounts its `app` on `new HtmlTarget(root)` via `app.initialize(target)`.
    - Session: imports `./app.mu.js`, resolves `PortalSessionService` from `app.Services`, calls `Initialize(client, email, OperatorContext.FromWire(role), new BrowserPageReloader())`, subscribes the client's change notifications to a `LiveUpdateBridge`, sets Compact density, then mounts.
    - Keep the existing `PortalMain` structure and constants style.

- [ ] **Step 1: Failing tests.**
  - Login VM:
    - Successful fake login -> reloader count 1.
    - Failing login -> `ErrorText` is the error message, Password is `''`, reloader count 0.
    - `LoginCommand.CanExecute()` is false while `IsBusy` or while Email/Password is empty.
  - Bridge: the active service is a test `PortalSectionService` whose current page is a detail page VM. `OnChanged()` -> that detail page's refresh count +1, an inactive section's page count unchanged, and Content still the detail page (Review Focus 5).
  - Boot: make the session-probe decision a static method `PortalBoot.Decide(probe: () => Promise<unknown>): Promise<BootTarget>` with `enum BootTarget { Login, Shell }`. Assert a 401 probe -> `Login`, a success -> `Shell`, and a 500 rethrows.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - Header template in `shell.resources.mu`, `DataTemplate [DataType = PortalSessionService]`: "Platform Admin", `$Email`, `$RoleLabel`, `$ReadOnlyNotice` (collapsed when empty), and a "Log out" button bound to `$LogoutCommand`.
  - The login template: Email box, Password box (masked; use the stock password mode of `TextBox` if present, else BLOCKED), a "Log in" button bound to `$LoginCommand`, and `$ErrorText`.
  - Delete `src/login-view.ts` only in Task 7.
- [ ] **Step 4: Gates pass.** Then manually start the control plane per `admin/README.md` and confirm login -> shell with the Fleet section -> Log out returns to login. Note the result in the report.
- [ ] **Step 5: Commit:** `feat(portal): boot into mu login/shell, header, live updates`.

### Task 3: Clients, Tenants, Hives sections (with their create/delete flows)

**Files:** `admin/portal/src/sections/{clients,tenants,hives}/`: module, resources, section service, page VMs, `tests/`. Modify `app.mu` (`.modules:` add `ClientsModule TenantsModule HivesModule` after `FleetModule`).

**Interfaces:**
- Consumes: Task 1 base classes; `DialogService` (`Show(options: DialogOptions)` / `Close(result)`, from `@pragmatic-tech-ai/mural/framework`); the existing `create-*-view-model.ts`, `*-detail-view-model.ts`, `*-list`/`clients`/`tenants`/`hives` VMs (reuse or reshape them; delete any left unused in Task 7).
- Produces:
  - `ClientsSectionService`, `TenantsSectionService`, `HivesSectionService`: Keys equal to their class names.
  - Page VMs: `ClientsPageViewModel` / `ClientDetailPageViewModel`, `TenantsPageViewModel` / `TenantDetailPageViewModel` / `OwnerPasswordRevealPageViewModel`, `HivesPageViewModel` / `HiveDetailPageViewModel`.
  - Dialog VMs: `NewClientDialogViewModel`, `NewTenantDialogViewModel`, `NewHiveDialogViewModel`, `NameConfirmDialogViewModel` (`Expected: string`, `Typed: string`, `IsMatch: boolean`).
  - `HivesPageViewModel.StandUpCommand` exists but is disabled until Task 5.

- [ ] **Step 1: Failing tests** (fake client, real `ContentHostService`, fake `DialogService` stand-in registered under `DialogService.Key` recording `Show` calls and returning a scripted result).
  - **Clients:**
    - The list loads rows.
    - `OpenCommand(row)` presents `ClientDetailPageViewModel` for that id.
    - `NewCommand` -> `DialogService.Show` called with a `NewClientDialogViewModel`. On a scripted confirm, `CreateClient(id, displayName, subscriptionRef?)` is called and the list refreshes.
  - **Tenants:**
    - New tenant passes `ownerEmail` through `CreateTenant(id, clientId, displayName, ownerEmail)`.
    - On success the section presents `OwnerPasswordRevealPageViewModel`, whose `Value` is the returned `owner.password` and whose `Email` is `owner.email`.
    - `ConfirmSavedCommand` is disabled until `Saved = true`. Executing it sets `Value` to `''` and presents the new tenant's detail (Review Focus 3).
    - The tenant detail shows the hive binding and the observed environments read-only (no commands on that panel's VM).
    - Rail round-trip keeps the tenant detail (Review Focus 1).
  - **Hives:** list -> detail. Credentials are exposed only as name/status (assert no property on the row VM holds a token value). New hive goes through a dialog.
  - **Delete (client, tenant, hive):** opens `NameConfirmDialogViewModel`. A mismatched `Typed` keeps the confirm disabled. A match calls the delete and returns to the list.
  - **Observer:** with `CanMutate=false`, every New/Delete command `CanExecute()` is false and executing does not call `DialogService.Show` (Review Focus 2).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement the VMs, section services, and `.mu` templates.**
  - Each list page has a header with its one primary action, a `ListBox` table, and state presentation.
  - Detail pages have a Back button bound to the section's `BackCommand`.
  - Dialog templates are keyed by dialog-VM type.
  - The reveal page template shows the value with a Copy button, an "I've saved it" `CheckBox` bound to `$Saved`, and the confirm button.
  - Tenant id field hint: "Tenant id (lowercase a-z, 0-9, -)".
- [ ] **Step 4: Gates pass.**
- [ ] **Step 5: Commit:** `feat(portal): Clients, Tenants, Hives sections`.

### Task 4: Registry & Releases, Release Policy, Activity, Settings

**Files:** `admin/portal/src/sections/{releases,release-policy,activity,settings}/` (module, resources, section service, page VMs, tests). Modify `app.mu` to add the four modules, in this rail order after Hives: Releases, ReleasePolicy, Activity, Settings.

**Interfaces:**
- Consumes: Task 1 and Task 3 patterns (`NameConfirmDialogViewModel`); the existing `releases-view-model.ts`, `release-detail-view-model.ts`, `create-manifest-view-model.ts`, `release-policy-view-model.ts`, `activity-view-model.ts`, `settings-view-model.ts`, `create-operator-view-model.ts`.
- Produces: `ReleasesSectionService`, `ReleasePolicySectionService`, `ActivitySectionService`, `SettingsSectionService` (Keys = class names), with their page and dialog VMs (`PublishDialogViewModel`, `PolicyEditDialogViewModel`, `InviteOperatorDialogViewModel`).

- [ ] **Step 1: Failing tests.**
  - **Releases:**
    - List -> detail.
    - Publish via dialog calls the existing publish client method with the dialog's fields.
    - Withdraw requires name-confirm and records the reason.
  - **Release Policy:** per-tenant view; edit via dialog saves through the existing policy client method; gate/ungate; the adoption ledger rows load.
  - **Activity:** audit list -> entry detail; Empty state when there are no entries.
  - **Settings:** Profile shows the session email and role; the operator roster loads; Invite opens a dialog and calls the existing invite/create-operator client method.
  - **Observer:** Publish/Withdraw/Edit policy/Gate/Invite are all disabled and never open a dialog.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement the VMs, services and templates.** Same page conventions as Task 3.
- [ ] **Step 4: Gates pass.**
- [ ] **Step 5: Commit:** `feat(portal): Releases, Release Policy, Activity, Settings sections`.

### Task 5: Stand up a hive (provision wizard page)

**Files:** `admin/portal/src/sections/hives/provision-wizard-page-view-model.ts` + its template in `hives.resources.mu` + `tests/provision-wizard-page-view-model.test.ts`. Modify `HivesPageViewModel` to enable `StandUpCommand`.

**Interfaces:**
- Consumes: the existing `provision-wizard-view-model.ts` (steps, validation, `ProvisionInputDto`, `client.Provision`). Reuse its logic; the new page VM wraps it or replaces it.
- Produces: `ProvisionWizardPageViewModel extends PortalPageViewModel` with:
  - `StepIndex`, `StepLabels`
  - `NextCommand`, `BackStepCommand`, `SubmitCommand`
  - reveal state: `OwnerPassword`, `AgentToken`, `OwnerSaved`, `AgentSaved`, `FinishCommand`

- [ ] **Step 1: Failing tests.**
  - `NextCommand` is disabled until the current step validates.
  - `SubmitCommand` calls `Provision` once even if executed twice while in flight.
  - On success: the reveal state holds both secrets, and `FinishCommand` is disabled until both saved flags are true.
  - Finish clears both values and presents the new hive's detail (Review Focus 3).
  - A provision error keeps the operator on the last step with `ErrorText` set.
  - Observer: `StandUpCommand` is disabled.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** The wizard is a page presented by `HivesSectionService`. Back/Next live inside the page template, with a step indicator listing `StepLabels`.
- [ ] **Step 4: Gates pass.**
- [ ] **Step 5: Commit:** `feat(portal): Stand up a hive wizard page`.

### Task 6: Switch-over audit (MVVM purity + rules)

**Files:** No new feature files. Fixes only, in any `src/shell/**` or `src/sections/**` file.

- [ ] **Step 1: Check the new code for MVVM and rule violations.**
  - From `admin/portal`, `grep -rn "new \(TextBlock\|StackPanel\|Button\|Border\|Grid\|ListBox\|TextBox\)" src/shell src/sections` must return nothing.
  - Every `RelayCommand` that mutates includes `CanMutate` in its guard.
  - No page or dialog VM keeps a secret after confirm.
  - No `tenantId` is labelled "tenant" in any `.mu`.
- [ ] **Step 2: Fix whatever was found.** Gates pass.
- [ ] **Step 3: Commit** if anything changed: `fix(portal): MVVM/rules audit`.

### Task 7: Delete the old UI, update e2e and docs

**Files:**
- Delete:
  - `admin/portal/src/app.ts`, `nav-rail.ts`, `nav-model.ts`, `top-bar.ts`, `section-container-view.ts`, `portal-view-base.ts`, `login-view.ts`, `coming-soon-view.ts`
  - every `*-view.ts`
  - the environment/graph/promote VMs and views
  - VMs no section uses
  - `kit/` modules no longer imported
  - their tests under `admin/portal/tests/`
- Modify: `admin/portal/tests/portal.spec.ts` (Playwright), `admin/README.md` (portal build note: `npm --prefix admin/portal run build` now runs `compile:mu`).

- [ ] **Step 1: Delete the old files.** Use `git rm` by explicit path, and confirm nothing in `src/` imports a deleted file (typecheck proves it).
- [ ] **Step 2: Rewrite `portal.spec.ts`** to drive the new structure against its existing fake/served setup:
  - log in
  - the Fleet page renders
  - the Tenants rail entry -> a tenant row -> its detail -> Back
  - New client dialog opens and Cancel closes it
  - Log out -> the login page
  - Keep it gated exactly as today (not part of `npm test`). Run it if browsers are installed, and report the result either way.
- [ ] **Step 3: Gates pass.** Rebuild the bundle, restart the control plane, and click through every section once in a browser. Note any section that fails to render in the report.
- [ ] **Step 4: Commit:** `refactor(portal): remove hand-built shell and imperative screens`.

## Final verification (whole branch)

- `npm --prefix admin/portal test`: all pass. `npm run typecheck:tools` (from `pragmatic-server/`): exit 0. `npm --prefix admin/portal run build`: succeeds.
- No file under `admin/portal/src/` outside generated `*.mu.js` constructs a Visual. No `admin/control-plane/` changes on the branch (`git diff --stat master...HEAD -- admin/control-plane` is empty), and the separate Mural repo has no new changes (`git -C ../Mural status --short` matches its state before Task 1, recorded in the ledger).
- Every touched file is LF/ASCII (python byte-scan).
