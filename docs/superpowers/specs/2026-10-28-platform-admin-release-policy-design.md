# PA-9 - Platform Admin Release Policy v1 (current gating + selection, read-only) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). Corresponds to reconciliation backlog spec 10 (Release Policy v1 on today's model). Two small additive control-plane reads + portal UI.
**Area:** Platform Admin portal (`admin/portal/`) + two additive control-plane read routes.
**Builds on:** PA-1 kit (`ScreenHost`, `PageHeader`, `Section`, `DataTable`, `Banner`, `PillKinds`), PA-4 `FleetHiveDto`, PA-5 `PortalDates.Label`, PA-8R `ManifestDto`/registry read pattern.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.7 (Release Policy), 3 (G5), 6 (spec 10).

## Context

The `Release Policy` nav section (`PaSection.ReleasePolicy`, label "Release Policy", under the "Releases" heading) mounts the `ComingSoonView` placeholder (app.ts falls through to it). The portal `api-client.ts` has no gating/selection calls.

Backend today (control-plane): the deployment model is a FLAT one, not the designed scoped-rules model:
- `GatingRecord { id, tenantId, version, gatedAt }` - a per-TENANT allowlist of versions a tenant's hive may adopt. Mutated by `POST /api/tenants/:id/gating` (Gate) and `DELETE /api/tenants/:id/gating/:version` (Ungate). There is NO GET for gating - the portal cannot read the allowlist today.
- `SelectionRecord { id, hiveId, targetVersion, selectedAt }` - the LATEST target version a hive is set to (overwritten each selection; no history). No read route.
- `GET /api/hives/:id/rollout` -> `HiveRolloutStatus { targetVersion, environments: [{ environmentName, runningImage, obsolete, ready }] }` (per-hive; exists).

The designed Release Policy (recon 1.7) is a different, richer model: scoped rules (default / client / hive) with channel, minimum version, blocked versions, hold-until + note, last-edited-by/at, an "Effect" preview, and an "Adoption ledger" (time, hive, env, from, to, outcome adopted/gated-out/roll-failed, note). NONE of that exists server-side (GAP G5): no policy entity, no scope hierarchy, no channel/min/blocked/hold, no editor audit, no ledger, no stored gated-out/roll-failed outcomes.

## Recon findings (binding) + rulings

1. **Two small additive server reads: `GET /api/gating` and `GET /api/selections`.** Add `PlatformDeploymentRegistry.AllGating(): readonly GatingRecord[]` (returns `this.gating.List()`) and `AllSelections(): readonly SelectionRecord[]` (returns `this.selections.List()`), and two GET route arms returning those lists. Read-only, operator-gated (GET passes `OperatorAuthorization` for every role via the central gate), NO secrets (both records carry only ids, a version string and a timestamp). This is the only backend change. Ruling: additive reads only - do NOT touch Gate/Ungate/SelectTarget or add policy fields (those are G5, deferred).

2. **Read-only v1, honestly labelled as the CURRENT model - no editing, no designed-policy pretence.** The screen surfaces exactly what exists: which versions each tenant is allowed to adopt (gating allowlist), and which target each hive is set to (selection). Ruling: an honest `Banner` states this is the current gating + selection model and that scoped rules, channel/minimum/blocked/hold, the effect preview, and the adoption ledger are not yet available. DEFERRED (filed as G5 Features): the entire scoped-rule editor (default/client/hive, channel, min version, blocked, hold + note, effect preview), the adoption ledger, gated-out/roll-failed outcomes, edit/add/remove rule actions.

3. **Single-screen view, not a self-routing container.** No detail drill-in in v1 (cross-section nav is still deferred). `ReleasePolicyView` is one `ScreenHost` screen (loading/empty/error) wrapping a `PageHeader` + the honest `Banner` + two `Section`s each wrapping a `DataTable`. This deliberately avoids adding a fifth copy of the self-routing section container.

4. **Gated versions table (per tenant):** columns Client / tenant (resolved from `tenantId` via `ListClients`/`ListTenants`; "(unknown)" fallback), Version (`version`), Gated (`PortalDates.Label(gatedAt)`). Rows = every `GatingRecord`. Search over client/tenant name + version. Empty text when no gates. Sorted by client/tenant then version (stable).

5. **Selected targets table (per hive):** columns Hive (`displayName` from fleet), Client / tenant (owner label via the shared `FleetViewModel.OwnerLabel`), Target version (`targetVersion`), Selected (`PortalDates.Label(selectedAt)`). Rows = every `SelectionRecord`, joined to `ListFleet` for hive + owner names ("(unknown hive)" when the hive id is not in the fleet - honest, do not drop the row). Search over hive/owner + target. Empty text when no selections.

6. **Reuse.** `PortalDates.Label` (dates), `FleetViewModel.OwnerLabel` (hive owner label single home), the fleet/tenant/client lists the portal already fetches, the kit `DataTable`/`Section`/`Banner`/`PageHeader`/`ScreenHost`. No new helper needed. Per-env rollout status (`GET /api/hives/:id/rollout`, running/obsolete per env) is a richer per-hive fan-out - DEFERRED from v1 (a future per-hive drill-in or a global rollout read).

## Goals

- Replace the Release Policy placeholder with a read-only screen that honestly surfaces the current gating allowlist (by client/tenant) and the current selected target per hive, on existing data plus two additive reads.
- Be unambiguous that this is the current flat model, not the designed scoped-policy editor or ledger.

## Non-goals / deferred (filed as Features - G5)

- The scoped-rule editor: default/client/hive scope, channel, minimum version, blocked versions, hold-until + note, last-edited audit, the live "Effect" preview, add/edit/remove rule drawers.
- The adoption ledger (time/hive/env/from/to/outcome/note), gated-out / roll-failed outcomes - no history or outcomes are stored.
- Any gating/selection MUTATION from this screen (Gate/Ungate/SelectTarget exist but editing policy is the G5 editor's job).
- Per-env rollout status (running/obsolete) and per-hive rollout drill-in.
- Cross-section nav links (gating row -> release/tenant; selection row -> hive). Needs a shared navigator; deferred.
- Any change to the gating/selection WRITE paths, the rollout route, legacy views, or the control-plane model.

## Anti-goals (a failure even if it "works")

- Presenting this as the designed scoped-policy editor, or showing channel / minimum version / blocked / hold / effect-preview / ledger fields that have no backing data (fabricating a backend).
- An edit/add/remove rule control, or a Gate/Ungate button, that has no honest designed-policy backend or would be reported-not-enforced.
- Dropping a selection row whose hive is not in the fleet (hide real state) instead of showing "(unknown hive)".
- Colour-only status; a control not keyboard-reachable; inline user-facing literals; importing `admin/tenant-portal`; surfacing any secret or raw internal ref.

## Information architecture (decided shape)

Control plane (`admin/control-plane/`):
- `platform-deployment-registry.ts` - add `public AllGating(): readonly GatingRecord[]` (`return this.gating.List()`) and `public AllSelections(): readonly SelectionRecord[]` (`return this.selections.List()`). Import the `GatingRecord`/`SelectionRecord` types as needed.
- `control-plane-host.ts` - add two route constants (`GatingAllPath = '/api/gating'`, `SelectionsAllPath = '/api/selections'`) and two GET arms in `RouteApi` returning `[...this.deployments.AllGating()]` / `[...this.deployments.AllSelections()]` as JSON. No other change; the per-scope gating/rollout routes are untouched.

New files under `admin/portal/src/`:
- `portal-types.ts` - add `GatingDto = { tenantId: string; version: string; gatedAt: string }` and `SelectionDto = { hiveId: string; targetVersion: string; selectedAt: string }`. (Omit the server `id` field; it is a composite key the UI does not use.)
- `api-client.ts` - add `ListGating(): Promise<GatingDto[]>` (GET `/api/gating`) and `ListSelections(): Promise<SelectionDto[]>` (GET `/api/selections`), mirroring `ListManifests` (no-arg GET), with hoisted route constants.
- `release-policy-view-model.ts` - `ReleasePolicyViewModel extends Observable`. From `(gating, selections, tenants, clients, fleet)` derives `GatedRow[]` (`{ ownerLabel, version, gatedLabel }`) and `TargetRow[]` (`{ hiveName, ownerLabel, targetVersion, selectedLabel }`). Owner label for a gate = client/tenant name resolved from `tenantId` (join tenant->client; "(unknown)" fallback); for a selection = hive displayName + `FleetViewModel.OwnerLabel` (hive found in fleet, else hiveName "(unknown hive)" + owner "(unassigned)"). Dates via `PortalDates.Label`. `Rows`-style getters `GatedRows`/`TargetRows`; `Update(...)` raising change keys. Stable sort (gated by owner then version; targets by hive).
- `release-policy-view.ts` - `ReleasePolicyView extends StackPanel implements IPortalView`, `constructor(client)`. `ScreenHost` (loading/empty[when BOTH tables empty]/error[onRetry]/populated). Populated: `PageHeader` (breadcrumb ['Releases', 'Release Policy'], title 'Release Policy') + honest `Banner` (Info, the current-model note) + "Gated versions" `Section` wrapping a fresh `DataTable<GatedRow>` + "Selected targets" `Section` wrapping a fresh `DataTable<TargetRow>`. `Refresh()` re-fetches. Fresh table slots per render (second-Refresh safe). Seams `Host`, `GatedTable`, `TargetTable`.

Modified:
- `app.ts` - `ShowSection(PaSection.ReleasePolicy)` mounts `new ReleasePolicyView(this.client)` before the `ComingSoon` fallback; update the `shell-app.test.ts` routing expectation (Release Policy -> ReleasePolicyView, not ComingSoon).

Tests: control-plane `admin/control-plane/tests/` (`npx tsx --test`): `GET /api/gating` and `GET /api/selections` return all records incl. empty-list, authenticated (add to the manifests/rollout host test file + `platform-deployment-registry.test.ts` unit for the two accessors). Portal `admin/portal/tests/` (`node:test`, `Application.current` harness): `release-policy-view-model.test.ts`, `release-policy-view.test.ts` (populated both tables; both-empty -> empty state; fetch-reject -> error with working onRetry; unknown tenant -> '(unknown)'; selection for a hive not in fleet -> '(unknown hive)' row still shown; missing date -> 'Unknown'; a SECOND `Refresh()` re-renders with no double-parent).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `tests/` subfolders.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`), re-scan after any `\uXXXX`. Match EOL of touched files.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools` (root); portal `npm test` + `npm run typecheck` in `admin/portal`. Both green on the merged result.
- Every actionable control keyboard-reachable; status icon + text; no cross-app import; no secret or raw internal ref exposed; never fabricate scoped-rule/channel/ledger data.
- Stateful view MUST survive a second `Refresh()` (fresh table slots per render).

## Review focus (inputs no happy-path test exercises)

- A gate whose `tenantId` matches no tenant (or whose tenant matches no client) shows "(unknown)", not blank/undefined. (VM test.)
- A selection whose `hiveId` is not in the fleet shows "(unknown hive)" and is NOT dropped. (VM + view tests.)
- Both tables empty -> the screen shows the empty state, not two empty tables with no explanation. (View test.)
- Missing/empty `gatedAt`/`selectedAt` -> "Unknown" via `PortalDates.Label`, never "Invalid Date". (VM test.)
- No scoped-rule / channel / min-version / hold / ledger field, and no edit/Gate/Ungate control, appears anywhere. (View test / review.)
- A second `Refresh()` re-renders without a double-parent throw. (View test.)
