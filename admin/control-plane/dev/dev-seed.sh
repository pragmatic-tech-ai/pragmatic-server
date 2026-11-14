#!/usr/bin/env bash
# Seeds the durable dev deployment via the operator API (the same path the operator panel UI uses):
#   client "dev-client" -> tenant "acme" (launches its per-tenant pragmatic-idp container) -> local hive "acme-hive".
# Idempotent-ish: re-running after the tenant exists just reports the existing owner can't be re-revealed.
# Writes connection details + the one-time tenant owner password to dev/dev-info.txt (gitignored).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OP='http://127.0.0.1:7000'
ORIGIN="-H Origin:${OP}"
JAR="$(mktemp)"
INFO="$HERE/dev-info.txt"

echo "[seed] operator login"
curl -fsS -c "$JAR" -X POST "$OP/api/login" -H 'Content-Type: application/json' \
	-d '{"email":"admin@control-plane.test","password":"dev-admin-pw"}' >/dev/null

echo "[seed] client dev-client"
curl -sS -b "$JAR" $ORIGIN -X POST "$OP/api/clients" -H 'Content-Type: application/json' \
	-d '{"id":"dev-client","displayName":"Dev Client"}' >/dev/null || true

echo "[seed] tenant acme (provisions its IdP container; this can take ~30s)"
RESP="$(curl -sS -b "$JAR" $ORIGIN -X POST "$OP/api/tenants" -H 'Content-Type: application/json' \
	-d '{"id":"acme","clientId":"dev-client","displayName":"Acme","ownerEmail":"owner@acme.test"}')"

# The hive attaches to the dev kind cluster (dev-up.sh creates it) and pulls the images dev-cluster.ts loaded onto its
# node, as the live-loop e2e hive does (a host registry on localhost:5000 is not reachable from a kind node).
echo "[seed] local hive acme-hive (backend=local, mode=attach, cluster kind-pragmatic-dev)"
curl -sS -b "$JAR" $ORIGIN -X POST "$OP/api/hives" -H 'Content-Type: application/json' \
	-d '{"id":"acme-hive","tenantId":"acme","displayName":"Acme Local Hive","cluster":{"backend":"local","mode":"attach","configRef":"kind-pragmatic-dev"},"registry":{"mode":"attach"}}' >/dev/null || true

OWNER_PW="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(o?.owner?.password??"")}catch{process.stdout.write("")}})')"
{
	echo "Pragmatic local dev deployment"
	echo "  Platform admin panel : http://127.0.0.1:7000   (operator: admin@control-plane.test / dev-admin-pw)"
	echo "  Tenant admin panel   : https://acme.lvh.me      (tenant owner: owner@acme.test)"
	if [ -n "$OWNER_PW" ]; then echo "  Tenant owner password: $OWNER_PW"; else echo "  Tenant owner password: (already provisioned earlier; not re-revealable)"; fi
	echo "  Local hive           : acme-hive (backend=local, mode=attach), bound to tenant acme"
} > "$INFO"
echo "[seed] done -> $INFO"
cat "$INFO"
