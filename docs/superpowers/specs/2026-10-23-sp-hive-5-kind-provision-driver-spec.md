# SP-HIVE-5 — kind Provision Driver + Multi-Hive (design)

**Status:** design, approved for autonomous execution (AFK run 2026-10-23). Rulings made in the user's absence are flagged in §9.

**Parent design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md` (the binding decisions). SP-HIVE-5 is named there (line 112) as "the kind driver: provision mode + multi-hive — closes the two Docker-Desktop gaps."

## 1. Intent & the why

The platform orchestrates a tenant's environments onto a **Hive** (a Kubernetes cluster). SP-HIVE-2 shipped the `Local + Attach` driver (`KubectlHiveOrchestrator` over `IKubectl`): it schedules workloads onto a **pre-existing** cluster (Docker Desktop's k8s) and tears down only the environment namespace. Docker Desktop cannot do the two things SP-HIVE-5 closes (parent design line 59, 81):

1. **Provision mode** — stand a cluster up from nothing and own its lifecycle (hive teardown destroys the cluster), per parent-design decision (line 29).
2. **Multi-hive / multicloud** — several clusters coexisting (a tenant may own many hives).

SP-HIVE-5 adds a **`kind`-backed provision driver** that plugs into the already-built extension point `HiveOrchestratorFactory.For(hive)` (keyed on `cluster.backend × cluster.mode`; today only `Local+Attach` is wired, everything else throws `UnsupportedBackendError`). It follows the SP-HIVE-2 precedent exactly: an external CLI behind a fakeable `IExecFile`-style seam, unit-tested with fakes, with real-cluster validation in a **gated smoke** (not run in CI or unattended).

## 2. Scope

**Goals**
- An `IKind` seam + `KindCli` (real `kind` CLI over `IExecFile`/`NodeExecFile`, arg arrays, never a shell, stderr redacted) — create/delete/list clusters.
- A `KindHiveOrchestrator implements IHiveOrchestrator` for `Local + Provision`: ensures the hive's `kind` cluster exists (idempotent), delegates workload Apply/WaitHealthy/Health/Roll to an inner `KubectlHiveOrchestrator` pointed at the provisioned cluster's context, and on Teardown **destroys the whole cluster** (not just the namespace).
- Wire the `Local + Provision` arm into `HiveOrchestratorFactory.For`.
- **Multi-hive:** each hive maps to its own deterministically-named `kind` cluster + kubeconfig context, so multiple hives are multiple coexisting clusters.
- A gated `kind-hive-smoke.ts` (written, NOT run unattended) proving two hives stand up as two isolated real clusters, each schedules a workload, and teardown destroys them — mirroring `k8s-hive-smoke.ts`.

**Non-goals / deferred (§9 files these as GitHub Features on the user's go)**
- Cloud-backend provision (`AKS/EKS/GKE` + IaC + cloud creds) — a separate later driver; this is the *local* way to exercise provision mode + multicloud shape.
- `k3d` as the tool (ruling R1: `kind`; `k3d` is swappable behind `IKind` later).
- Routing `EnvironmentService.Create` through the hive orchestrator (that cross-path integration remains deferred as in SP-HIVE-2).
- Running the real-`kind` smoke in CI / unattended (it needs the `kind` CLI + a Docker daemon).
- Wiring a provisioned in-cluster OCI registry into the kind cluster's containerd (registry provision path from SP-HIVE-3 is reused at the `EffectiveRegistry` level; making a kind node pull from it is smoke/real-infra concern, documented, not in the orchestrator unit scope).

**Anti-goals**
- No shell string interpolation — every `kind`/`kubectl` call is an argument array via `IExecFile`.
- No secret/credential/kubeconfig contents in any log or error (reuse the `KubectlError` redaction discipline for `KindError`).
- No change to the `IHiveOrchestrator` interface or the attach driver's behavior.

## 3. Architecture (files)

- **`admin/control-plane/kind.ts`** (new): `interface IKind { CreateCluster(name): Promise<void>; DeleteCluster(name): Promise<void>; ListClusters(): Promise<readonly string[]> }`; `KindCli implements IKind` over an injected `IExecFile` (reuse `NodeExecFile` from `kubectl.ts`); `KindError` (redacts stderr like `KubectlError`). All `kind` subcommands/flags hoisted to constants.
- **`admin/control-plane/kind-cluster-name.ts`** (new): `KindClusterName.For(hiveId): string` → `pragmatic-hive-<hiveId>`; validates the result against `kind`'s allowed charset (`^[a-z0-9-]+$`, length-capped); throws `InvalidHiveClusterNameError` for a hiveId that cannot form a valid cluster name (fail-closed, names the offending id). The context a `kind` cluster exposes is `kind-<name>`; expose `ContextFor(name): string`.
- **`admin/control-plane/kind-hive-orchestrator.ts`** (new): `KindHiveOrchestrator implements IHiveOrchestrator`, constructed with `(kind: IKind, clusterName: string, inner: IHiveOrchestrator)`:
  - `Apply(w)`: `await this.EnsureCluster()` then `await this.inner.Apply(w)`.
  - `WaitHealthy/Health/Roll`: delegate to `inner` (the cluster is ensured by a prior Apply in the normal lifecycle; Health on an absent cluster surfaces the inner kubectl error).
  - `Teardown(w)`: `await this.kind.DeleteCluster(this.clusterName)` — provision lifecycle destroys the cluster (contrast attach's namespace-only teardown).
  - private `EnsureCluster()`: if `!(await this.kind.ListClusters()).includes(this.clusterName)` → `await this.kind.CreateCluster(this.clusterName)` (idempotent).
- **`admin/control-plane/hive-orchestrator-factory.ts`** (modify): add the `backend===Local && mode===Provision` arm → derive `clusterName = KindClusterName.For(hive.id)` and `context = KindClusterName.ContextFor(clusterName)`, build the same `verifier`/`EffectiveRegistry`/`K8sManifestBuilder` as the attach arm, build `inner = new KubectlHiveOrchestrator(new KubectlCli(context), …)`, return `new KindHiveOrchestrator(new KindCli(new NodeExecFile()), clusterName, inner)`. All other combos still throw `UnsupportedBackendError`.
- **`admin/control-plane/kind-hive-smoke.ts`** (new, gated): real `kind` end-to-end, structured like `k8s-hive-smoke.ts`; header documents it needs the `kind` CLI + Docker and is NOT part of `npm test`.

## 4. Decisions

1. **Tool = `kind`** (ruling R1). Canonical Kubernetes-in-Docker; matches the Docker-centric dev substrate; behind `IKind`, so `k3d` is a later swap.
2. **Provision lifecycle** (parent decision): Apply stands the cluster up (idempotent create), Teardown destroys it. This is the whole distinction from attach.
3. **Delegation, not duplication:** `KindHiveOrchestrator` owns only cluster *lifecycle*; all workload scheduling/health/roll reuses the proven `KubectlHiveOrchestrator` against the provisioned context. No k8s logic is re-implemented.
4. **Per-hive cluster = multi-hive:** cluster name derived deterministically from `hive.id` (`pragmatic-hive-<id>`); distinct hives ⇒ distinct clusters ⇒ coexistence. Context is `kind-<name>` (kind's convention).
5. **Fail-closed naming:** a hiveId that cannot form a `kind`-valid cluster name throws a clear typed error at factory time, never a malformed `kind create`.
6. **Idempotent ensure:** re-Apply on an existing hive does not recreate the cluster (checked via `kind get clusters`).

## 5. The pinned contract

- `IKind` methods map to: `kind create cluster --name <n>`, `kind delete cluster --name <n>`, `kind get clusters` (newline-separated names). Arg arrays only.
- Cluster name: `pragmatic-hive-<hiveId>`, must match `^[a-z0-9-]+$`, ≤ a safe length (kind/Docker limits); context `kind-<name>`.
- `KindError` redacts the same secret-looking patterns as `KubectlError`.

## 6. Security

- No shell interpolation; `IExecFile` arg arrays; 300 s per-call timeout (reuse `NodeExecFile`).
- `KindError` stderr redaction (passwords/tokens/long base64).
- No kubeconfig/credential/token content in logs or errors.
- Image signature verification is unchanged — it stays in the inner `KubectlHiveOrchestrator` (verify before apply), so provisioned clusters get the same pre-apply verification as attached ones.

## 7. Proof

- **Unit tests** (fakes only, no real `kind`/Docker):
  - `KindHiveOrchestrator` with a fake `IKind` + a fake inner `IHiveOrchestrator`: Apply creates the cluster when absent then delegates Apply; Apply does NOT recreate when `ListClusters` already includes it; Teardown calls `DeleteCluster` (and nothing on the inner); Roll/Health/WaitHealthy delegate to inner.
  - `KindCli` with a fake `IExecFile`: asserts exact `kind` arg arrays for create/delete/list; `ListClusters` parses newline output; `KindError` redacts secrets in stderr.
  - `KindClusterName`: `For` derivation; `ContextFor`; invalid hiveId → `InvalidHiveClusterNameError`.
  - `HiveOrchestratorFactory`: `Local+Provision` → `KindHiveOrchestrator`; the existing `Local+Attach` → `KubectlHiveOrchestrator` unchanged; every other `backend×mode` still `UnsupportedBackendError`; two different hiveIds yield two different cluster names (multi-hive).
- **Gated smoke** `kind-hive-smoke.ts` (written, NOT run in this AFK run — requires the real `kind` CLI + Docker): provisions two hives as two real `kind` clusters, schedules a workload on each, asserts both independently healthy and isolated, then tears both down and asserts the clusters are gone. Run manually via `npx tsx admin/control-plane/kind-hive-smoke.ts` on a machine with `kind` + Docker.

## 8. Test / build commands

- Control-plane unit tests: `npx tsx --test "admin/control-plane/tests/*.test.ts"` (the new tests land here).
- Build: `npm run build`; tools typecheck: `npm run typecheck:tools`. Do NOT `npm install`.
- The gated smoke is excluded from every test glob (it is not a `*.test.ts`).

## 9. Rulings made in the user's absence (review on return)

- **R1 — tool is `kind`, not `k3d`.** The parent design wrote "kind/k3d". `kind` is the canonical Kubernetes-in-Docker and matches the existing Docker-Desktop-centric dev substrate. It sits behind the `IKind` seam, so swapping to `k3d` later is a contained adapter change, not an architecture change. Cost if wrong: rewrite `KindCli` + the smoke's CLI invocations + a line of operator docs — the orchestrator, factory wiring, naming, and all unit tests (fake `IKind`) are tool-agnostic and unaffected.
- **R2 — the real-`kind` smoke is written but NOT run in this AFK run.** Proving a real cluster stands up is the sub-project's headline value but needs `kind` + a Docker daemon, which is unsafe to drive unattended. The driver code is fully unit-tested with fakes (SP-HIVE-2 precedent); the smoke awaits a manual run on real infra. Cost if wrong: a latent bug the fakes didn't catch surfaces only at the first real run.
- **R3 — cluster naming scheme `pragmatic-hive-<hiveId>` + context `kind-<name>`.** Deterministic, collision-free per hiveId, matches `kind`'s context convention. Cost if wrong: a naming migration (no persisted data depends on it beyond live clusters).

## 10. Relationship to the program

SP-HIVE-5 is independent of the identity line (6a/6b/6c) and of SP-HIVE-7. It completes milestone-1's two deferred Docker-Desktop gaps. Cloud-backend provision (AKS/EKS/GKE) remains a separate future driver on the same factory seam.
