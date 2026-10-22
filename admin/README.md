# Admin control plane runbook

The control plane is a local web portal plus HTTP API that creates, starts, stops and deletes pragmatic-server environments as Docker containers.

## One-time image build

Needs Docker with BuildKit, and an .npmrc containing the scoped registry token. Run from the workspace root `architecture-agent/`, which holds all sibling packages:

```
DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path-to>/.npmrc -t pragmatic-server:dev .
```

## Build the portal

Before the first start. This emits admin/portal/dist/, which the control plane serves. The portal depends on the sibling Mural and todl-runtime builds via file: paths, so those siblings must already be built.

```
npm --prefix admin/portal install && npm --prefix admin/portal run build
```

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

## Create environments

From the portal, create either a dev-blank environment (the name must be a lowercase slug, characters a-z, 0-9 and hyphen) or a demo-contoso environment (seeds the Contoso security model and four demo users). Each is a pragmatic-server:dev container on an allocated host port. Connect over HTTP at http://localhost:PORT and over WebSocket at ws://localhost:PORT/?tenant=TENANT.

## Gated integration smoke

Requires Docker and the built image. It creates, starts, stops and deletes a dev and a demo environment end to end, and checks the seeded users. It creates the dev environment as a Development type and the demo as a Runtime type, and asserts each type reaches the numeric purpose in the generated tenants.json (0 and 1). The smoke is operator-run: it needs Docker and the pragmatic-server:dev image. On the demo environment it also runs a Manage round-trip over the admin routes: snapshot, create an account, grant and revoke a role, read and re-save the security model unchanged, and confirm that revoking the tenant Owner's own grant is refused with 409. It is not part of the normal test run.

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

admin/control-plane/data/ holds generated bundles, registry.json, provisioned secrets and master keys. It is generated and gitignored; never commit it. The Playwright portal spec is gated on a one-time browser install:

```
npx playwright install chromium
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
