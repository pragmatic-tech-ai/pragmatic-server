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
- **Local hive:** `acme-hive` (`backend=local, mode=attach`) bound to tenant `acme`, on the dev kind cluster
  `pragmatic-dev` (context `kind-pragmatic-dev`). `dev-up.sh` creates it when missing and loads `pragmatic-server:dev`,
  `registry:2` and `postgres:16` onto its node on every run, so a rebuilt server image reaches the hive. It maps no host
  port, so it runs beside Caddy and the live-loop e2e cluster. Docker Desktop's built-in Kubernetes is not used; you can
  turn it off. Manage the cluster on its own with `npx tsx admin/control-plane/dev/dev-cluster.ts up|down` (needs
  `kind` on PATH). A hive seeded before this change keeps its stored settings: one without a `configRef` now lands on
  `kind-pragmatic-dev`, but a `registry.mode` of `provision` still points its workloads at `localhost:5000`, which a kind
  node cannot reach. Recreate such a hive with `registry.mode` `attach` (re-running `dev-seed.sh` does not
  replace an existing hive).

Durable state lives in `admin/control-plane/data/` (gitignored): tenants, clients, hives, the IdP registry,
sessions, and the master key. Stop and restart anytime — state (and the IdP container + volume) persists.

## First-time setup (once)

1. **Trust the Caddy dev CA** (needs Administrator — the one step the harness can't do for you):
   open an elevated PowerShell and run `trust-ca.ps1`. It trusts the Caddy `*.lvh.me` CA so the browser accepts
   the tenant panel's TLS without warnings.
2. **Trust the acme IdP CA** (no elevation) after `dev-seed.sh` has provisioned acme: run `dev-ca-trust.ps1`
   with `-CaFile admin\control-plane\data\idp\acme\tls\ca.crt -Install` (see "Local platform IdP certificates").
   Restart the browser afterward.

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
- Each additional tenant gets its own IdP CA under `data/idp/<tenant>/tls/ca.crt`. It is name-constrained to
  `host.docker.internal` and `127.0.0.1`, so trust it for your Windows user with `dev-ca-trust.ps1` (see below).

## Development console certificates

The in-hive console is served over TLS signed by a per-domain development CA. The portal shows the CA file path;
trust it for your Windows user (no elevation, Windows shows its own confirmation) or remove it again:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -CaFile <ca.crt> -Install
powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -CaFile <ca.crt> -Remove
powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -CaFile <ca.crt> -ShowThumbprint
```

Add `-WhatIf` to `-Install` or `-Remove` to see what would happen without changing the store. `-Install` refuses
anything that is not a name-constrained CA. After the CA file is gone, remove it by thumbprint with
`-Thumbprint <40 hex> -Remove`.

## Local platform IdP certificates

A tenant's local IdP container serves TLS signed by its own CA, `data/idp/<tenant>/tls/ca.crt`, name-constrained to
`host.docker.internal` and `127.0.0.1`. Trust or remove it with the same `dev-ca-trust.ps1` commands as above.

An IdP whose CA predates the name constraint is refused by `-Install`. To replace that CA, stop the control plane,
delete the whole `data/idp/<tenant>/tls/` directory (only a missing directory is re-minted; a partly missing set of
files still fails recovery, so a CA is never replaced by accident), and start it again. The next tenant sign-in or
environment action recovers the IdP in place (same port and identity volume) with a new, constrained CA.
Environments created before the swap still trust the old CA, so recreate them.

An old CA that an earlier version of this guide had you trust machine-wide (a copy such as `certs\acme-idp-ca.crt`
imported by `trust-ca.ps1`) is not in your user store, so `dev-ca-trust.ps1 -Remove` cannot reach it. Read its
thumbprint with `dev-ca-trust.ps1 -CaFile <old ca.crt> -ShowThumbprint`, then remove it from an elevated PowerShell
with `Remove-Item Cert:\LocalMachine\Root\<thumbprint>`.

The server image can be rebuilt under the same tag. On the next tenant sign-in or environment action, the control
plane compares the image a healthy IdP container runs with the image the tag now names, and recreates a stale
container on the current image, on the same port and identity volume. This signs out anyone signed in to that IdP,
because its sessions are held in memory. If the new image cannot come up, the container is brought back on the
image it ran before and that sign-in or action still proceeds. That build is then left alone (a later recovery
also uses the image it fell back to) until the tag names another build or the control plane restarts. The
refusal is held in memory, and any failed start counts, including one slower than the health deadline.
