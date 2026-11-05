# Plexus platform session and in-hive follow-ups (Plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plexus keeps a second desktop session at the platform for an in-hive tenant that also has platform-managed environments (G4), names a retired console and a missing graph in plain sentences (G2 and G1, Plexus side), typechecks every e2e spec (G7), and the whole in-hive follow-up program is proven live on docker-desktop.

**Architecture:** The server adds one discovery bit (`platformEnvironments`). Plexus main keeps ONE encrypted blob with a console part and an optional platform part; `AccountService` owns both lifecycles, tags every target with its `Source`, and the relay connector dials the session of the target's source. `pragmatic-protocol` gains the two transport facts Plexus cannot read today (a refused upgrade's body, a close code). The renderer only ever sees name, status, source and id.

**Tech Stack:** TypeScript (ESM). Server: node >= 22.5, node:test via tsx. pragmatic-protocol: tsx --test, `ws` 8. Plexus: Electron, vitest, Mural `.mu` + TS view models, Playwright (live only).

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-11-06-in-hive-follow-ups-design.md` (sections G1 Plexus, G2 Plexus, G3, G4, G7, Constraints). Plans A (G1/G2 server side) and B run before this plan; their Produces are existing code here.

**Repos and branches:** pragmatic-server `C:\Users\Eugene\Projects\architecture-agent\pragmatic-server` (branch `feat/in-hive-follow-ups-c` from `master`); pragmatic-protocol `C:\Users\Eugene\Projects\architecture-agent\pragmatic-protocol` (branch `feat/relay-transport-detail` from `master`); Plexus `C:\Users\Eugene\Projects\architecture-agent\Plexus` (branch `feat/platform-session-follow-ups` from `main`). Merge each locally at the end; never push.

## Global Constraints

- OOP with no module-level functions or variables; Allman braces; PascalCase public members and interfaces.
- TS literals hoisted to `private static readonly` (.mu labels stay inline); enums over string sets.
- View models extend Observable; tests live in `tests/` subfolders.
- New files ASCII + LF.
- No explicit Width/Height in .mu.
- Secrets and tokens never cross IPC or reach logs (the renderer sees name, status, source, id).
- Layering: plexus-core never imports the app.
- Editor tools only (no shell edits of source); explicit staging (`git add <paths>`, never `-A`/`.`).
- Never stage these Plexus files: `apps/plexus/electron.vite.config.ts`, `apps/plexus/src/renderer/src/modules/typescript/framework-typings.generated.ts`, `packages/plexus-core/src/vite/mural-renderer.ts`, `packages/plexus-core/src/vite/tests/mural-renderer.test.ts`.
- Merge locally, never push.
- Plexus gates: `npm run build:core` (repo root); `npm run typecheck` in `apps/plexus` (includes `typecheck:e2e`); `npx vitest run` in `packages/plexus-core`; `npx vitest run` in `apps/plexus`.
- Server gates: `cd admin/control-plane && npx tsx --test tests/*.test.ts`; `npm run typecheck:tools` (repo root).
- pragmatic-protocol gates: `npm test`; `npm run build` (Plexus consumes its built `dist` through the file link, so rebuild after every protocol change).
- Fixed copy (G1): not found -> `The graph <graph> no longer exists in <environment>. Create it again in the tenant console.`; conflict -> `A package version is already in <graph> with different content.`; other graph codes -> the server's message.
- Fixed wire values (Plan A): graph codes -32040 not found, -32041 exists, -32042 invalid name, -32043 package conflict, -32044 segment, -32045 package missing; 503 body `{ error: 'console-not-registered', message: 'This console is no longer registered with the platform. Ask your administrator.' }` on `/desktop/*` except `/desktop/console`; relay close code 4003; routes `GET`/`POST /tenant-api/environments/NAME/graphs`, `DELETE /tenant-api/environments/NAME/graphs/GRAPH`.

## Review Focus

1. The platform part expires while the console part lives: State reads `Offered` again, targets list the console set only, no platform call is made (test in Task 7).
2. The same environment name on both sides: two distinct ids, only the platform one labelled `(platform)`, and a pick of it routes to the platform session (tests in Tasks 10 and 11).
3. A legacy session blob (flat console fields, no `Platform`, maybe `TenantPlaneUrl`): loads as a console part with no platform part and no offer (test in Task 6).
4. The user skips the platform step: State stays `Offered`, the signed-in panel keeps offering it, a picker-opened dialog closes on Skip (test in Task 12).
5. A platform 401 that arrives after the user signed out of the console (or after a new sign-in): it clears nothing and emits nothing (test in Task 7).

---

### Task 1: G7 - every e2e spec typechecks

**Files:**
- Modify: `apps/plexus/tsconfig.e2e.json` (include becomes `["e2e/**/*.ts"]`; update its comment)
- Modify: `apps/plexus/e2e/arch-go-to-definition.spec.ts:35,60`, `arch-node-context-menu.spec.ts:31`, `connector-save.spec.ts:180`, `diagram-export-preview.spec.ts:37`, `export-svg.spec.ts:39`, `save-ux.spec.ts:169`, `svg-document.spec.ts:42,103,226`, `connector-inline-edit.spec.ts:101,116,201`, `solution-explorer-mutation.spec.ts:33`, `toolbar-collapse.spec.ts:21`

**Interfaces:** Produces: `typecheck:e2e` covers the whole e2e folder (later e2e edits in Task 13 are gated by it).

- [ ] **Step 1: Widen the include** and run `npm run typecheck:e2e` in `apps/plexus`. Expected: FAIL with exactly 15 errors: 13 TS6133 at the lines above (unused `S` x9, `visibleEditors`, `emptyRoutePoint`, `diagram`, `KNOWN_PROJECTS`), TS18047 at svg-document:103, TS2352 at toolbar-collapse:21. Any other error: fix it the same way and record it as a ruling.
- [ ] **Step 2: Fix them.** Delete each unused declaration (for the two unused module-level functions in connector-inline-edit, delete the whole function). svg-document:103: assert `expect(marker, 'marker found').not.toBeNull()` before the use and read through `marker!`. toolbar-collapse:21: cast through `unknown` (`el as unknown as { [k: symbol]: { Name?: string } }`). No behaviour change in any spec.
- [ ] **Step 3: Run** `npm run typecheck` in `apps/plexus`. Expected: PASS.
- [ ] **Step 4: Commit** (Plexus) `test(plexus): every e2e spec typechecks; typecheck:e2e covers the e2e folder` staging the tsconfig and the ten specs.

---

### Task 2: Server - discovery says when an in-hive tenant also has platform environments

**Files:**
- Modify: `admin/control-plane/desktop-tenant-matcher.ts` (`DiscoveredTenant` gains `inHive: boolean`; set at every `Add`: advert tier true, index tier `placement.inHive`, record-domain tier false)
- Modify: `admin/control-plane/desktop-discovery-endpoint.ts` (new seam; answer at 91-98)
- Modify: `admin/control-plane/environment-registry.ts` (new read)
- Modify: `admin/control-plane/server.ts:274` (pass `registry`)
- Test: `admin/control-plane/tests/desktop-discovery-endpoint.test.ts`, `admin/control-plane/tests/environment-registry.test.ts`, `admin/control-plane/tests/desktop-tenant-matcher.test.ts`

**Interfaces:**
- Produces: `export interface IPlatformEnvironmentSource { HasEnvironmentsOf(tenantId: string): boolean }` (in desktop-discovery-endpoint.ts); `EnvironmentRegistry.HasEnvironmentsOf(tenantId: string): boolean` (true when any record's `tenantId` equals it); `DesktopDiscoveryEndpoint` constructor gains an optional 8th parameter `platformEnvironments?: IPlatformEnvironmentSource`. Wire: a tenant entry gains `platformEnvironments: true` only when `inHive` and the source says so; the key is absent otherwise (never `false`).

- [ ] **Step 1: Write the failing tests.** Endpoint: `it('marks an in-hive tenant with platform environments')` -> body `tenants[0].platformEnvironments === true`; `it('leaves the mark out for an in-hive tenant without platform environments')` and `it('never marks a control-plane tenant')` -> `'platformEnvironments' in tenants[0] === false`; `it('leaves the mark out when no source is composed')`. Registry: `HasEnvironmentsOf('t1')` true after a `Put` with `tenantId: 't1'`, false for `'t2'` and for an unbound record. Matcher: an advert match and an in-hive index match report `inHive: true`, a control-plane match `false`.
- [ ] **Step 2: Run** `cd admin/control-plane && npx tsx --test tests/desktop-discovery-endpoint.test.ts tests/environment-registry.test.ts tests/desktop-tenant-matcher.test.ts`. Expected: FAIL (no such member).
- [ ] **Step 3: Implement** the members above; the endpoint maps with a conditional spread; hoist `PlatformEnvironmentsField = 'platformEnvironments'` if named in code.
- [ ] **Step 4: Run** the server gates. Expected: PASS.
- [ ] **Step 5: Commit** (server) `feat(control-plane): discovery marks an in-hive tenant that also has platform environments`.

---

### Task 3: pragmatic-protocol - a refused upgrade keeps its body, a closed socket keeps its code

Ruling: Plexus cannot read either fact today (`ws` is not resolvable from Plexus, and the protocol drops both), and the spec's G2 triggers need them; this is the smallest change that exposes them.

**Files:**
- Modify: `src/client/socket-dialer.ts` (`WsSocketDialer.Dial`)
- Modify: `src/transport/transport-signals.ts` (new error class)
- Modify: `src/transport/message-socket.ts`, `src/transport/ws-message-socket.ts`, `src/transport/multiplex-message-socket.ts`, `src/client/pragmatic-client.ts`, `src/index.ts`, `src/browser.ts` (export)
- Test: `src/client/tests/pragmatic-client.test.ts`, `src/transport/tests/ws-message-socket.test.ts`

**Interfaces:**
- Produces: `export class UpgradeRefusedError extends Error { constructor(public readonly Status: number, public readonly Body: string) }` whose message stays `Unexpected server response: <status>` (Plexus `RelayRefusal.StatusOf` keeps parsing it); `Body` is at most 4096 bytes of the answer, UTF-8. `IMessageSocket` gains optional `CloseCode?(): number | undefined`; `WsMessageSocket.CloseCode()` returns the code of ws's `close` event (recorded by a listener attached in its constructor, so it is set before any `OnClose` handler runs); `MultiplexMessageSocket.CloseCode()` delegates; `PragmaticClient.CloseCode(): number | undefined` returns the current socket's.

- [ ] **Step 1: Write the failing tests** against a real local `ws` server: `test('a refused upgrade rejects with its status and body')` -> server answers 503 with `{"error":"console-not-registered"}`; `ConnectAsync` rejects with `UpgradeRefusedError`, `Status === 503`, `JSON.parse(Body).error === 'console-not-registered'`, `message === 'Unexpected server response: 503'`. `test('a server close keeps its code')` -> server closes with 4003 while a request is pending; the request rejects and `client.CloseCode() === 4003`. `test('an open client has no close code')` -> `undefined`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `Dial`, listen to `unexpected-response` (`(req, res)`): collect up to 4096 bytes, then `req.destroy()` and reject with `UpgradeRefusedError(res.statusCode, text)`; with that listener ws no longer emits the generic error, so the listener is the only reject path for non-101 answers.
- [ ] **Step 4: Run** `npm test` then `npm run build`. Expected: PASS, `dist` rebuilt.
- [ ] **Step 5: Commit** (pragmatic-protocol) `feat(protocol): a refused upgrade keeps its status and body; a client reports its close code`.

---

### Task 4: Plexus shared contract - target sources, ids and the two new account kinds

**Files:**
- Modify: `packages/plexus-core/src/shared/account-api.ts`
- Modify: `apps/plexus/src/main/account/desktop-api-client.ts` (`Targets` tags its answer)
- Modify: `apps/plexus/src/main/account/account-service.ts:161` (passes `TargetSource.Console`)
- Modify: every test fake that builds an `EnvironmentTarget` literal (`packages/plexus-core/src/renderer/modules/solution-explorer/services/tests/fake-target-sources.ts`, `apps/plexus/src/renderer/src/modules/account/tests/fake-account-service.ts`, and any other `grep -rn "Status: TargetStatus" --include=*.test.ts` hit)
- Test: `packages/plexus-core/src/shared/tests/account-api.test.ts` (create if absent), `apps/plexus/src/main/account/tests/desktop-api-client.test.ts`

**Interfaces:**
- Produces (account-api.ts):
  - `export enum TargetSource { Console = 'console', Platform = 'platform' }`
  - `export type EnvironmentTarget = { Id: string; Name: string; Status: TargetStatus; Source: TargetSource }`
  - `export type TargetRef = { Name: string; Source: TargetSource }`
  - `export type TargetChoice = { Environment: string; Source?: TargetSource; GraphName?: string }` (absent Source reads as Console: choices saved before this plan)
  - `export class TargetIdentity` with `static Id(source: TargetSource, name: string): string` (`<source>:<name>`), `static RefOf(choice: TargetChoice): TargetRef`, `static IsSource(value: unknown): value is TargetSource`
  - `AccountErrorKind.ConsoleRetired = 'console-retired'` with the fixed sentence `Your organization's console is no longer registered with the platform. Ask your administrator.`
  - `AccountErrorKind.PlatformSignedOut = 'platform-signed-out'` with `You're signed out of your platform environments. Sign in for them again from your account.`
  - `export enum PlatformAccess { Offered = 'offered', SignedIn = 'signed-in' }`; `AccountState` gains `Platform?: PlatformAccess`
- Produces (client): `DesktopApiClient.Targets(at: SessionAddress, source: TargetSource): Promise<AccountTargets>` (`SessionAddress` is Task 6's; until then type the parameter as `Pick<DesktopSession, 'ConsoleUrl' | 'Token'>`), each target `{ Id: TargetIdentity.Id(source, name), Name, Status, Source: source }`.

- [ ] **Step 1: Write the failing tests:** `TargetIdentity.Id(TargetSource.Platform, 'dev') === 'platform:dev'` and differs from the Console id; `RefOf({ Environment: 'dev' })` -> `{ Name: 'dev', Source: Console }`; `RefOf({ Environment: 'dev', Source: Platform })` keeps Platform; `IsSource('platform')` true, `IsSource('x')` false; `new AccountError(AccountErrorKind.ConsoleRetired).message` equals the sentence above (same for PlatformSignedOut). Client: `Targets(session, TargetSource.Platform)` returns `{ Id: 'platform:dev', Source: 'platform', ... }`.
- [ ] **Step 2: Run** `npx vitest run` in both packages for those files. Expected: FAIL.
- [ ] **Step 3: Implement** the contract and the tagging; update the fakes so every existing test still compiles.
- [ ] **Step 4: Run** all Plexus gates. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): targets carry their source and a cross-source id; console-retired and platform-signed-out kinds`.

---

### Task 5: DesktopApiClient - a retired console and the platform-environments bit

**Files:**
- Create: `apps/plexus/src/main/account/console-retirement.ts`
- Modify: `apps/plexus/src/main/account/desktop-api-client.ts` (`Send`, `Tenant`, `DiscoveredConsole`)
- Test: `apps/plexus/src/main/account/tests/desktop-api-client.test.ts`, `apps/plexus/src/main/account/tests/console-retirement.test.ts`

**Interfaces:**
- Produces: `export class ConsoleRetirement { static readonly ErrorCode = 'console-not-registered'; static readonly CloseCode = 4003; static readonly Status = 503; static IsBody(text: string): boolean }` (true only for a JSON object whose `error` equals ErrorCode; never throws). `DiscoveredConsole` gains `PlatformEnvironments: boolean` (true only when the raw entry has `platformEnvironments === true`).
- Behaviour: every request whose path starts with `/desktop/` that answers 503 with a retired body throws `AccountError(ConsoleRetired)`; a 503 with any other body keeps today's kind (Unavailable). Discovery (`/api/desktop/discover`) is never read this way.

- [ ] **Step 1: Write the failing tests:** `IsBody('{"error":"console-not-registered","message":"x"}')` true; `IsBody('{"error":"unavailable"}')`, `IsBody('<html>')`, `IsBody('[]')` false. Client, one test per call: `Begin`, `Complete`, `Targets`, `SignOut` and `Console` against a fake fetch answering 503 + retired body reject with `Kind === ConsoleRetired`; 503 + `{"error":"unavailable"}` on Targets rejects `Unavailable`; `Discover` with `platformEnvironments: true` -> `PlatformEnvironments === true`, with the key absent or `"yes"` -> false.
- [ ] **Step 2: Run** `npx vitest run src/main/account/tests/desktop-api-client.test.ts src/main/account/tests/console-retirement.test.ts` in `apps/plexus`. Expected: FAIL.
- [ ] **Step 3: Implement.** The check sits in `Send` after the fetch (it reads the body only for a 503 on a `/desktop/` path; hoist `DesktopPathPrefix = '/desktop/'`).
- [ ] **Step 4: Run** the app vitest and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): a refused console reads as retired on every desktop call; discovery's platform-environments bit`.

---

### Task 6: DesktopSessionStore - the optional platform part

**Files:**
- Modify: `apps/plexus/src/main/account/desktop-session-store.ts`
- Modify: callers of `Load`/`Save` in `account-service.ts` (mechanically: `(await store.Load()).Console`, `Save({ Console: s })`) so the app compiles; Task 7 adds the behaviour
- Test: `apps/plexus/src/main/account/tests/desktop-session-store.test.ts`

**Interfaces:**
- Produces:
  - `export type SessionAddress = { ConsoleUrl: string; Token: string }`
  - `export type DesktopSession = SessionAddress & { Email: string; TenantId: string; TenantName: string; ExpiresAt: string; PlatformUrl?: string }` (`PlatformUrl` = the tenant plane to offer the platform step at)
  - `export type PlatformSession = SessionAddress & { ExpiresAt: string; TenantId: string; Email: string }`
  - `export type StoredAccount = { Console?: DesktopSession; Platform?: PlatformSession }`
  - `Load(): Promise<StoredAccount>`; `Save(account: StoredAccount): Promise<void>` (both parts absent removes the file); `Clear(): Promise<void>`; `CanStore()` unchanged
- Blob format (one encrypted blob, temp + rename as today): the console fields flat at the top level (so an older Plexus still reads the console part), `PlatformUrl` beside them when set, and `Platform: { ConsoleUrl, Token, ExpiresAt, TenantId, Email }`. A platform part missing any field is dropped; an incomplete console part is dropped without dropping a complete platform part.

- [ ] **Step 1: Write the failing tests:** round-trip of both parts; round-trip of a platform part with no console part; `Save({})` removes the file; a legacy blob `{ ConsoleUrl, Token, Email, TenantId, TenantName, ExpiresAt }` loads as `{ Console: {...}, Platform: undefined }` with `PlatformUrl` undefined (Review Focus 3); a legacy `TenantPlaneUrl` blob still migrates; a `Platform` with an empty `Token` loads as no platform part; nothing but the listed fields is written (decrypt the reverse-encryptor blob and compare keys).
- [ ] **Step 2: Run** `npx vitest run src/main/account/tests/desktop-session-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the shapes; reuse `TextValue.Filled` for every field check.
- [ ] **Step 4: Run** the app vitest and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): the stored desktop session gains an optional platform part`.

---

### Task 7: AccountService - the platform session lifecycle

**Files:**
- Modify: `apps/plexus/src/main/account/account-service.ts`
- Test: `apps/plexus/src/main/account/tests/account-service.test.ts`

**Interfaces:**
- Consumes: Task 5 `DiscoveredConsole.PlatformEnvironments`, `Discovery.TenantPlaneUrl`; Task 6 store types; Task 4 `TargetSource`, `PlatformAccess`, `AccountErrorKind.PlatformSignedOut`.
- Produces:
  - constructor gains a last optional parameter `now: () => number = Date.now`
  - `State(): Promise<AccountState>`: no console part -> signed out (no `Platform`); else `Platform` is `SignedIn` when a live platform part exists, `Offered` when the console part has `PlatformUrl` and no live part, absent otherwise
  - `SessionFor(source: TargetSource): Promise<SessionAddress | undefined>` (Platform answers only beside a console part, and only a live part)
  - `SignInAtPlatform(): Promise<AccountState>`: no console part -> `SignedOut`; no `PlatformUrl` -> `Unavailable`; runs the same attempt (receiver, PKCE, browser, Complete) at `PlatformUrl` for the console part's `TenantId`; a Complete whose `TenantId` differs is ended at once and fails `SignInFailed`; stores `{ Console, Platform }`, ends a replaced platform part, emits Changed
  - `HandleSignedOut(token: string): Promise<void>`: matches the console token -> drops the console part only (the platform part stays dormant); matches the platform token -> drops the platform part only; matches neither -> no write, no emit
  - `Targets()`: console targets (Source Console) plus, when a live platform part exists, platform targets (Source Platform), concatenated per action. A console failure fails the call as today. A platform `SignedOut` -> `HandleSignedOut(platformToken)` and the console set is returned; any other platform failure returns the console set
  - `SignOut()`: ends the console part and the platform part (dormant too) at their own addresses, then clears
  - Discovery sign-in (`SignIn`) sets `PlatformUrl = UrlBase.Of(TenantPlaneUrl)` when the found tenant has `PlatformEnvironments` and its sign-in address is not the tenant plane itself; a typed-console sign-in never sets it
  - Committing a console session keeps the stored platform part when its `TenantId` and `Email` match the new console part and it is live; otherwise ends it and drops it
  - Live = all fields present and `Date.parse(ExpiresAt) > now()`; an expired part is treated as absent and dropped at the next write
- Refactor note: split today's `SignInAt` into `Authorize(attempt, address, tenantId, email): Promise<CompletedSignIn>` and the two commit paths, so both sign-ins share `RunAttempt`'s cancel handling.

- [ ] **Step 1: Write the failing tests** (fake client, fake store, fake clock), one `it` each:
  - discovery sign-in for a tenant with `PlatformEnvironments` -> State `Platform === Offered`; without it, or typed console -> `Platform` undefined
  - `SignInAtPlatform` stores the part at the tenant plane address (assert the fake client's Begin address) and State becomes `SignedIn`; a mismatched TenantId ends that session (fake SignOut called with its token) and rejects `SignInFailed`; signed out -> `SignedOut`
  - Targets merges both sets with their sources; a platform 401 clears only the platform part (console part still loaded, State `Offered`, console set returned); a platform `Unreachable` returns the console set and keeps the part
  - Review Focus 1: with the clock past the platform `ExpiresAt`, State is `Offered`, Targets makes no platform call and returns the console set
  - a console 401 (via `HandleSignedOut(consoleToken)`) keeps the platform part in the store but State is signed out; a following console sign-in for the same tenant and email reattaches it (State `SignedIn` without a second platform sign-in); for another tenant the old part is ended
  - SignOut ends both tokens at their own addresses and leaves `{}`
  - Review Focus 5: after SignOut (and after a sign-out followed by a new sign-in), `HandleSignedOut(oldPlatformToken)` writes nothing and emits nothing
  - an Owner reset on the console (simulated as a console 401) leaves the platform part untouched, and a platform 401 leaves the console part untouched
- [ ] **Step 2: Run** `npx vitest run src/main/account/tests/account-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block; every read-compare-write stays inside `Serialised`.
- [ ] **Step 4: Run** the app vitest and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): a second desktop session at the platform for an in-hive tenant`.

---

### Task 8: Account IPC and renderer account service - SignInAtPlatform

**Files:**
- Modify: `packages/plexus-core/src/shared/account-api.ts` (`AccountChannel.SignInAtPlatform = 'account:sign-in-at-platform'`; `IAccountBridge.SignInAtPlatform(): Promise<AccountReply<AccountState>>`; `IAccountApi.SignInAtPlatform(): Promise<AccountState>`)
- Modify: `packages/plexus-core/src/renderer/modules/account/account-service.ts` (`IAccountService.SignInAtPlatform(): Promise<void>`)
- Modify: `apps/plexus/src/main/account/account-ipc.ts`, `apps/plexus/src/preload/index.ts`, `apps/plexus/src/renderer/src/services/account/ipc-account-service.ts`, every `IAccountService` fake
- Test: `apps/plexus/src/main/account/tests/account-ipc.test.ts`, `apps/plexus/src/renderer/src/services/account/tests/ipc-account-service.test.ts`

**Interfaces:** Consumes Task 7 `AccountService.SignInAtPlatform`. Produces the renderer `IAccountService.SignInAtPlatform()` Task 12 calls; it applies the returned state like `SignIn` does.

- [ ] **Step 1: Write the failing tests:** the IPC handler answers `{ Ok: true, Value: state }` and wraps an `AccountError(PlatformSignedOut)` as `{ Ok: false, Error: { Kind: 'platform-signed-out' } }`; the renderer service updates `State.Platform` and raises Changed once.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** the channel end to end (no arguments cross).
- [ ] **Step 4: Run** all Plexus gates. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): account IPC for the platform sign-in step`.

---

### Task 9: RelayConnector - session by source, graph sentences, retired console

**Files:**
- Modify: `apps/plexus/src/main/account/relay-connector.ts` (`RelayClient` 4, `IRelaySessionSource` 8-13, `RelayRefusal` 37, `Connect` 114, `Refusal` 167, `Call` 200-212)
- Modify: `apps/plexus/src/main/graph-contribute/graph-contribute-service.ts`, `apps/plexus/src/main/tenant-publish/tenant-deploy-service.ts` (new `Call` shape; until Task 10 they still take an environment name and connect with `{ Name: environment, Source: TargetSource.Console }`), `apps/plexus/src/main/index.ts:205` only if a type requires it
- Test: `apps/plexus/src/main/account/tests/relay-connector.test.ts`

**Interfaces:**
- Consumes: Task 3 `UpgradeRefusedError`, `PragmaticClient.CloseCode()`; Task 5 `ConsoleRetirement`; Task 7 `SessionFor`, `HandleSignedOut`.
- Produces:
  - `RelayClient = Pick<PragmaticClient, 'ListGraphs' | 'ContributeGraph' | 'DeployApplication' | 'DisposeAsync' | 'CloseCode'>`
  - `IRelaySessionSource { SessionFor(source: TargetSource): Promise<SessionAddress | undefined>; HandleSignedOut(token: string): Promise<void> }`
  - `IRelayConnector.Connect(target: TargetRef, kind: TargetKind): Promise<RelayClient>`: no session -> `SignedOut` for Console, `PlatformSignedOut` for Platform; a 401 clears that token and answers the same per-source kind; a 503 whose `RelayRefusal.BodyOf(e)` passes `ConsoleRetirement.IsBody` -> `AccountError(ConsoleRetired)`; any other 503 -> the unreachable sentence
  - `RelayRefusal.BodyOf(error: unknown): string | undefined` (the `Body` of an `UpgradeRefusedError`, else undefined)
  - `export type RelayCall = { Environment: string; Graph?: string; Client: Pick<RelayClient, 'CloseCode'> }`; `RelayConnector.Call<T>(call: RelayCall, work: () => Promise<T>): Promise<T>`
  - `enum GraphErrorCode { NotFound = -32040, Exists = -32041, NameInvalid = -32042, PackageConflict = -32043, PackageSegment = -32044, PackageMissing = -32045 }` in relay-connector.ts. If Plan A put these codes in pragmatic-protocol (`grep -rn "32040" ../pragmatic-protocol/src`), import its constants instead and declare none here.
- `Call` order: a drop with `Client.CloseCode() === ConsoleRetirement.CloseCode` -> `AccountError(ConsoleRetired)`; any other drop -> unreachable sentence; a `ResponseError` with `NotFound` and a `Graph` -> the G1 not-found sentence; `PackageConflict` with a `Graph` -> the G1 conflict sentence; every other server answer (the other four codes, and NotFound/Conflict without a graph) -> rethrown with the server's message; account errors as is; anything else -> the not-handled sentence.

- [ ] **Step 1: Write the failing tests:** Connect with `{ Name: 'dev', Source: Platform }` dials with the platform token at the platform address (fake `SessionFor`); no platform part -> `PlatformSignedOut`; a platform 401 calls `HandleSignedOut(platformToken)` and rejects `PlatformSignedOut`; dial rejecting `new UpgradeRefusedError(503, '{"error":"console-not-registered"}')` -> `ConsoleRetired`; 503 with `'{"error":"x"}'` -> `The environment dev could not be reached.`. Call: `ResponseError(-32040, 'Graph not found: g')` with Graph `g`, Environment `dev` -> message `The graph g no longer exists in dev. Create it again in the tenant console.`; `-32043` -> `A package version is already in g with different content.`; `-32041`, `-32042`, `-32044`, `-32045` -> the server's message; a `ConnectionLostError` with `CloseCode()` 4003 -> `ConsoleRetired`, with `CloseCode()` 1006 -> unreachable sentence.
- [ ] **Step 2: Run** `npx vitest run src/main/account/tests/relay-connector.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The services pass `{ Environment, Graph: graphName, Client: client }` (contribute), `{ Environment, Client: client }` (list, deploy).
- [ ] **Step 4: Run** the app vitest and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): relay dials by target source; plain sentences for graph errors and a retired console`.

---

### Task 10: Contribute, publish and graph list route by source

**Files:**
- Modify: `packages/plexus-core/src/shared/graph-contribute-api.ts` (if it declares the API shapes), `packages/plexus-core/src/renderer/modules/graph-contribute/graph-contributor.ts`, `packages/plexus-core/src/renderer/modules/tenant-publish/tenant-publisher.ts`
- Modify: `packages/plexus-core/src/renderer/modules/solution-explorer/services/target-dialog.ts` (`EnvironmentChoice.Ref`), `contribute-target-dialog.ts` (`ListGraphs(environment.Ref)`; `ChoiceFor` adds `Source`), `publish-target-dialog.ts` (`ChoiceFor` adds `Source`), `contribute-to-graph-contributor.ts`, `publish-tenant-contributor.ts` (`TargetIdentity.RefOf(choice)`; titles keep the name)
- Modify: `apps/plexus/src/shared/graph-contribute-api.ts`, `apps/plexus/src/shared/tenant-publish-api.ts`, `apps/plexus/src/preload/index.ts`, `apps/plexus/src/main/graph-contribute/graph-contribute-ipc.ts`, `graph-contribute-service.ts`, `apps/plexus/src/main/tenant-publish/tenant-publish-ipc.ts`, `tenant-deploy-service.ts`, `apps/plexus/src/renderer/src/services/graph-contribute/ipc-graph-contributor.ts`, `apps/plexus/src/renderer/src/services/tenant-publish/ipc-tenant-publisher.ts`
- Test: the existing tests beside each file (`graph-contribute-ipc.test.ts`, `graph-contribute-service.test.ts`, `tenant-publish-ipc.test.ts`, `tenant-deploy-service.test.ts`, `ipc-graph-contributor.test.ts`, `contribute-target-dialog.test.ts`, `publish-target-dialog.test.ts`, `contribute-to-graph-contributor.test.ts`, `publish-tenant-contributor.test.ts`)

**Interfaces:**
- Consumes: Task 4 `TargetRef`, `TargetIdentity`; Task 9 `Connect(target, kind)`.
- Produces (every layer, same order): `ListGraphs(target: TargetRef)`, `Contribute(target: TargetRef, graphName, solutionId, packages)`, `Publish(target: TargetRef, outputDir)` / `Deploy(target: TargetRef, outputDir)`; `EnvironmentChoice.Ref: TargetRef`, `EnvironmentChoice.Id: string`. The IPC handlers validate `target` as an object with a non-blank string `Name` and `TargetIdentity.IsSource(Source)`, else `BadArguments`. Only `{ Name, Source }` crosses IPC.

- [ ] **Step 1: Write the failing tests:** main contribute service with `{ Name: 'dev', Source: Platform }` calls `Connect` with that ref and `TargetKind.Contribute`; IPC refuses `{ Name: 'dev', Source: 'x' }` and a bare string with the BadArguments sentence; the contribute picker confirming a platform environment resolves `{ Environment: 'dev', Source: 'platform', GraphName }` and lists graphs with the platform ref; the contributor passes `RefOf(choice)` to `Contribute`; a choice with no Source routes as Console.
- [ ] **Step 2: Run** the listed tests in both packages. Expected: FAIL.
- [ ] **Step 3: Implement** the signature change through every layer listed.
- [ ] **Step 4: Run** all Plexus gates. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): contribute, publish and graph listing go to the session of the target's source`.

---

### Task 11: Picker labels, remembered choices by source, and the NoGraphs sentence

**Files:**
- Modify: `packages/plexus-core/src/renderer/modules/solution-explorer/services/target-dialog.ts` (`EnvironmentChoice` label, `Load` selection)
- Modify: `apps/plexus/src/main/account/account-service.ts` (`ValidChoice`, `CopyChoice` keep a valid `Source`), `apps/plexus/src/main/account/account-ipc.ts` (`Choice` accepts an optional valid `Source`)
- Check: `packages/plexus-core/src/renderer/modules/solution-explorer/services/contribute-target-dialog.ts:24` `NoGraphs` (today `This environment has no graphs yet. Create one in the tenant console.`, which already points at the tenant console: keep it, and pin it with a test)
- Test: `contribute-target-dialog.test.ts`, `publish-target-dialog.test.ts`, `apps/plexus/src/main/account/tests/account-service.test.ts`, `account-ipc.test.ts`

**Interfaces:**
- Produces: `EnvironmentChoice` constructor `(target: EnvironmentTarget, showsSource = false)`; `Label` = name, then ` (platform)` when `showsSource`, then the status suffix; `static EnvironmentChoice.ListOf(targets: readonly EnvironmentTarget[]): EnvironmentChoice[]` sets `showsSource` for a Platform target whose `Name` also occurs on a Console target in the same list. The remembered choice is matched by `EnvironmentChoice.Id === TargetIdentity.Id(last.Source ?? Console, last.Environment)`.

- [ ] **Step 1: Write the failing tests:** Review Focus 2: targets `[console dev, platform dev, platform qa]` label `dev`, `dev (platform)`, `qa`, with distinct ids; a stopped colliding platform target reads `dev (platform) (stopped)`; a remembered `{ Environment: 'dev', Source: 'platform' }` pre-selects the platform one, a remembered `{ Environment: 'dev' }` the console one; RememberChoice + LastChoice round-trips `Source`; IPC drops an invalid Source as BadArguments; the no-graphs message equals `This environment has no graphs yet. Create one in the tenant console.`.
- [ ] **Step 2: Run** the listed tests. Expected: FAIL (the NoGraphs pin passes already).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all Plexus gates. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): platform targets labelled on a name collision; remembered choices keep their source`.

---

### Task 12: Account dialog - the platform step

**Files:**
- Modify: `apps/plexus/src/renderer/src/modules/account/account-dialog-step.ts` (`PlatformOffer = 'platform-offer'`)
- Modify: `apps/plexus/src/renderer/src/modules/account/account-dialog.ts`, `account.resources.mu` (its `.mu.js` is untracked build output from `npm run compile:mu`; regenerate it, never stage it)
- Test: `apps/plexus/src/renderer/src/modules/account/tests/account-dialog.test.ts`

**Interfaces:**
- Consumes: Task 8 `IAccountService.SignInAtPlatform()`; Task 4 `PlatformAccess`.
- Produces on `AccountDialog`: `IsPlatformOfferStep`, `ShowsPlatformOffer` (SignedIn step and `State.Platform === Offered`), `ShowsPlatformSignedIn` (`State.Platform === SignedIn`), `PlatformSignInCommand`, `SkipPlatformCommand` (each raises PropertyChanged through the existing enum).
- Flow: a successful discovery sign-in whose State is `Offered` goes to `PlatformOffer` instead of `SignedIn`, and does NOT close even when `closeOnSignIn`. PlatformSignIn -> `Waiting` -> `SignInAtPlatform()` -> `SignedIn` (closes when `closeOnSignIn`); a failure shows its sentence on the `SignedIn` step. Cancel while waiting on the platform returns to `SignedIn`, not `Email`. Skip -> `SignedIn` (closes when `closeOnSignIn`). `OnAccountChanged` leaves `PlatformOffer` only when signed out (-> Email) or when Platform is no longer Offered (-> SignedIn). The SignedIn panel shows a Text button `Also sign in for your platform environments` while `ShowsPlatformOffer`, and the line `Also signed in for your platform environments.` while `ShowsPlatformSignedIn`.
- .mu (labels inline, no Width/Height): a `PlatformOffer` panel with `Some of your organization's environments are managed by the platform. Sign in once more to use them in Plexus.` and buttons `Skip` (Text) and `Also sign in for your platform environments` (Filled).

- [ ] **Step 1: Write the failing tests:** offered sign-in lands on PlatformOffer (also with `closeOnSignIn`: `close` not called); PlatformSignInCommand calls `SignInAtPlatform` once and ends on SignedIn with `ShowsPlatformSignedIn`; a failing platform step shows `AccountError(PlatformSignedOut).message` and stays signed in; Cancel while waiting on the platform returns to SignedIn and calls `CancelSignIn`; Review Focus 4: Skip lands on SignedIn with `ShowsPlatformOffer` true and the fake's State still `Offered`; with `closeOnSignIn`, Skip calls `close`; a non-offered sign-in behaves exactly as before.
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/modules/account/tests/account-dialog.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the view-model members and the .mu panel.
- [ ] **Step 4: Run** all Plexus gates. Expected: PASS.
- [ ] **Step 5: Commit** (Plexus) `feat(plexus): account dialog offers the platform sign-in step`.

---

### Task 13: e2e - the platform step, console graphs and a retired console in the live spec

**Files:**
- Modify: `apps/plexus/e2e/scripted-desktop-sign-in.ts` (`AwaitSignedIn` also returns on `SignedIn && Step === PlatformOffer`; new `SignInAtPlatform`; `Targets` result rows gain `Source` and `Id`; `AccountState` gains `Platform`)
- Modify: `apps/plexus/e2e/in-hive-console-sign-in.spec.ts`

**Interfaces:**
- Produces: `ScriptedDesktopSignIn.SignInAtPlatform(app: ElectronApplication, win: Page): Promise<void>` (intercepts the opener, starts `account.SignInAtPlatform()` in the renderer without awaiting it, runs the same IdP login on the captured authorize URL, resolves when `State.Platform === 'signed-in'`, restores the opener; the password stays inside the helper). New optional env vars (each step skips with an annotation when its var is unset): `PLEXUS_IHC_GRAPH` (a graph created on `PLEXUS_IHC_ENVIRONMENT` through the console's tenant-api), `PLEXUS_IHC_PLATFORM_ENVIRONMENT` (a control-plane environment of the same tenant), `PLEXUS_IHC_EXPECT_RETIRED=1` (selects the retired-console test).
- Spec steps added to the existing test, after the targets step: (G1) contribute to `PLEXUS_IHC_GRAPH` succeeds; contribute to `<PLEXUS_IHC_GRAPH>-missing` fails with exactly `The graph <graph>-missing no longer exists in <environment>. Create it again in the tenant console.`; (G4) the account State is `Platform: 'offered'`, `SignInAtPlatform` completes, Targets lists `PLEXUS_IHC_ENVIRONMENT` with Source `console` and `PLEXUS_IHC_PLATFORM_ENVIRONMENT` with Source `platform`, and graph listing on the platform target answers (any list). The sign-out step additionally asserts `Platform` is absent. A second test, run only with `PLEXUS_IHC_EXPECT_RETIRED=1` (and then the first test skips): discovery sign-in rejects with kind `console-retired` before any browser opens.

- [ ] **Step 1: Edit the helper and the spec** (constants hoisted into the existing constant classes, Allman braces).
- [ ] **Step 2: Run** `npm run typecheck` in `apps/plexus` and `npx playwright test e2e/in-hive-console-sign-in.spec.ts` without the env vars. Expected: PASS; the spec is skipped.
- [ ] **Step 3: Commit** (Plexus) `test(plexus): live spec covers console graphs, the platform step and a retired console`.

---

### Task 14: Server - console relay hold smoke (G3 evidence)

Ruling: an idle open relay is the same condition for nginx's read/send timers as a call awaiting its answer (both measure the gap between socket reads/writes), so the check holds the relay connection idle for 150 s between two calls.

**Files:**
- Create: `admin/control-plane/console-relay-hold-smoke.ts` (gated, operator-run, `-smoke.ts` name so no test glob or build picks it up)

**Interfaces:**
- Consumes: the console's `/desktop/sign-in/begin`, `/desktop/sign-in/complete`, `/desktop/relay`, `/desktop/sign-out`; `IdpLoginPage` (`idp-login-page.ts`); Playwright Chromium; `PragmaticClient.ConnectAsync`.
- Produces: `npx tsx admin/control-plane/console-relay-hold-smoke.ts --console <url> --environment <name> --owner-email-file <path> --password-file <path> [--hold-seconds 150]`, run with `NODE_EXTRA_CA_CERTS=<devCaFile>`. Steps, one PASS/FAIL line each: Begin with a loopback redirect (`node:http` on 127.0.0.1, port 0) and a PKCE challenge; Chromium (ignoreHTTPSErrors, as `in-hive-console-smoke.ts` `DriveConsole`) opens the authorize URL, `IdpLoginPage.Submit`, the loopback captures `code` and `state`; Complete -> token; relay connect; `ListGraphs` -> list; idle `HoldSeconds`; `ListGraphs` again -> list and `CloseCode()` undefined; sign-out (always). Exit 1 on any FAIL. Never prints a token, password, email or code.

- [ ] **Step 1: Write the script** in the style of `desktop-sign-in-smoke.ts` (one class, constants hoisted, `IsEntryPoint`/`Main`).
- [ ] **Step 2: Run** `npm run typecheck:tools`. Expected: PASS. Run it with no arguments. Expected: a usage line and exit 2.
- [ ] **Step 3: Commit** (server) `test(control-plane): gated smoke holding a console relay open through its Ingress`.

---

### Task 15: Final cross-repo live check on docker-desktop, then teardown

Operator-run; never part of the gates. Stop and ask the user whenever a prerequisite cannot be met. Report each check's outcome; secrets never printed.

**Files:** none unless a check fails: a product bug is fixed in the owning task's files with a regression test, the gates re-run, and the check repeated. Conditional (only if G3 fails): `admin/control-plane/k8s-manifest-builder.ts` (`TenantConsoleIngressObjects`, 1259) + `admin/control-plane/tests/k8s-manifest-builder.test.ts`.

- [ ] **Step 1: Prerequisites.** Plans A, B and C merged locally in the server, pragmatic-protocol (dist built) and Plexus; `npm run build` in `apps/plexus`. Rebuild `pragmatic-server:dev` per `docker/Dockerfile`'s header and load it into the node: `npx tsx -e "import('./admin/control-plane/kind-image-loader.ts').then(m => new m.KindImageLoader().Load('pragmatic-server:dev'))"` (a plain `docker build` does not reach the node). Restart the control plane from this checkout as Plan 1 Task 15 describes, with a tenant-plane URL set.
- [ ] **Step 2: Install the console** on `default-pragmatic-hive` with development TLS and base domain `localtest.me` through the operator routes (`PUT /api/hives/default-pragmatic-hive/console`, `POST .../console-install`, poll the `GET` status to `deployed`, read `devCaFile`). Fetch the Owner password into a temp file via `POST .../console/owner-password` (written by a script, never echoed; this is itself an Owner reset, so fetch it before any desktop sign-in). Ask the user first, then run `powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -CaFile <devCaFile> -Install` (Windows shows a trust dialog only the user can accept). Default browser must be Edge or Chrome.
- [ ] **Step 3: Prepare the environments.** On the console (Owner signed in to `https://console-pragmatic-default.localtest.me` in a browser): create Development environment `smoke-ihd` and wait for `running`; create graph `ihc-live-graph` with `POST /tenant-api/environments/smoke-ihd/graphs` (201) and see it in `GET` (G1). Through the operator API create a control-plane environment `smoke-plat` on `default-pragmatic-hive` (`POST /api/environments` with that `hiveId`), wait for `running`. Poll `POST /api/desktop/discover` for the Owner email (at most 10 per minute) until the `pragmatic-default` entry has `consoleUrl` equal to the console and `platformEnvironments: true`.
- [ ] **Step 4: Run the Plexus spec** from `apps/plexus`: `npx playwright test e2e/in-hive-console-sign-in.spec.ts` with `PLEXUS_E2E_PLATFORM_ADDRESS=http://localhost:7000`, `PLEXUS_E2E_OWNER_EMAIL`, `PLEXUS_E2E_OWNER_PASSWORD_FILE`, `PLEXUS_IHC_CONSOLE_URL=https://console-pragmatic-default.localtest.me`, `PLEXUS_IHC_ENVIRONMENT=smoke-ihd`, `PLEXUS_IHC_GRAPH=ihc-live-graph`, `PLEXUS_IHC_PLATFORM_ENVIRONMENT=smoke-plat`, `PLEXUS_E2E_IDP_LOGIN=browser`. Expected: every step passes (G1 contribute + not-found sentence; G4 both sets after the platform step). If the platform step's Begin or Complete fails for the in-hive tenant, stop and ask the user.
- [ ] **Step 5: G3.** `NODE_EXTRA_CA_CERTS=<devCaFile> npx tsx admin/control-plane/console-relay-hold-smoke.ts --console https://console-pragmatic-default.localtest.me --environment smoke-ihd --owner-email-file <file> --password-file <file>`. Expected: all PASS; record "G3 closed: relay held 150 s through the console Ingress, no manifest change". If the second call fails with a drop: fallback - add `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` and `nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"` to the console Ingress only (in `TenantConsoleIngressObjects`, merged into the annotations `TerminatingIngress` returns, for every TLS source including none; the environment-server Ingress unchanged), with tests asserting both annotations on the console Ingress and their absence on the environment-server Ingress; run the server gates, commit `fix(control-plane): console Ingress keeps long relay calls open`, rebuild + reload the image, reinstall the console, re-run this step.
- [ ] **Step 6: G2.** Before editing, confirm by reading `TenantConsoleInstaller` and the hive reconciliation that nothing uninstalls a console whose hive setting is absent while the control plane runs; if something does, stop and ask the user. Stop the control plane, back up `<dataRoot>/hives.json`, remove the `console` field of `default-pragmatic-hive` with an editor, restart. Wait for two console timer ticks (`ConsoleAdvertSender.IntervalMs` = 5 minutes each, so up to ~11 minutes; `kubectl --context docker-desktop -n pragmatic-system logs deploy/pragmatic-tenant-admin-pragmatic-default` shows the refusals). Check `GET https://console-pragmatic-default.localtest.me/desktop/targets` answers 503 with `error: 'console-not-registered'` and `/desktop/console` still answers 200. Run the spec with the Step 4 variables plus `PLEXUS_IHC_EXPECT_RETIRED=1`. Expected: the retired test passes (Plexus shows ConsoleRetired). Stop the control plane, restore the backup, restart; after the next tick (up to 5 minutes) `/desktop/targets` without a bearer answers 401 again, and the Step 4 run passes again (restored).
- [ ] **Step 7: Teardown (always, best effort, each reported).** Sign Plexus out (both parts); delete graph `ihc-live-graph` (`DELETE /tenant-api/environments/smoke-ihd/graphs/ihc-live-graph`, 204) and environment `smoke-ihd` from the console; delete `smoke-plat` through the operator API; `DELETE /api/hives/default-pragmatic-hive/console` and Plan 1's leftover cleanup; ask the user first, then `dev-ca-trust.ps1 -CaFile <devCaFile> -Remove` (user dialog); delete the password and email temp files; confirm `hives.json` matches its backup and delete the backup.
- [ ] **Step 8: Merge locally** each branch (server, pragmatic-protocol, Plexus) after all gates pass; never push. Record the rulings and the G3 evidence in `docs/superpowers/plans/2026-11-06-plexus-platform-session-and-follow-ups-rulings.md` (server repo).
