# SP-HIVE-3 — Container Registry + Signed-Image Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hive pulls the platform image from a registry local to it, and the orchestrator verifies the image's signature before `kubectl apply` — a tampered or unsigned image is rejected and never reaches the cluster.

**Architecture:** An `EffectiveRegistry` rewrites the workload's image ref to the hive's registry (provision `localhost:5000` / attach endpoint); a Node-`crypto` Ed25519 verifier (`CryptoImageVerifier` over an `ISignatureStore` + `IImageDigest` + `IKeyStore`, all fakeable, keys/signatures by name) verifies the image digest against the hive's `trustRootRef`, fail-closed; `KubectlHiveOrchestrator.Apply`/`Roll` gain the verify-then-apply gate, wired by `HiveOrchestratorFactory`. Additive to the shipped docker lifecycle; the HIVE-2 health route is untouched.

**Tech Stack:** TypeScript, Node `crypto` (Ed25519), `node:child_process` `execFile` via the existing `IExecFile` seam, `docker` CLI + `registry:2`, `kubectl` against Docker Desktop k8s, `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-22-sp-hive-3-container-registry-signature-verification-spec.md`

## Global Constraints

- **Verification mechanism = Node `crypto` Ed25519 digest-signature behind a cosign-shaped `IImageVerifier` seam** (cosign/notation are NOT installed locally). Fail-closed.
- **Keys, signatures, registry credentials held server-side by name** (`trustRootRef`, signing-key ref, `registry.credentialRef`); never in logs, DTOs, errors, manifests, or the portal. Error messages name the image ref or a key *ref name*, never key/signature bytes.
- **Reuse the existing `IExecFile` seam** (`admin/control-plane/kubectl.ts`) for `docker` CLI calls — argument arrays, never a shell.
- **Local provision = real `registry:2`** on `localhost:5000`; the cluster pulls from it. Attach (GHCR) modeled + unit-tested; live GHCR deferred.
- **Additive**: do not change the shipped docker environment lifecycle or the HIVE-2 `GET /api/hives/:id/health` route. The orchestrator gate is an additive gate on `Apply`/`Roll`.
- **OOP**: classes with methods, no module-level free functions/state. **Allman** braces. **No inline string literals** (hoist to `private static readonly`). **PascalCase** public methods/interfaces. Enums over string-literal sets.
- **Tests in `tests/` subfolders.** **LF-only.** Admin tests: `npx tsx --test "admin/control-plane/tests/*.test.ts"` (root `npm test` does not cover `admin/`). Types: `npm run typecheck:tools`.

## Review Focus

- **Verification fails open:** a missing signature, an undefined/empty `trustRootRef`, or a missing key must each THROW, never vacuously pass (an unsigned image must not run) — pinned by Task 4 (each case) + Task 5 (gate propagates the throw).
- **Apply/Roll not actually gated:** `kubectl.Apply`/`SetImage` must NOT be called when `Verify` rejects — pinned by Task 5 (assert the kubectl call never happens on verify failure).
- **Key/signature value leakage:** no key or signature bytes in any error message, log, or DTO — pinned by Task 3 (`KeyNotFoundError`) + Task 4 (`ImageVerificationError`).
- **Wrong effective image ref:** the rendered/applied image must be the registry-rewritten ref (not the bare base image, and not double-prefixed); a hive with no registry endpoint leaves it unchanged — pinned by Task 1 + Task 5.
- **Digest mismatch (tamper) accepted:** a signature made over a different digest than the image's actual digest must fail verification — pinned by Task 4.

---

### Task 1: `EffectiveRegistry`

**Files:**
- Create: `admin/control-plane/effective-registry.ts`
- Test: `admin/control-plane/tests/effective-registry.test.ts`

**Interfaces:**
- Consumes: `HiveRecord`, `RegistrySpec`, `InfraMode` (`admin/control-plane/platform-records.ts`).
- Produces: `class EffectiveRegistry { static For(hive: HiveRecord): EffectiveRegistry; get Endpoint(): string | undefined; get Mode(): InfraMode; ImageRef(baseImage: string): string; get PullPolicy(): string }`.

- [ ] **Step 1: Write the failing tests:**
  - provision hive, no `registry.endpoint` → `Endpoint` is `localhost:5000`; `ImageRef('pragmatic-server:dev')` === `localhost:5000/pragmatic-server:dev`.
  - provision hive with `registry.endpoint = 'reg.local:6000'` → `ImageRef('pragmatic-server:dev')` === `reg.local:6000/pragmatic-server:dev`.
  - attach hive with `registry.endpoint = 'ghcr.io/pragmatic-tech-ai'` → `ImageRef('pragmatic-server:dev')` === `ghcr.io/pragmatic-tech-ai/pragmatic-server:dev`.
  - a hive whose resolution yields no endpoint (shared-store fast path) → `ImageRef('pragmatic-server:dev')` === `pragmatic-server:dev` (unchanged).
  - `PullPolicy` === `IfNotPresent`.
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/effective-registry.test.ts"` — expect FAIL.
- [ ] **Step 3: Implement** `EffectiveRegistry`. Default provision endpoint is a hoisted `private static readonly` `localhost:5000`. Decide the shared-store (unchanged) case: an explicitly empty endpoint string, or a provision mode with a sentinel — pick one and encode it so `For` sets `Endpoint` undefined; `ImageRef` prepends `Endpoint + '/'` only when `Endpoint` is set.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5:** `npm run typecheck:tools` clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-3): effective registry`).

---

### Task 2: `IImageDigest` + `DockerImageDigest`

**Files:**
- Create: `admin/control-plane/image-digest.ts`
- Test: `admin/control-plane/tests/image-digest.test.ts`

**Interfaces:**
- Consumes: `IExecFile` (`admin/control-plane/kubectl.ts` — `Run(file, args: readonly string[], stdin?): Promise<{stdout, stderr}>`).
- Produces: `interface IImageDigest { Of(imageRef: string): Promise<string> }`; `class DockerImageDigest implements IImageDigest` with `constructor(exec?: IExecFile)`.

- [ ] **Step 1: Write the failing test** with a fake `IExecFile`:
  - `Of('localhost:5000/pragmatic-server:dev')` runs `docker image inspect localhost:5000/pragmatic-server:dev --format {{.Id}}` (assert the exact arg array) and returns the trimmed stdout (e.g. `sha256:abc…`).
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** `DockerImageDigest` (arg-array via `IExecFile`; trim stdout; hoist `docker`/`image`/`inspect`/`--format`/`{{.Id}}` to constants). Real default `exec` is a `NodeExecFile` (import from `kubectl.ts`).
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5:** `npm run typecheck:tools` clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-3): docker image digest`).

---

### Task 3: `FileSignatureStore` + `FileKeyStore`

**Files:**
- Create: `admin/control-plane/signature-store.ts`
- Create: `admin/control-plane/key-store.ts`
- Test: `admin/control-plane/tests/signature-store.test.ts`
- Test: `admin/control-plane/tests/key-store.test.ts`

**Interfaces:**
- Produces: `interface ISignatureStore { Get(digest: string): Promise<string | undefined>; Put(digest: string, signature: string): Promise<void> }`; `class FileSignatureStore implements ISignatureStore` (`constructor(filePath: string)`). `interface IKeyStore { PublicKey(ref: string): Promise<string>; PrivateKey(ref: string): Promise<string> }`; `class FileKeyStore implements IKeyStore` (`constructor(keysDir: string)`); `class KeyNotFoundError extends Error`.

- [ ] **Step 1: Write the failing tests** (temp dirs via `mkdtemp`):
  - `FileSignatureStore`: `Put(digest, sig)` then `Get(digest)` round-trips; `Get(unknown)` → `undefined`; a fresh file path (ENOENT) → `Get` returns `undefined`; persisted file is valid JSON `{ digest: sig }`.
  - `FileKeyStore`: writing a PEM to `<keysDir>/<ref>.pub`/`.key` (decide the suffix convention, hoisted) then `PublicKey(ref)`/`PrivateKey(ref)` returns its contents; an unknown ref throws `KeyNotFoundError` whose message contains the **ref name** but no key bytes.
- [ ] **Step 2: Run** both tests — expect FAIL.
- [ ] **Step 3: Implement** both. `FileSignatureStore` follows the atomic temp-file+rename persist discipline of `json-record-store.ts` (ENOENT→empty map). `FileKeyStore` resolves `<keysDir>/<ref><suffix>`; missing file → `KeyNotFoundError`. Hoist filename suffixes/keys to constants.
- [ ] **Step 4: Run** both tests — expect PASS.
- [ ] **Step 5:** `npm run typecheck:tools` clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-3): signature + key stores`).

---

### Task 4: `CryptoImageVerifier` + `ImageSigner` + `ImageVerificationError`

**Files:**
- Create: `admin/control-plane/image-verifier.ts` (`IImageVerifier`, `CryptoImageVerifier`, `ImageVerificationError`)
- Create: `admin/control-plane/image-signer.ts` (`ImageSigner`)
- Test: `admin/control-plane/tests/image-verifier.test.ts`

**Interfaces:**
- Consumes: `IImageDigest` (Task 2), `ISignatureStore` + `IKeyStore` (Task 3).
- Produces: `interface IImageVerifier { Verify(imageRef: string, trustRootRef: string | undefined): Promise<void> }`; `class CryptoImageVerifier implements IImageVerifier` (`constructor(digests: IImageDigest, store: ISignatureStore, keys: IKeyStore)`); `class ImageVerificationError extends Error`; `class ImageSigner` (`constructor(digests: IImageDigest, store: ISignatureStore, keys: IKeyStore); Sign(imageRef: string, signingKeyRef: string): Promise<void>`).

- [ ] **Step 1: Write the failing tests.** Generate an Ed25519 key pair with Node `crypto` in the test; write keys through a real `FileKeyStore` (temp dir); use a fake `IImageDigest` returning a controlled digest and a real `FileSignatureStore` (temp file):
  - **round-trip:** `ImageSigner.Sign(img, 'dev-priv')` then `CryptoImageVerifier.Verify(img, 'dev-pub')` resolves (no throw).
  - **tamper (digest mismatch):** sign while the fake digest is `sha256:A`, then switch the fake to return `sha256:B` for the same ref → `Verify` throws `ImageVerificationError`.
  - **missing signature:** `Verify` on an unsigned image → `ImageVerificationError`.
  - **undefined trustRootRef:** `Verify(img, undefined)` → `ImageVerificationError` (fail-closed).
  - **wrong key:** verify with a different public key than the signer's → `ImageVerificationError`.
  - **no leakage:** the thrown message contains the image ref but neither the signature nor any key bytes.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** both. `Sign`: `digest = await digests.Of(ref)`; `crypto.sign(null, Buffer.from(digest), privateKeyObject)` (Ed25519, `sign(null, …)`); base64; `store.Put(digest, sig)`. `Verify`: reject if `trustRootRef` is undefined/empty; `digest = await digests.Of(ref)`; `sig = await store.Get(digest)` (undefined → throw); `crypto.verify(null, Buffer.from(digest), publicKeyObject, Buffer.from(sig,'base64'))` (false → throw). Load keys via `crypto.createPublicKey`/`createPrivateKey` on the PEM from `IKeyStore`. Hoist all literals.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5:** `npm run typecheck:tools` clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-3): crypto image verifier + signer`).

---

### Task 5: Orchestrator verification gate + factory wiring

**Files:**
- Modify: `admin/control-plane/kubectl-hive-orchestrator.ts` (ctor gains `registry`, `verifier`, `trustRootRef`; `Apply`/`Roll` gate)
- Modify: `admin/control-plane/hive-orchestrator-factory.ts` (wire real `EffectiveRegistry` + `CryptoImageVerifier` + `hive.trustRootRef`)
- Modify: `admin/control-plane/tests/kubectl-hive-orchestrator.test.ts` (pass fakes; new gate tests)
- Modify: `admin/control-plane/tests/hive-orchestrator-factory.test.ts` (assert effective-image wiring)

**Interfaces:**
- Consumes: `EffectiveRegistry` (Task 1), `IImageVerifier` (Task 4); existing `IKubectl`, `K8sManifestBuilder`.
- Produces: `KubectlHiveOrchestrator` ctor `(kubectl: IKubectl, manifests: K8sManifestBuilder, registry: EffectiveRegistry, verifier: IImageVerifier, trustRootRef: string | undefined, polling?: OrchestratorPolling)`.

- [ ] **Step 1: Write the failing tests** (fake `IKubectl` recording calls; fake `IImageVerifier` programmable to resolve/reject; a real or fake `EffectiveRegistry`):
  - `Apply(w)` calls `verifier.Verify(registry.ImageRef(w.image), trustRootRef)` **before** `kubectl.Apply`, and the manifest handed to `kubectl.Apply` contains the **effective** image ref (registry-rewritten).
  - when `verifier.Verify` rejects, `kubectl.Apply` is **never called** (`assert.rejects` + assert the fake recorded no `Apply`).
  - `Roll(w, image)` calls `verifier.Verify(registry.ImageRef(image), trustRootRef)` **before** `SetImage`; a verify rejection means `SetImage` is never called.
  - update the existing HIVE-2 orchestrator tests to construct with the new ctor args (a fake registry whose `ImageRef` is identity + a pass-through fake verifier) so their existing assertions still hold.
- [ ] **Step 2: Run** `npx tsx --test "admin/control-plane/tests/kubectl-hive-orchestrator.test.ts" "admin/control-plane/tests/hive-orchestrator-factory.test.ts"` — expect FAIL on the new assertions.
- [ ] **Step 3: Implement.** Extract one private `VerifiedImage(baseImage)` helper used by both `Apply` and `Roll` (DRY): `const img = this.registry.ImageRef(baseImage); await this.verifier.Verify(img, this.trustRootRef); return img`. `Apply` renders `{ ...w, image: VerifiedImage(w.image) }`; `Roll` sets `VerifiedImage(image)`. Wire the factory: `new CryptoImageVerifier(new DockerImageDigest(), new FileSignatureStore(sigPath), new FileKeyStore(keysDir))`, `EffectiveRegistry.For(hive)`, `hive.trustRootRef`; resolve `sigPath`/`keysDir` under the control-plane data root (hoist the path segments).
- [ ] **Step 4: Run** the full admin suite `npx tsx --test "admin/control-plane/tests/*.test.ts"` — expect PASS, no regressions.
- [ ] **Step 5:** `npm run typecheck:tools` clean.
- [ ] **Step 6: Commit** (`feat(sp-hive-3): orchestrator verification gate + factory wiring`).

---

### Task 6: Gated real-cluster provenance smoke

**Files:**
- Create: `admin/control-plane/registry-provenance-smoke.ts`
- Modify: `admin/README.md` (document it alongside the other gated smokes)

**Interfaces:**
- Consumes: everything above; composes a real `KubectlHiveOrchestrator` for a provision-registry local hive against context `docker-desktop`.

- [ ] **Step 1: Implement** `class RegistryProvenanceSmoke` with `static async Main()` + `IsEntryPoint()`, mirroring `k8s-hive-smoke.ts`. It: (a) `docker run -d -p 5000:5000 registry:2`, wait for `localhost:5000/v2/` ready; (b) `docker tag`/`push pragmatic-server:dev` → `localhost:5000/pragmatic-server:dev`; (c) generate a dev Ed25519 pair into a temp `FileKeyStore`, `ImageSigner.Sign('localhost:5000/pragmatic-server:dev', signingKeyRef)` into a temp `FileSignatureStore`; (d) compose the orchestrator (real `EffectiveRegistry` for a provision hive, `CryptoImageVerifier` over those stores, `trustRootRef` = dev public key) and `Apply` a throwaway dev-blank workload (HIVE-2 smoke boot env, per-run random namespace) → `WaitHealthy` → assert the running image ref is `localhost:5000/...`; (e) **tamper check:** corrupt/remove the signature (or swap the trust root) and assert a second `Apply` throws `ImageVerificationError` with no new namespace applied; (f) `finally`: teardown namespace, stop+remove the `registry:2` container, clean temp stores.
- [ ] **Step 2: Guard** it out of the normal run: standalone entrypoint (`npx tsx admin/control-plane/registry-provenance-smoke.ts`), not matched by `tests/*.test.ts`. Confirm the test glob does not pick it up.
- [ ] **Step 3: Run it for real** against Docker Desktop k8s. Capture real output (registry up, push, verify-pass + pod Ready pulling from `localhost:5000`, tamper → rejected). If `localhost:5000` needs insecure-registry config or any step can't run, diagnose and report honestly — never fake a pass.
- [ ] **Step 4: Commit** (`test(sp-hive-3): gated registry provenance smoke`).

---

## Notes for the executor

- Do NOT change the shipped docker lifecycle or the HIVE-2 health route. The orchestrator gate is additive on `Apply`/`Roll`.
- Follow `k8s-hive-smoke.ts` for the gated-smoke shape and `json-record-store.ts` for atomic-JSON persistence.
- Keys and signatures are secrets: never interpolate their bytes into a log, error, or DTO — only ref names and image refs.
- `crypto.sign(null, data, key)` / `crypto.verify(null, data, key, sig)` is the Ed25519 form (algorithm is `null` for Ed25519).
