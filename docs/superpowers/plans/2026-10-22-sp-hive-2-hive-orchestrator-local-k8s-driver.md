# SP-HIVE-2 — Hive Orchestrator + Local/Attach Docker Desktop k8s Driver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a hive real — a `HiveOrchestrator` abstraction keyed on backend × mode, plus the first driver (local/attach against Docker Desktop k8s) that can stand an environment workload up, health-check it, roll it, and tear it down via `kubectl`.

**Architecture:** A fakeable `IKubectl` CLI seam (`execFile`, arg arrays, context-scoped) + a `K8sManifestBuilder` (renders an `EnvironmentWorkload` into namespace/Deployment/Service/StatefulSet) + a `KubectlHiveOrchestrator` that drives them, resolved from a `HiveRecord` by a `HiveOrchestratorFactory` (only `{local,attach}` implemented; all else `UnsupportedBackendError`). The shipped raw-`docker` lifecycle (`DockerEnv`/`EnvironmentService`) is left untouched; the k8s path is proven by unit tests (fake kubectl) and a gated real-cluster smoke.

**Tech Stack:** TypeScript, `node:child_process` `execFile`, `node:test` via `tsx --test`, `kubectl` v1.36 against Docker Desktop k8s (context `docker-desktop`).

**Spec:** `docs/superpowers/specs/2026-10-22-sp-hive-2-hive-orchestrator-local-k8s-driver-spec.md`

## Global Constraints

- **kubectl shell-out only** via `execFile('kubectl', [...])` with argument arrays — never a shell; 16 MB maxBuffer; every call carries `--context <ctx>` (mirrors `DockerEnv.Exec` in `environments/seed/docker.ts`).
- **Local-first on Docker Desktop k8s**; attach mode; local default context `docker-desktop`; server image `pragmatic-server:dev` with `imagePullPolicy: IfNotPresent` (shared-store fast path).
- **Credentials server-side by name** — kubeconfig/context, registry secrets, DB passwords referenced by *name*, never as values in logged manifests, DTOs, errors, or the portal. Secret-looking tokens redacted before any stderr is surfaced.
- **Reuse, don't fork** — leave `DockerEnv`/`EnvironmentService`/`EnvironmentRegistry` and their routes unchanged; add the orchestrator alongside.
- **OOP**: classes with methods, no module-level free functions/state. **Allman** braces. **No inline string literals** in TS — hoist to `private static readonly`. **PascalCase** public methods/interfaces.
- **Tests in `tests/` subfolders.** **LF-only.** Admin tests run with an explicit glob: `npx tsx --test "admin/control-plane/tests/*.test.ts"` (root `npm test` does **not** cover `admin/`). Type coverage: `npm run typecheck:tools`.
- Enums over string-literal sets; typed error classes matching the SP-HIVE-1 style (`InvalidRecordIdError`, `HivePlacementError`, …).

## Review Focus

- **Secret leakage:** a DB password or kubeconfig token appearing in a rendered manifest string, a `KubectlError` message, or a health DTO — pinned by Task 2 (redaction) + Task 3 (password is a `secretKeyRef`, never a literal) + Task 7 (health DTO has no secret).
- **Shell/arg injection via environment name:** a crafted `environmentName` reaching a shell or an unescaped arg — pinned by Task 2 (arg-array assertions) + Task 1 (name is validated/sanitized before it becomes a namespace).
- **Teardown blast radius:** `Teardown` must delete only the environment's own namespace, never a cluster-scoped object or another namespace (attach must leave the cluster intact) — pinned by Task 4.
- **Silent roll failure:** `Roll`/`WaitHealthy` must throw when `kubectl rollout status` fails, not report success on a half-updated workload — pinned by Task 4.
- **Wrong-backend dispatch:** the factory must never hand back a local k8s driver for a cloud/provision hive (would schedule cloud workloads onto docker-desktop) — pinned by Task 5 (`UnsupportedBackendError` for every non-`{local,attach}` pair).

---

### Task 1: `EnvironmentWorkload` + factory

**Files:**
- Create: `admin/control-plane/environment-workload.ts`
- Test: `admin/control-plane/tests/environment-workload.test.ts`

**Interfaces:**
- Consumes: `EnvironmentRecord` (`admin/control-plane/environment-record.ts`: `name`, `template`, `tenantId`, `hiveId?`, `hostPort`), `HiveRecord` + `HiveBackend`/`InfraMode` (`admin/control-plane/platform-records.ts`).
- Produces: `type WorkloadDatabase = { image, user, database, passwordRef }`; `type EnvironmentWorkload = { environmentName, hiveId, image, serverPort, env: Readonly<Record<string,string>>, secretRefs: readonly string[], database?: WorkloadDatabase }`; `class EnvironmentWorkloadFactory { static From(record: EnvironmentRecord, hive: HiveRecord): EnvironmentWorkload }`.

- [ ] **Step 1: Write the failing tests** in `environment-workload.test.ts`:
  - `From` on a `runtime-postgres` record returns `database` set (`image` `postgres:16`, `passwordRef` a name string), `image` `pragmatic-server:dev`, `serverPort` 8080, `environmentName` == record name, `hiveId` == hive id.
  - `From` on a `dev-blank` record returns `database` undefined.
  - the returned `secretRefs` contain only name strings (assert none equals any known value token planted in the record), and `database.passwordRef` is a name, not a value.
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/environment-workload.test.ts"` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `EnvironmentWorkload`, `WorkloadDatabase`, and `EnvironmentWorkloadFactory.From`. `serverPort` fixed at 8080 (matches the docker model's container port). Database present iff the template implies Postgres (`runtime-postgres`, `demo-contoso`); reuse the template→DB decision already encoded for `EnvDefinition` where derivable, else a `private static readonly` set of DB-bearing templates. Secret-name constants hoisted.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): EnvironmentWorkload + factory`).

---

### Task 2: `IKubectl` seam + `KubectlCli` + `KubectlError`

**Files:**
- Create: `admin/control-plane/kubectl.ts`
- Test: `admin/control-plane/tests/kubectl.test.ts`

**Interfaces:**
- Produces: `interface IKubectl { Apply(manifestJson: string): Promise<void>; RolloutStatus(namespace: string, deployment: string): Promise<void>; SetImage(namespace: string, deployment: string, container: string, image: string): Promise<void>; Get(namespace: string, resource: string): Promise<string>; DeleteNamespace(namespace: string): Promise<void>; Version(): Promise<string> }`; `class KubectlCli implements IKubectl` with `constructor(context: string, exec?: IExecFile)`; `class KubectlError extends Error`; `interface IExecFile { Run(file: string, args: readonly string[], stdin?: string): Promise<{ stdout: string; stderr: string }> }` (the fakeable `execFile` wrapper — real impl `NodeExecFile` in same file, using `node:child_process` `execFile` with 16 MB maxBuffer, writing `stdin` to the child when present).

- [ ] **Step 1: Write the failing tests** with a fake `IExecFile` capturing calls:
  - every method prefixes args with `['--context', context]`; `Apply` runs `kubectl apply -f -` and passes `manifestJson` as stdin; `RolloutStatus` → `rollout status deployment/<dep> -n <ns>`; `SetImage` → `set image deployment/<dep> <container>=<image> -n <ns>`; `Get` → `get <resource> -n <ns> -o json` and returns stdout; `DeleteNamespace` → `delete namespace <ns> --ignore-not-found`.
  - the fake rejects with a non-zero result carrying a stderr string that embeds a planted secret token; assert the thrown `KubectlError.message` does **not** contain the token (redacted).
  - args are passed as an array to `IExecFile.Run` (never a single concatenated shell string).
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/kubectl.test.ts"` — expect FAIL.
- [ ] **Step 3: Implement** `KubectlCli` (arg arrays, context prefix, stdin for `Apply`), `NodeExecFile`, and `KubectlError` with a `private static readonly` redaction pattern replacing secret-looking tokens (base64-ish/long hex / `password=…`) before surfacing stderr.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): kubectl CLI seam + redaction`).

---

### Task 3: `K8sManifestBuilder`

**Files:**
- Create: `admin/control-plane/k8s-manifest-builder.ts`
- Test: `admin/control-plane/tests/k8s-manifest-builder.test.ts`

**Interfaces:**
- Consumes: `EnvironmentWorkload`/`WorkloadDatabase` (Task 1).
- Produces: `class K8sManifestBuilder { Render(workload: EnvironmentWorkload): string }` returning a JSON `{ apiVersion: 'v1', kind: 'List', items: [...] }`; plus `static NamespaceOf(environmentName: string): string`, `static ServerDeploymentOf(environmentName: string): string`, `static ServerContainerName`, used by Task 4.

- [ ] **Step 1: Write the failing tests** (parse `Render` output as JSON):
  - a workload **with** a database yields items of kinds `Namespace`, `Deployment` (server), `Service` (server, ClusterIP, port 8080), `StatefulSet` (postgres), `Service` (postgres headless).
  - a workload **without** a database yields only Namespace + server Deployment + server Service.
  - the Namespace is `pragmatic-env-<name>` with labels `pragmatic/environment` and `pragmatic/hive`.
  - the server Deployment: image == `workload.image`, `imagePullPolicy: IfNotPresent`, a `readinessProbe` on the server port, env entries for each `workload.env` key.
  - the Postgres `POSTGRES_PASSWORD` is a `valueFrom.secretKeyRef` referencing `database.passwordRef`; assert the rendered string contains **no** value token (only the ref name).
  - `NamespaceOf` / `ServerDeploymentOf` match the names used in the rendered objects.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** `K8sManifestBuilder`. All object-shape literals built from hoisted `private static readonly` field-name/label/kind constants (no inline string literals). Readiness-probe path reuses the server health/ping path the docker `WaitHealthy` already hits (resolve from the existing docker health check; if a constant exists, import it). `volumeClaimTemplate` with a small fixed size for Postgres data.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): k8s manifest builder`).

---

### Task 4: `IHiveOrchestrator` + `KubectlHiveOrchestrator`

**Files:**
- Create: `admin/control-plane/hive-orchestrator.ts` (interface + `WorkloadHealth` + `UnsupportedBackendError`)
- Create: `admin/control-plane/kubectl-hive-orchestrator.ts`
- Test: `admin/control-plane/tests/kubectl-hive-orchestrator.test.ts`

**Interfaces:**
- Consumes: `IKubectl` (Task 2), `K8sManifestBuilder` + `NamespaceOf`/`ServerDeploymentOf`/`ServerContainerName` (Task 3), `EnvironmentWorkload` (Task 1).
- Produces: `type WorkloadHealth = { ready: boolean; runningImage: string | undefined; detail: string }`; `interface IHiveOrchestrator { Apply(w): Promise<void>; WaitHealthy(w): Promise<void>; Health(w): Promise<WorkloadHealth>; Roll(w, image: string): Promise<void>; Teardown(w): Promise<void> }`; `class UnsupportedBackendError extends Error` (ctor `(backend: HiveBackend, mode: InfraMode)`); `class KubectlHiveOrchestrator implements IHiveOrchestrator` with `constructor(kubectl: IKubectl, manifests: K8sManifestBuilder)`.

- [ ] **Step 1: Write the failing tests** with a fake `IKubectl` recording calls:
  - `Apply(w)` calls `kubectl.Apply` once with exactly `manifests.Render(w)`.
  - `WaitHealthy(w)` calls `RolloutStatus(NamespaceOf(name), ServerDeploymentOf(name))`; when a DB is present it also awaits the Postgres rollout/ready.
  - `WaitHealthy` **rejects** when the fake `RolloutStatus` rejects (no swallow).
  - `Roll(w, img)` calls `SetImage(ns, serverDep, ServerContainerName, img)` then `RolloutStatus(ns, serverDep)`, in that order; rejects if either rejects.
  - `Health(w)` parses a fake `Get` JSON (`status.readyReplicas`, container image) into `WorkloadHealth { ready, runningImage, detail }`; `detail` contains no secret.
  - `Teardown(w)` calls `DeleteNamespace(NamespaceOf(name))` and **only** that (assert no other namespace/resource is deleted).
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** both files. `Health` reads ready replica count + the server container's running image from `kubectl get deployment -o json`. Hoisted string constants; Allman braces.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): kubectl hive orchestrator`).

---

### Task 5: `HiveOrchestratorFactory`

**Files:**
- Create: `admin/control-plane/hive-orchestrator-factory.ts`
- Test: `admin/control-plane/tests/hive-orchestrator-factory.test.ts`

**Interfaces:**
- Consumes: `HiveRecord`, `HiveBackend`, `InfraMode` (platform-records.ts); `IHiveOrchestrator`, `UnsupportedBackendError` (Task 4); `KubectlHiveOrchestrator` (Task 4); `KubectlCli` (Task 2); `K8sManifestBuilder` (Task 3).
- Produces: `class HiveOrchestratorFactory { constructor(localContext?: string); For(hive: HiveRecord): IHiveOrchestrator }`.

- [ ] **Step 1: Write the failing tests**:
  - `For` on a hive with `cluster = { backend: Local, mode: Attach }` returns an instance that is a `KubectlHiveOrchestrator`.
  - `For` on `{ Aks, Attach }`, `{ Local, Provision }`, `{ Private, Attach }`, `{ Eks, Provision }` each throw `UnsupportedBackendError` whose message names the backend and mode.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** `For`: for `{Local, Attach}` build `new KubectlHiveOrchestrator(new KubectlCli(context, …), new K8sManifestBuilder())` where `context` is `hive.cluster.configRef` if set else the ctor `localContext` (default `docker-desktop`); every other pair throws `UnsupportedBackendError`. Default context hoisted as a `private static readonly` constant.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): hive orchestrator factory`).

---

### Task 6: Placement wiring — bind an environment to a hive

**Files:**
- Create: `admin/control-plane/environment-placement.ts` (`class EnvironmentPlacement`)
- Test: `admin/control-plane/tests/environment-placement.test.ts`

**Interfaces:**
- Consumes: `PlatformDirectory` (`ValidateHivePlacement(tenantId, hiveId): void`, `GetHive(id)`) from `platform-directory.ts`; `EnvironmentRecord`; `EnvironmentWorkloadFactory.From` (Task 1); `HivePlacementError` (platform-directory.ts).
- Produces: `class EnvironmentPlacement { constructor(directory: PlatformDirectory); WorkloadFor(record: EnvironmentRecord): EnvironmentWorkload }` — resolves the record's `hiveId`, calls `directory.ValidateHivePlacement(record.tenantId, record.hiveId)`, then returns `EnvironmentWorkloadFactory.From(record, hive)`.

- [ ] **Step 1: Write the failing tests** (fake/real `PlatformDirectory` over temp stores):
  - `WorkloadFor` on a record whose `hiveId` belongs to the record's tenant returns the workload (hiveId threaded through).
  - `WorkloadFor` on a record whose `hiveId` belongs to a *different* tenant throws `HivePlacementError` (this exercises the previously-uncalled `ValidateHivePlacement`).
  - `WorkloadFor` on a record with no `hiveId` throws a typed error (unplaced environments can't be scheduled on a hive).
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** `EnvironmentPlacement.WorkloadFor`. Add an `EnvironmentNotPlacedError` (hoisted messages) for the no-`hiveId` case.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): environment placement + wire ValidateHivePlacement`).

---

### Task 7: Host route `GET /api/hives/:id/health`

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (add route in `RoutePlatform`/`RouteApi`; add `HiveHealthDto`; extend `ErrorStatuses` with `UnsupportedBackendError` → 400; add a `HiveOrchestratorFactory` constructor arg)
- Modify: `admin/control-plane/server.ts` (construct `HiveOrchestratorFactory`, pass to `ControlPlaneHost`)
- Modify: `admin/control-plane/control-plane-smoke.ts` (same wiring for the composed stack)
- Test: `admin/control-plane/tests/control-plane-host-hive-health.test.ts`

**Interfaces:**
- Consumes: `HiveOrchestratorFactory.For` (Task 5); `IHiveOrchestrator.Health` + `WorkloadHealth` (Task 4); `EnvironmentPlacement.WorkloadFor` (Task 6); `PlatformDirectory.GetHive`/`ListHives`; `EnvironmentRecord` list via the existing `IEnvironmentLookup`/service.
- Produces: `type HiveHealthDto = { environmentName: string; ready: boolean; runningImage: string | undefined; detail: string }`; route `GET /api/hives/:id/health` → `HiveHealthDto[]`.

- [ ] **Step 1: Write the failing test** (compose `ControlPlaneHost` with a fake service + a fake `HiveOrchestratorFactory` whose `For` returns a fake orchestrator; authenticated operator):
  - `GET /api/hives/<localHive>/health` returns 200 and a JSON array of `HiveHealthDto` for each environment bound to that hive (one entry per matching `EnvironmentRecord.hiveId`); the payload contains no secret field.
  - `GET /api/hives/<cloudHive>/health` (factory `For` throws `UnsupportedBackendError`) returns 400.
  - unauthenticated request → 401 (existing gate).
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/control-plane-host-hive-health.test.ts"` — expect FAIL.
- [ ] **Step 3: Implement** the route and DTO; add the 7th constructor arg `private readonly orchestrators: HiveOrchestratorFactory`; map `UnsupportedBackendError` → 400 in `ErrorStatuses`. Wire the new arg in `server.ts` and `control-plane-smoke.ts` (construct `new HiveOrchestratorFactory()`; the smoke keeps composing the real stack). DTO/field-name constants hoisted.
- [ ] **Step 4: Run** the test + the full admin suite `npx tsx --test "admin/control-plane/tests/*.test.ts"` — expect PASS, no regressions.
- [ ] **Step 5: Run** `npm run typecheck:tools` — expect clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-2): hive health route + wiring`).

---

### Task 8: Gated real-cluster smoke

**Files:**
- Create: `admin/control-plane/k8s-hive-smoke.ts`
- Modify: `admin/control-plane/README.md` (document it as a gated smoke, like `control-plane-smoke.ts`)

**Interfaces:**
- Consumes: everything above; composes a real `KubectlHiveOrchestrator` against context `docker-desktop`.

- [ ] **Step 1: Implement** `class K8sHiveSmoke` with `static async Main()` + `IsEntryPoint()`, mirroring `control-plane-smoke.ts` structure. It: builds a throwaway `EnvironmentWorkload` (dev-blank, image `pragmatic-server:dev`), `Apply`, `WaitHealthy`, asserts the server pod is Ready and serves its health endpoint (via `kubectl port-forward` to a local port — chosen over NodePort to avoid cluster-wide port state; justify inline), `Roll` to `pragmatic-server:dev` again and assert `rollout status` completes, `Teardown` and assert `kubectl get namespace <ns>` reports not-found. Seeds the dev Postgres secret (when a DB workload is exercised) via `kubectl create secret` in a local-dev-only helper, clearly labelled.
- [ ] **Step 2: Guard** it out of the normal run: it is a standalone entrypoint (run `npx tsx admin/control-plane/k8s-hive-smoke.ts`), not matched by `tests/*.test.ts`. Confirm `npx tsx --test "admin/control-plane/tests/*.test.ts"` does not pick it up.
- [ ] **Step 3: Run** the smoke for real against Docker Desktop k8s; capture that pods come up, serve, roll, and tear down clean. If the environment lacks the cluster or image, record that it was not runnable and why (do not fake a pass).
- [ ] **Step 4: Commit** (`test(sp-hive-2): gated docker-desktop k8s smoke`).

---

## Notes for the executor

- The shipped docker lifecycle (`DockerEnv`, `EnvironmentService.Create/Start/Stop/Delete`, their routes) is **not** modified. If a task seems to require changing it, stop and re-read scope — the k8s path is additive.
- Follow `control-plane-smoke.ts` for the real-infra smoke shape and `environment-service.test.ts` for the in-file-fakes unit-test shape.
- Field names inside rendered k8s manifests and parsed `kubectl -o json` are external JSON contracts (`apiVersion`, `kind`, `metadata`, `spec`, `status.readyReplicas`, …) and keep their upstream casing; the no-inline-literal rule still applies — hoist them to `private static readonly` constants, don't scatter them.
