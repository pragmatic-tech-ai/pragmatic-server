# Local dev with docker compose

`docker-compose.yml` (in the `pragmatic-server` root) runs the server for local development. The build context is the parent workspace directory, so private sibling packages resolve; the Dockerfile needs the BuildKit secret `npmrc` for private dependencies.

## 1. Generate a dev master key

The server reads its master key from a file mounted at `/run/secrets/master_key`. Create a 32-byte key:

    head -c 32 /dev/urandom > docker/master.key

or, without a POSIX shell:

    node -e "require('fs').writeFileSync('docker/master.key', require('crypto').randomBytes(32))"

`docker/master.key` (and any `docker/*.key`) is gitignored. Never commit it.

## 2. Start and stop

    docker compose up --build
    docker compose down

State lives in the named volume `pragmatic-data` (mounted at `/data`). Use `docker compose down -v` to wipe it.

## 3. Tenants

`docker/tenants.example.json` is mounted read-only as the tenants file. It declares one tenant, `acme`. Copy and edit it for your own tenants, then point the bind mount at your copy.

## 4. Connect a client

    ws://localhost:8080/?tenant=acme

## Multi-replica

A Redis coordinator is sketched (commented) in the compose file for the deferred multi-replica story.
