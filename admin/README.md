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

The tenant portal is a second Mural app (admin/tenant-portal/) for a client's administrators: an Overview, Environments (lifecycle and live logs), Users & Access (accounts, grants, tokens and the security model, per environment), Releases (adopt a version), read-only Settings and Connection status. Like the Platform Admin it is Mural markup + MVVM on pragmatic-app-shell (the shared sign-in, header and navigation; the tenant portal hides the change-password action, which the console does not offer): `npm --prefix admin/tenant-portal run build` (and `test`, `typecheck`, `dev`) first runs `compile:mu`, which compiles `src/**/*.mu` to the committed sibling `*.mu.js`. With no session it sends the browser to the tenant's identity provider (`/tenant-auth/oidc/begin`). It is served by a dedicated tenant listener (its own port), separate from the loopback operator listener, so the operator surface is structurally unreachable on it. The listener is a pragmatic-app-host AppHost: every route is declared with its authorization (the tenant role `admin` may do everything; the application role `environment-admin` may change the environments and their rollout; any other session may only read), sign-in is the app-host OIDC relying party against the tenant's identity provider, the portal's WebSockets authenticate with a one-use ticket from `POST /tenant-api/ws-ticket`, and every mutation writes the audit trail. Sessions (cookie `pts_session`, the bare token; the store keeps only its digest) last 12 hours for the portal; the session probe `GET /tenant-auth/session` answers `{ subject, claims }`. Until the tenant identity provider issues roles, the console bridges them from the tenant record: the Owner holds `admin`, anyone else `environment-admin`. Build it as shown above, then turn the tenant listener on by setting these on the control plane:

- PRAGMATIC_TENANT_ADMIN_PORT: the dedicated tenant listener's port. Its presence (with the base domain) activates the tenant plane; absent → operator-only, exactly as before.
- PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: e.g. `admin.example.com`. A request host is a tenant host iff it is `<tenantId>.<baseDomain>`; the tenant id is the first label. Subdomain admin login therefore requires the tenant id to be a lowercase DNS-label-safe string (`[a-z0-9-]`, no dot/underscore/uppercase); a tenant whose id is not DNS-safe cannot reach admin login via a host and such a host simply 403s.
- PRAGMATIC_TENANT_ADMIN_BIND: the tenant listener's bind address; defaults to `127.0.0.1` (proxy-fronted).
- PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME: `https` (default) or `http`; the scheme of the externally-visible tenant origin, used to build the per-tenant OIDC callback URL (`<scheme>://<tenantId>.<baseDomain>[:<port>]/tenant-auth/oidc/callback`).
- PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: optional; the externally-visible port of the tenant origin, for running without a proxy (e.g. `7002` with `PRAGMATIC_TENANT_ADMIN_PORT=7002`, base domain `localhost` and scheme `http` gives `http://<tenantId>.localhost:7002/tenant-auth/oidc/callback`). Omitted, or the scheme's default (80 for http, 443 for https), keeps the origin port-less, as before. When set, a request's Host must be `<tenantId>.<baseDomain>` with no port or exactly this one (other ports 403), and a mutating request's Origin must be exactly that origin. Do not put a port in the base domain. Validated like the other ports (1..65535; a bad value stops startup).

The tenant id and the OIDC callback are derived per request from the request's subdomain host; there is no `?tenant=` query parameter.

A tenant's Owner signs in to the tenant portal with the email and one-time password shown when the tenant was created. If that password is lost, a Full operator resets it in Platform Admin (Tenants, the tenant's page, Reset Owner password): after confirming with the tenant id, the control plane sets a fresh password in the tenant's identity provider (the old one stops working at once), ends the Owner's sessions (identity-provider single sign-on, tenant-portal sessions and open tenant-portal connections), and the portal shows the password once, with the Owner's email, until it is marked saved. The API form is `POST /api/tenants/ID/owner-password` (reply `{ ownerEmail, ownerPassword, sessionsRevoked, warning? }`, `Cache-Control: no-store`); `sessionsRevoked` is false, with a warning the portal shows, when the password changed but the tenant-portal sessions could not be ended durably (they may return after a control-plane restart). The identity provider also refuses anything authenticated before a password change (an older single sign-on session, an unexchanged sign-in code, or a sign-in whose password check started before the change), and the tenant plane refuses a tenant-portal session issued before the reset. A user changes their own password at the tenant's identity provider; the tenant portal does not offer it. Such a change ends only the single sign-on sessions; the operator reset above ends everything. It answers 409 when the tenant has no Owner recorded, its identity provider is not managed by this control plane (reset it from within the tenant's cluster instead), the identity provider has no Owner account or refuses, or a reset of that tenant is already running, and 503 when the identity provider cannot be reached (after a timeout the reset may have been applied: reset again). If the tenant listener runs off ports 80/443 with PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT unset, the control plane prints one startup warning. The password is never stored, logged or written to the activity log.

Gated end-to-end test. It runs against a fake control plane (no IdP, no Docker), serving dist/ and canned /tenant-auth and /tenant-api responses. It boots into the Overview, opens every rail section, an environment's detail and the create dialog, the Users & Access tabs and a one-time token reveal, the adopt wizard, a live event in Activity, and Log out landing on a stub identity provider. It needs a prior build and Playwright browsers, and is not part of the default unit run (`npm --prefix admin/tenant-portal test`):

```
npx playwright install chromium
npm --prefix admin/tenant-portal run build
npm --prefix admin/tenant-portal run test:e2e
```

The real-login e2e (a live per-tenant IdP and relying party driving a real roll) is a separate deferred Feature and is not covered here.

## Plexus desktop sign-in and publishing

Plexus (the desktop app) signs a tenant user in, lists the environments they may contribute to or publish to, and relays its JSON-RPC calls to those environments through the control plane's tenant plane. It never holds an environment credential: the tenant plane mints a short-lived one per relay and keeps it server-side.

Discovery. `POST /api/desktop/discover` on the operator listener (`{ email }`) answers `{ tenants: [{ id, displayName }], tenantPlaneUrl }` for the tenants that email has an account in (404 `no-account` when none, 400 `invalid-email`, 503 `unavailable` when no tenant plane is configured). It is unauthenticated, so it refuses any request carrying an Origin header (a browser page cannot probe it) and throttles to 10 requests per minute per address. `tenantPlaneUrl` is PRAGMATIC_DESKTOP_TENANT_PLANE_URL when set, else `http://127.0.0.1:<PRAGMATIC_TENANT_ADMIN_PORT>` when the tenant plane is enabled. Set PRAGMATIC_DESKTOP_TENANT_PLANE_URL when Plexus reaches the tenant listener at another address (behind a proxy, or on another machine).

Sign-in. The `/desktop/*` routes on the tenant listener are Host-independent (Plexus dials plain loopback): the tenant comes only from the sign-in flow or the desktop bearer, never the Host header, and any request with an Origin header is refused. `POST /desktop/sign-in/begin` (`{ tenantId, redirectUri, bindingChallenge }`, the redirect an RFC 8252 loopback `http://127.0.0.1:PORT/pragmatic-desktop/callback`) answers `{ authorizeUrl }` for the system browser; `POST /desktop/sign-in/complete` (`{ state, code, bindingVerifier }`, the verifier the SHA-256 preimage of the challenge, so only the Plexus instance that began a sign-in can finish it) answers `{ token, expiresAt, tenantId, tenantName, email? }`. The token is a Desktop-kind session: accepted only as `Authorization: Bearer` by the desktop routes (a tenant-portal cookie never works there, and the desktop token never works on the portal), valid 7 days, renewed on use at most hourly, and capped at 30 days from sign-in. `GET /desktop/profile` and `GET /desktop/targets` (`{ contribute: [{ name, status }], publish: [...] }`: the user's tenant's Development environments under contribute and Runtime ones under publish, only when their role holds the environments capability) read it; `POST /desktop/sign-out` ends it. Begins are rate limited per address and failed completes count against the login throttle; behind a proxy the address is the last `x-forwarded-for` hop only with PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY set. The session store keeps only token digests.

Relay. Plexus opens a WebSocket to `/desktop/relay?environment=NAME&action=contribute|publish` on the tenant listener with its desktop bearer (an unchanged `PragmaticClient.ConnectAsync(url, { bearerToken })`). The tenant plane checks the environment with the same rule as the targets list, mints a credential for the action (contribute: the environment's maker token, scope graph-contribute, Development only; publish: a deploy-only token, scope application-deploy, Runtime only), reaches the environment server (a Docker environment's published localhost port, or a kubectl port-forward tunnel into the cluster held for the whole relay), connects with that credential and pipes JSON-RPC text frames. Refusals are plain HTTP answers before the upgrade: 400 a malformed WebSocket handshake, 403 any request carrying an Origin header (desktop only, like the rest of `/desktop/*`), 401 no valid desktop bearer, 400 a missing environment or an action other than contribute/publish, 403 not allowed (no environments capability, another tenant's or an unknown environment, or the wrong type for the action), 409 the environment is not running, 502 the environment could not be reached, its credential could not be minted, or its server refused the connection. Only the action's methods are forwarded (contribute: `graph/list`, `graph/contribute`; publish: `application/deploy`; PragmaticClient sends no handshake of its own); any other request is answered with JSON-RPC error -32601 "This method is not available through the desktop relay." and never forwarded; a request reusing the id of a forwarded request still awaiting its answer is answered -32600, and one beyond 32 requests awaiting answers -32603, neither forwarded; client notifications are dropped (neither flow sends one), and a non-JSON, binary or batch frame closes the relay with 1008. Closing either side closes the other; a desktop sign-out closes the relays opened under that session (one still connecting when it signs out is refused 401), and an Owner reset closes all the user's relays.

Audit. The tenant plane keeps its own activity log of desktop relays (the `records_desktop_audit` table of the console database, separate from the operator activity log, capped at 1000 entries). Each forwarded `graph/contribute` or `application/deploy` writes one record when its response returns: actor `TENANT/EMAIL` (the principal id when the session has no email), method `contribute` or `publish`, path the environment name, status 200 (500 for a JSON-RPC error or a deploy that was not applied, 502 when the relay closed before the answer), and the graph or application name as the note. Every refusal writes a record with its HTTP status (unauthenticated ones as `(anonymous)`, under a per-address throttle). The environment credentials sit on the environments' shared maker and deployer principals, so this log is where "who contributed or published" is answered. Neither the desktop token nor an environment credential is ever logged, audited or sent to Plexus.

## Start the control plane

```
npx tsx admin/control-plane/server.ts
```

The port comes from PRAGMATIC_ADMIN_PORT (default 7000). The server binds 127.0.0.1 only. Open the portal at http://localhost:7000/ (or your chosen admin port).

## Storage

Every record of the platform admin console (clients, tenants, hives, environments, IdPs, releases and rollout state,
the activity log, operator accounts and sessions, sealed secrets, signatures) lives in its own Postgres database.
PRAGMATIC_ADMIN_DATABASE_URL_FILE names a file holding its URL (`postgres://user:password@host:port/database`, TLS
through `sslmode`/`sslrootcert` in the URL); the console refuses to start without it, and each store creates and
migrates its table at start. The URL is never logged. What stays on files under the data root (PRAGMATIC_ADMIN_DATA_ROOT):
public keys (`keys/*.pub`), the development CA's certificates and environment bundles. The co-hosted tenant plane keeps its
sessions, pending sign-ins and sealed OIDC client secrets in the same database (a platform-console session is refused on the
tenant plane and a tenant one on the operator listener). The master key and signing keys are secret files. `admin/control-plane/dev/dev-up.sh`
starts a local Postgres for development.

A data root from before the database is moved into it once, without changing the files (they stay as the backup):

```
PRAGMATIC_ADMIN_DATABASE_URL_FILE=/run/secrets/database_url node dist-tenant-admin/admin/control-plane/bin/pragmatic-admin-import.js --data-root /data
```

It reads the master key from PRAGMATIC_ADMIN_MASTER_KEY_FILE (default `<data root>/master.key`), prints what it wrote as
JSON, and refuses (exit 3) a database that already holds records unless `--force` is given; a forced re-run writes the
same state. Sessions are not moved: operators sign in again.

The tenant admin console (the `pragmatic-tenant-admin` image) has its own Postgres database the same way:
PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE names the file holding its URL, and it refuses to start without it. In a hive the
database is a pragmatic-postgres sidecar in the console's pod (data on the console's volume, credentials in the
`<console>-postgres` Secret the bootstrap mints); the console waits up to a minute for it at start. Its environments,
OIDC client registry (the client secrets sealed under its master key), desktop and graph audit, email domains,
registration, Owner-reset state, directory seed, verified images, sessions and the configuration repository all live
there. At its first start over an empty database it imports a pre-A5 data root once, without changing the files; the
same import runs by hand as
`node dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admin-import.js --data-root /data` (exit 3 when the
database already holds records, unless `--force`). Sessions and OIDC client secrets are not moved: users sign in
again and the client secrets rotate.

Configuration. The tenant console keeps a versioned configuration document per component it runs (env-server,
env-gateway, tenant-idp, hive-agent, tenant-admin; the settings of each from its release's component descriptor) and
serves it under `/tenant-api/configuration/components`: list, one component (head and settings), `versions/N`,
`diff?from=A&to=B`, `POST versions` (a new version, validated against the descriptor; 422 with the failing paths, 409
when the head moved) and `POST versions/N/apply`. Saving and applying need the tenant role `admin`. Secret settings
hold only secret references, never values. Applying writes the ConfigMap `pragmatic-config-<component>` and stamps its
hash on the pod template, which rolls the deployment; today only the env-server of the tenant's environments in this
hive is a target (409 for the others). The tenant portal's Configuration section shows, saves and applies them.

## Operator authentication

The control plane requires operator login and binds 127.0.0.1 only. Configuration is by environment variable:

PRAGMATIC_ADMIN_OPERATOR_EMAIL is the operator login email (default admin@control-plane.test).

PRAGMATIC_ADMIN_OPERATOR_PASSWORD seeds the operator on the first run only. It is ignored afterwards: seeding is idempotent and never resets an existing password.

PRAGMATIC_ADMIN_MASTER_KEY_FILE is the master key path (default <data>/master.key, generated automatically if absent).

PRAGMATIC_ADMIN_SECURE_COOKIE marks the session cookie Secure (default false; set true behind TLS).

An operator session is server-side (the `cp_session` cookie carries an opaque token; the database keeps only its digest)
and lasts one hour. The operator's role (operator.full or operator.read-only, the console's application roles) is a claim
of the session, re-read from the operator's account on every request, so a demotion or a disabled account takes effect at
once. Each route of the console names the role it admits: every read admits both (the operator roster only operator.full),
every change operator.full, except signing out and changing one's own password. The password sign-in is the console's
break-glass method; signing in through the realm (OIDC) comes later and uses the same sessions and roles.

First run: set the password variable once, start the server, then log in at http://localhost:7000/ (or your chosen admin port) with the operator email and that password. Later runs do not need the password variable.

```
PRAGMATIC_ADMIN_OPERATOR_PASSWORD=choose-a-password npx tsx admin/control-plane/server.ts
```

Any signed-in operator, Observers included, changes their own password from the Platform Admin header (Change password: current, new and confirm; the new one at least 12 characters). The API form is `POST /api/session/password` (`{ currentPassword, newPassword, confirmPassword? }`, `Cache-Control: no-store`): the identity is the session's, attempts share login's throttle bucket per email and client address (a failed change counts toward the login lockout from that address and vice versa; a successful change clears the count, as a successful login does), a second change while one runs is 409, a wrong current password is 403 (not 401, which would mean the session is gone) and a short, mismatched or unchanged new password 400. On success every session of the operator ends and the caller gets a fresh session cookie, so the page making the change stays signed in (its live connection carries over, and the periodic connection sweep never closes it mid-change) while every other session and its live connection is cut. If, after the password changed, the old sessions could not be ended or no fresh session could be issued, the reply is still 200 with `otherSessionsEnded` and a `warning` the header shows ("sign in again" when there is no fresh session). While the change is submitting, the portal does not treat a 401 from another request as the session ending; it checks the session once afterwards. A Full operator's reset of an operator's password (Settings, the operator's page) likewise ends all of that operator's sessions and closes their live connections; resetting your own account that way signs you out too, after the new password is shown. Neither password is logged or written to the activity log, which records only the path and outcome.

The operator accounts persist in the console's database, their password secrets sealed under the master key
(admin/control-plane/data/master.key in development). If you lose the database or the master key you must re-bootstrap:
set the password variable again on the next start.

The gated smoke below logs in automatically with a built-in test operator composed over an in-process database.

## Hive install (agent channel)

A hive comes alive when its agent, running in the client's cluster, dials home with its one-time agent token. Agents call the agent channel, a separate bearer-authenticated listener. Turn it on with PRAGMATIC_AGENT_CHANNEL_PORT (for example 7001); PRAGMATIC_AGENT_CHANNEL_BIND sets its bind address (default all interfaces). Without it, hive pages say the channel is off and offer no install bundle.

```
PRAGMATIC_AGENT_CHANNEL_PORT=7001 npx tsx admin/control-plane/server.ts
```

Install bundles point the agent at PRAGMATIC_AGENT_CHANNEL_URL, which defaults to http://host.docker.internal:PORT (how a pod in Docker Desktop's Kubernetes reaches this machine). Set it to the channel's externally reachable URL anywhere else.

An admin that serves no channel itself (role `admin` behind an edge) still offers bundles when PRAGMATIC_AGENT_CHANNEL_URL is set: that URL is where its hives dial in.

The Stand up a hive wizard ends on its Bootstrap step with the bundle (Download bundle) and the commands that apply it: `kubectl apply -f bootstrap-HIVE.json`, a silent `read -rs PRAGMATIC_AGENT_TOKEN` prompt for the one-time agent token, then `kubectl -n pragmatic-system create secret generic ...` from that variable. Neither the bundle nor the commands carry the token, so it stays out of shell history; it is shown once on the page and the control plane keeps only its hash. A hive's page offers the same bundle at any time, and Reissue agent token (the rollout-registration route) mints a new one-time token, which stops the old one at once. Its commands replace the Secret and restart every deployment in pragmatic-system labelled for the hive: the agent and, when installed, the tenant-admin pod, which reads the same token. The first pull of pragmatic-server:dev into Docker Desktop's node can take a minute or two.

Deleting a hive removes its agent from a cluster the control plane drives (an attached Local hive): the agent's objects and token Secret, the tenant-admin's IdP credential copies, and every deployment, service, service account and secret in pragmatic-system labelled for the hive, then revokes the agent token and removes the record; a provisioned (kind) hive's cluster is destroyed whole instead. The tenant-admin data volume and its seed Secret (whose master key decrypts it) are kept together, and the delete names them. If the cluster cannot be reached, or a kind cluster cannot be destroyed, the delete stops and keeps the record, and the hive page offers Delete anyway, which revokes the token and removes the record but leaves whatever is in the cluster (locked out) or the kind cluster behind. The API form is `DELETE /api/hives/ID?force=true`. Hive ids must be lowercase Kubernetes names (a-z, 0-9 and '-', at most 34 characters, the limit a kind cluster name sets).

An invalid PRAGMATIC_AGENT_CHANNEL_URL (not an absolute http or https URL) is ignored with a startup warning, and hive pages then report the channel as not configured.

## Infrastructure target

PRAGMATIC_ADMIN_INFRA_TARGET says what this admin drives. Unset or blank means `local`.

- `local`: the machine's own Docker and kind. The admin runs a per-tenant IdP container, tenant Owners get a one-time password, and hive agents and consoles run the locally built `pragmatic-server:dev` image.
- `none`: no Docker and no cluster. Environments, IdPs and installs answer 503 "no Docker/cluster target configured".
- `hosted`: no Docker. The admin pushes to registered clusters on our machines with kubectl. A hive must be an attached Local hive whose `configRef` names its kubeconfig context; without one the install answers 400 "a hosted hive must name its cluster's kubeconfig context (configRef)". It never provisions a cluster. PRAGMATIC_ADMIN_KUBECONFIG_FILE must name a readable kubeconfig file (YAML or JSON, one context per cluster). The admin checks it at start, refuses to start without it (naming the setting, never the file's content), and sets KUBECONFIG for every kubectl it runs.

In `none` and `hosted`:
- A tenant is a record: its client, its id and its Owner's email. No IdP and no password; sign-in lives in the tenant's home hive, and environments for it are created in that hive's console (a platform-created one answers 409).
- Image digests come from registry references (`...@sha256:...`); a tag reference is refused as not pinned by digest.
- Hive agents and consoles run the images of the newest verified, non-withdrawn release, by digest. Until one is imported, agent installs, console installs and bundle downloads answer 409 "no verified platform release yet".

When the release catalogue is configured (any mode), each verified release's images are countersigned with the platform signing key on every refresh (skipping images already signed), so hives that trust the platform key accept them.

## Releases from the registry

Releases are published to the registry by the release workflow; the control plane never publishes them. It discovers them by listing the signed release descriptors, verifies each new version (descriptor and every image signed by a trusted key, every image present at its signed digest) and imports it as verified or rejected. A Full operator triggers a refresh with `POST /api/releases/refresh`, which answers `{ imported, rejected, unchanged, shadowed }` (the versions imported or rejected, how many were already imported, and the versions hidden by a local manifest with the same id); it answers 409 when no registry is configured and 502 when the registry cannot be reached or refuses the credential. The control plane also refreshes on a poll, logging only the counts, or the failure sentence and carrying on. A refresh and the poll never run at once: a request that arrives during one gets its result. `GET /api/manifests` lists every version with its `release` provenance. Only the roles that serve operators (`all`, `admin`) compose the catalogue and the poll; the edge never reads these settings:

- PRAGMATIC_RELEASE_CREDENTIAL_FILE: a JSON file `{ "username": "...", "token": "..." }` holding a registry credential that can read the release packages. Unset, there is no catalogue. A missing, unreadable or malformed file stops startup; the token is never logged or answered.
- PRAGMATIC_RELEASE_REGISTRY: the registry API base URL (default `https://ghcr.io`). It must be https; plain http is accepted only for a loopback registry (`localhost`, `127.0.0.1`, `[::1]`), so the credential never crosses the network in clear.
- PRAGMATIC_RELEASE_NAMESPACE: the namespace the release repositories live under (default `pragmatic-tech-ai`).
- PRAGMATIC_RELEASE_TRUST_DIR: the directory of trusted release public keys, `<key id>.pub.pem` (default `release-keys` at the repository root; the platform-admin image carries it beside the compiled control plane).
- PRAGMATIC_RELEASE_POLL_SECONDS: the poll interval (default 300; 0 turns the poll off). Anything but a whole number from 0 to 2147483 stops startup. The first poll runs one interval after start; to import at once, use Refresh (`POST /api/releases/refresh`).

Cutting a release. A build manager tags pragmatic-server directly on GitHub: `release/X.Y.Z` for a stable release, `release/X.Y.Z-early.N` for the early-access channel. Only pragmatic-server is tagged; the sibling packages build from their default-branch head (cloned exactly as `ci.yml` clones them; some siblings' default branch is `master`) and their commits are recorded in the descriptor. The `release` workflow (`.github/workflows/release.yml`) checks the tag, builds the eight app images with `docker/docker-bake.hcl` (`pragmatic-platform-admin`, `pragmatic-platform-edge`, `pragmatic-env-server`, `pragmatic-env-gateway`, `pragmatic-hive-agent`, `pragmatic-tenant-admin`, `pragmatic-tenant-idp`, `pragmatic-ui-unpack`), pushes each to `ghcr.io/pragmatic-tech-ai` tagged `:X.Y.Z` and `:git-<server sha>`, signs every image digest, and pushes the signed descriptor as `pragmatic-release:X.Y.Z`. All nine packages are public for now: packages a workflow pushes from a public repository inherit its visibility, and GitHub cannot make a public container package private again (making them private means deleting and republishing them). They hold no secrets. Platform-admin still reads them with the read-only credential below. The images are built from `docker/images/Dockerfile`; each carries only the packages and the files (compiled sub-trees and assets such as the operator or tenant portal) listed for it in `docker/images/closure.json`, which `docker/images/closure-check.ts` keeps in step with the code and the Dockerfile; the build stage runs that check itself. Before pushing the descriptor, the publish step verifies every signature against the trusted public key in this checkout's `release-keys/` (`--trust-dir` overrides it) and refuses, pushing nothing, when the signing secret does not match, so a wrong secret never burns a version. The control plane never publishes: after the workflow is green, a Full operator uses Refresh in the portal (or `POST /api/releases/refresh`) to import the new version. Each Refresh also re-inspects every Rejected version and replaces it once it verifies.

The read-only registry token. Create a classic personal access token with only the `read:packages` scope and write the credential file, outside the repository and never committed:

```
{ "username": "<github user>", "token": "<the token>" }
```

Point PRAGMATIC_RELEASE_CREDENTIAL_FILE at it. The same token, written as an `.npmrc`, is what a local `docker buildx bake` needs as its `npmrc` secret:

```
//npm.pkg.github.com/:_authToken=<the token>
@pragmatic-tech-ai:registry=https://npm.pkg.github.com
```

Run the local build from the workspace root `architecture-agent/`:

```
NPMRC_FILE=<path-to>/.npmrc VERSION=0.1.0 SERVER_SHA=<server sha> docker buildx bake -f pragmatic-server/docker/docker-bake.hcl --set "*.output=type=docker" --allow=fs.read=<path-to>/.npmrc
```

Trust keys and rotation. The control plane trusts a release only when its descriptor and every image are signed by a key whose public half is in the trust directory (`release-keys/`, one `<key id>.pub.pem` per key; today `release-2026-11`). The private key exists only as the `RELEASE_SIGNING_KEY` GitHub Actions secret, and only the workflow signs. To rotate: add the new `<id>.pub.pem` to `release-keys/`, change the workflow's `--key-id` to the new id, replace the `RELEASE_SIGNING_KEY` secret, and keep the old public key for as long as releases signed with it are in use.

Control plane role. PRAGMATIC_CONTROL_PLANE_ROLE is `all` (default, everything in one process) or `admin` (everything except the agent channel, the `pragmatic-platform-admin` image); `edge` is refused: the keyless edge (the `pragmatic-platform-edge` image) runs its own entry, `bin/pragmatic-platform-edged`. The operator host and the tenant plane answer `/healthz` and `/readyz` for probes.

Not runnable yet (R4). A registry release can be imported, gated for a tenant and shown in the portal, but hives cannot run it until the next piece: selecting one for a hive answers "Release X.Y.Z is in the registry but hives cannot run registry releases yet." The tenant and agent routes answer their generic refusal instead, so a tenant cannot probe which versions exist.

The manual publish path (`manifest-publish.ts` and `POST /api/manifests`) is gone. Manifest records published locally before are not migrated: they stay in the catalogue as they were, with no release provenance, and a registry release with the same id as a local one is hidden by it (reported as `shadowed`).

## Create environments

The Platform Admin portal no longer has environment screens; the /api/environments routes remain. Through them, create either a dev-blank environment (the name must be a lowercase slug, characters a-z, 0-9 and hyphen) or a demo-contoso environment (seeds the Contoso security model and four demo users). Each is a pragmatic-server:dev container on an allocated host port. Connect over HTTP at http://localhost:PORT and over WebSocket at ws://localhost:PORT/?environment=ENVIRONMENT.

## Gated integration smoke

Requires Docker and the built image. It creates, starts, stops and deletes a dev and a demo environment end to end, and checks the seeded users. It creates the dev environment as a Development type and the demo as a Runtime type, and asserts each type reaches the numeric purpose in the generated environments.json (0 and 1). The smoke is operator-run: it needs Docker and the pragmatic-server:dev image. It also drives the promote path: it authors a graph on a development environment with a maker token, promotes it to a runtime environment and reads it back over cypher, deploys an environment-bound and a bundled app there, and confirms a Viewer sees a re-promoted graph on the same connection without a redeploy. Identity administration (accounts, roles, security model) lives on the tenant plane and is covered by the tenant-admin smoke, not here. It is not part of the normal test run.

```
npx tsx admin/control-plane/control-plane-smoke.ts
```

## Gated k8s Hive smoke

Requires the dev kind cluster (context kind-pragmatic-dev; `npx tsx admin/control-plane/dev/dev-cluster.ts up` creates it and loads the pragmatic-server:dev image onto its node; PRAGMATIC_SMOKE_CONTEXT picks another cluster). It drives a throwaway dev-blank environment through the real KubectlHiveOrchestrator: Apply, WaitHealthy, a /healthz check through kubectl port-forward, Roll, and Teardown (asserting the namespace is NotFound afterwards); the namespace is removed in a finally block even on failure. The stock workload only sets PRAGMATIC_PORT, so the smoke adds local-only boot env (base dir, environment id and a throwaway random master key) so the pod can reach Ready; injecting real config and secrets into k8s workloads belongs to SP-HIVE-3. The first run can take about a minute while the node loads the image. Like the control-plane smoke it is operator-run and not part of the normal test run.

```
npx tsx admin/control-plane/k8s-hive-smoke.ts
```

## Gated registry provenance smoke

Requires Docker, the dev kind cluster (context kind-pragmatic-dev; see `dev/dev-cluster.ts`) and the pragmatic-server:dev image. It starts a real registry:2 container on localhost:5000, pushes the image to it, and signs the image digest with a throwaway dev Ed25519 key kept in temporary key and signature stores. It then drives a real KubectlHiveOrchestrator for a provision-registry hive: the signed image verifies, Apply succeeds, WaitHealthy reports the pod Ready, and the running image ref is localhost:5000/pragmatic-server:dev. It then corrupts the stored signature (and separately swaps the trust root to a different key) and asserts a further Apply throws ImageVerificationError and creates no namespace, proving the gate refuses before kubectl apply. The namespaces, the registry container and the temporary stores are removed in a finally block. It reuses the k8s smoke's local-only boot env. Because the image is also in the local docker image store and the manifest uses imagePullPolicy IfNotPresent, the node may resolve the registry-tagged image locally rather than pulling over HTTP; a node that must really pull from localhost:5000 needs it configured as an insecure registry. Operator-run and not part of the normal test run.

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

Requires the dev kind cluster (context kind-pragmatic-dev; see `dev/dev-cluster.ts`) and the pragmatic-server:dev image. It tags the dev image as pragmatic-server:v1 and pragmatic-server:v2 (the same bits under two refs; what differs is the ref the Deployment runs), signs both refs with a throwaway dev Ed25519 key into the stores of the HiveOrchestratorFactory data root, and composes a real PlatformDeploymentRegistry over temporary files. It publishes and gates v1 and v2, brings a throwaway environment up on v1 (reusing the k8s smoke's local-only boot env), then SelectTarget(hive, v2) pushes the roll through the SP-HIVE-3 signature gate and the smoke asserts the live Deployment now runs pragmatic-server:v2; SelectTarget(hive, v1) is the rollback and is asserted the same way. The namespace, the two extra image tags and the temporary stores are removed in a finally block. Operator-run and not part of the normal test run.

```
npx tsx admin/control-plane/rollout-push-smoke.ts
```

## Gated rollout pull-agent smoke

Proves the pull path on the dev kind cluster (context kind-pragmatic-dev; see `dev/dev-cluster.ts`). The pragmatic-server:dev image must have been built after the pull agent landed, because the agent Deployment runs `node dist/bin/pragmatic-agentd.js` from it (build invocation is in docker/Dockerfile's header; run it from the workspace root architecture-agent/ with context `.`). The smoke tags and signs v1 and v2 as in the push smoke, registers the hive to obtain the machine token, stores it in a Secret (key token) in the environment namespace, brings the environment up on v1, and applies the agent objects (ServiceAccount, Role, RoleBinding, Deployment) pointing at a locally served ControlPlaneHost. The host only accepts loopback Host headers, so a small proxy listening on all interfaces rewrites the Host header and the pod reaches it as host.docker.internal. SelectTarget(hive, v2) goes through a second registry whose backend is unreachable, so it only records the selection and nothing pushes. The smoke then polls (bounded) until the in-cluster agent has patched the server Deployment to v2 on its own and has reported back so the rollout status shows the environment no longer obsolete. The namespace, the local server and proxy, the two extra image tags and the temporary stores are removed in a finally block. Operator-run and not part of the normal test run.

Known caveat: a kind node keeps its own image cache keyed by tag, so a rebuilt pragmatic-server:dev can be shadowed by a stale node copy. If the agent pod fails with a missing module, re-run `npx tsx admin/control-plane/dev/dev-cluster.ts up` (it re-loads the image onto the node), or remove the stale copy with `docker exec pragmatic-dev-control-plane crictl rmi docker.io/library/pragmatic-server:dev` (and the :v1 / :v2 tags).

```
npx tsx admin/control-plane/rollout-pull-smoke.ts
```
