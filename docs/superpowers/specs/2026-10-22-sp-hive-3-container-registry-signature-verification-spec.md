# SP-HIVE-3 — Container Registry + Signed-Image Verification — Spec

**Status:** Draft 2026-10-22. Third sub-project of the SP-HIVE program.
**Design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md` (decision 8).
**Predecessors:** SP-HIVE-1 (records), SP-HIVE-2 (Hive Orchestrator + local k8s driver) — both shipped to master.
**Owner repo:** pragmatic-server (`admin/control-plane`).

## Intent

A hive pulls the platform image from a registry **local to it**, and the orchestrator refuses to run an image whose provenance it cannot verify. SP-HIVE-2 applies `pragmatic-server:dev` straight from Docker Desktop's shared image store with no registry and no signature check. SP-HIVE-3 adds the two missing halves of the design's decision 8 — *"every hive pulls from a registry local to it; images are signed at source and verified before apply"*:

1. An **effective-registry** concept: per hive, resolve where images come from (provision a local `registry:2`, or attach a provider/GHCR endpoint), and rewrite the workload's image reference to that registry so the cluster pulls from it.
2. A **signature-verification gate** in the orchestrator's `Apply` path: before any `kubectl apply`, verify the image's signature against the hive's trust root; a tampered or unsigned image is rejected and never reaches the cluster.

Proven locally on Docker Desktop k8s: a signed image pushed to a provisioned `registry:2` is verified and runs; a tampered/unsigned image is rejected before apply.

## The key calls (builder's choice, per the design)

The design left the signing/verification toolchain to the builder ("cosign vs notation — pick one, justify").

- **Verification mechanism: a dependency-free Node `crypto` Ed25519 digest-signature verifier, behind a cosign-shaped `IImageVerifier` seam — not cosign.** `cosign` and `notation` are **not installed** on the local target, so requiring an external binary would make the local-first smoke un-runnable out of the box. Node's built-in `crypto` signs the image's content digest at "source" with a dev private key and verifies it before apply against the hive's `trustRootRef` public key — the exact "signed at source, verified before apply" behavior decision 8 mandates. The seam is cosign-shaped, so a cloud hive can swap in `cosign verify` later without redesign. Production/cloud guidance (cosign) is noted; local uses the built-in verifier.
- **Local provision = a real `registry:2` Docker container** published on `localhost:5000`, which the single-node Docker Desktop cluster pulls from (kubelet runs on the same host). This exercises a genuine OCI registry pull, not just the shared store. Attach (GHCR) is modeled first-class in the resolver and unit-tested; live GHCR replication/pull is deferred (Feature).
- **Reuse the existing `IExecFile` seam** (`admin/control-plane/kubectl.ts`) for the `docker` CLI calls this sub-project needs (`docker image inspect` for the digest; `docker tag`/`push` in the smoke's provision fill) — same execFile/arg-array discipline, no new process wrapper.

## In scope

- `EffectiveRegistry` — resolves a `HiveRecord.registry` (RegistrySpec) to a registry endpoint + an `ImageRef(baseImage)` rewrite; provision and attach modes.
- `IImageDigest` + `DockerImageDigest` — the image's content digest (`docker image inspect --format {{.Id}}`), fakeable.
- `ISignatureStore` + `FileSignatureStore` — the local analog of cosign's OCI signature artifacts: a digest → signature map persisted as atomic JSON (same pattern as `JsonRecordStore`), fakeable.
- `IImageVerifier` + `CryptoImageVerifier` + `ImageVerificationError` — verify a signature over the image digest against a trust-root public key resolved by name; throw on missing/invalid.
- `ImageSigner` — the "source" side: sign an image's digest with a dev private key and record it in the signature store (used by the smoke's publish step; a minimal local publish, mirroring SP-HIVE-4's manifest-publish-by-hand pattern).
- A **key resolver** (`IKeyStore` + `FileKeyStore`) holding the dev key pair server-side by name; `trustRootRef` names the public key, a signing-key ref names the private key. Never in logs/DTOs/manifests.
- The orchestrator `Apply` becomes the **verification gate**: resolve the effective image ref, verify it, render with the effective ref, then `kubectl apply`. `KubectlHiveOrchestrator` gains an injected `EffectiveRegistry` + `IImageVerifier` + the hive's `trustRootRef`; `HiveOrchestratorFactory.For(hive)` wires them from the HiveRecord. The HIVE-2 orchestrator unit tests are updated to pass fakes (no silent-pass defaults).
- A gated real-cluster smoke proving provision → sign → verify-passes → run, and tamper → verify-fails → apply refused.

## Out of scope (named deferrals — file as Features on approval)

- **Server secret/config injection to boot the pod** (base dir, tenants, master key via k8s Secret + provisioned secret *values*). Already filed as the two SP-HIVE-3 Features; this sub-project does **not** take them on — they are environment-runtime config, not registry/provenance. The smoke keeps HIVE-2's dev-only boot env.
- Live GHCR attach (replication/pull-through, pull secrets against the real registry) — modeled + unit-tested; live path deferred.
- cosign/notation integration (the real cloud toolchain) — the seam is ready; swap deferred.
- In-cluster registry (registry as a k8s workload) and private Harbor attach, air-gapped sideload — design mentions them; local uses the host `registry:2`.
- Rollout catalog / pull agent (SP-HIVE-4); cloud backends/provision (SP-HIVE-5).

## Model

### `EffectiveRegistry` (new, `admin/control-plane/effective-registry.ts`)

```ts
export class EffectiveRegistry
{
    static For(hive: HiveRecord): EffectiveRegistry   // reads hive.registry
    get Endpoint(): string | undefined                 // provision: localhost:5000 (or registry.endpoint); attach: registry.endpoint
    get Mode(): InfraMode
    ImageRef(baseImage: string): string                 // '<endpoint>/<baseImage>' when an endpoint is set; else baseImage unchanged (shared-store fast path)
    get PullPolicy(): string                            // IfNotPresent (local); registry pulls still resolve by ref
}
```

Provision with no explicit endpoint defaults to a `private static readonly` `localhost:5000`. When no registry endpoint applies (shared-store fast path), `ImageRef` returns the base image unchanged — preserving HIVE-2 behavior for hives that don't name a registry.

### Provenance components (new)

- `admin/control-plane/image-digest.ts`: `interface IImageDigest { Of(imageRef: string): Promise<string> }`; `class DockerImageDigest implements IImageDigest` (via the existing `IExecFile`: `docker image inspect <ref> --format {{.Id}}`, returns the `sha256:…`).
- `admin/control-plane/signature-store.ts`: `interface ISignatureStore { Get(digest: string): Promise<string | undefined>; Put(digest: string, signature: string): Promise<void> }`; `class FileSignatureStore` (atomic-JSON `{ digest: base64sig }`, ENOENT→empty, following `JsonRecordStore`'s persist discipline).
- `admin/control-plane/key-store.ts`: `interface IKeyStore { PublicKey(ref: string): Promise<string>; PrivateKey(ref: string): Promise<string> }`; `class FileKeyStore` (PEM key files under a keys dir resolved by name; values never logged). A `KeyNotFoundError` for a missing ref.
- `admin/control-plane/image-verifier.ts`: `interface IImageVerifier { Verify(imageRef: string, trustRootRef: string | undefined): Promise<void> }`; `class CryptoImageVerifier implements IImageVerifier` — `digest = await this.digests.Of(imageRef)`; `sig = await this.store.Get(digest)` (missing → `ImageVerificationError`); verify `sig` over the digest bytes with the public key `this.keys.PublicKey(trustRootRef)` via Node `crypto.verify` (Ed25519); invalid → `ImageVerificationError`. A `trustRootRef` of `undefined` → `ImageVerificationError` (an unconfigured trust root cannot vacuously pass). `class ImageVerificationError extends Error` (message names the image ref, never a key/signature value).
- `admin/control-plane/image-signer.ts`: `class ImageSigner { constructor(digests: IImageDigest, store: ISignatureStore, keys: IKeyStore); async Sign(imageRef: string, signingKeyRef: string): Promise<void> }` — digest → `crypto.sign` with the private key → `store.Put(digest, sig)`. The local "sign at source" step.

### Orchestrator gate (modify `kubectl-hive-orchestrator.ts`, `hive-orchestrator-factory.ts`)

`KubectlHiveOrchestrator` constructor gains `registry: EffectiveRegistry`, `verifier: IImageVerifier`, `trustRootRef: string | undefined` (after `kubectl`, `manifests`, before the optional `polling`). `Apply(w)` becomes:

```
effectiveImage = this.registry.ImageRef(w.image)
await this.verifier.Verify(effectiveImage, this.trustRootRef)   // throws ImageVerificationError → no apply
effectiveWorkload = { ...w, image: effectiveImage }
await this.kubectl.Apply(this.manifests.Render(effectiveWorkload))
```

`Roll`/`WaitHealthy`/`Health`/`Teardown` are unchanged except that `Roll`'s target image, when it originates from a hive image, is run through `registry.ImageRef` too (a rolled image is applied, so it is verified first — `Roll` gains the same verify-then-set gate). `HiveOrchestratorFactory.For(hive)` constructs the real `EffectiveRegistry.For(hive)`, a `CryptoImageVerifier` (over `FileSignatureStore` + `DockerImageDigest` + `FileKeyStore`), and passes `hive.trustRootRef`. No silent-pass defaults: the two HIVE-2 orchestrator unit tests are updated to pass fake registry/verifier.

### Security (binding)

- Keys (public and private), registry credentials, and signatures are held server-side and referenced **by name** (`trustRootRef`, a signing-key ref, `registry.credentialRef`); never in logs, DTOs, errors, manifests, or the portal. `ImageVerificationError`/`KeyNotFoundError` name the image ref or the key *ref name*, never a key or signature value.
- Verification **fails closed**: missing signature, missing/empty `trustRootRef`, missing key, or an invalid signature all throw — never a vacuous pass.

## Tests (in `tests/` subfolders; unit tests fake `IExecFile`/`IImageDigest`/stores)

- `effective-registry.test.ts` — provision resolves `localhost:5000` (or `registry.endpoint`) and rewrites `pragmatic-server:dev` → `localhost:5000/pragmatic-server:dev`; attach resolves `registry.endpoint`; a hive with no registry endpoint leaves the image unchanged (shared-store fast path).
- `image-verifier.test.ts` — a signature made by `ImageSigner` over a digest **verifies**; a signature over a *different* digest (tamper) **throws `ImageVerificationError`**; a missing signature throws; `trustRootRef` undefined throws; the error message contains no key/signature bytes.
- `signature-store.test.ts` / `key-store.test.ts` — round-trip persistence, ENOENT→empty; `KeyNotFoundError` for an unknown ref; stores never return a value through an error path.
- `image-digest.test.ts` — `DockerImageDigest` builds the right `docker image inspect` arg array via a fake `IExecFile`.
- `kubectl-hive-orchestrator.test.ts` (extend) — `Apply` calls `verifier.Verify(effectiveImage, trustRootRef)` **before** `kubectl.Apply`, and when `Verify` rejects, `kubectl.Apply` is **never called** (apply refused on bad provenance); `Apply` renders with the effective (registry-rewritten) image; `Roll` verifies the rolled image before `SetImage`.
- `hive-orchestrator-factory.test.ts` (extend) — a local/attach hive yields an orchestrator wired with a real `EffectiveRegistry` + verifier (assert the effective image ref is the registry-rewritten one through the same `Kubectl`/exposed seam used for the context assertion).

### Gated real-cluster smoke (`registry-provenance-smoke.ts`, NOT in `tsx --test`; requires Docker Desktop k8s + `pragmatic-server:dev`)

1. Provision: `docker run -d -p 5000:5000 registry:2`; `docker tag pragmatic-server:dev localhost:5000/pragmatic-server:dev`; `docker push`.
2. Sign at source: `ImageSigner.Sign('localhost:5000/pragmatic-server:dev', devSigningKeyRef)` into a `FileSignatureStore`; dev key pair generated into a temp `FileKeyStore`.
3. Compose a `KubectlHiveOrchestrator` for a provision-registry local hive (`trustRootRef` = dev public key); `Apply` → verify passes → the pod pulls from `localhost:5000` and reaches Ready (HIVE-2 smoke boot env); assert the running image ref is the `localhost:5000/...` one.
4. Tamper: remove/alter the signature (or point the trust root at a different key); `Apply` → `ImageVerificationError`, and assert **no namespace/workload was applied**.
5. Teardown: delete the namespace; stop + remove the `registry:2` container; clean the temp key/sig stores. Report the real captured output; never fake a pass.

## What is left to the builder

- Exact `crypto` algorithm details (Ed25519 key generation, PEM encoding) and the signature encoding (base64) — pick idiomatic Node `crypto`.
- The keys/signature-store directory layout under the control-plane data root.
- Whether `Roll` shares one private verify helper with `Apply` (it should — DRY the verify-then-apply/set step).
- The smoke's registry readiness wait (poll `localhost:5000/v2/` before push) and whether Docker Desktop needs `localhost:5000` as an insecure registry (document what you find; don't fake).
- Whether a tiny read surface (effective registry per hive) is worth a host route — default **no** (the smoke is the proof); add only if trivially justified.
