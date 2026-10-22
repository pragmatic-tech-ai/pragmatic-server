# SP-HIVE-4 — Platform-Software Rollout (Push + Pull) — Spec

**Status:** Draft 2026-10-22. Fourth sub-project of the SP-HIVE program. The largest slice so far — it proves **both** delivery paths.
**Design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md` (decisions 5, 6, 7; resolved decisions 1, 2, 3).
**Predecessors:** SP-HIVE-1 (records), SP-HIVE-2 (orchestrator + local k8s driver), SP-HIVE-3 (effective registry + signed-image verification gate) — all shipped to master.
**Owner repo:** pragmatic-server (`admin/control-plane`, plus a new agent entrypoint under `src/bin`).

## Intent

Connect Pragmatic Studio's platform engineering to the running fleet: publish a new `pragmatic-server` version, make it available to a tenant, select it for a hive, and have every environment on that hive move to it — **by push when the cluster is reachable, by pull when it is not**. This is the rollout mechanism of design decisions 5–7: it moves *platform software* (the versioned image carrying mural/todl/plexus), not customer content.

Proven on docker-desktop:
- **Push:** publish a manifest → (platform-admin gates it for the tenant) → select it for a hive → the control plane drives the orchestrator's `Roll` on that hive's environments → the running pod comes up on the new image (signature-verified by the SP-HIVE-3 gate).
- **Pull:** an in-cluster **agent** polls the PlatformDeploymentRegistry, sees its hive's selected target is ahead of what it runs (the **obsoletion flag**), updates its environment itself via the in-cluster Kubernetes API, and POSTs its running version + health back so the flag clears.

## The key calls (builder's choices)

- **PlatformDeploymentRegistry lives on the control-plane host**, not as a separate service — new operator-gated API routes + atomic-JSON record stores (the established `JsonRecordStore` pattern). A real separate client-facing service is a later concern; the surface and contract are what matter now.
- **Selection is driven through the control-plane operator API** (plus a publish CLI). The tenant-admin *self-service selection UI* is SP-HIVE-7's first feature (it needs the SP-HIVE-6 tenant identity realm), so SP-HIVE-4 ships **no new user-facing UI** — the operator acts on the tenant's behalf until then.
- **The pull agent is a new daemon in the existing `pragmatic-server:dev` image** — a `src/bin/pragmatic-agentd` entrypoint following the existing `pragmatic-serverd/workerd/gatewayd` bin pattern, run as a k8s Deployment with its `command` overridden. No second image to build/push; the image is already on the node. The agent speaks **only HTTP** (`fetch`): to the Registry (over a configured URL) and to the **in-cluster Kubernetes REST API** (`https://kubernetes.default.svc`, using its mounted ServiceAccount token + CA) to patch the environment's server Deployment image. No `@kubernetes/client-node` dependency, no `kubectl` in the pod. Because it imports no `admin/` code and only speaks HTTP, it stays dependency-clean despite living in `src/`.
- **Agent connectivity is field-faithful config, not a local shortcut** (the brainstorm resolution): the agent reaches the Registry at a **configured URL injected at deploy time** — `host.docker.internal:7000` locally, a public Registry URL in the field — polls **outbound** on an interval, authenticates with a **per-hive machine credential** on every request, and applies via **in-cluster authority** (its ServiceAccount/RBAC), never credentials handed in from outside. Only the URL value is local; the mechanism is the real reachable-outbound pull path. (Air-gapped sideload stays a later Feature.)
- **Machine credential is Registry-held, hash-only.** Registering a hive for rollout generates a bearer token, returns it once (to inject into the agent's k8s Secret), and stores only its hash in a rollout-registration record. The agent presents the token; the Registry hashes and compares. No new key-store module.

## In scope

- **Manifest** record + registry: a published release descriptor `{ id (version), image (signed ref), notes?, publishedAt }`.
- **Gating**: per-tenant control of which manifest versions are offered (decision 1). A gating record per `(tenantId, version)` the platform admin adds/removes; `AvailableFor(tenantId)` returns only gated-in manifests.
- **Selection**: per-hive selected target version (decision 2) — setting it is the rollout trigger; re-selecting a prior version is **rollback** (decision 3).
- **PlatformDeploymentRegistry** class coordinating the three stores + obsoletion + report-back ingestion + per-hive rollout registration (machine-token hash).
- **Push actuator**: on selection, the control plane resolves the hive's orchestrator (`HiveOrchestratorFactory.For`), and for each environment bound to the hive (`EnvironmentPlacement.WorkloadFor`), `Roll`s to the manifest's image — signature-verified by the SP-HIVE-3 gate.
- **Obsoletion + report-back**: the Registry computes, per hive, whether the reported running version matches the selected target; the agent POSTs `{ hiveId, environmentName, runningImage, ready }` (machine-credential-authenticated) and the flag clears when running == target.
- **Control-plane API** (operator-gated except the agent routes, which are machine-credential-authenticated): publish manifest; list manifests for a tenant (gated); add/remove gating; select target for a hive (triggers push); get rollout status/obsoletion for a hive; agent poll (get hive target); agent report-back (POST).
- **Publish CLI**: a minimal command registering a manifest (image ref + version + notes); local dogfood = publish the current `pragmatic-server:dev` by hand (full CI publish deferred — Feature).
- **The pull agent** (`src/bin/pragmatic-agentd` + `src/agent/*`): poll loop, obsoletion compare, k8s Deployment image patch via the in-cluster REST API, report-back; and the **k8s objects** to deploy it — ServiceAccount + Role (get/patch `apps/deployments` in the env namespace) + RoleBinding + the agent Deployment + its credential Secret — added to `K8sManifestBuilder`.
- **`HiveRecord` gains `agentTokenRef?`** (optional; the name of the hive's rollout registration) — additive.
- Two gated real-cluster smokes: a **push** smoke and a **pull-agent** smoke, run for real on docker-desktop.

## Out of scope (named deferrals — file as Features on approval)

- **In-agent signature verification (pull path).** The push path is signature-verified (the orchestrator `Roll` gate). The agent patches the Deployment via the k8s API directly and does **not** verify the image signature in-cluster — doing so needs the registry-manifest-digest capability already deferred in SP-HIVE-3 (the agent has no local docker store to compute `{{.Id}}`). The pull path proves the *self-update mechanics*; in-agent verification is a tracked follow-up gated on that SP-HIVE-3 Feature.
- Tenant-admin self-service selection **UI** → SP-HIVE-7. Tenant identity realm → SP-HIVE-6 (until then, operator-driven selection).
- **One-agent-per-hive watching many env namespaces.** SP-HIVE-4 deploys **one agent per environment** (in that env's namespace, namespace-scoped RBAC), polling the hive's selected target. Consolidating to a single per-hive agent is a refinement Feature.
- Full CI manifest-publish pipeline (local publish-by-hand only); cloud backends; air-gapped sideload; compatibility/pre-flight checks beyond version equality.

## Model

### Records + stores (`admin/control-plane/`)

Each a `type …Record = { id: string; … }` + a `class …Registry extends JsonRecordStore<…Record>` with its own `RootKey`/file, wired in `server.ts`:

- `manifest-record.ts` — `type ManifestRecord = { id: string /* version */; image: string; notes?: string; publishedAt: string }`; `class ManifestRegistry` (root `manifests`).
- `gating-record.ts` — `type GatingRecord = { id: string /* `${tenantId}:${version}` */; tenantId: string; version: string; gatedAt: string }`; `class GatingRegistry` (root `gating`).
- `selection-record.ts` — `type SelectionRecord = { id: string /* hiveId */; hiveId: string; targetVersion: string; selectedAt: string }`; `class SelectionRegistry` (root `selections`).
- `rollout-registration-record.ts` — `type RolloutRegistrationRecord = { id: string /* hiveId */; hiveId: string; agentTokenHash: string; registeredAt: string }`; `class RolloutRegistrationRegistry` (root `rolloutRegistrations`). Plus a per-hive **report** `type RolloutReportRecord = { id: string /* `${hiveId}:${environmentName}` */; hiveId: string; environmentName: string; runningImage: string; ready: boolean; reportedAt: string }` + registry (root `rolloutReports`) for obsoletion/report-back state.

### `PlatformDeploymentRegistry` (`admin/control-plane/platform-deployment-registry.ts`)

The coordinator. Holds the registries above + `PlatformDirectory` + a `HiveOrchestratorFactory` + `EnvironmentPlacement` seam for the push. Methods (names illustrative; builder may refine):

- `Publish(version, image, notes?)` → `ManifestRecord` (validates id; image ref required).
- `ManifestsFor(tenantId)` → `readonly ManifestRecord[]` — only versions gated-in for the tenant.
- `Gate(tenantId, version)` / `Ungate(tenantId, version)`.
- `SelectTarget(hiveId, version)` → validates the version is published and gated for the hive's tenant, records the selection, then **pushes** (best-effort: if the backend is reachable, `Roll` each of the hive's environments to the manifest image; if unreachable/`UnsupportedBackendError`, leave it for the agent to pull — record a typed note, not a failure).
- `TargetFor(hiveId)` → `{ version, image } | undefined` (what the agent polls).
- `Report(hiveId, environmentName, runningImage, ready)` → upserts the report record.
- `StatusFor(hiveId)` → `{ targetVersion, environments: [{ environmentName, runningImage, obsolete: boolean, ready }] }` — `obsolete = runningImage !== manifest(targetVersion).image`.

Typed errors (added to `ErrorStatuses`): `UnknownManifestError` (404), `ManifestNotGatedError` (409/403), `ManifestExistsError` (409), `HiveNotRegisteredError` (404), `AgentUnauthorizedError` (401).

### Control-plane API (`control-plane-host.ts`)

Operator-gated (default) — following `RouteHiveHealth`/`RoutePlatform` conventions, segment + `RegExp` pattern + `RouteXxx`, errors via `ErrorStatuses`:

- `POST /api/manifests` (publish) · `GET /api/tenants/:id/manifests` (gated list) · `POST /api/tenants/:id/gating` + `DELETE /api/tenants/:id/gating/:version` · `POST /api/hives/:id/target` (select → push) · `GET /api/hives/:id/rollout` (status/obsoletion) · `POST /api/hives/:id/rollout-registration` (generate + return the agent token once, store the hash).

Machine-credential-authenticated (NOT operator-gated; validated against the hive's `agentTokenHash`, constant-time compare; added to the host's auth handling as a distinct agent path, never to `IsPublicApi` as fully-public):

- `GET /api/hives/:id/agent/target` (agent poll) · `POST /api/hives/:id/agent/report` (report-back). Both require an `Authorization: Bearer <machine-token>` header the Registry verifies.

### The pull agent (`src/bin/pragmatic-agentd.ts` + `src/agent/`)

A new daemon following the `server-main.ts` shape (`class AgentMain { private constructor; static async Run(); static Fail(e) }`, `pragmatic-agentd.ts` one-line shim, `bin` entry in `package.json`). Config from env (`PRAGMATIC_AGENT_REGISTRY_URL`, `PRAGMATIC_AGENT_HIVE_ID`, `PRAGMATIC_AGENT_ENV_NAME`, token from a mounted Secret file, poll interval + backoff). Loop:
1. `fetch` `GET <registryUrl>/api/hives/<hiveId>/agent/target` with the bearer token.
2. Read the running image of its env's server Deployment via the in-cluster k8s REST API (`GET /apis/apps/v1/namespaces/<ns>/deployments/<dep>`, bearer = the mounted SA token, CA from the mounted CA file).
3. If `runningImage !== targetImage` (obsolete), `PATCH` the Deployment's server container image (strategic-merge or JSON patch) → k8s rolls it.
4. `POST` report-back `{ runningImage, ready }`.
5. Sleep the interval; bounded backoff on errors. (No in-agent signature verify — deferred, see Out of scope.)

### k8s objects for the agent (`K8sManifestBuilder`)

New render path (a method emitting the agent object set for an environment): `ServiceAccount`, `Role` (verbs `get`,`patch` on `apps`/`deployments`, resourceName optionally scoped to `ServerDeploymentOf(env)`), `RoleBinding`, the agent `Deployment` (`image: pragmatic-server:dev`, `imagePullPolicy: IfNotPresent`, `command: ['node','dist/bin/pragmatic-agentd.js']`, env + the token mounted from a `Secret`), all in the env namespace with the existing labels. Name helpers `AgentDeploymentOf(env)`, `AgentServiceAccountOf(env)`, etc., hoisted like the existing ones.

## Security (binding)

- The machine token is returned exactly once at registration; only its **hash** is stored (Registry), and only its **ref name** (`agentTokenRef`) is on the HiveRecord. Never logged, never in a DTO, never in an error. Agent-route auth is a constant-time hash compare; failure → `AgentUnauthorizedError` (401) with no token echo.
- The agent's in-cluster authority is a **namespace-scoped** Role (get/patch the one env's Deployment) — least privilege; it cannot touch other namespaces or cluster-scoped objects.
- The push path keeps the SP-HIVE-3 fail-closed signature gate (`Roll` verifies). The pull path's missing in-agent verification is explicitly deferred and documented, not silently skipped.
- Operator routes stay operator-gated + CSRF-guarded (existing `Authenticated`/`OriginAllowed`); only the two agent routes use machine-credential auth.

## Tests (in `tests/` subfolders; unit tests fake kubectl/fetch/stores)

- Record stores: round-trip/ENOENT for each new registry.
- `PlatformDeploymentRegistry`: `Publish`/`ManifestsFor` honors gating (an ungated version is not returned; gating in/out toggles visibility); `SelectTarget` rejects an unpublished or ungated version; `SelectTarget` on a reachable hive calls `Roll` for each bound environment with the manifest image (fake orchestrator records the calls); `SelectTarget` on an `UnsupportedBackendError` hive records the selection without failing (pull-only); `StatusFor` marks an env obsolete iff its reported running image != the target manifest's image; `Report` clears obsolescence when images match; rollback = re-`SelectTarget(prior)` restores the prior image.
- Machine-credential auth: a correct bearer token passes; a wrong/absent token → `AgentUnauthorizedError`; the stored value is a hash, and no token appears in any error.
- Host routes: publish/list-gated/gate/select/status each operator-gated (401 unauth); the two agent routes reject a bad bearer (401) and accept a good one; no secret in any response.
- k8s manifest builder: the agent render emits ServiceAccount + Role (get/patch deployments) + RoleBinding + agent Deployment (`command` to `pragmatic-agentd`, token via `secretKeyRef`/mounted Secret, image `pragmatic-server:dev`); no token value in the rendered text.
- Agent (`src/agent`): with a fake `fetch`/k8s-API client, the loop patches the Deployment iff obsolete, and reports back; a poll/patch error backs off and does not crash the loop; no token logged.

### Gated real-cluster smokes (NOT in `tsx --test`; docker-desktop + `pragmatic-server:dev`)

- `rollout-push-smoke.ts` — publish v1 + v2 manifests (both signed per SP-HIVE-3), bring an environment up on v1, `SelectTarget(hive, v2)` via the Registry, assert the env's running image is now v2 (push roll, signature-verified); re-select v1 (rollback) and assert it returns to v1.
- `rollout-pull-smoke.ts` — register the hive (get the machine token), deploy the agent (ServiceAccount/Role/RoleBinding/Deployment/Secret) alongside an environment on v1, select v2 WITHOUT driving push (simulate unreachable by selecting then not pushing), and assert the in-cluster agent notices obsolescence, patches its Deployment to v2 on its own, and reports back so the obsoletion flag clears. Teardown-in-finally; report the real captured output; never fake a pass.

## What is left to the builder

- Exact route verbs/paths within the conventions; the k8s PATCH form (strategic-merge vs JSON-patch) the agent uses; the agent's poll interval/backoff values.
- The hashing choice for the machine token (a standard `crypto` hash) and the constant-time compare.
- Whether `ManifestNotGatedError` maps to 403 or 409 (pick one, justify).
- How the push smoke produces a distinct "v2" image locally (e.g. a second tag of `pragmatic-server:dev`, or a trivially-different tag) so the roll is observable — keep it honest about what differs.
- The agent Secret + SA-token/CA mount paths (standard in-cluster conventions).
