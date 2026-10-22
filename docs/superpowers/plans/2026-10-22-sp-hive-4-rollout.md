# SP-HIVE-4 — Platform-Software Rollout (Push + Pull) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a platform version, gate it for a tenant, select it for a hive, and have that hive's environments move to it — by **push** (control plane drives `Roll`, signature-verified) when reachable, and by **pull** (an in-cluster agent self-updates and reports back) when not.

**Architecture:** A PlatformDeploymentRegistry on the control-plane host (atomic-JSON record stores for manifests, gating, per-hive selection, rollout registration, and reports) + a push actuator reusing the SP-HIVE-3 `Roll` gate + operator API routes + a publish CLI; and a pull agent — a new `pragmatic-agentd` daemon in the existing `pragmatic-server:dev` image that polls the Registry (machine-credential auth) and patches its env's Deployment via the in-cluster Kubernetes REST API, deployed by new RBAC+Deployment objects from `K8sManifestBuilder`. Tasks 1–6 complete the push path (proven by a smoke); 7–10 add the pull path (proven by a second smoke).

**Tech Stack:** TypeScript, Node `crypto` (token hashing) + `fetch` (agent→Registry and agent→k8s REST), `node:test` via `tsx --test`, `kubectl`/docker-desktop k8s, the existing `src/bin` daemon pattern + `docker/Dockerfile` image.

**Spec:** `docs/superpowers/specs/2026-10-22-sp-hive-4-rollout-spec.md`

## Global Constraints

- **Additive**: do not change the shipped docker lifecycle, the HIVE-2 health route, or the HIVE-3 gate; extend via new routes + an additive `ControlPlaneHost` ctor arg (last positional) + new records/stores.
- **Push stays signature-verified** via the SP-HIVE-3 orchestrator `Roll` gate. **Pull path does NOT verify in-agent** (deferred Feature — the agent has no local docker store for `{{.Id}}`); document it, never silently skip.
- **Agent = new `src/bin/pragmatic-agentd` daemon in the `pragmatic-server:dev` image**, HTTP-only: `fetch` to the Registry (configured URL, `host.docker.internal:7000` locally) and to the **in-cluster k8s REST API** (`https://kubernetes.default.svc`, mounted ServiceAccount token + CA). **No `@kubernetes/client-node`, no `kubectl` in the pod, no `admin/` import.**
- **Machine credential**: generated once at hive rollout-registration, returned once, **only its hash stored** (Registry) and only its ref name on `HiveRecord.agentTokenRef`. Never logged, never in a DTO or error. Agent-route auth is a **constant-time hash compare** (`crypto.timingSafeEqual`).
- **Agent RBAC is namespace-scoped least privilege**: `get`,`patch` on `apps/deployments` in the env namespace only.
- Operator routes stay operator-gated + CSRF-guarded (existing `Authenticated`/`OriginAllowed`); only the two agent routes use machine-credential auth and must NOT be added to `IsPublicApi` as fully public.
- **OOP**, **Allman** braces, **no inline string literals** (hoist to `private static readonly`), **PascalCase** public methods/interfaces, enums over string-literal sets.
- **Tests in `tests/` subfolders**; **LF-only**. Admin tests: `npx tsx --test "admin/control-plane/tests/*.test.ts"`. Agent tests live under `src/agent/tests/` and run with the repo's `npm test` (`src/**/*.test.ts`). Types: `npm run typecheck:tools` (admin) and `npm run build`/tsc for `src`.

## Review Focus

- **Machine-credential auth bypass:** a missing/wrong bearer on an agent route must 401 via constant-time compare; the stored value is a hash; no token in any log/DTO/error — pinned by Task 7.
- **Gating bypass:** `ManifestsFor`/`SelectTarget` must never offer or select a version not gated for the hive's tenant (a canary must not leak to a non-chosen tenant) — pinned by Task 2.
- **Unreachable-hive mishandling:** `SelectTarget` must push via `Roll` for reachable hives but must RECORD-and-continue (not fail, not silently drop) when the backend is unreachable/`UnsupportedBackendError` — pinned by Task 3.
- **Agent over-privilege / wrong patch:** the agent Role is namespace-scoped `get`/`patch` on its one Deployment; the agent patches only when obsolete and only its own env's Deployment — pinned by Task 7 (RBAC shape) + Task 9 (patch-iff-obsolete).
- **Obsoletion miscompute:** obsolete iff reported `runningImage !== manifest(targetVersion).image`, cleared exactly on match (equality, not substring) — pinned by Task 2.

---

### Task 1: Rollout record types + registries + `HiveRecord.agentTokenRef`

**Files:**
- Create: `admin/control-plane/manifest-record.ts`, `gating-record.ts`, `selection-record.ts`, `rollout-registration-record.ts`, `rollout-report-record.ts` (each: the `type …Record` + its `class …Registry extends JsonRecordStore<…>`).
- Modify: `admin/control-plane/platform-records.ts` (add `agentTokenRef?: string` to `HiveRecord`).
- Test: `admin/control-plane/tests/rollout-records.test.ts`

**Interfaces — Produces:** `ManifestRecord{ id, image, notes?, publishedAt }`+`ManifestRegistry`(root `manifests`); `GatingRecord{ id, tenantId, version, gatedAt }`+`GatingRegistry`(root `gating`); `SelectionRecord{ id, hiveId, targetVersion, selectedAt }`+`SelectionRegistry`(root `selections`); `RolloutRegistrationRecord{ id, hiveId, agentTokenHash, registeredAt }`+`RolloutRegistrationRegistry`(root `rolloutRegistrations`); `RolloutReportRecord{ id, hiveId, environmentName, runningImage, ready, reportedAt }`+`RolloutReportRegistry`(root `rolloutReports`). `HiveRecord` gains optional `agentTokenRef`.

- [ ] **Step 1: Write the failing test** — for one representative registry (ManifestRegistry): `Put`/`Get` round-trip, `Get(unknown)`→undefined, fresh-path(ENOENT)→empty `List`; and a compile-time check that a `HiveRecord` literal may carry `agentTokenRef`.
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/rollout-records.test.ts"` — FAIL (modules missing).
- [ ] **Step 3: Implement** the five record modules (mirror `hive-registry.ts`: `private static readonly RootKey`, ctor `super(filePath, RootKey)`) and add `agentTokenRef?` to `HiveRecord`.
- [ ] **Step 4: Run** the test — PASS. **Step 5:** `npm run typecheck:tools` clean. **Step 6: Commit** (`feat(sp-hive-4): rollout record stores + HiveRecord.agentTokenRef`).

---

### Task 2: `PlatformDeploymentRegistry` core (publish, gating, selection-record, target, report, obsoletion, machine-token)

**Files:**
- Create: `admin/control-plane/platform-deployment-registry.ts`
- Create: `admin/control-plane/rollout-errors.ts` (`UnknownManifestError`, `ManifestExistsError`, `ManifestNotGatedError`, `HiveNotRegisteredError`, `AgentUnauthorizedError`)
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts`

**Interfaces:**
- Consumes: the Task 1 registries; `PlatformDirectory` (`GetHive`, `GetTenant`). (The push actuator is Task 3 — this task records the selection but does NOT roll.)
- Produces: `class PlatformDeploymentRegistry` with (illustrative) `Publish(version: string, image: string, notes?: string): Promise<ManifestRecord>`; `ManifestsFor(tenantId: string): readonly ManifestRecord[]`; `Gate(tenantId, version): Promise<void>`; `Ungate(tenantId, version): Promise<void>`; `SelectTarget(hiveId, version): Promise<void>` (validates published+gated-for-the-hive's-tenant, records selection); `TargetFor(hiveId): { version: string; image: string } | undefined`; `Report(hiveId, environmentName, runningImage, ready): Promise<void>`; `StatusFor(hiveId): { targetVersion: string | undefined; environments: { environmentName: string; runningImage: string; obsolete: boolean; ready: boolean }[] }`; `RegisterHive(hiveId): Promise<string>` (generates a token, stores its hash, returns the token once); `VerifyAgentToken(hiveId, presentedToken): Promise<void>` (throws `AgentUnauthorizedError` on mismatch, constant-time).

- [ ] **Step 1: Write the failing tests:**
  - `Publish` then `ManifestsFor(tenant)` returns it only after `Gate(tenant, version)`; `Ungate` removes it; a second `Publish` of the same version throws `ManifestExistsError`.
  - `SelectTarget(hive, version)` throws `UnknownManifestError` for an unpublished version and `ManifestNotGatedError` when the version isn't gated for the hive's tenant; succeeds (records) when published+gated.
  - `StatusFor`: after `SelectTarget(hive, v2)` and `Report(hive, env, image(v1), true)`, the env is `obsolete: true`; after `Report(hive, env, image(v2), true)`, `obsolete: false` (equality, not substring — test `image(v2)` is not a substring of a longer string that would false-match).
  - rollback: `SelectTarget(hive, v1)` after v2 makes `TargetFor` return v1's image again.
  - machine token: `RegisterHive(hive)` returns a token; `VerifyAgentToken(hive, token)` resolves; a wrong token → `AgentUnauthorizedError`; the stored `RolloutRegistrationRecord.agentTokenHash` is NOT equal to the raw token (it's hashed); an unregistered hive → `HiveNotRegisteredError`.
- [ ] **Step 2: Run** the test — FAIL. **Step 3: Implement.** Token = `crypto.randomBytes(32).toString('base64url')`; hash = `crypto.createHash('sha256')`; verify via `crypto.timingSafeEqual` on the hashes. Hoist all literals; typed errors in `rollout-errors.ts`.
- [ ] **Step 4: Run** — PASS. **Step 5:** typecheck clean. **Step 6: Commit** (`feat(sp-hive-4): PlatformDeploymentRegistry core`).

---

### Task 3: Push actuator (`SelectTarget` drives `Roll` for reachable hives)

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts` (inject `HiveOrchestratorFactory` + an `EnvironmentPlacement`/`IEnvironmentLookup`; `SelectTarget` pushes after recording)
- Test: extend `admin/control-plane/tests/platform-deployment-registry.test.ts`

**Interfaces:**
- Consumes: `HiveOrchestratorFactory.For` (throws `UnsupportedBackendError` for non-local), `IHiveOrchestrator.Roll(workload, image)`, `EnvironmentPlacement.WorkloadFor`, the environment list (`IEnvironmentLookup`).
- Produces: `SelectTarget(hiveId, version)` now, after recording the selection: resolve the orchestrator; for each environment bound to the hive, `Roll(WorkloadFor(env), manifest.image)`; on `UnsupportedBackendError` (unreachable backend) record a typed note and return success (pull-only), NOT throwing.

- [ ] **Step 1: Write the failing tests** (fake `HiveOrchestratorFactory` + fake orchestrator recording `Roll` calls; a fake `IEnvironmentLookup` with 2 envs bound to the hive + 1 on another hive):
  - `SelectTarget(localHive, v2)` calls `Roll` exactly for the 2 bound envs, each with `manifest(v2).image`; the unrelated env is not rolled.
  - `SelectTarget` on a hive whose factory `For` throws `UnsupportedBackendError` still records the selection and resolves (no throw); `TargetFor` reflects v2.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the push loop; catch `UnsupportedBackendError` specifically (let other errors propagate).
- [ ] **Step 4: Run** the full registry test — PASS. **Step 5:** typecheck clean. **Step 6: Commit** (`feat(sp-hive-4): push actuator`).

---

### Task 4: Control-plane operator API + host wiring

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (new ctor arg `registry: PlatformDeploymentRegistry` (last positional); routes; `ErrorStatuses` += the rollout errors)
- Modify: `admin/control-plane/server.ts` (construct the registries + `PlatformDeploymentRegistry`, pass it in)
- Modify: `admin/control-plane/control-plane-smoke.ts` (same wiring)
- Modify: `admin/control-plane/tests/control-plane-host.test.ts`, `control-plane-host-platform.test.ts`, `control-plane-host-hive-health.test.ts` (ctor gains the new arg — update all constructions)
- Test: `admin/control-plane/tests/control-plane-host-rollout.test.ts`

**Interfaces:** routes `POST /api/manifests`; `GET /api/tenants/:id/manifests`; `POST /api/tenants/:id/gating`; `DELETE /api/tenants/:id/gating/:version`; `POST /api/hives/:id/target`; `GET /api/hives/:id/rollout`; `POST /api/hives/:id/rollout-registration` (→ returns the token once). All operator-gated. DTOs carry no secret (the registration route returns the token exactly once in its 201 body — document it as the one-time reveal, never stored in a record).

- [ ] **Step 1: Write the failing test** (compose host with a fake/real `PlatformDeploymentRegistry`; authenticated operator): publish→gate→list-gated returns the manifest; `POST /api/hives/:id/target` records + (fake registry) reports push attempted; `GET /api/hives/:id/rollout` returns the status DTO; unauthenticated → 401; the rollout-registration response contains a token field and the stored record does not.
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/control-plane-host-rollout.test.ts"` — FAIL.
- [ ] **Step 3: Implement** routes + DTOs (hoisted field constants) + `ErrorStatuses` additions (`ManifestNotGatedError`→403 — justify: the tenant is not authorized to that version); add the ctor arg; wire `server.ts` + `control-plane-smoke.ts` + update the three existing host test constructions.
- [ ] **Step 4: Run** the full admin suite — PASS, no regressions. **Step 5:** typecheck clean. **Step 6: Commit** (`feat(sp-hive-4): rollout operator API + wiring`).

---

### Task 5: Publish CLI

**Files:**
- Create: `admin/control-plane/manifest-publish.ts` (`class ManifestPublish` with `static async Main(argv)` + `IsEntryPoint()`, mirroring `loop-orchestrator.ts`'s CLI shape)
- Test: `admin/control-plane/tests/manifest-publish.test.ts`

**Interfaces:** `ManifestPublish.ParseArgs(argv): { version, image, notes? }`; composes a `ManifestRegistry`/`PlatformDeploymentRegistry` against the data root and calls `Publish`.

- [ ] **Step 1: Write the failing test:** `ParseArgs(['--version','1.0.0','--image','pragmatic-server:dev'])` returns the parsed object; missing `--version`/`--image` throws a typed usage error. (Pure arg-parsing + a Publish delegation; keep the Main/IsEntryPoint untested like other entrypoints.)
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (hoist flag names/usage strings). **Step 4: Run** — PASS. **Step 5:** typecheck clean. **Step 6: Commit** (`feat(sp-hive-4): manifest publish CLI`).

---

### Task 6: Gated real-cluster PUSH smoke

**Files:**
- Create: `admin/control-plane/rollout-push-smoke.ts`
- Modify: `admin/README.md`

**Interfaces:** composes the real stack (context `docker-desktop`) following `registry-provenance-smoke.ts`.

- [ ] **Step 1: Implement** `class RolloutPushSmoke` (`static Main` + `IsEntryPoint`, not under `tests/`). Publish v1 + v2 manifests (two tags of `pragmatic-server:dev`, both signed per SP-HIVE-3 into temp stores), bring an environment up on v1, `SelectTarget(hive, v2)` through the Registry, assert the env's server Deployment running image is now v2; re-select v1 (rollback) and assert it returns to v1. Teardown-in-finally; redacted logging.
- [ ] **Step 2: Guard** it out of `tsx --test`; confirm the glob doesn't pick it up.
- [ ] **Step 3: Run for real** against docker-desktop; capture real output (publish→select→roll to v2→rollback to v1). Report honestly; if an image-distinctness detail can't be shown, say so.
- [ ] **Step 4: Commit** (`test(sp-hive-4): gated rollout push smoke`). **Push path complete after this task.**

---

### Task 7: Agent routes (machine-credential auth)

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (two agent routes + the machine-credential auth path)
- Test: `admin/control-plane/tests/control-plane-host-agent.test.ts`

**Interfaces:** `GET /api/hives/:id/agent/target` and `POST /api/hives/:id/agent/report` — NOT operator-gated; each requires `Authorization: Bearer <token>` verified via `registry.VerifyAgentToken(hiveId, token)`; a bad/absent token → 401 (`AgentUnauthorizedError`). `target` returns `{ version, image } | 404`; `report` ingests `{ environmentName, runningImage, ready }` → `registry.Report(...)`.

- [ ] **Step 1: Write the failing test:** register a hive (get token); `GET …/agent/target` with the correct bearer → 200 `{version,image}`; with a wrong/absent bearer → 401 and the body contains no token; `POST …/agent/report` with the correct bearer records the report (reflected by `GET …/rollout`); the response/logs contain no token.
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/control-plane-host-agent.test.ts"` — FAIL.
- [ ] **Step 3: Implement** the agent-auth branch in `Handle`/`RouteApi` (extract the bearer; the two agent paths skip the operator-session gate but require `VerifyAgentToken`; they are NOT in `IsPublicApi`). Constant-time compare lives in the Registry (Task 2).
- [ ] **Step 4: Run** the full admin suite — PASS. **Step 5:** typecheck clean. **Step 6: Commit** (`feat(sp-hive-4): agent routes + machine-credential auth`).

---

### Task 8: k8s agent objects in `K8sManifestBuilder`

**Files:**
- Modify: `admin/control-plane/k8s-manifest-builder.ts` (render ServiceAccount + Role + RoleBinding + agent Deployment + the agent Secret for an environment; name helpers)
- Test: `admin/control-plane/tests/k8s-manifest-builder.test.ts` (extend)

**Interfaces — Produces:** a render path (e.g. `RenderAgent(workload, registryUrl, tokenSecretName): string` or items appended via a new method) emitting: `ServiceAccount` `AgentServiceAccountOf(env)`; `Role` (verbs `get`,`patch` on apiGroup `apps`, resource `deployments`, scoped to `ServerDeploymentOf(env)`); `RoleBinding` binding the SA to the Role; agent `Deployment` `AgentDeploymentOf(env)` (`image: pragmatic-server:dev`, `imagePullPolicy: IfNotPresent`, `command: ['node','dist/bin/pragmatic-agentd.js']`, env `PRAGMATIC_AGENT_*`, the token mounted from a `Secret` via `secretKeyRef`); all in the env namespace with existing labels. Static helpers hoisted like `ServerDeploymentOf`.

- [ ] **Step 1: Write the failing tests:** the agent render emits the five object kinds with the right names; the Role has exactly `get`,`patch` on `apps/deployments` (not `*`, not cluster-scoped, not other verbs); the agent Deployment's `command` targets `pragmatic-agentd`, `image` is `pragmatic-server:dev`, and the token is a `secretKeyRef` — the rendered string contains NO token value; the agent carries `PRAGMATIC_AGENT_REGISTRY_URL`/`_HIVE_ID`/`_ENV_NAME` env.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (hoist all k8s kind/field/verb constants; reuse existing label constants). **Step 4: Run** — PASS. **Step 5:** typecheck clean. **Step 6: Commit** (`feat(sp-hive-4): k8s agent RBAC + deployment manifests`).

---

### Task 9: The pull agent daemon (`pragmatic-agentd`)

**Files:**
- Create: `src/agent/rollout-agent.ts` (`class RolloutAgent`), `src/agent/k8s-api.ts` (`class InClusterK8sApi` — fetch-based get/patch deployment image, SA token + CA from mounted files), `src/agent/agent-main.ts` (`class AgentMain`), `src/bin/pragmatic-agentd.ts` (one-line shim)
- Modify: `package.json` (`bin` += `pragmatic-agentd`)
- Test: `src/agent/tests/rollout-agent.test.ts`

**Interfaces:** `class RolloutAgent { constructor(deps: { fetchTarget(): Promise<{version,image}|undefined>; readRunningImage(): Promise<string|undefined>; patchImage(image: string): Promise<void>; report(runningImage: string, ready: boolean): Promise<void> }); async Tick(): Promise<void> }` — the testable core (one poll cycle), with `fetch`/k8s wired by `AgentMain` from env. `InClusterK8sApi` reads `/var/run/secrets/kubernetes.io/serviceaccount/token` + `ca.crt` and talks to `https://kubernetes.default.svc`.

- [ ] **Step 1: Write the failing tests** (inject fakes for the four deps):
  - `Tick` with target image != running image → calls `patchImage(target)` then `report(...)`.
  - `Tick` with target == running → does NOT patch (idempotent), still reports.
  - `Tick` with no target → does not patch, does not throw.
  - a throwing `fetchTarget`/`patchImage` → `Tick` surfaces/handles it such that a long-running loop would back off, not crash (test that `Tick` rejects rather than hangs; the loop/backoff lives in `AgentMain` and is not unit-tested); no token is read into any log.
- [ ] **Step 2: Run** `npm test` (or `npx tsx --test "src/agent/tests/rollout-agent.test.ts"`) — FAIL.
- [ ] **Step 3: Implement** `RolloutAgent.Tick`, `InClusterK8sApi` (fetch, bearer SA token, CA trust; PATCH strategic-merge of the server container image), `AgentMain` (read env/config, construct deps, run the interval loop with bounded backoff), the bin shim, and the `bin` entry. Imports NOTHING from `admin/`; HTTP-only. Hoist all literals (env keys, k8s paths, container name).
- [ ] **Step 4: Run** the agent test — PASS. **Step 5:** `npm run build` (or tsc for `src`) + `npm run typecheck:tools` clean. **Step 6: Commit** (`feat(sp-hive-4): pull agent daemon`).

---

### Task 10: Gated real-cluster PULL smoke

**Files:**
- Create: `admin/control-plane/rollout-pull-smoke.ts`
- Modify: `admin/README.md`

- [ ] **Step 0 (prerequisite): rebuild the `pragmatic-server:dev` image** so it contains the new `pragmatic-agentd` bin from Task 9 (`DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path>/.npmrc -t pragmatic-server ..` from the parent workspace dir). Without this the agent pod runs a stale image with no agent entrypoint. Document the exact build invocation used.
- [ ] **Step 1: Implement** `class RolloutPullSmoke` (`static Main` + `IsEntryPoint`, not under `tests/`). Register the hive (get the machine token), bring an environment up on v1, deploy the agent objects (SA/Role/RoleBinding/Deployment/Secret from Task 8, token in the Secret, `PRAGMATIC_AGENT_REGISTRY_URL=http://host.docker.internal:<port>` to a locally-served Registry), `SelectTarget(hive, v2)` WITHOUT driving push (simulate unreachable — record-only), then assert the in-cluster agent patches its env's server Deployment to v2 on its own and reports back so `GET …/rollout` shows the env no longer obsolete. Poll with a bounded timeout; teardown-in-finally; redacted logging; the machine token + SA token never logged.
- [ ] **Step 2: Guard** it out of `tsx --test`.
- [ ] **Step 3: Run for real** against docker-desktop; capture real output (agent self-updates v1→v2 + flag clears). If the agent can't reach `host.docker.internal` or the image/boot caveats bite, diagnose and report honestly — never fake a pass.
- [ ] **Step 4: Commit** (`test(sp-hive-4): gated rollout pull-agent smoke`). **Pull path complete after this task.**

---

## Notes for the executor

- Tasks 1–6 are the push path and are independently complete/mergeable; 7–10 add pull.
- Reuse: `registry-provenance-smoke.ts` for smoke shape + signing setup; `server-main.ts` for the `AgentMain` daemon shape; `hive-registry.ts` for the record-store shape; `RouteHiveHealth` for the per-hive route shape.
- The agent speaks only HTTP and imports no `admin/` code — keep it that way (it ships in the runtime image but is dependency-clean).
- k8s/JSON contract field names (`apiVersion`,`kind`,`rules`,`verbs`,`subjects`,`roleRef`,`spec.template…`) keep upstream casing but are still hoisted to `private static readonly` constants, not inline.
- Machine token and the in-cluster SA token are secrets: never interpolate their bytes into a log, error, or DTO (the one exception is the registration route returning the token once in its response body — that is the documented one-time reveal).
