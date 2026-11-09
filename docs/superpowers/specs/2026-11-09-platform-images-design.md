# Platform images: one image per application, built and released from GitHub — design

Status: decisions recorded with the user 2026-11-09; awaiting approval of the full document.
Repo: pragmatic-server (Dockerfiles, release workflow, control plane, orchestrator, agent).
Scope: **platform software only.** Environment content (the in-hive `registry:2` that carries
tenants' signed app UI bundles, app deploys, graphs) is out of scope and unchanged.

## 1. Intent and why

Today every platform process ships in one image, `pragmatic-server:dev`, built by hand from
`docker/Dockerfile` with the whole workspace (about 17 sibling repos) baked in. The env server, the
hive agent, the tenant admin app, the tenant IdP and the UI unpacker are the same bytes started with
a different `command`. The image is never published (the `image.yml` workflow is inert: `OWNER`
placeholder, `:latest`). It reaches clusters by `kind load` or by streaming into the Docker Desktop
node, pulled with `IfNotPresent` by a mutable tag. Signatures are made over the *local* image id, and
two code paths sign the image at the moment they apply it, so the check proves nothing about where
the bytes came from.

The user wants a clean image structure — one image per application — and wants to start working
the way production will work now: releases are built on GitHub from a tag, land in the GitHub
registry, and the platform admin sees them there.

## 2. Decisions taken with the user

1. **One image per application** (list in §3).
2. **One uniform version for the whole package.** Every image of a release carries the same version
   tag. A hotfix is the next patch version: all images get the new tag; images whose code did not
   change keep the same digest, so only the fixed one actually rolls on hives.
3. **The build manager is a person working directly in GitHub.** They mark a pragmatic-server commit
   deployable by pushing a release tag carrying the version (e.g. `release/1.4.0`). Only
   pragmatic-server is tagged; the build records the exact commit of every sibling repo it used.
4. **The tag triggers the build.** A GitHub Actions workflow builds all images, pushes them to the
   GitHub registry, signs them and records the release there.
5. **The admin portal only reads the registry.** It shows the releases found in GHCR with their
   images and digests; the platform admin gates and selects from them as today. The portal never
   starts builds and holds no GitHub write access.
6. **One platform registry: GHCR under `pragmatic-tech-ai`, private.** No laptop registry, no
   mirrors, no per-hive copies. No local image builds: every image comes from this path, also during
   development.
7. **The registry is not open; the platform is the proxy.** Hives never talk to GHCR. They pull
   from a registry endpoint the platform serves, with a per-hive pull credential (an image-pull
   Secret in the hive, separate from the agent token, revocable on its own). The proxy **serves only
   images listed in releases gated for the hive's tenant**, and reads GHCR with one read-only
   credential. It lives on the public front door (the agent channel listener today, the
   `pragmatic-platform-edge` image after the split).
8. **No central tenant admin app.** Every hive runs its own. The control plane's tenant plane
   (listener B, `TenantPlaneHost`, `PRAGMATIC_TENANT_ADMIN_PORT` on the control plane, the centrally
   run console and its relay path) is removed.
9. **The control plane splits in two:** `pragmatic-platform-admin` (operator API + Platform Admin
   portal, internal only) and `pragmatic-platform-edge` (public: agent channel, Plexus desktop
   discovery, registry proxy). The edge is stateless and forwards to platform-admin over an internal
   API; platform-admin is the only writer of platform data.

## 3. The image catalogue

| Image | Process(es) | Listener | Exposure | Runs where |
|---|---|---|---|---|
| `pragmatic-platform-admin` | control plane operator part + `admin/portal` SPA | `PRAGMATIC_ADMIN_PORT` | internal only | Pragmatic |
| `pragmatic-platform-edge` | agent channel + `/api/desktop/discover` + registry proxy | `PRAGMATIC_AGENT_CHANNEL_PORT` | public | Pragmatic |
| `pragmatic-env-server` | `pragmatic-serverd` (single process) and `pragmatic-workerd` (scale-out worker): one app, two entrypoints | `PRAGMATIC_PORT` (+ worker advertise, health, metrics) | Ingress `<envId>.<baseDomain>` | hive, per environment |
| `pragmatic-env-gateway` | `pragmatic-gatewayd` (scale-out only) | `PRAGMATIC_PORT` | Ingress | hive |
| `pragmatic-hive-agent` | `pragmatic-agentd` | none (outbound only) | — | hive, one per hive |
| `pragmatic-tenant-admin` | `pragmatic-tenant-admind` + `tenant-portal` SPA | `PRAGMATIC_TENANT_ADMIN_PORT` | Ingress on the client's host | hive, one per hive |
| `pragmatic-tenant-idp` | `pragmatic-idpd` + `idp-login` SPA | `PRAGMATIC_IDP_PORT` (HTTPS) | Ingress | hive |
| `pragmatic-ui-unpack` | `pragmatic-ui-unpack` | none (init container) | — | hive, in env pods |

Off-the-shelf images, used as-is and **pinned by digest** in code: `postgres:16`, `registry:2` (the
out-of-scope UI-bundle registry), `redis` (scale-out state), and a small stock image (busybox or
similar) for the seed init steps that today borrow the big image only to run `sh -c cp`. These are
pulled from their public registries as today; the proxy is for platform images. The ingress
controller is assumed present in the cluster.

Every release lists all eight images. Hives apply only the in-hive six; the proxy never serves the
two platform-side images to a hive.

### What each image carries (recon 2026-11-09, esbuild import closure)

| Image | Sibling packages | Notable npm deps | Files / binaries |
|---|---|---|---|
| env-server | todl-runtime, TODL (+ Mural via TODL), pragmatic-graph, pragmatic-protocol, todl-connectors-host, todl-identity(+cloud/engine/host/local/node), todl-platform-node/cloud/aws/azure/gcp | lmdb (only native addon), pg, mongodb, neo4j-driver, redis, ws, jose, esbuild, typescript, cloud SDKs, OpenTelemetry | — |
| env-gateway | pragmatic-protocol, todl-identity, todl-runtime | redis, ws, OpenTelemetry | — |
| hive-agent | none | none (node:https only) | — |
| tenant-idp | todl-identity(+local/host/node), todl-runtime | jose, hash-wasm | `idp-login/dist` (startup refuses without it); `openssl` CLI (dev CA) |
| tenant-admin | today: TODL, Mural, protocol, todl-identity(+cloud/host/local/node), todl-runtime | ws, jose, hash-wasm | `tenant-portal/dist`; today also bundles docker/kubectl/kind code |
| ui-unpack | todl-runtime | — | HTTP to the UI-bundle registry |
| platform-admin | same closure as tenant-admin today | same | `admin/portal/dist`; shells out to `docker`, `kubectl`, `kind`, `openssl` |
| platform-edge | new; expected protocol/identity at most | — | — |

Findings the builder must act on:
- **tenant-admin reaches TODL/Mural through one dev-box chain** (`environments/seed/compile.ts`) and
  carries Docker-driver code (`docker-env-port`, `docker-idp-driver`, `idp-container-env`,
  `kind-image-loader`, `environments/seed/docker.ts`). The image must lose the Docker/kind code;
  whether TODL can go too depends on whether in-cluster environment creation genuinely compiles TODL
  (verify, then cut, or keep with a note in the Dockerfile).
- **pragmatic-graph is missing from today's `docker/Dockerfile`** while the env server imports it.
  The new build must include it. (Recon ran on the in-progress engine branch; re-measure on the
  branch the work starts from.)
- No argon2/bcrypt native addons remain (hashing is `hash-wasm`); the builder's C toolchain is only
  for lmdb.
- `node:22-slim` may lack the `openssl` CLI the IdP needs; the IdP image must provide it.

## 4. How it works

### 4.1 The images
- One Dockerfile per image (per-folder or one multi-target file: builder's call), sharing a builder
  stage that builds the needed sibling packages once. **Docker Buildx Bake** (on every GitHub runner,
  no new binary) builds all eight in one invocation. Build context = the workspace layout the
  workflow checks out (pragmatic-server plus siblings side by side, as `ci.yml` already does); the
  npm token stays a BuildKit secret.
- Each runtime image copies only its closure (§3) plus pruned production dependencies; runs as the
  non-root uid 10001 on `node:22-slim`; has its own `ENTRYPOINT`; keeps a `HEALTHCHECK` where the app
  serves `/healthz`. The single `docker/Dockerfile` and the `pragmatic-server:dev` tag are retired.

### 4.2 The release workflow
- Trigger: push of a tag `release/X.Y.Z` on pragmatic-server (the exact tag pattern is the
  builder's call; it must carry the version and be unmistakable as a release). The workflow refuses
  a tag whose version already exists in the registry.
- Steps: check out the tagged pragmatic-server commit and every sibling at its `main` head; record
  each sibling's commit; build all eight images; push each as
  `ghcr.io/pragmatic-tech-ai/<image>:X.Y.Z` (plus `:git-<sha>` of the server commit); read back each
  image's **registry digest**; sign each digest with the **release signing key** (Ed25519 PEM held as
  a GitHub Actions secret; our existing signature scheme, no cosign); then push the **release
  descriptor** as an OCI artifact `ghcr.io/pragmatic-tech-ai/pragmatic-release:X.Y.Z`:
  `{ version, serverCommit, siblingCommits: { <repo>: <sha> }, builtAt, signingKeyId,
  images: { <app>: { repository, digest, signature } } }`. The descriptor is pushed last, so its
  presence means the release is complete.
- `ci.yml` builds all images with Bake on every push (no push to the registry) so the per-app
  Dockerfiles cannot rot between releases. The inert `image.yml` is deleted.
- Hotfix: the build manager tags the fixed commit `release/X.Y.(Z+1)`; the workflow is identical.
  Unchanged images produce the same digest when their inputs are unchanged (builder: make builds
  reproducible enough that this holds for unchanged apps; if exact digest stability proves
  impractical, every image simply rolls — acceptable).

### 4.3 Platform admin reads the registry
- Platform-admin holds a **read-only GHCR credential** by reference (never in a response, log or
  error) and lists `pragmatic-release` tags through the OCI distribution API (existing
  `oci-registry-client`, extended with auth and tag listing).
- Each release descriptor is verified against the platform's trust roots (the public half of the
  release key); a descriptor or image signature that fails is shown as **rejected** and cannot be
  gated. A verified release appears in the catalogue as published, with its images, digests, server
  and sibling commits. *My call:* platform-admin discovers releases by refreshing on demand (portal
  "Refresh") and on a periodic poll; no GitHub webhook.
- `ManifestRecord` (one `image`, optional `digest`/`signed`) becomes a release record carrying the
  descriptor. Gating, per-hive selection, withdrawal and rollback keep their semantics, applied to
  the whole release. Withdrawal stays a platform-side flag; the registry is never written by the
  platform. *My call:* existing local single-image manifest records are dev data and are not
  migrated (the store starts fresh; admin README says so). The `manifest-publish.ts` CLI and the
  portal's publish form go away (publishing is the workflow's job).
- The Platform Admin portal's release views show, per release: version, built-at, server commit,
  sibling commits, and the eight images with digest and verification state.

### 4.4 Trust
- Signing happens **once, in the workflow**, over registry digests. Applying **only verifies**.
- A release names the key that signed it (`signingKeyId`); a hive's trust root is a **set** of keys
  (rotation). *My call:* platform-admin verifies every image of a release before it can be gated and
  again before it offers that release to a hive; the proxy serves only digests of verified, gated
  releases. The hive agent stays HTTP-only and does no crypto; it trusts the platform over its
  authenticated channel. This covers the agent's own self-update.
- Removed: apply-time signing in `InClusterEnvironmentRuntime` and `PlatformConsoleImageApproval`,
  the `ImageSigner` / `DockerImageDigest` local-image-id path, and the platform signing key on the
  control plane (the platform keeps only public keys). The in-hive tenant admin app's
  approved-images list (`PinnedImageVerifier`) carries digests.

### 4.5 Hives pull through the platform
- The proxy serves the read side of the OCI distribution API (`/v2/`, manifests and blobs by
  digest, HEAD and GET) on the public listener, streaming from GHCR with the read-only credential.
- **Pull credential:** issued per hive by platform-admin at hive install (hash-only on the platform,
  one-time reveal, like the agent token), installed in the hive as a `kubernetes.io/dockerconfigjson`
  Secret referenced by every platform workload. Revoke cuts image access without touching the agent
  token; reissue rotates it.
- **Authorization:** a hive may fetch a manifest or blob only if it belongs to an in-hive image of a
  verified release gated for its tenant (blobs are authorised through the manifests that reference
  them). Everything else is refused and audited.
- **TLS:** the proxy endpoint is HTTPS. Locally it uses the dev CA, which the cluster nodes'
  containerd must trust and know as a registry host (kind: configured at cluster creation; Docker
  Desktop: a one-time setup step the builder automates or documents).

### 4.6 Rendering and rollout
- Every workload the orchestrator renders takes its image from the hive's selected release, as
  `<proxy host>/<image>@sha256:<digest>`: env server, gateway (scale-out only), ui-unpack init
  container, tenant admin app, tenant IdP, hive agent. The hard-coded `pragmatic-server:dev` sites
  (`EnvironmentWorkload.ServerImage`, `K8sManifestBuilder.AgentImage`,
  `IdpContainerEnv.DefaultSeedImage`, `DockerEnv.ImageName`) go.
- Digests cannot be stale, so `IfNotPresent` stays safe. `kind load`, `KindImageLoader` and node
  streaming are deleted from the product path and from the smokes.
- **First install:** installing a hive requires a verified release gated for its tenant; it uses the
  hive's selection, or the newest gated release when none is selected. With nothing gated, install
  refuses with a plain sentence. The pull credential is issued and stored before the agent is
  applied.
- The hive agent today rolls only env server Deployments. It now moves **every in-hive component**
  to the selected release: env servers (and their init containers), tenant admin app, tenant IdP,
  and itself **last**. Its namespace-scoped RBAC widens to exactly those workloads. Reports carry the
  observed digest per component. Selection stays **per hive** (all environments in a hive move
  together, as decided in the hive design).

### 4.7 Control plane split
- Remove listener B and its code (`TenantPlaneHost` and what only it uses), env vars, tests, smokes
  and README sections.
- `pragmatic-platform-admin`: the operator plane, plus an internal API the edge calls (agent target,
  snapshot ingest, console adverts, desktop discovery, pull authorization), reachable only on the
  platform's private network and authenticated edge→admin.
- `pragmatic-platform-edge`: the agent channel routes, `/api/desktop/discover` and the proxy; holds
  no platform data and no keys except the read-only GHCR credential.
- Supported laptop setups: everything in containers, or everything via `npx tsx`. The internal API
  address is configurable.
- **Open for this piece (user decision before its plan):** how a containerized platform-admin
  drives local clusters. Today it runs `kubectl`/`kind`/`docker` against the laptop's kube contexts
  (agent auto-install, kind provisioning, environment creation). Either the image ships `kubectl`
  with a mounted kubeconfig and the host Docker socket for kind, or cluster setup moves to a separate
  laptop command and the platform only talks to hives through the agent channel.

## 5. Goals, non-goals, anti-goals

**Goals:** eight per-app images with only their closure; a tag-triggered GitHub workflow that builds,
pushes to private GHCR with one uniform version, signs registry digests and records a release
descriptor with every commit; the admin portal listing verified releases from GHCR; releases as
complete digest-pinned lists with patch-release hotfixes; verify-only apply; the platform as the
hives' only, gating-aware registry; every in-hive workload rendered from the selected release; the
agent rolling every in-hive component; no `kind load`; the control plane split with the central
tenant plane removed.

**Non-goals:** environment content and the UI-bundle registry; local image builds; mirrors,
air-gapped delivery or several registries; cloud clusters; starting builds from the portal; tagging
sibling repos; hot-patching one image without a release; migrating existing local manifest records;
changing the Helm chart topology (builder: point its image values at the new images).

**Anti-goals (failure even if it works):**
- An image that carries code or binaries its application does not run.
- Any new binary dependency (no cosign, crane, skopeo, oras); Docker Buildx and the existing
  `docker`/`kubectl`/`openssl` only.
- Signing anywhere but the release workflow; applying anything whose digest is unverified
  (fail-closed); a mutable tag on any rendered workload.
- A hive able to reach GHCR, or to pull an image not gated for its tenant, or a platform-side image.
- Any token, password, registry credential or signing key in an image layer, a workflow log, a
  process argument, a log, an error sentence, a response body (except one-time reveals), or the
  renderer.

## 6. Pieces and order

Each piece leaves the platform working end to end on the laptop.

1. **Images + release workflow + portal sees releases** (§4.1–4.4): per-app Dockerfiles and Bake,
   the tag-triggered workflow, the release descriptor, `ci.yml` builds everything, platform-admin
   lists and verifies releases from GHCR, the release record and portal views, apply-time signing
   removed. Hives keep running whatever they run today until piece 2.
2. **Hives run releases through the proxy** (§4.5–4.6): proxy on today's agent channel listener,
   pull credentials, rendering from the selected release, first-install rule, agent rolls all in-hive
   components, `kind load` and `pragmatic-server:dev` gone.
3. **Control plane split** (§4.7): tenant plane removed, platform-admin and platform-edge as two
   processes and images, proxy moves with the agent channel into the edge.

Each piece gets its own plan (writing-plans), executed subagent-driven, merged locally; pushing
needs the user's say-so. Piece 1 needs, before its live check: GitHub repo secrets for the release
signing key and the npm packages token (the latter already exists for CI), GHCR package visibility
set private, and a read-only GHCR token for platform-admin — created by the user.

## 7. Constraints

OOP, Allman braces, PascalCase public members and interfaces, no inline string literals (hoist to
`private static readonly`), tests in `tests/` folders, LF line endings (pre-existing CRLF files keep
CRLF), engine-never-calls-up. No secrets in logs. Gated live smokes stay outside `tsx --test` and
move to release images (they currently assume `pragmatic-server:dev` in the local store). Docs to
update: `admin/README.md`, `ARCHITECTURE.md`, `helm/pragmatic-server` values.

## 8. Left to the builder

Dockerfile layout, the Bake file, the exact tag pattern, how the workflow pushes the descriptor
artifact (plain `docker`/`curl` against the OCI API is fine; no new binaries), the release record's
field names, poll interval, the internal API transport and auth, the compose shape, containerd node
configuration, and the portal layout of the release views.
