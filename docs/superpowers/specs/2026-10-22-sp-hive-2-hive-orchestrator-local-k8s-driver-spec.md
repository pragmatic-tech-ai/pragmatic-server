# SP-HIVE-2 — Hive Orchestrator + Local/Attach Docker Desktop k8s Driver — Spec

**Status:** Draft 2026-10-22. Second sub-project of the SP-HIVE program.
**Design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md`
**Predecessor:** SP-HIVE-1 (Client/Tenant/Hive records) — shipped, merged to local master.
**Owner repo:** pragmatic-server (`admin/control-plane`).

## Intent

SP-HIVE-1 gave the control plane a system-of-record for `Client → Tenant → Hive`, where each `HiveRecord` carries a `ClusterSpec { backend, mode, configRef? }` (backend ∈ {aks,eks,gke,private,local}, mode ∈ {provision,attach}) — but nothing *acts* on that spec. SP-HIVE-2 makes a hive real: it introduces the **Hive Orchestrator** abstraction (the Kubernetes backend seam, keyed on backend × mode) and implements the first driver — **local / attach against Docker Desktop's built-in Kubernetes** — that can stand an environment's workload up as real k8s objects, health-check it, roll it to a new image, and tear it down, leaving the cluster clean.

The admin tool never talks to Kubernetes directly; it talks to a `HiveOrchestrator` driver resolved from the hive's spec. Today's single-box raw-`docker` path (`DockerEnv`/`EnvironmentService`) stays exactly as it is; this sub-project adds the k8s-capable orchestrator alongside it and proves it against a real cluster, without rewiring the shipped docker lifecycle.

## The key call (builder's choice, per the design)

The design left the k8s toolchain to the builder. **Decision: the driver shells out to the `kubectl` CLI**, applying plain rendered k8s object manifests (`kubectl apply -f -` reading JSON from stdin), behind an `IKubectl` seam — mirroring exactly how `DockerEnv` wraps the `docker` CLI (`node:child_process` `execFile`, argument arrays, never a shell; 16 MB maxBuffer). Rationale: it matches the one orchestration pattern already in this codebase, adds no heavyweight k8s client dependency, makes **attach** mode nothing more than "run kubectl against a named kubeconfig context," and the whole thing is a seam, so swapping to `@kubernetes/client-node` later is a driver replacement, not a redesign. We render plain manifests (not Helm). The existing `helm/pragmatic-server/` chart targets the *runtime* server's gateway/worker topology — a different deployment shape from the control plane's single-server + Postgres environment model — and is out of scope here.

## In scope

- `IHiveOrchestrator` — the driver seam: lifecycle operations on an **environment workload** (apply, health, roll, status, teardown).
- `EnvironmentWorkload` — the backend-neutral description of what a hive must run for one environment (derived from `EnvironmentRecord` + the hive it is placed on): image ref, server port, environment variables, optional Postgres sidecar, secret references.
- `K8sManifestBuilder` — renders an environment workload into k8s objects for Docker Desktop: a per-environment **Namespace**, the server **Deployment** + **Service**, the Postgres **StatefulSet** + headless **Service** (when the workload has a database), and a **Secret** sourced from server-side secret *names* (never values in the manifest text that is logged).
- `IKubectl` + `KubectlCli` — the fakeable CLI seam and its `execFile`-backed implementation, context-scoped (every invocation carries `--context <ctx>`).
- `KubectlHiveOrchestrator implements IHiveOrchestrator` — the **local/attach** driver: `Apply` (namespace + objects, `kubectl apply`), `Health`/`WaitHealthy` (`kubectl rollout status` + readiness), `Roll` (update image → rollout status, a real rolling update), `Status` (running image + ready replica health), `Teardown` (`kubectl delete namespace`, leaving the cluster itself — attach semantics).
- `HiveOrchestratorFactory` — resolves a `HiveRecord` (backend × mode) to a driver: `{local, attach}` → `KubectlHiveOrchestrator`; every other backend/mode pair → `UnsupportedBackendError` (the cloud/provision drivers are later sub-projects).
- Wire `PlatformDirectory.ValidateHivePlacement` into the point an environment is bound to a hive (it exists and is tested but is called nowhere today) — see "Placement wiring" below.
- Unit tests driving a **fake** `IKubectl` (assert the exact invocations, the rendered manifest shapes, the rollout/health/roll logic, secret-name-only redaction, and `UnsupportedBackendError`).
- A **gated real-cluster smoke** (sibling of `control-plane-smoke.ts`, NOT part of `tsx --test`) that deploys a real environment workload to `docker-desktop`, verifies the server pod becomes ready and serves, rolls it, and tears it down clean.

## Out of scope (named deferrals — file as Features on approval)

- Cloud backends (AKS/EKS/GKE) and **provision** mode — need cloud creds / `kind`; SP-HIVE-5.
- Container-registry provision/attach and signature verification — SP-HIVE-3 (this sub-project uses Docker Desktop's shared image store as the "no registry" fast path: `pragmatic-server:dev` with `imagePullPolicy: Never`/`IfNotPresent`).
- Rollout catalog, the in-hive pull agent, obsoletion flag, manifest publish — SP-HIVE-4. (SP-HIVE-2 implements the *mechanism* `Roll` uses; it does not implement who decides to roll or how a hive is told to.)
- Routing `EnvironmentService.Create` / the portal's environment-create flow through the k8s orchestrator for day-to-day use. SP-HIVE-2 proves the orchestrator against a real cluster via the gated smoke and the API below; making k8s the default placement for operator-created environments is a later integration slice.
- Berthing; governance/quota; fleet observability beyond per-hive/-workload health.

## Model

### `EnvironmentWorkload` (new, `admin/control-plane/environment-workload.ts`)

A backend-neutral value describing one environment's runnable shape. Plain data (serialized into manifests; JSON-casing fields), built by a static factory from an `EnvironmentRecord` + its `HiveRecord`:

```ts
export type WorkloadDatabase =
{
    image: string          // e.g. 'postgres:16'
    user: string
    database: string
    passwordRef: string    // NAME of a server-side secret; never the value
}

export type EnvironmentWorkload =
{
    environmentName: string   // == EnvironmentRecord.name; the namespace/label key
    hiveId: string
    image: string             // platform image ref, e.g. 'pragmatic-server:dev'
    serverPort: number        // in-container port (8080, matching the docker model)
    env: Readonly<Record<string, string>>   // non-secret PRAGMATIC_* config
    secretRefs: readonly string[]            // NAMES of server-side secrets mounted into the server
    database?: WorkloadDatabase
}
```

A `class EnvironmentWorkloadFactory` with a static `From(record: EnvironmentRecord, hive: HiveRecord): EnvironmentWorkload` builds it. Secret *values* are never part of the workload or any manifest string the logger sees — only reference names (SP-HIVE-1's and the design's standing rule; value resolution is SP-HIVE-3).

### `IHiveOrchestrator` (new, `admin/control-plane/hive-orchestrator.ts`)

```ts
export type WorkloadHealth =
{
    ready: boolean
    runningImage: string | undefined   // the image the live workload is actually running
    detail: string                     // human-readable status line (no secrets)
}

export interface IHiveOrchestrator
{
    Apply(workload: EnvironmentWorkload): Promise<void>
    WaitHealthy(workload: EnvironmentWorkload): Promise<void>
    Health(workload: EnvironmentWorkload): Promise<WorkloadHealth>
    Roll(workload: EnvironmentWorkload, image: string): Promise<void>
    Teardown(workload: EnvironmentWorkload): Promise<void>
}
```

`Apply` is idempotent (apply = create-or-update). `Roll` updates the server Deployment's image to `image` and waits for the rolling update to complete; it is the actuator SP-HIVE-4 will call. `Teardown` deletes the environment's namespace and all objects in it — **attach** semantics: the cluster stays.

### `IKubectl` + `KubectlCli` (new, `admin/control-plane/kubectl.ts`)

```ts
export interface IKubectl
{
    Apply(manifestJson: string): Promise<void>                 // kubectl apply -f - (stdin)
    RolloutStatus(namespace: string, deployment: string): Promise<void>
    SetImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    Get(namespace: string, resource: string): Promise<string>  // JSON (-o json) for health probing
    DeleteNamespace(namespace: string): Promise<void>
    Version(): Promise<string>                                 // client/server reachability check
}
```

`class KubectlCli implements IKubectl` wraps `execFile('kubectl', [...])` like `DockerEnv.Exec`: argument arrays only (never a shell), a `--context <ctx>` prefix on every call (the attach target; local default `docker-desktop`), 16 MB maxBuffer, stderr surfaced on non-zero exit via a typed `KubectlError` that **redacts** any secret-looking token. `Apply` pipes `manifestJson` to stdin.

### `KubectlHiveOrchestrator` (new, `admin/control-plane/kubectl-hive-orchestrator.ts`)

`implements IHiveOrchestrator`. Constructor takes `(kubectl: IKubectl, manifests: K8sManifestBuilder)`. Each method renders via the builder and drives `kubectl`:

- `Apply` → builder renders the full object set → `kubectl.Apply(json)` → the namespace and all objects exist.
- `WaitHealthy` → `kubectl.RolloutStatus(ns, serverDeployment)` (and the db StatefulSet when present).
- `Health` → `kubectl.Get(ns, 'deployment/<server>')`, parse `.status` for ready replicas + the container image; return `WorkloadHealth`.
- `Roll(workload, image)` → `kubectl.SetImage(ns, server, container, image)` → `kubectl.RolloutStatus(...)`.
- `Teardown` → `kubectl.DeleteNamespace(ns)`.

Namespace and object names are hoisted `private static readonly` patterns derived from `environmentName` (e.g. `pragmatic-env-<name>`), mirroring `DockerEnv`'s naming helpers. No user-facing or reused string literal appears inline.

### `K8sManifestBuilder` (new, `admin/control-plane/k8s-manifest-builder.ts`)

`class K8sManifestBuilder` with `Render(workload: EnvironmentWorkload): string` returning a JSON document (a `List` kind, or newline-joined objects for `apply -f -`). Objects:

- **Namespace** `pragmatic-env-<name>` with labels `{ 'pragmatic/environment': name, 'pragmatic/hive': hiveId }`.
- Server **Deployment** (1 replica): container image = `workload.image`, `imagePullPolicy: IfNotPresent` (local shared-store fast path), container port = `serverPort`, env from `workload.env`, secret envs/mounts from `workload.secretRefs` as `secretKeyRef`/volume referencing a k8s Secret by name, a **readiness probe** hitting the server's health path on `serverPort`.
- Server **Service** (ClusterIP) exposing `serverPort`.
- When `workload.database`: Postgres **StatefulSet** (image, `POSTGRES_USER`/`DB` from values, `POSTGRES_PASSWORD` via `secretKeyRef`), a headless **Service**, and a `volumeClaimTemplate` for data.
- A **Secret** object is *not* rendered with values here (values are SP-HIVE-3); the manifest references secret names that are assumed to exist / are created out-of-band in the smoke via a dev-only path. For SP-HIVE-2 the local smoke seeds the one needed secret (the Postgres password) through a dev helper so the workload is runnable end-to-end; this helper is explicitly local-dev-only and documented as such.

Design note: the probe health path and server port mirror the docker model (`-p host:8080`, server serves on 8080). The builder fixes k8s object *shapes*; the design explicitly delegated these to the builder.

### `HiveOrchestratorFactory` (new, `admin/control-plane/hive-orchestrator-factory.ts`)

`class HiveOrchestratorFactory` with `For(hive: HiveRecord): IHiveOrchestrator`. Reads `hive.cluster.backend` + `hive.cluster.mode`; for `{Local, Attach}` returns a `KubectlHiveOrchestrator` built against the context resolved from the hive (local default `docker-desktop`; the design's `configRef` names the kubeconfig/context server-side — for local/attach the context name is the resolved value). Any other pair throws `UnsupportedBackendError(backend, mode)` (new typed error, same style as the SP-HIVE-1 error classes). The factory is the one place backend × mode maps to a driver.

### Placement wiring

`PlatformDirectory.ValidateHivePlacement(tenantId, hiveId)` exists and is tested but called nowhere. SP-HIVE-2 wires it at the moment an environment is bound to a hive: add an orchestrator-facing method that, given an `EnvironmentRecord` + resolved `HiveRecord`, validates placement (tenant match) and builds the workload. We do **not** change `EnvironmentService.Create`'s default docker path or its signature for environments with no `hiveId`; the k8s path is reached through the new orchestrator API/smoke, keeping the shipped lifecycle untouched. (Full "operator creates an environment onto a k8s hive via the portal" is the deferred integration slice.)

## API (control-plane host) — minimal, operator-gated

Add, following the existing `RoutePlatform` convention and the same non-public auth gate:

- `GET /api/hives/:id/health` → resolve hive → factory → for each environment with `hiveId === id`, `orchestrator.Health(workload)` → a DTO array `{ environmentName, ready, runningImage, detail }`. Read-only; no secrets. Returns `UnsupportedBackendError` → 400 for non-local hives.

This is the one surface that proves the orchestrator through the real host without taking on the deferred create-on-hive integration. `Apply`/`Roll`/`Teardown` against a real cluster are exercised by the gated smoke, not yet exposed as operator routes (they become tenant/rollout surfaces in SP-HIVE-4).

## Security (binding)

- Credentials — kubeconfig/context, registry secrets, DB passwords — are referenced **by name**, held server-side; never in manifests that are logged, DTOs, errors, or the portal. `KubectlError` and the orchestrator redact secret-looking tokens before surfacing stderr.
- The manifest text handed to `kubectl apply` may contain a Secret-name reference but never a secret value in SP-HIVE-2 (value injection is SP-HIVE-3); the local smoke's dev-only password seeding is isolated and labelled local-dev-only.

## Tests (in `tests/` subfolders)

Unit (faked `IKubectl`, part of `tsx --test "admin/control-plane/tests/*.test.ts"`):

- `k8s-manifest-builder.test.ts` — a workload with and without a database renders the expected object kinds/names/labels/ports; the server Deployment has a readiness probe; Postgres password is a `secretKeyRef`, never a literal; `imagePullPolicy: IfNotPresent`.
- `kubectl.test.ts` — `KubectlCli` builds the right `execFile` arg arrays (context prefix on every call; `apply -f -` with stdin); non-zero exit throws `KubectlError` with stderr **redacted** of secret tokens.
- `kubectl-hive-orchestrator.test.ts` — `Apply` calls `kubectl.Apply` with the builder's output; `WaitHealthy` calls `RolloutStatus`; `Roll` calls `SetImage` then `RolloutStatus`; `Health` parses a fake `kubectl get -o json` into `WorkloadHealth`; `Teardown` calls `DeleteNamespace`.
- `hive-orchestrator-factory.test.ts` — `{local,attach}` → a `KubectlHiveOrchestrator`; every other backend/mode throws `UnsupportedBackendError`.
- `environment-workload.test.ts` — `From(record, hive)` maps fields correctly; carries only secret *names*; `database` present iff the record's template implies a DB.
- Placement: binding an environment to a hive of another tenant throws `HivePlacementError` (exercises the now-wired `ValidateHivePlacement`).
- Host route: `GET /api/hives/:id/health` for a local hive returns the health DTO (orchestrator faked); for a non-local hive → 400.

Gated real-cluster smoke (`k8s-hive-smoke.ts`, sibling of `control-plane-smoke.ts`, NOT in `tsx --test`; requires Docker Desktop k8s + the `pragmatic-server:dev` image):

- Compose a `KubectlHiveOrchestrator` against context `docker-desktop`, build a workload for a throwaway environment, `Apply`, `WaitHealthy`, assert the server pod is Ready and serves (port-forward or NodePort + health probe), `Roll` to the same/alternate image tag and assert rollout completes, `Teardown` and assert the namespace is gone. Mirrors how `control-plane-smoke.ts` runs real Docker and is explicitly excluded from the normal test run.

## What is left to the builder

- Exact k8s object JSON (probe timings, resource requests, `volumeClaimTemplate` size, Service type) — the spec fixes kinds, names, labels, ports, pull policy, and the secret-by-reference rule; the rest is idiomatic.
- The readiness-probe path (reuse the server's existing health/ping endpoint the docker `WaitHealthy` already relies on).
- Host-access mechanism in the smoke (port-forward vs NodePort) — pick one, justify briefly.
- Polling/backoff inside `WaitHealthy` beyond delegating to `kubectl rollout status`.
- Whether the gated smoke seeds the dev Postgres secret via `kubectl create secret` or an inline dev manifest — local-dev-only either way.
