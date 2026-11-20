#!/usr/bin/env bash
# Brings up the durable local dev deployment:
#   - the dev kind cluster `pragmatic-dev` (context kind-pragmatic-dev) the local hive runs on
#   - operator (platform admin) panel  : http://127.0.0.1:7000     (loopback)
#   - tenant admin panel               : https://<tenant>.lvh.me   (Caddy :443 -> tenant plane :7100)
#   - the console's own Postgres       : 127.0.0.1:55433           (container pragmatic-dev-postgres)
# Durable state: the Postgres volume pragmatic-dev-postgres-data and admin/control-plane/data (gitignored: keys, the
# database password and URL file, the JSON files of before the database). Re-run anytime; state persists.
# This script runs the control-plane server in the FOREGROUND (it is the long-lived process);
# the Caddy TLS proxy runs as a detached container started first. Ctrl-C stops the server;
# run dev-down.sh to also stop Caddy.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CP="$(cd "$HERE/.." && pwd)"
CERTS_WIN="$(cd "$HERE/certs" && pwd -W)"
CADDYFILE_WIN="$(cd "$HERE" && pwd -W)/Caddyfile"

# 0) The dev kind cluster `pragmatic-dev` the local hive runs on (created when missing; the images re-loaded each run).
(cd "$CP" && npx tsx dev/dev-cluster.ts up)

# 1) Caddy TLS terminator on :443 -> tenant plane (host.docker.internal:7100).
docker rm -f pragmatic-dev-caddy >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name pragmatic-dev-caddy \
	-p 443:443 \
	-v "${CERTS_WIN}:/certs:ro" \
	-v "${CADDYFILE_WIN}:/etc/caddy/Caddyfile:ro" \
	caddy:2 >/dev/null
echo "[dev-up] caddy TLS proxy on https://*.lvh.me -> tenant plane :7100"

# 2) The console's own Postgres (A5: every record of the console lives in its database). One container, data on the named
#    volume pragmatic-dev-postgres-data, published on host loopback only; its password and the URL file live under
#    data/postgres (gitignored). The official postgres:17 base of pragmatic-postgres (one database needs no reconcile);
#    switch to ghcr.io/pragmatic-tech-ai/pragmatic-postgres once a platform release carries it.
PG_DIR="$CP/data/postgres"
mkdir -p "$PG_DIR"
[ -s "$PG_DIR/password" ] || head -c 32 /dev/urandom | base64 | tr -d '+/=
' > "$PG_DIR/password"
PG_DIR_WIN="$(cd "$PG_DIR" && pwd -W)"
if ! docker ps --format '{{.Names}}' | grep -qx pragmatic-dev-postgres; then
	docker rm -f pragmatic-dev-postgres >/dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run -d --name pragmatic-dev-postgres --restart unless-stopped 		-p 127.0.0.1:55433:5432 		-e POSTGRES_USER=platform_admin -e POSTGRES_DB=platform_admin -e POSTGRES_PASSWORD_FILE=/run/secrets/password 		-v "${PG_DIR_WIN}/password:/run/secrets/password:ro" 		-v pragmatic-dev-postgres-data:/var/lib/postgresql/data 		postgres:17.12-trixie >/dev/null
fi
until docker exec pragmatic-dev-postgres pg_isready --host=127.0.0.1 --quiet; do sleep 1; done
printf 'postgres://platform_admin:%s@127.0.0.1:55433/platform_admin
' "$(cat "$PG_DIR/password")" > "$PG_DIR/platform-admin.url"
export PRAGMATIC_ADMIN_DATABASE_URL_FILE="$PG_DIR/platform-admin.url"
echo "[dev-up] postgres on 127.0.0.1:55433 (database platform_admin)"

# 3) A data folder from before the database: imported once (the JSON files stay as they are). Exit 3 = the database
#    already holds the records (imported earlier, or written by the console since): nothing to do.
if [ -f "$CP/data/master.key" ] && { [ -d "$CP/data/identity" ] || [ -f "$CP/data/clients.json" ]; }; then
	(cd "$CP" && npx tsx bin/pragmatic-admin-import.ts --data-root data) || [ $? -eq 3 ]
fi

# 4) Control-plane server: operator :7000 + tenant plane :7100 (bind 0.0.0.0 so the Caddy container can reach it).
export PRAGMATIC_ADMIN_PORT=7000
export PRAGMATIC_ADMIN_OPERATOR_EMAIL='admin@control-plane.test'
export PRAGMATIC_ADMIN_OPERATOR_PASSWORD='dev-admin-pw'
export PRAGMATIC_ADMIN_SECURE_COOKIE=false
export PRAGMATIC_TENANT_ADMIN_PORT=7100
export PRAGMATIC_TENANT_ADMIN_BIND=0.0.0.0
export PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN=lvh.me
export PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME=https
echo "[dev-up] starting control-plane server (operator http://127.0.0.1:7000, tenant plane :7100)"
cd "$CP"
exec npx tsx server.ts
