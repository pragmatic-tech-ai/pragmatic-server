# In-Hive Per-Hive Rollout Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the in-cluster rollout agent from the removed per-environment operator routes to the new `AgentChannelHost`, and from one-agent-per-environment to **one agent per hive**: it discovers the hive's environment server-deployments, rolls each toward the hive's single target image, and reports ONE whole-hive `HiveHealthDto[]` snapshot up the channel — turning the gated rollout smokes green.

**Architecture:** The hive's rollout target is a single server-image version; every environment in the hive runs that server image. One agent per hive (per the approved split design) lists the hive's server deployments by a hive label, patches each that is off-target, collects each one's health, and POSTs a single whole-hive snapshot to `POST /agent/hives/:id/snapshot` (the overwrite-the-hive semantics are correct because ONE agent owns the whole list — the old per-env agents would have clobbered each other). Target comes from `GET /agent/hives/:id/target`. The agent authenticates with the per-hive bearer.

**Tech Stack:** TypeScript, the existing `src/agent/` seam design (`RolloutAgent` + `IRolloutAgentDeps`, `InClusterK8sApi`), `AgentChannelHost` (merged), `K8sManifestBuilder`. Agent unit tests: `src/agent/tests/` run with `npx tsx --test "src/agent/tests/*.test.ts"`. Manifest/host tests: `admin/control-plane/tests/`. Typecheck `npx tsc -p tsconfig.tools.json --noEmit`. The gated rollout smokes (`rollout-pull-smoke.ts`, `rollout-push-smoke.ts`) run via `npx tsx <path>` against Docker Desktop Kubernetes and need a rebuilt `pragmatic-server:dev` image containing the new `dist/bin/pragmatic-agentd.js`.

**Spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` (the in-hive agent it names). Closes follow-up Feature `PVTI_lADOE0Zc984Biu4ozhDYxL8`.

## Global Constraints

- OOP only (behavior on classes; no module-level free functions or mutable module state; module-level `const`/`type`/`enum`/`interface` fine).
- Allman braces everywhere; `else`/`catch`/`finally` on their own line. Object literals / block-arrow bodies / genuine one-liners stay inline.
- No inline string literals: hoist reused/meaningful literals (env-var names, label keys, URL path templates, k8s field names, messages) to `private static readonly` PascalCase constants.
- PascalCase for every interface name and public method.
- **Secrets by name only:** the agent token and any inner-error text never appear in logs, response/request bodies beyond the `Authorization` header, thrown messages, or persisted records. The agent must never log its token (the smoke diagnostics already assume this).
- Tests live in `tests/` subfolders. Never `npm install` at the repo root. `git add` explicit paths only (untracked `dev/` stays untracked).

## Review Focus

- **Multiple environments in one hive:** one agent reports a snapshot listing ALL discovered envs; verify a second env appears in the snapshot and neither clobbers the other (the whole-hive replace is correct precisely because one agent sends the full list). (Task 2.)
- **An environment with no ready replicas** must report `ready: false` with a non-crashing `detail`, not be omitted. (Task 1.)
- **RBAC least privilege:** the per-hive agent may `list`/`get`/`patch` only deployments, and only within the hive's environment namespaces (or cluster-wide deployments filtered by the hive label) — not secrets, not other resources. (Task 4.)
- **A hive with no environments yet** (target set, nothing deployed) must post an empty snapshot and not error. (Task 2/3.)
- **The agent never leaks its token** into logs on any failure path. (Task 3.)

---

### Task 1: k8s list + readiness in InClusterK8sApi

**Files:**
- Modify: `src/agent/k8s-api.ts`
- Test: `src/agent/tests/k8s-api.test.ts` (create; fake the HTTP `Send` seam)

**Interfaces:**
- Produces: `public async ListServerDeployments(hiveLabelSelector: string): Promise<ReadonlyArray<{ namespace: string; deployment: string; container: string; runningImage: string | undefined; ready: boolean }>>` — GETs `/apis/apps/v1/deployments?labelSelector=<selector>` cluster-wide, mapping each item to its namespace, name, first/`server` container image, and readiness (`status.readyReplicas === status.replicas && status.replicas > 0`). Keep `ReadDeploymentImage`/`PatchDeploymentImage` (still used for the per-env patch).
- The HTTP send must be a seam the test can fake (extract/confirm a protected `Send` the test overrides, following the existing pattern).

- [ ] **Step 1: Write the failing test** — a fake Send returns a two-item deployment list (one ready, one with `readyReplicas` 0); `ListServerDeployments` returns both with correct namespace/deployment/runningImage/ready; the not-ready one is present with `ready:false`.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** `ListServerDeployments` + readiness parse; hoist path/field literals to constants.
- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat: k8s list server deployments with readiness`).

### Task 2: RolloutAgent goes per-hive (snapshot)

**Files:**
- Modify: `src/agent/rollout-agent.ts`
- Test: `src/agent/tests/rollout-agent.test.ts` (rewrite for the per-hive shape)

**Interfaces:**
- Consumes: the Task 1 listing shape; `HiveHealthDto` shape `{ environmentName, ready, runningImage, detail }` (mirror it as the reported element; do not import control-plane code into the agent — define a local matching type).
- Produces: new `IRolloutAgentDeps` — `fetchTarget(): Promise<IRolloutTarget | undefined>`; `listEnvironments(): Promise<ReadonlyArray<{ environmentName: string; namespace: string; deployment: string; container: string; runningImage: string | undefined; ready: boolean }>>`; `patchImage(namespace, deployment, container, image): Promise<void>`; `reportSnapshot(environments: ReadonlyArray<{ environmentName: string; ready: boolean; runningImage: string | undefined; detail: string }>): Promise<void>`. `Tick()`: fetch target (return early if none); list envs; for each env whose `runningImage !== target.image` patch it; build one snapshot element per env; `reportSnapshot` once. `detail` is a short fixed readiness string (e.g. a ready/not-ready label constant).

- [ ] **Step 1: Write the failing test** — target set; two envs listed (one on-target, one off-target); `Tick` patches only the off-target one and calls `reportSnapshot` once with BOTH envs; a no-env hive posts an empty snapshot and patches nothing; no target ⇒ no list/patch/report.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** the per-hive `Tick`.
- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat: per-hive rollout agent reports whole-hive snapshot`).

### Task 3: agent-main wires the per-hive agent to the channel

**Files:**
- Modify: `src/agent/agent-main.ts`
- Test: `src/agent/tests/agent-main.test.ts` (create — test the pure URL/selector/env parsing helpers that can be exercised without the cluster)

**Interfaces:**
- Consumes: Task 1 `InClusterK8sApi.ListServerDeployments`, Task 2 `RolloutAgent`/deps.
- Produces: drops `PRAGMATIC_AGENT_ENV_NAME`; keeps `PRAGMATIC_AGENT_REGISTRY_URL` (now the agent-channel base URL), `PRAGMATIC_AGENT_HIVE_ID`, `PRAGMATIC_AGENT_TOKEN`, poll/backoff. New path templates `/agent/hives/{hive}/target` and `/agent/hives/{hive}/snapshot`. Builds the hive label selector from a `HiveLabel` key constant + hive id. `listEnvironments` maps the k8s list (namespace → environmentName by stripping the `pragmatic-env-` prefix). The snapshot POST body is `{ environments: [...] }` (matching `AgentChannelHost`). Every failure path logs event + hiveId only, never the token.

- [ ] **Step 1: Write the failing test** — the label-selector builder, the namespace→environmentName mapping, and the target/snapshot URL builders produce the exact expected strings; `Required` still throws the fixed message for a missing env var.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement**; hoist all literals.
- [ ] **Step 4: Run it, verify it passes;** `npx tsc -p tsconfig.tools.json --noEmit`.
- [ ] **Step 5: Commit** (`feat: agent-main targets agent channel per hive`).

### Task 4: RenderHiveAgent manifest (one agent per hive, hive-scoped RBAC)

**Files:**
- Modify: `admin/control-plane/k8s-manifest-builder.ts`
- Confirm/fix: the environment server Deployment carries the hive label (so the agent can discover it); if the env Deployment meta lacks `HiveLabel`, add it (small ripple — update the env-deployment tests).
- Test: `admin/control-plane/tests/k8s-manifest-builder.test.ts` (extend)

**Interfaces:**
- Produces: `public RenderHiveAgent(hiveId: string, registryUrl: string, tokenSecretName: string): string` — ONE agent Deployment per hive (hive-scoped names), a ServiceAccount, and a **ClusterRole + ClusterRoleBinding** granting only `list`/`get`/`patch` on `apps/deployments` (so the agent can discover + patch across the hive's env namespaces). The agent Deployment's env carries `PRAGMATIC_AGENT_HIVE_ID`, `PRAGMATIC_AGENT_REGISTRY_URL`, `PRAGMATIC_AGENT_TOKEN` (from the secret), no `ENV_NAME`. Remove the per-env `RenderAgent` once no caller remains (the smokes switch in Task 5), or keep it only if still referenced.

- [ ] **Step 1: Write the failing test** — rendered list contains the SA, a ClusterRole whose rule verbs are exactly `get`/`list`/`patch` on `deployments` in `apps` (no secrets, no other resources), a ClusterRoleBinding to the SA, and a Deployment whose env has `HIVE_ID` + no `ENV_NAME`, all hive-labeled.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** `RenderHiveAgent`; ensure the env server Deployment carries the hive label.
- [ ] **Step 4: Run it, verify it passes;** full control-plane suite + typecheck.
- [ ] **Step 5: Commit** (`feat: render one per-hive rollout agent with hive-scoped RBAC`).

### Task 5: Green the gated rollout smokes against the agent channel

**Files:**
- Modify: `admin/control-plane/rollout-pull-smoke.ts`, `admin/control-plane/rollout-push-smoke.ts`
- (No new unit test — this task's acceptance is the gated Docker smoke.)

**Interfaces:**
- Consumes: Task 4 `RenderHiveAgent`; the `AgentChannelHost` port/bind; `ReportSnapshot`/`StatusFor`/`LatestFor`.
- Produces: the smokes start an `AgentChannelHost` (on a chosen port/bind reachable from the pod via `host.docker.internal`), register the hive, apply ONE per-hive agent (`RenderHiveAgent`) instead of the per-env `RenderAgent`, and assert: the env server deployment is patched to v2 by the agent; and the agent's whole-hive snapshot is observed on the platform side (`StatusFor` shows the env non-obsolete / `LatestFor` lists it). Remove the `EXPECTED-RED` comments.

- [ ] **Step 1: Rewire** `ApplyAgent`→`ApplyHiveAgent`, point the agent at the `AgentChannelHost` URL, assert patch + snapshot-observed.
- [ ] **Step 2: Rebuild the dev image** so it contains the new agent: build `pragmatic-server:dev` per the invocation in `docker/Dockerfile`'s header (materialize the temp `.npmrc` from `$PACKAGES_TOKEN`, delete after).
- [ ] **Step 3: Run** `npx tsx admin/control-plane/rollout-pull-smoke.ts` and `...rollout-push-smoke.ts` against Docker Desktop Kubernetes; expect PASS, zero leaks.
- [ ] **Step 4: Commit** (`feat: green rollout smokes on the agent channel`).

> **Verification note:** Tasks 1-4 are fully unit-testable and model-verifiable with no cluster. Task 5's run requires Docker Desktop Kubernetes up and the rebuilt `:dev` image; if Docker is unavailable at execution time, land Tasks 1-4 (typecheck + unit suites green) and run Task 5's smokes when the cluster is available, keeping the branch unmerged until the smokes pass.
