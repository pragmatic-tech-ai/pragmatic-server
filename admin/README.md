# Admin control plane runbook

The control plane is a local web portal plus HTTP API that creates, starts, stops and deletes pragmatic-server environments as Docker containers.

## One-time image build

Needs Docker with BuildKit, and an .npmrc containing the scoped registry token. Run from the workspace parent directory (one level above pragmatic-server):

```
DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path-to>/.npmrc -t pragmatic-server:dev ..
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

## Generated data and portal tests

admin/control-plane/data/ holds generated bundles, registry.json, provisioned secrets and master keys. It is generated and gitignored; never commit it. The Playwright portal spec is gated on a one-time browser install:

```
npx playwright install chromium
```
