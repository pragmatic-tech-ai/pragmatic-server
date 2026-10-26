# OCI Artifact Push/Pull + Signing + R6 Storage (Spec 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the reusable pieces that turn an app's UI bundle into a signed OCI artifact and back, and version-scope UI storage so redeploys are atomic and rollback-capable.

**Architecture:** Four independent units. (1) `OciRegistryClient` — a minimal OCI-distribution-v2 client over an injectable `fetch` seam (push/pull blob + manifest, sha256 digests), extracted from the logic the Spec 1 smoke already proved. (2) `UiArtifact` — packs a UI bundle into an OCI config blob + a JSON `{path: base64}` layer blob + an OCI manifest (and unpacks it), with a reproducible manifest digest. (3) `UiArtifactSigner`/`UiArtifactVerifier` — a detached Ed25519 signature over the canonical `{appName, appVersion, manifestDigest}` payload, reusing the existing `FileKeyStore` + `node:crypto`. (4) R6 — `AppIngestService` writes UI version-scoped under `<app>/<version>/ui` with a `<app>/live` pointer; `AppServingEndpoint` reads the pointer and dual-reads the legacy layout for already-deployed apps. Spec 3 wires these into a deploy actuator + pod-side init container; Spec 2 ships them with unit tests and leaves them uncalled by production (the recorded scope boundary).

**Tech Stack:** TypeScript (Node), `node:crypto` (`createHash`, Ed25519 `sign`/`verify`), global `fetch`, `@pragmatic-tech-ai/todl-runtime` `IStorage`. No new npm dependency; no tar library (the layer is JSON).

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-in-cluster-app-ui-serving-design.md` (§6.2 artifact, §6.3 signing, §6.5 R6 storage; §7 Spec 2). This plan builds only Spec 2.

## Global Constraints

- OOP (methods/statics on classes, no free functions, no module-level mutable state); Allman braces; PascalCase public members/interfaces.
- No inline string/number literals for media types, paths, headers, scheme/host strings, dir/file names, digest/algorithm strings, separators — hoist to `static readonly`. Structural tokens may stay inline.
- LF endings. Admin tests in `admin/control-plane/tests/`; app tests co-located with the existing `app-ingest-service`/`app-serving-endpoint` tests (find them; same directory). NodeNext ESM — relative imports end `.js`. Never `npm install` at repo root.
- Secrets/keys by name only — never a key, private PEM, signature, or inner error text in a log, DTO, thrown message, or persisted record. Reuse the existing `ImageVerificationError`-style messages that carry no material.
- Type gates (both must stay green): `npx tsc -p tsconfig.tools.json --noEmit` and `npx tsc -p tsconfig.tenant-admin.json --noEmit`. For the `src/` changes also `npm run build` (`tsc -p tsconfig.build.json`). Admin test runner: `npx tsx --test admin/control-plane/tests/<file>.test.ts`.
- Pinned shapes: config-blob mediaType `application/vnd.pragmatic.ui.config.v1+json`; layer-blob mediaType `application/vnd.pragmatic.ui.layer.v1+json`; OCI manifest mediaType `application/vnd.oci.image.manifest.v1+json`; digest form `sha256:<hex>`; signed-payload field order `appName`, `appVersion`, `manifestDigest`.
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Never merge/push without explicit instruction.

## Review Focus

- **Digest reproducibility.** The manifest digest must be identical for identical input across runs/machines, or Spec 3's env-spec digest-pin breaks. → Task 2 asserts two independent packs of the same bundle yield the same `sha256:` digest, and that layer-file ordering is canonicalized (sorted) before hashing.
- **Signature binds identity, not just the digest.** A valid signature must not verify against a different `appName`/`appVersion`/`manifestDigest`. → Task 3 asserts tampering any of the three fails verification (fail-closed), and a wrong/absent key fails.
- **R6 does not break already-deployed apps.** An app on the legacy `<app>/ui` layout (no `<app>/live`) must still serve after the storage change. → Task 4 asserts serving falls back to the legacy layout when `<app>/live` is absent.
- **Rollback serves the pointed-at version, not the newest on disk.** After deploying v2 then re-pointing to v1, serving returns v1's assets. → Task 4 asserts the live pointer — not newest-version-wins — decides what serves.
- **OCI non-2xx + transport failure are typed, not swallowed.** A registry 4xx/5xx or an unreachable host must raise a typed error naming neither credentials nor response bodies. → Task 1 asserts a non-2xx and a thrown-fetch each produce the typed error, body drained.

---

### Task 1: `OciRegistryClient`

**Files:**
- Create: `admin/control-plane/oci-registry-client.ts`
- Test: `admin/control-plane/tests/oci-registry-client.test.ts`

**Interfaces:**
- Produces: `type OciFetch = (url: string, init: { method: string; headers?: Record<string,string>; body?: Uint8Array | string }) => Promise<Response>`. `class OciRegistryClient` ctor `(baseUrl: string, fetchFn: OciFetch = fetch)`. Methods: `PushBlob(repo: string, bytes: Uint8Array): Promise<string>` (monolithic upload → returns the `sha256:` digest); `PushManifest(repo: string, reference: string, manifestBytes: Uint8Array): Promise<string>` (returns the manifest digest); `PullManifest(repo: string, reference: string): Promise<Uint8Array>`; `PullBlob(repo: string, digest: string): Promise<Uint8Array>`; `static DigestOf(bytes: Uint8Array): string` (`sha256:` + hex). Typed errors: `OciUnavailableError` (transport/thrown fetch) and `OciResponseError` (non-2xx, carries the status number only). These signatures are consumed by Spec 3, not within Spec 2.

- [ ] **Step 1: Write the failing tests** — drive the client with a fake `OciFetch` that records requests and returns canned `Response`s:

```ts
test('PushBlob does POST uploads then PUT ?digest= and returns the sha256 digest', async () =>
{
    // fake fetch: POST /v2/<repo>/blobs/uploads/ → 202 {Location: '/v2/<repo>/blobs/uploads/abc'}; PUT → 201
    // assert the PUT url carries digest=sha256:<hex of bytes>, Content-Type application/octet-stream,
    // and the returned digest equals OciRegistryClient.DigestOf(bytes)
})
test('PushBlob appends ?digest onto a Location that already has a query string', async () => { /* Location '...?_state=x' → '...?_state=x&digest=...' */ })
test('PullBlob GETs /v2/<repo>/blobs/<digest> and returns the bytes', async () => { /* 200 + bytes → Buffer.equals */ })
test('PushManifest PUTs /v2/<repo>/manifests/<ref> with the OCI manifest media type and returns the digest', async () => {})
test('a non-2xx response raises OciResponseError carrying the status and no body', async () => { /* 500 → throws, message has 500, not the body text */ })
test('a thrown fetch raises OciUnavailableError', async () => {})
```

- [ ] **Step 2: Run the tests, verify they fail.**

- [ ] **Step 3: Implement `OciRegistryClient`** in `admin/control-plane/oci-registry-client.ts`. Mirror the OCI sequence already proven in `admin/control-plane/registry-roundtrip-smoke.ts` (`PushBlob`/`PushManifest`, `new URL(location, baseUrl)`, `searchParams.set('digest', …)`, media-type constants, `createHash('sha256')`), but as a reusable class with the injectable `OciFetch` seam and the typed errors above. Match the HTTP house style of `admin/control-plane/tenant-api/http-rollout-client.ts` (try/catch fetch → typed transport error; non-ok → drain body then typed status error; literals hoisted). Pass `Uint8Array` bodies (not `Buffer`) to satisfy `BodyInit` typing.

- [ ] **Step 4: Run the tests, verify they pass; run both type-gate tsc configs clean.**

- [ ] **Step 5: Commit** — `feat: OciRegistryClient (OCI distribution v2 over fetch)`.

---

### Task 2: `UiArtifact` — pack/unpack + manifest digest

**Files:**
- Create: `admin/control-plane/ui-artifact.ts`
- Test: `admin/control-plane/tests/ui-artifact.test.ts`

**Interfaces:**
- Consumes: `OciRegistryClient.DigestOf` (Task 1) for blob digests.
- Produces: `interface UiBundleFile { path: string; bytes: Uint8Array }`. `interface UiArtifactConfig { appName: string; appVersion: string; entry: string; assets: readonly string[] }`. `class UiArtifact` with `static Pack(config: UiArtifactConfig, files: readonly UiBundleFile[]): { manifestBytes: Uint8Array; manifestDigest: string; configBlob: Uint8Array; layerBlob: Uint8Array }` and `static Unpack(layerBlob: Uint8Array): UiBundleFile[]` and `static ManifestDigestOf(manifestBytes: Uint8Array): string`. The layer blob is a JSON object mapping each file's relative path to its base64 bytes, **keys sorted** before serialization so the digest is reproducible. The OCI manifest references the config blob (config mediaType) and the one layer (layer mediaType) by digest+size, `schemaVersion: 2`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('Pack then Unpack round-trips the files exactly', () =>
{
    const files = [{ path: 'index.html', bytes: enc('<html>') }, { path: 'a/app.js', bytes: enc('x=1') }]
    const a = UiArtifact.Pack({ appName: 'northwind', appVersion: '1.0.0', entry: 'index.html', assets: ['a/app.js'] }, files)
    const out = UiArtifact.Unpack(a.layerBlob)
    // assert out has the same {path, bytes} set (order-independent), bytes Buffer.equal
})
test('the manifest digest is reproducible for identical input regardless of file order', () =>
{
    const f1 = [fileA, fileB]; const f2 = [fileB, fileA]
    assert.equal(UiArtifact.Pack(cfg, f1).manifestDigest, UiArtifact.Pack(cfg, f2).manifestDigest)
})
test('the manifest references the config and layer blobs by their sha256 digests and declares the pragmatic UI media types', () =>
{
    const a = UiArtifact.Pack(cfg, files); const m = JSON.parse(Buffer.from(a.manifestBytes).toString())
    assert.equal(m.config.mediaType, 'application/vnd.pragmatic.ui.config.v1+json')
    assert.equal(m.layers[0].mediaType, 'application/vnd.pragmatic.ui.layer.v1+json')
    assert.equal(m.config.digest, OciRegistryClient.DigestOf(a.configBlob))
    assert.equal(m.layers[0].digest, OciRegistryClient.DigestOf(a.layerBlob))
})
```

- [ ] **Step 2: Run the tests, verify they fail.**

- [ ] **Step 3: Implement `UiArtifact`.** The layer is `JSON.stringify` of a path→base64 map with keys inserted in sorted order (so the serialized bytes — and thus the digest — are stable). The config blob is `JSON.stringify(config)`. The manifest is the OCI image-manifest shape (`schemaVersion`, `config` descriptor, `layers: [descriptor]`), each descriptor `{ mediaType, digest: DigestOf(blob), size: blob.byteLength }`. `ManifestDigestOf` = `OciRegistryClient.DigestOf(manifestBytes)`. Hoist all media-type/field-name literals.

- [ ] **Step 4: Run the tests, verify they pass; type-gates clean.**

- [ ] **Step 5: Commit** — `feat: UiArtifact pack/unpack with reproducible manifest digest`.

---

### Task 3: `UiArtifactSigner` / `UiArtifactVerifier`

**Files:**
- Create: `admin/control-plane/ui-artifact-signer.ts`
- Test: `admin/control-plane/tests/ui-artifact-signer.test.ts`

**Interfaces:**
- Consumes: `IKeyStore` + `FileKeyStore` from `admin/control-plane/key-store.ts` (`PublicKey(ref)`, `PrivateKey(ref)` → PEM strings).
- Produces: a canonical payload binding the three identity fields: `static CanonicalPayload(appName: string, appVersion: string, manifestDigest: string): string` (field order per Global Constraints, a fixed separator that cannot occur in the values — e.g. newline). `class UiArtifactSigner` ctor `(keys: IKeyStore)`, `Sign(appName, appVersion, manifestDigest, signingKeyRef): Promise<string>` → base64 Ed25519 signature over the canonical payload bytes. `class UiArtifactVerifier` ctor `(keys: IKeyStore)`, `Verify(appName, appVersion, manifestDigest, signatureBase64, trustRootRef: string | undefined): Promise<void>` → resolves on valid, throws a material-free `UiSignatureError` on any failure (missing trust root, bad signature, mismatched identity). Detached signature returned to the caller (Spec 3 publishes it as a companion artifact); no `ISignatureStore` here.

- [ ] **Step 1: Write the failing tests** (generate an Ed25519 keypair into a temp `FileKeyStore` dir, mirror `admin/control-plane/tests/` signing tests if present):

```ts
test('a signature verifies against the same identity + digest', async () => { /* Sign → Verify resolves */ })
test('verification fails closed when appVersion is changed', async () => { /* Verify with a different appVersion → rejects UiSignatureError */ })
test('verification fails closed when the manifestDigest is changed', async () => {})
test('verification fails closed when appName is changed', async () => {})
test('a missing trust root rejects (fail-closed)', async () => { /* trustRootRef undefined → rejects */ })
test('a signature from a different key does not verify', async () => {})
test('the thrown error names no key material or signature bytes', async () => { /* assert message matches a fixed safe string */ })
```

- [ ] **Step 2: Run the tests, verify they fail.**

- [ ] **Step 3: Implement** using `node:crypto` `sign(null, Buffer.from(payload), createPrivateKey(pem))` / `verify(null, Buffer.from(payload), createPublicKey(pem), Buffer.from(sig,'base64'))` (Ed25519, the exact pattern in `admin/control-plane/image-signer.ts`/`image-verifier.ts`), resolving PEMs via the injected `IKeyStore`. `Verify` recomputes the canonical payload from its own arguments (never trusts a payload off the wire) and fails closed. `UiSignatureError` carries a fixed message only.

- [ ] **Step 4: Run the tests, verify they pass; type-gates clean.**

- [ ] **Step 5: Commit** — `feat: UiArtifact Ed25519 signer/verifier binding app identity`.

---

### Task 4: R6 version-scoped UI storage + live pointer + dual-read

**Files:**
- Modify: `src/host/apps/app-ingest-service.ts` (version-scope the UI + manifest paths; write the `<app>/live` pointer last)
- Modify: `src/host/apps/app-serving-endpoint.ts` (read `<app>/live` → version; dual-read legacy when absent)
- Test: co-located with the existing `app-ingest-service` / `app-serving-endpoint` tests (same directory)

**Interfaces:**
- Consumes: `IStorage` (`WriteText`/`WriteBytes` overwrite-safe all platforms; `Rename` file-replace safe on Windows; `Exists`/`ReadText`/`ReadBytes`). Recon confirmed no new storage primitive is needed.
- Produces: a new on-disk layout — UI at `<appName>/<version>/ui/<relpath>`, manifest at `<appName>/<version>/application.json`, and a pointer file `<appName>/live` whose content is the live version string. A `LivePointerFile = 'live'` constant on each class. The legacy layout (`<appName>/ui`, `<appName>/application.json`) is still readable.

- [ ] **Step 1: Write the failing tests** (match the existing test harness's storage double):

```ts
// ingest
test('Ingest writes UI under <app>/<version>/ui and the manifest under <app>/<version>/application.json', async () => {})
test('Ingest writes a <app>/live pointer naming the deployed version, written after the version tree', async () => {})
test('deploying a second version leaves the first version tree intact and repoints <app>/live', async () => {})
// serving
test('serving reads <app>/live then serves <app>/<version>/ui/<file> and the version manifest', async () => {})
test('after re-pointing <app>/live to an earlier version, serving returns that earlier version\'s assets', async () => {})
test('serving falls back to the legacy <app>/ui + <app>/application.json when <app>/live is absent', async () => {})
```

- [ ] **Step 2: Run the tests, verify they fail.**

- [ ] **Step 3: Implement the ingest change** in `app-ingest-service.ts`: compose UI paths as `[appName, version, UiDir, path].join('/')` and the marker as `[appName, version, ManifestFile].join('/')`; after the version tree's stage-then-rename commit (reusing the existing `Commit` flow), write `<appName>/live` via `WriteText` (overwrite — the new commit point; a few-byte file, not a rename). The version's own `application.json` remains the per-version marker; the `live` write is the atomic app-level switch.

- [ ] **Step 4: Implement the serving change** in `app-serving-endpoint.ts`: if `<app>/live` exists, read the version from it and resolve the manifest at `<app>/<version>/application.json` and assets at `<app>/<version>/ui/<file>`; else fall back to the legacy `<app>/application.json` + `<app>/ui/<file>` paths. Keep `InjectAppName` and the MIME map unchanged.

- [ ] **Step 5: Run the tests, verify they pass; run `npm run build` (src tsc) and both admin type-gates clean; run the existing app-ingest/app-serving suites to confirm no regression.**

- [ ] **Step 6: Commit** — `feat: version-scoped UI storage with a live pointer and legacy dual-read (R6)`.
