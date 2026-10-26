# In-cluster OCI Registry Workload (Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render and prove an in-cluster `registry:2` OCI registry that pods pull from via Service DNS and the control plane pushes to via a kind-mapped host port.

**Architecture:** A focused `InClusterRegistry` addressing type fixes the two reachabilities (pod pull vs host push). `K8sManifestBuilder.RenderRegistry(hiveId)` emits the Namespace+Deployment+NodePort-Service+PVC as a v1 List (the same JSON-List pattern as `Render`/`RenderHiveAgent`). A gated standalone smoke (the `IsEntryPoint()`/`Main()`/`Run()` convention the other in-cluster smokes use — **not** a `tests/` file) creates a kind cluster with the registry node-port mapped, applies the manifest, waits ready, and proves a `/v2/` blob round-trip from the host plus a pod-DNS reachability check.

**Tech Stack:** TypeScript (Node), `kind`, `kubectl`, `docker`, node `fetch`, `registry:2`. No new npm dependency, no new binary.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-in-cluster-app-ui-serving-design.md` (§6.1 two-address registry; §7 Spec 1). This plan builds **only** Spec 1 (the registry substrate). Production bring-up wiring (provisioning the registry during hive creation and adding the node-port to the real cluster-create path) is deliberately left to the spec that consumes it (Spec 3's deploy actuator), so Spec 1 ships a renderable manifest proven by its own smoke rather than half-wiring the orchestrator.

## Global Constraints

- OOP (methods/statics on classes, no free functions, no module-level mutable state); Allman braces; PascalCase public members/interfaces.
- No inline string/number literals that are labels, keys, names, image refs, paths, env-var names, or reused values — hoist to `private static readonly` (or `public static readonly` for cross-file constants). Structural tokens may stay inline.
- LF line endings. Tests live in `admin/control-plane/tests/`. Never `npm install` at the repo root.
- Secrets/tokens by name only — not relevant to Spec 1 (the dev registry is anonymous) but no credential value may appear in any rendered object, log, or error.
- `registry:2` is the pinned registry image; the in-cluster pull address is `pragmatic-registry.pragmatic-system.svc.cluster.local:5000`; the node-port is `30500`; the registry lives in the `pragmatic-system` namespace (value of `K8sManifestBuilder.SystemNamespace`).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never merge or push without explicit instruction.

## Review Focus

- **Node-port ↔ host-port ↔ Service-nodePort agreement.** The kind `extraPortMappings` entry, the host push address, and the rendered Service `nodePort` must be the same number, or host push hits nothing. → pinned by Task 1 (single constant) and asserted in Task 2 (rendered `nodePort` equals `InClusterRegistry.NodePort`).
- **Node-port range.** A `nodePort` outside 30000–32767 is rejected by the API server. → asserted in Task 1.
- **Readiness before push.** A push issued before `registry:2` is serving `/v2/` fails intermittently. → the rendered Deployment carries a `/v2/` readiness probe (Task 2 asserts it); the smoke waits on availability before any push (Task 3).
- **Blob integrity on round-trip.** A `/v2/` push addressed by `sha256:` digest must return byte-identical content on GET. → Task 3 asserts byte-equality.
- **Data persistence.** The design specifies a PVC, not ephemeral `emptyDir`; a restart must not silently drop pushed blobs. → Task 2 asserts a PVC is rendered and the Deployment volume references it.

---

### Task 1: `InClusterRegistry` addressing type

**Files:**
- Create: `admin/control-plane/in-cluster-registry.ts`
- Test: `admin/control-plane/tests/in-cluster-registry.test.ts`

**Interfaces:**
- Produces: `class InClusterRegistry` exposing `public static readonly RegistryName = 'pragmatic-registry'`, `Namespace = 'pragmatic-system'`, `Image = 'registry:2'`, `ServicePort = 5000`, `NodePort = 30500`, `DataClaimName = 'pragmatic-registry-data'`, `DataSize = '1Gi'`, `V2Path = '/v2/'`; and statics `static DnsHost(): string` → `'pragmatic-registry.pragmatic-system.svc.cluster.local'`, `static PullBase(): string` → `DnsHost() + ':' + ServicePort`, `static PushBase(): string` → `'localhost:' + NodePort`. Later tasks and specs consume these.

- [ ] **Step 1: Write the failing test** — `admin/control-plane/tests/in-cluster-registry.test.ts`

```ts
test('PullBase is the cluster Service DNS on the service port', () =>
{
    assert.equal(InClusterRegistry.PullBase(), 'pragmatic-registry.pragmatic-system.svc.cluster.local:5000')
})
test('PushBase is the host loopback on the node port', () =>
{
    assert.equal(InClusterRegistry.PushBase(), 'localhost:30500')
})
test('NodePort is inside the kubernetes NodePort range', () =>
{
    assert.ok(InClusterRegistry.NodePort >= 30000 && InClusterRegistry.NodePort <= 32767)
})
test('the registry image is pinned to registry:2', () =>
{
    assert.equal(InClusterRegistry.Image, 'registry:2')
})
```

- [ ] **Step 2: Run the test, verify it fails** — `node --test` on the file; expected FAIL (module not found / undefined).

- [ ] **Step 3: Implement `InClusterRegistry`** in `admin/control-plane/in-cluster-registry.ts` with the constants and the three composed statics from the Interfaces block. All addressing derives from the constants (no second copy of any literal).

- [ ] **Step 4: Run the test, verify it passes.**

- [ ] **Step 5: Commit** — `feat: InClusterRegistry two-address constants`.

---

### Task 2: `K8sManifestBuilder.RenderRegistry(hiveId)`

**Files:**
- Modify: `admin/control-plane/k8s-manifest-builder.ts` (add `RenderRegistry` + private object helpers + the constants it needs; reuse existing key constants — `ApiVersionCore`, `ApiVersionApps`, `ListKind`, `DeploymentKind`, `ServiceKind`, `NamespaceKind`, `PersistentVolumeClaimKind`, `ReadinessProbeKey`, `HttpGetKey`, `TypeKey`, `PortsKey`, `PortKey`, `TargetPortKey`, etc.)
- Test: `admin/control-plane/tests/k8s-manifest-builder-registry.test.ts`

**Interfaces:**
- Consumes: `InClusterRegistry` (Task 1) for name/namespace/image/ports/claim.
- Produces: `public RenderRegistry(hiveId: string): string` — `JSON.stringify` of `{ apiVersion: 'v1', kind: 'List', items: [...] }` containing, in order: the `pragmatic-system` Namespace, the registry Deployment, the NodePort Service, and the registry PVC. A new `NodePortKey = 'nodePort'` and `NodePortType = 'NodePort'` constant (and a `V2Path`/`DataClaim` reference via `InClusterRegistry`). `hiveId` is used for a `pragmatic/hive` label on the objects (addressing is cluster-fixed, so names/ports do not vary by hive).

- [ ] **Step 1: Write the failing test** — parse `JSON.parse(new K8sManifestBuilder().RenderRegistry('hive-1'))`:

```ts
const items = JSON.parse(new K8sManifestBuilder().RenderRegistry('hive-1')).items as any[]
const dep = items.find(o => o.kind === 'Deployment')
const svc = items.find(o => o.kind === 'Service')
const pvc = items.find(o => o.kind === 'PersistentVolumeClaim')

test('renders a registry:2 Deployment in pragmatic-system with a /v2/ readiness probe', () =>
{
    assert.equal(dep.metadata.namespace, 'pragmatic-system')
    const c = dep.spec.template.spec.containers[0]
    assert.equal(c.image, 'registry:2')
    assert.equal(c.readinessProbe.httpGet.path, '/v2/')
    assert.equal(c.readinessProbe.httpGet.port, 5000)
})
test('exposes a NodePort Service whose nodePort matches InClusterRegistry.NodePort', () =>
{
    assert.equal(svc.spec.type, 'NodePort')
    const p = svc.spec.ports[0]
    assert.equal(p.port, 5000)
    assert.equal(p.targetPort, 5000)
    assert.equal(p.nodePort, InClusterRegistry.NodePort)
})
test('backs the registry with a PVC the Deployment mounts', () =>
{
    assert.equal(pvc.metadata.name, InClusterRegistry.DataClaimName)
    const vols = dep.spec.template.spec.volumes
    assert.ok(vols.some((v: any) => v.persistentVolumeClaim?.claimName === InClusterRegistry.DataClaimName))
})
```

- [ ] **Step 2: Run the test, verify it fails** (method undefined).

- [ ] **Step 3: Implement `RenderRegistry` + its private helpers** following the existing object-builder style (mirror `RenderHiveAgent` for the List envelope and `ServerService`/`ServerDataClaim`/`ServerDeployment` for Service/PVC/Deployment shapes). The Service is `type: NodePort` with one port `{ port: 5000, targetPort: 5000, nodePort: 30500 }`. The Deployment is single-replica, image `registry:2`, `imagePullPolicy: IfNotPresent`, one container port 5000, a `/v2/` httpGet readiness probe, and a volume mounting the `pragmatic-registry-data` PVC at the registry data path (`/var/lib/registry`, hoisted to a constant). No strict non-root securityContext is imposed on the registry container (dev infra; `registry:2` is not hardened here — note this inline).

- [ ] **Step 4: Run the test, verify it passes. Run `tsc --noEmit` over `admin/` and verify clean.**

- [ ] **Step 5: Commit** — `feat: RenderRegistry emits the in-cluster registry workload`.

---

### Task 3: Gated `/v2/` round-trip smoke

**Files:**
- Create: `admin/control-plane/registry-roundtrip-smoke.ts`

**Interfaces:**
- Consumes: `InClusterRegistry` (Task 1), `K8sManifestBuilder.RenderRegistry` (Task 2), `KindCli.CreateCluster(name, { extraPortMappings: [InClusterRegistry.NodePort] })`, `KubectlCli.Apply`, and `KubectlCli` rollout/wait (mirror the readiness wait used by `kind-hive-smoke.ts` / `in-cluster-federation-smoke.ts`). `NodeExecFile` for `docker`/`kind`/`kubectl`.

This is a **standalone gated smoke**, not a unit test — it follows the `IsEntryPoint()` + `static Main()` + `async Run(): Promise<boolean>` convention of the sibling smokes and is run manually (`node dist/admin/control-plane/registry-roundtrip-smoke.js`). It requires Docker + kind + a free host port 30500. It is **not** added to the `tests/` suite and must not run in `node --test`.

- [ ] **Step 1: Implement `RegistryRoundtripSmoke`** with `Run()` performing, in order, each step wrapped in a pass/fail log line (mirror `in-cluster-federation-smoke.ts` logging + `try/finally` teardown):
  1. `docker pull registry:2`, then `kind load docker-image registry:2` onto the cluster node (hermetic; do after cluster create).
  2. `KindCli.CreateCluster(clusterName, { extraPortMappings: [InClusterRegistry.NodePort] })`.
  3. load the image (step 1b), then `kubectl apply` of `RenderRegistry(hiveId)`.
  4. wait for the registry Deployment to be Available (rollout status / `kubectl wait`).
  5. **host round-trip against `http://localhost:30500/v2/`**: assert `GET /v2/` → 200; push a small blob via a monolithic blob upload (`POST /v2/<repo>/blobs/uploads/` then `PUT <location>?digest=sha256:<hex>` with the bytes) and a minimal manifest (`PUT /v2/<repo>/manifests/<tag>`); `GET` the blob back by digest and assert byte-equality with what was pushed.
  6. **pod-DNS reachability**: `kubectl run` a throwaway curl/busybox pod (`--rm --restart=Never`) that `GET`s `http://` + `InClusterRegistry.PullBase()` + `/v2/` and assert it exits 0.
  7. `finally`: `KindCli.DeleteCluster(clusterName)`.
  `Run()` returns `true` only if every step passed.

- [ ] **Step 2: Add the entry-point tail** (`if (RegistryRoundtripSmoke.IsEntryPoint()) { await RegistryRoundtripSmoke.Main() }`) mirroring the siblings; `Main()` runs `Run()` and sets a non-zero exit on failure.

- [ ] **Step 3: Build and verify it does not run under the unit suite** — `tsc --noEmit` over `admin/` clean; confirm `node --test` discovery does not include this file (no `tests/` path, no `node:test` import).

- [ ] **Step 4: Commit** — `test: gated in-cluster registry /v2/ round-trip smoke`.

> **Verification note for the executor:** the gated smoke requires a live Docker/kind host and is not expected to run in the SDD review loop. Confirm it builds and type-checks; actually executing it against kind is a manual/operator step (like the other in-cluster smokes). Record in the ledger that smoke execution is operator-gated.
