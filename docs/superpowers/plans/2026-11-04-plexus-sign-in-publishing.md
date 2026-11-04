# Plexus Sign-in and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plexus signs in by email, learns the user's tenant and environments from the signed-in profile, and contributes/publishes to Docker and cluster environments through a tenant-plane relay that keeps every environment credential server-side.

**Architecture:** The control plane answers "which tenant is this email" from a platform-kept account index. The tenant plane hosted by the control plane gains a Host-independent `/desktop/*` surface: it brokers the browser sign-in (system browser, loopback redirect, a desktop-only IdP client), issues a sliding desktop session in the existing session store, lists targets, and relays JSON-RPC to environment servers with credentials it mints (maker for contribute, a new scope-limited deployer for publish). Cluster environments are reached through a kubectl port-forward pool. Plexus replaces its URL/token dialogs with an account area and environment pickers.

**Tech Stack:** TypeScript, Node `node:test` via `tsx --test` (pragmatic-server), Electron + vitest + Mural `.mu` (Plexus), `ws`, kubectl.

**Spec:** `docs/superpowers/specs/2026-11-04-plexus-sign-in-publishing-design.md` (approved 2026-11-04).

**Repos and branches:** pragmatic-server branch `feat/plexus-sign-in` (Tasks 1-9); Plexus branch `feat/plexus-sign-in` off `main` (Tasks 10-14). pragmatic-protocol is NOT changed (the relay is protocol-transparent; `PragmaticClient.ConnectAsync(url, { bearerToken })` already sends `Authorization: Bearer`).

## Global Constraints

- OOP only: no module-level functions or mutable variables; every function is a method (static where pure).
- Allman braces everywhere (object literals, arrow bodies and one-line blocks excepted).
- PascalCase for public methods and interfaces; private members and serialized JSON fields keep camelCase.
- No inline string literals in TS: hoist to `private static readonly` PascalCase constants (`.mu` labels stay inline). Enums over sets of strings.
- View models extend `Observable`, never `MuralBase`. No explicit Width/Height in `.mu`.
- Tests live in `tests/` folders beside the code.
- New files ASCII + LF. Files that are CRLF stay CRLF (check with `file` before editing; never `sed -i` repo files).
- Secrets (session tokens, env credentials, admin passwords, client secrets, PKCE/binding verifiers) never appear in logs, error messages, DTOs to the renderer, or IPC to the renderer.
- Plexus dials only `localhost` / `127.0.0.1` locally (Node cannot resolve `*.localhost` on Windows).
- Stage files by explicit path, never `git add -A`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Merge locally; never push.
- Server gates: `npx tsx --test admin/control-plane/tests/*.test.ts`, `npx tsx --test "src/idp/tests/*.test.ts"`, root `npm test`, `npm run typecheck:tools`. Plexus gates: `npm run build:core`, `npm test`, `npm run typecheck` (from Plexus root).

## Fixed values (used across tasks)

| Name | Value |
|---|---|
| Desktop IdP client id | `pragmatic-desktop` |
| Registered desktop redirect (portless loopback) | `http://127.0.0.1/pragmatic-desktop/callback` |
| Plexus loopback callback path | `/pragmatic-desktop/callback` |
| Desktop session TTL (sliding) | 7 days; renewal persisted at most once per hour; absolute cap 30 days from `issuedAt` |
| Sign-in flow lifetime (state + binding) | 10 minutes |
| Plexus loopback wait | 5 minutes |
| Maker credential | principal `maker`, roles `Maker` + `Viewer`, scope `graph-contribute`, 1 hour |
| Deploy credential | principal `deployer`, role `Admin`, scope `application-deploy`, 15 minutes |
| Tunnel idle close | 5 minutes |
| Discovery throttle | 10 requests per minute per client address |
| Platform address default | `http://localhost:7000` |
| Desktop tenant-plane URL default | `http://127.0.0.1:<PRAGMATIC_TENANT_ADMIN_PORT>`, override `PRAGMATIC_DESKTOP_TENANT_PLANE_URL` |

## Review Focus

1. The user closes the browser tab without finishing sign-in: Plexus gives up after 5 minutes with a plain sentence and the loopback port is closed (Task 10).
2. The desktop session is revoked server-side while Plexus runs (password changed in the console): the next targets or relay call gets 401 and Plexus flips to signed out and deletes its stored session (Tasks 4, 10, 11).
3. A request for a method outside the action's allowlist is sent through the relay (e.g. `graph/delete`): it is answered with a JSON-RPC error and never reaches the environment (Task 8).
4. Two relays to the same cluster environment share one tunnel; the port-forward process dies: the next acquire opens a fresh one (Task 7).
5. The email is typed with different case or surrounding spaces: discovery still finds the tenant (Task 3).

---

## Part A: pragmatic-server (branch `feat/plexus-sign-in`)

### Task 1: IdP loopback redirect matching

**Files:**
- Modify: `src/idp/idp-client-store.ts` (`RedirectAllowed`, ~line 85)
- Test: `src/idp/tests/idp-client-store.test.ts`

**Interfaces:**
- Produces: `IdpClientStore.RedirectAllowed(tenantId, clientId, redirectUri): boolean` now also accepts RFC 8252 section 7.3 loopback matches.

Rule: a registered URI whose scheme is `http`, host is exactly `127.0.0.1` and has NO port matches a presented URI with scheme `http`, host `127.0.0.1`, any port 1-65535, the identical path, and no query or fragment. Everything else stays exact string equality. `localhost` and `[::1]` are not loopback-matched (RFC 8252 8.3).

- [ ] **Step 1: Write the failing tests** (`describe('loopback redirect')`):
  - `it('matches any port on a registered portless 127.0.0.1 redirect')`: register `['http://127.0.0.1/pragmatic-desktop/callback']`; `RedirectAllowed(t, c, 'http://127.0.0.1:51234/pragmatic-desktop/callback') === true`, and `:1` and `:65535` are true too.
  - `it('refuses a different path, a query, a fragment, https, localhost or a port-ful registration mismatch')`: each of `http://127.0.0.1:5/other`, `http://127.0.0.1:5/pragmatic-desktop/callback?x=1`, `...callback#f`, `https://127.0.0.1:5/pragmatic-desktop/callback`, `http://localhost:5/pragmatic-desktop/callback`, `http://127.0.0.1.evil.test:5/pragmatic-desktop/callback` returns `false`; a client registered with `http://127.0.0.1:7000/cb` still accepts only exactly that URI.
- [ ] **Step 2: Run** `npx tsx --test "src/idp/tests/idp-client-store.test.ts"`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** a private static `IsLoopbackMatch(registered: string, presented: string): boolean` using `new URL` (catch parse errors as false); `RedirectAllowed` returns exact-includes OR any registered URI loopback-matches. Update the doc comment.
- [ ] **Step 4: Run** the IdP suite `npx tsx --test "src/idp/tests/*.test.ts"`. Expected: PASS (authorize and token endpoint tests unchanged; the token endpoint already compares against the code's bound redirect).
- [ ] **Step 5: Commit** `feat(idp): accept RFC 8252 loopback redirects on any port`.

### Task 2: Desktop sessions in the tenant session store

**Files:**
- Modify: `admin/control-plane/tenant-auth/tenant-session.ts`
- Modify: `admin/control-plane/tenant-auth/tenant-auth-gate.ts`
- Create: `admin/control-plane/tenant-auth/desktop-auth-gate.ts`
- Test: `admin/control-plane/tests/tenant-session.test.ts` (extend), `admin/control-plane/tests/desktop-auth-gate.test.ts` (new), `admin/control-plane/tests/tenant-auth-gate.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export enum TenantSessionKind { Console = 'console', Desktop = 'desktop' }`; `TenantSession` gains `kind?: TenantSessionKind` (absent reads as Console, so existing files load).
  - `TenantSessionStore` constructor gains a trailing optional `desktopTtlMs: number = TenantSessionStore.DesktopTtlMs` (7 days) and statics `DesktopTtlMs`, `DesktopRenewalIntervalMs` (1 h), `DesktopMaxLifetimeMs` (30 days).
  - `Issue(tenantId, principalId, email?, kind: TenantSessionKind = TenantSessionKind.Console): Promise<TenantSession>`.
  - `Validate(token)`: for a Desktop session, when `now - (keptAt ?? issuedAt) >= DesktopRenewalIntervalMs`, sets `expiresAt = min(now + desktopTtlMs, issuedAt + DesktopMaxLifetimeMs)` and `keptAt = now`, persisted with the store's existing copy-persist-swap. Console sessions are unchanged.
  - `RevokeAllFor` / `RotateFor` / principal resets apply to both kinds (they already iterate all sessions; add a test proving it). `RotateFor` mints a Console session.
  - `TenantAuthGate.Principal(req)` returns null for a Desktop-kind session (a desktop bearer is never a cookie).
  - `class DesktopAuthGate { constructor(sessions: TenantSessionStore); Principal(req: IncomingMessage): Promise<TenantSession | null> }`: reads only `Authorization: Bearer <token>`; returns the session only when `kind === Desktop`; ignores cookies.

- [ ] **Step 1: Write the failing tests:**
  - `it('issues a desktop session that lives 7 days')`: `Issue(t, p, e, TenantSessionKind.Desktop)`; `expiresAt - issuedAt === 7 days`; `kind === 'desktop'`.
  - `it('slides a desktop session on use, at most once per hour, never past 30 days')`: clock +2h → `Validate` moves `expiresAt` to now+7d and the file on disk shows it; clock +10min more → no write (file mtime/`keptAt` unchanged); clock at issuedAt+29.9d with repeated use → `expiresAt <= issuedAt + 30d`; at issuedAt+30d+1ms → `Validate` returns null.
  - `it('does not slide a console session')`.
  - `it('ends desktop sessions with RevokeAllFor and RotateFor')`: a Desktop session for the principal is invalid after each.
  - `it('loads a file written before session kinds existed as console sessions')`.
  - Gate tests: console cookie carrying a desktop token → `TenantAuthGate.Principal` null; `DesktopAuthGate` with a console token as bearer → null; with a desktop token → the session; missing/`Basic` header → null.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/tenant-session.test.ts admin/control-plane/tests/tenant-auth-gate.test.ts admin/control-plane/tests/desktop-auth-gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** the whole control-plane suite and `npm run typecheck:tools`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-auth): sliding desktop sessions kept apart from console cookies`.

### Task 3: Account index and email discovery

**Files:**
- Create: `admin/control-plane/tenant-account-index.ts`
- Create: `admin/control-plane/desktop-discovery-endpoint.ts`
- Modify: `admin/control-plane/tenant-provisioning-service.ts` (record the owner account after `SeedAccount`, ~line 150; update it wherever the owner email/principal changes, ~line 198; forget on tenant delete)
- Modify: `admin/control-plane/control-plane-host.ts` (public route), `admin/control-plane/server.ts` (compose, back-fill, tenant-plane URL)
- Test: `admin/control-plane/tests/tenant-account-index.test.ts`, `admin/control-plane/tests/desktop-discovery-endpoint.test.ts`, extend the provisioning test

**Interfaces:**
- Produces:
  - `type TenantAccountRecord = { id: string; email: string; tenantId: string; principalId: string }` (`email` stored trimmed + lowercased; `id = tenantId + '/' + principalId`).
  - `class TenantAccountIndex extends JsonRecordStore<TenantAccountRecord>`, file `data/tenant-accounts.json`: `Record(tenantId, principalId, email): Promise<void>` (replaces that principal's entry), `ForgetTenant(tenantId): Promise<void>`, `TenantsFor(email): readonly string[]` (normalises the query the same way; distinct tenant ids), `static Normalise(email: string): string`.
  - `TenantAccountIndex.BackfillFrom(directory: PlatformDirectory): Promise<number>`: records every tenant's `ownerEmail`/`ownerPrincipalId` not yet indexed; called at startup from `server.ts`.
  - `class DesktopDiscoveryEndpoint { constructor(index: TenantAccountIndex, directory: ITenantDirectory, tenantPlaneUrl: string | undefined, throttle: AuditThrottle); Handle(req, res): Promise<void> }` serving `POST /api/desktop/discover` with body `{ email }`:
    - 200 `{ tenants: [{ id, displayName }], tenantPlaneUrl }` (tenants sorted by displayName; unknown tenant ids skipped).
    - 404 `{ error: 'no-account' }` when none; 400 `{ error: 'invalid-email' }` for a missing/oversized (>254) email; 429 with `Retry-After` when throttled (every request counts); 503 `{ error: 'unavailable' }` when `tenantPlaneUrl` is undefined; 403 when an `Origin` header is present (desktop clients only; blocks browser-page probing).
  - `ControlPlaneServer.DesktopTenantPlaneUrlOf(env): string | undefined`: `PRAGMATIC_DESKTOP_TENANT_PLANE_URL` if set, else `http://127.0.0.1:<PRAGMATIC_TENANT_ADMIN_PORT>` when the tenant plane is enabled, else undefined.
- Rule (from the spec): the index covers every account that can sign in to the tenant console. Today the platform's only account-creating path is `TenantProvisioningService` (owner seeding); any future account-creation path must call `Record`. Write that rule in the class doc comment.

- [ ] **Step 1: Write the failing tests:**
  - `it('finds the tenant whatever the case or surrounding spaces')`: `Record('acme','p1','Ann@Acme.test')`; `TenantsFor('  ann@ACME.test ')` → `['acme']`.
  - `it('returns every tenant an email belongs to')`, `it('replaces a principal's old email')`, `it('forgets a deleted tenant')`, `it('back-fills owners already in the directory, once')`.
  - Endpoint: 200 body shape exactly `{ tenants: [{ id: 'acme', displayName: 'Acme' }], tenantPlaneUrl: 'http://127.0.0.1:7002' }`; 404 `no-account`; 400; 503; 403 with Origin; the 11th request in a minute from one address → 429.
  - Provisioning: provisioning a tenant records its owner in the index.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Mount the route in `ControlPlaneHost` ahead of operator-session checks (it is the only unauthenticated POST besides login; keep it out of the operator CSRF path but keep the Origin rejection). Reuse `AuditThrottle` with a 10/min window (add constructor options if it lacks them).
- [ ] **Step 4: Run** the control-plane suite + typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): email discovery for desktop sign-in`.

### Task 4: Desktop sign-in and profile API on the tenant plane

**Files:**
- Modify: `admin/control-plane/tenant-auth/tenant-oidc-relying-party.ts` (client kind)
- Create: `admin/control-plane/tenant-auth/desktop-sign-in-flows.ts`
- Create: `admin/control-plane/tenant-auth/desktop-endpoint.ts`
- Create: `admin/control-plane/tenant-auth/desktop-targets.ts`
- Modify: `admin/control-plane/tenant-auth/tenant-plane.ts` (add `desktop?: DesktopEndpoint`), `admin/control-plane/tenant-plane-host.ts` (route `/desktop/*` before Host resolution), `admin/control-plane/server.ts` (`BuildTenantPlane`)
- Test: `admin/control-plane/tests/desktop-sign-in-flows.test.ts`, `admin/control-plane/tests/desktop-endpoint.test.ts`, `admin/control-plane/tests/desktop-targets.test.ts`, extend `tenant-oidc-relying-party.test.ts` and `tenant-plane-host` tests

**Interfaces:**
- Consumes: Task 1 loopback matching; Task 2 `TenantSessionKind`, `DesktopAuthGate`.
- Produces:
  - `export enum TenantOidcClientKind { Console = 'console', Desktop = 'desktop' }`. `ITenantOidcRelyingParty.Begin(tenantId, callbackUrl, kind = Console)` and `Complete(tenantId, code, state, callbackUrl, kind = Console)`. Desktop uses client id `pragmatic-desktop`, its own secret ref `tenant-desktop-oidc/<tenantId>` (and registry entry when durable), and registers redirect `http://127.0.0.1/pragmatic-desktop/callback` (portless) while the authorize request and code exchange carry the port-ful `callbackUrl`. Console behaviour is unchanged and the two clients never overwrite each other's registration.
  - `class DesktopSignInFlows { constructor(now?: () => Date); Start(tenantId, redirectUri, bindingChallenge, state): void; Take(state): { tenantId, redirectUri, bindingChallenge } | undefined }`: in memory, 10-minute life, single use, bounded (evict oldest beyond 1000).
  - `class DesktopTargets { constructor(service: IEnvironmentService, directory: ITenantDirectory); For(session: TenantSession): Promise<DesktopTargetsDto>; Allows(session, envName: string, action: DesktopAction): Promise<EnvironmentRecord | undefined> }` with `export enum DesktopAction { Contribute = 'contribute', Publish = 'publish' }` and `type DesktopTargetsDto = { contribute: DesktopTargetDto[]; publish: DesktopTargetDto[] }`, `type DesktopTargetDto = { name: string; status: EnvStatus }`. Contribute lists the tenant's `Development` envs, Publish its `Runtime` envs, both only when `TenantAdminCapabilities.For(session, tenant).capabilities.envs`. `Allows` applies the same check plus `status === Running`; Task 8 uses it, so the list and the action share one rule.
  - `class DesktopEndpoint { constructor(rp: ITenantOidcRelyingParty, sessions: TenantSessionStore, gate: DesktopAuthGate, flows: DesktopSignInFlows, targets: DesktopTargets, directory: ITenantDirectory, profile: (session) => TenantProfileDto, throttle: LoginThrottle); Handle(req, res, path): Promise<boolean> }`. Routes (JSON in/out, every request with an `Origin` header → 403):
    - `POST /desktop/sign-in/begin` `{ tenantId, redirectUri, bindingChallenge }` → 200 `{ authorizeUrl }`. `redirectUri` must match `^http://127\.0\.0\.1:(\d{1,5})/pragmatic-desktop/callback$` with port 1-65535; `bindingChallenge` 43 base64url chars; unknown tenant → 404 `{ error: 'unknown-tenant' }`. The flow is stored under the RP's `State`.
    - `POST /desktop/sign-in/complete` `{ state, code, bindingVerifier }` → 200 `{ token, expiresAt, tenantId, tenantName, email }`. Takes the flow (single use), requires `base64url(sha256(bindingVerifier)) === bindingChallenge` (timing-safe), then `rp.Complete(..., Desktop)` and `sessions.Issue(..., TenantSessionKind.Desktop)`. Any failure → 401 `{ error: 'sign-in-failed' }` and a `LoginThrottle` failure keyed `(tenantId or '', ip)`; throttled → 429.
    - `POST /desktop/sign-out` (bearer) → 204, revokes that session only.
    - `GET /desktop/profile` (bearer) → 200 `TenantProfileDto` (same mapper as `/tenant-api/profile`).
    - `GET /desktop/targets` (bearer) → 200 `DesktopTargetsDto`.
    - Missing/invalid/console bearer on bearer routes → 401 `{ error: 'signed-out' }`.
  - `TenantPlaneHost.Handle`: paths beginning `/desktop/` go to `plane.desktop` regardless of Host (the tenant always comes from the flow or the bearer, never the Host or body); 404 when `desktop` is absent.

- [ ] **Step 1: Write the failing tests:**
  - RP: `it('registers the desktop client with the portless loopback redirect and leaves the console client alone')` using `RegistrationRecordingAdminClient`; and an `IdpFixture` round trip: Begin(Desktop) with `http://127.0.0.1:53111/pragmatic-desktop/callback`, browser signs in, Complete(Desktop) returns the principal.
  - Flows: `it('a flow is single use and expires after 10 minutes')`.
  - Endpoint (with `FakeRelyingParty`): begin rejects `http://localhost:5/...`, `http://127.0.0.1:0/...`, `http://127.0.0.1:5/other`, and a request with `Origin`; complete with a wrong verifier → 401 and the same state cannot be retried with the right one; complete success → a Desktop session that `DesktopAuthGate` accepts and `TenantAuthGate` rejects; response body never contains the binding verifier or the RP state; sign-out revokes only that session; `/desktop/targets` with a console token → 401 `signed-out`.
  - Targets: Development env appears under `contribute` only, Runtime under `publish` only, another tenant's env never; `Allows` refuses a stopped env, a wrong-type env and a foreign env.
  - Host: `GET /desktop/targets` with `Host: 127.0.0.1:7002` reaches the desktop endpoint.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the control-plane suite + typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-plane): desktop sign-in, profile and targets`.

### Task 5: Token scopes enforced by the environment server

**Files:**
- Create: `src/host/token-scope.ts`
- Modify: `src/host/connection-authenticator.ts` (carry the service token's scopes explicitly), `src/host/server-connection-handler.ts` (`authorize`, ~line 299)
- Test: `src/host/tests/token-scope.test.ts` and an extension of the connection-handler tests (find the existing file that covers `authorize`/`PolicyGate` denial)

**Interfaces:**
- Produces:
  - `export enum TokenScope { GraphContribute = 'graph-contribute', ApplicationDeploy = 'application-deploy' }`.
  - `class TokenScopeGate { static For(scopes: readonly string[]): TokenScopeGate; Allows(method: string): boolean }`. Known scopes map to methods: `GraphContribute` → `graph/contribute`, `graph/list`; `ApplicationDeploy` → `application/deploy`. When `scopes` holds at least one known scope, only the union of their methods is allowed; with no known scope the gate allows everything (existing tokens keep working).
  - Scopes come only from a service-token authentication, never from a session principal's groups. The handler checks the scope gate before the `PolicyGate`; a refusal throws `ResponseError(ErrorCodes.InvalidRequest, 'method is outside this credential's scope')`.

- [ ] **Step 1: Write the failing tests:** `For(['application-deploy']).Allows('application/deploy') === true` and `Allows('graph/create') === false`; `For(['graph-contribute'])` allows `graph/contribute`, `graph/list`, refuses `application/deploy`; `For([])` and `For(['custom'])` allow `graph/create`; a connection authenticated with a `graph-contribute` service token is refused `graph/delete` even when its role would allow it; a session-authenticated connection whose groups happen to include `application-deploy` is unaffected.
- [ ] **Step 2: Run** `npm test` (root). Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** root `npm test` and `npm run typecheck:tools`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): enforce credential scopes per method`.

### Task 6: Deploy credential and listable maker credential

**Files:**
- Modify: `admin/control-plane/environment-service.ts` (`AdminIssueMakerToken` ~line 577; new `AdminIssueDeployToken`), `admin/control-plane/control-plane-host.ts` (`IEnvironmentService`), test fakes implementing `IEnvironmentService`
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (`RouteEnvCredential` ~line 760: require the `envs` capability, closing the recon gap)
- Test: `admin/control-plane/tests/environment-service.test.ts` (CRLF file: edit via a Python script preserving CRLF), tenant-api maker-token test

**Interfaces:**
- Produces:
  - `AdminIssueMakerToken(name)` additionally grants `Viewer` to `maker` (so `graph/list` passes the role check; the scope still limits it to contribute + list).
  - `AdminIssueDeployToken(name: string): Promise<TokenIssuedDto>`: requires `rec.type === EnvType.Runtime` else `EnvironmentNotRuntimeError` (new, mirrors `EnvironmentNotDevelopmentError`); grants `Admin` to `deployer` on Tenant; issues `{ principalId: 'deployer', scopes: ['application-deploy'], expiresInSeconds: 900 }`. Constants hoisted (`DeployerPrincipal`, `DeployScope`, `DeployTtlSeconds`).
- [ ] **Step 1: Write the failing tests:** deploy token on a Runtime env → proxy saw `GrantRole(deployer, Admin, Tenant)` then `IssueToken(deployer, ['application-deploy'], 900)`; on a Development env → `EnvironmentNotRuntimeError`; maker token now grants `Maker` and `Viewer`; tenant-api maker-token route returns 403 for a session without `envs` (fake capabilities).
- [ ] **Step 2: Run** the affected tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** control-plane suite + typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environments): deploy-only credential for runtime environments`.

### Task 7: Reaching cluster environments (tunnel pool + admin secret)

**Files:**
- Create: `admin/control-plane/cluster-tunnel-pool.ts`
- Create: `admin/control-plane/environment-endpoints.ts`
- Modify: `admin/control-plane/kubectl.ts` (add a spawner seam for long-lived processes), `admin/control-plane/environment-service.ts` (`AdminInfoFor` ~line 632 via `EnvironmentEndpoints`), `admin/control-plane/server.ts` (compose; close the pool on shutdown)
- Test: `admin/control-plane/tests/cluster-tunnel-pool.test.ts`, `admin/control-plane/tests/environment-endpoints.test.ts`, extend `environment-service.test.ts`

**Interfaces:**
- Produces:
  - `interface ISpawnedProcess { readonly Stdout: NodeJS.ReadableStream; Kill(): void; OnExit(cb: () => void): void }`, `interface IProcessSpawner { Spawn(file: string, args: readonly string[]): ISpawnedProcess }`, `class NodeProcessSpawner implements IProcessSpawner` (in `kubectl.ts`). `KubectlCli` gains `PortForward(namespace: string, target: string, remotePort: number, spawner: IProcessSpawner): Promise<{ LocalPort: number; Process: ISpawnedProcess }>` running `kubectl --context <ctx> -n <ns> port-forward <target> 0:<remotePort> --address 127.0.0.1` and resolving on the stdout line `Forwarding from 127.0.0.1:<port> -> <remotePort>`; rejects after 15 s or on early exit (stderr never surfaced verbatim).
  - `class ClusterTunnelPool { constructor(spawner: IProcessSpawner, idleMs = 300_000, now?); Acquire(key: string, open: () => Promise<{ LocalPort, Process }>): Promise<number>; CloseAll(): void }`: one tunnel per key, concurrent acquires share one open, each acquire resets the idle timer, an exited process is dropped so the next acquire reopens.
  - `type EnvironmentUrls = { httpUrl: string; wsUrl: string }`. `class EnvironmentEndpoints { constructor(orchestrators: HiveOrchestratorFactory, directory: ITenantDirectory, tunnels: ClusterTunnelPool); UrlsFor(rec: EnvironmentRecord): Promise<EnvironmentUrls>; AdminPasswordFor(rec: EnvironmentRecord, dataRoot: string): Promise<string> }`. Docker records (`hostPort` set) keep `http://localhost:<hostPort>` / `ws://localhost:<hostPort>`. In-cluster records tunnel to `svc/<K8sManifestBuilder.ServerDeploymentOf(name)>` in `K8sManifestBuilder.NamespaceOf(name)` on the workload server port, giving `http://127.0.0.1:<local>` / `ws://127.0.0.1:<local>`. In-cluster admin password is read from the cluster Secret `EnvServerSeedSource.SecretNameOf(name)` (`kubectl Get`, base64-decode the provisioned-secrets entry) instead of a local bundle. A hive whose orchestrator has no kubectl context → `EnvironmentUnreachableError` ("The environment's hive is not reachable from the platform.").
  - `AdminInfoFor(name)` builds `AdminConnectInfo` from `EnvironmentEndpoints`, so `AdminIssueMakerToken`/`AdminIssueDeployToken` work for in-cluster envs.
- [ ] **Step 1: Write the failing tests** with a fake spawner emitting the forwarding line: port parsed; two concurrent `Acquire` calls spawn once; idle 5 min with no acquire → process killed; process exit → next acquire spawns again; a stdout that never prints the line → rejects within the timeout (fake clock); in-cluster `UrlsFor` returns `127.0.0.1:<local>`; Docker `UrlsFor` unchanged; `AdminPasswordFor` decodes the Secret via `FakeKubectl`; `AdminInfoFor` on an in-cluster record no longer throws.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** control-plane suite + typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environments): reach cluster environments through a kubectl tunnel`.

### Task 8: Relay with method allowlist and audit

**Files:**
- Create: `admin/control-plane/tenant-auth/desktop-relay.ts`
- Modify: `admin/control-plane/tenant-plane-host.ts` (WS upgrade for `/desktop/relay`), `admin/control-plane/tenant-auth/tenant-plane.ts`, `admin/control-plane/server.ts` (compose with an `AuditRegistry` on `data/tenant-desktop-audit.json`)
- Modify: `admin/README.md` (desktop sign-in, discovery, relay, new env var, audit file)
- Test: `admin/control-plane/tests/desktop-relay.test.ts`

**Interfaces:**
- Consumes: `DesktopAuthGate` (Task 2), `DesktopTargets.Allows` / `DesktopAction` (Task 4), `AdminIssueMakerToken` / `AdminIssueDeployToken` (Task 6), `EnvironmentEndpoints.UrlsFor` (Task 7).
- Produces:
  - `class DesktopRelay { constructor(gate: DesktopAuthGate, targets: DesktopTargets, service: IEnvironmentService, endpoints: EnvironmentEndpoints, audit: AuditRegistry, dialer: IUpstreamDialer); Upgrade(req, socket, head): Promise<void> }` for `GET /desktop/relay?environment=<name>&action=<contribute|publish>`.
  - Refusals are HTTP responses written before the upgrade: 401 (no/invalid desktop bearer), 403 (not allowed: capability, wrong type or foreign env), 409 (env not running), 400 (bad action), 502 (upstream unreachable or credential minting failed). Plexus maps these to sentences (Task 11).
  - On success: mints the credential for the action, dials `<wsUrl>/?environment=<environmentId>` with `Authorization: Bearer <credential>`, then pipes text frames both ways. Client-to-upstream frames are parsed as JSON-RPC; a request whose method is not in the action's allowlist gets a JSON-RPC error `{ code: -32601, message: 'This method is not available through the desktop relay.' }` written back and is never forwarded. Allowlists: Contribute = `graph/list`, `graph/contribute`; Publish = `application/deploy`; plus whatever methods `PragmaticClient` sends on connect (the implementer reads `pragmatic-protocol/src/client/pragmatic-client.ts` and lists them by constant). Non-JSON or batch frames close the relay with code 1008.
  - Each forwarded `graph/contribute` or `application/deploy` writes one audit record when its response returns: `actor = <tenantId>/<email or principalId>`, `method = action`, `path = env name`, `status = 200 | 500` (JSON-RPC error), `note` = graph or app name. Relay refusals write a record with the HTTP status.
  - Closing either side closes the other; the credential is never logged or echoed.
- [ ] **Step 1: Write the failing tests** with a fake upstream WS server and fake service: refusals 401/403/409/400/502 with no upstream dial; success forwards `graph/list` and `graph/contribute` and records one audit entry naming the user and graph; `graph/delete` gets -32601 and the fake upstream never receives it; publish relay forwards `application/deploy` with the deploy credential and refuses `graph/contribute`; upstream close closes the client; the bearer seen by upstream is the minted credential, never the desktop token.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (`ws` `WebSocketServer({ noServer: true })` as the existing tenant WS paths do).
- [ ] **Step 4: Run** control-plane suite, root `npm test`, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-plane): desktop relay to environments with allowlist and audit`.

### Task 9: Server live smoke

**Files:**
- Create: `admin/control-plane/desktop-sign-in-smoke.ts` (pattern: `idp-sso-smoke.ts`)

- [ ] **Step 1:** Script, run against a live control plane + tenant plane: discover the operator-provisioned tenant's owner email; begin desktop sign-in with a local loopback listener; drive the IdP login page with the owner password read from a file path given as an argument (never printed); complete; `GET /desktop/targets`; open a contribute relay to a running Development env (the in-cluster `training2` when present), call `graph/list`; try `graph/delete` and assert -32601. Prints only statuses and counts.
- [ ] **Step 2: Run** it against the restarted control plane. Expected: every check reports ok.
- [ ] **Step 3: Commit** `test(control-plane): desktop sign-in smoke`.

---

## Part B: Plexus (branch `feat/plexus-sign-in` off `main`)

Paths: `core` = `packages/plexus-core/src`, `app` = `apps/plexus/src`.

### Task 10: Account service in the main process

**Files:**
- Create: `core/shared/account-api.ts`
- Create: `app/main/account/desktop-session-store.ts`, `app/main/account/loopback-redirect-receiver.ts`, `app/main/account/desktop-api-client.ts`, `app/main/account/account-service.ts`, `app/main/account/account-ipc.ts`, `app/main/account/legacy-profile-cleanup.ts`
- Modify: `app/main/index.ts` (compose; delete `graph-profile.bin`/`tenant-profile.bin` once), `app/preload/index.ts` (bridge `account`)
- Test: `app/main/account/tests/*.test.ts`

**Interfaces:**
- Produces (in `core/shared/account-api.ts`):
  - `enum AccountChannel { State = 'account:state', Discover = 'account:discover', SignIn = 'account:sign-in', CancelSignIn = 'account:cancel-sign-in', SignOut = 'account:sign-out', Targets = 'account:targets', LastChoice = 'account:last-choice', RememberChoice = 'account:remember-choice', Changed = 'account:changed' }`.
  - `type AccountState = { SignedIn: boolean; Email?: string; TenantName?: string }` (never a token).
  - `type DiscoveredTenant = { Id: string; DisplayName: string }`; `enum TargetStatus { Running = 'running', Stopped = 'stopped', Failed = 'failed', Unknown = 'unknown' }`; `type EnvironmentTarget = { Name: string; Status: TargetStatus }`; `type AccountTargets = { Contribute: EnvironmentTarget[]; Publish: EnvironmentTarget[] }`; `enum TargetKind { Contribute = 'contribute', Publish = 'publish' }`; `type TargetChoice = { Environment: string; GraphName?: string }`.
  - `class PlatformAddress { static readonly Default = 'http://localhost:7000'; static Validate(url: string): string | undefined }` (error sentence or undefined; https anywhere, http only for `localhost`/`127.0.0.1`/`[::1]`).
  - `class AccountError extends Error` with `enum AccountErrorKind { NoAccount, Unreachable, SignInFailed, TimedOut, Cancelled, SignedOut, Unavailable }` and a fixed plain sentence per kind, e.g. NoAccount: "No account was found for this email.", Unreachable: "The platform could not be reached. Check the Platform address in Settings.", TimedOut: "Sign-in was not finished in the browser. Try again.", SignedOut: "You're signed out. Sign in and try again.".
  - `interface IAccountApi { State(): Promise<AccountState>; Discover(platformUrl: string, email: string): Promise<DiscoveredTenant[]>; SignIn(platformUrl: string, email: string, tenantId: string): Promise<AccountState>; CancelSignIn(): Promise<void>; SignOut(): Promise<AccountState>; Targets(): Promise<AccountTargets>; LastChoice(kind: TargetKind): Promise<TargetChoice | undefined>; RememberChoice(kind: TargetKind, choice: TargetChoice): Promise<void>; OnChanged(cb: (s: AccountState) => void): () => void }`. Errors cross IPC as `{ Kind }` and are rebuilt into `AccountError` in the bridge.
- Produces (main):
  - `DesktopSessionStore(dir, encryptor: ITokenEncryptor)`: `Save(s: DesktopSession)`, `Load(): Promise<DesktopSession | undefined>`, `Clear()`; file `desktop-session.bin` (temp + rename, like `GraphProfileStore`). `type DesktopSession = { TenantPlaneUrl, Token, Email, TenantId, TenantName, ExpiresAt }`.
  - `LoopbackRedirectReceiver`: `Start(): Promise<{ RedirectUri: string }>` listens on `127.0.0.1:0`, path `/pragmatic-desktop/callback`; `WaitForCode(expectedState: string, timeoutMs = 300_000): Promise<string>` resolves the `code` for a matching `state`, answers the browser with a short plain HTML page ("You can close this tab and return to Plexus."), ignores other paths (404) and mismatched state (400), rejects `TimedOut`; `Close()` always runs (finally).
  - `DesktopApiClient(fetch = globalThis.fetch)`: `Discover(platformUrl, email)`, `Begin(tenantPlaneUrl, tenantId, redirectUri, challenge)`, `Complete(tenantPlaneUrl, state, code, verifier)`, `Targets(session)`, `SignOut(session)`; maps 404 no-account → NoAccount, network errors → Unreachable, 401 → SignedOut.
  - `AccountService(store, choices dir, client, receiver factory, openExternal: (url) => Promise<void>)`: `SignIn` generates a 32-byte base64url binding verifier + S256 challenge, starts the receiver, begins, opens the browser, waits, completes, saves the session, emits Changed. The `state` Plexus expects is the one in the returned `authorizeUrl`. Any `SignedOut` from `Targets` or from relay connects (Task 11 calls `AccountService.HandleSignedOut()`) clears the store and emits Changed. Last choices persist per tenant in `publish-choices.json` (plain JSON, no secrets).
  - `AccountIpc.Register(ipc, service, webContentsProvider)`.
- [ ] **Step 1: Write the failing tests** (vitest, fakes for fetch/encryptor/openExternal):
  - receiver: returns the code for the right state; mismatched state → 400 and keeps waiting; `it('gives up after 5 minutes and closes the port')` (fake timers; afterwards a connect to the port is refused).
  - service: happy path saves the session and `State()` has email + tenant name and no token field; the challenge sent equals base64url(sha256(verifier)) and the verifier is sent only to Complete; `Targets()` 401 → `AccountError(SignedOut)`, store cleared, Changed emitted with `SignedIn: false`; `SignOut` calls the server and clears even when the server is unreachable; `RememberChoice`/`LastChoice` round-trip per kind and are keyed by tenant.
  - cleanup: deletes the two legacy `.bin` files when present, no error when absent.
  - `PlatformAddress.Validate`: accepts `http://localhost:7000`, `https://p.example`; refuses `http://p.example`, `ftp://x`.
- [ ] **Step 2: Run** `npm run test -w @pragmatic-tech-ai/plexus` (after `npm run build:core`). Expected: FAIL.
- [ ] **Step 3: Implement.** `openExternal` = Electron `shell.openExternal`.
- [ ] **Step 4: Run** `npm run build:core`, app tests, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): sign in by email through the system browser`.

### Task 11: Contribute and publish through the relay

**Files:**
- Modify: `core/shared/graph-contribute-api.ts`, `core/shared/tenant-publish-api.ts`
- Modify: `app/main/graph-contribute/graph-contribute-service.ts`, `graph-client.ts`, `graph-contribute-ipc.ts`; delete `graph-profile-store.ts`, `graph-profile.ts`
- Modify: `app/main/tenant-publish/tenant-deploy-service.ts`, `tenant-client.ts`, `tenant-publish-ipc.ts`; delete `tenant-profile-store.ts`, `tenant-profile.ts`
- Create: `app/main/account/relay-connector.ts`
- Modify: `app/main/index.ts`, `app/preload/index.ts`
- Test: update `app/main/graph-contribute/tests/*`, `app/main/tenant-publish/tests/*`; new `app/main/account/tests/relay-connector.test.ts`

**Interfaces:**
- Consumes: `AccountService` (Task 10): `Session(): Promise<DesktopSession | undefined>`, `HandleSignedOut(): Promise<void>`.
- Produces:
  - `RelayConnector(account: AccountService, dial: (url, token) => Promise<PragmaticClient>)`: `Connect(environment: string, kind: TargetKind): Promise<PragmaticClient>` dials `ws(s)://<tenant plane host>/desktop/relay?environment=<encoded>&action=<kind>` with the desktop token as bearer. Upgrade failures map to sentences: 401 → SignedOut (and `HandleSignedOut()`), 403 → "Your account can't use this environment.", 409 → "The environment <name> is not running. Start it from the tenant console.", 502/other → "The environment <name> could not be reached."; no session → SignedOut. The message never includes a URL or token.
  - Graph API: `GraphContributeChannel` gains `ListGraphs = 'graph-contribute:list-graphs'`, loses the profile channels. `IGraphContributeApi`: `Contribute(environment, graphName, solutionId, packages): Promise<GraphContributeResult>`, `ListGraphs(environment): Promise<string[]>`. `GraphContributeService(relay)` implements both over `RelayConnector.Connect(env, Contribute)` (always closing the client).
  - Publish API: `ITenantPublishApi.Deploy(environment: string, outputDir: string): Promise<TenantPublishResult>`; profile channels removed. `TenantDeployService(relay)`.
- [ ] **Step 1: Write the failing tests:** relay URL is `ws://127.0.0.1:7002/desktop/relay?environment=dev%201&action=contribute` for `TenantPlaneUrl = 'http://127.0.0.1:7002'`; each status maps to its sentence; a 401 clears the account; `ListGraphs` returns names sorted; `Contribute` and `Deploy` close the client on success and failure; no test-visible error contains `Bearer` or the token.
- [ ] **Step 2: Run** app tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build:core`, app tests, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): contribute and publish through the tenant-plane relay`.

### Task 12: Renderer seams

**Files:**
- Create: `core/renderer/modules/account/account-service.ts` (+ `index.ts`)
- Modify: `core/renderer/modules/graph-contribute/graph-contributor.ts`, `core/renderer/modules/tenant-publish/tenant-publisher.ts`
- Create: `app/renderer/src/services/account/ipc-account-service.ts`
- Modify: `app/renderer/src/services/graph-contribute/ipc-graph-contributor.ts`, `app/renderer/src/services/tenant-publish/ipc-tenant-publisher.ts`, `app/renderer/src/app.mu` (register the account service)
- Test: `core/renderer/modules/account/tests/account-service.test.ts`, existing IPC service tests

**Interfaces:**
- Produces:
  - `AccountServiceKey = new ServiceKey<IAccountService>('AccountService')`; `interface IAccountService { readonly State: AccountState; readonly Changed: Signal; Refresh(): Promise<void>; Discover(platformUrl, email): Promise<DiscoveredTenant[]>; SignIn(platformUrl, email, tenantId): Promise<void>; CancelSignIn(): Promise<void>; SignOut(): Promise<void>; Targets(): Promise<AccountTargets>; LastChoice(kind): Promise<TargetChoice | undefined>; RememberChoice(kind, choice): Promise<void> }`. `IpcAccountService` keeps `State` current from `account:changed` and raises `Changed` (signal, per the layering rule).
  - `IGraphContributor { Contribute(environment, graphName, solutionId, packages): Promise<GraphContributeResult>; ListGraphs(environment): Promise<string[]> }` (SetProfile/HasProfile removed).
  - `ITenantPublisher { Publish(environment: string, outputDir: string): Promise<TenantPublishResult> }` (SetProfile removed).
- [ ] **Step 1: Write the failing tests:** `IpcAccountService` updates `State` and raises `Changed` once per push; methods forward to the bridge; `AccountError` kinds survive the bridge.
- [ ] **Step 2: Run** core + app tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build:core`, `npm test`, `npm run typecheck`. Expected: PASS (callers fixed in Tasks 13-14 may be temporarily adapted minimally; they must compile and their tests pass at this commit).
- [ ] **Step 5: Commit** `feat(plexus-core): account seam; contributor and publisher take an environment`.

### Task 13: Account area and Platform address setting

**Files:**
- Create: `app/renderer/src/modules/account/account.module.mu`, `account.resources.mu`, `account-status-item.ts`, `account-dialog.ts`
- Modify: `app/renderer/src/app.mu` (module registration)
- Test: `app/renderer/src/modules/account/tests/*.test.ts`

**Interfaces:**
- Consumes: `IAccountService` (Task 12), `PlatformAddress` (Task 10).
- Produces:
  - Setting `SettingDefinition [Key = "account.platformAddress", Label = "Platform address", Kind = String, Default = "http://localhost:7000", Category = "Account"]`.
  - `AccountStatusItem extends Observable` (status bar, `ShellControlDefinition [Region = StatusBar]` like `background-work.module.mu`): `Text` is "Sign in" or "<email> (<tenant>)"; its command opens the dialog.
  - `AccountDialog extends Observable` with `enum AccountDialogStep { Email, ChooseTenant, Waiting, SignedIn }`; properties `Step`, `Email`, `Tenants`, `SelectedTenant`, `Message`, `IsBusy`; commands `Continue`, `Cancel` (calls `CancelSignIn` while waiting), `SignOut`. Flow: Email → `Discover`; one tenant → straight to Waiting + `SignIn`; several → ChooseTenant (ComboBox of display names) → Waiting; Waiting shows "Finish signing in in your browser."; success → SignedIn ("Signed in as <email> (<tenant>)", Sign out button). Errors show `AccountError` sentences in `Message`. An invalid Platform address shows the `PlatformAddress.Validate` sentence without calling main.
  - Templates in `account.resources.mu` (DataTemplate per step, no explicit sizes; labels inline).
- [ ] **Step 1: Write the failing VM tests** with a fake `IAccountService`: single-tenant path goes Email → Waiting → SignedIn; multi-tenant path stops at ChooseTenant with names sorted; NoAccount shows "No account was found for this email." and stays on Email; Cancel while waiting returns to Email; status item text follows `Changed`.
- [ ] **Step 2: Run** app tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): account area and Platform address setting`.

### Task 14: Environment pickers replace the URL/token dialogs

**Files:**
- Create: `core/renderer/modules/solution-explorer/services/contribute-target-dialog.ts`, `publish-target-dialog.ts`, `target-dialogs.resources.mu`
- Modify: `core/renderer/modules/solution-explorer/services/contribute-to-graph-contributor.ts`, `publish-tenant-contributor.ts`, `solution-explorer-service.ts` (wiring, ~lines 221-240)
- Delete: `graph-profile-dialog.ts`, `tenant-profile-dialog.ts`; remove commands `graph.configure` and `tenant.configure`
- Test: `core/renderer/modules/solution-explorer/services/tests/*` (update + new)

**Interfaces:**
- Consumes: `IAccountService`, `IGraphContributor`, `ITenantPublisher` (Task 12).
- Produces:
  - `ContributeTargetDialog extends Observable`: `Environments: EnvironmentTarget[]`, `SelectedEnvironment`, `Graphs: string[]` (loaded via `ListGraphs` when the environment changes), `SelectedGraph`, `Message`, `CanContribute` (signed in, running env, graph chosen), `NeedsSignIn`. Signed out → "Sign in to contribute to an environment." with a Sign in button opening the account dialog; no Development environments → "Your account has no development environments to contribute to."; selected env stopped → "This environment is stopped. Start it from the tenant console."; env with no graphs → "This environment has no graphs yet. Create one in the tenant console.". Pre-selects `LastChoice(Contribute)`; on OK calls `RememberChoice`. `Show(): Promise<TargetChoice | undefined>` via `DialogService.Show`.
  - `PublishTargetDialog extends Observable`: same pattern for `Publish` targets, without graphs; no Runtime environments → "Your account has no runtime environments to publish to.".
  - `ContributeToGraphContributor` command `graph.contribute`: dialog → build → `Contribute(choice.Environment, choice.GraphName, ...)`; `PublishTenantContributor` `tenant.publish` / `tenant.publish-env`: dialog → build (bind modes unchanged) → `Publish(choice.Environment, outputDir)`. Success/failure messages name the environment and use the error's sentence.
- [ ] **Step 1: Write the failing VM/contributor tests** with fakes: each sentence above for its state; last choice pre-selected; changing environment reloads graphs; `CanContribute` false for a stopped env; the contribute command calls `Contribute('dev', 'main', ...)` after the dialog returns `{ Environment: 'dev', GraphName: 'main' }`; the configure commands no longer exist.
- [ ] **Step 2: Run** core tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build:core`, `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): choose the target environment instead of typing a server`.

### Task 15: End-to-end check (controller, not a subagent)

- [ ] Restart the control plane with the tenant plane enabled; run the Task 9 smoke.
- [ ] Launch Plexus (`npm run dev -w @pragmatic-tech-ai/plexus`), sign in with the tenant owner email, open Contribute on a solution: `training2` is offered with its graphs; contribute succeeds; Publish lists the tenant's Runtime environments (or the "no runtime environments" sentence).
- [ ] Change the owner password in the tenant console; the next Contribute in Plexus shows "You're signed out. Sign in and try again." and the account area reads "Sign in".
