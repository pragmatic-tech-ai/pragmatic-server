# Local durable dev deployment

A persistent, production-faithful-HTTPS local stack: the platform (operator) admin panel, a tenant
admin panel over TLS on a real subdomain, and a seeded tenant with a local hive.

## Topology

- **Platform admin panel (operator):** `http://127.0.0.1:7000` — loopback, as in production (the operator
  plane is loopback-only by design). Operator: `admin@control-plane.test` / `dev-admin-pw`.
- **Tenant admin panel:** `https://acme.lvh.me` — a Caddy container terminates TLS on `:443` with the local
  dev CA and reverse-proxies to the tenant plane on `:7100`. `*.lvh.me` resolves to `127.0.0.1` via public DNS,
  so every tenant subdomain works with no hosts-file edits.
- **Tenant IdP:** each tenant runs its own `pragmatic-idp` container (acme: `https://host.docker.internal:12100`).
  Login redirects from the tenant panel land on it.
- **Local hive:** `acme-hive` (`backend=local, mode=attach`) bound to tenant `acme`, on docker-desktop Kubernetes.

Durable state lives in `admin/control-plane/data/` (gitignored): tenants, clients, hives, the IdP registry,
sessions, and the master key. Stop and restart anytime — state (and the IdP container + volume) persists.

## First-time setup (once)

1. **Trust the dev CAs** (needs Administrator — the one step the harness can't do for you):
   open an elevated PowerShell and run `trust-ca.ps1`. It trusts the Caddy `*.lvh.me` CA and the acme IdP CA
   so the browser accepts the dev TLS without warnings. Restart the browser afterward.

## Run

```bash
bash admin/control-plane/dev/dev-up.sh     # starts Caddy (:443) + the control-plane server (foreground)
bash admin/control-plane/dev/dev-seed.sh   # (first run only) seeds client + tenant acme + local hive; writes dev-info.txt
bash admin/control-plane/dev/dev-down.sh   # stops the Caddy proxy (Ctrl-C the dev-up terminal to stop the server)
```

`dev-info.txt` (gitignored) holds the URLs and the one-time tenant-owner password captured at provision time.
Log into the tenant panel at `https://acme.lvh.me` as `owner@acme.test` with that password.

## Dev tradeoffs (vs production)

- The session cookies are **not** `Secure`-flagged, because the operator panel is served over loopback HTTP
  (one shared secure-cookie flag drives both planes). They still work over the tenant panel's HTTPS. To make
  them `Secure`, front the operator plane with TLS too and set `PRAGMATIC_ADMIN_SECURE_COOKIE=true`.
- TLS uses a local dev CA (not a public one); hence the one-time `trust-ca.ps1` step.
- Each additional tenant gets its own IdP CA under `data/idp/<tenant>/tls/ca.crt` — trust it the same way
  (copy it beside this README as `<tenant>-idp-ca.crt` and re-run `trust-ca.ps1`).
