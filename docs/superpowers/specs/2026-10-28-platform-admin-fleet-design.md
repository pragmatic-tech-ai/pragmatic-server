# PA-4 - Fleet overview and the G8 fleet read model - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The FOURTH Platform Admin spec - the first daily-use operator screen, and the first to need a cross-hive read model (G8). Full-stack: a server read slice + the Fleet home.
**Area:** `admin/control-plane` (a fleet read endpoint) + `admin/portal` (fleet client, a Fleet view model with the derivations, the Fleet view, and the `ObservedPanel` kit primitive deferred from PA-1).
**Builds on:** PA-1 kit (`DataTable`, `StatusPill`/`PillKind` incl. Connected/Quiet/Awaiting + Healthy/Failing/Unknown, `ScreenHost`, `Section`, `PageHeader`), PA-2 shell (`ShowSection(Fleet)` currently mounts a placeholder), PA-3 role model. Informed by the prototype `platform.jsx` `Fleet` + `pctx.jsx` (`connLabel`, `hiveIssues`) - re-implemented on Mural, NOT ported.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.1 (Fleet), section 2 (Observed panel, hive-dials-home-as-status), section 3 G8, section 6 spec 5. **Separation spec** binds: `admin/portal` must not import `admin/tenant-portal`.

## Context: what exists, and the G8 gap

Recon found the raw material for a fleet read model already exists, but nothing assembles or serves it cross-hive:
- `PlatformDirectory` lists all hives/tenants/clients and resolves each (`ListHives()`, `GetTenant(id)`, `GetClient(id)`). `HiveRecord = { id, tenantId, displayName, cluster: { backend, mode, configRef? }, registry, trustRootRef?, agentTokenRef?, createdAt }` - it has `tenantId` (-> client via the tenant) but NO region/namespace/baseDomain (those are G1/G10 gaps).
- `HiveObservationRegistry` holds the latest snapshot per hive: `{ hiveId, environments: HiveHealthDto[], reportedAt }`, recorded platform-side by `PlatformDeploymentRegistry.RecordSnapshot`. `List()` (inherited) returns all; `reportedAt` is a usable last-seen. `HiveHealthDto = { environmentName, ready: boolean, runningImage: string | undefined, detail: string }` - name + a ready bool + the running image + a detail string. There is NO environment id, semantic application name, semantic version, status enum, health grade, or component-version data.
- The operator events socket emits one event type, `environments-changed` (`control-plane-host.ts`), already surfaced to the portal via `ControlPlaneClient.OnChanged`.
- `GET /api/hives/:id/health` returns one hive's `HiveHealthDto[]`. There is NO list-all fleet endpoint, no connection-state derivation, and the platform `HiveDto` is the raw `HiveRecord` (refs included - acceptable only because Platform Admin is the trusted internal console).

## The honest-scope decision (the central ruling)

G8 is a hard blocker in the recon. The governing mandate is **never fabricate a backend**: build only what the existing observation data genuinely supports, and defer the rest as filed Features. This spec draws the line explicitly.

**Ruling 1 (what PA-4 BUILDS - the honest G8 slice):**
- A **fleet read endpoint** `GET /api/fleet` that JOINs, for every hive: hive id/displayName, its tenant `{id, displayName}` and client `{id, displayName}` (via the directory chain), cluster `backend`/`mode`, `lastSeen` (the observation's `reportedAt`, or `null` if the hive has never reported), and the observed environment inventory from the latest snapshot (`{ name, ready, image, detail }`). A **purpose-built `FleetHiveDto` that carries NO internal refs** (no configRef/credentialRef/trustRootRef/agentTokenRef) - the fleet view does not need them, so they do not go on the wire even though the operator surface is trusted.
- **Client-side derivation** (in the Fleet view model, matching the prototype's `pctx` helpers; keeps the server a thin, testable join): per-hive **connection state** `connected | quiet | awaiting` from `lastSeen` and a configurable quiet threshold (`lastSeen === null` -> awaiting first dial-in; `now - lastSeen < threshold` -> connected; else -> quiet; threshold placeholder 6h, injectable `now` for tests); **derived issues** limited to the honestly-derivable ones - quiet hive, awaiting first dial-in, and environment-not-ready (from `ready === false`); **stat tiles** Hives / Need attention / Not checking in (quiet + awaiting) / Environments observed; **needs-attention** ordering danger > warning > info.
- The **`ObservedPanel` kit primitive** (deferred from PA-1 to its first screen - this is it): a dashed, read-only panel with an `observed` pill and a one-line "read from the hive's last check-in; no break-glass" note, containing the observed inventory and **no buttons or actionable controls** (the trust-boundary "observe, never command" rule).
- The Fleet view replaces the `ShowSection(PaSection.Fleet)` placeholder with the real screen: `PageHeader`, stat tiles, needs-attention list, a dense `DataTable` (Hive, Client/tenant, Connection pill + last-seen text, Health pill, Envs count, Issues) with search and the three saved filter segments (All / Needs attention / Not checking in), per-row tone, and `ScreenHost` states (loading/empty/populated). Refreshes on the existing `environments-changed` event.

**Ruling 2 (what PA-4 DEFERS - each filed as a Feature, never faked):**
- **`disconnected` = agent-token-revoked** connection state - needs the G4 token lifecycle (no token status exists). Until G4, a revoked/never-dialed hive reads as `awaiting` or `quiet`, not a false `disconnected`.
- **Semantic application name / version / status / health-grade** per environment beyond `ready` + the running image - the observation carries none. Fleet shows the env name, a Healthy/Failing pill from `ready`, and the running image labeled honestly as the running image (NOT a fabricated semantic version). Richer inventory is a G8-extension Feature (depends on the agent reporting it).
- **Component / agent-rollout** column and the "Agent rollout n/m" tile - G6 (no component model). Omitted, not shown blank-and-fake.
- **Issue kinds** component-rollout-failed (G6), token-revoked (G4), envs-on-a-withdrawn-version (G5), and degraded-observed (needs a health grade the data lacks) - deferred with their backends.
- **Row-open / needs-attention-row navigation into hive detail** - hive detail is PA-7; PA-4 rows are informational, not dead buttons (no navigation wired yet).
- **The "Stand up a hive" primary action** - the provisioning wizard is PA-8; a primary action that goes nowhere is a forbidden dead control, so it is omitted until PA-8.
- **A dedicated fleet socket push** - PA-4 refreshes on the existing `environments-changed` event; a fleet-specific push is a G8-extension Feature.
- **Client combo filter and full column controls** - PA-15 (polish); the three segments ship now.

**Ruling 3 (derivation lives client-side, authority stays honest):** connection-state and issue derivation are presentation logic over facts the server reports (`lastSeen`, `ready`); deriving them in the VM (not the server) matches the prototype, keeps the server a testable join, and does not touch the honesty invariant (no capability is claimed - these are observations, explicitly labeled observed/read-only). The quiet threshold is a named VM constant (placeholder 6h) with a note that making it server-configurable is a later Feature.

## Goals

- **Server:** `GET /api/fleet` returns `FleetHiveDto[]` (operator-session-gated like every `/api` route). `FleetHiveDto = { id, displayName, tenant: {id, displayName}, client: {id, displayName} | null, clusterBackend, clusterMode, lastSeen: string | null, environments: { name: string, ready: boolean, image?: string, detail: string }[] }`. No internal refs. A control-plane test asserts the join (hive with/without observation, tenant/client names, lastSeen null vs set) and that no ref field leaks.
- **Portal client:** `ControlPlaneClient.ListFleet(): Promise<FleetHiveDto[]>`; `FleetHiveDto` mirrored in `portal-types.ts`.
- **`ObservedPanel`** kit primitive (`admin/portal/src/kit/observed-panel.ts`) + barrel export.
- **`FleetViewModel`** (`admin/portal/src/fleet-view-model.ts`, extends `Observable`): holds the rows, derives connection state / issues / tile counts / needs-attention ordering / segment filtering from the DTO + a quiet threshold + an injectable `now`.
- **`FleetView`** (`admin/portal/src/fleet-view.ts`): the Fleet home, wired into the shell at `ShowSection(PaSection.Fleet)`.
- Tests: the server join; the VM derivations (every connection state, the three issue kinds, tile counts, ordering, segment filter) with an injected clock; the view's states.

## Non-goals

- Any WRITE or command on hives/environments (Fleet observes, never commands - trust boundary).
- The deferred items in Ruling 2 (disconnected/token state, semantic app/version/status/health-grade, components/agent-rollout, the deferred issue kinds, hive-detail navigation, the "Stand up a hive" action, a dedicated fleet socket push, client combo, column controls).
- Hive detail / Tenant detail / Client detail screens (PA-7/PA-6/PA-5) - PA-4 is the Fleet home; it may reuse `ObservedPanel` which those will too.
- Changing `GET /api/hives` / the existing `HiveDto` or any RBAC.

## Anti-goals (a failure even if it "works")

- Fabricating a semantic application/version/status/health-grade the observation does not carry, or a `disconnected` state the backend cannot substantiate (reported != observed).
- A blank-but-present "Agent rollout" column/tile implying data that does not exist.
- A dead control: a "Stand up a hive" action, a needs-attention row, or a table row that navigates nowhere.
- An `ObservedPanel` that carries a button or an actionable control (breaks "observe, never command").
- Leaking an internal ref on the fleet DTO.
- Coupling `admin/portal` to `admin/tenant-portal`; inline user-facing literals.

## Information architecture (the decided shape)

- **Server (`control-plane-host.ts`):** add `GET /api/fleet` beside the other `/api` routes (session-gated). A `private BuildFleet(): FleetHiveDto[]` maps `this.directory.ListHives()` -> for each hive resolve tenant (`GetTenant`) and client (`GetClient` via `tenant.clientId`, `null` if missing), read `this.observations.Get(hiveId)` for `reportedAt` + environments, and map each `HiveHealthDto` to `{ name: environmentName, ready, image: runningImage, detail }`. Define `FleetHiveDto` (and its nested env type) in `control-plane-host.ts` or a small shared module; hoist the route path `/api/fleet`.
- **Portal types/client:** mirror `FleetHiveDto` in `portal-types.ts`; add `ListFleet()` to `api-client.ts` (a GET like `ListHives`).
- **`kit/observed-panel.ts`:** `ObservedPanel extends StackPanel` taking `{ title: string; note?: string; body: Visual }`; renders a dashed container, an `observed` `StatusPill` (PillKind.Observed), the (hoisted default) no-break-glass note, and the body; exposes no actions. Barrel export.
- **`fleet-view-model.ts`:** `FleetConnection` enum `{ Connected, Quiet, Awaiting }`; `FleetIssueKind` enum `{ Quiet, Awaiting, EnvironmentNotReady }`; a `FleetRow` presentation type (hive + tenant/client label + connection + lastSeenLabel + env count + issues + per-row tone). `FleetViewModel extends Observable`: ctor `(rows: FleetHiveDto[], now?: () => Date, quietThresholdMs?: number)`; getters for the derived rows, the tile counts, the needs-attention list (ordered), and a `Segment` filter (All / NeedsAttention / NotCheckingIn) seam. Hoisted constants for labels + the quiet threshold (6h). Connection derivation: `lastSeen === null` -> Awaiting; `now - lastSeen < threshold` -> Connected; else Quiet. `lastSeenLabel` like "Last check-in 3 min ago" / "Never dialled in".
- **`fleet-view.ts`:** `FleetView extends Tenant?`/the PA view base (there is no PA view base; the shell mounts a `Visual & IPortalView` - follow the `ComingSoonView` shape: implement `AttachNavigator`/`Refresh`). `Refresh()` calls `ListFleet()` and updates a `ScreenHost` (loading -> populated/empty). Populated content: `PageHeader` ("Fleet", sub "Every hive, read from its last check-in. Exceptions first.", no primary action), stat tiles, the needs-attention list (ordered; informational rows), and a `DataTable` over the rows with connection + health `StatusPill`s, last-seen text, env count, issues, per-row tone, search, and the three segment filters. Observed inventory presented through `ObservedPanel` where the design calls for it. Empty state "No hives yet...".
- **Shell (`app.ts`):** in `ShowSection`, route `PaSection.Fleet` to a `new FleetView(this.client)` instead of the `ComingSoonView`; keep every other section on its placeholder. Refresh the Fleet view on `OnChanged`.
- A minimal stat-tile rendering (label + value) - a small view-local helper or a tiny kit `StatTile`; builder's call, keep it text (value + label), not colour-only.
- Tests under `admin/portal/tests/` and `admin/control-plane/tests/`.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals (hoist to `private static readonly`), enums over unions (`FleetConnection`/`FleetIssueKind`/`Segment` are enums; DTO wire fields stay plain data), view models extend `Observable`, components extend their Mural base, `IDisposable` not lambdas, tests under `tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`0 0 N`). Existing files touched (`control-plane-host.ts`, `portal-types.ts`, `api-client.ts`, `app.ts`, `kit/index.ts`): check + MATCH current EOL, never flip. Escape non-ASCII as `\uXXXX`; re-scan after the Write tool.
- **Two gates, both green on the merged result:** control plane - from repo root `npx tsx --test admin/control-plane/tests/*.test.ts` AND `npm run typecheck:tools`; portal - in `admin/portal` `npm test` AND `npm run typecheck`.
- `admin/portal` must not import `admin/tenant-portal`. The fleet DTO leaks no internal ref. Fleet observes only - no command, no actionable control in `ObservedPanel`.

## Review focus (inputs no happy-path test exercises)

- A hive with NO observation record -> `lastSeen: null` -> Awaiting (first dial-in), never a crash or a false Connected. (Server + VM tests.)
- A hive whose `reportedAt` is older than the quiet threshold -> Quiet; just under -> Connected (test with an injected `now` on both sides of the boundary). (VM test.)
- An environment with `ready === false` -> an EnvironmentNotReady issue + a Failing health pill; needs-attention orders danger > warning > info. (VM test.)
- A hive whose tenant or client record is missing -> `client: null` / a safe label, never a crash. (Server + VM tests.)
- The fleet DTO carries no configRef/credentialRef/trustRootRef/agentTokenRef. (Server test.)
- `ObservedPanel` renders no actionable control. Empty fleet -> honest empty state. (View/kit tests.)
- No `admin/tenant-portal` import; no inline user-facing literal. (Diff review.)
