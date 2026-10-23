# SP-HIVE-5 — kind Provision Driver + Multi-Hive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kind`-backed provision driver that plugs into `HiveOrchestratorFactory` so a hive can stand its own Kubernetes cluster up from nothing (provision mode) and many hives can coexist as many clusters (multi-hive).

**Architecture:** A new `IKind`/`KindCli` seam (the `kind` CLI over the existing `IExecFile`, mirroring `IKubectl`/`KubectlCli`). A `KindHiveOrchestrator` for `Local+Provision` that ensures the hive's kind cluster on Apply, delegates all workload ops to an inner `KubectlHiveOrchestrator` pointed at the cluster's context, keeps `Teardown(w)` namespace-scoped, and exposes a separate hive-scoped `DestroyCluster()`. Fake-driven unit tests; a gated real-`kind` smoke (written, not run).

**Tech Stack:** TypeScript (ESM, Node ≥22.5, explicit `.js` imports), `node:test`+`tsx`, `kind` CLI via `IExecFile`/`NodeExecFile` (from `admin/control-plane/kubectl.ts`), existing `KubectlHiveOrchestrator`/`KubectlCli`/`K8sManifestBuilder`/`EffectiveRegistry`/`CryptoImageVerifier`.

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-5-kind-provision-driver-spec.md`

## Global Constraints

- OOP only; Allman braces; PascalCase for interfaces and public methods. No module-level free functions or mutable module state.
- No inline string literals for reused strings / CLI subcommands / flags / messages — hoist to `private static readonly` constants.
- **No shell string interpolation** — every `kind` invocation is an argument array through `IExecFile`. Reuse `NodeExecFile` (300 s timeout, 16 MB buffer, no shell).
- **No kubeconfig/credential/token/secret content in any log or error.** `KindError` redacts stderr — reuse `KubectlError.Redact` (public static) rather than duplicating the regex.
- Do NOT change the `IHiveOrchestrator` interface. Do NOT change the attach driver's behavior.
- Tests live in `admin/control-plane/tests/`. Run: `npx tsx --test "admin/control-plane/tests/*.test.ts"`. Build: `npm run build`; tools typecheck: `npm run typecheck:tools`. Do NOT run `npm install` (breaks workspace symlinks).
- The gated smoke is NOT a `*.test.ts` and is NOT run in this plan — only type-checked.
- Commit after each task; each task ends green on its own tests.

## Review Focus

- **Teardown granularity:** `KindHiveOrchestrator.Teardown(w)` must delegate to the inner (namespace-scoped) and must NOT call `DeleteCluster` — destroying a shared hive on single-environment teardown is the headline footgun. Task 3 asserts Teardown delegates and the fake `IKind` sees no delete.
- **Health on an un-provisioned cluster:** the wired polling path must return *not ready* (no throw, no inner call) when `ListClusters` lacks the cluster. Task 3 tests it.
- **Cluster-name rejection:** a hiveId that is empty, uppercase, contains `_`/`.`/non-`[a-z0-9-]`, or is over-length must throw `InvalidHiveClusterNameError` before any `kind` call. Task 1 tests each class.
- **`kind get clusters` empty/sentinel parsing:** `ListClusters` must return `[]` (not `['No kind clusters found.']` or `['']`) when there are no clusters. Task 2 tests the empty and sentinel cases.
- **Idempotent ensure:** Apply on an already-present cluster must not call `CreateCluster`; `DestroyCluster`/`DeleteCluster` on an absent cluster is a no-op. Task 3 tests the no-recreate path.

---

### Task 1: KindClusterName + InvalidHiveClusterNameError

**Files:**
- Create: `admin/control-plane/kind-cluster-name.ts`
- Test: `admin/control-plane/tests/kind-cluster-name.test.ts`

**Interfaces:**
- Produces: `export class InvalidHiveClusterNameError extends Error` (message names the offending hiveId; hoisted prefix). `export class KindClusterName` with `static For(hiveId: string): string` (→ `pragmatic-hive-<hiveId>`; throws `InvalidHiveClusterNameError` unless the hiveId is non-empty AND the composed name matches `^[a-z0-9-]+$` AND its length ≤ 49) and `static ContextFor(clusterName: string): string` (→ `kind-<clusterName>`).

- [ ] **Step 1: Write failing tests.**
  - `test('For composes pragmatic-hive-<id> for a valid id')` → `KindClusterName.For('acme1')` === `'pragmatic-hive-acme1'`.
  - `test('ContextFor prefixes kind-')` → `ContextFor('pragmatic-hive-acme1')` === `'kind-pragmatic-hive-acme1'`.
  - `test('For rejects empty, uppercase, underscore, dot, non-ascii, and over-length ids')` → each of `''`, `'Acme'`, `'my_hive'`, `'a.b'`, `'äcme'`, and a 60-char id throws `InvalidHiveClusterNameError`.
- [ ] **Step 2:** Run `npx tsx --test "admin/control-plane/tests/kind-cluster-name.test.ts"` → FAIL.
- [ ] **Step 3:** Implement. Hoist `Prefix='pragmatic-hive-'`, `ContextPrefix='kind-'`, `Pattern=/^[a-z0-9-]+$/`, `MaxLength=49`. Validate the FULL composed name (and non-empty hiveId) before returning.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(hive): KindClusterName derivation + fail-closed validation`.

### Task 2: IKind + KindCli + KindError

**Files:**
- Create: `admin/control-plane/kind.ts`
- Test: `admin/control-plane/tests/kind.test.ts`

**Interfaces:**
- Consumes: `IExecFile`, `NodeExecFile`, `KubectlError.Redact` from `./kubectl.js`.
- Produces: `export interface IKind { CreateCluster(name: string): Promise<void>; DeleteCluster(name: string): Promise<void>; ListClusters(): Promise<readonly string[]>; LoadImage(image: string, clusterName: string): Promise<void> }`; `export class KindError extends Error` (ctor `(rawStderr: string)`, message = prefix + `KubectlError.Redact(rawStderr).trim()`); `export class KindCli implements IKind` ctor `(exec: IExecFile)`.

- [ ] **Step 1: Write failing tests** with a fake `IExecFile` (records the last `file`+`args`, returns a configurable `{stdout,stderr}` or rejects with an error carrying `.stderr`):
  - `test('CreateCluster runs: kind create cluster --name <n>')` — assert exact argv.
  - `test('DeleteCluster runs: kind delete cluster --name <n>')`.
  - `test('LoadImage runs: kind load docker-image <image> --name <n>')`.
  - `test('ListClusters parses newline-separated names')` → stdout `"a\nb\n"` → `['a','b']`.
  - `test('ListClusters returns [] for empty output and the no-clusters sentinel')` → stdout `''` → `[]`; stdout `'No kind clusters found.\n'` → `[]`.
  - `test('a failed kind call throws KindError with redacted stderr')` — fake rejects with `{stderr:'token=abcdef...'}`; assert `KindError` and the secret is `[REDACTED]`.
- [ ] **Step 2:** Run `npx tsx --test "admin/control-plane/tests/kind.test.ts"` → FAIL.
- [ ] **Step 3:** Implement. Hoist `Kind='kind'`, verbs/flags (`create`/`delete`/`cluster`/`--name`/`get`/`clusters`/`load`/`docker-image`), `Sentinel='No kind clusters found.'`, newline split. Each method try/`exec.Run`/catch→`throw new KindError(e.stderr ?? e.message)`. `ListClusters` splits stdout on `\n`, trims, filters empties and the sentinel.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(hive): IKind seam + KindCli over IExecFile (create/delete/list/load)`.

### Task 3: KindHiveOrchestrator

**Files:**
- Create: `admin/control-plane/kind-hive-orchestrator.ts`
- Test: `admin/control-plane/tests/kind-hive-orchestrator.test.ts`

**Interfaces:**
- Consumes: `IKind` (Task 2), `IHiveOrchestrator`/`WorkloadHealth` (`./hive-orchestrator.js`), `EnvironmentWorkload` (`./environment-workload.js`).
- Produces: `export class KindHiveOrchestrator implements IHiveOrchestrator` ctor `(kind: IKind, clusterName: string, inner: IHiveOrchestrator)`; `public get ClusterName(): string` (for factory testability); plus `public async DestroyCluster(): Promise<void>` (NOT on the interface). Behavior per spec §3: `Apply` ensures-then-delegates; `Health` guards (not-ready, no inner call, when `ListClusters` lacks the cluster) else delegates; `WaitHealthy`/`Roll`/`Teardown` delegate; `DestroyCluster` → `kind.DeleteCluster(clusterName)`; private `EnsureCluster` creates only when `ListClusters` lacks it.

- [ ] **Step 1: Write failing tests** with a `FakeKind` (configurable `ListClusters` result; records create/delete/load calls) and a `FakeInner implements IHiveOrchestrator` (records every call):
  - `test('Apply creates the cluster when absent then delegates Apply')`.
  - `test('Apply does not recreate when the cluster already exists')` (ListClusters returns the name → no CreateCluster, inner.Apply still called).
  - `test('Health returns not-ready without calling inner when the cluster is absent')` (ready=false, runningImage undefined, inner.Health not called).
  - `test('Health delegates to inner when the cluster exists')`.
  - `test('Teardown delegates to inner and never deletes the cluster')` (FakeKind.DeleteCluster NOT called).
  - `test('DestroyCluster deletes the cluster')`.
  - `test('Roll and WaitHealthy delegate to inner')`.
  - `test('ClusterName exposes the constructed name')`.
- [ ] **Step 2:** Run `npx tsx --test "admin/control-plane/tests/kind-hive-orchestrator.test.ts"` → FAIL.
- [ ] **Step 3:** Implement. Hoist the `detail` string for the not-provisioned health (`'cluster not provisioned'`). Keep `EnsureCluster` private; `DestroyCluster` public.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(hive): KindHiveOrchestrator (provision lifecycle, namespace-scoped teardown, cluster destroy)`.

### Task 4: Wire the Local+Provision arm into the factory

**Files:**
- Modify: `admin/control-plane/hive-orchestrator-factory.ts`
- Test: `admin/control-plane/tests/hive-orchestrator-factory.test.ts` (extend)

**Interfaces:**
- Consumes: `KindClusterName` (T1), `KindCli` (T2), `KindHiveOrchestrator` (T3), `NodeExecFile`/`KubectlCli` (`./kubectl.js`), and the existing `verifier`/`EffectiveRegistry.For`/`K8sManifestBuilder` construction already in the attach arm.
- Produces: `For(hive)` returns a `KindHiveOrchestrator` when `hive.cluster.backend === HiveBackend.Local && hive.cluster.mode === InfraMode.Provision`; all other combos unchanged (attach arm as-is; everything else `UnsupportedBackendError`).

- [ ] **Step 1: Write failing tests** (extend the existing factory test):
  - `test('Local + Provision resolves to a KindHiveOrchestrator')` — `For(hive)` `instanceof KindHiveOrchestrator`.
  - `test('two hives with different ids get different cluster names')` — assert the two orchestrators' `ClusterName` differ and each equals `KindClusterName.For(id)`.
  - Confirm the existing `Local+Attach → KubectlHiveOrchestrator` test and the `UnsupportedBackendError` tests still pass unchanged.
- [ ] **Step 2:** Run `npx tsx --test "admin/control-plane/tests/hive-orchestrator-factory.test.ts"` → FAIL (new assertions).
- [ ] **Step 3:** Implement the arm: derive `clusterName`/`context` via `KindClusterName`, build the same verifier/registry/manifests as the attach arm, build `inner = new KubectlHiveOrchestrator(new KubectlCli(context), manifests, EffectiveRegistry.For(hive), verifier, hive.trustRootRef)`, return `new KindHiveOrchestrator(new KindCli(new NodeExecFile()), clusterName, inner)`. Factor the shared verifier/manifests construction if it reduces duplication, without changing attach behavior.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(hive): factory resolves Local+Provision to the kind driver`.

### Task 5: Gated real-kind smoke (written, not run)

**Files:**
- Create: `admin/control-plane/kind-hive-smoke.ts`

**Interfaces:**
- Consumes: `KindCli`/`NodeExecFile`, `KindClusterName`, `KindHiveOrchestrator`, `KubectlHiveOrchestrator`/`KubectlCli`, `K8sManifestBuilder`, `EffectiveRegistry`, a `CryptoImageVerifier` (or the smoke's existing verifier helper), and the `EnvironmentWorkload` shape — modelled on `admin/control-plane/k8s-hive-smoke.ts`.

- [ ] **Step 1:** Write `kind-hive-smoke.ts` mirroring `k8s-hive-smoke.ts`'s PASS/FAIL-gate + exit-code structure. Header comment: requires the real `kind` CLI + a Docker daemon; NOT part of `npm test`; run via `npx tsx admin/control-plane/kind-hive-smoke.ts`. Flow: build two `HiveRecord`s with distinct ids, `backend=Local`, `mode=Provision`, and an **attach-style registry** (`registry.mode = Attach`, endpoint undefined → image ref unchanged); resolve each via `HiveOrchestratorFactory.For`; for each hive call `KindCli.LoadImage(<the dev image>, clusterName)` after Apply stands the cluster up (or load before scheduling, matching how kind requires the image on-node); `Apply` a workload, `WaitHealthy`, assert `Health.ready` and image isolation between the two clusters; finally `DestroyCluster()` both and assert `ListClusters` no longer contains either. Gate each assertion; exit non-zero on any failure.
- [ ] **Step 2: Do NOT run the smoke** (no `kind`/Docker in this run). Instead verify it compiles: `npm run typecheck:tools` is clean (it covers `admin/control-plane/**`). Also `npm run build`.
- [ ] **Step 3:** Commit `test(hive): gated real-kind two-cluster provision smoke (not run in CI)`.

---

## Final verification (before whole-branch review)

- `npx tsx --test "admin/control-plane/tests/*.test.ts"` green.
- `npm run build` and `npm run typecheck:tools` clean.
- The gated smoke type-checks but is NOT run.
- Whole-branch review on the most capable model, with Review Focus items (teardown granularity, health guard, name rejection, list parsing, idempotent ensure) specifically re-checked.
