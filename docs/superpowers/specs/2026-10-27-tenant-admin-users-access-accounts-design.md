# Tenant-Admin "Users & Access" — Accounts & Grants (SP-ADMIN Spec B1-1) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, `admin/tenant-portal` (ships one-per-hive). Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Spec B → B1 (tenant-admin identity UI). B1 is a multi-spec sub-program; this is its first spec (B1-1). Depends on the Mural `DataGrid` (Spec B0, merged mural `main` @8ee9a5f1).
**Reconciles with:** the two-app split (`2026-10-25-platform-and-tenant-admin-app-separation-design.md`) — tenant identity management lives in tenant-admin — and the UX brief (`docs/design/2026-10-26-platform-and-tenant-admin-ux-brief.md`), §5.3 "Users & Access".

## Intent

Give a tenant operator a real **Users & Access** screen in the tenant portal to manage the in-hive identity provider for a selected environment: see the accounts and their role grants in a table, create and disable accounts, and grant/revoke roles — presented through the new Mural `DataGrid`, never exposing secrets, with explicit loading/empty/error/permission-denied states and a guard against the operator removing their own access. This is the first use of the DataGrid in a shipping app and the foundation the later identity specs (tokens, security-model designer, field-security) build on.

## Goals

- A `UsersAccessView` reachable from a new **Users & Access** entry in the tenant portal's top-bar navigation (per the brief's IA), scoped to an environment chosen in an environment picker at the top of the section.
- An **accounts `DataGrid`**: one row per account, columns for email, principal id, status (Active/Disabled), and the account's roles; a trailing template column with a **Disable** action (inline name-to-confirm).
- A **create-account** form (email, principal id, password) that calls the existing route and refreshes.
- A **roles editor** for the selected account: grant a role (role + resource scope) and revoke an existing grant, against the existing grant routes.
- **Warn before self-lockout:** disabling your own account or revoking your own Owner grant prompts a name-to-confirm warning; the backend also rejects (409) and the UI surfaces the generic conflict message.
- **No secrets, ever:** password is input-only (never rendered or retained for display); no tokens in this slice.
- Full **states**: loading, empty, populated, error (generic, no leaked internals), permission-denied — per the brief's states matrix.
- Uses **only existing** `/tenant-api/environments/:name/admin/*` routes — no server changes.

## Non-goals / anti-goals (this spec)

Each deferred to a later B1 spec or filed as a Project item:

- **Service tokens** (list/issue/revoke) — needs new `/tenant-api` REST routes (ListTokens/RevokeToken/generic IssueToken are on the JSON-RPC `AdminProtocol` but not surfaced over REST). → **Spec B1-2** + a server slice.
- **Roles × privilege matrix** editor (the `securityModel.roles[].privileges[]` grid of `AccessLevel` cells). → **Spec B1-3**.
- **Field-security designer** (`securityModel.fieldSecurity`). → **Spec B1-4** (shares a security-model draft VM with B1-3).
- **Org structure** (business units, teams, membership, ownership, role/profile assignment). → **Spec B1-5**.
- **Concept/field catalog** backend op (the matrices need a list of concepts/fields; none exists). → filed as a Project Feature; the designer specs decide free-type vs catalog.
- **Tenant-level identity aggregation** across environments (R1 scopes this spec to a single environment). → **committed as a later B1 slice** (user decision 2026-10-27: "R1 at full tenant after" — environment-scoped now, full-tenant aggregation built after the environment-scoped slices land). Additive layer over the same view/VM/client.
- A Mural `framework` barrel export for `DataGrid` (R3 uses the subpath import). → optional later mural cleanup.

## Rulings

- **R1 — environment-scoped.** The backend identity surface is per-environment (every route is keyed by `:name`); per `project_platform_admin_tenant_semantics` the server "tenant" is really an environment. The brief's "one tenant's identity" is realized as an environment picker. *Cost if wrong:* a tenant-wide aggregation is an additive later layer, not a rewrite.
- **R2 — Accounts & Grants first, existing routes only.** Smallest shippable identity slice, no backend changes, proves the DataGrid in a shipping app. *Cost if wrong:* later specs reuse the same view/VM/client scaffolding.
- **R3 — import DataGrid via the `@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js` (+ `data-grid-column.js`) subpath.** The framework barrel doesn't export it; the package `exports` wildcard `./framework/*.js` does. *Cost if wrong:* trivially swapped for a barrel import once mural adds one.
- **R4 — top-bar nav entry + environment picker.** Matches the brief's IA (Users & Access as a primary section, not buried in the hive tree). `ITenantNavigator` gains `ShowUsersAccess()`.

## Architecture

Follow the tenant-portal house pattern exactly: an imperative Mural view (`.ts`, no `.mu`) paired with an `Observable` view-model; the view subscribes to VM `PropertyChanged` and rebuilds its children on change; all user-facing text in `private static readonly` constants; styling inherited entirely from the Pragmatic theme (no hand-rolled brushes/margins/widths). Row objects for the grid are `Observable` so cell templates and status reflect updates.

**New files (tenant-portal `admin/tenant-portal/src/`):**

| File | Role |
|---|---|
| `users-access-view.ts` | `UsersAccessView extends TenantViewBase` — environment picker, accounts `DataGrid`, create-account form, roles editor for the selected account, states. |
| `users-access-view-model.ts` | `UsersAccessViewModel extends Observable` — environment list + selection, accounts/grants snapshot, loading/error/permission state, create-form state, selected account + its grants, grant-draft; methods `LoadEnvironments`, `LoadSnapshot`, `CreateAccount`, `DisableAccount`, `GrantRole`, `RevokeRole`. Consumes a narrow `IUsersAccessSource` interface (satisfied by `TenantApiClient`). |
| `account-row.ts` | `AccountRow extends Observable` — `Email`, `PrincipalId`, `Status`, `RolesText` (joined role names from the account's grants), and the underlying ids needed for actions. |

**Modified files:**

- `tenant-api-client.ts` — add `GetAdminSnapshot(env)`, `CreateAccount(env, {email, principalId, password})`, `DisableAccount(env, principalId)`, `GrantRole(env, grant)`, `RevokeRole(env, grant)` against the existing REST routes (see recon §3); plus `ListEnvironments()` if not already present (the picker's source).
- `tenant-types.ts` — add `AccountDto`, `GrantDto`, `AdminSnapshotDto`, `GrantMutationDto`, and `IUsersAccessSource` (wire shapes copied verbatim — the portal never imports `pragmatic-protocol` types directly).
- `tenant-app.ts` — add a **Users & Access** top-bar nav entry and `ShowUsersAccess()`; `ITenantNavigator.ShowUsersAccess()` in `tenant-types.ts`.
- `tests/fake-tenant-control-plane.ts` — extend the canned `/tenant-api` server with the snapshot/accounts/grants routes so view/VM tests and e2e can exercise them.

**DataGrid usage:** `ItemsSource = AccountRow[]`; `DataGridTextColumn` for Email / PrincipalId / Status / Roles; a `DataGridTemplateColumn` "Actions" whose `CellTemplate` builds a Disable `Button` that puts the row into an inline "Confirm disable / Cancel" state (the `confirming`-flag pattern from `environment-detail-view`). The clicked row comes from the cell's `DataContext`. Call the grid's `dispose()` from the view's `Dispose()`.

**Roles editor:** selecting an account row drives a side/below panel showing that account's current grants (role + resource path) each with a Revoke button, plus a grant form (role `ComboBox` over Owner/Admin/Editor/Viewer/Maker, resource-kind/scope, Grant button). v1 keeps the resource scope to the tenant root unless a richer picker is trivial.

## Trust-boundary / security UX

- Password field is write-only input; never echoed back, never stored in the VM beyond the create call, cleared on success.
- Error text is the backend's fixed generic strings; the UX surfaces them verbatim and never synthesizes internal detail. A 401 routes to login (via `TenantViewBase.ShowError`).
- Self-lockout: before issuing a disable/revoke that targets the current operator's own access, show a name-to-confirm warning explaining the consequence in plain language (brief §5.5); if the backend still rejects (self-lockout / last-admin → 409), show the generic conflict message.
- Permission-denied state rendered if the snapshot load returns 403 (defense in depth; the operator reaching tenant-portal normally has `administer`).

## Testing

House pattern: `tsx --test` unit tests for the VM against a fake `IUsersAccessSource`, and view tests against a fake source asserting the DataGrid renders (walk the visual tree / `TreeQuery` as in the mural DataGrid tests).

- VM: load snapshot populates accounts+roles; create/disable/grant/revoke call the right source methods and refresh; error sets the error state; self-targeting disable/revoke sets the warn-confirm state.
- View: accounts render one grid row per account with the right cell text; the Disable action's confirm flow; the create form; the roles editor grant/revoke; loading/empty/error/permission-denied render distinctly.
- `fake-tenant-control-plane` gains the routes so the existing e2e harness still boots.
- Gates: `npm run typecheck:tools`; `npm --prefix admin/tenant-portal test`; (DataGrid already in mural `dist` — no mural rebuild needed unless mural changes). LF endings; OOP/Allman/PascalCase/no-inline-literals; VMs extend `Observable`.

## Left to the plan

Exact method signatures on `IUsersAccessSource`/`TenantApiClient` and the copied DTO shapes; whether the roles editor is a side panel or an expander; the environment-picker source (`ListEnvironments` vs the tree's environment list); the precise DataGrid column widths/templates; task decomposition (likely: client+DTOs+fake → VM → view+DataGrid → nav wiring, each independently testable).
