# In-hive Desktop API, Relay and Plexus Console Addresses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People in a tenant whose console runs inside the client's own cluster sign in to Plexus by email (found by discovery or by typing the console address) and contribute / publish to their in-hive environments through the console's own desktop relay, with the dev CA trusted from the Windows store.

**Architecture:** The in-hive console composes the `/desktop/*` surface and `/desktop/relay` from the same `tenant-auth/desktop-*` classes the control plane uses, with Plan 1's `InClusterEnvironmentReach` as the relay's `IEnvironmentReach` (origin-only `record.endpoint`, no-op lease) and a new `GET /desktop/console` lookup that names the one tenant it serves. An operator Owner reset reaches the console's sessions through the advert response (pull, no new inbound route). Plexus resolves a console address per tenant (discovery's `consoleUrl`, else `tenantPlaneUrl`, or a typed address), stores it as the session's `ConsoleUrl`, and sends every later call (targets, relay, sign-out) there; its main process adds the Windows system trust store to Node's default CA list so both `fetch` and the `ws` relay trust the dev CA.

**Tech Stack:** TypeScript (ESM). Server: node >= 22.5, node:test via tsx. Plexus: Electron 43.7.5 (embedded Node 24.21.0), Node fetch (undici) + `ws` (via `@pragmatic-tech-ai/pragmatic-protocol`'s `SocketDialer`), vitest, Mural `.mu` + TS view models, Playwright (live smoke only).

**Spec:** docs/superpowers/specs/2026-11-04-in-hive-desktop-sign-in-design.md (this is Plan 3 of 3. Plan 1 = docs/superpowers/plans/2026-11-04-in-hive-console-install-and-env-management.md: console install, TLS, dev CA + `dev/dev-ca-trust.ps1`, in-cluster environment management, `IEnvironmentReach`. Plan 2 = advert route, fingerprint matching, discovery `consoleUrl`, email domains. Both execute before this plan; their Produces blocks are treated as existing code.)

## Global Constraints

- OOP only: every function is a method (instance or static) on a class; no module-level functions, no module-level mutable `let`/`const` state (module-level `const` only for true compile-time constants, plus type/enum declarations).
- Allman braces for class/interface/enum/method/constructor/getter/setter bodies and all control-flow blocks; `else`/`catch`/`finally` on their own line. Object literals, block-bodied arrows and genuine one-line blocks (`if (x) return`) stay inline. Existing files that use another style for top-level code (`apps/plexus/src/main/index.ts`, `apps/plexus/src/preload/index.ts`) keep their own style.
- PascalCase for every interface and every public method/property; private members and JSON-mirroring data fields (wire bodies such as `consoleUrl`, `tenantId`) keep camelCase.
- No inline string literals in TS method bodies: user-facing text and reused literals are `private static readonly` PascalCase constants. `.mu` labels stay inline. Fixed value sets are enums, never string unions.
- New view models extend `Observable`, never `MuralBase`. No explicit `Width`/`Height` in `.mu`.
- Tests live in `tests/` subfolders (`admin/control-plane/tests/*.test.ts`; `apps/plexus/src/main/account/tests/`, `apps/plexus/src/main/net/tests/`, `apps/plexus/src/renderer/src/modules/account/tests/`, `packages/plexus-core/src/shared/tests/`).
- New files ASCII + LF. Existing files keep their line endings (every file touched here is LF today except `admin/control-plane/agent-channel-host.ts`, which is CRLF and stays CRLF; verify with `git ls-files --eol <path>` before editing).
- Secrets never logged, printed, put in error messages, audit notes, test output or IPC answers: desktop bearer, binding verifier, auth code, RP state, minted environment credential, Owner password, operator password, agent token. Account emails are never logged either. Plexus errors are fixed sentences per `AccountErrorKind`; they never carry a URL, a token or raw server text.
- Layering: server `src/` never imports `admin/`. Plexus `packages/plexus-core` never imports `apps/plexus`. The Plexus renderer never sees the session token or a console address it did not type.
- Stage by explicit path (`git add <file> <file>`), never `git add -A`/`.`. Server: another agent edits `admin/control-plane/audit-record.ts`, `json-record-store.ts`, `tests/audit-batching.test.ts` - never stage, revert or reformat them. Plexus: never stage `apps/plexus/electron.vite.config.ts`, `apps/plexus/src/renderer/src/modules/typescript/framework-typings.generated.ts`, `packages/plexus-core/src/vite/mural-renderer.ts`, `packages/plexus-core/src/vite/tests/mural-renderer.test.ts`.
- Each commit message ends with `Co-Authored-By: <implementer model name> <noreply@anthropic.com>` naming the model that wrote the change. Work on branch `feat/in-hive-desktop-api` (server, from `master` with Plans 1 and 2 merged) and `feat/console-address-sign-in` (Plexus, from `main`). Merge locally; NEVER push.
- Server gates (all green before each server commit): `cd admin/control-plane && npx tsx --test tests/*.test.ts`; at the repo root `npm run typecheck:tools`, `npm run build:tenant-admin`, `npm test`.
- Plexus gates (all green before each Plexus commit): at the Plexus root `npm run build:core`, `npm run typecheck`, `npm test -w @pragmatic-tech-ai/plexus-core`, `npm test -w @pragmatic-tech-ai/plexus` (its `pretest` compiles `.mu`).
- No new npm dependency in either repo.
- Values pinned by this plan: lookup route `GET /desktop/console` answering `{ tenantId, tenantName }`; Plexus setting key `account.consoleAddress` (String, default `""`); IPC channel `account:sign-in-at-console`; owner-reset store file `console-owner-resets.json` (control plane) and applied-marker file `owner-reset-applied.json` (console data root); advert response field `ownerResetAt` (ISO-8601); console desktop audit file `ControlPlaneServer.DesktopAuditFile` (`tenant-desktop-audit.json`) under the console's data root.

## Review Focus

1. A desktop session saved before this change (blob with `TenantPlaneUrl`, no `ConsoleUrl`) must keep signing out, listing targets and relaying against the platform's tenant plane, and is rewritten in the new shape on the next save (Task 6 tests `Load maps a legacy TenantPlaneUrl blob to ConsoleUrl` and `targets and sign-out of a legacy session go to the platform tenant plane`).
2. A typed address that is a real https site but not a console (the control plane's tenant plane, which has no served tenant; or any page answering 200 HTML) must say "That address is not a Pragmatic tenant console." and never open the browser (Task 6 test `Console maps 404 and non-JSON 200 to NotAConsole`, Task 7 test `SignInAtConsole on a non-console never opens the browser`).
3. The dev CA not installed (or a cert for another host): the user must read a certificate sentence, not "could not be reached" (Task 5 test `IsCertificate recognises fetch and ws certificate failures`, Task 6 test `a certificate failure is CertificateUntrusted, not Unreachable`, Task 6 test `relay certificate failure names the certificate`).
4. Discovery naming a tenant whose `consoleUrl` is cleartext and not loopback (a bad advert): Plexus must refuse before Begin, so no bearer or code ever travels over cleartext to a remote host (Task 7 test `a discovered cleartext non-loopback console is refused before Begin`).
5. Typed address with surrounding spaces, a trailing slash or an uppercase scheme (`HTTPS://Console-Acme.localtest.me/`): sign-in, targets and relay must all reach `https://console-acme.localtest.me` / `wss://console-acme.localtest.me/desktop/relay?...` (Task 4 test `ConsoleAddress.Normalise trims, lowercases the origin and drops trailing slashes`, Task 6 test `RelayUrl of a normalised https console`).

---

## File Structure

Server (`admin/control-plane/`):
- Modify `tenant-auth/desktop-endpoint.ts` - optional served tenant; `GET /desktop/console`.
- Modify `server.ts` - `BuildTenantPlane` gains a trailing `consoleTenantId?: string` passed to `DesktopEndpoint`.
- Modify `tenant-admin-server.ts` - `Compose` mounts desktop + relay (reach present) with the console's desktop audit; `TenantAdminComposition.desktopAudit`.
- Create `console-owner-resets.ts` - `ConsoleOwnerResets` (control-plane store) and `ConsoleOwnerResetFollower` (console side).
- Modify the Plan 1 owner-password path (SUPERSEDED (D3): the record is made in `TenantConsoleInstaller.ResetOwnerPassword`, before the IdP call; the route is unchanged), the Plan 2 advert route handler and the Plan 2 console advert sender (names per Plan 2's Produces) - wire the owner-reset pull.
- Tests: `tests/desktop-endpoint.test.ts`, `tests/tenant-admin-server.test.ts`, `tests/desktop-relay.test.ts`, create `tests/console-owner-resets.test.ts`, plus the Plan 2 advert route/sender test files.

Plexus (`C:\Users\Eugene\Projects\architecture-agent\Plexus`):
- Modify `packages/plexus-core/src/shared/account-api.ts` - error kinds, `ConsoleAddress`, channel, bridge/API member. Create `packages/plexus-core/src/shared/tests/account-api.test.ts` (or extend the existing shared test file if one covers `PlatformAddress`; check first).
- Modify `packages/plexus-core/src/renderer/modules/account/account-service.ts` - `IAccountService.SignInAtConsole`.
- Create `apps/plexus/src/main/net/system-trust.ts` - `ITlsDefaults`, `NodeTlsDefaults`, `SystemTrust`, `TlsFailure`. Test `apps/plexus/src/main/net/tests/system-trust.test.ts`.
- Modify `apps/plexus/src/main/account/desktop-api-client.ts`, `desktop-session-store.ts`, `relay-connector.ts`, `account-service.ts`, `account-ipc.ts`; tests in `apps/plexus/src/main/account/tests/` (create `desktop-api-client.test.ts`).
- Modify `apps/plexus/src/main/index.ts` (apply system trust), `apps/plexus/src/preload/index.ts`, `apps/plexus/src/renderer/src/services/account/ipc-account-service.ts`.
- Modify `apps/plexus/src/renderer/src/modules/account/account-dialog.ts`, `account-dialog-host.ts`, `account.resources.mu`, `account.module.mu`; create `console-address-setting.ts`; tests `tests/account-dialog.test.ts`, `tests/account-dialog-host.test.ts`, `tests/fake-account-service.ts`.
- Modify (only if needed, see Task 9) the scripted sign-in helper from branch `e2e-scripted-sign-in` (expected `apps/plexus/e2e/support/scripted-desktop-sign-in.ts`; use the name it landed under). Create `apps/plexus/e2e/in-hive-console-sign-in.spec.ts` (gated live smoke).

---

### Task 1: Console lookup route `GET /desktop/console`

**Files:**
- Modify: `admin/control-plane/tenant-auth/desktop-endpoint.ts:116-139` (ctor + route map), new private `Console` method
- Modify: `admin/control-plane/server.ts:373-416` (`BuildTenantPlane` trailing param)
- Test: `admin/control-plane/tests/desktop-endpoint.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // DesktopEndpoint
  private static readonly ConsolePath = '/desktop/console'
  // ctor gains a trailing param after `connections`:
  /** The one tenant this listener serves (the in-hive console); absent on the control plane, where /desktop/console is not a route. */
  private readonly consoleTenantId?: string
  // ControlPlaneServer.BuildTenantPlane gains a trailing param after `relay`:
  consoleTenantId?: string   // forwarded to DesktopEndpoint; ComposeTenantPlane passes nothing
  ```
  Wire: `GET /desktop/console` -> 200 `{ tenantId, tenantName }` (`tenantName` = directory displayName, else the id) with `Cache-Control: no-store`. Order of checks: Origin (403, existing `Handle` rule) -> method (405) -> begin throttle `RecordHit` + `CheckAllowed` on the client address (429 with `Retry-After`; it shares the begin bucket, so lookups and begins together get 10 per minute) -> served tenant known to the directory (else 404 `unknown-tenant`) -> 200. No body is read (`req.resume()`). Registered in the route map only when `consoleTenantId` is defined, so on the control plane the path is unhandled (the host answers 404).

- [ ] **Step 1: Write the failing tests** in `tests/desktop-endpoint.test.ts` (extend `EndpointHarness` with an optional served tenant):
  - `console lookup names the served tenant`: harness with `consoleTenantId = 'acme'` (directory display name `Acme Corp`) -> `GET /desktop/console` status 200, `deepEqual(body, { tenantId: 'acme', tenantName: 'Acme Corp' })`, header `cache-control === 'no-store'`.
  - `console lookup is not a route without a served tenant`: default harness -> `Handle` returns `false`.
  - `console lookup refuses an Origin with 403 and a POST with 405`: `Origin: https://evil.example` -> 403 `{ error: 'forbidden' }`; POST -> 405 with `allow === 'GET'`.
  - `console lookup shares the begin rate limit`: 6 lookups + 4 begins from one address pass the throttle; the 11th request (lookup) is 429 with a `retry-after` header.
  - `console lookup for a served tenant the directory lost is 404`: `consoleTenantId = 'gone'` -> 404 `{ error: 'unknown-tenant' }`.
- [ ] **Step 2: Run** `cd admin/control-plane && npx tsx --test tests/desktop-endpoint.test.ts` - Expected: FAIL (no `/desktop/console` route).
- [ ] **Step 3: Implement** the ctor param, the conditional route entry and `Console(req, res)`; add the `BuildTenantPlane` param and pass it to `new DesktopEndpoint(...)`. Update the `BuildTenantPlane` doc comment: drop "so the in-hive tenant console does not serve it (that is a later follow-up)".
- [ ] **Step 4: Run** the server gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): desktop console lookup names the tenant a console serves` (stage `tenant-auth/desktop-endpoint.ts`, `server.ts`, `tests/desktop-endpoint.test.ts`).

### Task 2: The in-hive console serves the desktop API and relay

**Files:**
- Modify: `admin/control-plane/tenant-admin-server.ts` (`Compose`, `TenantAdminComposition`)
- Test: `admin/control-plane/tests/tenant-admin-server.test.ts`, `admin/control-plane/tests/desktop-relay.test.ts`

**Interfaces:**
- Consumes: `IEnvironmentReach`, `DesktopRelayWiring = { endpoints: IEnvironmentReach; audit: AuditRegistry }` (Plan 1 Task 1); `TenantAdminComposition.reach: IEnvironmentReach | undefined`, `InClusterEnvironmentReach`, `Compose(env, serviceAccountRoot?)` (Plan 1 Task 7); `BuildTenantPlane(..., withDesktop, relay, consoleTenantId)` (Task 1); `ControlPlaneServer.DesktopAuditFile`.
- Produces:
  ```ts
  // TenantAdminComposition gains:
  readonly desktopAudit: AuditRegistry   // <dataRoot>/tenant-desktop-audit.json, loaded before the plane is built
  ```
  `Compose`: `desktopAudit = new AuditRegistry(join(dataRoot, ControlPlaneServer.DesktopAuditFile))`, `await desktopAudit.Load()`; `BuildTenantPlane(..., cfg.trustedProxy, true, reach === undefined ? undefined : { endpoints: reach, audit: desktopAudit }, seededTenantId)` where `seededTenantId` is the seed's tenant id - the same value Plan 1's `InClusterOrchestrationOf` takes as `tenantId`. One home: reuse the accessor Plan 1 used; if it read the seed inline, add `public get TenantId(): string` to `SeededTenantDirectory` (`tenant-api/seeded-tenant-directory.ts`, which has `GetTenant`/`ListHives` but no tenant accessor today) and use it in both places. The RP registers `pragmatic-desktop` on the injected IdP lazily at the first begin (existing `TenantOidcRelyingParty.Begin(..., TenantOidcClientKind.Desktop)`), with the portless loopback redirect; nothing new is needed for it. Out of a pod (`reach === undefined`) the desktop sign-in and targets are served and the relay upgrade is refused (no relay), because that dev-collapse console has no way to reach environments either.

- [ ] **Step 1: Write the failing tests:**
  - `tenant-admin-server.test.ts` `Compose serves the desktop surface and its lookup`: existing seed + master key -> `composition.plane.desktop !== undefined`; then drive `composition.host` (or `plane.desktop.Handle` with a fake req/res as `desktop-endpoint.test.ts` does) with `GET /desktop/console` -> 200 `{ tenantId: Names.TenantId, ... }`.
  - `Compose without a service account has no relay`: `composition.plane.relay === undefined`.
  - `Compose in a pod mounts the relay over the composition's reach and audits under the data root`: Plan 1's temp service-account dir + `KUBERNETES_SERVICE_HOST` -> `composition.plane.relay !== undefined`, `composition.desktopAudit` file path `=== join(root, 'tenant-desktop-audit.json')` (assert via the registry's path accessor if it has one, else `existsSync` after one `Record`), and no network call at compose.
  - `desktop-relay.test.ts` `an in-cluster reach dials the env's Service DNS with its environment query and holds no lease`: `RelayKit` with its endpoints replaced by `new InClusterEnvironmentReach(fakeKubectl)` and a record whose `endpoint = { httpUrl: 'http://s.pragmatic-env-e1.svc.cluster.local:8080', wsUrl: 'ws://s.pragmatic-env-e1.svc.cluster.local:8080/?environment=e1' }`, `environmentId: 'e1'` -> the `CountingDialer`'s single dial URL `=== 'ws://s.pragmatic-env-e1.svc.cluster.local:8080/?environment=e1'`; after the client closes, the fake kubectl recorded no port-forward and the pipe is closed (lease Release ran without throwing).
- [ ] **Step 2: Run** `npx tsx --test tests/tenant-admin-server.test.ts tests/desktop-relay.test.ts` - Expected: FAIL (`plane.desktop` undefined; `desktopAudit` missing).
- [ ] **Step 3: Implement** in `Compose` as above; extend the class doc comment ("serves the Plexus desktop surface; the relay only in a pod").
- [ ] **Step 4: Run** the server gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): the in-hive console serves the desktop API and relay` (stage `tenant-admin-server.ts`, both test files).

### Task 3: An operator Owner reset ends the Owner's in-hive console sessions

**Superseded in part (as built in 998502a, per pre-flight D1-D7; the spec's Accepted deviations are authoritative).** Do not "fix" the code back to the original wording below; the lines marked SUPERSEDED were corrected. In short: the reset is recorded inside `TenantConsoleInstaller.ResetOwnerPassword` after its guards and BEFORE the IdP call (D3); the record is kept through console removal and hive delete and forgotten only with the tenant (D4); the follower revokes on any well-formed value that differs from the marker, not only a newer one, and marks only after the revoke resolved (D5); the Owner principal rule is `TenantOwner.PrincipalOf` / `TenantOwner.DefaultPrincipalId` in tenant-owner.ts and there is no `ConsoleOwnerResets.DefaultOwnerPrincipalId` (D6); the follower lives in its own file console-owner-reset-follower.ts (D6); the transport returns `ConsoleAdvertAnswer` and agent-channel-host.ts writes the field (D1, D2).

**Controller note (Plan 2 names, now written):** Plan 2 (docs/superpowers/plans/2026-11-04-in-hive-console-advert-and-discovery.md) names the route handler `ConsoleAdvertReceiver.Receive(hiveId, body)` (200 body today: the refused domains), the advert body `ConsoleAdvertBody`, and the console sender `ConsoleAdvertSender {Start, Stop, SendNow, Body}` composed by `TenantAdminServer.AdvertSenderOf`. This task adds `ownerResetAt?: string` to that 200 body and has `ConsoleAdvertSender` hand it to `ConsoleOwnerResetFollower.Apply`.

**Files:**
- Create: `admin/control-plane/console-owner-resets.ts`
- Modify: `admin/control-plane/control-plane-host.ts` (Plan 1 Task 13's `POST /api/hives/:hive/console/owner-password` handler; ctor param)
- Modify: `admin/control-plane/server.ts` (construct and load the store; pass it to the host and to Plan 2's advert route handler)
- Modify: Plan 2's advert route handler (`POST /agent/hives/:hive/console`) and Plan 2's console advert sender - read Plan 2's Produces for their exact class names and files
- Modify: `admin/control-plane/tenant-admin-server.ts` (construct the follower, hand it to Plan 2's sender)
- Modify: Plan 1's `in-hive-idp-admin.ts` (use `TenantOwner.PrincipalOf` from the new tenant-owner.ts; there was no inline `'owner'`) [SUPERSEDED: D6]
- Test: `admin/control-plane/tests/console-owner-resets.test.ts`, plus one case each in Plan 2's advert route and sender test files and in `tests/control-plane-host-hive-console.test.ts`

**Interfaces:**
- Consumes: `TenantPrincipalSessions.RevokeAllFor(tenantId, principalId)`; `TenantRecord.ownerPrincipalId?`; Plan 1's `IInHiveIdpAdmin.ResetOwnerPassword`; Plan 2's advert route and sender.
- Produces:
  ```ts
  // console-owner-resets.ts
  export class ConsoleOwnerResets          // control plane; JSON file { [tenantId]: iso }, written temp + rename
  {
      public static readonly FileName = 'console-owner-resets.json'
      // SUPERSEDED (D6): no DefaultOwnerPrincipalId here; the rule is TenantOwner.PrincipalOf / TenantOwner.DefaultPrincipalId
      public constructor(path: string, now?: () => Date)
      public Load(): Promise<void>
      public Record(tenantId: string): Promise<string>      // stores and returns now().toISOString()
      public Of(tenantId: string): string | undefined
      public Forget(tenantId: string): Promise<void>        // SUPERSEDED (D4): called only on tenant delete; console removal and hive delete keep the record
  }
  export class ConsoleOwnerResetFollower   // console; marker file { appliedAt: iso }
  {
      public static readonly FileName = 'owner-reset-applied.json'
      public constructor(principals: TenantPrincipalSessions, tenant: TenantRecord, path: string)
      /** SUPERSEDED (D5): revokes every session and closes every socket/relay of the Owner when `resetAt` is well formed and DIFFERS from the applied marker (or there is no marker), earlier values included; then records it (only after the revoke resolved). Returns whether it revoked. Undefined or malformed values are ignored. */
      public Apply(resetAt: string | undefined): Promise<boolean>
  }
  ```
  Advert response: Plan 2's 200 body gains `ownerResetAt?: string` = `ConsoleOwnerResets.Of(tenantId)`. The sender calls `follower.Apply(body.ownerResetAt)` after every 200 (its failure is logged by error name only and never fails the advert). SUPERSEDED (D3): `TenantConsoleInstaller.ResetOwnerPassword` calls `ownerResets.Record(tenantId)` after its guards and BEFORE the IdP call (never after it resolved: that loses either the password or the revocation). The Owner's console and desktop sessions therefore end within one advert interval (Plan 2: at most 5 minutes). The owner-password route's response body is unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/console-owner-resets.test.ts`:
  - `Record stores the reset time per tenant and survives a reload` (fixed clock `2026-11-04T10:00:00.000Z`; new instance `Load` -> `Of('acme') === '2026-11-04T10:00:00.000Z'`).
  - `Forget drops the tenant`.
  - `Apply revokes the Owner once per reset`: fake principals recording calls; tenant `{ id: 'acme', ownerPrincipalId: 'p-1' }` -> `Apply('2026-11-04T10:00:00.000Z')` is `true` with call `['acme','p-1']`; the same value again is `false`; a later value is `true`.
  - `Apply without ownerPrincipalId revokes the default owner principal` -> call `['acme', 'owner']`.
  - SUPERSEDED (D5): `Apply ignores undefined and malformed values` -> `false`, no call; plus `an equal value is a no-op; a different value revokes, even an earlier one`.
  - `the applied marker survives a restart` (new follower on the same file, same value -> `false`).
  - In Plan 2's advert route test file: `the advert answer carries the tenant's last Owner reset`. In Plan 2's sender test file: `a 200 advert answer is handed to the owner-reset follower`. In `tests/control-plane-host-hive-console.test.ts`: `an Owner reset of an in-hive console records the reset time` and `a failed reset records nothing` (SUPERSEDED (D3): `a reset records before the IdP call` and `a refused reset (installing / no console) records nothing`).
- [ ] **Step 2: Run** the four test files - Expected: FAIL.
- [ ] **Step 3: Implement** the two classes and the wiring; `in-hive-idp-admin.ts` uses `TenantOwner.PrincipalOf` (SUPERSEDED (D6): there was no inline `'owner'`).
- [ ] **Step 4: Run** the server gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): an operator Owner reset ends the Owner's in-hive console sessions` (stage each touched file by path).

### Task 4: Plexus shared contract - console address, error kinds, channel

**Files:**
- Modify: `packages/plexus-core/src/shared/account-api.ts`
- Modify: `packages/plexus-core/src/renderer/modules/account/account-service.ts:46-66`
- Test: `packages/plexus-core/src/shared/tests/account-api.test.ts` (create, or extend the existing test that covers `PlatformAddress`)

**Interfaces:**
- Produces:
  ```ts
  // AccountChannel gains
  SignInAtConsole = 'account:sign-in-at-console',
  // AccountErrorKind gains (messages exactly):
  ConsoleAddressInvalid = 'console-address-invalid',  // 'Enter the console address as an https:// web address. Plain http:// works only for this computer.'
  NotAConsole = 'not-a-console',                      // 'That address is not a Pragmatic tenant console.'
  ConsoleUnreachable = 'console-unreachable',         // "Your organization's console could not be reached. Try again later, or check the console address."
  CertificateUntrusted = 'certificate-untrusted',     // "This computer doesn't trust the server's certificate. Ask your administrator to install it."
  // new class, next to PlatformAddress (same scheme rule: https anywhere, http only for localhost / 127.0.0.1 / [::1]):
  export class ConsoleAddress
  {
      /** undefined when usable, else AccountErrorKind.ConsoleAddressInvalid. */
      public static Validate(url: string): AccountErrorKind | undefined
      /** Trimmed; scheme and host lowercased (URL does this); port and path kept; trailing slashes dropped. Call only on a valid address. */
      public static Normalise(url: string): string
  }
  // IAccountBridge gains: SignInAtConsole(consoleUrl: string, email: string): Promise<AccountReply<AccountState>>
  // IAccountApi gains:    SignInAtConsole(consoleUrl: string, email: string): Promise<AccountState>
  // IAccountService (core renderer) gains: SignInAtConsole(consoleUrl: string, email: string): Promise<void>
  ```
  `PlatformAddress` and `ConsoleAddress` share the loopback host list through one private static home (e.g. `ConsoleAddress` reads `PlatformAddress.LoopbackHosts` made `public static readonly`); do not duplicate the list. `DiscoveredTenant` stays `{ Id, DisplayName }`: the console address never reaches the renderer.

- [ ] **Step 1: Write the failing tests:**
  - `ConsoleAddress.Validate accepts https anywhere and http only on loopback`: `https://console-acme.localtest.me` -> `undefined`; `http://127.0.0.1:7002` -> `undefined`; `http://console-acme.localtest.me` -> `ConsoleAddressInvalid`; `ftp://x`, `not a url`, `''` -> `ConsoleAddressInvalid`.
  - `ConsoleAddress.Normalise trims, lowercases the origin and drops trailing slashes`: `'  HTTPS://Console-Acme.localtest.me/ '` -> `'https://console-acme.localtest.me'`; `'https://h.example:8443/tenant//'` -> `'https://h.example:8443/tenant'`.
  - `every new error kind has its fixed sentence`: `new AccountError(AccountErrorKind.NotAConsole).message === 'That address is not a Pragmatic tenant console.'` and likewise for the other three exact strings above.
- [ ] **Step 2: Run** `npm test -w @pragmatic-tech-ai/plexus-core` - Expected: FAIL.
- [ ] **Step 3: Implement.** Adding the interface members breaks the app's implementers until Tasks 7 and 8; in this commit add the app-side members as thin pass-throughs only where the compiler requires (preload `account.SignInAtConsole` -> `AccountBridge.Call(AccountChannel.SignInAtConsole, consoleUrl, email)`; `IpcAccountService.SignInAtConsole` -> `this.Apply(AccountWire.Unwrap(await this.api.SignInAtConsole(consoleUrl, email)))`; `tests/fake-account-service.ts` records the call) so every gate stays green.
- [ ] **Step 4: Run** the Plexus gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus-core): console address and its sign-in contract` (stage `account-api.ts`, core `account-service.ts`, the core test, `apps/plexus/src/preload/index.ts`, `ipc-account-service.ts`, `fake-account-service.ts`).

### Task 5: Main process trusts the system certificate store

**Files:**
- Create: `apps/plexus/src/main/net/system-trust.ts`
- Modify: `apps/plexus/src/main/index.ts` (first statement inside the `app.whenReady()` handler, before any account or relay object is built)
- Test: `apps/plexus/src/main/net/tests/system-trust.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The slice of node:tls SystemTrust uses (NodeTlsDefaults adapts the real module). */
  export interface ITlsDefaults
  {
      GetCaCertificates(store: TlsCaStore): string[]
      SetDefaultCaCertificates(certs: string[]): void
  }
  export enum TlsCaStore { Default = 'default', System = 'system' }
  export class NodeTlsDefaults implements ITlsDefaults   // tls.getCACertificates / tls.setDefaultCACertificates
  export class SystemTrust
  {
      /** Sets Node's default CA list to the union (deduplicated, default first) of the current defaults and the OS store, so Node fetch and ws trust what Windows trusts (incl. CurrentUser\Root). Returns false, changing nothing, when the OS store cannot be read; logs only the error name. */
      public static Apply(tls: ITlsDefaults = new NodeTlsDefaults()): boolean
  }
  export class TlsFailure
  {
      /** True when `error` (or its `cause`, one level) carries a certificate-verification code. */
      public static IsCertificate(error: unknown): boolean
  }
  ```
  `TlsFailure` codes (one `private static readonly` set): `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_GET_ISSUER_CERT`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_UNTRUSTED`, `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`, `ERR_TLS_CERT_ALTNAME_INVALID`. Node fetch rejects with `TypeError('fetch failed')` whose `cause.code` is the code; `ws` emits an Error whose own `code` is the code.

- [ ] **Step 1: Write the failing tests:**
  - `Apply sets the union of default and system certificates once each`: fake default `['A','B']`, system `['B','C']` -> one `SetDefaultCaCertificates` call with `['A','B','C']`; returns `true`.
  - `Apply changes nothing when the system store cannot be read`: system read throws -> no set call, returns `false`, `console.warn` spy got the error name only.
  - `NodeTlsDefaults reads the real system store`: `new NodeTlsDefaults().GetCaCertificates(TlsCaStore.System).length > 0` (Windows dev machine and CI both have roots; never call Set on the real module in tests).
  - `IsCertificate recognises fetch and ws certificate failures`: `Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })` -> true; `Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })` -> true; `{ cause: { code: 'ECONNREFUSED' } }` -> false; `'text'` -> false.
- [ ] **Step 2: Run** `npm test -w @pragmatic-tech-ai/plexus -- src/main/net` - Expected: FAIL.
- [ ] **Step 3: Implement**; in `index.ts` call `SystemTrust.Apply()` at the top of the ready handler with a one-line comment (why: main's fetch and the ws relay use Node TLS, which ignores the Windows store by default).
- [ ] **Step 4: Run** the Plexus gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): main process trusts the system certificate store` (stage the two new files and `index.ts`).

### Task 6: Per-tenant console addresses in the API client, session and relay

**Files:**
- Modify: `apps/plexus/src/main/account/desktop-api-client.ts`
- Modify: `apps/plexus/src/main/account/desktop-session-store.ts`
- Modify: `apps/plexus/src/main/account/relay-connector.ts:113-176`
- Test: create `apps/plexus/src/main/account/tests/desktop-api-client.test.ts`; extend `tests/desktop-session-store.test.ts`, `tests/relay-connector.test.ts`

**Interfaces:**
- Consumes: `ConsoleAddress`, the four new `AccountErrorKind` members (Task 4); `TlsFailure.IsCertificate` (Task 5).
- Produces:
  ```ts
  // desktop-api-client.ts
  export type DiscoveredConsole = { Id: string; DisplayName: string; ConsoleUrl: string }  // per-tenant consoleUrl, else the body's tenantPlaneUrl
  export type Discovery = { Tenants: DiscoveredConsole[]; TenantPlaneUrl: string }
  export type ServedTenant = { TenantId: string; TenantName: string }
  // DesktopApiClient
  public Discover(platformUrl: string, email: string): Promise<Discovery>               // unchanged signature
  public Console(consoleUrl: string): Promise<ServedTenant>                             // GET /desktop/console
  public Begin(consoleUrl: string, tenantId: string, redirectUri: string, challenge: string): Promise<string>
  public Complete(consoleUrl: string, state: string, code: string, verifier: string): Promise<CompletedSignIn>
  public Targets(session: DesktopSession): Promise<AccountTargets>                      // session.ConsoleUrl
  public SignOut(session: DesktopSession): Promise<void>                                // session.ConsoleUrl
  // desktop-session-store.ts
  export type DesktopSession = { ConsoleUrl: string; Token: string; Email: string; TenantId: string; TenantName: string; ExpiresAt: string }
  // RelayConnector.RelayUrl(consoleUrl: string, environment: string, kind: TargetKind): string  (param renamed; same rule)
  ```
  Failure mapping: `Send` takes the kind to raise when the request cannot be made: `Discover` -> `Unreachable` (unchanged sentence about the Platform address); every console call -> `ConsoleUnreachable`; in both, a `TlsFailure.IsCertificate` failure -> `CertificateUntrusted`. `Console`: 404 -> `NotAConsole`; 200 that is not a JSON object with non-empty string `tenantId` -> `NotAConsole`; 429/5xx -> `Unavailable`. A discovery entry's `consoleUrl` that is absent, not a string or empty falls back to `tenantPlaneUrl`; any other string is kept as given (validated by the caller, Task 7). Session store: `Fields` is the new key set; `Decode` accepts a blob whose `ConsoleUrl` is missing but whose legacy `TenantPlaneUrl` is a non-empty string, mapping it to `ConsoleUrl`; `Pick`/`Save` write only the new shape. Relay certificate failure: `Refusal` checks `TlsFailure.IsCertificate(e)` before the status switch and returns `new AccountError(AccountErrorKind.CertificateUntrusted)`.

- [ ] **Step 1: Write the failing tests:**
  - `desktop-api-client.test.ts` (fake fetch recording URL, method, headers):
    - `Discover keeps each tenant's console address and falls back to the tenant plane`: body `{ tenants: [{ id: 'a', displayName: 'A', consoleUrl: 'https://console-a.example' }, { id: 'b', displayName: 'B' }], tenantPlaneUrl: 'http://127.0.0.1:7002' }` -> `Tenants[0].ConsoleUrl === 'https://console-a.example'`, `Tenants[1].ConsoleUrl === 'http://127.0.0.1:7002'`.
    - `Console answers the served tenant`: 200 `{ tenantId: 'acme', tenantName: 'Acme' }` -> `{ TenantId: 'acme', TenantName: 'Acme' }`; request is `GET https://console-acme.example/desktop/console`, no Authorization, no Origin.
    - `Console maps 404 and non-JSON 200 to NotAConsole` (404; 200 `text/html` body `<html>`; 200 `{}`).
    - `a certificate failure is CertificateUntrusted, not Unreachable`: fetch rejects with the Task 5 fetch-shaped error -> `Console` and `Discover` both reject with kind `CertificateUntrusted`.
    - `console calls that cannot connect are ConsoleUnreachable`: `ECONNREFUSED` cause -> `Begin`, `Targets`, `SignOut` reject with `ConsoleUnreachable`; `Discover` with `Unreachable`.
    - `targets and sign-out of a legacy session go to the platform tenant plane`: session loaded from a legacy blob (`TenantPlaneUrl: 'http://127.0.0.1:7002'`) -> fetch URLs `http://127.0.0.1:7002/desktop/targets` and `.../desktop/sign-out`.
  - `desktop-session-store.test.ts`: `Load maps a legacy TenantPlaneUrl blob to ConsoleUrl` (encrypt the old JSON shape directly; `Load()` deepEquals the new shape with `ConsoleUrl` = old value); `Save writes only the new fields` (decrypted JSON has `ConsoleUrl` and no `TenantPlaneUrl`); `a blob with neither address reads as signed out`.
  - `relay-connector.test.ts`: `RelayUrl of a normalised https console` (`RelayUrl('https://console-acme.localtest.me', 'dev env', TargetKind.Contribute) === 'wss://console-acme.localtest.me/desktop/relay?environment=dev%20env&action=contribute'`); `relay dials the session's console address`; `relay certificate failure names the certificate` (dial rejects with `Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })` -> `AccountError` kind `CertificateUntrusted`, session not cleared).
- [ ] **Step 2: Run** `npm test -w @pragmatic-tech-ai/plexus -- src/main/account` - Expected: FAIL.
- [ ] **Step 3: Implement**; rename every `TenantPlaneUrl` use of the session (including `account-service.ts`'s session literal, which Task 7 then reshapes) so the app compiles.
- [ ] **Step 4: Run** the Plexus gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): sessions remember their console address; certificate failures read plainly` (stage the three sources, the three tests and `account-service.ts` if touched).

### Task 7: Account service signs in at the chosen or typed console

**Files:**
- Modify: `apps/plexus/src/main/account/account-service.ts`
- Modify: `apps/plexus/src/main/account/account-ipc.ts`
- Test: `apps/plexus/src/main/account/tests/account-service.test.ts`, `tests/account-ipc.test.ts`

**Interfaces:**
- Consumes: `DesktopApiClient.Discover/Console/Begin/Complete`, `DiscoveredConsole`, `DesktopSession.ConsoleUrl` (Task 6); `ConsoleAddress`, `AccountChannel.SignInAtConsole` (Task 4).
- Produces:
  ```ts
  // AccountService
  public Discover(platformUrl: string, email: string): Promise<DiscoveredTenant[]>          // maps DiscoveredConsole -> { Id, DisplayName }; caches the consoles
  public SignIn(platformUrl: string, email: string, tenantId: string): Promise<AccountState> // signs in at that tenant's console address
  public SignInAtConsole(consoleUrl: string, email: string): Promise<AccountState>          // validate -> Console() -> sign in there
  ```
  The `discovered` cache becomes `{ PlatformUrl; Email; Consoles: ReadonlyMap<string, string> }` (tenant id -> console address). `SignIn` resolves the console for `tenantId` from the cache (re-discovering when the platform/email differ, as today); a tenant absent from the answer -> `NoAccount`; a console address failing `ConsoleAddress.Validate` -> `Unavailable` (before the receiver starts, Begin or the browser). The shared body (verifier/challenge, receiver, Begin, browser, Complete, cancel checks, Keep, ending the previous session at its own `ConsoleUrl`) moves into one private `SignInAt(attempt, consoleUrl: string, tenantId: string, email: string)` used by both public methods; the session stores `ConsoleAddress.Normalise(consoleUrl)`. `SignInAtConsole`: `ConsoleAddress.Validate` -> `AccountError(ConsoleAddressInvalid)`; `Console(normalised)` gives the tenant id; the attempt is created first so a cancel during the lookup is honoured. `AccountIpc` registers `AccountChannel.SignInAtConsole` with both arguments checked by `Text`. The IdP is reached only by the system browser; the main process never fetches the authorize URL.

- [ ] **Step 1: Write the failing tests** in `account-service.test.ts` (existing fakes: fake client, receiver, openExternal):
  - `signs in at the chosen tenant's console address`: discovery `[{ Id: 'a', ConsoleUrl: 'https://console-a.example' }, { Id: 'b', ConsoleUrl: 'http://127.0.0.1:7002' }]`; `SignIn(platform, email, 'a')` -> `Begin` and `Complete` got `'https://console-a.example'`; the saved session's `ConsoleUrl === 'https://console-a.example'`; a later `Targets()` uses it.
  - `a discovered cleartext non-loopback console is refused before Begin`: `ConsoleUrl: 'http://console-a.example'` -> rejects `Unavailable`; `Begin` never called; `openExternal` never called; receiver never started.
  - `SignInAtConsole signs in at the typed address`: `SignInAtConsole('  HTTPS://Console-Acme.localtest.me/ ', email)` -> `Console('https://console-acme.localtest.me')`, `Begin('https://console-acme.localtest.me', 'acme', ...)`; session `ConsoleUrl === 'https://console-acme.localtest.me'`; `Discover` never called.
  - `SignInAtConsole rejects an invalid address without dialing`: `'http://console-acme.localtest.me'` -> `ConsoleAddressInvalid`, no client call.
  - `SignInAtConsole on a non-console never opens the browser`: `Console` rejects `NotAConsole` -> same kind; no `Begin`, no `openExternal`.
  - `cancel during the console lookup: no browser, kind Cancelled` (mirrors the existing discovery-cancel test).
  - `signing in to a console ends the previous platform session at the platform`: stored legacy-shaped session at `http://127.0.0.1:7002`; `SignInAtConsole(...)` succeeds -> `SignOut` called with the previous session, whose `ConsoleUrl === 'http://127.0.0.1:7002'`.
  - `account-ipc.test.ts`: `sign-in-at-console passes both strings and answers the state envelope`; `a non-string console address is refused as malformed` (`{ Ok: false, Error: { Kind: Unavailable } }` per `AccountWire.Capture`).
- [ ] **Step 2: Run** `npm test -w @pragmatic-tech-ai/plexus -- src/main/account` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Plexus gates - Expected: PASS.
- [ ] **Step 5: Commit** `feat(plexus): sign in at a tenant's own console, discovered or typed` (stage `account-service.ts`, `account-ipc.ts`, both tests).

### Task 8: Account dialog - "Use a specific console address"

**Files:**
- Create: `apps/plexus/src/renderer/src/modules/account/console-address-setting.ts`
- Modify: `apps/plexus/src/renderer/src/modules/account/account-dialog.ts`, `account-dialog-host.ts`, `account.resources.mu`, `account.module.mu`
- Test: `apps/plexus/src/renderer/src/modules/account/tests/account-dialog.test.ts`, `tests/account-dialog-host.test.ts`

**Interfaces:**
- Consumes: `IAccountService.SignInAtConsole`, `ConsoleAddress`, `AccountErrorKind.ConsoleAddressInvalid` (Task 4).
- Produces:
  ```ts
  // console-address-setting.ts
  export interface IConsoleAddressSetting
  {
      readonly Value: string            // '' when unset or blank
      Remember(address: string): void
      Forget(): void
  }
  export class ConsoleAddressSetting implements IConsoleAddressSetting   // over ApplicationSettings (Get/Set), key below; absent settings service -> Value '' and no-ops
  {
      public static readonly Key = 'account.consoleAddress'
      public constructor(settings: ApplicationSettings | undefined)
  }
  // AccountDialog ctor becomes:
  public constructor(account: IAccountService, platformAddress: string, consoleAddress: IConsoleAddressSetting, close: () => void, closeOnSignIn = false)
  // AccountDialog gains bindables:
  UseConsoleAddress: boolean            // starts true when consoleAddress.Value !== ''
  ConsoleAddress: string                // starts as consoleAddress.Value
  UseConsoleAddressCommand: ICommand    // shows the field
  UsePlatformCommand: ICommand          // hides it (the remembered value stays until a platform sign-in succeeds)
  ```
  Continue on the Email step with `UseConsoleAddress`: empty email -> `InvalidEmail` sentence; `ConsoleAddress.Validate` failing -> its `AccountError` sentence (nothing reaches main); else Waiting step and `account.SignInAtConsole(address, email)`; on success `consoleAddress.Remember(ConsoleAddress.Normalise(address))`. A successful platform sign-in calls `consoleAddress.Forget()`, so the next dialog opens the way the user last signed in. `AccountDialogHost` builds `new ConsoleAddressSetting(this.provider.get(ApplicationSettings.Key))`. Add both bindables to the dialog's `AccountDialogProperty` enum and raise them on change.
  `.mu` (Email panel, under the email TextBox): a `Button [ Variant = Text, Command = $UseConsoleAddressCommand, Visibility = $UseConsoleAddress << ToInverseVisibility ]` with text "Use a specific console address"; a StackPanel shown by `$UseConsoleAddress << ToVisibility` holding `TextBlock "Console address"`, `TextBox [ Text = $ConsoleAddress ]`, a caption `TextBlock "For example https://console-yourcompany.example.com"` and a text Button "Find my organization from my email instead" bound to `$UsePlatformCommand`. Use the converter the repo already has for inverse visibility (check `ToVisibility`'s siblings; if none exists, bind a second getter `ShowsUseConsoleLink` instead of adding a converter). `account.module.mu` adds `SettingDefinition [ Key = "account.consoleAddress", Label = "Console address", Description = "A tenant console to sign in to directly, instead of asking the platform which organization your email belongs to.", Kind = String, Default = "", Category = "Account" ]`, with a comment that the key mirrors `ConsoleAddressSetting.Key`.

- [ ] **Step 1: Write the failing tests** in `account-dialog.test.ts` (fake setting class recording Remember/Forget):
  - `the console address field starts open with the remembered address`: Value `'https://console-acme.localtest.me'` -> `UseConsoleAddress === true`, `ConsoleAddress === 'https://console-acme.localtest.me'`.
  - `continue with a console address signs in there and remembers it`: email `ann@acme.example`, address `'https://Console-Acme.localtest.me/'` -> fake `SignInAtConsole('https://Console-Acme.localtest.me/', 'ann@acme.example')`; then `Step === SignedIn`; `Remember('https://console-acme.localtest.me')`; `Discover` never called.
  - `an invalid console address shows the sentence and calls nothing`: `'http://console-acme.localtest.me'` -> `Message === new AccountError(AccountErrorKind.ConsoleAddressInvalid).message`, no service call, still Email step.
  - `a console sign-in failure shows its sentence and remembers nothing`: fake rejects `NotAConsole` -> `Message === 'That address is not a Pragmatic tenant console.'`, Email step, no Remember.
  - `a platform sign-in forgets the remembered console address`: Value set, `UsePlatformCommand` executed, discovery with one tenant -> SignIn succeeds -> `Forget` called once.
  - `account-dialog-host.test.ts`: `the dialog reads the console address setting`: ApplicationSettings fake with `account.consoleAddress = 'https://c.example'` -> the shown dialog's `ConsoleAddress === 'https://c.example'`.
- [ ] **Step 2: Run** `npm test -w @pragmatic-tech-ai/plexus -- src/renderer/src/modules/account` - Expected: FAIL.
- [ ] **Step 3: Implement** the setting class, the VM members, the host wiring and both `.mu` edits; update existing tests' `new AccountDialog(...)` calls to pass a fake setting.
- [ ] **Step 4: Run** the Plexus gates - Expected: PASS. Then run `npm run dev -w @pragmatic-tech-ai/plexus` once, open the account dialog, and confirm the link shows, the field toggles and a bad address shows the sentence (visual check only; the window goes to the second monitor).
- [ ] **Step 5: Commit** `feat(plexus): sign in at a specific console address from the account dialog` (stage the new file, the four modified sources and both tests).

### Task 9: Live smoke - Plexus signs in to the in-hive console and contributes through its relay

**Files:**
- Modify (only if needed): the scripted sign-in helper from branch `e2e-scripted-sign-in` (expected `apps/plexus/e2e/support/scripted-desktop-sign-in.ts`)
- Create: `apps/plexus/e2e/in-hive-console-sign-in.spec.ts` (skips unless its env vars are set; never part of the unit gates)

**Interfaces:**
- Consumes: Tasks 1-8; Plan 1's operator routes (`PUT /api/hives/:hive/console`, `POST .../console-install`, `GET` status with `devCaFile`, `POST .../console/owner-password`, `DELETE /api/hives/:hive/console`), its `dev/dev-ca-trust.ps1 -CaFile <path> (-Install | -Remove)`, and its smoke's teardown list; Plan 2's discovery `consoleUrl`; the console's `/tenant-api/environments` routes; the app's account IPC and graph-contribute IPC.
- Produces: env vars read by the spec, all required for it to run: `PLEXUS_IHC_PLATFORM_URL` (e.g. `http://localhost:7000`), `PLEXUS_IHC_CONSOLE_URL` (`https://console-pragmatic-default.localtest.me`), `PLEXUS_IHC_EMAIL` (the tenant Owner's email), `PLEXUS_IHC_PASSWORD_FILE` (file with the Owner password), `PLEXUS_IHC_ENVIRONMENT` (`smoke-ihd`). The password is read from the file and is never printed, logged, put in a test title, an assertion message or a trace attachment (disable Playwright tracing/screenshots for the IdP page steps).

  Helper rule: discovery sign-in needs no helper change (the console address is resolved inside main). If the helper starts sign-in through `account:sign-in` IPC, add an optional `ConsoleAddress` option that invokes `account:sign-in-at-console` with `(consoleAddress, email)` instead; if it drives the account dialog, the option clicks "Use a specific console address" and fills the field. The helper's IdP login page must not set `ignoreHTTPSErrors` for these runs (the point is system trust). The two existing live specs (`runtime-live-loop.spec.ts`, `sp1-plexus-smoke.spec.ts`) target the control-plane path and need no change; run them once to confirm.

  Prerequisites the executor establishes (stop and ask the user if any cannot be met): (a) Plans 1-3 merged locally in the server and Plexus, `e2e-scripted-sign-in` merged into Plexus `main` (else stop and ask); (b) `pragmatic-server:dev` rebuilt per `docker/Dockerfile`'s header and the control plane restarted from this checkout exactly as Plan 1 Task 15 describes; (c) the console installed on `default-pragmatic-hive` with development TLS and base domain `localtest.me` through Plan 1's operator routes (Plan 1's smoke steps 2-4, without its teardown) and the Owner password fetched into a temp file via `POST .../console/owner-password` (written by a script, never echoed); (d) the dev CA trusted: `powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -CaFile <devCaFile> -Install` - Windows shows a confirmation dialog the USER must accept, so ask the user before running it; (e) environment `smoke-ihd` created on the console (Plan 1 smoke step 8) and `running`; (f) Plan 2's first advert received (poll `POST /api/desktop/discover` for the Owner email up to 6 minutes until the tenant entry's `consoleUrl === PLEXUS_IHC_CONSOLE_URL`); (g) the default browser is Edge or Chrome (Firefox does not read the Windows root store by default).

  Spec steps (each a `test.step`):
  1. Launch Plexus via `e2e/plexus-app.ts`; account State is signed out.
  2. Discovery path: `Discover(PLATFORM, EMAIL)` lists `pragmatic-default`; `SignIn(PLATFORM, EMAIL, 'pragmatic-default')` completed by the helper -> State `SignedIn` with tenant name.
  3. `Targets()` lists `PLEXUS_IHC_ENVIRONMENT` with status `running` under Contribute (only the in-hive console knows this environment, so this proves the session talks to the console).
  4. Contribute a one-entity graph to it through the graph-contribute IPC, then list graphs through the same relay -> the graph is there.
  5. Sign out -> State signed out; a following `Targets()` is `SignedOut`.
  6. Typed path: `SignInAtConsole(CONSOLE, EMAIL)` completed by the helper -> `Targets()` lists the environment again.
  7. Audit check (outside Plexus, by the executor): `kubectl --context docker-desktop -n pragmatic-system exec deploy/pragmatic-tenant-admin-pragmatic-default -- cat /data/tenant-desktop-audit.json` has a contribute entry by the Owner for `smoke-ihd`; the output contains no `Bearer`, and the captured spec output does not contain the first 6 characters of the Owner password.
  8. Owner reset (Task 3): `POST .../console/owner-password`, wait up to 6 minutes -> `Targets()` becomes `SignedOut`.
  Teardown (always, best effort, each reported): sign out; delete `smoke-ihd` from the console; `DELETE /api/hives/default-pragmatic-hive/console` and Plan 1's leftover cleanup; `dev-ca-trust.ps1 -Remove` (ask the user to accept its dialog); delete the password temp file.

- [ ] **Step 1: Read the helper** on Plexus `main`; apply the helper rule above (or record that no change was needed).
- [ ] **Step 2: Write the spec** (constants hoisted, Allman braces, the class-per-file e2e style of `runtime-live-loop.spec.ts`); `npm run typecheck` - Expected: PASS; `npx playwright test e2e/in-hive-console-sign-in.spec.ts` without the env vars - Expected: skipped.
- [ ] **Step 3: Establish the prerequisites** (asking the user where stated) and **run** `npx playwright test e2e/in-hive-console-sign-in.spec.ts` from `apps/plexus` with the env vars - Expected: every step passes; then run the two existing live specs - Expected: unchanged outcome from before this plan.
- [ ] **Step 4: Fix** any product bug found in the owning task's files with a regression test there; re-run the gates and the smoke.
- [ ] **Step 5: Commit** `test(plexus): live smoke for signing in to an in-hive console` (stage the spec and, if changed, the helper; server fixes are committed in the server repo with their own tests).

---

## Self-review

**Spec coverage.** Goal 1 (console serves `/desktop/*` and `/desktop/relay` from the same classes) - Tasks 1, 2. Goal 2 (reach over Service DNS, never port-forward) - Task 2 relay test over Plan 1's `InClusterEnvironmentReach`. Goal 6 (per-tenant console address; every later call there) - Tasks 6, 7. Goal 7 (typed address, remembered) - Tasks 4, 7, 8. "Builder's guide / Plexus": `consoleUrl` with `tenantPlaneUrl` fallback, session stores the address, targets/relay/sign-out use it - Task 6; typed address https or loopback http - Task 4; console-side lookup - Task 1; plain-sentence errors - Tasks 4, 6. "In-hive desktop API and relay": `withDesktop` + `DesktopRelayWiring`, no lease, desktop audit in the data root, `pragmatic-desktop` client on the injected IdP (existing lazy registration) - Task 2. Development certificates: Plexus main uses the system trust store - Task 5; verified live with Plan 1's dev CA script - Task 9. Intent guarantees: sign-out and password change reuse the shared classes (Task 2), operator Owner reset - Task 3 (by pull, at the console's next advert: at most 5 minutes), tenant delete ends access only when its hives were deleted without force, because Plan 1's hive/console removal takes the console away; a forced hive delete skips the cluster and leaves a running console reachable until the cluster owner removes it (its adverts are refused) - recorded in the spec's accepted deviations. Goals 3-5 belong to Plans 1 and 2. Profile: Plexus never calls `/desktop/profile` (its state comes from the stored session), so there is nothing to route there.

**Placeholder scan.** Task 3 names Plan 2's advert route and sender by role because Plan 2 is written in parallel; the executor reads Plan 2's Produces for the class names, and the payload field (`ownerResetAt`) and calls are pinned here. Task 9's helper path is named as expected with the rule to use the landed name.

**Type consistency.** `consoleTenantId` (Task 1) is the trailing param of both `DesktopEndpoint` and `BuildTenantPlane` and is passed in Task 2. `ConsoleAddress.Validate/Normalise`, the four `AccountErrorKind` members and `AccountChannel.SignInAtConsole` (Task 4) are used unchanged in Tasks 6-8. `DesktopSession.ConsoleUrl` (Task 6) in Task 7. `TlsFailure.IsCertificate` (Task 5) in Task 6. `IConsoleAddressSetting` (Task 8) only in Task 8. `TenantOwner.PrincipalOf` / `TenantOwner.DefaultPrincipalId` (tenant-owner.ts) is the one Owner-principal rule, re-exported as `TenantProvisioningService.OwnerPrincipalId` (SUPERSEDED the original `ConsoleOwnerResets.DefaultOwnerPrincipalId`, D6).

**Review Focus.** Each line names its test in the owning task (6; 6+7; 5+6; 7; 4+6).

**Proportion.** No method bodies; code blocks are signatures, wire shapes and exact sentences only.

## Rulings

- Ruling: the typed-address lookup is a new `GET /desktop/console` answering `{ tenantId, tenantName }`, taking no email - why: the console serves exactly one tenant, so an email adds nothing and would let the route confirm which emails have accounts; a separate read lets Plexus say "not a console" before opening a browser - cost if wrong: one more route; switching to an email-taking begin later is local to Tasks 1 and 7.
- Ruling: the lookup shares the begin rate limit bucket - why: it is unauthenticated and precedes a begin in the typed flow, so one budget bounds both - cost if wrong: a user retrying addresses can hit 429 slightly sooner.
- Ruling: Plexus main trusts the OS store via `tls.setDefaultCACertificates(union(default, system))` at the top of the ready handler, not Electron `net.fetch` and not `--use-system-ca` / `NODE_USE_SYSTEM_CA` - why: account HTTP is Node fetch (undici) and the relay is `ws` over Node https (`pragmatic-protocol`'s `SocketDialer`), so `net.fetch` would leave the relay untrusted; Electron 43.7.5 embeds Node 24.21.0, where `tls.getCACertificates('system')` works (179 certificates on this machine) and `setDefaultCACertificates` exists; NODE_OPTIONS is ignored by packaged Electron apps - cost if wrong: if undici kept an earlier CA list, the dev CA fails with the certificate sentence in the Task 9 smoke; fallback is injecting `net.fetch` into `DesktopApiClient` (its ctor already takes a fetch) and passing `ca` to the ws dialer.
- Ruling: the session field is renamed `TenantPlaneUrl` -> `ConsoleUrl`, and legacy blobs are read by mapping the old field - why: one address per session is all any call needs; the old value is exactly the platform address those sessions belong to - cost if wrong: none for users; a reader of old code sees a rename.
- Ruling: the console address stays in main; `DiscoveredTenant` crossing to the renderer is unchanged - why: the renderer never needs it and the spec keeps addresses out of the UI except the typed one - cost if wrong: one field to add later.
- Ruling: a discovered `consoleUrl` failing the https / loopback-http rule refuses that sign-in with `Unavailable` rather than falling back to the tenant plane - why: falling back would sign an in-hive tenant into the control plane's tenant plane, which has none of its accounts; continuing would send a bearer over cleartext - cost if wrong: a misconfigured advert blocks sign-in until fixed (the operator sees the advert in the portal).
- Ruling: out of a pod the console serves desktop sign-in and targets but no relay - why: Plan 1 gives the out-of-pod (dev-collapse) console no `IEnvironmentReach`, and its environment service cannot mint credentials there either - cost if wrong: dev-collapse contribute shows the relay-refused sentence; the supported path is in a pod.
- Ruling: an operator Owner reset reaches the console by pull - the control plane records the reset time and Plan 2's advert answer carries it; the console revokes the Owner's sessions and relays when it sees a newer value - why: the spec requires Owner reset to end access, the control plane cannot reach the console's sessions, and a pull adds no inbound route on the public Ingress - cost if wrong: up to one advert interval (5 minutes) of continued access after a reset; and coupling to Plan 2's names, which the executor resolves from Plan 2.
- Ruling: typed address remembered only after a successful sign-in, and forgotten after a successful platform sign-in - why: a typo is never persisted, and the dialog reopens the way the user last signed in - cost if wrong: a user who alternates retypes the address.
- Ruling: new error kinds `ConsoleAddressInvalid`, `NotAConsole`, `ConsoleUnreachable`, `CertificateUntrusted`; console calls use `ConsoleUnreachable` instead of the Platform-address sentence - why: "Check the Platform address in Settings" is wrong advice when the console is the thing down, and an untrusted dev certificate otherwise reads as "unreachable" - cost if wrong: sentence tweaks only.
- Ruling: the live smoke asks the user before each `dev-ca-trust.ps1` run - why: Windows shows its own trust confirmation that only the user can accept - cost if wrong: none; the run waits for the user.
