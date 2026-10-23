# SP-HIVE-6c-proper — Per-Tenant IdP Launch + Provisioning + Federation (design)

**Status:** design, decisions resolved with the user (2026-10-23). Second of the two 6c builds (after 6c-rename, now shipped). Ready for plan → SDD. User chose: **build the whole thing as one sub-project**, with a **per-tenant IdP running as a Docker container**.

**Consumes:** 6a (IdP), 6b (admin API + `IdpAdminClient` + email/name claims), 6c-rename (environmentId/tenantId split + env→tenant binding). Parent decisions: 6c design doc D1–D6.

## 1. Intent

Make the tenant identity realm real end-to-end: the control-plane launches one `pragmatic-idp` per tenant, seeds its Owner at tenant-create, registers each environment as an OIDC client at environment-create, and federates the served app to the tenant realm so a browser login works. This turns 6a/6b from a provisioning mechanism into a working SSO login.

## 2. Scope (one sub-project)

**A. Per-tenant IdP container launch.** Reuse the existing `pragmatic-server` image with the IdP entrypoint overridden (`node dist/bin/pragmatic-idpd.js`) — no new image build; the bin already ships in `dist/bin/`. A new `IdpContainerEnv` (a `DockerEnv`-style wrapper) runs/stops/health-checks one IdP container per tenant. An `IdpService` (mirroring `EnvironmentService`): per tenant, allocate a port (a second `PortAllocator` floor), prepare the IdP data dir (mint the DevCa for the issuer host, write the admin-token file), run the container, wait healthy, persist an `IdpRecord`, with rollback on failure.

**B. Admin-token provisioning.** The control-plane generates a per-tenant admin token (`randomBytes(32).base64url`), writes it to `<idpData>/secrets/<ref>` **before** launching the IdP (the IdP's fail-closed loader then enables its admin API), and retains the plaintext to drive `IdpAdminClient`. Never logged.

**C. Tenant-create provisioning.** `TenantRecord` gains non-secret owner metadata (`ownerEmail`, `ownerPrincipalId`) + IdP coordinates (`idpBaseUrl`, `idpCaRef`, `idpAdminTokenRef`). A `TenantProvisioningService` wraps `CreateTenant`: launch the tenant's IdP (A), `IdpAdminClient.EnsureRealm` + `SeedAccount` (Owner, generated password, with displayName), and return the Owner's **one-time password** in the `POST /api/tenants` response (`Cache-Control: no-store`). Enforce the `_`-reserved realm namespace at `CreateTenant`.

**D. Environment-create federation.** When an environment is bound to a hive→tenant that has an IdP, `EnvironmentService.Create` (after the port is allocated, before `docker.Up`): generate a client secret, `IdpAdminClient.RegisterClient(platformTenantId, { clientId, redirectUris, secret })` against the tenant's IdP, and inject into the bundle — `WriteTenantConfig` flips `packId` to `generic-oidc` with `providerSettings` (issuer/discoveryUrl/clientId/redirectUri/secretRef), `WriteSecrets` adds the raw secret by ref. Unbound environments (no hive/tenant/IdP) keep today's `local` pack behavior.

**E. Container → IdP federation wiring.** `DockerEnv.RunArgs` gains: a read-only mount of the tenant IdP's `ca.crt` + `NODE_EXTRA_CA_CERTS` pointing at it, so the served app's relying party trusts the IdP TLS. The issuer/discovery URL injected into the bundle is the container-and-browser-reachable IdP URL (§5).

**F. Gated end-to-end smoke.** A real-Docker smoke: provision a tenant (get the one-time Owner password), create a hive + a bound environment, drive an OIDC login against the tenant realm through the served container, assert a session with `email`/`name`; a second environment under the same tenant rides SSO. Gated (needs Docker + the image), run manually.

## 3. Decisions

1. **Reuse the `pragmatic-server` image, override the entrypoint** to the IdP bin — avoids a second image build; the IdP bin is already in `dist/bin/`.
2. **Per-tenant IdP container**, launched by the control-plane mirroring `EnvironmentService` (port-alloc, run, health-wait, `IdpRecord`, rollback). A second `PortAllocator` floor for IdP ports.
3. **Issuer host = `host.docker.internal`** (§5) — the one URL that resolves from both the browser-on-host and the env container on Docker Desktop; DevCa SAN covers it.
4. **Admin token:** control-plane-generated, written to the IdP secrets ref pre-launch, held to drive the admin client. Per-tenant.
5. **Owner password:** generated, seeded via the admin API, revealed **once** in the tenant-create response; only non-secret owner metadata persisted on `TenantRecord`.
6. **`redirectUri` is browser-facing** (`http://localhost:<envHostPort>/auth/oidc/callback`); **issuer/discovery is container-and-browser-facing** (`https://host.docker.internal:<idpPort>/<tenantId>`). These differ by design — the browser posts the code back to the env, the env's RP fetches tokens from the IdP.
7. **CA trust in the container via `NODE_EXTRA_CA_CERTS`** (the only lever the generic-oidc relying party exposes; no `ca:` option is plumbed).

## 4. Architecture (files)

- **`admin/control-plane/idp-container-env.ts`** (new): `IdpContainerEnv` — `Up`/`Down`/`WaitHealthy`/`RemoveVolume` for a per-tenant IdP container (reuses the server image + idp entrypoint; mounts the IdP data dir incl. `secrets/<ref>` + `tls/`; publishes the IdP port; env: `PRAGMATIC_IDP_*`). Health = probe the IdP's TLS discovery for a known realm (or a minimal `/healthz` added to `IdpHost`).
- **`admin/control-plane/idp-record.ts`** + **`idp-registry.ts`** (new): `IdpRecord { tenantId, port, baseUrl, containerName, volumeName, caPath, adminTokenRef, createdAt, status }`; a `JsonRecordStore` (`idps.json`).
- **`admin/control-plane/idp-service.ts`** (new): `IdpService` — `EnsureForTenant(tenantId, displayName): Promise<IdpConnection>` (idempotent per tenant; returns `{ baseUrl, ca, adminToken }`), `Teardown(tenantId)`. Allocates the port, mints DevCa (host = `host.docker.internal`), writes master.key seed + the admin-token file, launches via `IdpContainerEnv`, waits healthy, persists `IdpRecord`, rollback on failure.
- **`admin/control-plane/tenant-provisioning-service.ts`** (new): `TenantProvisioningService.Provision(input): Promise<{ record, ownerPassword }>` — `IdpService.EnsureForTenant` → build an `IdpAdminClient({ baseUrl, ca, adminToken })` → `EnsureRealm(tenantId)` → generate owner password → `SeedAccount(tenantId, { email, principalId, displayName, password })` → persist `TenantRecord` (+owner/idp metadata) → return the one-time password. Never logs the password/secret/token.
- **`admin/control-plane/platform-records.ts`** (modify): `TenantRecord` += `ownerEmail`, `ownerPrincipalId`, `idpBaseUrl`, `idpCaRef`, `idpAdminTokenRef`.
- **`admin/control-plane/platform-directory.ts`** (modify): keep `CreateTenant` side-effect-free for the record write; the host calls `TenantProvisioningService` around it (like `CreateHive`).
- **`admin/control-plane/control-plane-host.ts`** (modify): `POST /api/tenants` calls `TenantProvisioningService`, returns the one-time owner password (`Cache-Control: no-store`); `_`-reserved realm id rejected (400).
- **`admin/control-plane/environment-service.ts`** (modify): the §2D client registration + an `IdpConnection` source (via `IdpService.EnsureForTenant(platformTenantId)` for the env's tenant); pass OIDC data to the bundle.
- **`environments/seed/bundle.ts`** (modify): `WriteTenantConfig` emits `generic-oidc` providerSettings when OIDC data is supplied (else `local`); `WriteSecrets` adds the client secret by ref.
- **`environments/seed/docker.ts`** (modify): `RunArgs` mounts the tenant IdP CA + sets `NODE_EXTRA_CA_CERTS`; ensures the env container can resolve `host.docker.internal` (Docker Desktop provides it; on Linux add `--add-host host.docker.internal:host-gateway`).
- **`src/idp/idp-host.ts`** (modify, minimal): add a `GET /healthz` (unauthenticated, no realm) for the container healthcheck.
- **`admin/control-plane/server.ts`** (modify): compose `IdpService`/`TenantProvisioningService`; inject into the host + `EnvironmentService`.
- **`admin/control-plane/idp-federation-smoke.ts`** (new, gated): §2F.

## 5. The federation wiring (the key risk — pinned)

Three parties must agree on the IdP URL: the **browser** (on the host) redirects to the IdP `/authorize`; the **env container's relying party** fetches discovery/token from the IdP; the **`iss` claim** is fixed to the IdP's `PRAGMATIC_IDP_BASE_URL`. On **Docker Desktop**, `host.docker.internal` resolves to the host from *both* a container and the host itself, so a single issuer `https://host.docker.internal:<idpPort>/<tenantId>` satisfies all three:
- IdP launched with `PRAGMATIC_IDP_BASE_URL=https://host.docker.internal:<idpPort>`, published to the host at `<idpPort>`; DevCa SAN = `host.docker.internal` (+127.0.0.1+localhost).
- Bundle injects `issuer`/`discoveryUrl` = `https://host.docker.internal:<idpPort>/<tenantId>`; env container gets `NODE_EXTRA_CA_CERTS` = the mounted `ca.crt`.
- `redirectUri` = `http://localhost:<envHostPort>/auth/oidc/callback` (browser → env; the env is published on the host at `<envHostPort>`).
- Browser flow: env (localhost:envPort) → 302 to IdP authorize (host.docker.internal:idpPort, resolves on host) → login → 302 back to localhost:envPort/callback → env RP exchanges the code at host.docker.internal:idpPort/token (container → host) → `iss` matches.

**Deferred:** non-Docker-Desktop hosts (plain Linux CI, real DNS/certs in prod) need a different issuer-host + trust strategy; §8 files it. Linux Docker gets `--add-host host.docker.internal:host-gateway` as a best-effort.

## 6. Security

- Admin token, Owner password, client secret: generated, used in-memory, written only where required (admin-token file pre-launch; raw client secret into the bundle secret store by ref; Owner password revealed once). **Never logged, never in an error, never in a persisted record** (only hashes/refs persist; `TenantRecord` holds owner email/principalId + IdP refs, no secrets).
- The one-time Owner-password reveal uses `Cache-Control: no-store`.
- Per-tenant admin tokens and realms isolate tenants; the IdP's `_`-reserved namespace + fail-closed admin loader (6b) are unchanged.
- DevCa is dev-only; production TLS deferred.

## 7. Proof

- **Unit tests (fakes, no Docker):** `IdpService.EnsureForTenant` (idempotent; rollback on launch failure; returns `{baseUrl,ca,adminToken}`) over a fake `IdpContainerEnv` + fake `PortAllocator`; admin-token generation + file write (no plaintext in logs); `TenantProvisioningService.Provision` against an **in-process `IdpHost`+`IdpAdminEndpoint`** (realm ensured, Owner seeded + authenticates, one-time password returned, nothing secret persisted/logged); `EnvironmentService.Create` bound path registers a client + the bundle carries `generic-oidc` providerSettings + the secret by ref (against an in-process IdP); unbound path still `local`; `bundle.ts`/`docker.ts` RunArgs include the CA mount + `NODE_EXTRA_CA_CERTS` + `host.docker.internal` resolution; `TenantRecord` owner/IdP metadata; `IdpHost /healthz`.
- **Gated e2e smoke (`idp-federation-smoke.ts`, real Docker):** provision a tenant (capture the one-time Owner password), create a hive + a bound environment, perform a real OIDC login (via the relying-party machinery / a scripted browser-like flow) against the tenant realm, assert a session carrying `email`/`name`; a second bound environment rides SSO. Run via `npx tsx admin/control-plane/idp-federation-smoke.ts` on Docker Desktop. (If Docker is unavailable in the build environment, the smoke is written + type-checked but run by the user.)

## 8. Deferred (file as Features)

- Non-Docker-Desktop issuer-host + real-cert trust (prod federation).
- IdP HA / persistent (non-file) stores / graceful shutdown (6a deferrals).
- Upstream Entra/Google federation (the tenant IdP federating UP).
- The `/auth` session response-key `tenant`→`environment` rename (carried from 6c-rename, to do with the SP-HIVE-7 client).
- IdP container image slimming (a dedicated minimal IdP image vs reusing the server image).

## 9. Sequencing

6c-proper completes the identity line. After it, **SP-HIVE-7** (tenant-admin app) can log in against a real, reachable tenant realm. The gated smoke is the headline proof, runnable on Docker Desktop.

---

## BUILDER-CHECK RESOLUTIONS (2026-10-23) — pins for the plan

1. **IdP data-dir writable by uid 10001.** The runtime image runs USER 10001 and the IdP writes master.key/signing/realms/tls at startup. Use the env flow's pattern: a named volume seeded + `chmod -R a+rwX` by a throwaway root container (mirror `docker.ts SeedVolume`), OR a host bind-mount pre-chowned to 10001. Plan: named volume + a root seed step that also drops in the pre-minted `tls/` + `secrets/<ref>`.
2. **No openssl in node:22-slim ⇒ the control-plane PRE-MINTS the full DevCa (all 4 files: ca.key, ca.crt, server.key, server.crt) on the host** (the control-plane host has openssl, as the existing idp-sso-smoke proves) and mounts/seeds `tls/` into the IdP container. `DevCa.EnsureAt`'s idempotency guard then skips minting inside the container. The IdP never mints its own CA.
3. **Bundle providerSettings shape:** `providerSettings` is `Array<[string,string]>` (entry tuples), deserialized via `new Map(...)` by `FileTenantConfigStore`. For OIDC emit tuples keyed by `OidcSettingKeys` (`issuer`,`discoveryUrl`,`clientId`,`redirectUri`,`secretRef`) and set `delegationDepth` to the `DelegationDepth.AuthnDirectory` ordinal (NOT the literal 2). Verify the enum ordinal in todl-identity-cloud.
4. **Entrypoint override:** `docker run --entrypoint node <image> dist/bin/pragmatic-idpd.js` (the baked ENTRYPOINT is exec-form serverd; trailing args would append). Mirror docker.ts's `--entrypoint sh` usage.
5. **Baked HEALTHCHECK is wrong for the IdP (plain-HTTP :8080):** run the IdP container with `--no-healthcheck`; rely solely on `IdpContainerEnv.WaitHealthy`.
6. **Add `GET /healthz` to `IdpHost`** (unauthenticated, no-realm, before the `segments>=2`/realm guard; 200 OK). `IdpContainerEnv.WaitHealthy` probes it over **HTTPS with the control-plane's minted CA** via `https.get({ ca })` against `127.0.0.1:<idpPort>` (the cert's IP:127.0.0.1 SAN) — it canNOT reuse `DockerEnv.Probe` (plain http).
7. **IdP port: published host==container** (so `host.docker.internal:<idpPort>` is identical from host and container; the IdP's `PRAGMATIC_IDP_PORT` = the published port, unlike env's fixed internal 8080). **Second `PortAllocator` floor = 12100** (env allocator spans [8100,12099]); its own `taken` set from `IdpRecord` ports.
8. **Owner identity input (ruling):** add `ownerEmail` to the `POST /api/tenants` body and to `TenantProvisioningService.Provision`. `ownerPrincipalId` is generated as the constant `'owner'` (the tenant's single Owner). `displayName` for the account = the tenant displayName or `'Owner'`. `CreateTenant` (directory) keeps its `{id,clientId,displayName}` record-write; the owner fields live on the provisioning path + persisted `TenantRecord`.
9. **`IIdpService` interface (fakeable) — REQUIRED for unit testing.** `interface IIdpService { EnsureForTenant(tenantId, displayName): Promise<IdpConnection>; Teardown?(tenantId) }`, `IdpConnection = { baseUrl: string; ca: string | Buffer; adminToken: string }`. The real `IdpService` launches a container; a fake returns a connection pointing at an **in-process `IdpHost`+`IdpAdminEndpoint`** so `TenantProvisioningService` + `EnvironmentService` client-registration unit-test without Docker (exactly as idp-sso-smoke.ts wires the admin client). Both services depend on `IIdpService`, not the concrete class.
10. **Teardown + client-deregister (ruling: DEFER, file Features).** 6c-proper builds provision/launch/federate only. `DeleteTenant`→`IdpService.Teardown` (container+volume+port reclaim) and an `IdpAdminClient` deregister-client (env delete) are **deferred** — file two Features. Note the orphan-accumulation caveat in the deferred list.
11. **Composition / idempotent reuse:** build `IdpService` before `EnvironmentService` + `TenantProvisioningService` in `server.ts` (no cycle). `EnsureForTenant` is **idempotent**: if a running `IdpRecord`+container exists for the tenant, reuse it (return its connection) without relaunching. `EnvironmentService.Create` (bound path) calls `EnsureForTenant(platformTenantId)` to get the connection at env-create.
12. **redirectUri split is supported (confirmed):** `OidcResolvedConfig.RedirectUri` is independent of `Issuer`; the RP only `RequireHttps`-checks discovery/token, never the redirect; the IdP accepts any `new URL()`-parseable redirect and exact-`includes`-matches it. Register EXACTLY `http://localhost:<envHostPort>/auth/oidc/callback` (byte-identical to `AuthHttpEndpoint.OidcCallbackPath`).
13. **host.docker.internal on Linux (ruling):** add `--add-host host.docker.internal:host-gateway` UNCONDITIONALLY to env + IdP run args (harmless on Docker Desktop, enables Linux). The browser-redirect to `host.docker.internal` still only resolves on Docker Desktop, so the federated-login smoke is **Docker-Desktop-only** — stated, acceptable (the platform's dev substrate).
14. **Gated smoke flow (scripted, no real browser):** drive the env's `/auth/oidc/begin` → follow the 302 to the IdP (`host.docker.internal`) → POST login → follow the 302 back to `http://localhost:<envPort>/auth/oidc/callback` (the container does the token exchange internally) → GET `/auth/session` and assert `email`/`name`. SSO: the browser-jar carries the IdP's SSO cookie across the two env flows (the cookie is set by the IdP, not the env). The runtime env needs the Owner's app-reader/session grant. A `node:https` client carrying the minted CA (as idp-sso-smoke.ts) does the HTTP.
15. **DevCa SAN = `DNS:<host>` + `IP:127.0.0.1` only (not localhost).** Mint with `host = host.docker.internal`; address the IdP as `host.docker.internal` (browser/container, matches DNS SAN) or `127.0.0.1` (WaitHealthy, matches IP SAN). Never as `localhost` for TLS.

**Added deferrals (file as Features):** IdP `Teardown` on tenant-delete (container/volume/port reclaim); `IdpAdminClient` client-deregister on env-delete (orphan clients); non-Docker-Desktop federation issuer-host strategy.
