# SP-HIVE-3 In-cluster env-server boot config & secret injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-cluster environment boots its `pragmatic-server:dev` pod as a correctly-configured tenant — tenants.json via ConfigMap, master key + provisioned secrets via k8s Secrets, base dir via PVC — with no plaintext secret env var.

**Architecture:** Reuse `BundleBuilder` to generate a durable host bundle control-plane-side (create-if-absent). An `EnvServerSeedSource` reads the bundle and yields a tenants ConfigMap manifest (plain) and an `EnvServerSecretSet` (master key + provisioned-secrets + optional db pw) that exits bytes only through `RenderManifest()` — mirroring P4's `InClusterIdpSeedSource`/`IdpSecretSet`. `K8sManifestBuilder.ServerDeployment` wires the env vars, volume mounts, volumes and a base-dir PVC by name only. `InClusterEnvironmentRuntime.Prepare` generates the bundle; `BringUp` applies the workload (creating the namespace) then applies the ConfigMap + Secrets — the exact ordering P4 uses.

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`, kubectl via `IKubectl`, docker-desktop k8s for the gated smoke.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-3-in-cluster-boot-config-secret-injection-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state.
- Allman braces; no inline string literals (hoist to `private static readonly` PascalCase).
- PascalCase interfaces + public methods.
- **Secret-safety (verbatim):** master key / provisioned-secret / db-password bytes held by name only — NEVER in logs, DTOs, errors, thrown messages, the `EnvironmentWorkload`, the environment record, or any non-Secret manifest. Values exit only through `EnvServerSecretSet.RenderManifest()` into a k8s `Secret`. Redact `toJSON`/`toString`.
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root.
- LF-only line endings. Co-author trailer on commits.
- The Docker (host-port, `PublishesHostPort()===true`) path stays byte-identical.

## Review Focus

1. **Master-key / admin-password stability across re-Apply** — the bundle is create-if-absent, so a re-Apply must project the SAME values; a rotation loses all encrypted data and breaks admin login. (Task 1 test: second `EnvServerSeedSource` over the same bundle yields byte-identical secret manifests. Task 3 test: `Prepare` twice does not rewrite master.key.)
2. **Secret non-leakage** — bytes never in `toJSON`/`toString`/errors/DTO/record/non-Secret manifest. (Task 1 test: `toJSON`/`toString` redacted, only `RenderManifest()` surfaces bytes; Task 3 test: a forced apply failure's error carries no secret.)
3. **DB-password single value** — the one bundle-generated DB password is identical in the postgres Secret (`<ref>` key `password`) and in provisioned-secrets.json. (Task 1 test.)
4. **Docker path unchanged** — in-cluster-only injection keyed off `PublishesHostPort()`. (Task 2 test: a Docker-backed render carries no new env/volumes.)
5. **Name scoping** — ConfigMap/Secret names are environment-scoped and match the Deployment's refs exactly; the namespace is per-env so names are stable within it. (Task 2 test: rendered Deployment volume refs equal the seed objects' metadata.name.)

---

## Task 1: EnvServerSeedSource + EnvServerSecretSet

**Files:**
- Create: `admin/control-plane/env-server-seed.ts`
- Test: `admin/control-plane/tests/env-server-seed.test.ts`
- Reference: `admin/control-plane/in-cluster-idp-seed.ts` (the P4 pattern to mirror), `environments/seed/bundle.ts` (bundle file names).

**Interfaces:**
- Consumes: a bundle directory produced by `BundleBuilder.Generate` (files `master.key`, `provisioned-secrets.json`, `tenants.json`), the environment name, and the optional db password ref.
- Produces:
  - `EnvServerSeedSource` with `ConfigMapManifest(): K8sObject` (the tenants ConfigMap, data key `tenants.json` = the file text) and `SecretSet(): EnvServerSecretSet`.
  - `EnvServerSecretSet` with `Add(...)` (defensive-copies buffers), `RenderManifest(): K8sObject[]` (one or more `v1 Secret` objects, `type: Opaque`, `data` base64), and redacted `toJSON()`/`toString()`. Secret names: a master/provisioned Secret `<env>-env-secrets` (keys `master.key`, `provisioned-secrets.json`) and — when a db password is present — the postgres Secret `<ref>` (key `password`) carrying the SAME value `DatabaseStatefulSet` consumes.

- [ ] **Step 1: Write failing tests** — (a) `toJSON()`/`toString()` of a populated `EnvServerSecretSet` contain none of the secret bytes (assert a known sentinel value is absent, a redaction marker present); (b) `RenderManifest()` emits Secret object(s) whose `data['master.key']`/`data['provisioned-secrets.json']` base64-decode to the bundle bytes; (c) the db-password value in the postgres Secret equals the `provisioned-secrets.json` entry for that ref; (d) `ConfigMapManifest()` carries `tenants.json` as plain (non-base64) data and is a `ConfigMap` kind; (e) two independent `EnvServerSeedSource` instances over the same bundle render byte-identical Secret manifests.
- [ ] **Step 2: Run tests — expect fail** (`npx tsx --test admin/control-plane/tests/env-server-seed.test.ts`).
- [ ] **Step 3: Implement `env-server-seed.ts`** mirroring `in-cluster-idp-seed.ts` (bytes in `#private`, defensive copy in `Add`, redacted serializers, `RenderManifest` only). Read the three bundle files; parse `provisioned-secrets.json` to pull the db-password value for the ref.
- [ ] **Step 4: Run tests — expect pass.**
- [ ] **Step 5: Commit.**

## Task 2: Manifest wiring (ServerDeployment env/mounts/volumes/PVC) + workload refs

**Files:**
- Modify: `admin/control-plane/environment-workload.ts` (name-only ref fields), `admin/control-plane/k8s-manifest-builder.ts` (`ServerDeployment` env + mounts + volumes + base-dir PVC; constants for the five env var names and the three fixed mount paths).
- Test: `admin/control-plane/tests/k8s-manifest-builder.test.ts` (extend existing if present, else create under `tests/`).

**Interfaces:**
- Consumes: `EnvironmentWorkload` (gains `tenantsConfigMap?`, `envSecretName?`, `baseDirMount?` — NAMES/paths only, populated only for in-cluster). Consumes the Secret/ConfigMap names Task 1 defines (keep the name scheme in one shared constants home referenced by both Task 1 and Task 2).
- Produces: a `ServerDeployment` whose container carries exactly `PRAGMATIC_BASE_DIR`, `PRAGMATIC_TENANTS_FILE`, `PRAGMATIC_MASTER_KEY_FILE`, `PRAGMATIC_PROVISIONED_SECRETS_FILE`, `PRAGMATIC_DEPLOYMENT_MODE` (plus existing `PRAGMATIC_PORT`), three `volumeMounts` (config, secrets, data) and matching `volumes` (ConfigMap, Secret, PVC).

- [ ] **Step 1: Write failing tests** — (a) an in-cluster workload renders a ServerDeployment carrying the five env vars with the fixed mount-path values, and `volumes` referencing the ConfigMap + Secret by the Task-1 names and a base-dir PVC; (b) a Docker-backed workload (`PublishesHostPort()===true`) renders a ServerDeployment with ONLY `PRAGMATIC_PORT` and no new volumes (byte-identical to today).
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the env/mount/volume/PVC additions in `ServerDeployment`, gated so they appear only for the in-cluster workload (name refs present). Hoist env-var names and mount paths to constants. Keep ordering stable.
- [ ] **Step 4: Run tests — expect pass.**
- [ ] **Step 5: Commit.**

## Task 3: InClusterEnvironmentRuntime Prepare + BringUp apply

**Files:**
- Modify: `admin/control-plane/in-cluster-environment-runtime.ts` (`Prepare` generates the bundle via `BundleBuilder.Generate` under the ctx data root, create-if-absent; `BringUp` applies the workload via the orchestrator, then applies the ConfigMap + Secret manifests via the orchestrator's `Kubectl`).
- Test: `admin/control-plane/tests/in-cluster-environment-runtime.test.ts` (extend existing).
- Reference: `admin/control-plane/in-cluster-idp-driver.ts` (applies seed Secrets after the workload apply, before rollout wait — mirror this ordering).

**Interfaces:**
- Consumes: `EnvServerSeedSource` (Task 1), the workload name refs (Task 2), the orchestrator's `Kubectl` handle, `EnvRuntimeContext` (record + data root).
- Produces: a BringUp that leaves the namespace holding the Deployment/Service (+DB) AND the tenants ConfigMap + env Secret (+ db Secret) before WaitHealthy.

- [ ] **Step 1: Write failing tests (fake `IKubectl` + fake orchestrator)** — (a) `Prepare` generates a bundle (master.key/provisioned-secrets.json/tenants.json exist) and a second `Prepare` does NOT rewrite master.key (durability); (b) `BringUp` applies the workload first, then a manifest containing the ConfigMap + Secret objects whose names equal the Deployment's volume refs; (c) a kubectl-apply failure surfaces the existing named `InClusterEnvironmentError` with NO secret bytes or stderr in the message.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** `Prepare` (bundle generate) and `BringUp` (workload apply → seed apply) using the P4 ordering; route the db password ref from the workload into the seed source. Guard errors as the file already does (no stderr/secret).
- [ ] **Step 4: Run tests — expect pass.** Then run the full control-plane unit suite + `tsc` (tools, tenant-admin, build, portal) and confirm green.
- [ ] **Step 5: Commit.**

## Task 4: Promote k8s-hive-smoke to the real injection (operator-run live smoke)

**Files:**
- Modify: `admin/control-plane/k8s-hive-smoke.ts` (delete the LOCAL-SMOKE-ONLY `BootEnv`/plaintext master key; the environment now reaches Ready from the injected ConfigMap/Secrets). Add: authenticate the bootstrapped admin over the tenant WS using the provisioned admin password read from the generated bundle; assert a re-Apply keeps the same master key (durability).

**Interfaces:**
- Consumes: the real in-cluster Prepare/BringUp from Task 3.
- Produces: a gated smoke proving boot-from-injected-config end to end. NOT part of `tsx --test`; operator-run on docker-desktop.

- [ ] **Step 1: Rewrite** the smoke to create a dev-blank in-cluster environment through the real `InClusterEnvironmentRuntime` (Prepare + BringUp), drive Apply → WaitHealthy → `/healthz`, authenticate the admin, re-Apply and assert master-key stability, then Teardown (namespace NotFound).
- [ ] **Step 2: Operator runs** `npx tsx admin/control-plane/k8s-hive-smoke.ts` against docker-desktop; expect all checks PASS. (Controller runs this; a subagent cannot reach the cluster.)
- [ ] **Step 3: Commit.**

---

## Self-Review

- **Spec coverage:** every design component (seed source, secret-set, manifest wiring, runtime Prepare/BringUp, smoke) maps to a task. Scope-out (heavy seed) is explicit; no task touches it.
- **Step scan:** each step writes one reasonable thing; tests carry concrete assertions.
- **Type consistency:** the ConfigMap/Secret name scheme is defined once (Task 1) and referenced by Task 2's render and Task 3's assertions — keep the names in one shared constants home to avoid drift.
- **Review Focus:** all five pinned to Task tests (durability 1+3, non-leakage 1+3, db-pw 1, Docker-unchanged 2, name-scoping 2).
- **Proportion:** plan carries decisions + test assertions, not code bodies.
