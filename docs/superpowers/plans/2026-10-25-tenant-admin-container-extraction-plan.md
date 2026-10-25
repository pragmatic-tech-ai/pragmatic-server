# Tenant-Admin Container Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the tenant-admin backend out of `ControlPlaneServer` into its own standalone, separately-deployable server that OWNS its tenant-scoped data (environments, tenant sessions, tenant-admin OIDC, the per-tenant IdP), while the platform (operator) plane keeps the global directory, registry, gating/selection, and the agent channel. The deliverable is the `admin/tenant-portal` SPA served by a standalone tenant-admin entrypoint, with the local dev stack still collapsed to one `dev-up`.

**Architecture:** The tenant plane is already factored (`ComposeTenantPlane`) but shares in-process objects with the operator over one data root. This plan draws seam interfaces between the tenant plane and the platform-global data it only READS (`ITenantDirectory`, `IRolloutClient`), gives the tenant plane its own composition root + data root + master key, moves the one cross-boundary WRITE (target adoption) to an up-call over the existing `AgentChannelHost`, makes the per-tenant IdP driver pluggable (docker for dev, in-cluster for the hive), reports health UP the channel, and severs the operator plane's tenant-scoped routes. In collapsed dev both run in one process over in-process adapters; deployed, the tenant admin is its own container seeded by a client-applied bootstrap.

**Tech Stack:** TypeScript, `node:http`, `JsonRecordStore`, the existing `tenant-auth/` + `tenant-api/` modules, `AgentChannelHost`, `IdpService`/`IDockerExec` seam, `K8sManifestBuilder`. Unit tests under `admin/control-plane/tests/` and `admin/tenant-portal/`; run control-plane with `npx tsx --test "admin/control-plane/tests/*.test.ts"`, typecheck `npx tsc -p tsconfig.tools.json --noEmit`. Gated smokes run via `npx tsx <path>` against Docker Desktop Kubernetes and need a rebuilt `pragmatic-server:dev` loaded into the kind node.

**Spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md`. Third sub-project plan of the split (after the agent channel + the in-hive agent).

## Global Constraints

- OOP only (behavior on classes; no module-level free functions or mutable module state; `const`/`type`/`enum`/`interface` at module scope fine).
- Allman braces everywhere; `else`/`catch`/`finally` on their own line. Object literals / block-arrow bodies / one-liners stay inline.
- No inline string literals: hoist reused/meaningful literals (env-var names, paths, route segments, label keys, messages) to `private static readonly` PascalCase constants.
- PascalCase for every interface name and public method. New seam interfaces are real interfaces, not lambda bags.
- Secrets by name only: master keys, the agent token, IdP admin tokens, OIDC client secrets, and inner-error text never appear in logs, DTOs, thrown messages, or persisted records.
- The tenant layer must not import operator-only or platform-global-only concerns it doesn't need; the seam interfaces it depends on are the contract.
- Tests in `tests/` subfolders. Never `npm install` at the repo root. `git add` explicit paths only (untracked `dev/` stays untracked).

## Resolved decisions (controller rulings on the recon's open items)

- **Home-channel transport:** generalize the existing HTTP pull-agent surface on `AgentChannelHost`; provide an `IRolloutClient` with an in-process adapter (collapsed dev) and an HTTP adapter (deployed). No new persistent-socket protocol in this slice.
- **Agent vs tenant-admin process boundary:** two separate in-hive workloads — the rollout agent (already shipped) stays its own Deployment; the tenant-admin backend is its own container. No merging.
- **Adoptable-version representation:** query-on-demand over the channel (no hive-side mirror/cache in this slice).
- **Bootstrap packaging:** a plain k8s manifest set (consistent with `RenderHiveAgent`), not Helm.
- **Per-tenant master key:** minted by the platform during bootstrap generation and seeded into the container as a secret (same custody model as the agent token); the container never derives it from operator state.
- **`registry.json` ownership:** each tenant container owns its OWN `registry.json` (its hive's environments only); the operator plane stops owning environments. Pre-release, so no migration of existing global data — fresh per-container store.
- **`GraphService` / operator graph view:** OUT OF SCOPE for this slice — left on the operator unchanged (it currently needs tenant env admin creds; relocating it is a later decision). Do not touch it.
- **Repo layout:** one repo, two entrypoints (the standalone tenant-admin entrypoint lives beside `server.ts`); not a separate package.

## Review Focus

- **Cross-tenant isolation:** with the tenant container scoped to one tenant+hive, a request/host for a different tenant must 403/404 and never reach another tenant's data — the endpoint's `tenantId` filter becomes structural but must still reject mismatches. (Tasks 2, 3.)
- **The adopt up-call keeps gating platform-side:** a tenant adopting a non-gated version must be refused by the platform's gating check, not silently applied locally. (Task 4.)
- **No secret seeded into the container leaks back out:** the master key, IdP admin token, and OIDC client secret never appear in any response/log/DTO. (Tasks 3, 5.)
- **Operator can no longer mutate tenant-owned resources:** after Task 7 the operator API has no env-create/lifecycle, no per-env identity admin, no tenant target-select route. (Task 7.)
- **A tenant container with no cluster reachability** (IdP down, channel down) fails closed with a clear status, not a crash or a hang. (Tasks 4, 5, 6.)

---

### Task 1: Seam interfaces for the tenant plane's platform reads

**Files:** Create `admin/control-plane/tenant-api/tenant-directory.ts` (`ITenantDirectory`), `admin/control-plane/tenant-api/rollout-client.ts` (`IRolloutClient`); modify `tenant-host-resolver.ts`, `tenant-api/tenant-api-endpoint.ts`, `tenant-auth/tenant-oidc-relying-party.ts`, `environment-placement.ts`, `hive-health-producer.ts` to depend on the interfaces. Test: extend the existing tests of those modules.

**Interfaces:**
- `ITenantDirectory` — `GetTenant(id): TenantRecord | undefined`, `GetHive(id): HiveRecord | undefined`, `ListHives(tenantId): readonly HiveRecord[]` (the exact subset the tenant plane reads; `PlatformDirectory` already satisfies it structurally).
- `IRolloutClient` — `ManifestsFor(tenantId): …`, `StatusFor(hiveId): HiveRolloutStatus`, `AdoptTarget(hiveId, version): Promise<void>` (rename of the tenant's use of `SelectTarget`; `PlatformDeploymentRegistry` satisfies it in collapsed dev).
- Produces: the same runtime behavior; this is a pure retarget onto interfaces.

- [ ] Step 1: Write failing tests asserting the tenant modules compile/run against the narrow interfaces (construct them with hand-written fakes implementing only the interface).
- [ ] Step 2: Run, verify fail. Step 3: Introduce interfaces + retarget. Step 4: full control-plane suite + `tsc` green. Step 5: Commit (`refactor: tenant plane depends on ITenantDirectory/IRolloutClient seams`).

### Task 2: Single-tenant seeded directory view

**Files:** Create `admin/control-plane/tenant-api/seeded-tenant-directory.ts`; Test: `admin/control-plane/tests/seeded-tenant-directory.test.ts`.

**Interfaces:**
- Consumes: Task 1 `ITenantDirectory`, `TenantRecord`/`HiveRecord`.
- Produces: `SeededTenantDirectory` built from a startup config (`{ tenant: TenantRecord; hives: HiveRecord[] }`) answering ONLY for that one tenant+hive; `GetTenant`/`GetHive` for any other id return `undefined`; `ListHives` returns only the seeded hive(s).

- [ ] Steps: failing test (seeded tenant resolvable; foreign tenant/hive → undefined) → run fail → implement → green → Commit (`feat: single-tenant seeded directory view`).

### Task 3: Standalone tenant-admin server + entrypoint

**Files:** Create `admin/control-plane/tenant-admin-server.ts` (`TenantAdminServer`), `src/bin/pragmatic-tenant-admind.ts` (thin entrypoint). Modify `server.ts` (keep the collapsed path working). Test: `admin/control-plane/tests/tenant-admin-server.test.ts` (compose + port/config parsing, no live boot).

**Interfaces:**
- Consumes: `ComposeTenantPlane`, `TenantPlaneHost`, `SeededTenantDirectory` (Task 2), its own `MasterKeyFile` under its own dataRoot.
- Produces: `TenantAdminServer` with its OWN dataRoot (own `registry.json`/`tenant-sessions.json`/`tenant-admin-clients.json`/`tenant-admin-oidc/`/`idps.json`/`master.key`), reading the directory from the seeded view, and a `Run()` that boots `TenantPlaneHost` + the health monitor. Env: `PRAGMATIC_TENANT_ADMIN_TENANT_ID`, `_HIVE_ID`, `_DISPLAY_NAME`, `_DATA_ROOT`, plus the existing base-domain/scheme/port/bind vars. `ControlPlaneServer.Main` still composes the collapsed dev path.

- [ ] Steps: failing test (config parsing + composition wiring with fakes) → run fail → implement → full suite + `tsc` green → Commit (`feat: standalone tenant-admin server + entrypoint`). Flag: real boot acceptance is Docker-gated (Task 8).

### Task 4: Rollout adopt up-call over the channel

**Files:** Modify `agent-channel-host.ts` (add adoptable-list + adopt routes), create `admin/control-plane/tenant-api/http-rollout-client.ts` + an in-process adapter; modify `platform-deployment-registry.ts` if needed for `AdoptTarget` semantics. Tests: `admin/control-plane/tests/agent-channel-host.test.ts`, a new adapter test.

**Interfaces:**
- Produces: `GET /agent/hives/:id/adoptable` → the gated∩published version list; `POST /agent/hives/:id/adopt {version}` → runs the platform gating check + writes `selections.json` (no local push — the hive rolls locally via the agent); both bearer-authed like the existing agent routes. `HttpRolloutClient implements IRolloutClient` calling these; an in-process adapter for collapsed dev.
- Review focus: a non-gated version adopt → platform refuses (403), writes nothing.

- [ ] Steps: failing tests (adoptable list; adopt gated → 200 + selection written; adopt non-gated → 403 nothing written; bearer enforced) → run fail → implement → suite + `tsc` green → Commit (`feat: rollout adopt up-call on the agent channel`).

### Task 5: Pluggable IdP driver (docker for dev, in-cluster for the hive)

**Files:** Modify `idp-service.ts`/`idp-container-env.ts` to make the launch driver a seam (`IIdpWorkloadDriver`), add an in-cluster driver (via `K8sManifestBuilder` + the in-cluster API), keep the docker driver for dev. Tests: extend idp-service tests with a fake driver.

**Interfaces:**
- Produces: `IIdpWorkloadDriver` (`EnsureRunning(tenantId, …): Promise<{ baseUrl, caRef, adminTokenRef }>`); `DockerIdpDriver` (today's `docker run` path) and `InClusterIdpDriver` (hive workload + in-cluster service DNS baseUrl); `idpAdminTokenRef`/`idpCaRef` seeded from bootstrap in the in-cluster case.
- Review focus: no admin token / CA material in logs or errors.

- [ ] Steps: failing test (service uses the injected driver; fake driver returns connection info; secrets not logged) → run fail → implement → suite + `tsc` green → Commit (`feat: pluggable IdP workload driver`). Flag: in-cluster driver acceptance is Docker/kind-gated (Task 8).

### Task 6: Health reported UP the channel

**Files:** Modify `tenant-health-monitor.ts`/the tenant container wiring to POST snapshots via the channel (`AgentChannelHost` `ReportSnapshot` path / `HttpRolloutClient` sibling) in addition to the in-process `TenantEventBus`. Test: a reporter unit test with a fake channel.

**Interfaces:**
- Produces: the tenant container's health monitor produces `HiveHealthDto[]` locally and reports it up (the platform's observation read-model, already built, receives it). In collapsed dev the in-process path still feeds the event bus for the SPA's live view.

- [ ] Steps: failing test (monitor tick → one snapshot posted up with all envs) → run fail → implement → suite + `tsc` green → Commit (`feat: tenant health reported up the channel`).

### Task 7: Sever operator-side tenant mutations

**Files:** Modify `control-plane-host.ts` (remove env create/start/stop/logs/delete, the per-env identity admin-proxy routes, and the tenant `SelectTarget` route; keep directory CRUD, manifest publish/withdraw, gate/ungate, rollout status read + hive registration); modify `server.ts` to stop constructing `EnvironmentService`/`IdpService` for the operator; split `TenantProvisioningService` into platform bootstrap-generation vs in-hive seeding; update `admin/portal`. Tests: update the affected control-plane-host tests.

**Interfaces:**
- Produces: an operator API with NO tenant-owned mutation surface. Provisioning becomes `GenerateBootstrap(tenantId, hiveId, …)` on the platform (mints agent token + per-tenant master key + pull cred ref + emits the directory read-models + IdP secret refs); the owner-account/realm seeding moves into the in-hive path.
- Review focus: confirm no orphaned operator route still mutates tenant data; the operator cannot reach into a tenant.

- [ ] Steps: failing tests (old operator tenant-mutation routes gone; bootstrap-generation returns the seed payload) → run fail → implement → suite + `tsc` green → Commit (`feat: sever operator-side tenant mutations; bootstrap generation`).

### Task 8: Package the tenant-admin container + bootstrap artifact; live smoke

**Files:** Create a `RenderTenantAdmin(...)` manifest in `k8s-manifest-builder.ts` (Deployment serving the `tenant-portal` dist from the standalone entrypoint + its seeded config/secrets), extend the bootstrap artifact to stand up agent + tenant-admin + IdP with seeded data, and add/extend a gated smoke proving a tenant-admin container serves and adopts in-cluster. Modify the Dockerfile if the entrypoint needs wiring.

**Interfaces:**
- Produces: a bootstrap manifest set carrying the agent token, pull-only registry credential, trust-root public key, IdP secret refs, per-tenant master key, and the directory read-models; `RenderTenantAdmin` renders the container + its RBAC/secrets. Acceptance: a gated smoke (needs Docker/kind + rebuilt `:dev`) brings a tenant-admin container up in-cluster, logs in, creates an env, and adopts a version.

- [ ] Steps: render-manifest unit tests green + `tsc`; then the controller rebuilds `:dev`, loads it into the kind node, and runs the gated smoke to green. Commit (`feat: tenant-admin container + bootstrap; live smoke green`).

> **Verification note:** Tasks 1-7 are unit-testable + model-verifiable with no cluster and must leave `tsc` + the unit suites green at each step. Tasks 3, 5, 8 have Docker/kind-gated acceptance; the controller runs those smokes (rebuild `pragmatic-server:dev`, load into the kind node). The branch merges only after the Task 8 live smoke passes. This is a large slice — if execution needs to pause, every task through 7 is independently green and the Docker-gated tail can run when the cluster is available.
