# PA-5 - Platform Admin Clients (list, create, detail) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The FIFTH Platform Admin spec. UI-only; no backend change.
**Area:** Platform Admin portal (`admin/portal/`).
**Builds on:** PA-1 kit, PA-2 shell/nav, PA-3 operator role (`OperatorContext`), PA-4 Fleet (`FleetViewModel` connection derivation, `FleetHiveDto`).
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.2 (Clients), section 3 (G8/G9/G10), section 6 (spec 3 = lists/details on existing data).

## Context

The `Clients` nav section currently mounts a `ComingSoonView` placeholder (`app.ts` `ShowSection`). Legacy pre-kit client views (`client-list-view.ts`, `create-client-view.ts`) remain reachable only via the dev-only legacy drill-down entry (`onLegacy` -> `ShowList`); they and their tests (`client-tenant-views.test.ts`) are out of scope and stay untouched.

The designed Clients experience (recon 1.2): a **list** (columns Client+legal, Contract, Tier, Region, Tenants count, Hives connection, Client since; filter; "Create client"), a **create** form, and a **detail** page (header with Active/Onboarding pill + "Add tenant"; "Tenants and hives" table with connection + observed env count; "Activity" audit; "Contract & profile" KV).

## The scope decision (recon finding + rulings)

**Recon finding (binding):** `ClientRecord` (`admin/control-plane/platform-records.ts`) has only `{ id, displayName, subscriptionRef?, createdAt }`. The designed profile fields (legal entity, contract ref, tier, primary region, client-administrator contact, active/onboarding status) **do not exist** on the server. Per the honesty invariant we ship what exists and never invent a backend.

Rulings:

1. **No server change.** `ControlPlaneHost` already serialises `ClientDto = ClientRecord` (so `createdAt` is already on the wire; the portal's `ClientDto` type merely omits it). PA-5 adds `createdAt` to the portal `ClientDto` type and consumes existing endpoints (`ListClients`, `ListTenants`, `ListFleet`) only. No new route, no record field.

2. **Build NEW kit views; leave the legacy client views and their dev chain + tests untouched.** The new views wire into `ShowSection(PaSection.Clients)`, replacing the `ComingSoon` arm - exactly as `FleetView` replaced it for Fleet.

3. **`ClientsView` is a self-routing section container.** It is the single view mounted at `PaSection.Clients` and swaps between three internal screens - list, create, detail - via a content host. The nav rail stays on "Clients" throughout; no new `IPortalNavigator` methods, no shell changes beyond the one `ShowSection` arm. Row activation opens detail; detail and create carry a "Back to clients" affordance.

4. **List columns = existing data only:** Client (displayName), Tenants (count), Hives (count + a connection roll-up label, e.g. "2 connected, 1 quiet"), Subscription ref, Client since (`createdAt`). Search over client name/id. Primary action "Create client" as an `Act` gated by `OperatorContext` (visible-but-denied for Observers). **No delete** - destructive, the design does not surface it on this page, and the `ConfirmDialog`/name-to-confirm primitive is deferred; legacy delete stays in the dev chain.

5. **Create flow = kit-framed form, not a modal.** Reuse the proven `CreateClientViewModel` (`ICreateClientSink`); render it with `PageHeader` + `Section` + text fields + a gated submit `Act` and a cancel. Fields: id, displayName, subscription ref (optional) - the only fields that exist. The designed dialog/modal and the extra profile fields are **deferred** (Dialog primitive -> PA-15; profile fields -> filed Feature under G10).

6. **Detail = existing data only.** `PageHeader` (breadcrumb "Clients / <name>"), a "Contract & profile" `KeyValueGrid` (client id, display name, subscription ref, client since), and a "Tenants and hives" `Section` whose `DataTable` joins `ListTenants(clientId)` with the client's hives from `ListFleet()` - columns Tenant, Hive, Connection (pill + last-seen label), Observed envs - with an observed-data caption on the section (mirroring `FleetView`'s `ObservedCaption`, since connection/env are read from each hive's last check-in). **Deferred** (filed as Features / noted): the Active/Onboarding status pill (no status field), the Activity audit list (G9), and the "Add tenant" action (PA-6 owns tenant creation).

7. **Reuse PA-4 connection derivation.** The per-client hive connection state reuses `FleetViewModel` over the client's filtered `FleetHiveDto[]` (no duplicated lastSeen->connection logic). The `FleetConnection -> PillKind` mapping is extracted to a single shared home (a small `FleetPresentation` helper) used by both `FleetView` and the client detail, so the mapping is defined once. `ObservedPanel` stays deferred to PA-6/PA-7 per the `FleetView` precedent (a mixed identity+observed table uses `Section` + caption, not the all-observed `ObservedPanel`).

## Goals

- Replace the Clients placeholder with a kit Clients experience: list, create, detail, all on existing data, keyboard-usable and honest about what is observed.
- Surface per-client tenant/hive counts and hive connection roll-up on the list; tenant/hive connection + observed env count on the detail.
- Gate every mutation (Create client) as visible-but-denied for Observers via `OperatorContext`.

## Non-goals / deferred (filed as Features or to later PA specs)

- Client profile fields (legal, contract, tier, region, contact, status) and the Active/Onboarding pill - **G10**, server work; filed Feature.
- Per-client Activity / audit feed - **G9**; filed Feature.
- "Add tenant" from client detail - **PA-6** (Tenants list + detail + 1:1 create).
- Modal Dialog / Drawer create, `ConfirmDialog` name-to-confirm, client delete - Dialog/ConfirmDialog primitives deferred (PA-15).
- Any change to the legacy `client-list-view.ts` / `create-client-view.ts` or the control-plane.

## Anti-goals (a failure even if it "works")

- Inventing a client profile/status field or faking an activity feed (honesty: reported == enforced; never fabricate a backend).
- A "Create client" or "Add tenant" button that is enabled for an Observer, or that is present but does nothing.
- Colour-only status (connection must be icon + text via `StatusPill`).
- Any actionable control not keyboard-reachable.
- Coupling `admin/portal` to `admin/tenant-portal`; exposing a raw server-side internal ref.
- Inline user-facing string literals (hoist to `private static readonly`).

## Information architecture (decided shape)

New files under `admin/portal/src/`:

- `clients-view-model.ts` - `ClientsViewModel extends Observable`. `Load()` fetches `ListClients` + `ListTenants()` (all) + `ListFleet()` (all); derives one `ClientListRow` per client `{ id, displayName, subscriptionRef, createdAt, tenantCount, hiveCount, connectionSummary }`. Connection roll-up via a `FleetViewModel` over the fleet, grouped by `client.id`. Test seam: `Rows`.
- `client-detail-view-model.ts` - `ClientDetailViewModel extends Observable`. `Load(clientId)` fetches `ListTenants(clientId)` + `ListFleet()` (filtered to client); derives profile KV items and `ClientTenantRow[]` `{ tenantId, tenantName, hiveName, connection, lastSeenLabel, observedEnvCount }` left-joining tenants to their 1:1 hive. Test seams: `Profile`, `Rows`, `Client`.
- `clients-view.ts` - `ClientsView extends StackPanel implements IPortalView`. Owns the API client + `OperatorContext` + a content host; routes list / create / detail. `Refresh()` re-runs the active screen. Mounted by `ShowSection(PaSection.Clients)`.
- `client-detail-view.ts` - `ClientDetailView extends StackPanel`. `ScreenHost` + `PageHeader` + profile `KeyValueGrid` + observed "Tenants and hives" `Section`/`DataTable`; `onBack` callback.
- `fleet-presentation.ts` - `FleetPresentation` with `static ConnectionKind(c: FleetConnection): PillKind` (and `HealthKind` if the Fleet refactor pulls it along); the one home for the connection-pill mapping.

Create screen: reuse `CreateClientViewModel`; its view is either a small `ClientCreateView` file or an internal builder on `ClientsView` (builder's call - keep it focused and testable, gated submit).

Modified:

- `portal-types.ts` - add `createdAt: string` to `ClientDto` (already on the wire).
- `app.ts` - `ShowSection(PaSection.Clients)` mounts `new ClientsView(this.client, this.operator)` instead of `ComingSoonView`; pass the `OperatorContext` (as `ShowSection` already holds `this.operator`). No other shell change.
- `fleet-view.ts` - use `FleetPresentation.ConnectionKind` (extract-and-reuse; behaviour unchanged).

Tests under `admin/portal/tests/` (`node:test`, `Application.current` harness as in `fleet-view.test.ts`): `clients-view-model.test.ts`, `client-detail-view-model.test.ts`, `clients-view.test.ts` (list populated/empty/error; row-open navigates to detail; create gated for Observer; a SECOND `Refresh()` survives - the PA-4 double-parent lesson), `client-detail-view.test.ts`.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `admin/portal/tests/`.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`), re-scan after escaping any `\uXXXX`. Match EOL of any existing file touched.
- Gate: `npm test` + `npm run typecheck` in `admin/portal`, green on the merged result; plus `npm run typecheck:tools` from repo root (it typechecks both portals). No control-plane source change.
- Every actionable control keyboard-reachable; every status icon + text, not colour alone. No cross-app import; no raw internal ref exposed.
- Stateful re-render: `ClientsView`/`ClientDetailView` MUST survive a second `Refresh()` (fresh content slot per render; Visual holds one parent) - the PA-4 blocker.

## Review focus (inputs no happy-path test exercises)

- A client with zero tenants/hives renders counts of 0 and an honest empty "Tenants and hives" table, not a crash. (Detail VM + view tests.)
- A tenant with no hive yet (awaiting) shows an Awaiting connection, not a blank/undefined row. (Detail VM test.)
- "Create client" is visible-but-disabled with the needed-role hint for an Observer and never submits. (ClientsView test.)
- A second `Refresh()` (events-socket change) re-renders list and detail without a double-parent throw. (ClientsView test.)
- `createdAt` absent/malformed on a `ClientDto` degrades to a readable label, not `Invalid Date` noise. (Detail VM test.)
