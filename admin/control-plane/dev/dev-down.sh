#!/usr/bin/env bash
# Stops the transient TLS proxy. Durable state (admin/control-plane/data) and the per-tenant
# IdP container persist, so the next dev-up resumes the same deployment.
set -euo pipefail
docker rm -f pragmatic-dev-caddy >/dev/null 2>&1 && echo "stopped caddy proxy" || echo "caddy proxy not running"
echo "The control-plane server runs in your dev-up terminal (Ctrl-C there to stop it)."
echo "Left intact: the console Postgres (pragmatic-dev-postgres, volume pragmatic-dev-postgres-data), the tenant IdP container"
echo "(pragmatic-idp-acme) and durable data under admin/control-plane/data."
