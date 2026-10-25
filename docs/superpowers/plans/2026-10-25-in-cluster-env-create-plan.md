# In-Cluster Environment Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the tenant admin create environments in its own hive by driving the in-cluster Kubernetes orchestrator, via an `IEnvironmentRuntime` seam on `EnvironmentService` (Docker impl = today's dev-collapse behavior, in-cluster impl = orchestrator + placement + manifest), plus a tenant-plane create route — proven to the orchestration level by a gated live smoke.

**Architecture:** The approved design (spec lines 37/83/101) mandates the tenant admin create environments through the *existing* `EnvironmentService` + `HiveOrchestratorFactory` + `EnvironmentPlacement` path, pointed at the in-cluster k8s API — not a new parallel service. Today `EnvironmentService` is Docker-only: `Create`/`Start`/`Stop`/`Delete` call `IDockerEnv`, and the `EnvironmentRecord`/DTO carry Docker-shaped fields (`containerName`/`volumeName`/`bundleDir`/`hostPort`). We extract the backend-shaped operations behind a new `IEnvironmentRuntime` seam. `DockerEnvironmentRuntime` wraps the current `IDockerEnv`/`IBundleBuilder`/`IContainerProbe` and preserves behavior exactly. `InClusterEnvironmentRuntime` drives `HiveOrchestratorFactory.For(hive).Apply(EnvironmentPlacement.WorkloadFor(record))` + `WaitHealthy`/`Teardown`. A per-record `EnvironmentRuntimeResolver` picks the runtime from the record's hive binding (unbound/undefined ⇒ Docker; bound to a k8s hive ⇒ in-cluster). The standalone `TenantAdminServer` wires the in-cluster runtime and exposes `POST /tenant-api/environments`.

**Tech Stack:** TypeScript (NodeNext ESM, `verbatimModuleSyntax`), node:test + tsx, the existing `admin/control-plane` orchestrator/kubectl/manifest stack, kind (docker-desktop) for the gated smoke.

**Spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` — implements the filed follow-up "In-cluster environment creation for the tenant admin".

## Scope boundary (read before implementing)

This slice delivers in-cluster env creation to the **orchestration level**: the tenant admin applies an env-server workload into its hive via the orchestrator, it rolls out Ready, and it can be torn down. The following are genuinely-unfinished adjacent substrate ("SP-HIVE-3") and are explicitly **OUT OF SCOPE** here — each is filed as a follow-up Feature, and the code must not pretend to implement them:

- Real in-cluster server **boot config/secret injection** into the served env-server pod. `K8sManifestBuilder.Render`/`ServerDeployment` today wire only `PRAGMATIC_PORT`; the served `pragmatic-server` needs base-dir/tenant-source/master-key that the Docker model supplies as mounted files. The live smoke uses the same throwaway-config approach as `k8s-hive-smoke.ts` (reaching rollout-Ready), not a fully identity-wired served env.
- `Federate` rework for in-cluster: the per-env OIDC `redirectUri` is hardcoded `http://localhost:<port>` and the CA is returned as a host path (`caHostPath`). In-cluster needs the cluster-served origin and the CA mounted as a Secret. For in-cluster create this slice does **not** call `Federate` (the in-cluster runtime applies the workload without per-env OIDC federation); federation-in-cluster is deferred.
- Env-secret provisioning as k8s Secret objects (admin/DB/OIDC-client).

The deliverable is the adapter + route + orchestration-level proof; the above make the served env fully production-wired and are separate.

## Global Constraints

- OOP only: methods/statics on classes; no module-level free functions or mutable module state. `const` compile-time constants and type/enum declarations are fine.
- Allman braces for every class/interface/enum/method/control-flow block. Hand-maintained; match surrounding code.
- No inline string literals: hoist user-facing text and any reused literal to `private static readonly` PascalCase constants. Structural single-use tokens may stay inline.
- PascalCase for interfaces and all public methods. New seams are real classes/interfaces, not lambda "bags".
- Security discipline (verbatim, non-negotiable): credentials/keys/tokens/secrets/auth-codes and inner-error text are held server-side by name only — NEVER in logs, DTOs, errors, thrown messages, or persisted records. Manifests carry secret REFs, not values.
- Engine-never-calls-up / signal-only upward notification; the `OnChanged` lifecycle fan-out stays signal-only.
- Tests live in `admin/control-plane/tests/`; files `*.test.ts`. Gated smokes are `*-smoke.ts` (excluded from the test glob, run via `npx tsx`).
- LF-only line endings; do not flip files to CRLF. Do not touch `agent-channel-host.ts`.
- NEVER `npm install` at the repo root (breaks workspace symlinks).
- Typecheck gates: `npx tsc -p tsconfig.tools.json --noEmit` AND `npx tsc -p tsconfig.tenant-admin.json --noEmit` both clean.
- Control-plane unit suite (`npx tsx --test "admin/control-plane/tests/*.test.ts"`) must stay green (baseline 635 pass on this branch's master).
- Git commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push.

## Review Focus

- **Docker-path behavior preservation (Task 1):** the seam extraction must not change any observable Docker behavior — `Create`/`Start`/`Stop`/`Restart`/`Delete`/`Logs`/`AdminInfoFor`/`SeedDemoUsers` for an unbound (Docker) env must behave byte-identically. Covered by the full existing unit suite staying green with no test assertions weakened.
- **Runtime selection correctness (Task 2/3):** an unbound record (no `hiveId`) always resolves to the Docker runtime; a record bound to a k8s hive resolves to in-cluster. A misresolution would run Docker ops against an in-cluster env or vice-versa. Covered by `EnvironmentRuntimeResolver` unit tests on both branches.
- **Cross-tenant create (Task 3):** the create route must set the environment's hive from the caller's own tenant/hive binding (session-derived), never from an attacker-chosen body hiveId that belongs to another tenant; a body naming a foreign hive must 404/400, not create. Covered by the create-route cross-tenant test.
- **Secret non-leakage on the in-cluster path (Task 2):** a failed `Apply`/`WaitHealthy` must surface a fixed generic error — never the kubectl stderr, manifest contents, or any secret ref value. Covered by an in-cluster-runtime error-mapping test.
- **Teardown completeness (Task 2):** in-cluster `Delete` must tear down the namespace (and thus Deployment/Service/DB/PVC) so a re-create of the same name does not collide. Covered by a teardown unit test asserting `orchestrator.Teardown` is invoked and by the live smoke's create→delete→recreate.

---

### Task 1: Extract the `IEnvironmentRuntime` seam (behavior-preserving)

**Files:**
- Create: `admin/control-plane/environment-runtime.ts` (`IEnvironmentRuntime` interface, `EnvRuntimeContext`/`EnvEndpoint` types, `DockerEnvironmentRuntime` class)
- Modify: `admin/control-plane/environment-service.ts` (depend on `IEnvironmentRuntime` instead of calling `IDockerEnv`/`IBundleBuilder`/`IContainerProbe` directly; bring-up returns an `EnvEndpoint`)
- Modify: `admin/control-plane/environment-record.ts` (make `containerName`/`volumeName`/`bundleDir`/`hostPort` optional; add an optional stored `endpoint?: { httpUrl: string; wsUrl: string }`)
- Modify: `admin/control-plane/environment-dto.ts` (`ToDto` reads the stored `endpoint` when present, falling back to today's `hostPort`/localhost derivation)
- Modify the wirings that construct `EnvironmentService`: `admin/control-plane/server.ts`, `admin/control-plane/tenant-admin-server.ts`, and the smoke/loop constructions (`control-plane-smoke.ts`, `loop-orchestrator.ts`, `idp-federation-smoke.ts`, `tenant-login-e2e-smoke.ts`) — wrap the existing `DockerEnvAdapter` in `DockerEnvironmentRuntime` and pass that.
- Test: `admin/control-plane/tests/environment-runtime.test.ts` (new) + the existing `environment-service` tests stay green.

**Interfaces:**
- Produces (consumed by Tasks 2-3):
```ts
export type EnvEndpoint = { httpUrl: string; wsUrl: string; hostPort?: number }
export type EnvRuntimeContext = { def: EnvDefinition; record: EnvironmentRecord; bundleDir?: string; oidc?: EnvOidc; caHostPath?: string }
export interface IEnvironmentRuntime
{
    EnsureImage(def: EnvDefinition): Promise<boolean>
    BuildCommand(): string
    BringUp(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    WaitHealthy(ctx: EnvRuntimeContext): Promise<void>
    Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    Stop(ctx: EnvRuntimeContext): Promise<void>
    Teardown(ctx: EnvRuntimeContext, removeData: boolean): Promise<void>
    RemoveVolume(ctx: EnvRuntimeContext): Promise<void>
    Logs(ctx: EnvRuntimeContext): Promise<string>
    LogStream(ctx: EnvRuntimeContext, onData: (chunk: string) => void): ILogProcess
    Probe(ctx: EnvRuntimeContext): Promise<boolean>
}
```
- `DockerEnvironmentRuntime` ctor takes the existing `IDockerEnv` + `IBundleBuilder` (and whatever `AdminInfoFor`/`SeedDemoUsers` need) and implements every method by exactly the calls `EnvironmentService` makes today (`EnsureImage`→`docker.EnsureImage`, `BringUp`→`bundle.Generate` + `docker.Up` + returns a `localhost:hostPort` endpoint, `WaitHealthy`→`docker.WaitHealthy`, `Teardown`→`docker.Down(def,removeData)`, `RemoveVolume`→`docker.RemoveVolume`, `Probe`→`docker.Running(containerName)`, etc.). No behavior change.

**Approach note:** This is a pure refactor. The design decision already made: move backend-shaped ops behind the seam; keep in `EnvironmentService` the port allocation, `TemplateCatalog.Resolve`, `Federate` orchestration, the in-flight guard, `registry.Put/Remove`, and `NotifyChanged`. `AdminInfoFor`/`DatabaseInfoFor`/`SeedDemoUsers` read `bundleDir`/`hostPort`/`provisioned-secrets.json` — for Docker they keep working via the now-optional fields; do NOT make them in-cluster-aware in this task.

- [ ] **Step 1:** Write `environment-runtime.test.ts` asserting `DockerEnvironmentRuntime` forwards each method to the underlying fake `IDockerEnv`/`IBundleBuilder` with the same arguments `EnvironmentService` used before, and that `BringUp` returns `{ httpUrl:'http://localhost:<port>', wsUrl:'ws://localhost:<port>/?environment=<id>', hostPort:<port> }`.
- [ ] **Step 2:** Run it — FAIL (class not defined).
- [ ] **Step 3:** Implement `environment-runtime.ts` (interface + types + `DockerEnvironmentRuntime`). Refactor `EnvironmentService` to hold `private readonly runtime: IEnvironmentRuntime` and route all `docker.*`/`bundle.Generate` calls through it; persist the `EnvEndpoint` on the record; make the record's Docker fields optional; update `ToDto`. Update every `new EnvironmentService(...)` construction to pass `new DockerEnvironmentRuntime(docker, bundle, ...)`.
- [ ] **Step 4:** Run the full control-plane suite + both tscs → all green, no weakened assertions.
- [ ] **Step 5:** Commit `refactor: extract IEnvironmentRuntime seam from EnvironmentService (Docker impl preserves behavior)`.

---

### Task 2: `InClusterEnvironmentRuntime` + `EnvironmentRuntimeResolver`

**Files:**
- Create: `admin/control-plane/in-cluster-environment-runtime.ts` (`InClusterEnvironmentRuntime implements IEnvironmentRuntime`)
- Create: `admin/control-plane/environment-runtime-resolver.ts` (`EnvironmentRuntimeResolver` — picks the runtime per record)
- Modify: `admin/control-plane/environment-service.ts` (resolve the runtime per-record via the resolver rather than a single injected runtime; the resolver is the new ctor dependency)
- Modify the `EnvironmentService` wirings so they compile with the new resolver ctor (this task changes the signature, so it must rewire everything in the same task to keep tsc green): `admin/control-plane/server.ts`, `admin/control-plane/tenant-admin-server.ts`, `admin/control-plane/control-plane-smoke.ts`, `admin/control-plane/loop-orchestrator.ts`, `admin/control-plane/idp-federation-smoke.ts`, `admin/control-plane/tenant-login-e2e-smoke.ts` — each constructs `new EnvironmentRuntimeResolver(dockerRuntime, inClusterRuntime, directory)` and passes it. In the standalone `tenant-admin-server.ts` and `server.ts` the in-cluster runtime is built from the already-constructed `HiveOrchestratorFactory` + `EnvironmentPlacement` + directory; in the Docker-only smokes/loop the in-cluster branch is present but never selected (their records are unbound), so an in-cluster runtime built over a `HiveOrchestratorFactory` is fine and never exercised.
- Test: `admin/control-plane/tests/in-cluster-environment-runtime.test.ts`, `admin/control-plane/tests/environment-runtime-resolver.test.ts`

**Interfaces:**
- Consumes: `IEnvironmentRuntime` (Task 1); `HiveOrchestratorFactory.For(hive)` → `IHiveOrchestrator` (`Apply`/`WaitHealthy`/`Health`/`Teardown`); `EnvironmentPlacement.WorkloadFor(record)` → `EnvironmentWorkload`; `ITenantDirectory.GetHive(hiveId)`.
- `InClusterEnvironmentRuntime` ctor: `(orchestrators: HiveOrchestratorFactory, placement: EnvironmentPlacement, directory: ITenantDirectory)`. `BringUp(ctx)`: resolve `hive = directory.GetHive(ctx.record.hiveId)`, `workload = placement.WorkloadFor(ctx.record)`, `orchestrators.For(hive).Apply(workload)`, return an `EnvEndpoint` whose `httpUrl`/`wsUrl` are the in-cluster Service DNS (derive from `K8sManifestBuilder` name helpers — no `hostPort`). `WaitHealthy`→`orchestrator.WaitHealthy(workload)`. `Teardown`→`orchestrator.Teardown(workload)`. `Probe`→`orchestrator.Health(workload).ready`. `EnsureImage`→`true` (image availability is the orchestrator's `VerifiedImage`/registry concern at apply time). `RemoveVolume`→no-op (namespace teardown removes the PVC). `Logs`/`LogStream`: throw a fixed `EnvLogsUnavailableInClusterError` (logs are a deferred concern; name it, don't fake it). On `Apply`/`WaitHealthy` failure, throw a fixed generic error (no kubectl stderr / manifest / secret content).
- `EnvironmentRuntimeResolver` ctor: `(docker: IEnvironmentRuntime, inCluster: IEnvironmentRuntime, directory: ITenantDirectory)`; method `For(record: EnvironmentRecord): IEnvironmentRuntime` returns `docker` when `record.hiveId === undefined`, else looks up the hive and returns `inCluster` when the hive's `cluster` resolves to a k8s orchestrator (Local/Attach or Local/Provision), else throws `UnsupportedBackendError`.

- [ ] **Step 1:** Write resolver tests (unbound→docker; k8s-hive→in-cluster; unsupported backend→throws) and in-cluster-runtime tests with a fake `HiveOrchestratorFactory`/orchestrator + fake placement: `BringUp` applies the placement workload and returns a DNS endpoint; `Teardown` calls `orchestrator.Teardown`; a thrown `Apply` surfaces a fixed generic error with no stderr; `Logs` throws the named unavailable error.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement both classes; change `EnvironmentService` to take the resolver and call `this.runtimes.For(rec)` at each lifecycle verb.
- [ ] **Step 4:** Full suite + tscs green.
- [ ] **Step 5:** Commit `feat: InClusterEnvironmentRuntime + per-record runtime resolver`.

---

### Task 3: Add the tenant create route

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (add `POST /tenant-api/environments`)
- Test: `admin/control-plane/tests/tenant-create-env.test.ts`

(The standalone + collapsed wirings already construct and inject the resolver as of Task 2, so this task is route-only.)

**Interfaces:**
- Create route `POST /tenant-api/environments`, body `{ name: string; template: Template; type: EnvType }` (NO hiveId in the body). The endpoint derives the hive from the caller's tenant: it resolves the caller's single hive via `directory.ListHives(session.tenantId)` and uses that hive's id as the `hiveId` passed to `service.Create(name, template, type, undefined, hiveId)`. If the tenant has no hive → 409/404 generic. Validate body (non-empty name, known `template`/`type` enum) → 400 `{error}` on bad input, mirroring the `ReadVersion`/`RouteHiveTarget` body/size conventions. Success → 201 + `EnvironmentDtoMapper.ToDto(record)`. Map `EnvironmentExistsError`→409, `UnsupportedBackendError`→400, other create failures→a fixed generic 500/503 `{error}` with no inner text.
- Cross-tenant guard: because the hive is derived from `session.tenantId` (never the body), a caller can only create in its own hive by construction; the test asserts a body cannot steer creation to another tenant's hive.

- [ ] **Step 1:** Write `tenant-create-env.test.ts`: valid body → `service.Create` called with the session-tenant's hiveId and returns 201 + DTO; body attempting to pass a foreign `hiveId` is ignored (hive comes from session); missing/invalid body → 400; no-hive tenant → generic 409/404; `EnvironmentExistsError` → 409. Use the existing tenant-api test harness (fake service/directory/session).
- [ ] **Step 2:** Run — FAIL (route not present).
- [ ] **Step 3:** Implement the route + the two wirings. Hoist literals.
- [ ] **Step 4:** Full control-plane suite + both tscs green.
- [ ] **Step 5:** Commit `feat: tenant-plane POST /environments (create in own hive) + wire in-cluster runtime`.

---

### Task 4: Gated live smoke — create an env in-cluster via the tenant path

**Files:**
- Create: `admin/control-plane/in-cluster-env-create-smoke.ts` (gated; run via `npx tsx`, not in the test glob)

**Interfaces:**
- Consumes everything above. Models `k8s-hive-smoke.ts` for the cluster harness (kubectl context `docker-desktop`, the existing `pragmatic-server:dev` image already loaded in the kind node). Drives the real `EnvironmentService` in-process (via tsx) with the `InClusterEnvironmentRuntime` wired, a `SeededTenantDirectory` providing one Local/Attach hive, and the real `HiveOrchestratorFactory`/`EnvironmentPlacement`.

- [ ] **Step 1:** Write the smoke: (a) `Create` a dev-blank env bound to the seeded k8s hive → asserts the workload is applied and the env-server Deployment reaches rollout-Ready (reuse the throwaway boot-config approach from `k8s-hive-smoke.ts:245-249` — this is the documented SP-HIVE-3 limitation, not a product bug); (b) `List`/`ToDto` returns a DNS endpoint, not `http://localhost:0`; (c) `Delete` tears down the namespace; (d) a second `Create` of the same name after delete succeeds (no collision). Print PASS/FAIL per step and an OVERALL line; exit non-zero on any FAIL.
- [ ] **Step 2:** Run it live against docker-desktop k8s: `npx tsx admin/control-plane/in-cluster-env-create-smoke.ts`. Capture output. If the env-server cannot reach Ready purely because of the deferred SP-HIVE-3 boot-config contract (not because of this slice's code), re-scope the readiness assertion to "Deployment accepted + pods scheduled" and record the limitation in the smoke header + the ledger (ruling), rather than block.
- [ ] **Step 3:** Commit `test: gated in-cluster env-create smoke (orchestration-level)`.

---

## Self-Review Notes

- **Spec coverage:** Tasks 1-3 implement "in-cluster EnvironmentService orchestration adapter + tenant-plane create route"; Task 4 proves it live. The served-env boot/secret contract + Federate-in-cluster are explicitly deferred (Scope boundary) and filed as Features.
- **Type consistency:** `IEnvironmentRuntime`/`EnvEndpoint`/`EnvRuntimeContext` defined in Task 1 are consumed unchanged by Tasks 2-3; the resolver signature in Task 2 matches its use in `EnvironmentService`.
- **Proportion:** the plan fixes the seam signatures and the create-route contract (the decisions) and defers handler/runtime bodies to the implementer reading the existing Docker calls and `k8s-hive-smoke`/`HiveHealthProducer` patterns it mirrors.
- **Review Focus:** behavior-preservation (Task 1 suite), runtime selection (resolver tests), cross-tenant create (route test), secret non-leakage (in-cluster error test), teardown (teardown test + smoke recreate) — each tied to a task's tests.
