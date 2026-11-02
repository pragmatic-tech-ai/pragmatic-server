# Tenant Admin on Mural markup + MVVM + EditorShell

**Status:** design, 2026-11-02. Approved direction from Eugene ("rebuild the Tenant Admin the way we did the Platform Admin"); calls marked *(my call)* are the builder's and open to correction.
**Scope:** the Tenant Admin web app (`admin/tenant-portal`). It mirrors the Platform Admin rebuild (`2026-11-02-platform-admin-mural-mvvm-design.md`) for the tenant side of the trust boundary. The two apps stay separate: no file in one imports from the other.

## Intent

The Tenant Admin works, but its UI is hand-built TypeScript: a custom shell (`TenantApp` extends StackPanel, `NavRail`, `TopBar`, a hand-rolled dialog host and drawer), imperative screens that construct Visual trees in code (`*-view.ts`, `src/kit/`), and an `ITenantNavigator` that swaps whole screens. Rebuild it the way the Platform Admin now is:

- **All UI in Mural markup** (`.mu`).
- **MVVM:** views are templates bound to view-models; no TS code builds Visual trees.
- **The framework shell:** `EditorShell` as the application root, composed from one module per section.

The screen structure (sections, pages, navigation, what each screen shows) follows the admin-apps design in `dev-kit/design/admin-apps/` (`prototypes/tenant.html`, `src/tenant.jsx`, `src/tenant2.jsx`). Visual fidelity is a later pass.

Success: the app is an `.mu` `Application` whose root is a bare `EditorShell` in the dark scheme. Each section is a module. Every screen is a DataTemplate over a view-model. The old imperative shell, screens and kit are gone. Everything the current app does still works, against the same backend, except what is listed under Dropped with its evidence.

## Goals

1. **Composition like the Platform Admin.** `app.mu` declares `Application [ Theme = Pragmatic, Scheme = PragmaticDark ] { .services: {...} .modules: {...} resources: { ... EditorShell x:root [ HeaderContent = ... ] { } } }`. The shell takes no body children; its regions bind to services through `$service(...)`.
2. **One shell module per section**, in the design's rail order (what a client owns): **Overview, Environments, Users & Access, Releases, Settings, Connection status.** Each module contributes one `Capability` (Name, Icon, ServiceKey), registers its section service in `.services:`, and merges its DataTemplates from a `resources` dictionary. Rail icons come from an app-level icon dictionary; the rail item style adds a tooltip naming the section (as in the Platform Admin).
3. **Pages full-width in the content region** through `ContentHostService.View(...)`, with the side pane hidden by an app `NavigationService` subclass (the stock one forces `SidePaneVisible`). Each section owns a small page stack (list -> detail -> ...), re-presents its current page on activation and quietly reloads it.
4. **Strict MVVM.** View-models extend `Observable` (todl-runtime); section and shell services extend `ServiceBase`. Views are implicit-by-type DataTemplates; table rows and list items use explicit keyed `ItemTemplate`s (a ListBox only resolves implicit templates for MuralBase items). Navigation is a view-model call on a section service.
5. **Dialogs through the shell's `DialogService`** for create forms, confirms and pickers, each with its own view-model and template. **One-time secret reveals and wizards are pages**, not dialogs: a dialog closes on Escape and can't hold a reveal open until "I've saved it".
6. **Backend unchanged.** The app talks only to `/tenant-auth/*` and `/tenant-api/*` through the existing `TenantApiClient`, with the DTOs in `tenant-types.ts`. No new route or field is invented; where the design shows something the API doesn't serve, it is left out and listed under Dropped.

## Sections, pages and flows

| Section | Pages / flows | API |
| --- | --- | --- |
| **Overview** (home) | Overview page: Create environment (dialog); the newer-version offer banner with Review and adopt (opens the adopt wizard in Releases); environment cards (open the environment's detail in Environments); Recent activity (5, with See all); the connection card (opens Connection status). Activity page: the session's observed events, newest first. | `ListEnvironments`, `GetHealth`, `ListManifests`, `GetRollout`, `ListHives` |
| **Environments** | List: filter, table (select, name, status, version, health, live URL), bulk Start/Restart/Stop, Create environment (dialog). Detail: header (status, health, Start/Stop/Restart, Delete with name-to-confirm), tabs Application & version (incl. the newer version offered, Review and adopt), Health & activity (health, this environment's activity, live logs with Pause/Resume), Access (addresses). | `ListEnvironments`, `GetHealth`, `Start/Stop/RestartEnvironment`, `CreateEnvironment`, `DeleteEnvironment`, `OpenLogStream`, `ListManifests`, `GetRollout` |
| **Users & Access** | One page, tabs **Users / Roles & permissions / Tokens**, each over an environment picked in an Environment ComboBox. Users: accounts table, Create account (dialog), account detail page (grants with Revoke, Grant role, Disable, Issue token). Tokens: tokens table with Revoke (confirm), Issue token (dialog) -> one-time token reveal page. Roles & permissions: the security-model editor (below). Whole-page denied state without the Manage users & access permission. | `ListEnvironments`, `GetAdminSnapshot`, `CreateAccount`, `DisableAccount`, `GrantRole`, `RevokeRole`, `ListTokens`, `IssueToken`, `RevokeToken`, `GetSecurityModel`, `SetSecurityModel` |
| **Releases** | Releases page: offer cards (Adopt), what runs where (environment x version), version history (ledger). Adopt wizard page: Version, Environments (informational: adopt targets the whole hive), Review, Outcome. | `ListManifests`, `GetRollout`, `ListEnvironments`, `ListLedger`, `SelectTarget` |
| **Settings** | Read-only page, tabs Hive & domain, Tenant profile, Identity provider (credentials by reference: Configured / Not configured). | `Profile`, `ListHives` |
| **Connection status** | Read-only: Connected / Quiet (503) / no hive / denied (403), the outbound-only explanation, target version and what each environment runs. | `ListHives`, `GetRollout` |
| **Header** | Identity plate (organisation / tenant / hive; fixed, no switcher), Activity (N) (opens the Activity page), signed-in email and role, Log out. | `Session`, `Profile`, `Logout` |
| **Sign-in** | No session: redirect to the tenant IdP (`BeginLogin`), as today. A failed session probe (not a 401) shows a sign-in page with the reason, Sign in and Try again. | `Session`, `BeginLogin` |

### The security-model editor (Users & Access > Roles & permissions)

The existing UI-free model classes are kept and driven from new view-models: `SecurityModelViewModel`, `SecurityModelDraft`, `SecurityModelOrg`, `RoleAssignmentSection` / `ProfileAssignmentSection`, `RecordSharingDeriver`, `RoleHoldersDeriver`, the enums and the row adapters. Structure, as today:

- Mode tabs **Roles | Organization**. Roles: role list (select, add, delete), sub-tabs **What they can do** (concept x 8-action privilege matrix, a cell cycles None -> User -> Business unit -> Business unit and children -> Organization, plus the plain sentence and Add concept), **Fields** (field profiles, secured-field grid with Read/Update/Create, add/remove, who has this profile), **Record sharing** (derived, read-only), **People** (role holders: by person, by claim, by team). Organization: **Business units** (rename, parent, remove, add; cycles refused), **Teams**, **Membership** (claim rules, per-person overrides), **Ownership rules**.
- One draft, one dirty flag, one save bar (Discard / Save) for the whole model. Save PUTs the model and rebases the draft. Edits are ignored while busy. Switching environment with unsaved changes asks first *(my call: today it silently discards; the design warns before losing work)*.

## Rules carried from the design and the current app

- **No secret values on screen** except the one-time issued token value, shown once on a reveal page and gated on "I've saved it" before leaving. It lives only on the reveal page VM, is cleared on confirm, and is never logged. Passwords typed into Create account are input, never echoed back. IdP credentials show only as Configured / Not configured.
- **Denied, not hidden.** A command needing a permission the profile lacks is visible, disabled, and the page shows why: "Needs the Manage environments permission. Ask <owner contact>." Capabilities: Manage environments (`envs`), Adopt versions (`adopt`), Manage users & access (`access`), Manage tenant settings (`settings`, unused: Settings is read-only). An unreadable profile is permissive (the server is the gate), as today. Environment detail's Start/Stop/Restart/Delete are now gated by `envs` like every other environment command *(my call: today they are ungated; the design gates them)*.
- **Irreversible actions need the name typed to confirm** (delete environment). Disable account, revoke token, stop environment and self-affecting actions (disable yourself, revoke your own grant) get a plain confirm with consequences; self-affecting ones carry the lockout warning.
- **Every screen handles loading, empty, populated and error**; a 403 shows the denied state where the API can answer 403 (Settings, Connection, Users & Access, security model).
- **Exact vocabulary:** Tenant, Hive, Environment, Application, Version/Release, Adopt.

## Session and live updates

- **Boot** (`TenantBoot`): probe `Session()`. No session (null or 401): `BeginLogin()`, which navigates to the IdP, exactly as today (the control-plane login smoke relies on the auto-redirect). Probe failure: import `login.mu.js` and show the reason. Session: read `Profile()` (failure -> undefined, permissive), import `app.mu.js`, initialize `TenantSessionService`, subscribe to events, refresh the active section, mount.
- **Log out**, or a 401 from any later call: the page reloads, which lands on the IdP redirect. No service or view-model carries one session into the next.
- **Live updates:** every tenant event is recorded in the session's activity log, then the active section handles it: by default it reloads its current page; Environments drops back to the list when the open environment was deleted.
- **Live logs** stream only while the environment detail's logs panel is open and the page is shown; leaving the page closes the socket.

## Dropped (each with evidence)

- **Hive detail** (`hive-detail-view.ts`): unreachable today; its only opener is `ShowHiveDetail`, called only from the unmounted `TenantTreeView`. Its one action (target a version, including rolling back) is the Releases adopt flow, which offers every non-withdrawn, non-current version.
- **The "My Hives" tree** (`tenant-tree-view*.ts`) and `placeholder-root-view.ts`: never mounted by `TenantApp`.
- **Coming-soon fallback**: Overview and Releases without a hive show their own empty state instead.
- **Design parts the API does not serve:** Updated by Pragmatic / Pragmatic components list, check-in history and the 24 h health strip, pods and active users, Deploy UI bundle, OIDC client credential rotation, IdP credential rotate/revoke, tenant profile Edit, per-environment adopt selection and per-step rollout progress (adopt targets the whole hive through `SelectTarget`), user names / last sign-in / enable account, per-user role dialog semantics beyond grant/revoke, global search, Operations drawer, density toggle, keyboard shortcuts, the security-model self-lockout prediction on save.
- **Visual fidelity**: paper sidebar with labels and badges, pills with icons, cards grid styling. Stock EditorShell chrome now; fidelity later.

## Kept

- `TenantApiClient`, `tenant-types.ts`, `ActivityLog`, `EnvironmentRow`, and the UI-free view-models and helpers listed above, reused or reshaped where they fit; a helper kept only because it exists is deleted.
- The status vocabulary in `kit/pill-kinds.ts` moves out of `kit/` as plain label/tone data (no Visual types) if still used.

## Constraints

- **Stock Mural only.** No changes to the Mural repo. Subclassing or re-registering a framework service from the app is allowed. Known pitfalls are worked around in the app and noted: ListBox implicit row templates need MuralBase rows (explicit ItemTemplate per table); a bare ItemsControl filled after first layout renders nothing (use ListBox); a realized ComboBox ignores in-place collection changes (replace the collection instance and raise the property); NavigationService forces the side pane (subclass); compile-mu realpaths the CLI; theme fonts need the ThemeFontCopy Vite plugin.
- **Workspace conventions:** OOP, no module-level functions or mutable state; Allman braces; PascalCase public members and interfaces; no inline string literals in TS (`.mu` labels may stay inline); enums over string unions; view-models extend `Observable`; tests in `tests/` subfolders; new `.ts` ASCII + LF (generated `*.mu.js` exempt, committed).
- **Build:** `compile:mu` runs before `dev`, `build`, `test` and `typecheck`. The test glob covers `src/**/tests/*.test.ts`.
- **Tests:** view-models and services unit-tested with node:test; `npm --prefix admin/tenant-portal test`, `run typecheck`, `run build`, root `npm run typecheck:tools` pass; the Playwright spec is rewritten for the new UI against the existing fake tenant control plane (gated, not part of `npm test`).
- **Delivery:** branch in a worktree, commit per task, never merge or push.
