# PA-7 - Platform Admin Hives (list + detail skeleton) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The SEVENTH Platform Admin spec. UI-only; no backend change.
**Area:** Platform Admin portal (`admin/portal/`).
**Builds on:** PA-1 kit (incl. `ObservedPanel`, `Banner`), PA-4 `FleetViewModel`/`FleetHiveDto`/`FleetPresentation`, PA-5/PA-6 self-routing section pattern (`ClientsView`/`TenantsView`) + the observed-env table from `TenantDetailView`.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.4 (Hives), 3 (G4/G6/G8/G9), 6 (spec 3).

## Context

The `Hives` nav section mounts a `ComingSoonView` placeholder. Legacy pre-kit hive views (`hive-list-view.ts` per-tenant, `create-hive-view.ts` raw-record form) remain reachable only via the dev-only legacy drill-down; they stay untouched.

Designed Hives experience (recon 1.4): a list (selectable rows + bulk "Rotate agent tokens"; columns Hive, Client/tenant, Cluster + region, Connection, Health, Agent, hidden Base domain) and a rich detail (header + 3 banners + tabs Overview/Observed environments/Credentials/Activity; "Home channel" KV; "Pragmatic components running"; "What you can do from here" = Rotate/Re-issue/Revoke agent token; Credentials `SecretTable` by reference + Trust root; name-to-confirm + `OnceSecret` ops).

## Recon findings (binding) + rulings

The designed detail is **heavily backend-gap-blocked**: token Rotate/Revoke/Re-issue = **G4** (no lifecycle API; only `POST /api/hives/:id/rollout-registration` mints+overwrites a raw token), component versions = **G6**, Activity = **G9**, `SecretTable`/`OnceSecret`/`ConfirmDialog` are deferred kit primitives, and the agent-token/registry/trust-root fields on `HiveDto` are **internal reference names** (`configRef`/`credentialRef`/`trustRootRef`/`agentTokenRef`) the honesty invariant keeps off the UI.

Rulings:

1. **No server change.** The global hive data the list + detail skeleton need is already in `ListFleet()` -> `FleetHiveDto` (id, displayName, tenant, client, clusterBackend, clusterMode, lastSeen, environments) and derivable via `FleetViewModel` (connection, last-seen label, health, env count). PA-7 consumes `ListFleet()` only.

2. **Ship a list + detail SKELETON on existing observed data; defer every gap as a Feature.** DEFERRED (filed / noted): all token operations - Rotate / Revoke / Re-issue (G4) and the "What you can do from here" section (never show an action that has no honest backend or that would be reported-not-enforced); "Pragmatic components running" (G6); the Credentials tab - `SecretTable` by reference + Trust root (deferred primitive + internal refs); Activity (G9); the token-revoked banner + its "Re-issue bootstrap token" action (G4); bulk "Rotate agent tokens" + selectable rows on the list (G4); the tab chrome (3 of 4 tabs are deferred, so render sections, not tabs); region / base domain / agent id / expected check-in interval (not in the observed data; interval is a PA-13 Settings config value). We do NOT display `configRef`/`credentialRef`/`trustRootRef`/`agentTokenRef`.

3. **`HivesView` is a self-routing section container** (modes List / Detail - NO Create; hive creation is the provisioning wizard's job, PA-8), mirroring `TenantsView`: mounted at `ShowSection(PaSection.Hives)`, swaps list<->detail via a content host rebuilt fresh each render, nav stays on "Hives".

4. **List columns = existing data only:** Hive (`displayName`), Client / tenant (`ownerLabel`), Cluster (`backend / mode`), Connection (pill + last-seen), Health (Healthy/Failing pill), Envs observed (count). Search over hive name + owner. Row open -> detail. No selection/bulk (G4). The designed "Agent" column (component version) and hidden Base domain are deferred.

5. **Detail skeleton = header + observational banner + "Home channel" KV + observed environments.** Header: hive display name/id, connection pill, client, tenant (text, not a link - cross-section nav deferred), cluster. An observational `Banner` derived from connection state ONLY: quiet -> Warning with the designed honest copy ("...hasn't checked in for a while. Its last report stands. Pragmatic can't connect in, so there is nothing to retry from here."), awaiting -> Info ("Awaiting first dial-in."), connected -> no banner. (No token-revoked banner - that state + its action are G4.) "Home channel" `Section`/`KeyValueGrid`: Connection, Last check-in, Cluster, Environments observed. Then an **`ObservedPanel` "Observed environments"** wrapping the shared observed-env table (Environment / Status [Healthy|Failing] / Image / Detail - the honest subset; Application/Version/Health-grade are G8-ext, deferred).

6. **DRY the observed-env table.** PA-6's `TenantDetailView` and PA-7's `HiveDetailView` render the identical observed-environments table. Extract it to a shared `ObservedEnvTable` (an `ObservedEnvRow { name, ready, image, detail }` + a `static Build(rows): DataTable<ObservedEnvRow>`), refactor `TenantDetailView` to use it (behaviour-preserving), and use it in `HiveDetailView`. Reuse `FleetViewModel`/`FleetPresentation` for connection, and the self-routing pattern from `TenantsView`.

## Goals

- Replace the Hives placeholder with a kit navigable global Hives list and a hive detail skeleton, on existing observed data, honest about what is observed vs not-yet-available.
- Make the per-hive observed environments visible via the shared `ObservedEnvTable` inside an `ObservedPanel`.

## Non-goals / deferred (filed as Features or later specs)

- Agent-token lifecycle: Rotate / Revoke / Re-issue, the "What you can do from here" section, token-revoked banner/action, bulk rotate - **G4**.
- "Pragmatic components running" (agent / Tenant Admin / IdP versions + rollout) - **G6**; the Agent column.
- Credentials tab: `SecretTable` by reference + Trust root - deferred primitive + internal refs.
- Activity feed - **G9**. Tab chrome, region / base domain / agent id / expected interval. Hive creation (PA-8). Cross-section nav (tenant link). Observed Application/Version/Health-grade - **G8-ext**.
- Any change to legacy hive views or the control-plane.

## Anti-goals (a failure even if it "works")

- A Rotate/Revoke/Re-issue control (or a token-revoked "Re-issue" banner action) with no honest backend - reported-not-enforced.
- Surfacing `configRef`/`credentialRef`/`trustRootRef`/`agentTokenRef` or any raw internal ref; fabricating component versions, agent id, or an Activity feed.
- Colour-only status; a control that is not keyboard-reachable; inline user-facing literals; importing `admin/tenant-portal`.

## Information architecture (decided shape)

New files under `admin/portal/src/`:

- `observed-env-table.ts` - `interface ObservedEnvRow { name: string; ready: boolean; image: string; detail: string }` + `class ObservedEnvTable { public static Build(rows: readonly ObservedEnvRow[]): DataTable<ObservedEnvRow> }` (Dense; columns Environment / Status [`PillKinds.For(ready ? Healthy : Failing).label`, tone Danger when not ready] / Image / Detail; `emptyText` 'No environments observed.'; `searchText` = name). Hoisted literals.
- `hives-view-model.ts` - `HivesViewModel extends Observable`. From `(fleet: FleetHiveDto[], now?, quietThresholdMs?)` derives `HiveListRow { id, displayName, ownerLabel, cluster, connection, lastSeenLabel, envCount, notReadyCount }` by reusing a `FleetViewModel` (indexed by hive id for connection/lastSeenLabel/envCount/notReadyCount/ownerLabel) and reading `cluster = backend + ' / ' + mode` from the dto. `Rows`, `Update(fleet)` raising `RowsProperty`.
- `hive-detail-view-model.ts` - `HiveDetailViewModel extends Observable`. From `(hive: FleetHiveDto, now?, quietThresholdMs?)` derives `Hive` header fields (displayName, ownerLabel, cluster), `Connection`/`LastSeenLabel`, a `BannerState { show: boolean; tone: BannerTone; text: string }` (quiet/awaiting/none), `HomeChannel: KeyValueItem[]` (Connection, Last check-in, Cluster, Environments observed), and `EnvRows: readonly ObservedEnvRow[]`.
- `hive-detail-view.ts` - `HiveDetailView extends StackPanel`, `constructor(vm, onBack)`. `ScreenHost` populated -> Back + `PageHeader` + optional `Banner` + "Home channel" `Section`/`KeyValueGrid` + `ObservedPanel` "Observed environments" wrapping `ObservedEnvTable.Build(vm.EnvRows)` (fresh slot per render). Seams `Host`, `EnvTable`.
- `hives-view.ts` - `HivesView extends StackPanel implements IPortalView`, `constructor(client)`, enum `HivesMode { List, Detail }`, self-routes list/detail (copy the hardened `TenantsView`). List: `ListFleet()` -> `HivesViewModel` -> `DataTable<HiveListRow>` (cols above, `onOpen` -> ShowDetail, fresh slot, ScreenHost loading/error[onRetry]/empty['No hives yet.']/populated). Detail: refetch `ListFleet()`, find the hive by id (stale-guard + try/catch -> list error fallback), build `HiveDetailViewModel`/`HiveDetailView`. Seams `Host`, `Table`, `Mode`.

Modified:
- `tenant-detail-view.ts` - use `ObservedEnvTable.Build(...)` instead of its private env columns (behaviour-preserving).
- `app.ts` - `ShowSection(PaSection.Hives)` mounts `new HivesView(this.client)` before the `ComingSoon` fallback.

Tests under `admin/portal/tests/` (`node:test`, `Application.current` harness): `observed-env-table.test.ts`, `hives-view-model.test.ts`, `hive-detail-view-model.test.ts`, `hive-detail-view.test.ts`, `hives-view.test.ts` (list populated/empty/error; row-open -> detail; detail-fetch-reject fallback; list + detail second `Refresh()` survive).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, tests under `admin/portal/tests/`.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`), re-scan after any `\uXXXX`. Match EOL of touched files.
- Gate (green on merged result): `npm test` + `npm run typecheck` in `admin/portal`; `npm run typecheck:tools` from repo root. No control-plane change.
- Every actionable control keyboard-reachable; status icon + text; no cross-app import; no raw internal ref exposed.
- Stateful views MUST survive a second `Refresh()` in BOTH list and detail modes (fresh content slot per render).

## Review focus (inputs no happy-path test exercises)

- A hive that never dialled in (lastSeen null) shows Awaiting + an awaiting Banner + empty Observed environments, no crash; the Connection cell does NOT double a label (real hives use 'Never dialled in', distinct from the Awaiting pill). (List/detail tests.)
- A quiet hive shows the Warning banner with the "nothing to retry from here" copy and still renders its last observed envs. (Detail VM + view tests.)
- An observed env with `ready === false` shows a Failing (not Healthy) status and `image ?? '-'`. (ObservedEnvTable test.)
- No Rotate/Revoke/Re-issue control, no Credentials/Components/Activity section, and no internal ref appears anywhere in the detail. (Detail view test / review.)
- A second `Refresh()` in list and in detail re-renders without a double-parent throw. (HivesView test.)
