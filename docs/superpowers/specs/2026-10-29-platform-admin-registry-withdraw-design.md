# PA-R2 - Platform Admin Registry Withdraw/Restore (manifest lifecycle write) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; user chose "PA-R2 withdraw/restore" at the backend-vs-polish fork). Proceeds to plan + SDD. Completes the manifest lifecycle UI begun in PA-R1 (publish). The backend endpoints already exist and are already Full-operator-only via the central gate; this spec wires a Full-gated Withdraw/Restore action to them. No new backend, no new route, no authorization rule, no kit primitive.
**Area:** Platform Admin portal (`admin/portal/`) only. Control-plane tests MAY gain a gate-lock case; no control-plane source change.
**Builds on:** PA-R1 (the registry-write pattern: `operator.MutatingAct` -> Full-gated `Act`, re-fetch after write, no optimistic mutation; `ReleasesView` already takes `operator`), PA-8R Registry READ (`ReleaseDetailView` already renders the read-only withdrawn banner + status), PA-15 `SectionContainerView` (`ReleasesView` extends it; `ShowDetail(row)` is public and re-fetches via `BuildDetail`).

## Context

PA-R1 added manifest PUBLISH and tenant GATE/UNGATE. The one manifest-lifecycle write it deliberately deferred is WITHDRAW/RESTORE. The backend is already there:

- `POST /api/manifests/:version/withdrawn` -> `deployments.SetWithdrawn(version, true)` -> returns the updated `ManifestDto`; `DELETE` -> `SetWithdrawn(version, false)` (restore); `404` for an unknown version (`RouteManifestWithdrawn`, `control-plane-host.ts`).
- `SetWithdrawn` is REVERSIBLE: a withdrawn version stays published and gated, just flagged `withdrawn: true` for the UI (hives stop seeing it as adoptable after their next check-in; environments already running it keep running).

The portal already SHOWS this state read-only: `ReleaseDetailView` renders `ReleaseDetailViewModel.WithdrawnBanner` (a warning banner) and a "Status: Published/Withdrawn" row in the profile. What's missing is the toggle. `ReleaseDetailView` is built in `ReleasesView.BuildDetail(row)`, and `ReleasesView` already carries `operator` (from PA-R1). `SectionContainerView.ShowDetail(row)` is public and re-runs `BuildDetail` (which re-fetches `ListManifests` + `ListFleet`), so re-showing the detail after a write re-renders with the server's authoritative new flag - no optimistic mutation needed.

## Recon findings (binding) + rulings

1. **Zero control-plane source change.** The withdraw/restore routes exist and are Full-gated by the central `OperatorAuthorization.Authorize` (any mutating method for a non-Full role -> 403, applied at `control-plane-host.ts:598` before routing). Ruling: add NO route, NO authz change. Add ONE control-plane rbac test case locking ReadOnly -> 403 on `POST` and `DELETE /api/manifests/:version/withdrawn` (the PA-R1 Task 5 loop covers publish + gating but NOT the withdrawn routes). Test-only.

2. **The action lives on `ReleaseDetailView` (per release), refreshed by re-showing the detail.** Ruling: add a single Full-gated `Act` to the detail view whose label/variant depend on the current state - "Withdraw version" (`ActVariant.Danger`) when published, "Restore version" (`ActVariant.Secondary`) when withdrawn. On success, re-show the detail via the container's `ShowDetail(row)` (re-fetches -> authoritative new state). Do NOT mutate the manifest/VM locally (reported == enforced; the re-fetch is the single source of truth).

3. **`ReleaseDetailView` gains `operator` + an async toggle callback; `ReleasesView.BuildDetail` supplies both.** Ruling: ctor becomes `(vm, onBack, operator, onToggleWithdrawn)` where `onToggleWithdrawn: (withdraw: boolean) => Promise<void>` is supplied by `BuildDetail` as `async (withdraw) => { await this.client.SetManifestWithdrawn(row.id, withdraw); await this.ShowDetail(row) }`. The view performs no fetch itself; it calls the callback and shows one error line on failure (mirrors PA-R1 `ReleasesView.Submit`). Full-gated via `operator.MutatingAct` so an Observer sees it disabled + hinted (== server 403).

4. **`ReleaseDetailViewModel` exposes `Withdrawn`.** Ruling: add `get Withdrawn(): boolean` (`this.manifest.withdrawn === true`) so the view knows which label/variant/target to use (it already derives the banner + status from the same flag; this is the same single source, surfaced for the action). No other VM change.

5. **Fresh slot per render / double-parent safety.** The action `Act` + the error line are rebuilt FRESH inside `ReleaseDetailView.BuildContent` every render (a Visual holds one parent); the view already rebuilds `tableSlot` fresh each `BuildContent`. The view must survive a re-render (it does today; the new Visuals follow the same rule).

## Goals

- Let a Full operator withdraw a published manifest version and restore a withdrawn one, from the release detail page, hitting the existing Full-gated endpoints.
- Keep the action visibly gated (Observer sees it disabled + hinted) and honest (re-fetch after the write; no optimistic flag flip).
- Complete the manifest lifecycle UI (publish from PA-R1 + withdraw/restore here) reusing the PA-R1 write pattern; add no backend route, authz rule, or kit primitive.

## Non-goals / deferred (filed as Features)

- A withdraw/restore action from the Releases LIST (per-row) - `DataTable` cells are text-only (no action column); the per-release detail is the home.
- A confirm dialog (no `ConfirmDialog` primitive; withdraw is reversible via restore, and the action is `Danger`-styled - the v1 safety, same ruling as PA-R1 gate/ungate).
- Bulk withdraw; withdraw reason/audit note (no backend field); showing who/when withdrew (no stored history - G9).
- Any change to publish/gating/other write paths.

## Anti-goals (a failure even if it "works")

- An Observer able to actually trigger withdraw/restore (must be disabled + hinted; the server 403s anyway, but the UI must not imply success).
- Optimistically flipping the withdrawn flag / banner before the server confirms (reported != enforced on rejection) instead of re-fetching.
- A withdraw action that does not reflect the authoritative new state after success (must re-show the detail, not patch the VM).
- Adding a per-row `DataTable` action column, a dialog/confirm primitive, a new route, or an `OperatorAuthorization` change under this spec.
- Inline user-facing literals; cross-app import; a detail view that double-parents on re-render.

## Information architecture (decided shape)

Portal (`admin/portal/src/`):

- `api-client.ts` - add `SetManifestWithdrawn(version: string, withdraw: boolean): Promise<ManifestDto>`: `withdraw` -> `POST`, else `DELETE`, to a hoisted `/api/manifests/:version/withdrawn` path builder (`ManifestWithdrawnRoute(version)` = `ManifestsRoute + '/' + encodeURIComponent(version) + '/' + 'withdrawn'`, the `'withdrawn'` segment hoisted). Returns the parsed `ManifestDto`. Mirror the existing `Send` write methods.

- `release-detail-view-model.ts` - add `get Withdrawn(): boolean` returning `this.manifest.withdrawn === true` (the same flag the banner/status already read). No other change.

- `release-detail-view.ts` - ctor becomes `(vm, onBack, operator: OperatorContext, onToggleWithdrawn: (withdraw: boolean) => Promise<void>)`. In `BuildContent`, add (near the profile/banner) a Full-gated `Act` built fresh each render: label `WithdrawLabel`/`RestoreLabel` and variant `Danger`/`Secondary` chosen from `vm.Withdrawn`; onClick -> `void this.Toggle()`. `Toggle()`: `try { await this.onToggleWithdrawn(!this.vm.Withdrawn) } catch { set a fresh error line }`. Add a fresh error `TextBlock` per render. Hoist all labels/text.

- `releases-view.ts` - `BuildDetail(row)` passes `this.operator` and `onToggleWithdrawn = async (withdraw) => { await this.client.SetManifestWithdrawn(row.id, withdraw); await this.ShowDetail(row) }` to `new ReleaseDetailView(...)`. (`ShowDetail` is the public base method; it re-fetches via `BuildDetail`.)

Control plane (`admin/control-plane/`): tests only. Extend the PA-R1 rbac registry-write test (or add a focused case): a ReadOnly operator gets 403 on `POST /api/manifests/:version/withdrawn` and on `DELETE` of the same (empty body for the DELETE, matching the portal's bodiless restore).

Tests:

- Portal (`admin/portal/tests/`):
  - `api-client-platform.test.ts` - `SetManifestWithdrawn('1.0.0', true)` issues `POST /api/manifests/1.0.0/withdrawn` and returns the parsed `ManifestDto`; `SetManifestWithdrawn('1.0.0', false)` issues `DELETE` of that path; a version needing encoding (`a/b`) is path-encoded.
  - `release-detail-view(-model).test.ts` - `Withdrawn` getter true/false; the detail view shows a "Withdraw version" action (Danger) for a published manifest and "Restore version" for a withdrawn one; for an Observer the action is disabled with a non-empty hint; clicking (as Full) calls `onToggleWithdrawn(!withdrawn)`; a thrown toggle shows one error line and does not crash. Prefer testing `ReleaseDetailView` with an injected `onToggleWithdrawn` spy (its natural seam), plus a `ReleasesView` test that the wired callback calls `SetManifestWithdrawn(row.id, ...)` then re-shows the detail (a second `ListManifests` fetch).
- Control-plane (`admin/control-plane/tests/`, `npx tsx --test`): ReadOnly -> 403 on `POST` and `DELETE /api/manifests/:version/withdrawn`.

## Constraints (inherited, binding)

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (the `'withdrawn'` path segment, action labels, error text).
- New/edited `.ts`: pure ASCII, LF. Byte-scan every written `.ts` -> `0 0 N`. `control-plane-host.ts` is NOT a source target (keeps its 6 pre-existing non-ASCII); if any CP source is touched, add none. Match EOL (all LF).
- HONESTY: reported == enforced. The action is gated with `operator.MutatingAct`; NO optimistic flag flip; re-fetch (re-show the detail) after the write. No secret/internal ref (the route carries only the version).
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.
- No cross-app import; the detail view survives a re-render (fresh slot per render); add no kit primitive, no route, no authorization rule.

## Review focus (inputs no happy-path test exercises)

- An Observer (ReadOnly) on a release detail -> the Withdraw/Restore action is VISIBLE but disabled + hinted (never hidden, never enabled). (Detail-view test + CP 403 test.)
- A published manifest shows "Withdraw version" (Danger) targeting `withdraw=true`; a withdrawn one shows "Restore version" targeting `withdraw=false`. (Detail-view + VM tests - the label/variant/target must track `vm.Withdrawn`, not be hardcoded.)
- A failing toggle (server rejects / network error) -> one error line, the detail stays put, no crash, no local flag flip. (Detail-view test with a rejecting callback.)
- After a successful toggle, the detail reflects the SERVER's new state via a re-fetch (re-show), not a patched VM. (ReleasesView wiring test: `SetManifestWithdrawn` then a second `ListManifests`.)
- A restore `DELETE` is sent with no body (matches the portal client) and a version needing URL-encoding is encoded. (api-client test.)
- The detail view re-rendered (e.g. after the toggle re-show) does not double-parent its action/error Visuals. (Detail-view render-twice test.)
