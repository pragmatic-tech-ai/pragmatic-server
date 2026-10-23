# SP-HIVE-5 — kind Provision Driver + Multi-Hive (design)

**Status:** design, approved for autonomous execution (AFK run 2026-10-23). Amended after a builder-check (resolutions folded into §3/§4/§7/§9). Rulings made in the user's absence are flagged in §9.

**Parent design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md` (the binding decisions). SP-HIVE-5 is named there (line 112): "the kind driver: provision mode + multi-hive — closes the two Docker-Desktop gaps."

## 1. Intent & the why

The platform orchestrates a tenant's environments onto a **Hive** (a Kubernetes cluster; a hive hosts **many** environments, each as a namespace). SP-HIVE-2 shipped the `Local + Attach` driver (`KubectlHiveOrchestrator` over `IKubectl`): it schedules workloads onto a **pre-existing** cluster and tears down only the environment namespace. Docker Desktop cannot do the two things SP-HIVE-5 closes (parent design lines 59, 81):

1. **Provision mode** — stand a cluster up from nothing and own its lifecycle (hive teardown destroys the cluster), per parent-design decision line 29.
2. **Multi-hive / multicloud** — several clusters coexisting (a tenant may own many hives).

SP-HIVE-5 adds a **`kind`-backed provision driver** that plugs into the already-built extension point `HiveOrchestratorFactory.For(hive)` (keyed on `cluster.backend × cluster.mode`; today only `Local+Attach` is wired, everything else throws `UnsupportedBackendError`). It follows the SP-HIVE-2 precedent: an external CLI behind a fakeable `IExecFile` seam, unit-tested with fakes, with real-cluster validation in a **gated smoke** (not run in CI or unattended).

## 2. Scope

**Goals**
- An `IKind` seam + `KindCli` (real `kind` CLI over `IExecFile`/`NodeExecFile`, arg arrays, never a shell, stderr redacted): create / delete / list clusters, plus **load-image** (kind nodes do not share the host Docker image store).
- A `KindHiveOrchestrator implements IHiveOrchestrator` for `Local + Provision` that:
  - **Apply:** ensures the hive's `kind` cluster exists (idempotent), then delegates workload apply to an inner `KubectlHiveOrchestrator` against the provisioned cluster's context.
  - **WaitHealthy / Roll:** delegate to the inner orchestrator.
  - **Health:** guards — returns *not ready* when the cluster does not exist yet (does not throw), else delegates.
  - **Teardown(w):** **namespace-scoped** — delegates to the inner orchestrator (removes only that environment's namespace), exactly like attach, so tearing down one environment never destroys a hive shared by other environments.
  - **DestroyCluster():** a separate, hive-scoped method (NOT on `IHiveOrchestrator`) that `kind delete cluster`s — the provision-lifecycle "hive teardown destroys the cluster." Wiring it into hive teardown (`PlatformDirectory.DeleteHive`) is **deferred** (like the `EnvironmentService.Create → Apply` integration SP-HIVE-2 deferred).
- Wire the `Local + Provision` arm into `HiveOrchestratorFactory.For`.
- **Multi-hive:** each hive maps to its own deterministically-named `kind` cluster + kubeconfig context, so multiple hives are multiple coexisting clusters.
- A gated `kind-hive-smoke.ts` (written, NOT run unattended) proving two hives stand up as two isolated real clusters, each loads + schedules a workload, each is independently healthy, then `DestroyCluster` removes them — mirroring `k8s-hive-smoke.ts`.

**Non-goals / deferred (§9 files these as GitHub Features on the user's go)**
- Cloud-backend provision (`AKS/EKS/GKE` + IaC + cloud creds) — a separate later driver on the same seam.
- `k3d` as the tool (ruling R1: `kind`; `k3d` is swappable behind `IKind`).
- Wiring `EnvironmentService.Create → orchestrator.Apply` and `DeleteHive → DestroyCluster` (cross-path integration remains deferred as in SP-HIVE-2).
- Running the real-`kind` smoke in CI / unattended (needs the `kind` CLI + a Docker daemon).
- Production image distribution into provisioned clusters (a provisioned in-cluster registry / containerd wiring). The orchestrator's `Apply` does NOT auto-load images; `kind load` is exercised by the smoke. The registry-provision path (SP-HIVE-3) is unchanged at the `EffectiveRegistry` level.

**Anti-goals**
- No shell string interpolation — every `kind`/`kubectl` call is an argument array via `IExecFile`.
- No kubeconfig/credential/token content in any log or error (reuse `KubectlError`-style redaction for `KindError`).
- No change to the `IHiveOrchestrator` interface and no change to the attach driver's behavior.

## 3. Architecture (files)

- **`admin/control-plane/kind.ts`** (new): `interface IKind { CreateCluster(name): Promise<void>; DeleteCluster(name): Promise<void>; ListClusters(): Promise<readonly string[]>; LoadImage(image: string, clusterName: string): Promise<void> }`; `KindCli implements IKind` over an injected `IExecFile` (reuse `NodeExecFile` from `kubectl.ts`); `KindError` (redacts stderr like `KubectlError`). All `kind` subcommands/flags hoisted to constants. `ListClusters` parses newline-separated stdout, trimming blanks and filtering the "No kind clusters found." sentinel.
- **`admin/control-plane/kind-cluster-name.ts`** (new): `KindClusterName.For(hiveId): string` → `pragmatic-hive-<hiveId>`; validates the FULL result against `^[a-z0-9-]+$` and a length cap (≤ 49 chars — kind uses the name as the `<name>-control-plane` Docker/container prefix, bounded by the 63-char k8s label limit minus the suffix); throws `InvalidHiveClusterNameError` (new, names the offending id) for any hiveId that produces uppercase, `_`, `.`, non-`[a-z0-9-]`, or over-length. `ContextFor(name): string` → `kind-<name>` (kind's context convention).
- **`admin/control-plane/kind-hive-orchestrator.ts`** (new): `KindHiveOrchestrator implements IHiveOrchestrator`, constructed with `(kind: IKind, clusterName: string, inner: IHiveOrchestrator)`:
  - `Apply(w)`: `await this.EnsureCluster()` then `await this.inner.Apply(w)`.
  - `WaitHealthy(w)` / `Roll(w, image)`: delegate to `inner`.
  - `Health(w)`: if `!(await this.kind.ListClusters()).includes(this.clusterName)` → return `{ ready: false, runningImage: undefined, detail: <"cluster not provisioned"> }`; else `this.inner.Health(w)`.
  - `Teardown(w)`: delegate to `inner` (namespace-scoped).
  - `DestroyCluster()`: `await this.kind.DeleteCluster(this.clusterName)` (hive-scoped; not on the interface).
  - private `EnsureCluster()`: if `!(await this.kind.ListClusters()).includes(this.clusterName)` → `await this.kind.CreateCluster(this.clusterName)` (idempotent via the list pre-check; single-writer control-plane, TOCTOU negligible).
- **`admin/control-plane/hive-orchestrator-factory.ts`** (modify): add the `backend===Local && mode===Provision` arm → `clusterName = KindClusterName.For(hive.id)`, `context = KindClusterName.ContextFor(clusterName)`, build the SAME `verifier`/`EffectiveRegistry.For(hive)`/`K8sManifestBuilder`/`hive.trustRootRef` as the attach arm, `inner = new KubectlHiveOrchestrator(new KubectlCli(context), …)`, return `new KindHiveOrchestrator(new KindCli(new NodeExecFile()), clusterName, inner)`. Construction is eager and safe (`KubectlCli` only stores the context string; it shells out lazily, after `Apply` ensures the cluster). All other combos still throw `UnsupportedBackendError`.
- **`admin/control-plane/kind-hive-smoke.ts`** (new, gated): real `kind` end-to-end, structured like `k8s-hive-smoke.ts`; header documents it needs the `kind` CLI + Docker and is NOT in `npm test`. Uses an **attach-style registry** (`registry.mode = Attach`, endpoint undefined → image ref unchanged) plus `IKind.LoadImage` to put the image on each node — NOT the provision-registry `localhost:5000` default (a kind node can't reach it).

## 4. Decisions

1. **Tool = `kind`** (ruling R1). Canonical Kubernetes-in-Docker; matches the Docker-centric dev substrate; behind `IKind`, so `k3d` is a later swap.
2. **Provision lifecycle, two granularities.** Apply stands the cluster up (idempotent). Environment teardown is **namespace-scoped** (`Teardown(w)` → inner), so it is safe on a multi-environment hive. Cluster destruction is **hive-scoped** (`DestroyCluster()`), matching the parent decision "hive teardown destroys the cluster"; its wiring is deferred. (Builder-check resolution — ruling R4.)
3. **Delegation, not duplication:** `KindHiveOrchestrator` owns only cluster *lifecycle*; all scheduling/health/roll/namespace-teardown reuse the proven `KubectlHiveOrchestrator` against the provisioned context.
4. **Per-hive cluster = multi-hive:** cluster name derived deterministically from `hive.id`; distinct hives ⇒ distinct clusters ⇒ coexistence.
5. **Fail-closed naming:** a hiveId that cannot form a `kind`-valid cluster name throws a clear typed error at factory time, never a malformed `kind create`.
6. **Health never throws on an un-provisioned cluster** — it is the wired polling path (`control-plane-host` health route), so it reports *not ready* rather than erroring when no `Apply` has stood the cluster up yet. (Builder-check resolution.)
7. **Idempotent ensure** via `kind get clusters` pre-check; `kind delete cluster` on an absent cluster is a no-op (exit 0).

## 5. The pinned contract

- `IKind` → `kind create cluster --name <n>`, `kind delete cluster --name <n>`, `kind get clusters`, `kind load docker-image <image> --name <n>`. Arg arrays only.
- Cluster name `pragmatic-hive-<hiveId>`, `^[a-z0-9-]+$`, ≤ 49 chars; context `kind-<name>`.
- `KindError` redacts the same secret-looking patterns as `KubectlError`.

## 6. Security

- No shell interpolation; `IExecFile` arg arrays; 300 s per-call timeout (`NodeExecFile`).
- `KindError` stderr redaction (passwords/tokens/long base64).
- No kubeconfig/credential/token content in logs or errors.
- Image signature verification is unchanged — it stays in the inner `KubectlHiveOrchestrator` (verify before apply), so provisioned clusters get the same pre-apply verification as attached ones.

## 7. Proof

- **Unit tests** (fakes only, no real `kind`/Docker):
  - `KindHiveOrchestrator` with a fake `IKind` + a fake inner `IHiveOrchestrator`: Apply creates the cluster when absent then delegates Apply; Apply does NOT recreate when `ListClusters` already includes it; `Health` returns not-ready (no throw, no inner call) when the cluster is absent and delegates when present; `Teardown` delegates to inner and does NOT delete the cluster; `DestroyCluster` calls `DeleteCluster`; `Roll`/`WaitHealthy` delegate.
  - `KindCli` with a fake `IExecFile`: exact `kind` arg arrays for create/delete/list/load; `ListClusters` parses newline output and filters the empty/"No kind clusters found." sentinel; `KindError` redacts secrets in stderr.
  - `KindClusterName`: `For` derivation; `ContextFor`; invalid hiveId (uppercase, `_`, `.`, over-length, non-ascii) → `InvalidHiveClusterNameError`.
  - `HiveOrchestratorFactory`: `Local+Provision` → `KindHiveOrchestrator`; `Local+Attach` → `KubectlHiveOrchestrator` unchanged; every other `backend×mode` still `UnsupportedBackendError`; two different hiveIds yield two different cluster names (multi-hive).
- **Gated smoke** `kind-hive-smoke.ts` (written, NOT run in this AFK run — requires real `kind` + Docker): provisions two hives as two real clusters, `LoadImage` + schedules a workload on each, asserts both independently healthy and isolated, then `DestroyCluster` both and asserts they are gone. Run manually via `npx tsx admin/control-plane/kind-hive-smoke.ts` on a machine with `kind` + Docker.

## 8. Test / build commands

- Control-plane unit tests: `npx tsx --test "admin/control-plane/tests/*.test.ts"` (new tests land here).
- Build: `npm run build`; tools typecheck: `npm run typecheck:tools`. Do NOT `npm install`.
- The gated smoke is excluded from every test glob (not a `*.test.ts`).

## 9. Rulings made in the user's absence (review on return)

- **R1 — tool is `kind`, not `k3d`.** Parent design wrote "kind/k3d". `kind` is canonical Kubernetes-in-Docker and matches the Docker-Desktop-centric dev substrate; behind `IKind`, so swapping to `k3d` later is a contained adapter change. Cost if wrong: rewrite `KindCli` + the smoke's CLI calls + a line of operator docs — the orchestrator, factory, naming, and all unit tests (fake `IKind`) are tool-agnostic.
- **R2 — the real-`kind` smoke is written but NOT run in this AFK run.** Proving a real cluster stands up needs `kind` + Docker, unsafe unattended. The driver is fully unit-tested with fakes (SP-HIVE-2 precedent). **Residual risks the fakes cannot catch, pending a manual smoke run:** real `kind get clusters` output-channel/sentinel behavior; the exact charset/length `kind` accepts vs the pinned regex; `kind create` latency vs the 300 s timeout and Docker-daemon dependency; image-not-on-node (`kind load`) vs `imagePullPolicy`; real context naming `kind-<name>`.
- **R3 — cluster naming `pragmatic-hive-<hiveId>` + context `kind-<name>`, ≤ 49 chars, `^[a-z0-9-]+$`.** Deterministic, collision-free per hiveId; matches kind's context convention. Cost if wrong: a naming migration of live clusters only.
- **R4 — Teardown granularity split (builder-check).** `Teardown(w)` is namespace-scoped (safe on multi-environment hives); cluster destruction is a separate `DestroyCluster()` whose wiring into hive teardown is deferred — rather than making env teardown destroy a shared cluster. Cost if wrong: if hive teardown is expected to auto-destroy the cluster today, that wiring is one deferred step away (the method exists).

## 10. Relationship to the program

SP-HIVE-5 is independent of the identity line (6a/6b/6c) and of SP-HIVE-7. It completes milestone-1's two deferred Docker-Desktop gaps. Cloud-backend provision (AKS/EKS/GKE) remains a separate future driver on the same factory seam.
