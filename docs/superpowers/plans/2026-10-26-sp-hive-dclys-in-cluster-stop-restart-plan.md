# DclYs In-cluster env Stop/Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant admin can Stop and Restart an in-cluster environment: Stop scales the env-server Deployment to zero (namespace/PVC/Secrets retained), Start re-applies the manifest to restore one replica.

**Architecture:** Add a `Scale(namespace, deployment, replicas)` method through the existing kubectl→orchestrator seam (mirroring `Roll`/`SetImage`). `InClusterEnvironmentRuntime.Stop` becomes a guarded scale-to-zero instead of a 501 reject; the obsolete `EnvStopUnavailableInClusterError` and the route's 501 catch are deleted. `EnvironmentService.Stop/Start/Restart` and the status transitions already work generically — no service change. Start (= existing `BringUp`) re-applies the workload whose `ServerDeployment` pins `replicas: 1`, so 0→1 is deterministic.

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`, kubectl via `IKubectl`, docker-desktop k8s for the gated smoke. Single repo: pragmatic-server.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-dclys-in-cluster-stop-restart-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state.
- Allman braces; no inline string literals (hoist to `private static readonly` PascalCase). PascalCase interfaces + public methods.
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root. LF-only. Commit trailer: Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>.
- Stop scales ONLY the server Deployment; never calls `Teardown`/`DeleteNamespace`. DB StatefulSet stays running (deliberate; see spec).
- Docker path (`DockerEnvironmentRuntime`) byte-identical. No new `Restart` on the runtime or `IEnvironmentRuntime`.
- No worktree; branch `feat/sp-hive-dclys-stop-restart` off master.

## Review Focus

1. **Stop must not destroy state** — Stop calls `Scale(...,0)`, never `Teardown`. (Task 2 unit: Stop records a Scale(0) and NO Teardown. Smoke: namespace+PVC+Secrets present after Stop.)
2. **Start restores replicas + idempotent seed** — `kubectl apply` after scale-to-0 resets replicas to 1 (manifest-pinned); seed does not clobber live data. (Smoke: pod back + data preserved after Start.)
3. **No stderr/secret leak on Scale failure** — a failed scale surfaces as `InClusterOperationFailedError`. (Task 2 unit.)
4. **Docker path byte-identical** — Docker Stop still `docker.Down` without removeData. (Task 2 unit, if a Docker Stop test exists; else assert no change in the Docker runtime diff.)
5. **501 fully retired** — in-cluster Stop returns success + `Stopped`; the error class, the route catch, and the dead `StatusNotImplemented` constant are gone; no test still expects 501 for it. (Task 2: updated tests + a grep showing no remaining `EnvStopUnavailableInClusterError`.)

---

## Task 1: `Scale` seam through kubectl + orchestrators (+ all test-double stubs)

**Files:**
- Modify: `admin/control-plane/kubectl.ts` (`IKubectl.Scale` + `KubectlCli.Scale`), `admin/control-plane/hive-orchestrator.ts` (`IHiveOrchestrator.Scale`), `admin/control-plane/kubectl-hive-orchestrator.ts` (`Scale`), `admin/control-plane/kind-hive-orchestrator.ts` (`Scale` delegates to inner)
- Modify (test doubles — add a `Scale` stub so `tsc` stays green): `tests/control-plane-host-hive-health.test.ts`, `tests/kind-hive-orchestrator.test.ts` (FakeInner), `tests/tenant-api-mutate.test.ts`, `tests/tenant-api-read.test.ts` (all `implements IHiveOrchestrator`); `tests/kubectl-hive-orchestrator.test.ts`, `tests/in-cluster-idp-driver.test.ts`, `tests/in-cluster-idp-seed.test.ts` (all `implements IKubectl`). (The `in-cluster-environment-runtime.test.ts` orchestrator fake is handled in Task 2 where it must RECORD the call.)
- Test: `tests/kubectl-hive-orchestrator.test.ts` (extend) for the orchestrator Scale; a kubectl-cli arg test wherever the existing `SetImage`/`RolloutStatus` arg tests live (follow that file).

**Interfaces:**
- Produces: `IKubectl.Scale(namespace: string, deployment: string, replicas: number): Promise<void>`;
  `IHiveOrchestrator.Scale(workload: EnvironmentWorkload, replicas: number): Promise<void>`.

- [ ] **Step 1: Write failing tests** — (a) `KubectlCli.Scale('ns','dep',0)` invokes `kubectl` with args `['scale','deployment/dep','--replicas=0','-n','ns']` (fake exec recording argv; mirror the existing `SetImage` arg test); (b) `KubectlHiveOrchestrator.Scale(workload, 0)` calls `kubectl.Scale(K8sManifestBuilder.NamespaceOf(name), K8sManifestBuilder.ServerDeploymentOf(name), 0)`; (c) `KindHiveOrchestrator.Scale(workload, 0)` delegates to `inner.Scale` (no `EnsureCluster`).
- [ ] **Step 2: Run tests — expect fail** (`npx tsx --test admin/control-plane/tests/kubectl-hive-orchestrator.test.ts <and the cli arg test file>`).
- [ ] **Step 3: Implement** `Scale` on `IKubectl`/`KubectlCli` (via `Invoke`, new `'scale'` + `'--replicas='` constants, reusing `DeploymentPrefix`/`NamespaceFlag`), `IHiveOrchestrator`/`KubectlHiveOrchestrator` (derive ns/dep from the K8sManifestBuilder statics, like `Roll`), `KindHiveOrchestrator` (delegate). Add the compiling `Scale` stub to each of the 7 listed test doubles.
- [ ] **Step 4: Run tests — expect pass.** Then `tsc` (tools, tenant-admin, build) to confirm all doubles compile.
- [ ] **Step 5: Commit** (branch `feat/sp-hive-dclys-stop-restart` off master).

## Task 2: In-cluster `Stop` = scale-to-zero + retire the 501

**Files:**
- Modify: `admin/control-plane/in-cluster-environment-runtime.ts` (`Stop` = guarded `orchestrator.Scale(workload, 0)`; DELETE `EnvStopUnavailableInClusterError` + its throw), `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (remove the `EnvStopUnavailableInClusterError` import, the 501 catch, and the dead `StatusNotImplemented` constant)
- Modify (tests): `tests/in-cluster-environment-runtime.test.ts` (its `FakeOrchestrator` gains a recording `Scale`; replace the "Stop rejects with EnvStopUnavailableInClusterError" test with "Stop scales the server to 0 and does NOT Teardown" + "a failing Scale maps to InClusterOperationFailedError"), `tests/tenant-api-mutate.test.ts` (the in-cluster Stop case now expects success + `Stopped`, not 501; its `FakeService.StopError` wiring for the 501 is removed)
- Modify (smoke): `admin/control-plane/in-cluster-env-create-smoke.ts` (add a Stop→gone→Start→Ready phase)

**Interfaces:**
- Consumes: `IHiveOrchestrator.Scale` (Task 1); the existing `Resolve`/`Guard`/`Start`/`BringUp`.

- [ ] **Step 1: Write failing tests** — in `in-cluster-environment-runtime.test.ts`: (a) `Stop(ctx)` resolves and calls `orchestrator.Scale(workload, 0)` with NO `Teardown` call (the FakeOrchestrator records both); (b) a Scale that throws is mapped to `InClusterOperationFailedError` with no stderr text. In `tenant-api-mutate.test.ts`: (c) an in-cluster Stop returns success and the record is `Stopped` (not 501).
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** `Stop` = `const { orchestrator, workload } = this.Resolve(ctx); await this.Guard(() => orchestrator.Scale(workload, 0))`; delete the error class + throw; remove the route import, the 501 catch, and the `StatusNotImplemented` constant.
- [ ] **Step 4: Run tests — expect pass.** Then the full control-plane unit suite + `tsc` (tools, tenant-admin, build); grep to confirm no remaining `EnvStopUnavailableInClusterError`/`StatusNotImplemented`.
- [ ] **Step 5: Rewrite the gated smoke** to: create an in-cluster env → WaitHealthy; Stop → assert the server Deployment has 0 ready replicas / pod gone AND the namespace, PVC, and env Secrets still exist; Start → assert the pod returns (replicas 1), `/healthz` OK, and live PVC data preserved; Teardown. Mark operator-run. (Controller/operator runs it; a subagent cannot reach the cluster.)
- [ ] **Step 6: Commit.**

---

## Self-Review

- **Spec coverage:** Scale seam (Task 1), Stop-scale-to-zero + 501 retirement + smoke (Task 2); Start/Restart already work via the service layer (no task needed — noted). DB-scale-on-Stop is an explicit filed follow-up, not in scope.
- **Step scan:** each step writes one thing; test steps carry concrete argv/assertions.
- **Type consistency:** `Scale(namespace, deployment, replicas)` / `Scale(workload, replicas)` consistent across kubectl, orchestrators, and runtime call site.
- **Review Focus:** RF1/RF3 (Task 2 unit), RF2 (smoke), RF4 (Task 2 unit/diff), RF5 (Task 2 updated tests + grep) all pinned.
- **Proportion:** plan carries decisions + the full test-double edit list; shorter than the spec.
