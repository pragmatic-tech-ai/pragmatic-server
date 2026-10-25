#!/usr/bin/env bash
# Brings up the durable local dev deployment:
#   - operator (platform admin) panel  : http://127.0.0.1:7000     (loopback)
#   - tenant admin panel               : https://<tenant>.lvh.me   (Caddy :443 -> tenant plane :7100)
# Durable state lives under admin/control-plane/data (gitignored). Re-run anytime; state persists.
# This script runs the control-plane server in the FOREGROUND (it is the long-lived process);
# the Caddy TLS proxy runs as a detached container started first. Ctrl-C stops the server;
# run dev-down.sh to also stop Caddy.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CP="$(cd "$HERE/.." && pwd)"
CERTS_WIN="$(cd "$HERE/certs" && pwd -W)"
CADDYFILE_WIN="$(cd "$HERE" && pwd -W)/Caddyfile"

# 1) Caddy TLS terminator on :443 -> tenant plane (host.docker.internal:7100).
docker rm -f pragmatic-dev-caddy >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name pragmatic-dev-caddy \
	-p 443:443 \
	-v "${CERTS_WIN}:/certs:ro" \
	-v "${CADDYFILE_WIN}:/etc/caddy/Caddyfile:ro" \
	caddy:2 >/dev/null
echo "[dev-up] caddy TLS proxy on https://*.lvh.me -> tenant plane :7100"

# 2) Control-plane server: operator :7000 + tenant plane :7100 (bind 0.0.0.0 so the Caddy container can reach it).
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
