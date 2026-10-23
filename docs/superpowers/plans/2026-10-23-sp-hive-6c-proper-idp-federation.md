# SP-HIVE-6c-proper — Per-Tenant IdP Launch + Provisioning + Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The control-plane launches one `pragmatic-idp` container per tenant, seeds its Owner at tenant-create (one-time password), registers each environment as an OIDC client at environment-create, and federates the served app to the tenant realm so a browser login works.

**Architecture:** An `IIdpService` (fakeable) whose real impl launches a per-tenant IdP container (reusing the server image, IdP entrypoint) and returns `{baseUrl, ca, adminToken}`; a `TenantProvisioningService` and `EnvironmentService` drive `IdpAdminClient` against it; the bundle + docker run-args federate the served app over `host.docker.internal` with `NODE_EXTRA_CA_CERTS`.

**Tech Stack:** TypeScript (ESM), `node:test`+`tsx`, Docker CLI via `execFile`, `node:https`+`node:crypto`, the existing IdP + `IdpAdminClient`.

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-6c-proper-idp-federation-spec.md` (read it incl. the BUILDER-CHECK RESOLUTIONS 1–15 — they pin the exact mechanisms).

## Global Constraints

- OOP, Allman braces, PascalCase, no inline reused literals.
- **Secrets discipline:** the admin token, Owner password, and client secret are generated, used in memory, and written ONLY where required (admin-token file pre-launch; raw client secret into the bundle by ref; Owner password returned once). NEVER logged, in an error, or in a persisted record. One-time Owner reveal carries `Cache-Control: no-store`.
- **Fakeability:** `TenantProvisioningService` and `EnvironmentService` depend on `IIdpService` (resolution 9), so their tests run `IdpAdminClient` against an in-process `IdpHost`+`IdpAdminEndpoint` (as `idp-sso-smoke.ts` does) — NO Docker in unit tests.
- Docker specifics per resolutions: `--entrypoint node` (4), `--no-healthcheck` (5), IdP port published host==container (7), CA pre-minted on host + mounted (2), data-dir seeded writable for uid 10001 (1), `--add-host host.docker.internal:host-gateway` (13).
- Tests: `npx tsx --test "admin/control-plane/tests/*.test.ts"`, `npx tsx --test "src/idp/tests/*.test.ts"`, `npx tsx --test "environments/seed/tests/*.test.ts"`; `npm run build`; `npm run typecheck:tools`. The federation smoke is gated (Docker Desktop), NOT in any glob — written + type-checked, run by the user. Do NOT `npm install`.
- Commit after each task; each task green on its own suites.

## Review Focus

- **Secret leakage:** no admin token / Owner password / client secret in any log, error, or persisted record across `IdpService`, `TenantProvisioningService`, `EnvironmentService`, `IdpContainerEnv`. Tasks 5/6/10 assert absence.
- **CA pre-minted, not container-minted:** the IdP container never runs openssl; the control-plane mints all 4 DevCa files and seeds `tls/`. Task 5 tests the pre-mint + seed.
- **Issuer URL consistency:** issuer/discovery = `https://host.docker.internal:<idpPort>/<tenantId>` (host==container port); redirectUri = `http://localhost:<envHostPort>/auth/oidc/callback` exact. Tasks 8/10 assert the injected values.
- **Idempotent EnsureForTenant:** a second call for a tenant with a running IdP reuses it (no relaunch). Task 5 tests it.
- **Unbound env unchanged:** an environment with no hive/tenant still gets the `local` pack (no OIDC). Task 10 tests it.

---

### Task 1: IdpHost `GET /healthz`
**Files:** `src/idp/idp-host.ts`; test `src/idp/tests/idp-host-health.test.ts` (new).
- [ ] Add an unauthenticated, no-realm `GET /healthz` → 200 (small JSON `{status:'ok'}`), matched BEFORE the `segments>=2`/realm guard in `RouteApi`. Hoist the path + body.
- [ ] Test (HTTPS fixture from idp-host-discovery): `/healthz` → 200 without a realm; a bogus path still 404.
- [ ] Run `npx tsx --test "src/idp/tests/idp-host-health.test.ts"` + the idp suite; commit `feat(idp): unauthenticated /healthz`.

### Task 2: TenantRecord owner + IdP metadata
**Files:** `admin/control-plane/platform-records.ts`; its test.
- [ ] `TenantRecord` += optional `ownerEmail?`, `ownerPrincipalId?`, `idpBaseUrl?`, `idpCaRef?`, `idpAdminTokenRef?` (all optional — pre-6c tenants lack them). Document each.
- [ ] Test the record shape round-trips. Commit `feat(platform): TenantRecord owner + idp metadata fields`.

### Task 3: IdpContainerEnv (docker wrapper for a per-tenant IdP)
**Files:** `admin/control-plane/idp-container-env.ts` (new) + test.
**Interfaces:** `class IdpContainerEnv` with `Up(spec)`, `Down(name)`, `RemoveVolume(name)`, `WaitHealthy(port, ca): Promise<void>`, and a static `RunArgs(spec)` returning the argv. `spec = { tenantId, port, baseUrl, dataVolume, caHostDir, image }`.
- [ ] RunArgs: `run -d --rm=false --name <n> --entrypoint node -p <port>:<port> --no-healthcheck --add-host host.docker.internal:host-gateway -v <vol>:/idp-data -e PRAGMATIC_IDP_PORT=<port> -e PRAGMATIC_IDP_BASE_URL=https://host.docker.internal:<port> -e PRAGMATIC_IDP_HOST=0.0.0.0 -e PRAGMATIC_IDP_DATA=/idp-data -e PRAGMATIC_IDP_ADMIN_TOKEN_REF=<ref> <image> dist/bin/pragmatic-idpd.js` (hoist every flag). `WaitHealthy` polls `https.get({ host:'127.0.0.1', port, path:'/healthz', ca })` for 200 (reuses the CA; 127.0.0.1 matches the IP SAN).
- [ ] Tests with a fake `IExecFile`: assert the exact RunArgs; `WaitHealthy` against an in-process https server (dev CA) resolves on 200, rejects on timeout. Commit `feat(control-plane): IdpContainerEnv (per-tenant IdP container over the server image)`.

### Task 4: IdpRecord + IdpRegistry
**Files:** `admin/control-plane/idp-record.ts`, `idp-registry.ts` (new) + test.
- [ ] `IdpRecord { tenantId, port, baseUrl, containerName, volumeName, caDir, adminTokenRef, createdAt, status }`; `IdpRegistry` = a `JsonRecordStore`-style store at `idps.json` keyed by tenantId (`Get/Put/List/Delete`, atomic, ENOENT→empty).
- [ ] Test put/get/list/idempotent-load. Commit `feat(control-plane): IdpRecord + IdpRegistry`.

### Task 5: IIdpService + IdpService (launch, pre-mint CA, admin token, idempotent)
**Files:** `admin/control-plane/idp-service.ts` (new) + test. **Security-sensitive (admin token).**
**Interfaces:** `interface IIdpService { EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection> }`; `type IdpConnection = { baseUrl: string; ca: string | Buffer; adminToken: string }`; `class IdpService implements IIdpService` ctor `(allocator: PortAllocator, containers: IdpContainerEnv, registry: IdpRegistry, dataRoot: string, image: string, openssl?)`.
- [ ] `EnsureForTenant`: if `registry.Get(tenantId)` exists and its container is running → return its connection (idempotent reuse, no relaunch). Else: allocate a port (floor 12100, own taken-set from registry ports); prepare `<dataRoot>/idp/<tenantId>/`; `DevCa.EnsureAt(tls/, 'host.docker.internal', openssl)` (pre-mint all 4 on the host); generate `adminToken = randomBytes(32).base64url` and write `secrets/<ref>` (0600); seed a writable named volume from the data dir (root throwaway container `chmod -R a+rwX`, mirror docker.ts SeedVolume); `containers.Up` + `WaitHealthy(port, caBuf)`; `registry.Put(IdpRecord)`; return `{ baseUrl:'https://host.docker.internal:<port>', ca: caBuf, adminToken }`. Rollback (Down+RemoveVolume) on failure. NEVER log the token.
- [ ] Tests with a fake `IdpContainerEnv` (records Up/WaitHealthy/Down) + fake `PortAllocator` + real `DevCa` (temp dir; openssl present): EnsureForTenant mints the CA + writes the admin-token file (assert file exists, mode, and that no log/returned error contains the token value); idempotent second call reuses (no second Up); rollback on a WaitHealthy failure (Down called, no record). Commit `feat(control-plane): IdpService launches a per-tenant IdP, pre-mints CA, provisions admin token`.

### Task 6: TenantProvisioningService (realm + Owner seed + one-time password)
**Files:** `admin/control-plane/tenant-provisioning-service.ts` (new) + test. **Security-sensitive (Owner password).**
**Interfaces:** `class TenantProvisioningService` ctor `(idp: IIdpService, directory: PlatformDirectory, adminClientFactory: (c: IdpConnection) => IdpAdminClient)`; `Provision(input: { id, clientId, displayName, ownerEmail }): Promise<{ record: TenantRecord; ownerPassword: string }>`.
- [ ] `Provision`: `conn = idp.EnsureForTenant(id, displayName)`; `client = adminClientFactory(conn)`; `client.EnsureRealm(id, displayName)`; `ownerPassword = randomBytes(...).base64url`; `client.SeedAccount(id, { email: ownerEmail, principalId: 'owner', displayName, password: ownerPassword })`; `directory.CreateTenant({id,clientId,displayName})` then persist the owner/idp metadata onto the record (via a directory setter or a record update); return `{record, ownerPassword}`. Never log the password.
- [ ] Tests against an **in-process `IdpHost`+`IdpAdminEndpoint`** (fake `IIdpService` returns a connection to it, real `IdpAdminClient`): Provision ensures the realm + seeds the Owner (the realm then authenticates `ownerEmail`/`ownerPassword`), returns the one-time password, persists owner metadata but NO secret; a re-provision is idempotent on the realm/account. Assert no log/error contains the password. Commit `feat(control-plane): TenantProvisioningService seeds the realm Owner with a one-time password`.

### Task 7: Wire tenant-create (host + body + one-time reveal + reserved id)
**Files:** `admin/control-plane/control-plane-host.ts`, `server.ts`; tests.
- [ ] `POST /api/tenants` body gains required `ownerEmail`; `HandleCreatePlatform` tenant branch calls `TenantProvisioningService.Provision` and returns `{ ...record, owner: { email, principalId, password } }` with `Cache-Control: no-store`; reject an `id` starting with `_` (400). Compose `TenantProvisioningService` in `server.ts`.
- [ ] Tests (host test with a fake/in-process IdP wiring): create returns the one-time password + no-store; `_x` id → 400; missing ownerEmail → 400. Commit `feat(control-plane): tenant-create provisions the IdP + reveals the one-time Owner password`.

### Task 8: Bundle generic-oidc injection
**Files:** `environments/seed/bundle.ts`; tests.
**Interfaces:** `BundleBuilder.Generate`/`WriteTenantConfig` accept optional OIDC data `{ issuer, discoveryUrl, clientId, redirectUri, secretRef, secret }`.
- [ ] When OIDC data is supplied: `WriteTenantConfig` emits `packId:'generic-oidc'`, `delegationDepth: <DelegationDepth.AuthnDirectory ordinal>`, and `providerSettings` as the entry-tuple array keyed by `OidcSettingKeys` (issuer/discoveryUrl/clientId/redirectUri/secretRef); `WriteSecrets` adds the raw `secret` under `secretRef`. When absent: today's `local` pack unchanged.
- [ ] Tests: OIDC path yields the exact tuples + depth + secret-by-ref; local path unchanged. Verify the shape matches `FileTenantConfigStore` (`Array<[string,string]>`). Commit `feat(seed): bundle emits generic-oidc providerSettings + client secret when federated`.

### Task 9: docker.ts RunArgs federation (CA + NODE_EXTRA_CA_CERTS + add-host)
**Files:** `environments/seed/docker.ts`; tests.
- [ ] `RunArgs` gains (when a tenant CA is provided): a read-only mount of the tenant IdP `ca.crt` → a container path + `-e NODE_EXTRA_CA_CERTS=<that path>`; and `--add-host host.docker.internal:host-gateway` unconditionally. Thread the CA path through `Up`/`Generate` inputs.
- [ ] Tests assert the mount + env + add-host appear when a CA is supplied and are absent otherwise. Commit `feat(seed): env container trusts the tenant IdP CA via NODE_EXTRA_CA_CERTS`.

### Task 10: EnvironmentService env-create federation
**Files:** `admin/control-plane/environment-service.ts`, `server.ts`; tests. **Security-sensitive (client secret).**
**Interfaces:** `EnvironmentService` ctor gains `idp: IIdpService` + `adminClientFactory`. 
- [ ] Bound path (hive→platform tenant resolved): `conn = idp.EnsureForTenant(platformTenantId, …)`; generate client secret; `adminClientFactory(conn).RegisterClient(platformTenantId, { clientId: <env-derived>, redirectUris: ['http://localhost:<hostPort>/auth/oidc/callback'], secret })`; pass OIDC data (issuer/discoveryUrl = `conn.baseUrl + '/' + platformTenantId` + `/.well-known/openid-configuration`; clientId; redirectUri; a secretRef; the raw secret; `conn.ca` path) into `bundle.Generate` + the docker CA mount. Unbound path: unchanged (`local`). Never log the secret.
- [ ] Tests (fake `IIdpService` → in-process IdP, real `IdpAdminClient`): bound Create registers a client (the IdP then verifies the secret) and the bundle carries the generic-oidc config + secret by ref + the CA mount in run-args; unbound Create stays `local` with no OIDC; the secret never appears in a log/error. Commit `feat(control-plane): environment-create registers an OIDC client and federates the served app`.

### Task 11: Gated end-to-end federation smoke (written, Docker-Desktop-only)
**Files:** `admin/control-plane/idp-federation-smoke.ts` (new).
- [ ] Write the smoke per spec §7/resolution 14 (PASS/FAIL gates, exit code): provision a tenant (capture the one-time Owner password), create a hive + a bound environment, drive the env `/auth/oidc/begin`→IdP login→callback→`/auth/session` asserting `email`/`name`, a second bound env rides SSO via the shared IdP cookie jar; a `finally` tears down. Header: needs Docker Desktop + the `pragmatic-server:dev` image; NOT in `npm test`.
- [ ] Do NOT run it (Docker Desktop required). Verify `npm run typecheck:tools` + `npm run build` include it and are clean. Commit `test(control-plane): gated end-to-end per-tenant IdP federation smoke (Docker Desktop)`.

---

## Final verification (before whole-branch review)
- `npx tsx --test "admin/control-plane/tests/*.test.ts"`, `"src/idp/tests/*.test.ts"`, `"environments/seed/tests/*.test.ts"` green; `npm run build` + `npm run typecheck:tools` clean; the federation smoke type-checks (not run).
- Whole-branch review on the most capable model; secret-leakage + the federation-URL model + idempotent reuse re-checked. Tasks 5/6/10 flagged security-sensitive.
