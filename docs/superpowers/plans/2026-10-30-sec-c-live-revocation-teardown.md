# SEC-C: Live grant/session invalidation on revoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When an admin revokes a role, revokes a service token, or disables an account, force-close the affected principal's already-open connections immediately (within the serving process) and update the store so reconnects are rejected; a reconnect after a role revoke rebuilds the AccessContext with the reduced grants.

**Architecture:** A per-host `PrincipalConnectionRegistry` indexes live `ServerConnectionHandler`s by `(tenantId, principalId)`. `AdminService` gains two optional-last collaborators — an `IPrincipalInvalidator` (the registry) and an `ISessionManager` — and, after each revoke's store mutation + audit, tears down the principal's live connections (and, for disable, also deletes its sessions via the already-present-but-unused `ISessionManager.RevokeAllFor`). `ServerConnectionHandler` gains a `revoked` flag + `Revoke()` and rejects any in-flight RPC with a dedicated local error code; `Dispose()` becomes idempotent so direct teardown and the ws-close path don't double-dispose.

**Spec:** `docs/superpowers/specs/2026-10-30-sec-c-live-revocation-teardown-design.md` (fork decision + rulings — read it).

## Global Constraints

- ASCII + LF for every touched file. At base: `src/host/server-connection-handler.ts`, `src/host/admin-service.ts`, `src/host/pragmatic-server-host.ts` are LF / 0 non-ASCII; `src/cluster/worker-host.ts` is LF with exactly **3 non-ASCII bytes — preserve them** (do not normalize). New files (`src/host/principal-connection-registry.ts`, new tests under `src/host/tests/`) are LF / ASCII. Byte-scan base + each touched file on the way out. Never `sed -i` (Git Bash `sed -i` strips CR; here all files are LF, but the rule stands — use Edit/Write).
- OOP + Allman braces; no inline string literals (hoist messages/codes/keys to `private static readonly`); enums over string unions; PascalCase public members; no module-level free functions or state (the registry's `Map`s are per-instance fields).
- Never log/echo/return a password, token, or secret. Invalidation keys on `(tenantId, principalId)` identifiers only.
- `RevokedError` is a **local** code on `ServerConnectionHandler` (mirroring the existing `RateLimitedCode = -32029` / `CypherTimeoutCode = -32030`), NOT a change to `@pragmatic-tech-ai/pragmatic-protocol` (no published-contract edit).
- Gate: realm `npm test` (`tsx --test "src/**/*.test.ts"`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- Revoke reaches live connections: after `RevokeRole` / `RevokeToken` / `DisableAccount`, an already-open connection for that principal is force-closed, and an RPC arriving on it before the close completes is rejected with `RevokedCode` (not served).
- Reconnect reflects new state: reconnect after `RevokeRole` rebuilds AccessContext without the role; after `DisableAccount` the reconnect is rejected (sessions were `RevokeAllFor`-deleted); after `RevokeToken` the token no longer resolves.
- No double-dispose / no index leak: `Dispose()` is idempotent; `registry.Remove` runs on ws-close so the index drops dead handlers (a later `InvalidatePrincipal` must not touch a stale handler).
- Scope isolation: invalidating principal A does not tear down principal B's connections, nor A's connections under a different tenant.
- Disable is store + live: `DisableAccount` both `RevokeAllFor`-deletes sessions and tears down live connections.
- Both hosts wired: registry Add/Remove and the `AdminService` invalidator/`sessions` injection exist in BOTH `PragmaticServerHost` and `worker-host`.
- Backward-compatible construction: the two new `AdminService` ctor params are optional-last; an `AdminService` built without them behaves exactly as before.
- EOL: touched files keep base EOL; `worker-host.ts` keeps its 3 non-ASCII bytes; new files LF / ASCII.

---

### Task 1: `ServerConnectionHandler` revocation primitives

**Files:** `src/host/server-connection-handler.ts` (LF), `src/host/tests/server-connection-handler-revoke.test.ts` (NEW, LF/ASCII — mirror `src/host/tests/server-connection-handler-drain.test.ts`).

**Interfaces:**
- Produces: `ServerConnectionHandler.Revoke(): void`; `public static readonly RevokedCode = -32031`; a `private static readonly RevokedMessage`; an idempotent `Dispose()`. `Dispatch` rejects on a revoked handler.

- [ ] Failing tests (mirror the drain test's handler construction): (a) after `handler.Revoke()`, a JSON-RPC request dispatched on the connection is rejected with a `ResponseError` whose `code === ServerConnectionHandler.RevokedCode`; (b) calling `Dispose()` twice disposes the underlying `MessageConnection` exactly once (count `dispose` on a fake connection); (c) `Revoke()` disposes the connection (the connection's `dispose` is called once after `Revoke()`).
- [ ] Implement: add `private revoked = false` and `private disposed = false`. `public Revoke(): void` sets `this.revoked = true`, calls `this.BeginDrain()`, then `this.Dispose()`. Guard `Dispose()` with `if (this.disposed) { return }; this.disposed = true` before disposing subscriptions/connection. In `Dispatch`, BEFORE the existing `if (this.draining)` check, add `if (this.revoked) { throw new ResponseError(ServerConnectionHandler.RevokedCode, ServerConnectionHandler.RevokedMessage) }`. Hoist `RevokedMessage` (e.g. `'connection authorization has been revoked'`) as a `private static readonly`. Allman; no inline literals.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (both files LF, 0 non-ASCII). Commit (explicit paths).

### Task 2: `PrincipalConnectionRegistry` + `IPrincipalInvalidator`

**Files:** `src/host/principal-connection-registry.ts` (NEW, LF/ASCII), `src/host/tests/principal-connection-registry.test.ts` (NEW, LF/ASCII).

**Interfaces:**
- Consumes: the `Revoke()` method from Task 1 (via a minimal `IRevocableConnection { Revoke(): void }` the registry stores, which `ServerConnectionHandler` satisfies structurally — keeps the registry decoupled from the full handler and trivially testable).
- Produces: `export interface IPrincipalInvalidator { InvalidatePrincipal(tenantId: string, principalId: string): void }`; `export interface IRevocableConnection { Revoke(): void }`; `export class PrincipalConnectionRegistry implements IPrincipalInvalidator` with `Add(tenantId: string, principalId: string, handler: IRevocableConnection): void`, `Remove(handler: IRevocableConnection): void`, `InvalidatePrincipal(tenantId: string, principalId: string): void`.

- [ ] Failing tests (use a small fake implementing `IRevocableConnection` with a `Revoke` call-count): (a) Add two handlers for `(t1, A)` and one for `(t1, B)`; `InvalidatePrincipal(t1, A)` calls `Revoke` on both A handlers and not B's; (b) tenant isolation — Add `(t1, p)` and `(t2, p)`; `InvalidatePrincipal(t1, p)` revokes only the t1 handler; (c) `Remove(handlerA1)` then `InvalidatePrincipal(t1, A)` does not call the removed handler's `Revoke`; (d) `InvalidatePrincipal` on an unknown key is a no-op (no throw).
- [ ] Implement: key = `` `${tenantId}\u0000${principalId}` `` (NUL-joined; hoist the separator as a `private static readonly`). Field `private readonly byKey = new Map<string, Set<IRevocableConnection>>()` plus a reverse `private readonly keyOf = new Map<IRevocableConnection, string>()` so `Remove` drops the handler from its bucket in O(1) (delete the bucket when it empties). `InvalidatePrincipal` snapshots the bucket (copy to an array before iterating, since `Revoke()` triggers ws-close → `Remove`, mutating the set) and calls `Revoke()` on each. Allman; PascalCase; no inline literals; no module-level state.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (both files LF, 0 non-ASCII). Commit (explicit paths).

### Task 3: Wire invalidation + session revoke into `AdminService`

**Files:** `src/host/admin-service.ts` (LF), `src/host/tests/admin-service.test.ts` (LF, extend).

**Interfaces:**
- Consumes: `IPrincipalInvalidator` (from `./principal-connection-registry.js`), `ISessionManager` (from `@pragmatic-tech-ai/todl-identity`); `ServiceTokenSummary.PrincipalId`.
- Produces: `AdminService` constructor gains two optional-last params — `invalidator?: IPrincipalInvalidator, sessions?: ISessionManager` (params 11 and 12, after `securityModelReload`). Stored as `private readonly` fields.

- [ ] Failing tests (extend the fixture with a fake `IPrincipalInvalidator` capturing `(tenantId, principalId)` calls and a fake `ISessionManager` capturing `RevokeAllFor(tenant, principalId)`; build an `AdminService` WITH both params): (a) `RevokeRole(actor, subject, role, resource)` calls `InvalidatePrincipal(tenant.Id, subject)` exactly once after a successful revoke; (b) `IssueToken` then `RevokeToken(actor, tokenRef)` calls `InvalidatePrincipal(tenant.Id, <that token's PrincipalId>)`; (c) `DisableAccount(actor, principalId)` calls `sessions.RevokeAllFor(tenant, principalId)` AND `InvalidatePrincipal(tenant.Id, principalId)`; (d) backward-compat — an `AdminService` built WITHOUT the two params (the existing fixture) still completes `RevokeRole`/`RevokeToken`/`DisableAccount` with no error and makes no teardown/session calls.
- [ ] Implement: add the two optional-last ctor params + fields. In `RevokeRole`, after the existing `await this.Serialized(...)` block (post-commit, post-audit), call `this.invalidator?.InvalidatePrincipal(this.tenant.Id, subject)`. In `RevokeToken`, capture `const summary = existing.find(s => s.TokenRef === tokenRef)` (reuse the list already fetched for the not-found guard); after `await this.tokens.Revoke(...)` + audit, `this.invalidator?.InvalidatePrincipal(this.tenant.Id, summary.PrincipalId)`. In `DisableAccount`, after `await this.accounts.Disable(...)`: `await this.sessions?.RevokeAllFor(this.tenant, principalId)`, then build+`await this.Audit(...)` (existing), then `this.invalidator?.InvalidatePrincipal(this.tenant.Id, principalId)` (order: account disabled → sessions deleted → audit → live teardown). No inline literals; Allman.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (both files LF, 0 non-ASCII). Commit (explicit paths).

### Task 4: Own the registry in both hosts and wire attach/close + e2e

**Files:** `src/host/pragmatic-server-host.ts` (LF), `src/cluster/worker-host.ts` (LF — preserve 3 non-ASCII bytes), `src/host/tests/admin-e2e.test.ts` (LF, extend — mirror `AdminHostFixture`).

**Interfaces:**
- Consumes: `PrincipalConnectionRegistry` (Task 2), the extended `AdminService` ctor (Task 3), `pack.Sessions` (`ISessionManager`), the per-connection `context` (`AccessContext` — `context.Tenant.Id`, `context.Principal.Id`).
- Produces: each host owns `private readonly principalConnections = new PrincipalConnectionRegistry()`.

- [ ] Failing e2e tests (extend `AdminHostFixture` in `admin-e2e.test.ts`): (a) connect as a non-owner principal; from an Owner connection `RevokeRole` on that principal → the first connection's ws emits `close` (await it with a bounded timeout) OR a subsequent RPC on it rejects with `RevokedCode`; (b) `DisableAccount` on the connected principal → its live connection closes and a fresh connect attempt with the same credential is rejected; (c) scope — revoking principal A does not close a concurrently-connected principal B's connection.
- [ ] Implement (apply identically in BOTH hosts): add the `principalConnections` field. In the upgrade path, append `, this.principalConnections, pack.Sessions` to the `new AdminService(...)` call (after `await server.SecurityModelReload()`). After `this.handlers.add(handler)`, add `this.principalConnections.Add(context.Tenant.Id, context.Principal.Id, handler)`. In the ws `close` callback, add `this.principalConnections.Remove(handler)` next to `this.handlers.delete(handler)`. Confirm `worker-host`'s `AdminService` call and attach/close mirror `PragmaticServerHost` (its Attach arg list is shorter but the AdminService tail — `}, await server.SecurityModelReload())` — is identical, so the two appended args go in the same place). Do not disturb `worker-host`'s 3 non-ASCII bytes.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan every touched file (LF; `worker-host.ts` still 3 non-ASCII). Commit (explicit paths).

## Final verification (whole branch)

- `npm test` (`tsx --test "src/**/*.test.ts"`) — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: LF; `worker-host.ts` retains exactly 3 non-ASCII bytes; new files 0 non-ASCII.
