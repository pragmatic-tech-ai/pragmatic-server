# PA-6 - Platform Admin Tenants (list + detail, one-tenant-one-hive visible) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The SIXTH Platform Admin spec. UI-only; no backend change.
**Area:** Platform Admin portal (`admin/portal/`).
**Builds on:** PA-1 kit (incl. `ObservedPanel`), PA-2 shell/nav, PA-3 `OperatorContext`, PA-4 `FleetViewModel`/`FleetHiveDto`/`FleetPresentation`, PA-5 `ClientsView` self-routing pattern + `ClientSinceLabel` date guard.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.3 (Tenants), 3 (G8/G9/G10), 6 (spec 3/4).

## Context

The `Tenants` nav section mounts a `ComingSoonView` placeholder. Legacy pre-kit tenant views (`tenant-list-view.ts` per-client, `create-tenant-view.ts`) remain reachable only via the dev-only legacy drill-down; they and their tests (`client-tenant-views.test.ts`) are out of scope and stay untouched.

Designed Tenants experience (recon 1.3): a GLOBAL **list** (Tenant, Client, Hive 1:1 + link, Hive connection, Envs observed, Created); a **create** dialog (client + tenant name + a "Stand up a new hive (required)" radio, existing hives disabled "Already serves X. One tenant per hive.", Continue hands off to the wizard); and a **detail** page ("Hive binding" 1:1 visual + connection, then an `ObservedPanel` "Environments", then Activity).

## Recon findings (binding) + rulings

1. **No server change.** `ControlPlaneHost.ToTenantDto` already serialises `{ id, clientId, displayName, createdAt, ownerEmail, ownerPrincipalId }`, so `createdAt` is already on the wire (the portal `TenantDto` merely omits it). PA-6 consumes existing `ListTenants()` (global), `ListClients()`, `ListFleet()` only. **Ruling: add `createdAt?: string` to the portal `TenantDto` as OPTIONAL** - several existing fixtures (including the `api-client` create-request-body test, which correctly omits `createdAt` since it is server-assigned) build `TenantDto` without it; optional avoids churning those and is honest because the shared date formatter degrades a missing value to "Unknown". Do NOT surface `ownerEmail`/`ownerPrincipalId` (owner identity refs, not in the designed columns).

2. **Tenant creation is DEFERRED to PA-8 (the provisioning wizard).** `POST /api/tenants` now *requires* `ownerEmail` and runs owner-IdP provisioning returning a one-time owner password (needs the deferred `OnceSecret` primitive). The design itself routes tenant create to the wizard ("Continue hands off to the wizard"). **Ruling: PA-6 ships list + detail only; no create form, and no "Create tenant"/"Stand up a hive" action on the list** (a button that cannot honestly complete the owner-provisioning op, or that does nothing, is the anti-goal). This mirrors `FleetView` deferring "Stand up a hive" to PA-8. The legacy portal `CreateTenant` (sends only `{id,clientId,displayName}`, now stale vs the server's `ownerEmail` requirement) stays in the dev chain, untouched; PA-8 owns the correct flow.

3. **`TenantsView` is a self-routing section container** (modes List / Detail - NO Create), mirroring PA-5 `ClientsView`: one view mounted at `ShowSection(PaSection.Tenants)`, swaps list<->detail via a content host rebuilt fresh each render, nav stays on "Tenants", no new `IPortalNavigator` methods.

4. **List columns = existing data only:** Tenant (`displayName`), Client (resolved name from `clientId`), Hive (the 1:1 hive's `displayName` or "No hive yet"), Connection (pill + last-seen), Envs observed (count), Created (`createdAt`). The designed 1:1 "link icon" is text here (DataTable cells are text; icon-in-cell deferred PA-15, consistent with PA-4). Search over tenant name/id + client name. Row open -> detail. No delete (destructive; no `ConfirmDialog`; legacy keeps delete in the dev chain).

5. **Detail = existing data only.** `PageHeader` (breadcrumb "Tenants / <name>"); a "Hive binding" `Section` presenting the one-tenant-one-hive relationship as a `KeyValueGrid`/compact row (Tenant, Hive or "No hive yet", Connection pill + last-seen, Cluster = backend / mode) - the designed diagram is rendered as text/KV (no diagram primitive; deferred); then **`ObservedPanel` "Environments"** (its FIRST production consumer) wrapping a `DataTable` of the observed env inventory. The designed env columns are Environment, Environment ID, Application, Version, Status, Health - of which only name / ready / image / detail exist (`FleetEnvDto`), so ship the honest subset: Environment (`name`), Status (`ready` -> Healthy/Failing pill), Image (`image ?? '-'`), Detail (`detail`). **Deferred** (filed / noted): Environment ID + Application + Version + Health grade (G8-ext), the Activity audit list (G9).

6. **Reuse PA-4/PA-5.** Connection state reuses `FleetViewModel` (indexed by hive id, joined to the tenant via `FleetHiveDto.tenant.id`); the pill via `FleetPresentation.ConnectionKind`. **Extract the date guard to a shared `PortalDates.Label(iso: string | undefined): string`** (empty/undefined/NaN -> "Unknown" else `toISOString().slice(0,10)`) - the single home used by the tenant list/detail AND retrofitted into PA-5's `ClientDetailViewModel.ClientSinceLabel` (delegates) and `ClientsView` list column, so the formatter is defined once.

## Goals

- Replace the Tenants placeholder with a kit Tenants experience: a global list and a detail page on existing data, keyboard-usable, honest about what is observed, with the one-tenant-one-hive relationship made visible.
- Give `ObservedPanel` its first production use (tenant detail Environments).

## Non-goals / deferred (filed as Features or later specs)

- Tenant creation / "Stand up a hive" / the 1:1 create rule enforcement + wizard handoff - **PA-8** (and server G10).
- Server-side one-tenant-one-hive invariant + unified create client+tenant+hive provisioning op - **G10**, server.
- Observed Environment ID / Application / Version / Health grade - **G8-ext**.
- Per-tenant Activity / audit - **G9**.
- Cross-section nav links (client<->tenant<->hive detail) - need a shared navigator; deferred (PA-7+).
- Diagram 1:1 visual, modal Dialog/ConfirmDialog, tenant delete, icon-in-cell - deferred (PA-15 / primitives).
- Any change to legacy tenant views or the control-plane.

## Anti-goals (a failure even if it "works")

- A "Create tenant"/"Stand up a hive" control that is present but cannot honestly complete the owner-provisioning op, or that does nothing.
- Fabricating env Application/Version/Health or an Activity feed; surfacing `ownerEmail`/`ownerPrincipalId` or any raw internal ref.
- Colour-only status (connection/env status must be icon + text via `StatusPill`).
- Any actionable control not keyboard-reachable; inline user-facing literals; importing `admin/tenant-portal`.

## Information architecture (decided shape)

New files under `admin/portal/src/`:

- `portal-dates.ts` - `class PortalDates { public static Label(iso: string | undefined): string }`.
- `tenants-view-model.ts` - `TenantsViewModel extends Observable`. Derives `TenantListRow[]` from `(tenants, clients, fleet, now?, quietThresholdMs?)`: `{ id, displayName, clientId, clientName, hiveName, connection, lastSeenLabel, observedEnvCount, createdAt }`. Client name from a `clientId -> displayName` map ("(unknown client)" fallback); the 1:1 hive via `fleet.find(h => h.tenant?.id === tenant.id)`; connection/last-seen from a `FleetViewModel` indexed by hive id; no-hive -> "No hive yet"/Awaiting/"Awaiting first dial-in"/0. `Rows`, `Update(...)` raising a `RowsProperty`.
- `tenant-detail-view-model.ts` - `TenantDetailViewModel extends Observable`. From `(tenant, clients, fleet, now?, quietThresholdMs?)` derives `Tenant`, `ClientName`, `Binding { hasHive, hiveName, connection, lastSeenLabel, cluster }`, and `EnvRows: { name, ready, image, detail }[]`. Seams `Tenant`, `Binding`, `EnvRows`, `ClientName`.
- `tenants-view.ts` - `TenantsView extends StackPanel implements IPortalView`, `constructor(client: ControlPlaneClient)` (no operator needed - no mutation), enum `TenantsMode { List, Detail }`, self-routes list/detail. `Refresh()` re-runs the active mode. Seams `Host`, `Table`, `Mode`.
- `tenant-detail-view.ts` - `TenantDetailView extends StackPanel`, `constructor(vm: TenantDetailViewModel, onBack: () => void)`. `ScreenHost` (populated) -> Back button + `PageHeader` + "Hive binding" `Section`/`KeyValueGrid` + `ObservedPanel` "Environments" wrapping a fresh `DataTable` of `EnvRows`. Seams `Host`, `EnvTable`.

Modified:
- `portal-types.ts` - `TenantDto` gains `createdAt?: string`.
- `app.ts` - `ShowSection(PaSection.Tenants)` mounts `new TenantsView(this.client)` before the `ComingSoon` fallback.
- `client-detail-view-model.ts` + `clients-view.ts` - `ClientSinceLabel`/the list "Client since" cell delegate to `PortalDates.Label` (single formatter home).

Tests under `admin/portal/tests/` (`node:test`, `Application.current` harness like `fleet-view.test.ts`): `portal-dates.test.ts`, `tenants-view-model.test.ts`, `tenant-detail-view-model.test.ts`, `tenant-detail-view.test.ts`, `tenants-view.test.ts` (list populated/empty/error; row-open -> detail; a SECOND `Refresh()` survives - the PA-4 guard).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `admin/portal/tests/`.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`), re-scan after any `\uXXXX`. Match EOL of touched files.
- Gate (green on merged result): `npm test` + `npm run typecheck` in `admin/portal`; `npm run typecheck:tools` from repo root. No control-plane source change.
- Every actionable control keyboard-reachable; status icon + text; no cross-app import; no raw internal ref exposed.
- Stateful views MUST survive a second `Refresh()` (fresh content slot per render).

## Review focus (inputs no happy-path test exercises)

- A tenant with no hive renders "No hive yet"/Awaiting and an empty Environments panel, not a crash. (Detail VM + view tests.)
- A tenant whose `clientId` matches no client shows "(unknown client)", not blank/undefined. (List VM test.)
- An observed env with `ready === false` shows a Failing (not Healthy) status pill and `image ?? '-'` when image is absent. (Detail view test.)
- A missing/empty `createdAt` renders "Unknown" in the Created column, not "Invalid Date". (PortalDates test.)
- A second `Refresh()` (events-socket change) re-renders list and detail with no double-parent throw. (TenantsView test.)
