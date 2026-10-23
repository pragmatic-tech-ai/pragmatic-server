# SP-HIVE-7a — Tenant Backend (auth plane + façade + streaming) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the control-plane a tenant-facing plane — an OIDC relying-party + tenant session that logs a tenant admin into their own per-tenant IdP, a `/tenant-api/…` façade that only ever exposes the caller's own tenant's hives/environments/versions, and live streaming (tenant-scoped events + log-follow) — so the SP-HIVE-7b mural app can be built on top.

**Architecture:** New modules under `admin/control-plane/tenant-auth/` and `admin/control-plane/tenant-api/`, wired into the existing `ControlPlaneHost`/`server.ts`. The relying-party reuses the server-side OIDC machinery (`IdentityPackResolver`, `GenericOidcPack`, flow-state store) already used by the runtime host, pointed at a tenant's IdP via the existing `IdpService`/`IdpAdminClient`. The tenant session is a new file-backed store with a tenant-prefixed cookie, distinct from the operator `cp_session`. The façade reuses `PlatformDirectory`/`EnvironmentService`/`PlatformDeploymentRegistry` behind a tenant filter derived from the session.

**Tech Stack:** TypeScript (ESM, Node ≥22.5), `node:test` + `tsx`, `ws` WebSocketServer, `node:child_process` spawn for log-follow.

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-7-tenant-admin-app-design.md` (§8 UX, §9 serving/auth topology).

## Global Constraints

- OOP: behavior on classes (methods/statics), no module-level free functions or mutable state; `const`/enum/type declarations at module scope are fine.
- Allman braces (opening brace on its own line) for every block.
- No inline reused/user-facing string literals — hoist to `private static readonly` PascalCase constants; path segments and single-use structural tokens may stay inline.
- PascalCase for interfaces and public methods; private members and serialized JSON data-shape fields keep their wire casing.
- Enums over string-literal unions for fixed value sets.
- **Security-core:** the admin-app OIDC client secret, the tenant session token, and the IdP admin token are held server-side by ref/name and must NEVER appear in logs, DTOs, thrown error messages, or persisted platform records. Scrub every throw/log/serialize path.
- The operator `/api/*` surface, its `cp_session` cookie, and the operator `AllowedHosts`/gate stay behaviorally unchanged.
- Tests live in `admin/control-plane/tests/*.test.ts`; run `npx tsx --test "admin/control-plane/tests/*.test.ts"`, `npm run build`, `npm run typecheck:tools`. Do NOT run `npm install`. Commit after each task. Each task ends GREEN on the full control-plane suite.

## Review Focus

- **Cross-tenant data leak:** a tenant-A session hitting any `/tenant-api/*` route for a hive/environment/manifest owned by tenant B must get 404/empty, never B's data — pinned in Tasks 5, 6, 8.
- **Unauthenticated / wrong-plane access:** a `/tenant-api/*` request with no tenant cookie, or with an operator `cp_session` instead, must be 401 — pinned in Task 4.
- **Secret non-leakage:** a failed login (bad code/state), a failed client registration, and a failed roll must return a generic error with no client secret / session token / admin token in the body or logs — pinned in Tasks 2, 3, 6.
- **IdP-CA trust on fetch:** the relying-party's HTTP client fetching the tenant IdP's discovery/jwks/token endpoints must trust the tenant IdP's CA (`IdpConnection.ca`); without it every login fails — pinned in Task 2.
- **Session expiry / revocation:** an expired or revoked tenant session must be rejected by the gate (not merely absent) — pinned in Tasks 1, 4.

---

### Task 1: Tenant session store + tenant session cookie

**Files:**
- Create: `admin/control-plane/tenant-auth/tenant-session.ts`
- Create: `admin/control-plane/tenant-auth/tenant-session-cookie.ts`
- Test: `admin/control-plane/tests/tenant-session.test.ts`, `admin/control-plane/tests/tenant-session-cookie.test.ts`

**Interfaces:**
- Produces:
  - `export type TenantSession = { id: string; tenantId: string; principalId: string; email?: string; expiresAt: string }` (expiresAt ISO).
  - `export class TenantSessionStore` ctor `(filePath: string, ttlMs: number, now?: () => Date)`; `Issue(tenantId: string, principalId: string, email?: string): Promise<TenantSession>`, `Validate(token: string): Promise<TenantSession | null>`, `Revoke(token: string): Promise<void>`. File-backed JSON keyed by session id, temp-write+rename, ENOENT→empty (mirror `IdpRegistry`/`EnvironmentRegistry` persistence). Token id = `randomBytes(32).toString('base64url')`.
  - `export class TenantSessionCookie` — `Name = 'pts_session'`; statics `Build(tenantId: string, token: string, expiresAt: Date, secure: boolean): string`, `BuildClearing(secure: boolean): string`, `Read(cookieHeader: string | undefined): { tenantId: string; token: string } | null`. Cookie value `pts_session=<encodeURIComponent(tenantId)>.<token>`; attributes `HttpOnly; SameSite=Strict; Path=/; Max-Age=<s>[; Secure]`. `Read` splits on the LAST `.`, decodes the tenant, validates token against `/^[A-Za-z0-9_-]+$/`, returns null on a duplicate/garbled cookie. (Model on `src/host/browser-session-auth.ts` + `admin/control-plane/session-cookie.ts`.)

- [ ] **Step 1: Write failing tests.** `tenant-session.test.ts`: Issue then Validate round-trips tenantId/principalId/email; Validate of an unknown token → null; Validate after Revoke → null; a session past `expiresAt` → null (inject `now`); store persists (new `TenantSessionStore` on the same file validates a prior session). `tenant-session-cookie.test.ts`: Build then Read round-trips tenantId (including a tenantId with a `-`) and token; a header with two `pts_session` values → null; a missing cookie → null; `secure=true` appends `; Secure` and `secure=false` omits it; `BuildClearing` sets `Max-Age=0`.
- [ ] **Step 2:** Run both tests — expect FAIL (modules absent).
- [ ] **Step 3:** Implement `TenantSession`/`TenantSessionStore` and `TenantSessionCookie` per the Interfaces block.
- [ ] **Step 4:** Run green: the two tests, `npm run build`, `npm run typecheck:tools`.
- [ ] **Step 5:** Commit `feat(tenant-auth): tenant session store + tenant-prefixed session cookie`.

### Task 2: Tenant OIDC relying-party (SECURITY-CORE — client secret)

**Files:**
- Create: `admin/control-plane/tenant-auth/tenant-oidc-relying-party.ts`
- Test: `admin/control-plane/tests/tenant-oidc-relying-party.test.ts`

**Interfaces:**
- Consumes: `IIdpService.EnsureForTenant(tenantId, displayName): Promise<IdpConnection>` and `IdpConnection { baseUrl; ca: Buffer; adminToken; adminTokenRef; caDir }` (`admin/control-plane/idp-service.ts`); `IdpAdminClient` with `RegisterClient(tenantId, { clientId, redirectUris, secret }): Promise<void>` (`idp-admin-client.ts`); `IdentityPackResolver.Resolve(tenant, config, stores)` → `{ Oidc: OidcIdentityProviderPackBase | undefined }` and `OidcIdentityProviderPackBase.BeginAuthorization(tenant): Promise<{ Url; State }>` + `AuthenticatorFor(AuthMethod.Oidc)` (`src/identity/identity-pack-resolver.ts`, `@pragmatic-tech-ai/todl-identity-cloud`); `OidcSettingKeys`, `IdentityConfig`, `DelegationDepth.AuthnDirectory`, `GenericOidcPackId` (same values Task 8 of SP-HIVE-6c-proper used in `environments/seed/bundle.ts`); `Tenant`/`TenantKind`, `Credential`/`PresentedSecret`/`AuthMethod.Oidc`/`AuthenticatedResult` (`@pragmatic-tech-ai/todl-identity`).
- Produces:
  - `export interface ITenantOidcRelyingParty { Begin(tenantId: string): Promise<{ Url: string; State: string }>; Complete(tenantId: string, code: string, state: string): Promise<{ principalId: string; email?: string }> }`
  - `export class TenantOidcRelyingParty implements ITenantOidcRelyingParty` ctor `(idp: IIdpService, directory: PlatformDirectory, adminClientFactory: (conn: IdpConnection) => IdpAdminClient, callbackUrl: string, resolver?: IdentityPackResolver, flowStates?: IOidcFlowStateStore)`. `callbackUrl` is the absolute tenant-facing callback (e.g. `https://<tenant-origin>/tenant-auth/oidc/callback`), registered as the admin client's one redirect URI.
  - `public static readonly AdminClientId = 'pragmatic-tenant-admin'`.

**Approach notes (decisions the implementer cannot make alone):**
- `Begin`: `EnsureForTenant(tenantId, displayName)` → generate a client secret (`randomBytes(24).toString('base64url')`), `RegisterClient(tenantId, { clientId: AdminClientId, redirectUris: [callbackUrl], secret })` (idempotent — re-registering the same client replaces it; registration per Begin is acceptable for v1), seed the secret into an in-process `Secrets` store under a secretRef, build an `IdentityConfig(GenericOidcPackId, DelegationDepth.AuthnDirectory, providerSettings, …)` with `providerSettings` = Issuer `conn.baseUrl + '/' + encodeURIComponent(tenantId)`, DiscoveryUrl `issuer + '/.well-known/openid-configuration'`, ClientId `AdminClientId`, RedirectUri `callbackUrl`, SecretRef, then `resolver.Resolve(tenant, config, stores).Oidc.BeginAuthorization(tenant)`.
- The resolver's `IdentityPackResolver` must be constructed with an `IHttpClient` that **trusts `conn.ca`** (the IdP DevCa) — otherwise discovery/jwks/token fetches fail. Build it from the tenant's CA per login (the CA is per-tenant). This is the Review-Focus "IdP-CA trust" item.
- `Complete`: rebuild the same pack for the tenant (shared `flowStates` so the `state`/PKCE verifier survives across Begin→Complete), `AuthenticatorFor(AuthMethod.Oidc).Authenticate(new Credential(AuthMethod.Oidc, state), new PresentedSecret(code), tenant)` → on `AuthenticatedResult` return `{ principalId: result.Principal.Id, email: <from result principal/claims if present> }`, else throw a generic `TenantLoginError`. Always `PresentedSecret.Clear()`.
- Secret/token never logged or placed in a thrown message (reuse the redaction discipline from `environment-service.ts`/`idp-service.ts`).

- [ ] **Step 1: Write failing tests** (`tenant-oidc-relying-party.test.ts`) using the in-process IdP fixture pattern from `admin/control-plane/tests/environment-service.test.ts` (`IdpFixture.With(tenantId, …)` — in-process `IdpHost` + `IdpAdminEndpoint` + DevCa, realm pre-created) plus a seeded account: (a) `Begin` returns a `Url` whose origin is the tenant IdP and that carries `response_type=code`, `client_id=pragmatic-tenant-admin`, `redirect_uri=<callbackUrl>`, `state`, `code_challenge`; (b) after driving the IdP authorize+login to obtain a real `code` for that `state`, `Complete(tenantId, code, state)` returns `principalId` equal to the seeded account's subject; (c) `Complete` with a bad `code` throws `TenantLoginError` and the error message contains neither the client secret nor the code.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `TenantOidcRelyingParty` per the Interfaces + Approach notes.
- [ ] **Step 4:** Run green (test, build, typecheck). Full control-plane suite stays green.
- [ ] **Step 5:** Commit `feat(tenant-auth): tenant OIDC relying-party against the per-tenant IdP`.

### Task 3: Tenant auth endpoint (`/tenant-auth/*`)

**Files:**
- Create: `admin/control-plane/tenant-auth/tenant-auth-endpoint.ts`
- Test: `admin/control-plane/tests/tenant-auth-endpoint.test.ts`

**Interfaces:**
- Consumes: `ITenantOidcRelyingParty` (Task 2), `TenantSessionStore` + `TenantSessionCookie` (Task 1).
- Produces: `export class TenantAuthEndpoint` ctor `(rp: ITenantOidcRelyingParty, sessions: TenantSessionStore, secureCookie: boolean)`; `public async Handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>` returning true when it handled the path. Paths + behavior:
  - `GET /tenant-auth/oidc/begin?tenant=<id>` → `rp.Begin(tenantId)` → `302` `Location: Url` (400 if `tenant` missing).
  - `GET /tenant-auth/oidc/callback?tenant=<id>&code=&state=` → `rp.Complete(...)` → `sessions.Issue(...)` → `Set-Cookie: TenantSessionCookie.Build(tenantId, session.id, expiresAt, secureCookie)` + `302` to the app root `/` (400 on missing params, 401 on `TenantLoginError`). The admin client's `redirect_uri` carries `?tenant=<id>` so the callback knows its tenant (same hint pattern as SP-HIVE-6c-proper's env redirect_uri).
  - `GET /tenant-auth/session` → `{ tenantId, principalId, email? }` from the cookie's validated session, else 401.
  - `POST /tenant-auth/logout` → `sessions.Revoke(token)` + `Set-Cookie: TenantSessionCookie.BuildClearing(secure)` → 204.
  - `Cache-Control: no-store` on begin/callback/session responses.

- [ ] **Step 1: Write failing tests** with a fake `ITenantOidcRelyingParty` (Begin returns a canned Url+State; Complete returns a canned principal, or throws `TenantLoginError`) and a real `TenantSessionStore` (tmp file): begin → 302 to the canned Url (and 400 without `tenant`); callback → 302 to `/` with a `pts_session` Set-Cookie whose session validates to the principal; callback with a throwing Complete → 401 and no Set-Cookie and no secret in body; `GET /tenant-auth/session` with that cookie → the principal, without it → 401; logout → 204, clears the cookie, and the session no longer validates.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `TenantAuthEndpoint`.
- [ ] **Step 4:** Run green (test, build, typecheck).
- [ ] **Step 5:** Commit `feat(tenant-auth): /tenant-auth OIDC begin/callback/session/logout endpoint`.

### Task 4: Tenant auth gate + host/server wiring for the tenant plane

**Files:**
- Create: `admin/control-plane/tenant-auth/tenant-auth-gate.ts`
- Modify: `admin/control-plane/control-plane-host.ts` (register `/tenant-auth/*` as public, mount the gate for `/tenant-api/*`, widen host acceptance for configured tenant hosts, Origin + secure-cookie handling for the tenant plane; operator surface unchanged), `admin/control-plane/server.ts` (compose the tenant plane), `admin/control-plane/control-plane-config.ts` or the `ReadOperatorOptions` area (read `PRAGMATIC_TENANT_ADMIN_HOSTS`, `PRAGMATIC_TENANT_ADMIN_CALLBACK_URL`).
- Test: `admin/control-plane/tests/tenant-auth-gate.test.ts`, and additions to `admin/control-plane/tests/control-plane-host-tenant.test.ts` (new file).

**Interfaces:**
- Produces:
  - `export class TenantAuthGate` ctor `(sessions: TenantSessionStore)`; `public async Principal(req: IncomingMessage): Promise<TenantSession | null>` (reads `TenantSessionCookie`, validates; null if absent/expired/revoked).
  - `ControlPlaneHost` gains a trailing constructor param `tenantAuth?: TenantPlane` where `export type TenantPlane = { endpoint: TenantAuthEndpoint; gate: TenantAuthGate; api: TenantApiEndpoint; allowedHosts: ReadonlySet<string> }` (Tasks 3/5/8 fill `api`; wire what exists, extend as later tasks land). The operator path is untouched when `tenantAuth` is undefined.
  - Routing: in `Handle`, `/tenant-auth/*` is public (no operator gate, no tenant gate); `/tenant-api/*` requires `await gate.Principal(req) !== null` else 401 `{error:'Authentication required'}`; both skip the operator `Authenticated` gate. Host check: accept a request whose host is in the operator `AllowedHosts` OR in `tenantAuth.allowedHosts`; operator `/api/*` additionally requires the host be in the operator set (so the tenant origin cannot reach operator routes). Origin check for mutating `/tenant-*` requests mirrors the operator one but against the tenant allowed origins. Tenant cookies use `secureCookie`.

- [ ] **Step 1: Write failing tests.** `tenant-auth-gate.test.ts`: Principal returns the session for a valid `pts_session`, null for none, null for an expired/revoked one. `control-plane-host-tenant.test.ts` (harness like `control-plane-host.test.ts`, sending a `pts_session` cookie): a `/tenant-api/hives` request with no tenant cookie → 401; with an operator `cp_session` but no tenant cookie → 401; a `/tenant-auth/session` request is reachable without any gate; a request to an operator route `/api/hives` from a configured tenant host → still requires the operator cookie (401 without it); a `/tenant-api/*` request on a configured tenant host with a valid tenant cookie passes the host+gate checks (stub the api endpoint to 200).
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement the gate, the host routing/host/origin changes, the config reads, and `server.ts` composition (construct `TenantSessionStore`(data file + ttl), `TenantOidcRelyingParty`(idpService, directory, `conn => new IdpAdminClient(conn)`, callbackUrl), `TenantAuthEndpoint`, `TenantAuthGate`, pass as `TenantPlane`). Keep operator behavior identical when the tenant plane is configured off.
- [ ] **Step 4:** Run green (new tests, the existing `control-plane-host*.test.ts` suite unchanged-green, build, typecheck).
- [ ] **Step 5:** Commit `feat(tenant-auth): mount the tenant plane (gate, host/origin, server wiring)`.

### Task 5: Tenant façade read routes (`/tenant-api` hives/environments/manifests/rollout/health)

**Files:**
- Create: `admin/control-plane/tenant-api/tenant-api-endpoint.ts`
- Modify: `admin/control-plane/control-plane-host.ts` (dispatch `/tenant-api/*` to the endpoint with the gate's `TenantSession`).
- Test: `admin/control-plane/tests/tenant-api-read.test.ts`

**Interfaces:**
- Consumes: `PlatformDirectory.ListHives(tenantId)`, `GetHive(id)`, `GetTenant(id)` (`platform-directory.ts`); `IEnvironmentService.ListReconciled()`/`List()` (filter by `EnvironmentRecord.tenantId`); `PlatformDeploymentRegistry.ManifestsFor(tenantId)` + the rollout/health producers behind the existing `GET /api/hives/:id/rollout` and `GET /api/hives/:id/health` handlers (reuse their logic); `HiveRecord`, `EnvironmentDto`, `ManifestDto`, `HiveRolloutDto`, `HiveHealthDto` shapes (recon §5/§2).
- Produces: `export class TenantApiEndpoint` ctor `(service: IEnvironmentService, directory: PlatformDirectory, deployments: PlatformDeploymentRegistry, orchestrators: HiveOrchestratorFactory, placement: EnvironmentPlacement)`; `public async Handle(req, res, path: string, session: TenantSession): Promise<boolean>`. Every route scopes to `session.tenantId`:
  - `GET /tenant-api/hives` → the tenant's `HiveRecord[]` (via `ListHives(session.tenantId)`).
  - `GET /tenant-api/environments` → environments whose `tenantId === session.tenantId`.
  - `GET /tenant-api/manifests` → `ManifestsFor(session.tenantId)`.
  - `GET /tenant-api/hives/:id/rollout` and `/health` → 404 unless `GetHive(id)?.tenantId === session.tenantId`, else the same DTO the operator route returns.

- [ ] **Step 1: Write failing tests** (harness + a directory seeded with two tenants' hives/environments/manifests, built like `rollout-fixture.ts`): a tenant-A session lists only A's hives/environments/manifests; `GET /tenant-api/hives/<B-hive>/rollout` under an A session → 404; `GET /tenant-api/hives/<A-hive>/rollout` → the rollout DTO; same for `/health`; environments list excludes B's and any unbound (`tenantId` unset) env.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `TenantApiEndpoint` read routes and dispatch them from `ControlPlaneHost` with the gate session; set `api` on the `TenantPlane`.
- [ ] **Step 4:** Run green (test, build, typecheck; existing suites green).
- [ ] **Step 5:** Commit `feat(tenant-api): tenant-scoped read routes (hives, environments, manifests, rollout, health)`.

### Task 6: Tenant façade mutation routes (version target, env start/stop/restart)

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (add mutations), `admin/control-plane/environment-service.ts` (+`Restart`), `admin/control-plane/control-plane-host.ts` (`IEnvironmentService` gains `Restart`).
- Test: additions to `admin/control-plane/tests/tenant-api-read.test.ts` or a new `tenant-api-mutate.test.ts`; `environment-service.test.ts` for `Restart`.

**Interfaces:**
- Consumes: `PlatformDeploymentRegistry.SelectTarget(hiveId, version)` (throws `UnknownHiveError`/`UnknownManifestError`/`ManifestNotGatedError`); `EnvironmentService.Start`/`Stop`.
- Produces:
  - `EnvironmentService.Restart(name: string): Promise<EnvironmentRecord>` = `Stop` then `Start` (sequential; reuse existing methods). Add to `IEnvironmentService`.
  - `TenantApiEndpoint` mutations, all gated to `session.tenantId`:
    - `POST /tenant-api/hives/:id/target` `{version}` → 404 unless the hive is the tenant's, else `SelectTarget` → 204; a `ManifestNotGatedError`/`UnknownManifestError` → 409/404 with a generic message (no internals).
    - `POST /tenant-api/environments/:name/start|stop|restart` → 404 unless the env's `tenantId === session.tenantId`, else `service.Start|Stop|Restart(name)` → `EnvironmentDto`.

- [ ] **Step 1: Write failing tests:** `environment-service.test.ts` — `Restart` calls Stop then Start and returns a running record (assert ordering via the `FakeDocker` call log). `tenant-api` — an A session rolling an A hive → 204 and `SelectTarget` called; an A session rolling a B hive → 404 and `SelectTarget` NOT called; an A session `start`/`stop`/`restart` on a B env → 404 (service not called); on an A env → the DTO; a target with an un-gated version → 409 with a generic body.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `Restart` and the mutation routes with the cross-tenant guards and generic error mapping.
- [ ] **Step 4:** Run green (tests, build, typecheck; existing suites green).
- [ ] **Step 5:** Commit `feat(tenant-api): tenant-scoped version target + environment start/stop/restart`.

### Task 7: Log-follow streaming seam

**Files:**
- Modify: `environments/seed/docker.ts` (add a spawn seam + `LogStream`), `admin/control-plane/docker-env-port.ts` (`IDockerEnv` + `DockerEnvAdapter` gain `LogStream`), `admin/control-plane/environment-service.ts` (`EnvironmentService.LogStream`, `IEnvironmentService.LogStream`).
- Test: `admin/control-plane/tests/environment-service.test.ts` (fake spawn seam), `environments/seed/tests/docker.test.ts` (argv assertion).

**Interfaces:**
- Produces:
  - A spawn seam on `DockerEnv`: `export interface IProcessSpawn { Spawn(command: string, args: string[]): ILogProcess }` and `export interface ILogProcess { OnData(cb: (chunk: string) => void): void; OnClose(cb: () => void): void; Kill(): void }`; `DockerEnv` ctor gains an optional `IProcessSpawn` (default wraps `child_process.spawn`). `DockerEnv.LogStream(def: EnvDefinition, onData: (chunk: string) => void): ILogProcess` spawns `docker logs -f --tail <N> <container>` (N a named constant) and pipes stdout+stderr to `onData`.
  - `IDockerEnv.LogStream(def, onData): ILogProcess` + `DockerEnvAdapter.LogStream` delegating.
  - `EnvironmentService.LogStream(name: string, onData: (chunk: string) => void): ILogProcess` (`Require(name)` then `docker.LogStream(DefOf(rec), onData)`); add to `IEnvironmentService`.

- [ ] **Step 1: Write failing tests:** `docker.test.ts` — `LogStream` asks the spawn seam for `['logs','-f','--tail',<N>,'pragmatic-env-<name>']` and forwards chunks to `onData`, and `Kill()` kills the process (assert via a fake `IProcessSpawn`/`ILogProcess`). `environment-service.test.ts` — `LogStream` resolves the def and delegates to `docker.LogStream`, forwarding chunks (fake docker).
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement the spawn seam and `LogStream` across the three layers. The default `IProcessSpawn` wraps `spawn('docker', args)` and decodes stdout/stderr to utf8 strings.
- [ ] **Step 4:** Run green (`docker.test.ts`, `environment-service.test.ts`, build, typecheck).
- [ ] **Step 5:** Commit `feat(env): docker log-follow streaming seam (LogStream)`.

### Task 8: Tenant-scoped streaming transport (events ws + log stream ws)

**Files:**
- Create: `admin/control-plane/tenant-api/tenant-events.ts` (per-tenant event fan-out), `admin/control-plane/tenant-api/tenant-log-socket.ts` (log-stream ws handler).
- Modify: `admin/control-plane/control-plane-host.ts` (ws `upgrade` for `/tenant-api/events` and `/tenant-api/environments/:name/logs/stream`, tenant-gated), `admin/control-plane/environment-service.ts` or the service's change signal so health/lifecycle changes carry the env (so events can be tenant-filtered).
- Test: `admin/control-plane/tests/tenant-streaming.test.ts`

**Interfaces:**
- Consumes: `TenantAuthGate.Principal` (ws cookie), `EnvironmentService.LogStream` (Task 7), the existing environment-change broadcast (recon §2 — today `{type:'environments-changed'}` to all operators).
- Produces:
  - `export class TenantEventBus` — subscribe `On(tenantId: string, cb: (event: TenantEvent) => void): () => void` and `Emit(tenantId: string, event: TenantEvent)`; `TenantEvent = { type: 'environment-changed' | 'health-changed'; environmentName: string; … }`. The host emits to it (scoped by the env's `tenantId`) wherever it currently calls the operator `Broadcast`.
  - ws `GET /tenant-api/events` (upgrade): gate the cookie → subscribe to `TenantEventBus.On(session.tenantId, …)` → forward events as JSON; unsubscribe on close. Reject (destroy socket) when the cookie is absent/invalid or the host/origin disallowed.
  - ws `GET /tenant-api/environments/:name/logs/stream` (upgrade): gate the cookie → 404-equivalent (close) unless the env's `tenantId === session.tenantId` → `service.LogStream(name, chunk => ws.send(chunk))`; `Kill()` the process on socket close.

- [ ] **Step 1: Write failing tests** (ws client against `host.Listen(0,...)`, like the `/api/events` tests): a `/tenant-api/events` socket opened with tenant-A's `pts_session` receives an event emitted for tenant A and does NOT receive one emitted for tenant B; a socket with no `pts_session` is rejected (closed). A `/tenant-api/environments/<A-env>/logs/stream` socket under an A session receives forwarded log chunks (fake `LogStream`) and kills the process on close; the same for a B env under an A session is rejected.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `TenantEventBus`, the two ws upgrade handlers (tenant-gated), and route environment change/health emissions through the bus scoped by env `tenantId`. The operator `/api/events` broadcast stays as-is.
- [ ] **Step 4:** Run green (test, build, typecheck; existing suites green).
- [ ] **Step 5:** Commit `feat(tenant-api): tenant-scoped events + log-stream websockets`.

---

## Final verification (before whole-branch review)
- `npx tsx --test "admin/control-plane/tests/*.test.ts"`, `npx tsx --test "environments/seed/tests/*.test.ts"`, `npm run build`, `npm run typecheck:tools` all green; the existing operator `control-plane-host*` tests unchanged-green (operator plane untouched).
- Whole-branch review on the most capable model, Review-Focus re-checked: cross-tenant leak (Tasks 5/6/8), wrong-plane/unauth (Task 4), secret non-leakage (Tasks 2/3/6), IdP-CA trust (Task 2), session expiry/revocation (Tasks 1/4). Task 2 (client secret) gets adversarial review.
- A gated e2e proving a real tenant login + scoped data + a real roll is deferred to SP-HIVE-7b (it needs the app and a browser); 7a ships the backend proven by the harness + ws tests.

## Out of scope (file as Features on completion)
- The mural tenant-admin app (SP-HIVE-7b — planned next, consumes this backend).
- Per-plane listener isolation (v1 shares one listener; the tenant/operator boundary is the cookie + per-route host check). A dedicated tenant listener/port is a hardening Feature.
- Reusing/rotating the admin-app OIDC client registration (v1 re-registers on Begin); a durable per-tenant admin-client record + secret rotation is a Feature.
