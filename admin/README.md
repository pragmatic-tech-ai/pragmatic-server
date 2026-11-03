# Admin control plane runbook

The control plane is a local web portal plus HTTP API that creates, starts, stops and deletes pragmatic-server environments as Docker containers.

## One-time image build

Needs Docker with BuildKit, and an .npmrc containing the scoped registry token. Run from the workspace root `architecture-agent/`, which holds all sibling packages:

```
DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path-to>/.npmrc -t pragmatic-server:dev .
```

## Build the portal

Before the first start. This emits admin/portal/dist/, which the control plane serves. The portal depends on the sibling Mural and todl-runtime builds via file: paths, so those siblings must already be built.

The Platform Admin portal (admin/portal/) is a Mural markup app: its screens are `.mu` files under admin/portal/src/ (app.mu, login.mu, and one module per section in src/sections/). `npm --prefix admin/portal run build` first runs `compile:mu`, which compiles every `.mu` file into the `.mu.js` module beside it, then bundles with Vite. `test`, `typecheck` and `dev` run `compile:mu` first too, so there is no separate step. The generated `.mu.js` files are committed; rebuild after editing a `.mu` file and commit both.

```
npm --prefix admin/portal install && npm --prefix admin/portal run build
npm --prefix admin/tenant-portal install && npm --prefix admin/tenant-portal run build
```

## Tenant portal

The tenant portal is a second Mural app (admin/tenant-portal/) for a client's administrators: an Overview, Environments (lifecycle and live logs), Users & Access (accounts, grants, tokens and the security model, per environment), Releases (adopt a version), read-only Settings and Connection status. Like the Platform Admin it is Mural markup + MVVM on the framework EditorShell: `npm --prefix admin/tenant-portal run build` (and `test`, `typecheck`, `dev`) first runs `compile:mu`, which compiles `src/**/*.mu` to the committed sibling `*.mu.js`. With no session it sends the browser to the tenant's identity provider (`/tenant-auth/oidc/begin`). It is served by a dedicated tenant listener (its own port), separate from the loopback operator listener, so the operator surface is structurally unreachable on it. Build it as shown above, then turn the tenant listener on by setting these on the control plane:

- PRAGMATIC_TENANT_ADMIN_PORT: the dedicated tenant listener's port. Its presence (with the base domain) activates the tenant plane; absent → operator-only, exactly as before.
- PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: e.g. `admin.example.com`. A request host is a tenant host iff it is `<tenantId>.<baseDomain>`; the tenant id is the first label. Subdomain admin login therefore requires the tenant id to be a lowercase DNS-label-safe string (`[a-z0-9-]`, no dot/underscore/uppercase); a tenant whose id is not DNS-safe cannot reach admin login via a host and such a host simply 403s.
- PRAGMATIC_TENANT_ADMIN_BIND: the tenant listener's bind address; defaults to `127.0.0.1` (proxy-fronted).
- PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME: `https` (default) or `http`; the scheme of the externally-visible tenant origin, used to build the per-tenant OIDC callback URL (`<scheme>://<tenantId>.<baseDomain>[:<port>]/tenant-auth/oidc/callback`).
- PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: optional; the externally-visible port of the tenant origin, for running without a proxy (e.g. `7002` with `PRAGMATIC_TENANT_ADMIN_PORT=7002`, base domain `localhost` and scheme `http` gives `http://<tenantId>.localhost:7002/tenant-auth/oidc/callback`). Omitted, or the scheme's default (80 for http, 443 for https), keeps the origin port-less, as before. When set, a request's Host must be `<tenantId>.<baseDomain>` with no port or exactly this one (other ports 403), and a mutating request's Origin must be exactly that origin. Do not put a port in the base domain. Validated like the other ports (1..65535; a bad value stops startup).

The tenant id and the OIDC callback are derived per request from the request's subdomain host; there is no `?tenant=` query parameter.

A tenant's Owner signs in to the tenant portal with the email and one-time password shown when the tenant was created. If that password is lost, a Full operator resets it in Platform Admin (Tenants, the tenant's page, Reset Owner password): after confirming with the tenant id, the control plane sets a fresh password in the tenant's identity provider (the old one stops working at once), ends the Owner's sessions (identity-provider single sign-on, tenant-portal sessions and open tenant-portal connections), and the portal shows the password once, with the Owner's email, until it is marked saved. The API form is `POST /api/tenants/ID/owner-password` (reply `{ ownerEmail, ownerPassword, sessionsRevoked, warning? }`, `Cache-Control: no-store`); `sessionsRevoked` is false, with a warning the portal shows, when the password changed but the tenant-portal sessions could not be ended. It answers 409 when the tenant has no Owner recorded, its identity provider is not managed by this control plane (reset it from within the tenant's cluster instead), the identity provider has no Owner account or refuses, or a reset of that tenant is already running, and 503 when the identity provider cannot be reached (after a timeout the reset may have been applied: reset again). If the tenant listener runs off ports 80/443 with PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT unset, the control plane prints one startup warning. The password is never stored, logged or written to the activity log.

Gated end-to-end test. It runs against a fake control plane (no IdP, no Docker), serving dist/ and canned /tenant-auth and /tenant-api responses. It boots into the Overview, opens every rail section, an environment's detail and the create dialog, the Users & Access tabs and a one-time token reveal, the adopt wizard, a live event in Activity, and Log out landing on a stub identity provider. It needs a prior build and Playwright browsers, and is not part of the default unit run (`npm --prefix admin/tenant-portal test`):

```
npx playwright install chromium
npm --prefix admin/tenant-portal run build
npm --prefix admin/tenant-portal run test:e2e
```

The real-login e2e (a live per-tenant IdP and relying party driving a real roll) is a separate deferred Feature and is not covered here.

## Start the control plane

```
npx tsx admin/control-plane/server.ts
```

The port comes from PRAGMATIC_ADMIN_PORT (default 7000). The server binds 127.0.0.1 only. Open the portal at http://localhost:7000/ (or your chosen admin port).

## Operator authentication

The control plane requires operator login and binds 127.0.0.1 only. Configuration is by environment variable:

PRAGMATIC_ADMIN_OPERATOR_EMAIL is the operator login email (default admin@control-plane.test).

PRAGMATIC_ADMIN_OPERATOR_PASSWORD seeds the operator on the first run only. It is ignored afterwards: seeding is idempotent and never resets an existing password.

PRAGMATIC_ADMIN_MASTER_KEY_FILE is the master key path (default <data>/master.key, generated automatically if absent).

PRAGMATIC_ADMIN_SECURE_COOKIE marks the session cookie Secure (default false; set true for a future TLS deployment).

First run: set the password variable once, start the server, then log in at http://localhost:7000/ (or your chosen admin port) with the operator email and that password. Later runs do not need the password variable.

```
PRAGMATIC_ADMIN_OPERATOR_PASSWORD=choose-a-password npx tsx admin/control-plane/server.ts
```

The operator account and master key persist in the gitignored admin/control-plane/data/identity/ directory plus master.key. If you lose the data directory or the master key you must re-bootstrap: set the password variable again on the next start.

The gated smoke below logs in automatically with a built-in test operator composed over its temporary data directory.

## Hive install (agent channel)

A hive comes alive when its agent, running in the client's cluster, dials home with its one-time agent token. Agents call the agent channel, a separate bearer-authenticated listener. Turn it on with PRAGMATIC_AGENT_CHANNEL_PORT (for example 7001); PRAGMATIC_AGENT_CHANNEL_BIND sets its bind address (default all interfaces). Without it, hive pages say the channel is off and offer no install bundle.

```
PRAGMATIC_AGENT_CHANNEL_PORT=7001 npx tsx admin/control-plane/server.ts
```

Install bundles point the agent at PRAGMATIC_AGENT_CHANNEL_URL, which defaults to http://host.docker.internal:PORT (how a pod in Docker Desktop's Kubernetes reaches this machine). Set it to the channel's externally reachable URL anywhere else.

The Stand up a hive wizard ends on its Bootstrap step with the bundle (Download bundle) and the commands that apply it: `kubectl apply -f bootstrap-HIVE.json`, a silent `read -rs PRAGMATIC_AGENT_TOKEN` prompt for the one-time agent token, then `kubectl -n pragmatic-system create secret generic ...` from that variable. Neither the bundle nor the commands carry the token, so it stays out of shell history; it is shown once on the page and the control plane keeps only its hash. A hive's page offers the same bundle at any time, and Reissue agent token (the rollout-registration route) mints a new one-time token, which stops the old one at once. Its commands replace the Secret and restart every deployment in pragmatic-system labelled for the hive: the agent and, when installed, the tenant-admin pod, which reads the same token. The first pull of pragmatic-server:dev into Docker Desktop's node can take a minute or two.

Deleting a hive removes its agent from a cluster the control plane drives (an attached Local hive): the agent's objects and token Secret, the tenant-admin's IdP credential copies, and every deployment, service, service account and secret in pragmatic-system labelled for the hive, then revokes the agent token and removes the record; a provisioned (kind) hive's cluster is destroyed whole instead. The tenant-admin data volume and its seed Secret (whose master key decrypts it) are kept together, and the delete names them. If the cluster cannot be reached, or a kind cluster cannot be destroyed, the delete stops and keeps the record, and the hive page offers Delete anyway, which revokes the token and removes the record but leaves whatever is in the cluster (locked out) or the kind cluster behind. The API form is `DELETE /api/hives/ID?force=true`. Hive ids must be lowercase Kubernetes names (a-z, 0-9 and '-', at most 34 characters, the limit a kind cluster name sets).

An invalid PRAGMATIC_AGENT_CHANNEL_URL (not an absolute http or https URL) is ignored with a startup warning, and hive pages then report the channel as not configured.

## Create environments

The Platform Admin portal no longer has environment screens; the /api/environments routes remain. Through them, create either a dev-blank environment (the name must be a lowercase slug, characters a-z, 0-9 and hyphen) or a demo-contoso environment (seeds the Contoso security model and four demo users). Each is a pragmatic-server:dev container on an allocated host port. Connect over HTTP at http://localhost:PORT and over WebSocket at ws://localhost:PORT/?environment=TENANT.

## Gated integration smoke

Requires Docker and the built image. It creates, starts, stops and deletes a dev and a demo environment end to end, and checks the seeded users. It creates the dev environment as a Development type and the demo as a Runtime type, and asserts each type reaches the numeric purpose in the generated tenants.json (0 and 1). The smoke is operator-run: it needs Docker and the pragmatic-server:dev image. It also drives the promote path: it authors a graph on a development environment with a maker token, promotes it to a runtime environment and reads it back over cypher, deploys an environment-bound and a bundled app there, and confirms a Viewer sees a re-promoted graph on the same connection without a redeploy. Identity administration (accounts, roles, security model) lives on the tenant plane and is covered by the tenant-admin smoke, not here. It is not part of the normal test run.

```
npx tsx admin/control-plane/control-plane-smoke.ts
```

## Gated k8s Hive smoke

Requires Docker Desktop's built-in Kubernetes (context docker-desktop) and the pragmatic-server:dev image in the local docker image store. It drives a throwaway dev-blank environment through the real KubectlHiveOrchestrator: Apply, WaitHealthy, a /healthz check through kubectl port-forward, Roll, and Teardown (asserting the namespace is NotFound afterwards); the namespace is removed in a finally block even on failure. The stock workload only sets PRAGMATIC_PORT, so the smoke adds local-only boot env (base dir, tenant id and a throwaway random master key) so the pod can reach Ready; injecting real config and secrets into k8s workloads belongs to SP-HIVE-3. The first run can take about a minute while the node loads the image. Like the control-plane smoke it is operator-run and not part of the normal test run.

```
npx tsx admin/control-plane/k8s-hive-smoke.ts
```

## Gated registry provenance smoke

Requires Docker, Docker Desktop's built-in Kubernetes (context docker-desktop) and the pragmatic-server:dev image. It starts a real registry:2 container on localhost:5000, pushes the image to it, and signs the image digest with a throwaway dev Ed25519 key kept in temporary key and signature stores. It then drives a real KubectlHiveOrchestrator for a provision-registry hive: the signed image verifies, Apply succeeds, WaitHealthy reports the pod Ready, and the running image ref is localhost:5000/pragmatic-server:dev. It then corrupts the stored signature (and separately swaps the trust root to a different key) and asserts a further Apply throws ImageVerificationError and creates no namespace, proving the gate refuses before kubectl apply. The namespaces, the registry container and the temporary stores are removed in a finally block. It reuses the k8s smoke's local-only boot env. Because the image is also in the local docker image store and the manifest uses imagePullPolicy IfNotPresent, the node may resolve the registry-tagged image locally rather than pulling over HTTP; a node that must really pull from localhost:5000 needs it configured as an insecure registry. Operator-run and not part of the normal test run.

```
npx tsx admin/control-plane/registry-provenance-smoke.ts
```

## Generated data and portal tests

admin/control-plane/data/ holds generated bundles, registry.json, provisioned secrets and master keys. It is generated and gitignored; never commit it. The Playwright portal spec (admin/portal/tests/portal.spec.ts) runs against a fake control plane that serves dist/ and canned /api responses, and refuses every write. It logs in, checks the Fleet page, opens a tenant's detail and goes Back, opens and cancels the Create client dialog, and logs out. It needs a prior build and a one-time browser install, and is not part of the default unit run (`npm --prefix admin/portal test`):

```
npx playwright install chromium
npm --prefix admin/portal run build
npm --prefix admin/portal run test:e2e
```

## Type-check gate

`npm run typecheck:tools` type-checks the tsx-run `environments/` and `admin/control-plane/` trees (which the `src` build does not cover) plus the portal. Run it before relying on those trees.

## Gated rollout push smoke

Requires Docker Desktop's built-in Kubernetes (context docker-desktop) and the pragmatic-server:dev image. It tags the dev image as pragmatic-server:v1 and pragmatic-server:v2 (the same bits under two refs; what differs is the ref the Deployment runs), signs both refs with a throwaway dev Ed25519 key into the stores of the HiveOrchestratorFactory data root, and composes a real PlatformDeploymentRegistry over temporary files. It publishes and gates v1 and v2, brings a throwaway environment up on v1 (reusing the k8s smoke's local-only boot env), then SelectTarget(hive, v2) pushes the roll through the SP-HIVE-3 signature gate and the smoke asserts the live Deployment now runs pragmatic-server:v2; SelectTarget(hive, v1) is the rollback and is asserted the same way. The namespace, the two extra image tags and the temporary stores are removed in a finally block. Operator-run and not part of the normal test run.

```
npx tsx admin/control-plane/rollout-push-smoke.ts
```

## Gated rollout pull-agent smoke

Proves the pull path on Docker Desktop's Kubernetes (context docker-desktop). The pragmatic-server:dev image must have been built after the pull agent landed, because the agent Deployment runs `node dist/bin/pragmatic-agentd.js` from it (build invocation is in docker/Dockerfile's header; run it from the workspace root architecture-agent/ with context `.`). The smoke tags and signs v1 and v2 as in the push smoke, registers the hive to obtain the machine token, stores it in a Secret (key token) in the environment namespace, brings the environment up on v1, and applies the agent objects (ServiceAccount, Role, RoleBinding, Deployment) pointing at a locally served ControlPlaneHost. The host only accepts loopback Host headers, so a small proxy listening on all interfaces rewrites the Host header and the pod reaches it as host.docker.internal. SelectTarget(hive, v2) goes through a second registry whose backend is unreachable, so it only records the selection and nothing pushes. The smoke then polls (bounded) until the in-cluster agent has patched the server Deployment to v2 on its own and has reported back so the rollout status shows the environment no longer obsolete. The namespace, the local server and proxy, the two extra image tags and the temporary stores are removed in a finally block. Operator-run and not part of the normal test run.

Known caveat: Docker Desktop's kind-style node keeps its own image cache keyed by tag, so a rebuilt pragmatic-server:dev can be shadowed by a stale node copy. If the agent pod fails with a missing module, run `docker exec desktop-control-plane crictl rmi docker.io/library/pragmatic-server:dev` (and the :v1 / :v2 tags) so the node re-pulls from the docker store.

```
npx tsx admin/control-plane/rollout-pull-smoke.ts
```
