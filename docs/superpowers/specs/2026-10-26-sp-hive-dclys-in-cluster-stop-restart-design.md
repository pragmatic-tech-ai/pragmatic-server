# DclYs — In-cluster env Stop / Restart via scale-to-zero (design)

**Status:** approved for planning (AFK autonomous run; merge locally, never push).
**Project item:** `PVTI_lADOE0Zc984Biu4ozhDclYs` (Kind=Feature) — "In-cluster env Stop/Restart support".
**Spun off from:** P2 in-cluster-env-create, which delivered Create/Delete but left in-cluster Stop returning HTTP 501 (`EnvStopUnavailableInClusterError`).

## Intent & why

A tenant admin can Stop/Restart a Docker environment but not an in-cluster one: in-cluster `Stop` throws
`EnvStopUnavailableInClusterError` (`admin/control-plane/in-cluster-environment-runtime.ts:148-151`),
caught and mapped to HTTP 501 (`admin/control-plane/tenant-api/tenant-api-endpoint.ts:314-322`). This
closes that gap by stopping the env the k8s-native way: scale the env-server Deployment to zero replicas,
keeping the namespace, PVC, and Secrets so data and config survive; Start scales back by re-applying the
workload manifest (whose `ServerDeployment` pins `replicas: 1`).

Recon confirmed the service/route layer is ALREADY generic: `EnvironmentService.Stop` already sets
`EnvStatus.Stopped` (`environment-service.ts:353-358`), `Start` sets `Running` (`:346-351`), and `Restart`
already composes Stop+Start (`:361-365`). The ONLY thing blocking in-cluster is the runtime's deliberate
reject plus the route's 501 catch. So this feature is a thin seam addition (`Scale`) + flipping `Stop` from
reject to scale-to-zero + deleting the now-obsolete 501 path.

## The mechanism

- **Stop** = scale the env-server Deployment to 0. Namespace/PVC/Secrets untouched (only `Teardown`/
  `DeleteNamespace` removes those). Pod terminates; data on the PVC and config/secret objects remain.
- **Start** = the existing `InClusterEnvironmentRuntime.Start` → `BringUp` (`in-cluster-environment-runtime.ts:141-146`):
  re-applies the workload manifest (`ServerDeployment` sets `replicas: SingleReplica = 1`, `k8s-manifest-builder.ts:868,102`),
  so a `kubectl apply` after scale-to-0 deterministically restores 1 replica; then re-applies the seed
  bundle, idempotent via the `.env-seeded` marker (so live PVC data is never clobbered). Then WaitHealthy.
- **Restart** = `EnvironmentService.Restart` (Stop then Start) — works automatically once Stop works; no
  runtime `Restart` exists or is needed (it is a service-level composition, and `IEnvironmentRuntime` has
  no `Restart`).

## Decisions (mine, as the builder — AFK)

- **New seam method `Scale`, mirroring the existing `Roll`/`SetImage` plumbing.** `IKubectl` gains
  `Scale(namespace, deployment, replicas)`; `KubectlCli` runs `kubectl scale deployment/<dep>
  --replicas=<n> -n <ns>` through the existing private `Invoke` (`kubectl.ts:123-137`), so stderr is
  redacted by `KubectlError` exactly as other verbs. `IHiveOrchestrator` gains `Scale(workload, replicas)`;
  `KubectlHiveOrchestrator` derives the namespace/deployment via `K8sManifestBuilder.NamespaceOf` /
  `ServerDeploymentOf` (as `Roll` does, `kubectl-hive-orchestrator.ts:80-87`); `KindHiveOrchestrator`
  delegates to `this.inner.Scale` (no `EnsureCluster` — scaling only applies to an already-provisioned
  cluster, matching how it delegates `Roll`/`Teardown`).
- **`InClusterEnvironmentRuntime.Stop` scales to zero, never tears down.** Replace the reject with
  `const { orchestrator, workload } = this.Resolve(ctx); await this.Guard(() => orchestrator.Scale(workload, 0))`.
  Using `Guard` (`in-cluster-environment-runtime.ts:192-202`) means any failure surfaces as the existing
  `InClusterOperationFailedError` with NO stderr/secret leak, consistent with BringUp/WaitHealthy/Teardown.
- **Delete the obsolete error + 501 path.** `EnvStopUnavailableInClusterError` (`in-cluster-environment-runtime.ts:40-50`)
  and its sole throw are removed; the route's 501 catch (`tenant-api-endpoint.ts:314-322`) and the import
  are removed so in-cluster Stop returns success (200) and status `Stopped` like Docker. A real Scale
  failure flows through the route's generic error path (already `InClusterOperationFailedError`, no leak).
- **Stop scales only the env-server Deployment; the database StatefulSet (if any) stays running.** The
  "stopped" contract is: not serving + data retained + restartable — which scaling the server to 0 fully
  satisfies. Leaving the DB StatefulSet up is deliberate: it keeps the data safe (PVC retained either way),
  avoids StatefulSet scale-down/up and a Start-time DB readiness race, and makes Restart faster (no DB
  cold start). The cost is that a Stopped env still runs one idle DB pod. Reclaiming that (scaling the DB
  StatefulSet to 0 on Stop and back on Start) is a bounded follow-up, filed, not done here — it would add
  DB-presence branching and a statefulset-scale path to this otherwise minimal task. `Scale` therefore
  targets the server Deployment only (like `Roll`).
- **Docker path unchanged.** `DockerEnvironmentRuntime.Stop` (`docker.Down`, keeps the volume) and
  Start/Teardown are untouched; this is an in-cluster-runtime-only change. (Note a benign semantic
  difference: Docker Stop downs the whole env including its DB container, while in-cluster Stop leaves the
  DB pod running per the decision above; both retain data and restart cleanly.)
- **Start's bundle dependency is pre-existing, not introduced here.** `BringUp` needs `ctx.bundleDir`
  (`InClusterBundleMissingError`); `EnvironmentService.CtxOf` supplies `join(dataRoot, name)` and the boot
  bundle from Create is not deleted on success. Start therefore works as long as the control-plane data
  root still holds the bundle (true in the normal single-control-plane deployment). Not solved here; noted
  as a known property and asserted by the smoke running Start right after Stop.

## Non-goals / anti-goals

- No change to Docker Stop/Start/Restart behavior.
- No deletion of namespace/PVC/Secrets on Stop (that is Delete/Teardown, a different operation).
- No new Restart method on the runtime or the `IEnvironmentRuntime` seam.
- No change to the unrelated `EnvLogsUnavailableInClusterError` (stays as-is; it is not mapped to 501).
- No control-plane-side durability work for the boot bundle (pre-existing; separate concern).

## Component shape (for the plan)

- `admin/control-plane/kubectl.ts` — `IKubectl.Scale(namespace, deployment, replicas: number): Promise<void>`;
  `KubectlCli.Scale` via `Invoke(['scale', DeploymentPrefix+deployment, '--replicas='+String(replicas), NamespaceFlag, namespace])`.
  New constants for `'scale'` and `'--replicas='`.
- `admin/control-plane/hive-orchestrator.ts` — `IHiveOrchestrator.Scale(workload: EnvironmentWorkload, replicas: number): Promise<void>`.
- `admin/control-plane/kubectl-hive-orchestrator.ts` — `Scale` deriving ns/dep from the K8sManifestBuilder statics.
- `admin/control-plane/kind-hive-orchestrator.ts` — `Scale` delegating to `this.inner.Scale`.
- `admin/control-plane/in-cluster-environment-runtime.ts` — `Stop` = guarded scale-to-0; delete `EnvStopUnavailableInClusterError` + its throw.
- `admin/control-plane/tenant-api/tenant-api-endpoint.ts` — remove the `EnvStopUnavailableInClusterError` import, the 501 catch (`:314-322`), AND the now-dead `StatusNotImplemented = 501` constant (`:96`, used only by that catch).
- **Test doubles that must gain a `Scale` stub to keep `tsc` green** (TS `implements` is enforced — enumerate all up front):
  - `implements IHiveOrchestrator`: `tests/in-cluster-environment-runtime.test.ts` (the `FakeOrchestrator` — also records the Scale call/replicas for the Stop assertion), `tests/control-plane-host-hive-health.test.ts`, `tests/kind-hive-orchestrator.test.ts` (`FakeInner`), `tests/tenant-api-mutate.test.ts`, `tests/tenant-api-read.test.ts`.
  - `implements IKubectl`: `tests/kubectl-hive-orchestrator.test.ts`, `tests/in-cluster-idp-driver.test.ts`, `tests/in-cluster-idp-seed.test.ts`. (The `FakeKubectl` inside `in-cluster-environment-runtime.test.ts` is cast `as unknown as IKubectl`, so it does not need the stub.)

## Verification

- **Unit (`tsx --test`, no cluster):**
  - `InClusterEnvironmentRuntime.Stop` calls `orchestrator.Scale(workload, 0)` and does NOT call `Teardown`
    (fake orchestrator records a `Scale` with replicas 0, no `Teardown`); a Scale failure maps to
    `InClusterOperationFailedError` with no stderr text.
  - `KubectlCli.Scale` invokes `kubectl` with `['scale','deployment/<dep>','--replicas=0','-n','<ns>']`
    (mirror the existing `SetImage`/`RolloutStatus` arg tests, fake exec).
  - `KubectlHiveOrchestrator.Scale` targets `NamespaceOf(name)` + `ServerDeploymentOf(name)`;
    `KindHiveOrchestrator.Scale` delegates to inner.
  - Route: an in-cluster Stop no longer returns 501 — update `tests/tenant-api-mutate.test.ts:296-301` to
    expect success + `Stopped`; update `tests/in-cluster-environment-runtime.test.ts:161` (Stop now
    resolves via Scale, not rejects).
- **Gated live smoke (`in-cluster-env-create-smoke`, operator-run, docker-desktop):** create an in-cluster
  env → WaitHealthy; Stop → assert the Deployment has 0 ready replicas / the pod is gone AND the namespace,
  PVC, and the env Secrets still exist; Start → assert the pod returns, replicas back to 1, `/healthz` OK,
  and (marker intact) live PVC data preserved; Teardown removes the namespace.
- control-plane unit suite green; `tsc` tools+tenant-admin+build clean.

## Review focus (likely-to-bite, pin each in a task test)

1. **Stop must not destroy state** — Stop calls `Scale(...,0)`, never `Teardown`/`DeleteNamespace`; the
   namespace/PVC/Secrets survive so Start restores the same data. (Unit: no Teardown on Stop. Smoke:
   namespace+PVC+Secrets present after Stop.)
2. **Start restores replicas deterministically + idempotent seed** — `kubectl apply` after scale-to-0 resets
   replicas to 1 (manifest pins it); the seed does not re-run / clobber live data (marker). (Smoke:
   pod back + data preserved.)
3. **No stderr/secret leak on Scale failure** — a failed `kubectl scale` surfaces as
   `InClusterOperationFailedError`, not raw stderr. (Unit.)
4. **Docker path byte-identical** — Docker Stop/Start/Restart unchanged. (Unit: Docker Stop still calls
   `docker.Down` without removeData.)
5. **501 fully retired** — in-cluster Stop returns 200 + `Stopped`; no caller/test still expects 501 for
   it; the obsolete error class and route catch are gone. (Unit: the two updated tests; grep shows no
   remaining `EnvStopUnavailableInClusterError`.)
