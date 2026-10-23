# SP-HIVE-6c — IdP Deployment, Federation & Tenant Binding (DESIGN / DECISIONS)

**Status: AWAITING USER DECISIONS — NOT approved for build.** Written during the 2026-10-23 AFK run as the design artifact for the sub-project SP-HIVE-6b deferred (ruling R5). It lays out the decisions that are the user's to make, each with options and a recommended default. The user vetoes/adjusts, then this becomes a build spec → plan → SDD.

**Consumes:** SP-HIVE-6a (the local OIDC IdP) + SP-HIVE-6b (the admin API, `IdpAdminClient`, email/name claims). 6b built the *mechanism*; 6c makes it *live* end-to-end.

## 1. Intent

After 6b, the IdP can be provisioned over an authenticated admin API and emits the right claims — but nothing in production calls it, no IdP process is actually deployed/reachable, and an environment has no link to the tenant realm it should federate to. 6c closes that: a reachable platform IdP, the control-plane wired to provision it (Owner at tenant-create, client at env-create), environments federating to the tenant realm over TLS for true SSO, and the `tenantId`→environment-id disambiguation. This is the slice that turns 6a/6b into a working login.

Every item below rests on a real deployment/topology decision; that is why 6b stopped here rather than shipping it unattended.

## 2. Decisions the user must make (options + recommendation)

### D1 — Where the platform IdP runs
- **Options:** (a) one **platform-level IdP service** (a single `pragmatic-idp` process/Deployment multiplexing all tenants via realms), reachable at a configured base URL; (b) **per-hive** IdP sidecar; (c) **per-tenant** IdP.
- **Recommend (a).** Matches 6a's realm-multiplexing design and 6b-R4; one admin surface, one issuer host. In dev it is a host process (the `pragmatic-idp` bin already exists); in a hive it is a Deployment+Service. **The admin API shape built in 6b is topology-agnostic, so this choice is reversible.**
- **Blast radius if changed later:** the issuer base URL per environment (and thus the `iss` claim contract) moves — so pin it deliberately.

### D2 — Container → IdP reachability and the issuer host
- **Problem (6b builder-check #4):** environments run as Docker containers on per-env networks; a served app inside the container must reach the issuer/discovery URL, AND the RP verifies `iss == <baseUrl>/<tenant>` byte-for-byte. `127.0.0.1:7100` from inside a container does not reach a host IdP.
- **Options:** (a) dev: `host.docker.internal:<port>` as the in-container issuer/discovery host; (b) k8s: an in-cluster Service DNS name; (c) a shared Docker network joining env containers and the IdP.
- **Recommend:** per-environment **IdP base URL injected at container launch** (`docker.ts` env), `host.docker.internal` in dev / Service DNS in a hive. The `iss` claim and the discovery URL must use the SAME host — pin that the injected issuer equals the discovery origin.

### D3 — Served-app CA trust
- **Problem (6b builder-check #5):** the relying party is the served app INSIDE the container; it must trust the IdP's dev-CA over TLS. The 6b `IdpAdminClient` injects the CA via a `node:https` agent, but the served app is a different process.
- **Options:** (a) mount the dev CA into the container + set `NODE_EXTRA_CA_CERTS` at container launch (works here, unlike in the 6a smoke, because the container process starts *after* the CA exists); (b) a real CA-signed cert in prod.
- **Recommend (a)** for dev via `docker.ts`; real certs in prod. This is the clean use of `NODE_EXTRA_CA_CERTS` the 6a smoke couldn't use.

### D4 — Admin-token sharing across the two processes
- **Problem (6b builder-check #3):** 6b has the IdP load its admin token by ref from its own `secrets/` dir, and the control-plane hold "the same token"; but the two processes have separate stores and 6b never said who generates it or how it reaches both.
- **Options:** (a) the **control-plane generates** the admin token at IdP-deploy and writes it into the IdP's `secrets/<ref>` file (and holds it by ref in its own config); (b) an operator sets both out of band.
- **Recommend (a).** Symmetric with 6b-R2 (control-plane generates secrets). The IdP's fail-closed loader (built in 6b) already does the right thing when the file is present/absent.

### D5 — Environment → platform-tenant binding (the realm-key identity)
- **Problem (6b builder-check #1, #2):** `EnvironmentService.Create` does not know its platform tenant, and "a realm shared across a tenant's environments" cannot be realized while `tenantId` is the per-environment id.
- **Key insight:** an environment is created **under a Hive**, and `HiveRecord.tenantId` **is the platform tenant** (`Client→Tenant→Hive→Environment`). So the **tenant realm = `HiveRecord.tenantId`**, shared across every environment under every hive of that tenant. The binding already exists in the hierarchy — env → hive → `hive.tenantId` = the realm key / issuer tenant.
- **Recommend:** derive the realm/issuer tenant from the environment's hive's `tenantId`; the IdP realm is keyed by the platform `TenantRecord.id`. This resolves the realm-key ambiguity WITHOUT the rename (D7) being a prerequisite.

### D6 — The provisioning wiring (follows once D1–D5 are set)
- `CreateTenant` → ensure the tenant realm + seed the **Owner** login (one-time password reveal in the response, `Cache-Control: no-store`; persist only non-secret owner metadata — needs a `TenantRecord` field, 6b builder-check #13).
- `EnvironmentService.Create` → generate a client secret (R2), `IdpAdminClient.RegisterClient` (redirect URI = the environment's served callback, D2), inject `generic-oidc` providerSettings (`issuer`/`discoveryUrl`/`clientId`/`redirectUri`/`secretRef`) into `WriteTenantConfig` and the raw secret by ref into `WriteSecrets`.
- Enforce the `_`-reserved realm namespace at `CreateTenant` (reject a tenant id starting with `_`, 6b builder-check #12).
- Idempotency + partial-failure policy (realm-ensure ok but seed fails, IdP unreachable): decide rollback vs idempotent-retry of the `TenantRecord`/`EnvironmentRecord` (6b builder-check #7, #11).

### D7 — The `tenantId` → environment-id rename & migration
- **The big one (6b-R1).** ~465 sites/91 files; touches on-disk layout (`data/<tenantId>/…`), JSON keys (`tenants.json`, `tenant-config.json`), secret-ref strings (`<tenantId>-admin-pw`), env vars (`PRAGMATIC_TENANT_ID`, …), the id_token `iss` URL, and Redis flow-state key prefixes.
- **Options:** (a) **full rename + data migration** (rename on-disk, env vars, issuer; write a migrator for existing environments); (b) **semantic-only** — rename in-memory symbols/params to `environmentId` but keep the serialized keys/env-vars/issuer as-is (no migration, no external-contract break); (c) **leave as-is**, document the collision.
- **Recommend (b)** first (disambiguates the code with zero blast radius), with (a) as a later, deliberate migration if the external names must change. **This needs the user present** — it is a data-migration + external-contract decision.

## 3. Proof (once built)
- A real **docker e2e**: provision a tenant (get the one-time Owner password), create an environment under a hive, confirm the served app in the container federates to the tenant realm over TLS and a browser login yields a session with `email`/`name`; a second environment under the same tenant rides SSO. (This is the live version of the 6b gated smoke, against real containers.)

## 4. Non-goals
- Cloud-backend hive provisioning (SP-HIVE-5's cloud follow-on); upstream Entra/Google federation; IdP HA/persistent stores/graceful shutdown (all still deferred).

## 5. What to decide first
D1 (where the IdP runs) and D5 (realm = `hive.tenantId`) unlock everything else; D2/D3/D4 are the dev-topology mechanics; D6 is mechanical once D1–D5 are fixed; D7 can proceed independently (recommend option (b) to start). Bring D1, D5, and the D7 scope to the table; the rest have safe defaults above.

---

## DECISIONS RESOLVED (2026-10-23, with the user)

- **D1 = Per-tenant IdP.** One `pragmatic-idp` per tenant (own issuer, keys, admin token, data). Hosting default (user may override): the control-plane **launches a per-tenant IdP at tenant-create** — a port-allocated host process in dev (as it spawns environments), a per-tenant Deployment+Service in a hive. Supersedes the doc's platform-level recommendation.
- **D2 = default accepted** — per-environment in-container issuer/discovery URL injected at container launch (`host.docker.internal` dev / Service DNS in-hive); `iss` == discovery origin.
- **D3 = default accepted** — served-app CA trust via `NODE_EXTRA_CA_CERTS` mounted at container launch (dev); real certs in prod.
- **D4 = per-tenant admin token**, control-plane-generated and written to that tenant's IdP secrets ref at IdP launch (held by ref in control-plane config).
- **D5 = realm keyed by the platform tenant (`hive.tenantId`)** — one shared login across all environments under all of a tenant's hives; env→tenant resolved via the hive.
- **D6 = default accepted** — `CreateTenant` ensures realm + seeds Owner (one-time password reveal, `Cache-Control: no-store`, non-secret owner metadata on `TenantRecord`); `EnvironmentService.Create` generates the client secret, `IdpAdminClient.RegisterClient`, injects `generic-oidc` providerSettings + secret-by-ref into the bundle; enforce the `_`-reserved realm namespace at `CreateTenant`; idempotent-retry (not rollback) on partial provisioning failure.
- **D7 = FULL rename + migration NOW**, carved into ITS OWN plan/SDD (SP-HIVE-6c-rename): rename the environment-scope `tenantId`→`environmentId` across ~465 sites incl. on-disk layout (`data/<id>/…`), JSON keys, secret refs, env vars (`PRAGMATIC_TENANT_*`), the id_token issuer URL, Redis prefixes, + a data migrator. Chosen pre-production so there is no live data/contract to break. Sequence the rename as its own sub-project; 6c's provisioning wiring consumes the renamed symbols.

**Build sequencing (proposed):** (1) SP-HIVE-6c-rename (the full rename + migrator) → (2) SP-HIVE-6c proper (per-tenant IdP launch + control-plane provisioning wiring + container federation). Both now have resolved decisions and can go to plan/SDD.
