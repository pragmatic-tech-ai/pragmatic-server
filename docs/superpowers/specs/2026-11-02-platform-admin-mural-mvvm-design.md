# Platform Admin on Mural markup + MVVM + EditorShell

**Status:** design, 2026-11-02. Approved direction from Eugene in conversation; calls marked *(my call)* are the designer's and open to correction.
**Scope:** the Platform Admin web app (`admin/portal`). The Tenant Admin (`admin/tenant-portal`) follows later on the same pattern, as a separate spec.

## Intent

The Platform Admin works and is being smoke-tested, but its UI is hand-built TypeScript: a custom shell (`App` extends StackPanel, `NavRail`, `TopBar`), imperative screens that construct Visual trees in code, and an `IPortalNavigator` that swaps whole screens. It doesn't follow the architecture every other Mural app in the workspace uses, so it can't reuse the framework's shell, services or templates, and every new screen adds more hand-wired code.

Rebuild it the way the Mural TS demo platform (`Mural/demo/platform/`) and Plexus are built:
- **All UI in Mural markup** (`.mu`).
- **MVVM:** views are templates bound to view-models; no TS code builds Visual trees.
- **The framework shell:** `EditorShell` as the application root, composed from modules.

The screen structure (sections, screens, flows and states) follows the admin-apps design in `dev-kit/design/admin-apps/`.

Success: the app is an `.mu` `Application` whose root is a bare `EditorShell`. Each section is a module. Every screen is a DataTemplate over a view-model. The old imperative shell and screens are gone. The app does everything the current one does except the parts explicitly dropped below, against the same backend.

## Goals

1. **Composition like the demo platform.** `app.mu` declares `Application [ Theme = Pragmatic, Scheme = PragmaticLight ] { .services: {...} .modules: {...} resources: { ... EditorShell x:root { } } }`. The shell takes no body children; its regions bind to services through `$service(...)`.
2. **One shell module per section.** Each module contributes one `Capability` (rail entry: Name, Icon, ServiceKey), registers its services in `.services:`, and carries its DataTemplates in a `resources` dictionary. Sections, in rail order, per the design's IA:
   - Fleet
   - Clients, Tenants, Hives
   - Registry & Releases, Release Policy
   - Activity
   - Settings
3. **Screens follow the design's structure.** Each section shows its page full-width in the content region (`ContentHostService.View(...)`), as in the design: list pages with a table, detail pages reached from a row with a way back, one primary action in the page header. The left side pane stays hidden *(my call: the design has no list-in-side-pane; the demo's side-pane list is the demo's content, not a pattern the design asks for)*.
   - The stock `NavigationService` forces `SidePaneVisible` true on every rail selection (`syncActiveService`, `onDestinationActivated`). So the app registers its own `NavigationService` subclass that keeps it false, using the documented register-your-own override. EditorShell skips its default when `NavigationService.Key` is already registered.
   - Overriding a framework service from the app is ordinary framework use, not a Mural change *(my call)*.
   - Each section re-presents its current page on activation (`IActivatable.OnActivated`).
4. **Strict MVVM.**
   - Views are `.mu` DataTemplates keyed by view-model type (implicit-by-type), bound with `$Prop` / `$service(...)`.
   - Each view-model extends `Observable` (todl-runtime) and exposes bindable state plus commands. Shell-region services extend the framework's `ServiceBase`.
   - No view-model constructs Visuals. Behavior that needs a Visual goes in a Mural Behavior or control.
   - Navigation between screens is a view-model call (a section service presenting the next view-model), never a view swapping itself.
5. **Dialogs through the shell.** Create forms, confirms, publish, invite and similar flows open through the shell's `DialogService`, each with its own view-model and `.mu` template.
   - **Exception: one-time secret reveals and the provision wizard are content pages, not dialogs.** Stock dialogs always close on Escape and the title-bar X, so they can't hold a reveal open until "I've saved it". The design itself draws Stand up a hive as a page with steps.
   - When New tenant succeeds, the dialog closes and the Tenants section presents the Owner-password reveal page. It returns to the tenant only after the operator confirms *(my call)*.
6. **Backend unchanged.** The app talks to the control plane's existing `/api/*` routes and events socket through the existing `ControlPlaneClient` (`api-client.ts`). The control plane serves `admin/portal/dist` exactly as today.

## Screens and flows to carry over

Every behavior the current app has, except what's dropped below, moves to the new structure:

| Section | Screens / flows |
| --- | --- |
| **Fleet** (home) | Summary counts, Needs-attention list, hives table with health; opens a hive. |
| **Clients** | List; client detail; New client (dialog). |
| **Tenants** | List; tenant detail with its hive binding and the observed, read-only environment panel; New tenant (dialog: client, id, display name, Owner email). The Owner's one-time password is shown once on success. |
| **Hives** | List; hive detail (credentials by name/status only, rollout state); New hive (dialog); Stand up a hive: the provision wizard, multi-step, ending in a shown-once bootstrap reveal. |
| **Registry & Releases** | Releases list; release detail; Publish (dialog); Withdraw (name-to-confirm). |
| **Release Policy** | Per-tenant policy view and edit; gate / ungate; adoption ledger. |
| **Activity** | Audit log list; entry detail. |
| **Settings** | Profile; operator roster; invite operator (dialog). |
| **Login** | Email + password, before the shell is shown. |

## Rules carried from the design and the current app

These are behavior, not styling, so they apply now:
- **No secret values on screen.** The only exceptions are one-time values (Owner password, bootstrap/agent token), each shown once and gated on "I've saved it" before leaving. They live only in the reveal view, never on a view-model field that outlives the reveal, and are never logged.
- **Platform Admin only observes tenant data.** Tenant environments appear read-only with no commands.
- **Irreversible actions need the name typed to confirm** (withdraw, delete, revoke).
- **Denied, not hidden.** An Observer (read-only operator) sees mutating commands disabled, with the reason, plus a read-only notice in the header. Enablement comes from the operator context the session returns (`OperatorContext.CanMutate`).
- **Every screen handles loading, empty, populated and error.** Denied is covered by the disabled commands above.
- **Exact vocabulary:** Client, Tenant, Hive, Environment, Application, Version/Release, Agent, Adopt, Bootstrap.

## Session and live updates

- **Boot.** A compiled `app.mu.js` builds its Application, modules and shell as soon as it is imported, and nothing tears that down. So login and the shell are kept apart *(my call)*:
  - `main.ts` asks the control plane for the current session.
  - No session: it mounts the login view, a `.mu` template over a login view-model. It does not import the shell app.
  - Session, or after a successful login: it dynamically imports `app.mu.js` and mounts the shell. The operator context (`OperatorContext`) is registered as a service before the shell's view-models resolve it.
  - Log out, or a 401 from any later call: the page reloads. That drops all shell state and lands on login, so no service or view-model ever carries one session's data or role into another.
- **Header.** EditorShell's `HeaderContent` carries a minimal top bar template over a header view-model: product name, signed-in email and role, the read-only notice for Observers, and Log out.
- **Live updates.** The client's change notifications (events socket) refresh the active section's view-model.

## Dropped

- The legacy environment tools (environment list/detail, graphs, create graph, promote graph) and the top-bar button that reached them. Gone from the UI. The control-plane API routes stay; this spec doesn't touch the backend.
- The "coming soon" Agent Channel and Platform Components entries. They return as real modules when there's content *(my call)*.
- The hand-built shell and every imperative screen and widget it used: `app.ts`, `nav-rail.ts`, `nav-model.ts`, `top-bar.ts`, `section-container-view.ts`, `portal-view-base.ts`, the `*-view.ts` screens, and `kit/` pieces that become templates or are unused. They are deleted, not kept alongside.
- The design's visual fidelity: ink grouped sidebar with section headings and badges, search, Operations drawer, density toggle, keyboard shortcuts, dark theme. Stock EditorShell chrome is accepted for now, and fidelity is a later pass. Where a stock control can show the design's structure (a table, a status with icon and text), use it.

## Kept

- `ControlPlaneClient` and the DTOs in `portal-types.ts`.
- `OperatorContext`, date/version helpers (`portal-dates.ts`, `version-order.ts`, `release-channel.ts`, `fleet-presentation.ts`) and their tests.
- Existing `*-view-model.ts` files and their tests, reused where they fit the new structure. They already extend `Observable`. Reshape them as needed for commands and navigation; don't keep a view-model only because it exists.

## Constraints

- **Stock Mural only.** No changes to Mural are planned.
  - Subclassing or re-registering a framework service from the app, as the shell architecture documents, is allowed.
  - If the structure genuinely can't be expressed without a Mural change, stop and raise it. Don't work around it in the app with imperative Visual code.
  - The wizard's Back/Next live inside its page template, since it's a page.
- **Workspace conventions** (CLAUDE.md):
  - OOP, no module-level functions or state.
  - Allman braces in TS.
  - No inline string literals in TS (hoist to `private static readonly`). `.mu` labels stay inline.
  - Enums over string unions.
  - PascalCase for interfaces and public members.
  - View-models extend `Observable`.
  - Layering: the app depends on Mural and todl-runtime, never the reverse.
- **Mural's DI conventions** (`dev-kit/docs/projects/mural/shell-architecture.md` section 8):
  - Keys only on concrete leaf services.
  - Bindable state must be observable, or the binding silently yields `undefined`.
  - Shared collaborators registered where both resolvers can reach them: e.g. `ContentHostService` at the app root, as the demo does.
- **Build.** Add a `compile:mu` step (Mural CLI compiling `src/**/*.mu` to sibling `*.mu.js`, as Plexus's `scripts/compile-mu.mjs` and the demo do). It runs before `dev`, `build`, `test` and `typecheck`. Whether generated `.mu.js` files are committed follows Plexus (committed) *(my call)*.
- **Tests.**
  - View-models and services are unit-tested with node:test (`tsx --test`), as today. Tests live in `tests/`.
  - `npm --prefix admin/portal test` and `npm run typecheck:tools` (repo root) must pass.
  - The Playwright `portal.spec.ts` is updated to drive the new structure (login, rail, a list -> detail, a create dialog).
  - Tests for deleted imperative views are deleted with them.
- **EOL.** New and touched files are LF and ASCII.
- **Delivery.** Branch and merge locally; never push without explicit instruction.

## Left to the builder

- The exact module and file layout under `admin/portal/src/`. Suggested shape, after the demo's `groups/`: one folder per section holding its `*.module.mu`, `*.resources.mu`, services and view-models, with tests in that folder's `tests/`.
- How each section service presents list vs. detail (a small per-section navigation stack, or a shared helper service), as long as it stays view-model-driven.
- Which stock controls render tables, status and the wizard steps.
- Task decomposition and ordering. A sensible spine:
  1. Build plumbing and the empty shell with one section.
  2. Login and header.
  3. The remaining sections.
  4. Dialogs and the provision wizard.
  5. Deletion of the old code.
  6. e2e.
