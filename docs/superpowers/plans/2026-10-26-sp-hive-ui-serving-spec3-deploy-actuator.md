# Per-env Carrier + Deploy Actuator + Pod-side Unpack (Spec 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Specs 1+2 into a real deploy: a control-plane actuator builds/pushes/signs an app's UI artifact and records it on the env, and an init container on the env pod pulls, verifies (pod-side), and unpacks it before the server starts.

**Architecture:** The per-env carrier folds onto `EnvironmentRecord` as an optional `appDeployment` field (one served app per env for v1), flowing through `EnvironmentWorkloadFactory` into a `WorkloadAppDeployment` on `EnvironmentWorkload` and thence into the rendered Deployment — exactly as `idpBaseDomain?`→`WorkloadFederation` already does. The pod-side pull/verify/unpack runs as a new bin `admin/control-plane/bin/pragmatic-ui-unpack.ts`, which ships in the image's `dist-tenant-admin/` tree and so can import `OciRegistryClient`/`UiArtifact`/`UiArtifactVerifier` directly (the server `dist/` cannot reach them; the control-plane tree can). The actuator lives where kubectl+registry+trust-root are reachable — the `KubectlHiveOrchestrator` (which already holds `KubectlCli`, `K8sManifestBuilder`, `EffectiveRegistry`, the verifier, and `trustRootRef`), fronted by an `EnvironmentService.DeployAppToEnvironment` method. The integrity model: the env-spec `manifestDigest` is the trusted anchor (delivered over the k8s API); the pod independently (1) pins the fetched manifest's computed digest to it and (2) verifies the Ed25519 signature — pulled as a **companion artifact from the untrusted registry** — over `{appName,appVersion,manifestDigest}` against a per-env-mounted trust-root public key. Both checks fail closed.

**Tech Stack:** TypeScript (Node), `node:crypto`, `fetch`, `kubectl`, the Spec-1/2 classes (`InClusterRegistry`, `OciRegistryClient`, `UiArtifact`, `UiArtifactSigner`/`UiArtifactVerifier`), `FileKeyStore`. No new npm dependency; no new binary in the pod (the unpack bin is plain Node).

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-in-cluster-app-ui-serving-design.md` (§6.3 signing/verify, §6.4 carrier+actuator, §6.6 init container; §7 Spec 3). Builds only Spec 3.

## Global Constraints

- OOP, Allman braces, PascalCase public members/interfaces, no inline string/number literals (hoist). LF endings. NodeNext ESM `.js` import specifiers. Never `npm install` at repo root. Uint8Array (not Buffer) in public APIs where Spec 2 established it.
- Secrets/keys/tokens/signatures/inner-error-text held by name only — never in logs, DTOs, thrown messages, or persisted records. The per-env trust Secret carries only the PUBLIC key (never the private signing key; never the IdP server key).
- Admin tests in `admin/control-plane/tests/`. Type gates: `npx tsc -p tsconfig.tools.json --noEmit` and `-p tsconfig.tenant-admin.json --noEmit`; for `src/` changes also `npm run build`. Admin test runner: `npx tsx --test admin/control-plane/tests/<file>.test.ts`.
- Pinned shapes/values: registry pull base `InClusterRegistry.PullBase()`; the UI repo name for an app is `<tenant>/<appName>` (lowercased per OCI repo grammar — hoist the scheme); signature companion tag = `<artifact-tag>.sig`; the trust Secret is `<env>-ui-trust` with data key `<trustRootRef>.pub`; the signing/trust keypair is the hive's `trustRootRef` (private `.key` signs on the control plane, public `.pub` verifies pod-side).
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Never merge/push without explicit instruction.

## Review Focus

- **Pod-side verification fails closed on every tampering path.** A manifest whose computed digest ≠ the env-spec digest, a bad/absent signature, a missing trust key, or a signature over a different app/version must ALL abort the unpack with a non-zero exit (init container fails → pod does not serve new UI). → Task 2 asserts each path exits non-zero and does not write the version tree / flip the pointer.
- **The signature must come from the registry, not the env spec.** If the signature travelled the same trusted channel as the digest, it would not defend against env-spec tampering. → Task 2/Task 5 keep the signature a companion artifact pulled from the registry; the digest comes from env spec. A review check confirms the two sources are distinct.
- **An env with no app deployment renders unchanged.** Adding the carrier must not alter the manifest for envs without `appDeployment`. → Task 3 asserts the rendered Deployment is byte-identical (no extra init container / volume / env) when `appDeployment` is absent.
- **Rollout-restart actually re-runs the init container.** A redeploy must cause the pod to re-pull. → Task 4 asserts `RolloutRestart` issues `kubectl rollout restart deployment/<d> -n <ns>`; Task 5 calls it after recording.
- **The trust Secret never carries private material.** → Task 4 asserts the projected Secret contains only `<trustRootRef>.pub` (public key), never a `.key`.

---

### Task 1: Per-env carrier — `EnvironmentRecord.appDeployment` → `WorkloadAppDeployment`

**Files:**
- Modify: `admin/control-plane/environment-record.ts` (add optional field)
- Modify: `admin/control-plane/environment-workload.ts` (add `WorkloadAppDeployment` + field)
- Modify: `admin/control-plane/environment-workload.ts` `EnvironmentWorkloadFactory.From` (map record→workload)
- Test: `admin/control-plane/tests/environment-workload.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `type AppDeployment = { appName: string; appVersion: string; repo: string; artifactTag: string; manifestDigest: string }` added as optional `appDeployment?: AppDeployment` on `EnvironmentRecord`. `type WorkloadAppDeployment = { appName: string; appVersion: string; registryPullBase: string; repo: string; artifactTag: string; manifestDigest: string; trustSecretName: string; trustKeyRef: string }` on `EnvironmentWorkload` as optional `appDeployment?`. `EnvironmentWorkloadFactory.From(record, hive)` sets `workload.appDeployment` from `record.appDeployment` when present, filling `registryPullBase = InClusterRegistry.PullBase()`, `trustSecretName = <env>-ui-trust` (a new `EnvServerSeedSource.UiTrustSecretNameOf(name)` helper mirroring `IdpCaSecretNameOf`), and `trustKeyRef = hive.trustRootRef`. Consumed by Tasks 3 and 5.

- [ ] **Step 1: Write the failing test** — `EnvironmentWorkloadFactory.From` maps a record with `appDeployment` into a workload whose `appDeployment` carries the record's app fields plus `registryPullBase === InClusterRegistry.PullBase()`, `trustSecretName === UiTrustSecretNameOf(name)`, `trustKeyRef === hive.trustRootRef`; and a record WITHOUT `appDeployment` yields `workload.appDeployment === undefined`.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** the two types + the factory mapping + the `UiTrustSecretNameOf` helper (hoist the `-ui-trust` suffix constant next to `IdpCaSecretNameSuffix`).
- [ ] **Step 4: Run it, verify it passes; both type-gates clean.**
- [ ] **Step 5: Commit** — `feat: per-env app-deployment carrier on EnvironmentRecord/Workload`.

---

### Task 2: Pod-side unpack bin `pragmatic-ui-unpack`

**Files:**
- Create: `admin/control-plane/bin/pragmatic-ui-unpack.ts`
- Create: `admin/control-plane/ui-unpacker.ts` (the testable class the bin wraps)
- Test: `admin/control-plane/tests/ui-unpacker.test.ts`

**Interfaces:**
- Consumes: `OciRegistryClient` (pull manifest/blob), `UiArtifact.Unpack`/`ManifestDigestOf`, `UiArtifactVerifier.Verify`, `IStorage` (the data PVC), `IKeyStore` (`FileKeyStore` at the mounted trust dir).
- Produces: `class UiUnpacker` ctor `(client: OciRegistryClient, verifier: UiArtifactVerifier, storage: IStorage)`. `Reconcile(input: UiUnpackInput): Promise<void>` where `type UiUnpackInput = { repo: string; artifactTag: string; sigTag: string; expectedManifestDigest: string; appName: string; appVersion: string; trustRootRef: string }`. Reconcile: pull manifest; compute `ManifestDigestOf` and require `=== expectedManifestDigest` (throw `UiUnpackError` on mismatch); read the config + layer descriptors from the manifest; pull the layer blob and the signature companion artifact (pull its manifest → its layer = the base64 signature); `verifier.Verify(appName, appVersion, expectedManifestDigest, signature, trustRootRef)`; only then `UiArtifact.Unpack` the layer and write each file under `<appName>/<appVersion>/ui/<rel>` and the config-derived `application.json` under `<appName>/<appVersion>/`, then write the `<appName>/live` pointer (the Spec-2 layout). Idempotent: if `<appName>/live` already names `appVersion` AND the version tree exists, no-op; else (re)write pointer after ensuring the tree. The bin `pragmatic-ui-unpack.ts` reads the `UiUnpackInput` fields + the data dir + the trust-dir from argv/env, constructs `OciRegistryClient(registryPullBase)`, `new UiArtifactVerifier(new FileKeyStore(trustDir))`, `NodeFsStorage(dataDir)`, runs `Reconcile`, and sets a non-zero exit on any throw.

- [ ] **Step 1: Write the failing tests** against `UiUnpacker` with an in-memory `OciRegistryClient` fake (inject a fake `OciFetch`, or construct a fake client exposing the same pull methods — prefer a fake `OciFetch` serving a canned registry) and a `FakeStorage`/temp `NodeFsStorage`, plus a real Ed25519 keypair in a temp `FileKeyStore`:

```ts
test('Reconcile pulls, verifies, unpacks the version tree and flips the live pointer', async () => { /* happy path: files land under app/version/ui, application.json written, app/live === version */ })
test('a manifest whose computed digest != the expected digest aborts and writes nothing', async () => { /* throws UiUnpackError; no app/version tree; no live pointer change */ })
test('a bad signature aborts and writes nothing', async () => {})
test('a signature over a different appVersion aborts (identity binding)', async () => {})
test('a missing trust key aborts', async () => {})
test('an already-unpacked current version is a no-op', async () => {})
```

- [ ] **Step 2: Run them, verify they fail.**
- [ ] **Step 3: Implement `UiUnpacker` then the thin `pragmatic-ui-unpack.ts` bin.** The bin is argv/env parsing + wiring only; all logic is in `UiUnpacker` (testable). Verify digest-pin BEFORE signature, both before any write; writes go version-tree-first then the `live` pointer (Spec-2 ordering). Hoist all arg/env names + error messages.
- [ ] **Step 4: Run tests, verify pass; both type-gates clean; confirm the bin is NOT under `tests/` and imports no `node:test`.**
- [ ] **Step 5: Commit** — `feat: pod-side UI unpacker (pull+verify+unpack) + bin`.

---

### Task 3: Render the unpack init container + trust mount + registry env

**Files:**
- Modify: `admin/control-plane/k8s-manifest-builder.ts` (`ServerDeployment`: add the unpack init container + trust Secret volume/mount + env when `workload.appDeployment`; also drop the `pragmatic/hive` label from the shared registry objects — the Spec-1 carried TODO)
- Test: `admin/control-plane/tests/k8s-manifest-builder-ui-unpack.test.ts` (new)

**Interfaces:**
- Consumes: `WorkloadAppDeployment` (Task 1), `InClusterRegistry` (bin image path constant for the unpack entrypoint).
- Produces: when `workload.appDeployment` is set, `ServerDeployment` gains a second init container (named, hoist) running `node dist-tenant-admin/admin/control-plane/bin/pragmatic-ui-unpack.js` with the `UiUnpackInput` passed as args/env (repo, artifactTag, sigTag, expectedManifestDigest, appName, appVersion, trustRootRef, registryPullBase, data dir, trust dir), plus a read-only volume mounting the `<env>-ui-trust` Secret (items-projected to the single `<trustRootRef>.pub` key) at a trust dir, sharing the data PVC. When `appDeployment` is absent, the Deployment is unchanged. Separately, the registry objects rendered by `RenderRegistry` (Spec 1) drop their `pragmatic/hive` label (shared cluster-fixed infra).

- [ ] **Step 1: Write the failing tests:** (a) with `appDeployment` set, the rendered Deployment has two init containers, the second running the unpack bin path with the expected args/env and a read-only `<env>-ui-trust` volume mounted projecting only `<trustRootRef>.pub`; (b) with `appDeployment` absent, `JSON.stringify` of the Deployment equals the pre-change render (no extra init container/volume/env); (c) `RenderRegistry('hive-1')` objects carry no `pragmatic/hive` label.
- [ ] **Step 2: Run them, verify they fail.**
- [ ] **Step 3: Implement** the conditional init-container + trust-volume block (mirror the existing `workload.federation` block + `SecretVolume(..., items)` projection), the bin-path constant, and the registry label removal.
- [ ] **Step 4: Run tests + existing manifest-builder suites (no regression); both type-gates clean.**
- [ ] **Step 5: Commit** — `feat: render UI-unpack init container + trust mount; unlabel shared registry`.

---

### Task 4: `IKubectl.RolloutRestart` + per-env trust-Secret projection

**Files:**
- Modify: `admin/control-plane/kubectl.ts` (`IKubectl` + `KubectlCli`: add `RolloutRestart`)
- Modify: `admin/control-plane/env-server-seed.ts` (add `ApplyUiTrust` mirroring `ApplyIdpCa`)
- Test: `admin/control-plane/tests/kubectl.test.ts` (extend) and `admin/control-plane/tests/env-server-seed.test.ts` (extend, if present; else a focused new test)

**Interfaces:**
- Produces: `IKubectl.RolloutRestart(namespace: string, deployment: string): Promise<void>` → `kubectl rollout restart deployment/<deployment> -n <namespace>` (mirror `SetImage`/`Scale` arg-building + the exec seam). `EnvServerSeedSource.ApplyUiTrust(kubectl: IKubectl, environmentName: string, trustKeyRef: string, publicKeyPem: Buffer): Promise<void>` → applies a `<env>-ui-trust` Secret whose single data key is `<trustKeyRef>.pub` = base64(publicKeyPem) (clone `ApplyIdpCa`; namespace via `K8sManifestBuilder.NamespaceOf`). Consumed by Task 5.

- [ ] **Step 1: Write the failing tests:** `RolloutRestart` invokes the exec with args `['rollout','restart','deployment/<d>','-n','<ns>']` (assert against a fake `IExecFile` recording calls, matching how the existing kubectl tests drive it); `ApplyUiTrust` calls `kubectl.Apply` with a Secret JSON whose `metadata.name === <env>-ui-trust`, namespace correct, and `data` has exactly one key `<trustKeyRef>.pub` equal to the base64 of the PEM (and NO `.key`).
- [ ] **Step 2: Run them, verify they fail.**
- [ ] **Step 3: Implement** both (hoist the `rollout`/`restart`/`deployment/` tokens and the `-ui-trust`/`.pub` constants).
- [ ] **Step 4: Run tests + existing kubectl/seed suites; both type-gates clean.**
- [ ] **Step 5: Commit** — `feat: kubectl RolloutRestart + per-env UI trust-root Secret`.

---

### Task 5: `DeployAppToEnvironment` actuator

**Files:**
- Modify: `admin/control-plane/kubectl-hive-orchestrator.ts` (add a `DeployApp` method that reaches kubectl+registry+keys) OR a focused new `admin/control-plane/ui-deploy-actuator.ts` the orchestrator/service delegates to — the implementer picks the cleaner seam given the orchestrator's existing deps; the actuator must reach `KubectlCli`, `EffectiveRegistry`/`InClusterRegistry.PushBase()`, a signing `FileKeyStore`, and `K8sManifestBuilder`.
- Modify: `admin/control-plane/environment-service.ts` (add `DeployAppToEnvironment` delegating to the runtime/orchestrator; persist the `appDeployment` onto the `EnvironmentRecord`)
- Test: `admin/control-plane/tests/ui-deploy-actuator.test.ts` (new) + an `environment-service` test for the record update

**Interfaces:**
- Consumes: `UiArtifact.Pack` (Task-consumed Spec 2), `OciRegistryClient(InClusterRegistry.PushBase())`, `UiArtifactSigner(new FileKeyStore(keysDir))`, `ApplyUiTrust` + `RolloutRestart` (Task 4), the carrier types (Task 1).
- Produces: `DeployAppToEnvironment(environmentName: string, bundle: { config: UiArtifactConfig; files: readonly UiBundleFile[] }): Promise<EnvironmentRecord>`. It: packs the artifact; pushes config+layer blobs then the manifest (tag `<appName>-<appVersion>`) to the in-cluster registry; signs `{appName,appVersion,manifestDigest}` with the hive's `trustRootRef` private key and pushes the signature as a companion artifact (tag `<tag>.sig`, a tiny artifact whose single layer blob is the base64 signature); projects the `<env>-ui-trust` Secret (hive `trustRootRef` public PEM) via `ApplyUiTrust`; sets `record.appDeployment = { appName, appVersion, repo, artifactTag, manifestDigest }` and `registry.Put`s it; re-applies the env manifest (so the init container is present) and `RolloutRestart`s the env Deployment. Returns the updated record.

- [ ] **Step 1: Write the failing tests** with fakes for the registry client (record pushes), the kubectl (record Apply/RolloutRestart), and a temp `FileKeyStore`: deploying a bundle (a) pushes config+layer+manifest then a `<tag>.sig` companion whose layer decodes to a signature that `UiArtifactVerifier` accepts for `{appName,appVersion,manifestDigest}`; (b) projects a `<env>-ui-trust` Secret with the public key only; (c) sets `record.appDeployment` with the returned `manifestDigest` and persists it; (d) issues a `RolloutRestart` for the env Deployment. Plus: the signed digest equals the pushed manifest's digest (end-to-end digest consistency).
- [ ] **Step 2: Run them, verify they fail.**
- [ ] **Step 3: Implement** the actuator + the `EnvironmentService.DeployAppToEnvironment` delegation + record persistence. Reuse the Spec-1/2 classes; push order is blobs→manifest→signature; the trust Secret + record happen before the restart. Hoist all tags/suffixes.
- [ ] **Step 4: Run tests + the admin suite (no regression); both type-gates clean.**
- [ ] **Step 5: Commit** — `feat: DeployAppToEnvironment actuator (build/push/sign/record/restart)`.

## Notes for the executor

- **The signature's source is load-bearing:** it is pulled by the pod from the registry (companion artifact), while the expected digest comes from the env spec (k8s API). Keeping these channels distinct is what lets pod-side verification defend against both a tampered registry (digest-pin catches it) and a tampered env spec (signature catches it). Do not "simplify" by shipping the signature through the env spec/Secret.
- **One served app per env (v1):** `appDeployment` is a single optional field, not a list. A multi-app generalization is out of scope (and would be a separate record+registry).
- **Signing key:** the control plane signs with the hive `trustRootRef` keypair's private `.key` (present in the control-plane `keysDir`); the pod verifies with the `.pub` projected into `<env>-ui-trust`. If a hive has no `trustRootRef`, `DeployAppToEnvironment` must fail fast with a material-free error (no unsigned deploy).
