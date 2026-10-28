# PA-8R - Platform Admin Registry & Releases (read side) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). Ships IN PLACE of the PA-8 provisioning wizard, which is deferred (see "Why not the wizard" below). Corresponds to reconciliation backlog spec 8 (Registry and Releases, read side). Small additive server read + portal UI.
**Area:** Platform Admin portal (`admin/portal/`) + one additive control-plane read route.
**Builds on:** PA-1 kit (incl. `ObservedPanel`, `Banner`, `DataTable`, `PageHeader`, `KeyValueGrid`), PA-4 `FleetViewModel`/`FleetHiveDto`, PA-5 `PortalDates.Label`, PA-6/PA-7 self-routing section pattern (`TenantsView`/`HivesView`).
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.6 (Registry and Releases), 3 (G2/G3/G8), 6 (spec 8).

## Why not the wizard (PA-8 deferral ruling, binding)

The designed "Stand up a hive" bootstrap wizard (recon 1.5; backlog spec 6; backend GAP G1 - the largest single item) is DEFERRED as backend-blocked. Two independent recon passes confirm:

- The bootstrap bundle builder is LIBRARY-ONLY: `tenant-admin-bootstrap.ts` `GenerateBootstrap` renders an in-memory manifest + secret set but is wired to NO operator HTTP route (used only by smoke scripts/tests). There is NO digest, NO byte-size, NO download-name, NO RBAC list, NO install-commands string anywhere. The wizard Review / Bootstrap / First-dial-in steps have no honest data source.
- `HiveRecord` has NO awaiting/connected lifecycle state and NO namespace / baseDomain / region / cluster-target fields (G1/G10).
- One-tenant-one-hive is NOT enforced server-side at create (G10).
- The portal client cannot call `rollout-registration` at all; `CreateTenant` omits the now-required `ownerEmail` (would 400) and the portal `TenantDto` discards the one-time owner password.

Building the wizard against today's surface would fabricate a bundle/digest/install-commands and surface internal refs - the two named anti-goals. Deferred as filed Features: G1 (bundle endpoint: package manifest/chart + trust-root public key + pull ref, return download + digest + RBAC + install commands; mint one-time token; awaiting-first-dial-in state), G10 (1:1 invariant + unified provisioning record + hive target fields), trust-root fingerprint exposure. NOTE for a future small spec: `POST /api/tenants` (one-time owner password) and `POST /api/hives/:id/rollout-registration` (one-time raw agent token, `no-store`, hash stored) ARE honest one-time-secret producers today - they can anchor the deferred `OnceSecret` primitive when their screens (tenant provisioning / hive re-issue) are built.

## Context

The `Registry` nav section (`PaSection.Registry`, label "Registry & Releases") mounts the `ComingSoonView` placeholder (app.ts falls through to it). The portal `api-client.ts` has NO manifest calls at all.

Backend today (control-plane): `POST /api/manifests` publishes a bare `ManifestRecord` `{ id, image, notes?, publishedAt, withdrawn? }` (no channel, no signing, no digest, no build source); `POST /api/manifests/:version/withdrawn` + `DELETE` set/clear the `withdrawn` boolean (no reason/actor/timestamp); `GET /api/(tenants|hives)/:id/manifests` returns gated-filtered per-scope lists. There is NO global `GET /api/manifests` (list-all). `ManifestRegistry extends JsonRecordStore<ManifestRecord>` whose `List()` already enumerates all records, so a global read is trivial and additive.

## Recon findings (binding) + rulings

1. **One small additive server read: `GET /api/manifests`.** Add `PlatformDeploymentRegistry.AllManifests(): readonly ManifestRecord[]` returning `this.manifests.List()`, and a GET branch at the existing `ManifestsPath` in `control-plane-host.ts` (currently POST-only) returning that list. Read-only, operator-gated (GET passes `OperatorAuthorization` for ReadOnly), returns NO secrets (`ManifestRecord` carries none). This is the only backend change. Ruling: additive read endpoint only - do NOT touch the publish/withdraw paths, do NOT add channel/signing/digest/reason fields (those are G2/G3, deferred).

2. **Adoption spread is derived client-side from observed data - no extra endpoint.** Each `ManifestRecord` has an `image` reference; each `FleetHiveDto` environment (`FleetEnvDto`) has an observed `image`. Per-version adoption = the observed environments across `ListFleet()` whose env `image === manifest.image`. This is honest ("observed") and needs only the `ListFleet()` the portal already consumes. Ruling: label adoption strictly as observed; a version no running env reports shows "Not observed running", never "0 adoptions" as if authoritative.

3. **`ReleasesView` is a self-routing section container** (modes List / Detail - NO publish, NO withdraw/restore), mirroring `HivesView`: mounted at `ShowSection(PaSection.Registry)`, swaps list<->detail via a content host rebuilt fresh each render, nav stays on "Registry & Releases".

4. **List columns = existing data only:** Version (`id`), Status (Published / Withdrawn pill), Image (`image`, reference string - not a secret), Published (`PortalDates.Label(publishedAt)`), Running (observed adoption: "N environment(s)" or "Not observed running"). Search over version id + image. Row open -> detail. DEFERRED columns: Channel (Stable/Early access - G2, not in record), Signed (no signing data in record - must NOT fabricate a Signed pill), adoption "hives/envs" split beyond the observed env count.

5. **Detail = existing data only.** `PageHeader` (breadcrumb "Registry & Releases / <version>"); a CONDITIONAL withdrawn `Banner` (Warning: the version is withdrawn, honest copy - "Hives stop seeing this version as adoptable after their next check-in. Environments already running it keep running it until their tenant adopts another version."); a "Release" `Section`/`KeyValueGrid` (Version, Image, Published, Status, "What's new" = `notes` or "(none)"); then an `ObservedPanel` "Where it runs" wrapping a `DataTable` of the observed environments running this image (columns Hive, Client / tenant, Environment, Status [Healthy/Failing pill]). DEFERRED: digest/signature/provenance panel (G2, no data), withdraw/restore actions + name-to-confirm `ConfirmDialog` (deferred primitive; needs reason/actor/timestamp server fields - G3), channel.

6. **Reuse.** `PortalDates.Label` for Published; `PillKinds`/`StatusPill` for Status + env health; the self-routing container + fresh-slot-per-render discipline from `HivesView`/`TenantsView`; `FleetHiveDto`/`FleetEnvDto` for observed adoption. The "Where it runs" env table has DIFFERENT columns from `ObservedEnvTable` (it adds Hive + owner), so it is its own small table, not that helper.

## Goals

- Replace the Registry placeholder with a kit Registry & Releases list + release detail, on existing data, honest about what is observed (adoption) vs not-yet-available (signing, channel, digest).
- Make per-version observed adoption visible ("Where it runs") via an `ObservedPanel`.
- Add the one missing read endpoint (`GET /api/manifests`) so the portal can list all published versions.

## Non-goals / deferred (filed as Features or later specs)

- Publish drawer: build picker, channel, "What's new" input, signing with the platform release key, "Sign and publish" async op - **G2** (write side).
- Withdraw / restore dialogs (name-to-confirm `ConfirmDialog` + consequences) and the reason/actor/timestamp the design shows - deferred primitive + **G3** server fields.
- Signature & provenance panel, digest display, channel (Stable / Early access), "Signed" column/pill - **G2/G3** (no data; fabricating them is the anti-goal).
- Adoption "hives on it / envs on it" authoritative counts beyond observed env matching - needs **G8-ext**.
- The provisioning wizard (**G1 + G10**), tenant-create OnceSecret flow, hive re-issue OnceSecret.
- Any change to the publish / withdraw write paths or to legacy views.

## Anti-goals (a failure even if it "works")

- A "Signed" pill, channel label, digest, or provenance block with no backing data - fabricating a backend.
- A Publish / Withdraw / Restore control that is present but cannot honestly complete, or that does nothing.
- Presenting observed adoption as an authoritative count ("0 adoptions") rather than "Not observed running".
- Colour-only status; a control not keyboard-reachable; inline user-facing literals; importing `admin/tenant-portal`; surfacing any raw internal ref.

## Information architecture (decided shape)

Control plane (`admin/control-plane/`):
- `platform-deployment-registry.ts` - add `public AllManifests(): readonly ManifestRecord[]` returning `this.manifests.List()`.
- `control-plane-host.ts` - at the existing `ManifestsPath` branch, serve `GET` (return `[...this.deployments.AllManifests()]` as `ManifestDto[]`) in addition to the existing `POST` publish. No other change.

New files under `admin/portal/src/`:
- `portal-types.ts` - add `ManifestDto = { id: string; image: string; notes?: string; publishedAt: string; withdrawn?: boolean }`.
- `api-client.ts` - add `public async ListManifests(): Promise<ManifestDto[]>` hitting `GET /api/manifests` (new `ManifestsRoute` constant).
- `releases-view-model.ts` - `ReleasesViewModel extends Observable`. From `(manifests: ManifestDto[], fleet: FleetHiveDto[])` derives `ReleaseListRow { id, image, withdrawn, publishedLabel, observedEnvCount }`; `observedEnvCount` = count of fleet envs whose observed `image === manifest.image`. `Rows`, `Update(manifests, fleet)` raising `RowsProperty`. Newest-first by `publishedAt` (stable).
- `release-detail-view-model.ts` - `ReleaseDetailViewModel extends Observable`. From `(manifest: ManifestDto, fleet: FleetHiveDto[])` derives header fields (version id, withdrawn), `WithdrawnBanner { show, tone, text }`, `Profile: KeyValueItem[]` (Version, Image, Published, Status, What's new), and `AdoptionRows: readonly ReleaseAdoptionRow[]` (`{ hiveName, ownerLabel, envName, ready }`) = every fleet env whose observed `image === manifest.image`, carrying its hive displayName + owner label. Seams `Profile`, `WithdrawnBanner`, `AdoptionRows`.
- `release-detail-view.ts` - `ReleaseDetailView extends StackPanel`, `constructor(vm, onBack)`. `ScreenHost` populated -> Back + `PageHeader` + conditional `Banner` (only `vm.WithdrawnBanner.show`) + "Release" `Section`/`KeyValueGrid` + `ObservedPanel` "Where it runs" wrapping a fresh `DataTable<ReleaseAdoptionRow>` (cols Hive, Client / tenant, Environment, Status [Healthy/Failing pill, tone Danger when not ready]; emptyText "No running environment observed on this version."). Fresh table slot per render. Seams `Host`, `AdoptionTable`.
- `releases-view.ts` - `ReleasesView extends StackPanel implements IPortalView`, `constructor(client)`, enum `ReleasesMode { List, Detail }`, self-routes list/detail (copy the hardened `HivesView`). List: `Promise.all([ListManifests(), ListFleet()])` -> `ReleasesViewModel` -> `DataTable<ReleaseListRow>` (cols Version, Status, Image, Published, Running; `onOpen` -> ShowDetail; fresh slot; ScreenHost loading/error[onRetry]/empty["No versions published yet."]/populated). Detail: refetch both, find the manifest by id (stale-guard + try/catch -> list error fallback), build `ReleaseDetailViewModel`/`ReleaseDetailView`. Seams `Host`, `Table`, `Mode`.

Modified:
- `app.ts` - `ShowSection(PaSection.Registry)` mounts `new ReleasesView(this.client)` before the `ComingSoon` fallback.

Tests: control-plane `admin/control-plane/tests/` (`node:test`, run via `npx tsx --test`): a `GET /api/manifests` host test (returns all published incl. withdrawn; empty list when none). Portal `admin/portal/tests/` (`node:test`, `Application.current` harness): `releases-view-model.test.ts`, `release-detail-view-model.test.ts`, `release-detail-view.test.ts`, `releases-view.test.ts` (list populated/empty/error; row-open -> detail; detail-fetch-reject fallback; list + detail second `Refresh()` survive).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `tests/` subfolders.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`), re-scan after any `\uXXXX`. Match EOL of touched files.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools` (repo root; root `npm test` MISSES control-plane tests); portal `npm test` + `npm run typecheck` in `admin/portal`. The merged result must be green on BOTH.
- Every actionable control keyboard-reachable; status icon + text; no cross-app import; no raw internal ref or secret exposed; never fabricate signing/channel/digest data.
- Stateful views MUST survive a second `Refresh()` in BOTH list and detail modes (fresh content slot per render - the PA-4 guard).

## Review focus (inputs no happy-path test exercises)

- A withdrawn version shows the Withdrawn status pill AND the withdrawn Banner with the honest "keep running until the tenant adopts another version" copy, and still lists where it runs. (List + detail tests.)
- A version that no observed env reports running shows "Not observed running" (not "0") in the list and an empty "Where it runs" panel in detail, no crash. (VM + view tests.)
- A version with empty/missing `notes` shows "(none)" for What's new, and a missing/empty `publishedAt` shows "Unknown" (via `PortalDates.Label`), never "Invalid Date". (Detail VM test.)
- No Signed pill, channel label, digest, provenance block, or publish/withdraw control appears anywhere. (View test / review.)
- A second `Refresh()` in list and in detail re-renders without a double-parent throw. (ReleasesView test.)
