# PA-14 (Observed) - Platform Admin Rollout Status (actual fleet state vs selected target, read-only) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). Corresponds to reconciliation backlog spec 14 (Observed), the rollout-observability slice. ONE additive control-plane read + a Release Policy section. Non-security (authoritative rollout state, no secrets), in the PA-8R/PA-9 additive-read pattern.
**Area:** Platform Admin portal (`admin/portal/`) + one additive control-plane read route.
**Builds on:** PA-9 Release Policy (`ReleasePolicyView`/`ReleasePolicyViewModel`, gating + selections), PA-4 `FleetHiveDto` + `FleetViewModel.OwnerLabel`, PA-1 kit (`DataTable`, `Section`, `PillKinds`), the PA-8R/PA-9 additive-read shape.

## Context

Release Policy (PA-9) shows the deployment INTENT: which versions each tenant may adopt (gating allowlist) and which target each hive is SET to (selections). It does NOT show REALITY: whether each hive's environments are actually running that target yet.

Backend today: `PlatformDeploymentRegistry.StatusFor(hiveId): HiveRolloutStatus` already computes the authoritative per-hive rollout state:
- `HiveRolloutStatus = { targetVersion: string | undefined; environments: EnvironmentRolloutStatus[] }`
- `EnvironmentRolloutStatus = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }`
- `targetVersion` = the selected target's manifest id (via `TargetFor`: selection.targetVersion -> manifest; undefined if no selection or unknown manifest).
- `obsolete` = `target !== undefined && env.runningImage !== target.image` (the env is running something other than the selected target's image).
- `ready` = the env's reported readiness. Only OBSERVED environments appear (from `observations.LatestFor(hiveId)`); an env that never reported is absent.
- Explicitly documented "no secrets" (version/image refs + booleans only).
It is exposed per-hive at `GET /api/hives/:id/rollout`, but there is NO global read; the portal cannot see fleet-wide rollout state without N per-hive calls.

`this.directory.ListHives()` is the authoritative hive list (used by `BuildFleet`). The host already composes `directory` + per-hive state in `BuildFleet`, so a global rollout aggregate is a host composition, not a registry change.

## Recon findings (binding) + rulings

1. **ONE additive read `GET /api/rollouts`, host-composed, operator-gated (both roles), no secrets.** The host builds the aggregate: `this.directory.ListHives().map(h => ({ hiveId: h.id, targetVersion: s.targetVersion, environments: s.environments }))` where `s = this.deployments.StatusFor(h.id)`. Ruling: NO registry change (the host composes `directory.ListHives` + `deployments.StatusFor`, exactly as `BuildFleet` composes directory + observations). It is a normal safe GET allowed to BOTH roles (Full + ReadOnly) via the central gate - rollout status is operational metadata, not a disclosure surface (Observer already sees env images via `GET /api/fleet`). NOT added to `OperatorAuthorization.FullOnlyReadPaths` (that set stays operators-only). This is the only backend change.

2. **Authoritative server computation, surfaced honestly - never re-derived client-side.** The portal shows exactly what `StatusFor` reports (`targetVersion`, per-env `runningImage`/`obsolete`/`ready`). Ruling: do NOT re-derive `obsolete`/target in the portal from selections+manifests+fleet (that risks reported != enforced vs the server's truth); consume the authoritative read. reported==enforced; no fabricated fields.

3. **A "Rollout status" section added to the existing `ReleasePolicyView` (not a new nav section).** There is no "Rollouts" nav item and the nav set is fixed; rollout reality is the natural complement to Release Policy's intent (gating + selections), so it is a third `Section` on that single-screen view. Ruling: enhance `ReleasePolicyView`/`ReleasePolicyViewModel`, do NOT add a nav section or a new routed view.

4. **Rollout table (per hive x observed environment):** columns Hive (`displayName` from fleet), Client / tenant (owner via the shared `FleetViewModel.OwnerLabel`), Environment (`environmentName`), Target version (`targetVersion` or a "No target" label when undefined), Running (`runningImage` or an "Not reported" label when undefined), Status. Status is derived ONLY from the authoritative flags: `targetVersion === undefined` -> "No target"; else `obsolete` -> "Behind target" (Warn tone); else `ready` -> "On target" (Healthy tone); else "Not ready" (Warn/neutral tone). Rows = every (hive, observed-env) pair across all hives; a hive with no observed envs contributes no rows (honest - nothing to show). Join hiveId -> fleet for displayName + owner ("(unknown hive)" if absent, like PA-9's target table - do not drop). Stable sort by hive then environment. Search over hive/owner/env/version.

5. **Empty / honesty.** When there are no rollout rows (no observed envs anywhere) the section shows an honest empty note, not a fabricated "all healthy". The section coexists with the existing gated/selected sections; the screen's overall empty state (PA-9) already keys on gated+selected being both empty - rollout rows do NOT change that keying in v1 (a screen with only rollout data but no gating/selections is an edge the PA-9 empty logic can keep as-is; document it). Actually: extend the screen's non-empty condition to also count rollout rows so a fleet with rollouts but no gating/selections is not shown as empty.

6. **Reuse.** `FleetViewModel.OwnerLabel` (owner single home), the fleet/manifest/selection lists already fetched by ReleasePolicy (fleet is already fetched for owner labels), the kit `DataTable`/`Section`/`PillKinds`. The rollout read is the one new fetch added to the view's existing `Promise.all`.

## Goals

- Surface authoritative fleet-wide rollout reality (per hive x environment: target version, running image, on-target/behind/not-ready) next to Release Policy's intent, via one additive non-secret read.
- Make it obvious whether a selected target has actually rolled out, without per-hive drilling.

## Non-goals / deferred (filed as Features)

- Per-hive rollout drill-in / a dedicated Rollouts nav section (no nav home; the global section covers v1).
- Rollout HISTORY / timeline / an adoption ledger (G9 - no stored history; only the latest snapshot exists).
- Any rollout MUTATION (trigger/retry/pause a roll) - the operator plane has no such action; selection is agent/server-driven.
- Showing environments that never reported (no observation = no row; not fabricated as "pending").
- Changing the per-hive `GET /api/hives/:id/rollout` route or any write path.

## Anti-goals (a failure even if it "works")

- Re-deriving `obsolete`/target client-side instead of using the server's authoritative `StatusFor` (reported != enforced risk).
- Fabricating a status for an unobserved env, or showing "On target" when there is no target (must be "No target").
- Dropping a rollout row whose hive is absent from the fleet (show "(unknown hive)").
- Exposing any secret or internal ref (StatusFor carries none; keep the DTO to {hiveId, targetVersion, environments:[{environmentName, runningImage, obsolete, ready}]}).
- Gating `/api/rollouts` to Full-only (it is non-secret operational state; both roles, like fleet/gating/selections). Color-only status; inline literals; cross-app import.

## Information architecture (decided shape)

Control plane (`admin/control-plane/`):
- `control-plane-host.ts` - add `RolloutsAllPath = '/api/rollouts'`; a GET arm in `RouteApi` (exact-path) returning `this.directory.ListHives().map(h => { const s = this.deployments.StatusFor(h.id); return { hiveId: h.id, targetVersion: s.targetVersion, environments: s.environments } })` as JSON. Add a `HiveRolloutsDto`/entry type alias if helpful (the element shape). No `OperatorAuthorization` change (safe GET, both roles). No registry change.

Portal (`admin/portal/src/`):
- `portal-types.ts` - add `EnvRolloutDto = { environmentName: string; runningImage?: string; obsolete: boolean; ready: boolean }` and `HiveRolloutDto = { hiveId: string; targetVersion?: string; environments: EnvRolloutDto[] }`.
- `api-client.ts` - add `ListRollouts(): Promise<HiveRolloutDto[]>` (GET `/api/rollouts`), mirroring `ListSelections`.
- `release-policy-view-model.ts` - extend: ctor/`Update` also take `rollouts: readonly HiveRolloutDto[]`; derive `RolloutRow[]` (`{ hiveName, ownerLabel, envName, targetLabel, runningLabel, statusLabel, statusKind }`) by flattening hive x env, joining hiveId -> fleet for name+owner (FleetViewModel.OwnerLabel; "(unknown hive)"/"(unassigned)" fallback), mapping status per finding 4; stable sort hive then env; dates n/a. Add `RolloutRows` getter + `RolloutRowsProperty` change key. Extend the non-empty condition to include rollout rows.
- `release-policy-view.ts` - add a third "Rollout status" `Section` (fresh slot per render) wrapping a `DataTable<RolloutRow>` (cols Hive, Client/tenant, Environment, Target version, Running, Status[pill: On target/Behind target/Not ready/No target]); include it in the 3-way (now 4-way with rollouts) `Promise.all`; the honest empty note covers the all-empty case.

Tests:
- Control-plane (`admin/control-plane/tests/`, `npx tsx --test`): `GET /api/rollouts` returns, for each hive, `{ hiveId, targetVersion, environments }` with the authoritative flags (seed a hive with a selection + an observation whose image != target -> obsolete true; == target + ready -> on-target; no selection -> targetVersion undefined, obsolete false); authenticated (both roles get 200 - add a ReadOnly-200 case to prove it is NOT Full-gated); unauth -> 401; the DTO carries no field beyond the four env keys + hiveId/targetVersion.
- Portal (`admin/portal/tests/`): `release-policy-view-model.test.ts` - rollout rows flattened + joined + status mapping (behind/on-target/not-ready/no-target; unknown hive -> "(unknown hive)"); `release-policy-view.test.ts` - the Rollout status section renders rows; a fetch including rollouts but no gating/selections is NOT empty; a SECOND `Refresh()` is safe.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `tests/`.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`). `control-plane-host.ts` has 6 PRE-EXISTING non-ASCII bytes - add none. Match EOL.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` (admin/portal). BOTH green on the merged result.
- `/api/rollouts` is non-secret and BOTH-role (NOT in FullOnlyReadPaths); authoritative server state only; no re-derivation; no fabricated rows/status.
- No cross-app import; status shown as icon+text (pill); stateful view survives a second `Refresh()` (fresh section slot).

## Review focus (inputs no happy-path test exercises)

- A hive with a selection but an env running a DIFFERENT image -> "Behind target" (obsolete true). (CP + VM tests.)
- A hive with NO selection -> targetVersion undefined -> "No target", NOT "On target", and obsolete false for its envs. (CP + VM.)
- A rollout row whose hiveId is absent from the fleet -> "(unknown hive)", row kept. (VM.)
- An env with `runningImage` undefined (reported but imageless) -> "Not reported" running label, not "undefined". (VM.)
- `/api/rollouts` reachable by a ReadOnly operator (200), unauth -> 401. (CP host tests - prove it is NOT Full-gated.)
- A fleet with rollout rows but zero gating/selections -> screen NOT shown as empty. (View test.)
- A second `Refresh()` re-renders the three sections with no double-parent. (View test.)
