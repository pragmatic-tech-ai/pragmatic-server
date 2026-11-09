# Platform images, piece 1 — per-app images, GitHub release workflow, releases in the portal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `release/X.Y.Z` tag on pragmatic-server builds eight per-app images on GitHub, pushes them to private GHCR with one uniform version, signs their registry digests and records a release descriptor; platform-admin lists and verifies those releases from GHCR and shows them in the Platform Admin portal.

**Architecture:** A dependency-free release toolkit under `admin/control-plane/release/` (descriptor, tag parsing, Ed25519 signing in the existing scheme, an authenticated OCI client) is shared by the workflow's publisher CLI and by platform-admin's `ReleaseCatalog`. Images come from one multi-target Dockerfile driven by Docker Buildx Bake, each target copying only its app's package closure (checked in CI). The existing manifest catalogue gains a `release` payload; gating works on imported releases; hive rollout keeps today's path until piece 2.

**Tech Stack:** TypeScript (Node 22, `node:test` via `tsx --test`), Docker Buildx Bake, GitHub Actions, OCI distribution API (GHCR), Mural MVVM portal.

**Spec:** `docs/superpowers/specs/2026-11-09-platform-images-design.md` (piece 1 = §6 item 1; §4.1–4.4).

## Global Constraints

- OOP, Allman braces, PascalCase public members and interfaces, no inline string literals (hoist to `private static readonly`), no module-level functions or mutable state; tests in `tests/` folders; LF endings (pre-existing CRLF files keep CRLF).
- No new binary dependency: no cosign, crane, skopeo, oras. Docker Buildx, `docker`, `kubectl`, `openssl`, `git`, `curl` only.
- Signing happens only in the release workflow. Platform-admin holds public keys only.
- Signature scheme = the existing one (`CryptoImageVerifier`): Ed25519 over the UTF-8 bytes of the digest string `sha256:<64 hex>`, signature base64.
- Images are referenced by digest everywhere the platform renders or records them.
- No token, password, credential or private key in an image layer, workflow log, process argument, log line, error sentence or response body.
- Uniform version: every image of release `X.Y.Z` is tagged `:X.Y.Z` (plus `:git-<server sha>`).
- Registry: `ghcr.io`, namespace `pragmatic-tech-ai`, private. Image names exactly: `pragmatic-platform-admin`, `pragmatic-platform-edge`, `pragmatic-env-server`, `pragmatic-env-gateway`, `pragmatic-hive-agent`, `pragmatic-tenant-admin`, `pragmatic-tenant-idp`, `pragmatic-ui-unpack`; descriptor repository `pragmatic-release`.
- Only pragmatic-server is tagged; siblings build from their `main` head and their commits are recorded.
- Commit identity: `-c user.name="Eugene Napryaglo" -c user.email="evgen.napryaglo@gmail.com"`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path. Never push.

## Rulings against the spec (made while planning)

- **R1 — apply-time signing removal moves to piece 2.** Spec §6.1 lists it in piece 1, but until piece 2 hives still run the locally built `pragmatic-server:dev`, which only passes verification because the platform signs it at apply. Removing that now breaks in-cluster environment creation on the laptop, against "each piece leaves the platform working". Piece 2 removes it together with the switch to release images. Cost if wrong: one more piece carries the old path.
- **R2 — `docker/Dockerfile` and `pragmatic-server:dev` stay until piece 2** for the same reason (the hives' current image). `ci.yml` stops building it; Bake builds the eight new images instead.
- **R3 — `pragmatic-platform-edge` in piece 1** is an image of today's control plane started with a flag that runs only the agent-channel listener (`PRAGMATIC_CONTROL_PLANE_ROLE=edge`), since the real split is piece 3. Both platform images share one closure until then. Cost if wrong: piece 3 rewrites the entrypoint, which it does anyway.
- **R4 — imported releases cannot yet be selected for a hive.** Hives cannot pull from GHCR until the proxy (piece 2). `SelectTarget` on a release-backed record refuses with a plain sentence; gating, listing and withdrawal work. Piece 2 removes the guard.
- **R5 — channel from the tag:** `release/X.Y.Z` → `Channel.Stable`; `release/X.Y.Z-early.N` → `Channel.EarlyAccess`. Anything else is refused.

## Review Focus

1. GHCR answers a tag with an **OCI image index** (Buildx adds attestation manifests), not a single manifest → `HeadManifest` must send index media types in `Accept` and return the index digest from `Docker-Content-Digest`. Pinned in Task 2.
2. **Partial or broken releases:** descriptor missing (build died before the last step) → the version is simply not listed; descriptor present but one image digest absent from the registry → recorded as Rejected, never gateable. Pinned in Task 6.
3. **Tampered or foreign descriptor:** layer bytes whose digest ≠ the manifest's layer digest, descriptor signature by a key not in the trust set, or an image signature failure → Rejected with a reason naming the image/key id only. Pinned in Task 6.
4. **Registry down or credential wrong during a poll** → existing catalogue untouched, a typed error with no token text, `POST /api/releases/refresh` answers 502; the periodic poll logs and carries on. Pinned in Tasks 6 and 7.
5. **Malformed tags** (`release/1.4`, `release/v1.4.0`, `release/1.4.0-rc1`) → the workflow fails before building anything. Pinned in Task 1 (`ReleaseTag`) and used by Task 5's first step.

---

## File map

- `admin/control-plane/release/release-tag.ts` — parse `release/X.Y.Z[-early.N]` → version + channel.
- `admin/control-plane/release/release-descriptor.ts` — `ReleaseDescriptor` type, `ReleaseApp` enum, codec (canonical bytes, parse + validate).
- `admin/control-plane/release/release-signature.ts` — Ed25519 sign/verify over a digest string.
- `admin/control-plane/release/release-trust-keys.ts` — trusted public keys from a directory.
- `admin/control-plane/oci-registry-client.ts` — gains bearer-challenge auth, `ListTags`, `HeadManifest`, `PushArtifact`, `PullArtifactLayer`.
- `admin/control-plane/release/release-publisher.ts` + `bin/pragmatic-release-publish.ts` — what the workflow runs.
- `admin/control-plane/release/release-catalog.ts` — platform-admin's refresh/verify/import.
- `admin/control-plane/manifest-record.ts`, `platform-deployment-registry.ts`, `rollout-errors.ts`, `control-plane-host.ts`, `server.ts` — release payload, import, guard, routes, config.
- `docker/images/Dockerfile`, `docker/docker-bake.hcl`, `docker/images/closure.json`, `docker/images/closure-check.ts` — per-app images.
- `.github/workflows/release.yml` (new), `ci.yml` (changed), `image.yml` (deleted).
- `admin/portal/src/api-client.ts`, `admin/portal/src/sections/releases/*` — portal.
- `release-keys/release-2026-11.pub.pem` — the trusted public key (already generated, uncommitted).
- `admin/README.md`, `ARCHITECTURE.md`, `helm/pragmatic-server/values.yaml` — docs.

---

### Task 1: Release toolkit — tag, descriptor, signature, trust keys

**Files:**
- Create: `admin/control-plane/release/release-tag.ts`, `release-descriptor.ts`, `release-signature.ts`, `release-trust-keys.ts`
- Create: `admin/control-plane/release/tests/release-tag.test.ts`, `release-descriptor.test.ts`, `release-signature.test.ts`, `release-trust-keys.test.ts`
- Add: `release-keys/release-2026-11.pub.pem` (already on disk; commit it here)

**Interfaces — Produces:**
- `enum ReleaseApp { PlatformAdmin = 'pragmatic-platform-admin', PlatformEdge = 'pragmatic-platform-edge', EnvServer = 'pragmatic-env-server', EnvGateway = 'pragmatic-env-gateway', HiveAgent = 'pragmatic-hive-agent', TenantAdmin = 'pragmatic-tenant-admin', TenantIdp = 'pragmatic-tenant-idp', UiUnpack = 'pragmatic-ui-unpack' }` and `ReleaseApps.All: readonly ReleaseApp[]` (that order).
- `class ReleaseTag { static Parse(ref: string): ReleaseTag; readonly Version: string; readonly Channel: Channel }`; accepts `release/X.Y.Z` and `refs/tags/release/X.Y.Z`; throws `ReleaseTagInvalidError(ref)`.
- `type ReleaseImage = { repository: string; digest: string; signature: string }`
- `type ReleaseDescriptor = { schema: 1; version: string; channel: Channel; serverCommit: string; siblingCommits: Record<string, string>; builtAt: string; signingKeyId: string; images: Record<ReleaseApp, ReleaseImage> }`
- `class ReleaseDescriptorCodec { static Encode(d: ReleaseDescriptor): Uint8Array; static Decode(bytes: Uint8Array): ReleaseDescriptor }` — Encode is canonical (keys sorted recursively, no whitespace) so its sha256 is stable; Decode throws `ReleaseDescriptorInvalidError(reason)` when any field is missing/ill-shaped, any `ReleaseApp` is absent, a digest is not `sha256:<64 hex>`, or a commit is not 40 hex.
- `class ReleaseSignature { static Sign(digest: string, privateKeyPem: string): string; static Verifies(digest: string, signature: string, publicKeyPem: string): boolean }` (never throws from Verifies).
- `class ReleaseTrustKeys { static FromDirectory(dir: string): ReleaseTrustKeys; KeyFor(keyId: string): string | undefined; get Ids(): readonly string[] }` — loads every `<id>.pub.pem`; id = file name minus `.pub.pem`; ignores other files; a key that is not an Ed25519 public key throws `ReleaseTrustKeyInvalidError(id)`.

- [ ] **Step 1: Write the failing tests**
  - `release-tag.test.ts`: `Parse('release/1.4.0')` → `1.4.0`/Stable; `Parse('refs/tags/release/2.0.1-early.3')` → `2.0.1-early.3`/EarlyAccess; each of `release/1.4`, `release/v1.4.0`, `release/1.4.0-rc1`, `v1.4.0`, `release/01.4.0` throws `ReleaseTagInvalidError`.
  - `release-descriptor.test.ts`: Encode→Decode round-trips a full descriptor; Encode of two objects with different key insertion order gives identical bytes; Decode rejects a missing `pragmatic-ui-unpack` entry, a digest `sha256:abc`, and `schema: 2`.
  - `release-signature.test.ts`: with a key from `generateKeyPairSync('ed25519')`, Sign then Verifies → true; flipped digest → false; another key → false; garbage signature → false. Cross-check: a signature from `ReleaseSignature.Sign` passes `CryptoImageVerifier.Verify` (fake digest/store/key-store seams), proving the scheme matches.
  - `release-trust-keys.test.ts`: a temp dir with `a.pub.pem`, `b.pub.pem`, `notes.txt` → `Ids` = `['a','b']`; `KeyFor('c')` undefined; an RSA public key file throws `ReleaseTrustKeyInvalidError('bad')`; the committed `release-keys/` dir loads id `release-2026-11`.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/release/tests/*.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** the four files. These files and Tasks 2–3's code import only `node:*` builtins and each other (the workflow runs them with `npx --yes tsx@4` and no `npm install`).
- [ ] **Step 4: Run** the same command → PASS; `npm run typecheck:tools` clean.
- [ ] **Step 5: Commit** the four sources, four tests and `release-keys/release-2026-11.pub.pem` — `feat(release): release tag, descriptor, signature and trust keys`.

### Task 2: Authenticated OCI client for GHCR

**Files:**
- Modify: `admin/control-plane/oci-registry-client.ts`
- Test: `admin/control-plane/tests/oci-registry-client-auth.test.ts` (new; existing OCI tests stay green)

**Interfaces — Produces** (on `OciRegistryClient`; constructor gains optional third param `credential?: RegistryCredential`):
- `type RegistryCredential = { username: string; token: string }`
- `ListTags(repo: string): Promise<string[]>` — `GET /v2/<repo>/tags/list`, follows `Link: <...>; rel="next"` pagination; `[]` on 404.
- `HeadManifest(repo: string, reference: string): Promise<string | undefined>` — `HEAD /v2/<repo>/manifests/<ref>` with `Accept` = OCI index, OCI manifest, Docker manifest list v2, Docker manifest v2; returns `Docker-Content-Digest`; `undefined` on 404.
- `PushArtifact(repo: string, tag: string, artifactType: string, layerMediaType: string, layer: Uint8Array, annotations: Record<string, string>): Promise<string>` — pushes the empty config (`application/vnd.oci.empty.v1+json`, bytes `{}`) and the layer as blobs, then an OCI image manifest with `artifactType`, one layer and `annotations`; returns the manifest digest.
- `PullArtifactLayer(repo: string, tag: string): Promise<{ layer: Uint8Array; layerDigest: string; annotations: Record<string, string> }>` — pulls the manifest, then its single layer; throws `OciResponseError` if the pulled bytes' sha256 ≠ the manifest's layer digest.
- Auth: on any 401 carrying `WWW-Authenticate: Bearer realm=...,service=...,scope=...`, fetch `realm?service=&scope=` with `Authorization: Basic base64(username:token)`, cache the bearer per scope, retry once. A second 401 → `OciResponseError(401, 'The OCI registry refused the credential')`. No credential and a 401 → same error. The token never appears in any error message.

- [ ] **Step 1: Write the failing tests** (fake `OciFetch` that records requests):
  - challenge flow: first `GET tags/list` → 401 + Bearer challenge; client calls realm with Basic auth of `u:t`, then retries with `Bearer <issued>`; returns tags from two pages linked via `Link`.
  - `HeadManifest` sends all four media types in `Accept` and returns `sha256:<index digest>` for a response whose `Content-Type` is the OCI index type (Review Focus 1).
  - `HeadManifest` on 404 → `undefined`.
  - `PushArtifact` then `PullArtifactLayer` round-trip against an in-memory fake registry returns the same layer bytes and annotations; a fake that serves altered layer bytes → `OciResponseError`.
  - a refused credential → error whose `message` does not contain the token string.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/oci-registry-client*.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement** in `oci-registry-client.ts` (keep the auth handling in a small private `RegistryBearerAuth` class in the same file).
- [ ] **Step 4: Run** → PASS (old and new).
- [ ] **Step 5: Commit** `feat(oci): bearer auth, tag listing, digest HEAD and artifact push/pull`.

### Task 3: Release publisher and its CLI

**Files:**
- Create: `admin/control-plane/release/release-publisher.ts`, `admin/control-plane/bin/pragmatic-release-publish.ts`
- Test: `admin/control-plane/release/tests/release-publisher.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ReleaseApp`, `ReleaseApps.All`, `ReleaseDescriptorCodec`, `ReleaseSignature`, `ReleaseTag`), Task 2 (`OciRegistryClient` with credential).
- Produces:
  - `class ReleasePublisher { constructor(registry: OciRegistryClient, namespace: string, clock?: () => Date); CheckVersionFree(version: string): Promise<void>; Publish(input: ReleasePublishInput): Promise<ReleaseDescriptor> }`
  - `type ReleasePublishInput = { tag: ReleaseTag; serverCommit: string; siblingCommits: Record<string, string>; signingKeyId: string; privateKeyPem: string }`
  - Constants: descriptor repository `pragmatic-release`; `artifactType` `application/vnd.pragmatic.release.v1`; layer media type `application/vnd.pragmatic.release.v1+json`; annotations `org.pragmatic.release.signature` (base64 signature over the layer digest string) and `org.pragmatic.release.key` (key id).
  - Errors: `ReleaseVersionExistsError(version)` (a `pragmatic-release:<version>` tag exists); `ReleaseImageMissingError(app, version)` (an image tag is absent).
- `Publish`: for each app in `ReleaseApps.All`, `HeadManifest('<ns>/<app>', version)` → digest (missing → `ReleaseImageMissingError`), sign it; build the descriptor (`builtAt` from clock, ISO); encode; sign the encoded bytes' digest; `PushArtifact('<ns>/pragmatic-release', version, ...)` **last**.
- CLI `pragmatic-release-publish.ts` (one class `ReleasePublishCli` with a static `Run(argv, env)`; the bin calls `Run().catch(Fail)` as `pragmatic-idpd.ts` does): commands `check --tag <ref>` and `publish --tag <ref> --server-commit <sha> --siblings-file <path> --key-id <id>`; reads the private key from the file named by env `RELEASE_SIGNING_KEY_FILE`, the registry credential from env `RELEASE_REGISTRY_USER` + `RELEASE_REGISTRY_TOKEN`, registry host from `RELEASE_REGISTRY` (default `ghcr.io`), namespace from `RELEASE_NAMESPACE` (default `pragmatic-tech-ai`). Prints only the version and digests. Exit 1 with the error sentence on failure.

- [ ] **Step 1: Write the failing tests** (in-memory fake registry from Task 2's tests, moved to `admin/control-plane/tests/fake-oci-registry.ts` if shared):
  - happy path: eight image tags present → descriptor pushed; it decodes, every image signature verifies with the public key, the annotation signature verifies over the layer digest; the descriptor push is the last request recorded.
  - one image tag missing → `ReleaseImageMissingError('pragmatic-ui-unpack','1.4.0')` and **no** descriptor pushed.
  - `CheckVersionFree('1.4.0')` with an existing descriptor tag → `ReleaseVersionExistsError`.
  - CLI: `check --tag release/1.4` exits 1 with the `ReleaseTagInvalidError` sentence (Review Focus 5); stdout of a successful publish contains no part of the key PEM or token.
  - closure guard: the import graph of `pragmatic-release-publish.ts` (walk relative imports from the file text) contains only `node:` specifiers and relative paths.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/release/tests/release-publisher.test.ts` → FAIL.
- [ ] **Step 3: Implement** publisher and CLI.
- [ ] **Step 4: Run** → PASS; `npm run typecheck:tools` clean.
- [ ] **Step 5: Commit** `feat(release): publisher and release-publish CLI`.

### Task 4: Cut Docker/kind code out of the tenant-admin closure

**Files:** determined by the investigation; expected around `admin/control-plane/tenant-admin-server.ts`, `bin/pragmatic-tenant-admind.ts`, `environment-service.ts`, `environments/seed/*`.
**Test:** `admin/control-plane/tests/tenant-admin-closure.test.ts` (new).

**Interfaces — Produces:** no new public API; the tenant-admind import graph changes only.

- [ ] **Step 1: Write the failing test** `tenant-admin closure carries no dev-box drivers`: run esbuild's metafile build of `admin/control-plane/bin/pragmatic-tenant-admind.ts` (`--bundle --platform=node --format=esm --packages=external --metafile`, output to `os.tmpdir()`) and assert no input path matches `environments/seed/docker.ts`, `docker-env-port.ts`, `docker-idp-driver.ts`, `idp-container-env.ts`, `kind-image-loader.ts`, `kind.ts`. (esbuild is resolvable from the server's dependencies; if not, from `../TODL/node_modules`.)
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/tenant-admin-closure.test.ts` → FAIL listing the offending paths.
- [ ] **Step 3: Cut the chains** by moving the Docker/kind-specific construction to the control-plane composition (`server.ts`) behind the existing seams (`IEnvironmentRuntime`, `EnvironmentRuntimeResolver`, the IdP driver interface), so the tenant-admin composition root never imports them. Then check whether TODL/Mural are still reached: if only through `environments/seed/compile.ts` and in-cluster creation does not compile TODL, cut that too and add `TODL`/`Mural` to the test's forbidden list; if it genuinely compiles, keep them and record why in the test as a comment.
- [ ] **Step 4: Run** the new test → PASS; `npx tsx --test "admin/control-plane/**/*.test.ts"` all green; `npm run typecheck:tools` clean.
- [ ] **Step 5: Commit** `refactor(tenant-admin): keep dev-box Docker and kind drivers out of the tenant admin app`.

### Task 5: Per-app images, closure check, workflows

**Files:**
- Create: `docker/images/Dockerfile`, `docker/docker-bake.hcl`, `docker/images/closure.json`, `docker/images/closure-check.ts`, `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`, `src/bin` or `admin/control-plane/server.ts` (edge role flag, R3)
- Delete: `.github/workflows/image.yml`
- Test: `docker/images/tests/closure-check.test.ts`, `admin/control-plane/tests/control-plane-role.test.ts`

**Interfaces — Produces:**
- `closure.json`: `{ "<ReleaseApp>": { "entrypoint": ["node", "<path>"], "packages": ["<sibling dir>", ...], "files": ["<extra built dir>", ...] } }` for all eight apps. Entrypoints: platform-admin / platform-edge → the compiled control plane server (`dist-tenant-admin/admin/control-plane/server.js` or wherever the tenant-admin tsconfig emits it — the control plane is compiled, not run with tsx, inside the image); env-server → `dist/bin/pragmatic-serverd.js` (worker: same image, command `node dist/bin/pragmatic-workerd.js`); env-gateway → `dist/bin/pragmatic-gatewayd.js`; hive-agent → `dist/bin/pragmatic-agentd.js`; tenant-admin → `dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js`; tenant-idp → `dist/bin/pragmatic-idpd.js`; ui-unpack → `dist-tenant-admin/admin/control-plane/bin/pragmatic-ui-unpack.js`.
- `class ClosureCheck { static Run(workspaceRoot: string): ClosureReport }` — for each app, builds an esbuild metafile from the entry's TypeScript source and reports sibling packages reached vs `closure.json` (`missing` = reached but not listed; `extra` = listed but not reached). CI fails on any `missing` or `extra`.
- `PRAGMATIC_CONTROL_PLANE_ROLE` = `all` (default, today's behaviour) | `edge` (start only the agent-channel listener) | `admin` (everything except the agent-channel listener).

- [ ] **Step 1: Write the failing tests**
  - `closure-check.test.ts`: on a fixture workspace of three tiny packages, an entry importing `a` with `closure.json` listing `a,b` reports `extra: ['b']`; listing nothing reports `missing: ['a']`.
  - `control-plane-role.test.ts`: role `edge` composes the agent channel and not the operator host; `admin` the reverse; an unknown role throws a typed error naming the variable only.
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement**
  - `ClosureCheck` + `closure.json` (fill from a real run; agent/gateway/idp/ui-unpack must not list TODL or Mural).
  - The role flag in `server.ts` composition.
  - `docker/images/Dockerfile`: a `build` stage that installs the C toolchain, copies and builds each sibling in dependency order (as today's Dockerfile, with the npm token as a BuildKit secret) plus the server's `build`, `build:tenant-admin`, `admin/portal`, `admin/tenant-portal` and `idp-login` builds, then `npm prune --omit=dev` per package; one runtime target per app on `node:22-slim` (pinned by digest), uid 10001, `WORKDIR /workspace/pragmatic-server`, copying **only** the dirs in that app's `closure.json` entry, its own `ENTRYPOINT`, `HEALTHCHECK` on `/healthz` for env-server, env-gateway, tenant-admin, tenant-idp, platform-admin. tenant-idp installs the `openssl` CLI. hive-agent copies only `pragmatic-server/dist` and `package.json` (no `node_modules`).
  - `docker/docker-bake.hcl`: variables `VERSION`, `SERVER_SHA`, `REGISTRY` (default `ghcr.io/pragmatic-tech-ai`); group `default` = the eight targets; each target tagged `${REGISTRY}/<app>:${VERSION}` and `${REGISTRY}/<app>:git-${SERVER_SHA}`; secret `npmrc`; context = workspace root.
  - `ci.yml`: replace the "Docker build" step with `docker buildx bake -f pragmatic-server/docker/docker-bake.hcl` (no push, `VERSION=ci`) and add `npx tsx pragmatic-server/docker/images/closure-check.ts` after the sibling build.
  - `release.yml`: `on: push: tags: ['release/*']`; `permissions: contents: read, packages: write`; steps — checkout at the tag into `pragmatic-server`; `npx --yes tsx@4 pragmatic-server/admin/control-plane/bin/pragmatic-release-publish.ts check --tag "$GITHUB_REF"` (fails fast on a malformed tag or an existing version, before any clone or build); clone each sibling at `main` (same list as `ci.yml`) and write `{ "<repo>": "<sha>" }` to `$RUNNER_TEMP/siblings.json`; `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`; `docker/setup-buildx-action`; npmrc from `PACKAGES_TOKEN` into `$RUNNER_TEMP` (removed after); `docker buildx bake --push` with `VERSION`, `SERVER_SHA`; write `secrets.RELEASE_SIGNING_KEY` to `$RUNNER_TEMP/release.key` under `umask 077` (never echoed); run `publish` with `RELEASE_REGISTRY_USER=${{ github.actor }}`, `RELEASE_REGISTRY_TOKEN=${{ secrets.GITHUB_TOKEN }}`, `--key-id release-2026-11`; always remove the key file.
  - Delete `image.yml`.
- [ ] **Step 4: Verify**
  - Both tests PASS.
  - `npx tsx docker/images/closure-check.ts` (from the workspace root, after siblings are built) → no missing/extra.
  - Local build of all eight: `docker buildx bake -f pragmatic-server/docker/docker-bake.hcl --set *.output=type=docker` from `D:\architecture-agent` with a local npmrc secret → eight images. Record each image's size in the task report; hive-agent and ui-unpack must be under 300 MB.
  - Each image's entry parses: `docker run --rm --entrypoint node <image> --check <entry path>`. Each image's closure loads: start it with no configuration for up to 10 s and expect the app's own configuration/startup error sentence (not `ERR_MODULE_NOT_FOUND`); hive-agent and ui-unpack included. If the control plane `server.ts` is not emitted by `tsconfig.tenant-admin.json`, extend that config's `include` to emit it (the image runs compiled JS, not tsx).
- [ ] **Step 5: Commit** the new/changed files and the deletion — `feat(images): one image per app via Buildx Bake; release and CI workflows`.

### Task 6: Release catalogue in platform-admin

**Files:**
- Create: `admin/control-plane/release/release-catalog.ts`
- Modify: `admin/control-plane/manifest-record.ts`, `platform-deployment-registry.ts`, `rollout-errors.ts`
- Test: `admin/control-plane/release/tests/release-catalog.test.ts`, extend `admin/control-plane/tests/platform-deployment-registry*.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `ManifestRecord.release?: ManifestRelease` where `type ManifestRelease = { state: ReleaseState; serverCommit?: string; siblingCommits?: Record<string, string>; builtAt?: string; signingKeyId?: string; images?: Record<ReleaseApp, { repository: string; digest: string }>; rejectedReason?: string }` and `enum ReleaseState { Verified = 'verified', Rejected = 'rejected' }`. For a verified release: `id` = version, `channel` from the descriptor, `image` = `ghcr.io/pragmatic-tech-ai/pragmatic-env-server@<digest>`, `digest` = that digest, `signed` = true, `publishedAt` = `builtAt`.
  - `PlatformDeploymentRegistry.ImportRelease(record: ManifestRecord): Promise<void>` (throws `ManifestExistsError` if the id exists).
  - `PlatformDeploymentRegistry.Gate` throws `ReleaseRejectedError(version)` (409) for a Rejected record; `SelectTarget` throws `ReleaseNotRunnableYetError(version)` (409, sentence: "Release <v> is in the registry but hives cannot run registry releases yet.") for any record with `release` set (R4).
  - `class ReleaseCatalog { constructor(registry: OciRegistryClient, namespace: string, trust: ReleaseTrustKeys, deployments: PlatformDeploymentRegistry); Refresh(): Promise<ReleaseRefreshResult> }`, `type ReleaseRefreshResult = { imported: string[]; rejected: string[]; unchanged: number }`; registry/credential failures surface as `ReleaseRegistryUnavailableError` (message without token text).
- `Refresh`: `ListTags('<ns>/pragmatic-release')`; for each tag that is a valid `ReleaseTag` version not already a record: `PullArtifactLayer`, decode, check the annotation key id is trusted and the signature verifies over `layerDigest`, check every image: `HeadManifest` equals the descriptor digest and its signature verifies; all pass → Verified record; any failure → Rejected record with a reason naming the check and the app or key id. Versions already present are counted `unchanged` (idempotent).

- [ ] **Step 1: Write the failing tests** (fake registry + generated key pair):
  - verified import: record fields as above; second `Refresh` → `unchanged: 1`, no duplicate.
  - image digest in the registry differs from the descriptor → Rejected, reason names the app (Review Focus 2).
  - descriptor signed by an untrusted key → Rejected, reason names the key id; altered layer bytes → Rejected (Review Focus 3).
  - a tag `latest` or `release-notes` in the descriptor repo is ignored.
  - registry unreachable → `ReleaseRegistryUnavailableError`, records unchanged (Review Focus 4).
  - `Gate` on a Rejected record → `ReleaseRejectedError`; `SelectTarget` on a verified release → `ReleaseNotRunnableYetError`; `SelectTarget` on an old-style record (no `release`) still works.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/release/tests/release-catalog.test.ts admin/control-plane/tests/platform-deployment-registry*.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; full `admin/control-plane` suite green.
- [ ] **Step 5: Commit** `feat(release): platform-admin release catalogue verifies and imports GHCR releases`.

### Task 7: Host routes, configuration, poll

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`, `admin/control-plane/server.ts`
- Delete: `admin/control-plane/manifest-publish.ts` (and its README section; its tests if any)
- Test: extend the control-plane host tests (the file that covers `/api/manifests`)

**Interfaces — Produces:**
- `POST /api/releases/refresh` (mutation → Full operators only via the central gate) → 200 `ReleaseRefreshResult`; 409 `{ error: 'The release registry is not configured.' }` when no catalogue; 502 on `ReleaseRegistryUnavailableError`.
- `POST /api/manifests` removed (falls through to the existing unknown-route answer). `GET /api/manifests` unchanged, now carrying `release`.
- Error map adds `ReleaseRejectedError` → 409, `ReleaseNotRunnableYetError` → 409.
- `server.ts` config: `PRAGMATIC_RELEASE_CREDENTIAL_FILE` (JSON `{ "username": "...", "token": "..." }`; absent → no catalogue), `PRAGMATIC_RELEASE_REGISTRY` (default `https://ghcr.io`), `PRAGMATIC_RELEASE_NAMESPACE` (default `pragmatic-tech-ai`), `PRAGMATIC_RELEASE_TRUST_DIR` (default `<repo>/release-keys`), `PRAGMATIC_RELEASE_POLL_SECONDS` (default 300; 0 disables). The poll calls `Refresh` and logs `imported`/`rejected` counts or the error sentence.

- [ ] **Step 1: Write the failing tests:** refresh as Full → 200 with the fake catalogue's result; as Observer → 403; no catalogue → 409 sentence; unavailable → 502 and body without the token; `POST /api/manifests` → no longer publishes (404/405 per the host's existing unknown-route behaviour); `POST /api/hives/:id/target` with a release version → 409 sentence.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; thread the catalogue as an optional constructor dependency (follow how other optional services are passed); delete `manifest-publish.ts`; update smokes that called the CLI (they call `deployments.Publish` in-process, which stays).
- [ ] **Step 4: Run** the full `admin/control-plane` suite and `npm run typecheck:tools` → green.
- [ ] **Step 5: Commit** `feat(control-plane): refresh releases from the registry; drop manual publish`.

### Task 8: Portal — releases come from the registry

**Files:**
- Modify: `admin/portal/src/api-client.ts`, `admin/portal/src/portal-types.ts` (or wherever `ManifestDto` mirrors), `admin/portal/src/sections/releases/releases-page-view-model.ts`, `release-detail-page-view-model.ts`, `releases-section-service.ts`, `releases.resources.mu`, `releases.module.mu`
- Delete: `admin/portal/src/sections/releases/publish-dialog-view-model.ts` and its markup/resources
- Test: `admin/portal/src/sections/releases/tests/releases-section.test.ts`

**Interfaces — Produces:**
- `ControlPlaneClient.RefreshReleases(): Promise<ReleaseRefreshDto>`; `PublishManifest` removed.
- Releases page: the "Publish a version" command becomes **"Refresh from registry"** (a `MutatingCommand`, so Observers see it disabled with the role hint), which shows "Imported N, rejected M" afterwards; the list gains a **Verification** column (`Verified` / `Rejected`).
- Release detail page: built-at, server commit (short + full on hover/copy), signer key id, a table of the eight images (app, short digest), sibling commits (repo, short sha), and the rejected reason when Rejected; the existing withdraw/restore and gating views unchanged.

- [ ] **Step 1: Write the failing tests:** refresh command calls the client and sets the result text; Observer → command disabled; a Verified release's detail VM exposes eight image rows in `ReleaseApps.All` order; a Rejected release exposes its reason and the list shows `Rejected`; no publish dialog type exists.
- [ ] **Step 2: Run** `cd admin/portal && npm test` → FAIL.
- [ ] **Step 3: Implement** (Mural MVVM; VMs extend `Observable`; labels hoisted; `.mu` labels stay inline).
- [ ] **Step 4: Run** `npm test` and the portal typecheck → green; open the portal with a fake catalogue and eyeball both pages.
- [ ] **Step 5: Commit** `feat(portal): releases from the registry with images, commits and verification`.

### Task 9: Docs and the live-run runbook

**Files:** `admin/README.md`, `ARCHITECTURE.md`, `helm/pragmatic-server/values.yaml`

- [ ] **Step 1:** `admin/README.md`: replace the publish section with the release flow (tag `release/X.Y.Z` on pragmatic-server → workflow → GHCR → portal Refresh), the `PRAGMATIC_RELEASE_*` variables, how to create the read-only GHCR token (classic PAT, only `read:packages`) and the credential file shape, the trust-key directory and rotation (add a `<id>.pub.pem`), the note that old local manifest records are not migrated, and R4 (registry releases are not runnable until piece 2).
- [ ] **Step 2:** `ARCHITECTURE.md`: a short "Platform images and releases" section pointing to the spec, the Bake file, `closure.json` and the release toolkit.
- [ ] **Step 3:** Helm values: image repository `ghcr.io/pragmatic-tech-ai/pragmatic-env-server` and `pragmatic-env-gateway`, tag empty with a comment to set the release version; `helm lint` + `helm template` still pass (if helm is installed locally; otherwise CI covers it).
- [ ] **Step 4: Commit** `docs: platform images and the release flow`.

**Live check (after merge, needs the user):** the user creates the read-only GHCR token file and approves pushing the branch and the first tag (`release/0.1.0`). Then: the workflow run is green; GHCR shows nine packages (eight images + `pragmatic-release`), all private; portal Refresh imports `0.1.0` as Verified with eight images; gating `0.1.0` for a tenant works; selecting it for a hive answers the R4 sentence.
