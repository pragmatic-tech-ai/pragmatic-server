# Task 8 report (code phase): tenant-admin container + bootstrap + smokes

Status: DONE_WITH_CONCERNS. Commit 619aafc. Nothing Docker/kind was run; the live smoke is the controller's.

## What was built

RenderTenantAdmin (`k8s-manifest-builder.ts`, spec type in `tenant-admin-workload.ts`, env names in `tenant-admin-env.ts`):
a v1 List of the shared `pragmatic-system` Namespace (first, unlabeled), ServiceAccount (automount off, NO RBAC: the process needs no
in-cluster API access), data PVC, Deployment, ClusterIP Service. All but the Namespace carry only the `pragmatic/hive` label (agent
never selects them). Deployment: runAsNonRoot uid 10001 (the image user), drop ALL, seccomp RuntimeDefault, read-only rootfs, fsGroup
10001, `/tmp` emptyDir; command `node dist-tenant-admin/src/bin/pragmatic-tenant-admind.js`. An init container (`seed`) runs
`cp -f --no-preserve=mode /seed/* /data/`, copying the seed Secret (mounted read-only, 0440) into the PVC data root so the app can
rewrite its own state files (sessions, registry, oidc dir). Env: data root, port, bind 0.0.0.0, base domain, scheme, secure-cookie
(derived from https), rollout URL, rollout hive id; the rollout bearer is a `secretKeyRef` to the agent-token Secret. Readiness is an
httpGet on `/` with `Host: <tenant>.<baseDomain>` (the plane 403s any other Host). Optional `imagePullSecrets`. No Secret objects and
no secret values in the manifest.

Rollout wiring (needed for in-pod adoption): `TenantAdminServer.RolloutClientFrom(env)` builds `HttpRolloutClient` when
`PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL` is set (token + hive id required, error names the variable), else the unconfigured default;
`Main` uses it. TenantAdminServer's env names moved into `TenantAdminEnv` (shared with the builder).

GenerateBootstrap (`tenant-admin-bootstrap.ts`, class `TenantAdminBootstrap`): mints the one-time agent token via an
`IHiveRegistrar` (PlatformDeploymentRegistry.RegisterHive satisfies it), a fresh 32-byte per-tenant master key, builds the seed
(`{tenant, hives:[hive with agentTokenRef = token Secret name]}`), and returns `TenantBootstrap { seed, manifest, secrets,
agentTokenSecretName, seedSecretName }`. `manifest` is one deduped List (Namespace first; agent via RenderHiveAgent, IdP via RenderIdp
when `idp` is supplied, tenant-admin via RenderTenantAdmin) with Secret REFS only. `secrets` is a `BootstrapSecretSet` holding values
in ES `#private` fields, so JSON.stringify / String() / util.inspect show only a redaction marker; the one exit is
`RenderManifest()` (base64 `data` Secrets in `pragmatic-system`: agent token; seed with `seed.json`, `master.key`, `trust-root.pub`;
optional dockerconfigjson pull credential). `AddEntry` extends a Secret (used by the smoke for test-only seed state). IdP TLS/admin
token Secrets are referenced, not minted here (bootstrap carries refs only, per the brief).

control-plane-smoke.ts repoint: every removed operator env route (POST /api/environments, start, stop, DELETE at all sites incl.
cleanup, promotion round trip, demo) now calls `EnvironmentService` directly (`Create/Start/Stop/Delete` via a `Try` helper);
GET list, per-env admin/manage, graphs, maker-token, promote, loaded-graph remain over operator HTTP. Labels/header updated. Typechecks.

Packaging: the main build (`tsconfig.build.json`, rootDir src) was ALREADY broken by `src/bin/pragmatic-tenant-admind.ts`
importing `admin/` (TS6059; would have failed `npm run build` in the image). Fixed by excluding that bin from the main build and adding
`tsconfig.tenant-admin.json` (+ `npm run build:tenant-admin`, bin entry, `.gitignore` `dist-tenant-admin`). Output layout:
`dist-tenant-admin/src/bin/pragmatic-tenant-admind.js` (hence the entrypoint differs from the brief's `dist/bin/...`) and the SPA is
resolved at `dist-tenant-admin/admin/tenant-portal/dist`. Dockerfile: builds Mural (tenant-portal depends on it), runs
`build:tenant-admin`, builds tenant-portal and copies its dist to that path.

tenant-admin-smoke.ts flow: platform in-process (directory, publish+gate v1/v2, real AgentChannelHost on 0.0.0.0, URL
host.docker.internal) -> GenerateBootstrap -> AddEntry seeds a pre-issued tenant session (`tenant-sessions.json`) and one environment
record (`registry.json`) into the seed Secret -> kubectl apply manifest, then secrets -> rollout status -> kubectl port-forward to the
Service -> assert: GET / 200 html; `/tenant-auth/session` and `/tenant-api/hives` 401 unauth; with `pts_session` cookie: session 200,
hives = the seeded hive, environments contains the seeded env, manifests (via the channel) has v1+v2, POST target v2 -> 204, and the
platform registry records v2 as the hive target. Diagnostics: pod list, seed-init and server log tails (redacted). Cleanup deletes only
the smoke's own objects (hive-label selector for namespaced kinds + cluster RBAC, the named Secrets), channel, port-forward, temp dir;
deletes `pragmatic-system` only if it created it.

## Controller run

1. Rebuild `pragmatic-server:dev` with the Dockerfile header command (now builds Mural, `dist-tenant-admin`, tenant-portal). On kind:
   `kind load docker-image pragmatic-server:dev --name <cluster>`.
2. `npx tsx admin/control-plane/tenant-admin-smoke.ts`
   Optional env: `PRAGMATIC_SMOKE_CONTEXT` (default `docker-desktop`; set to the kind context), `PRAGMATIC_SMOKE_IMAGE`,
   `PRAGMATIC_SMOKE_CHANNEL_HOST` (default `host.docker.internal`; on kind-on-Linux use the docker bridge gateway IP).

## TDD

RED: `npx tsx --test admin/control-plane/tests/tenant-admin-manifest.test.ts ...` -> `TypeError: ... RenderTenantAdmin is not a function`
(bootstrap suite failed on the missing module). GREEN: manifest suite 10/10, bootstrap suite 9/9, tenant-admin-server suite 19/19
(3 new RolloutClientFrom tests). Full: `npx tsx --test "admin/control-plane/tests/*.test.ts"` -> tests 621, pass 621, fail 0.
`npx tsc -p tsconfig.tools.json --noEmit` -> clean (includes both smokes). `npx tsc -p tsconfig.build.json --noEmit` -> clean (was failing).
Note: `tsconfig.tenant-admin.json` run locally shows 11 errors in `src/composition/*` from a stale local todl-runtime dist (resolution
picks a different todl-runtime copy than the tools config does); emit layout verified; a clean image build uses fresh sibling dists.

## Self-review

House rules followed (Allman, no inline literals, PascalCase, classes only, secrets by name). Known gaps below. Unverified: the
Dockerfile changes, the `cp` init command inside node:22-slim, port-forward, everything in-cluster.

## Concerns / what the live run will most likely trip on (ranked)

1. Image build: Dockerfile additions (Mural COPY/build, tenant-portal `npm install` with file: deps on Mural/todl-runtime, vite build)
   are unverified; Mural's build may need TODL deps/ordering or more siblings. Most likely first failure.
2. Environment CREATE is not exercised and cannot work in-pod: the tenant API has no create route, and `EnvironmentService` in the
   container is still wired to Docker adapters (no docker CLI in the image). A k8s-backed environment driver is needed for real
   in-cluster lifecycle (start/stop/restart/logs also hit docker). The smoke covers listing a seeded record (Reconcile swallows the
   missing docker as "stopped") plus adoption. This is a scope shortfall vs the brief's "create an environment"; needs a decision.
3. Compose also builds `DockerIdpDriver`/`IdpService` (not `InClusterIdpDriver`), so tenant OIDC login in-pod is not wired to the
   in-cluster IdP; not covered by the smoke (seeded session), but real login needs that composition change.
4. Readiness/permissions: read-only rootfs + fsGroup assumptions (node writes nothing outside /data and /tmp?), init `cp` with
   `--no-preserve=mode` (GNU cp in the slim image), PVC provisioning on the local cluster (kind has a default StorageClass; fine).
5. Pod -> host channel reachability (`host.docker.internal` on kind/Linux); agent pod also starts and polls the same channel.
6. The hive agent Deployment has no imagePullSecrets (RenderHiveAgent unchanged); only tenant-admin honors the pull credential.
7. `kubectl rollout status` has no timeout flag (waits up to the default progress deadline if the pod never becomes Ready).

## Fix report (code review)

1. `tsconfig.tenant-admin.json` now typechecks clean (`npx tsc -p tsconfig.tenant-admin.json --noEmit`, no errors). Root cause was NOT an over-broad include: `tenant-admin-server.ts` imports `ControlPlaneServer`, which transitively pulls `operator-identity` -> `src/identity/server-bootstrap` -> `src/pragmatic-server`/`src/composition`, so those files are legitimately in the program. The errors came from TypeScript's package-id dedupe picking a STALE nested `todl-runtime` copy (TODL/Mural/todl-identity node_modules) before pragmatic-server's own. Fix: a `paths` entry pinning `@pragmatic-tech-ai/todl-runtime` to `./node_modules/.../dist/index.d.ts` (type resolution only; runtime/emit unaffected). Include narrowed to the entrypoint, `admin/control-plane/**` and `environments/seed/**`.
2. IdP Secrets: bootstrap never emitted IdP Secrets into pragmatic-system (it only references `tlsSecretName`/`adminTokenSecretName`; its Secret set is agent token, seed, optional pull credential). The `idp` field is now documented: RenderIdp mounts them from the IdP's own namespace, so whoever provisions the IdP must create them there. New test asserts the IdP Deployment is in the IdP namespace, mounts exactly those two Secret names, and that they are absent from the bootstrap Secret set.
3-7. Hoisted `'utf8'`, Secret/List keys (bootstrap), `''` (RolloutClientFrom), `'content-type'` (smoke); named `RenderedList`/`RenderedItem` types; smoke uses typed DTOs (`SessionDto`, `HiveDto`, `EnvironmentDto`, `ManifestDto`) and an `AsList<T>` helper.
8. package.json cannot hold comments: the `pragmatic-tenant-admind` bin points at `dist-tenant-admin/...`, which exists only after `npm run build:tenant-admin` (plain `npm run build` does not produce it). The Dockerfile runs both.

Verification: control-plane suite 622/622; `tsc -p tsconfig.tools.json --noEmit` clean; `tsc -p tsconfig.tenant-admin.json --noEmit` clean.

## Fix report (whole-branch review)

1. Removed the orphaned operator `GET /api/templates`: `TemplatesPath`, its dispatch/handler, and the `TemplateCatalog` import in `control-plane-host.ts` (`InvalidEnvironmentNameError` import kept; the `Template` enum is untouched). In `control-plane-host.test.ts` removed the catalog test, its `TemplateCatalog` import, and the `/api/templates` 401 assertion inside the gating test (that was an assertion line, not a standalone test). No portal references remained.
2. `TenantAdminServer.Compose`: removed the dead `mkdirSync` (and its import).
3. `TenantAdminServer`: the two remaining inline `''` comparisons now use `EmptyString`.

Verification: control-plane suite 621/621 (622 minus the removed test); `tsc -p tsconfig.tools.json --noEmit` and `tsc -p tsconfig.tenant-admin.json --noEmit` both clean.
