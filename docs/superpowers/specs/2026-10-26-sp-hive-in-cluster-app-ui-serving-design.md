# In-cluster App UI Serving via In-cluster OCI Registry — Program Design

**Date:** 2026-10-26
**Status:** Design (approved decisions below); decomposed into sequenced sub-specs.
**Repo:** pragmatic-server
**Supersedes the scope of:** Project #1 item "[SP-HIVE] In-cluster app UI serving (deploy-with-UI path + version-scoped UI storage)" (`…DkitA`) and folds in "version-scoped UI storage + atomic directory swap" (R6, `app-ingest-service.ts`).

---

## 1. Intent and why

An app deployed into an in-cluster environment must be reachable in a browser with its real UI, the same way a Docker/direct-hosted env already is. Today the **serving half already works in-cluster** — the env pod runs the full `PragmaticServerHost`, which installs `AppServingEndpoint` (`/app/<tenant>/<app>/…`) on its node:http server, and the 6c per-env TLS-terminating Ingress (`<environmentId>.<baseDomain>`) already routes a browser to it. The gap is purely **delivery + storage**: nothing gets a UI bundle (~7 MB) onto the pod's data PVC, and `application.json` carries no `ui` field there.

The chosen delivery model is an **in-cluster OCI registry**: the control plane publishes an app's UI bundle as a signed OCI artifact; the env pod pulls, verifies, and unpacks it on deploy. This scales to arbitrary bundle sizes (the ~1 MB single-Secret seed path cannot), keeps secrets/large blobs off the Kubernetes API, and establishes registry infrastructure the platform needs anyway (it also unblocks over-the-wire image pulls on kind/cloud, today faked by `kind load`).

**Why now:** it is the last missing piece of the in-cluster author→deploy→serve loop that every other SP-HIVE block has been building toward; with 6c federation shipped, a real browser can already reach an in-cluster env — it just has nothing to render.

## 2. Goals

- A control-plane action "deploy app version V (with UI) to in-cluster environment E" that results in the env pod serving that app's UI at `https://<environmentId>.<baseDomain>/app/<tenant>/<app>/…`.
- An **in-cluster OCI registry** (a real k8s workload) reachable by pods (pull) and by the control plane (push), provisioned per hive.
- UI bundles delivered as **signed OCI artifacts**: the same Ed25519 trust-root model as image signing, verified **pod-side** before unpack (fail-closed).
- **R6 version-scoped UI storage + atomic swap**: UI stored under `<appName>/<version>/ui`, with an atomic live-version pointer flip, so a redeploy never serves a half-written or mixed-version tree and a prior version remains on disk for rollback. This change is in the shared storage layer, so the Docker/direct path benefits too.
- A redeploy and a rollback of an in-cluster app's UI version.
- A gated end-to-end smoke proving build → push → pod pull+verify+unpack → browser render on kind.

## 3. Non-goals

- **Attach-mode / authenticated external registries (GHCR, Harbor).** The registry runs anonymous in dev (matching today's `localhost:5000`). `RegistrySpec.credentialRef` stays unwired. Filed follow-up.
- **Shipping the *server container image* through the new registry.** Server-image rollout keeps its existing `kind load` / `ctr import` path. This program adds *artifact* push/pull; converting image distribution to the in-cluster registry is a separate effort (SP-HIVE-5 item).
- **A live in-pod puller daemon.** Redeploy is a control-plane-recorded ref + a rollout restart; the existing init-container model pulls on pod start. No new long-running agent in the pod.
- **Cloud DNS / cert-manager substrate.** Inherited from the 6c follow-up (`…Dp3bg`); this program runs on the kind + `*.localtest.me` substrate already proven.
- **A UI build pipeline.** We consume an already-built UI bundle (the bytes the existing `CypherAppDeployParamsDto.uiBundle` already carries). The demo gets a minimal hand-written bundle.
- **An admission webhook / cluster-wide signature policy.** Verification is pod-side in the unpack init container, not a cluster policy engine.

## 4. Anti-goals (failure even if it "works")

- Introducing a new **binary dependency** into the `pragmatic-server:dev` image or onto the control-plane host (no `oras`/`crane`/`skopeo`). The codebase idiom is node + `fetch` + already-present binaries (`docker`/`kubectl`/`openssl`); a new binary in the pulled-at-runtime pod image is a supply-chain and image-size regression.
- Any path where **unsigned or tampered** UI bytes can be unpacked and served. Verification failure must leave the live UI untouched (fail-closed, like `CryptoImageVerifier`).
- A redeploy that can leave the served UI in a **mixed-version** state (some old assets, some new) — the reason R6 is in-scope rather than inheriting in-place overwrite.
- Putting **multi-MB blobs on the Kubernetes API** (Secrets/ConfigMaps). Bundles travel registry↔pod over HTTP, never through a Secret.

## 5. Constraints (carried from the workspace)

- OOP, Allman braces, PascalCase public members/interfaces, no inline string literals (hoist to `private static readonly`), engine-never-calls-up. LF-only except pre-existing CRLF in `idp/` files.
- Secrets/keys/tokens held server-side **by name only** — never in logs, DTOs, thrown messages, or persisted records; manifests carry refs, not values.
- Tests live in `tests/` subfolders. Never `npm install` at the repo root. Rebuild sibling `dist` after src edits if a sibling is touched.
- Deferrals filed as GitHub Project #1 items (Kind=Feature, Status=Todo).
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never merge/push without explicit instruction.

## 6. Architecture

### 6.1 The two-address registry

One registry, two reachabilities — exactly the split `EffectiveRegistry` already models (control-plane endpoint vs in-pod ref):

- **Pods pull** from the in-cluster Service DNS: `pragmatic-registry.<namespace>.svc.cluster.local:5000` (plain HTTP in-cluster; the pull init container trusts it because the signature, not the transport, is the integrity boundary).
- **The control plane pushes** to a host-reachable address. On kind, pods cannot reach the host's `localhost:5000` and the host cannot reach a ClusterIP; the registry Service is therefore exposed via a **NodePort mapped to a host port through kind `extraPortMappings`** (the same mechanism 6c added for `:443`). Control plane pushes to `localhost:<hostPort>`; the identical blobs are pulled by pods via the Service DNS.

`EffectiveRegistry` is extended so a provisioned in-cluster registry yields the Service-DNS ref for manifest rendering (what the pod sees) while the push path uses the host-port endpoint.

### 6.2 UI bundle as an OCI artifact

A UI bundle becomes a standard OCI artifact: a small JSON **config blob** (artifact type `application/vnd.pragmatic.ui.config.v1+json`, carrying `{appName, appVersion, entry, assets[]}`), and a single **layer blob** that is a deterministic `tar` of the `ui/` tree (gzip optional; deterministic ordering + fixed mtime so the digest is reproducible). Push and pull speak the **OCI distribution HTTP API** (`/v2/<name>/blobs/uploads/`, `PUT …?digest=`, `PUT /v2/<name>/manifests/<ref>`, and the `GET` duals) directly over node `fetch` — no external tool. The artifact is tagged `<appName>-<appVersion>` and also addressable by manifest digest.

**My call (implementation):** a minimal OCI-distribution client/server-consumer over `fetch`, in both the control-plane push library and the in-pod unpack script, rather than a binary. Rationale in §4; marked as my decision, not the user's.

### 6.3 Signing and pod-side verification

Reuse the Ed25519 `ImageSigner`/`CryptoImageVerifier` trust-root model, retargeted from a docker-image id to the **artifact's OCI manifest digest** (introduce an `IArtifactDigest` that computes the sha256 of the canonical manifest bytes, parallel to `DockerImageDigest`). The signature is published as a **companion tag** the pod can fetch (`<tag>.sig`, a tiny artifact whose layer is the base64 signature) — the local analog of cosign's referrer, reusing the existing `FileSignatureStore` shape on the control-plane side.

**The integrity anchor is the env-spec `manifestDigest`, not the registry tag** (resolves builder-check #2). The registry is an untrusted blob store; the trusted channel is the Kubernetes API, over which the control plane delivers the expected `manifestDigest` into the env spec (§6.4). The unpack init container therefore applies **two independent checks, both fail-closed**:
1. **Digest pin:** recompute the sha256 of the fetched manifest bytes and require it to equal the env-spec `manifestDigest`. This alone defeats registry-side tampering and tag substitution/replay.
2. **Signature:** verify the Ed25519 signature over that digest against the mounted trust-root public key. The **signed payload binds `{appName, appVersion, manifestDigest}`** (not the bare digest), so a validly-signed artifact cannot be lifted onto a different app or version.

Verification moves **pod-side**: the unpack init container is given the hive **trust-root public key** via a mounted `ca.crt`-style Secret (the existing `SecretVolume` + `items` projection pattern; public key only, never the private signing key), fetches manifest + signature, runs both checks, and refuses to unpack on any failure. This is the one genuinely new location for verification (today it is control-plane-only at apply/roll); it is required because the control plane does not touch the bytes the pod unpacks. The trust-root pub-key Secret is **per-env**, named like the other per-env trust Secrets, and is **created by the deploy actuator at deploy time** (it resolves the hive `trustRootRef` to its public PEM and projects it) — so hive provisioning (Spec 1) carries no key-distribution responsibility (resolves builder-check #3). It is a distinct Secret from the 6c federation IdP-CA Secret (a different key with a different purpose), though it reuses the same projection mechanism.

### 6.4 Per-env app-version carrier and the deploy actuator

Today the rollout carrier is per-*hive* `{version, image}` (`RolloutTarget`/`SelectionRecord`). App/UI deploy is per-*env* and orthogonal to server-image rollout, so it gets its **own per-env carrier** rather than overloading the server-image target: an `AppDeploymentRecord { environmentId, appName, appVersion, artifactRef, manifestDigest, deployedAt }` persisted alongside the env, and surfaced to the pod as env spec (the existing `EnvironmentRecord` optional-capability-field pattern, e.g. `idpBaseDomain?`, flowing record→`EnvironmentWorkload`→manifest, exactly as `federation?` does).

The control-plane actuator `DeployAppToEnvironment(environmentId, params)`:
1. builds the OCI artifact from the UI bundle, pushes it, signs it;
2. records the `AppDeploymentRecord`;
3. triggers the pod to reconcile via a **rollout restart** of the env Deployment (`kubectl rollout restart`), so the unpack init container re-runs against the new ref.

**My call (implementation):** redeploy = record + rollout restart, reusing the init-container unpack model, rather than a live in-pod puller (§4 anti-goal). Rollback = record a prior `appVersion` + restart; because R6 keeps prior version trees on disk, rollback is a pointer flip with no re-pull when the version is still present.

**Reconcile target is the live-pointer state, not the unpack state** (resolves builder-check #4). The init container's job is: *make `<appName>/live` name the env-spec target version.* Unpack is skip-if-already-present-and-verified, but the `live` pointer flip **always runs** to match the env-spec target — otherwise a rollback to an already-on-disk version would restart the pod without moving `live` and keep serving the newer version. Unpack idempotence and pointer reconciliation are separate steps.

### 6.5 R6 version-scoped storage + atomic swap

In `AppIngestService` and `AppServingEndpoint`, UI moves from `<appName>/ui/…` to `<appName>/<version>/ui/…`, with a `<appName>/live` pointer: a small marker file naming the live version. `application.json` becomes version-scoped the same way. Serving reads the live pointer, then the version tree.

**Atomicity without cross-platform atomic rename** (resolves builder-check #5). The anti-mixed-version guarantee rests on **ordering, not on atomic rename-over-existing**: the entire `<version>/ui` tree + `<version>/application.json` are committed *first*; only then is the `live` pointer written, via the storage's normal overwrite write of a few-byte marker (not a rename over an existing file). This sidesteps the known gap that node `fs.rename` fails on an existing target on Windows — the Docker/direct path and the tests run on Windows, the PVC runs on Linux, and neither needs atomic replace. A reader that observes a half-written pointer (not expected for a tiny write, but treated as possible) validates that the named version directory exists and falls back rather than serving a mixed tree. (The implementer confirms `NodeFsStorage`'s overwrite-write truncates an existing key on all platforms; it does for `writeFile`.)

**Backward compatibility** (resolves builder-check #1): `AppServingEndpoint` **dual-reads** — when `<appName>/live` is absent it falls back to the legacy `<appName>/ui` + `<appName>/application.json` layout, so apps already deployed via the Docker/direct path keep serving after the storage change. No destructive migration; `AppIngestService` simply writes the new version-scoped layout going forward. In-cluster envs have no pre-existing apps, so they are unaffected.

This is the shared-storage change that makes both the in-cluster unpack and the Docker/direct ingest atomic and rollback-capable; it closes R6.

### 6.6 The unpack init container

A second init container on the env Deployment (sibling to `ServerSeedContainer`), running a node script in the pulled `workload.image` (no new binary), parameterised by the registry Service-DNS endpoint, the artifact ref + expected manifest digest (from env spec), and the mounted trust-root pub key. It pulls manifest+layer+signature over `fetch`, verifies, unpacks the tar into `<appName>/<version>/ui` on the data PVC guarding path escape (as `ServerSeedScript` does), writes the version-scoped `application.json`, and flips the `live` pointer last. Idempotent: a version already present + verified is a no-op (marker per version).

## 7. Decomposition into sub-specs (execution order)

Each sub-spec is independently testable and merges locally on its own; the program is executed in this order, compacting between specs.

- **Spec 1 — In-cluster OCI registry workload.** `registry:2` Deployment + Service + PVC rendered per hive (provision mode), NodePort + kind `extraPortMappings` for host-push reachability, `EffectiveRegistry` extended to the two-address model, a readiness gate, anonymous in dev. Deliverable: a registry reachable from host (push) and pods (pull), proven by a `/v2/` round-trip of a blob.
- **Spec 2 — OCI artifact push/pull + signing (the artifact library + R6 storage).** The minimal OCI-distribution `fetch` client (push + pull), the UI-bundle↔artifact (de)serialization (deterministic tar), `IArtifactDigest` + artifact signer/verifier over the existing Ed25519 trust root, and the R6 version-scoped storage + atomic swap in `AppIngestService`/`AppServingEndpoint`. Deliverable: control-plane can push a signed UI artifact and a unit-level pull+verify+unpack reproduces the tree; Docker/direct UI redeploys are atomic.
- **Spec 3 — Per-env carrier, deploy actuator, and the unpack init container.** `AppDeploymentRecord` + env-spec plumbing (record→workload→manifest), `DeployAppToEnvironment` actuator (build→push→sign→record→rollout restart), the unpack init container with mounted trust-root pub key and pod-side verify. Deliverable: deploying to an in-cluster env lands verified UI on the PVC and the pod serves it.
- **Spec 4 — Demo UI bundle + full e2e smoke.** Give the northwind demo a minimal real UI bundle (`bundle.ts` writes a `ui` field + assets); a gated kind smoke: build → push → create/redeploy env → pod pull+verify+unpack → Playwright hits `<env>.<baseDomain>/app/<tenant>/northwind/` and asserts the rendered UI; plus a tamper test (a mutated layer fails pod-side verify and the pod does not serve). Deliverable: the loop proven end to end.

## 8. What's left to the builder

- Exact OCI media types / artifact-type strings (within the `application/vnd.pragmatic.ui.*` family), the tar determinism recipe (entry ordering, mode/mtime normalization), and manifest canonicalization for a reproducible digest.
- Registry `registry:2` version pin, PVC size, NodePort number + host-port mapping choice, and readiness-probe shape.
- Whether the unpack init container shares the existing `ServerSeedContainer`'s volume/marker conventions verbatim or defines its own sibling marker (`.ui-<version>-unpacked`).
- The precise `AppDeploymentRecord` persistence location (same store family as `EnvironmentRecord`) and the control-plane admin surface that invokes `DeployAppToEnvironment` (CLI vs tenant-admin action — may land minimally as a CLI/test entry in this program and get a UI later).
- Test doubles for the registry in unit scope (an in-memory `/v2/` consumer) vs the gated real `registry:2` in the smoke.

## 9. Open decisions resolved in this document

- Delivery = in-cluster OCI registry, pod pulls (user).
- R6 version-scoped storage + atomic swap included (user).
- Full registry-substrate program, not the lighter deploy-over-WS path (user).
- OCI over `fetch`, no new binary (my call, §6.2).
- Registry anonymous in dev, attach/auth deferred (my call, §3).
- Redeploy = record + rollout restart, no live in-pod puller (my call, §6.4).
- Per-env app carrier separate from the per-hive server-image target (my call, §6.4).
- Signature carried as a companion tag, verified pod-side via a mounted trust-root pub key (my call, §6.3).
- Integrity anchor = env-spec `manifestDigest` (k8s-API-delivered), with digest-pin + signature both fail-closed and `{appName,appVersion,manifestDigest}` bound into the signed payload (my call, §6.3 — builder-check #2).
- Trust-root pub key projected per-env by the deploy actuator at deploy time; hive provisioning distributes no keys (my call, §6.3 — builder-check #3).
- Init container reconciles to the live-pointer target; unpack is skip-if-present but the pointer flip always runs (my call, §6.4 — builder-check #4).
- R6 atomicity via tree-before-pointer ordering + overwrite-write of the marker (no atomic rename-replace dependency); `AppServingEndpoint` dual-reads the legacy layout for already-deployed apps (my call, §6.5 — builder-check #1, #5).
