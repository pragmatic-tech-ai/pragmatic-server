# SP-HIVE-3b — In-cluster env seed projection (data/<env> tree) (design)

**Status:** approved for planning (AFK autonomous run; merge locally, never push).
**Project item:** `PVTI_lADOE0Zc984Biu4ozhDeUPM` (Kind=Feature) — "SP-HIVE-3b: project the heavy in-cluster env seed".
**Spun off from:** SP-HIVE-3, which projected the BOOT config (tenants ConfigMap + master-key/provisioned-secrets Secrets + base-dir PVC) but explicitly scoped OUT the `data/<env>/` seed tree (security-model, packages, applications), calling it "binary/large, exceeds a ConfigMap."

## Premise correction (from recon + measurement)

The deferral's "heavy/binary >1 MB" framing was inaccurate for the demo seed. Measured against a real
compiled bundle (`C:/tmp/sp1-smoke/bundle/data/sp1`): compiled TODL `packages/` ~8 KB, `identity/`
~22 KB, `application.json` <1 KB. The only large artifact in any bundle is an app's UI bundle
(`applications/<app>/ui/index.html` ~7 MB) — and the demo northwind has NO UI: `BundleBuilder`
(`environments/seed/bundle.ts:199-209`) writes northwind's `application.json` with no `ui` field and
no `ui/` directory, and there is no UI bundle in the repo. So the demo seed tree is tiny (~30 KB) and
fits in a single k8s Secret.

Separately, recon confirmed there is **no in-cluster app-deploy-with-UI path** today: in-cluster envs
receive only server-image rollout adoption over the agent channel (`admin/control-plane/tenant-api/rollout-client.ts:5-10`,
`tenant-api-endpoint.ts:40-73`); full app deploy with UI (`AppIngestService.Ingest` over a tenant WS,
`src/host/apps/app-ingest-service.ts:268-281`) is a Docker/direct-WS path only. In-cluster **UI serving**
is therefore a larger separate program (needs an in-cluster app-deploy path + the still-deferred
version-scoped UI storage, `app-ingest-service.ts:52-55`) and is OUT of scope here.

## Intent & why

A DEMO (or any non-dev-blank) in-cluster environment should boot as a FULLY seeded tenant — its
security model governing, its seeded app's packages registered — exactly as the Docker runtime does via
its `SeedVolume` copy (`environments/seed/docker.ts:457-467`). SP-HIVE-3 gets the pod to boot as a bare
configured tenant; today it does NOT carry the `data/<env>/` tree, so an in-cluster demo has no
security model and no registered app. This closes that gap: **data-layer parity with the Docker seed**.

The in-cluster read path just shipped (app-private concept governance, `DdtsU`) makes this immediately
useful: with the security model present, northwind's own concepts are governed and its app graph is
queryable over the tenant WS.

## The Docker parity target

Docker delivers the seed with a privileged throwaway container that `cp -a`s `bundleDir/data` into the
named data volume at `/data` (= `PRAGMATIC_BASE_DIR`), marker-guarded by `.env-seeded` so a restart
never clobbers live state (`environments/seed/docker.ts:192-196,457-467`). The server then reads
`<baseDir>/<env>/{packages,applications,identity}` (`src/tenancy/tenant-registry.ts:231-241`). Our k8s
projection reproduces this: an init-container writes the same tree into the base-dir PVC before the
server container starts, marker-guarded identically.

## Decisions (mine, as the builder — AFK)

- **Tree path/mount/marker key off `environmentId`, NOT the record name — this is the silent-failure
  trap.** `BundleBuilder.Generate` writes the tree at `join(bundleDir, 'data', def.environmentId)`
  (`bundle.ts:69`) and the server reads `join(baseDir, environmentId, …)` (`tenant-registry.ts:231-241`).
  For a Demo env `def.environmentId` is the fixed `contoso` while `record.name` is the user's env name —
  they DIFFER. The existing `EnvServerSeedSource` is constructed with `environmentName` and `ApplyBundle`
  is passed `ctx.record.name`; a name-keyed projection would unpack into `data/<name>/` while the server
  reads `data/contoso/`, booting UNSEEDED with no error. So the seed projection threads
  `ctx.def.environmentId` (available at the `BringUp` call site) and uses it for the walked tree path, the
  init-container's destination sub-dir, and the marker path. The Secret RESOURCE name stays on the
  existing `environmentName` scheme (the namespace is per-env, so it is unique either way). Pin with a test
  asserting the unpack destination is `data/<environmentId>/` when id ≠ name.
- **One seed Secret carrying the whole `data/<environmentId>/` tree, unpacked by an init-container.** The tree may
  include `identity/` material that is sensitive, so the conservative, uniform choice is a single k8s
  Secret (not a ConfigMap) built with the existing `EnvServerSecretSet` discipline (bytes in `#private`,
  redacted `toJSON`/`toString`, values exit only via `RenderManifest()`). The tree is projected as one
  Secret entry whose value is a JSON manifest mapping each relative path under `data/<env>/` to its
  base64 bytes.
- **Unpack with node, not tar.** The runtime image is `node:22-slim` running `USER 10001`
  (`docker/Dockerfile:94-100`). The init-container runs that same image with a small node script
  (node is guaranteed present; tar is not relied on) that reads the mounted seed manifest and writes each
  entry to `/pragmatic/data/<env>/<relpath>`, creating parent dirs, IF a marker
  `/pragmatic/data/<env>/.env-seeded` is absent; then writes the marker. This mirrors Docker's
  marker-guarded copy exactly, so a pod restart keeps live state. Runs as uid/fsGroup 10001 (already set
  by SP-HIVE-3), writing into the existing base-dir PVC mounted rw.
- **Reuse the TenantAdmin init-container pattern, with its hardened securityContext.**
  `K8sManifestBuilder.ServerDeployment` gains an `initContainers: [<seed>]` entry modelled on
  `TenantAdminSeedContainer` (`admin/control-plane/k8s-manifest-builder.ts:701-714`): same image, a seed
  Secret volume (ro) + the base-dir PVC (rw), the node unpack command, and the same hardened
  `securityContext` the TenantAdmin seed container uses (`runAsUser: 10001`, `readOnlyRootFilesystem: true`,
  drop ALL capabilities). The unpack writes ONLY into the mounted PVC (no temp files, no `$HOME`/`/tmp`
  writes), so a read-only root filesystem is fine. The script/command string is hoisted to a
  `private static readonly` constant. The init-container is UNCONDITIONAL on this builder — see the Docker
  note below.
- **EnvServerSeedSource owns the projection.** It already reads the bundle and renders the tenants
  ConfigMap + secret set (`admin/control-plane/env-server-seed.ts`); it gains a method that walks
  `data/<environmentId>/` and contributes the seed Secret to the applied List via `ApplyBundle`. The
  `EnvironmentWorkload`/manifest still carries NAMES only; the renderer wires the volume/mount by name.
- **Docker is untouched because `K8sManifestBuilder` is in-cluster-only.** `ServerDeployment`/`Render` has
  NO Docker caller (the Docker backend uses `environments/seed/docker.ts`), so there is no
  `PublishesHostPort()`-keyed render to guard here — the init-container is simply always present on this
  builder. The parity guarantee is that NO Docker code (`docker.ts`, the Docker runtime) is modified by
  this work; verify by the diff touching no Docker files, not by a (vacuous, unreachable) host-port render
  assertion.
- **Projection is conditional on the tree existing.** A dev-blank env's bundle has no `data/<env>/`
  packages/applications (only identity); the projection includes whatever `BundleBuilder.Generate`
  actually wrote (always `identity/tenant-config.json`; packages/applications for Demo kind). An empty
  or identity-only tree is still projected so the security model lands in-cluster.
- **UI is explicitly not delivered.** If a future seeded env carries a UI bundle, the single-Secret
  approach hits the ~1 MB Secret limit and this mechanism must be replaced by a heavier one (registry
  artifact / chunked ingest). That is the filed follow-up, not this work.

## Non-goals / anti-goals

- No in-cluster app UI serving; no in-cluster app-deploy path (separate program).
- No change to the Docker seed path (parity is the goal).
- No change to SP-HIVE-3's boot config/secret projection beyond adding the seed Secret to the same apply.
- No new secret store; the bundle + k8s Secrets remain the two stores.
- No version-scoped UI storage (deferred R6).

## Component shape (for the plan)

- `admin/control-plane/env-server-seed.ts` — `EnvServerSeedSource` gains `SeedTreeSecret(): EnvServerSecretSet`
  (or extends the existing set) that walks `join(bundleDir, 'data', environmentId)` recursively, builds the
  path->base64 manifest, and contributes a Secret named `SeedSecretNameOf(env)` (e.g. `<env>-env-seed`)
  with one data key (e.g. `seed.json`). `ApplyBundle` adds it to the applied List. Returns no values except
  through `RenderManifest()`.
- `admin/control-plane/k8s-manifest-builder.ts` — `ServerDeployment` gains `initContainers: [ServerSeedContainer(...)]`:
  same image, command = a hoisted node unpack script, volumeMounts = seed Secret (ro, at e.g. `/pragmatic/seed`)
  + base-dir PVC (rw, `/pragmatic/data`), running as 10001. Constants for the mount path, marker filename,
  and the command.
- `admin/control-plane/in-cluster-environment-runtime.ts` — `BringUp`/`ApplyBundle` already apply the seed
  objects after the workload; the new seed Secret rides along. No ordering change (k8s retries the pod until
  the init-container's Secret exists).
- `environments/seed/bundle.ts` — unchanged (already writes the tree). The demo app staying UI-less is a
  pre-existing, separate matter, not touched here.

## Verification

- **Unit (`tsx --test`, no cluster):** given a temp bundle dir with a `data/<env>/` tree (identity +
  packages + application.json), `EnvServerSeedSource`'s seed Secret base64-round-trips every file; the
  manifest preserves nested relative paths; the Secret redacts `toJSON`/`toString` (values only via
  `RenderManifest`); `ServerDeployment` renders an init-container whose Secret volume name equals the seed
  Secret's `metadata.name`, mounts the base-dir PVC rw, carries the hardened securityContext, and runs the
  marker-guarded unpack writing into `data/<environmentId>/` (assert with id ≠ name); the rendered seed
  Secret's data size is checked against the ~1 MB ceiling and a tree over it raises a named error.
- **Gated live smoke (operator-run, docker-desktop):** promote `in-cluster-env-create-smoke` (or
  `k8s-hive-smoke`) to create a DEMO env; after rollout Ready, the pod's data root holds
  `<env>/{identity/tenant-config.json, packages/northwind/.../model.json, applications/northwind/application.json}`;
  over the tenant WS the seeded admin lists northwind as registered and queries its graph (reads succeed
  under app-private governance); a re-Apply / pod restart does NOT re-seed (marker intact) and keeps live
  state.
- control-plane unit suite green; `tsc` tools+tenant-admin+build+portal clean.

## Review focus (likely-to-bite, pin each in a task test)

1. **environmentId keying (the silent trap):** the unpack destination, mount sub-dir, and marker must be
   `data/<def.environmentId>/` — NOT `data/<record.name>/`. For a Demo env (`environmentId='contoso'`,
   `name`=user's) a name-keyed projection boots unseeded with no error. Pin with a test where id ≠ name.
2. **Marker idempotency:** a second init-container run (pod restart / re-Apply) must NOT overwrite live
   data — a `data/<environmentId>/.env-seeded` marker guards the copy (equivalent to Docker's root
   `/data/.env-seeded` for a single-env PVC).
3. **Nested-path fidelity:** the manifest must reconstruct `packages/<id>/<ver>/model.json` and
   `applications/<app>/application.json` with parent dirs created; a flat write would break registration.
4. **Secret non-leakage:** seed bytes never in a log, DTO, error, the workload record, or a non-Secret
   manifest — same bar SP-HIVE-3/P4 passed; redaction + error paths tested.
5. **Size ceiling:** if the RENDERED seed Secret exceeds the ~1 MB limit (a future UI-bearing seed), the
   projection must fail LOUDLY with a named error, not silently truncate — pin a guard + test. (Docker is
   untouched — no host-port render guard; the init-container is unconditional on this in-cluster-only builder.)
