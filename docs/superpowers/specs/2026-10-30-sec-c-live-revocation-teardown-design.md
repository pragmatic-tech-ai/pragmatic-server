# SEC-C: Live grant/session invalidation on revoke (immediate teardown)

**Status:** design — FORK RESOLVED 2026-10-30: invalidation reach =
**immediate teardown** (force-close the affected principal's live
connections the instant a revoke lands, with an in-process next-request
re-check as a backstop). **Program:** suite security-hardening batch.
SEC-C is the last item in the batch (after SEC-A dispatch/admin hardening
and SEC-B IdP login throttle).

## Problem

A connection's `AccessContext` (principal + baked-in grants) is assembled
**once** at WebSocket upgrade (`PragmaticServerHost.AuthenticateAgainst`
-> `ConnectionAuthenticator.ResolveAsync` -> `AccessContextAssembler`) and
is **never re-checked**. Every later RPC is authorized by `PolicyGate`
against that cached context (`ServerConnectionHandler` holds
`this.accessContext`, read in `authorize`). Consequently, every revoke
path today only affects *new* authentications; an **already-open**
connection keeps its grants until it disconnects:

- `AdminService.RevokeRole` mutates the grant store only — live
  connections keep the revoked role.
- `AdminService.RevokeToken` revokes the service token in the store — a
  connection already opened with it stays live.
- `AdminService.DisableAccount` flips a `Disabled` boolean on the account
  record and **does not revoke the principal's sessions at all** — a
  genuine bug: a disabled account's existing sessions still `Validate`
  and its live connections stay up.

The host credentials are **opaque and store-backed** (session tokens via
`ISessionManager`, service tokens via `IServiceTokenStore`), not
self-validating JWTs, so invalidation is a store delete plus a live
teardown — **no deny-list or JWT-revocation backend needs to be built.**
`ISessionManager.RevokeAllFor(tenant, principalId)` already exists in
`@pragmatic-tech-ai/todl-identity` and is **never called in this repo**.

## Goal

When an administrator revokes a role, revokes a service token, or disables
an account, the affected principal's **already-open** connections are
force-closed immediately (within the serving process), and the store is
updated so new connections and reconnects are rejected. A reconnect after
a role revoke rebuilds the `AccessContext` with the reduced grants.

## Scope

### IN

1. **`ServerConnectionHandler` revocation hook.** Add a `revoked` flag, a
   public `Revoke()` method (sets `revoked = true`, begins draining, and
   disposes the connection), and make `Dispose()` idempotent (guarded by a
   `disposed` flag). `Dispatch` rejects any RPC on a revoked handler with a
   dedicated `RevokedError` (a distinct JSON-RPC error, separate from the
   existing draining error) — the in-process next-request backstop for an
   RPC that was already in flight when teardown fired, or any handler the
   teardown iteration raced.

2. **`PrincipalConnectionRegistry` (new host-layer class).** A per-host
   index keyed by `(tenantId, principalId)` -> `Set<ServerConnectionHandler>`.
   Methods: `Add(tenantId, principalId, handler)`, `Remove(handler)`,
   `InvalidatePrincipal(tenantId, principalId)` (calls `Revoke()` on each
   matching handler). Per-instance state (a `Map` field), no module-level
   state. The registry exposes the invalidate capability through a narrow
   host-layer interface (`IPrincipalInvalidator` with
   `InvalidatePrincipal(tenantId, principalId): void`) so `AdminService`
   depends on the interface, not the host.

3. **Wire the registry into both hosts.** `PragmaticServerHost` and
   `src/cluster/worker-host.ts` each own a `PrincipalConnectionRegistry`;
   at attach, `registry.Add(context.Tenant.Id, context.Principal.Id,
   handler)`; in the existing ws `close` callback, `registry.Remove(handler)`
   (alongside the existing `handlers.delete`). Both hosts pass the
   registry (as `IPrincipalInvalidator`) and `pack.Sessions`
   (`ISessionManager`) into the `AdminService` they construct.

4. **`AdminService` wiring (store delete + live teardown).** Add two
   optional-last constructor parameters — `invalidator?: IPrincipalInvalidator`
   and `sessions?: ISessionManager` — both defaulting to undefined so all
   existing construction and tests keep compiling. After the store mutation
   and audit in each method:
   - `RevokeRole`: `invalidator?.InvalidatePrincipal(tenant, subject)` —
     the forced reconnect rebuilds the `AccessContext` with the reduced
     grants. (The session legitimately remains valid; only the live
     connection is torn down.)
   - `RevokeToken`: resolve the token's `PrincipalId` from the summary
     already fetched for the not-found guard, then
     `invalidator?.InvalidatePrincipal(tenant, principalId)`.
   - `DisableAccount`: `await sessions?.RevokeAllFor(tenant, principalId)`
     (store delete — fixes the existing bug so reconnects fail) **and**
     `invalidator?.InvalidatePrincipal(tenant, principalId)` (live
     teardown). The invalidation happens after the audit; a teardown
     failure must not swallow the disable (best-effort live teardown over
     the already-committed store change).

### OUT (fork choice + rulings)

- **Logout live-teardown.** `auth-http-endpoint.Logout` already revokes
  its own session in the store (`Sessions.Revoke(session.Id)`), so a
  reconnect with that cookie fails. **Ruling:** force-closing logout's
  live WS connection is *session-scoped* (end THIS session, not the
  principal's connections on other devices), which needs session-id
  plumbing threaded from `ConnectionAuthenticator` through the handler and
  a session-keyed index — a distinct, larger mechanism with narrower
  semantics than the principal-keyed teardown here. Deferred as a filed
  follow-up Feature. Cost if wrong: a logged-out browser tab's *other*
  open WS on the same session lingers until it disconnects; the store
  revoke still blocks any reconnect. Low.
- **Cross-process (clustered) live teardown + cross-process backstop.**
  The registry and the `revoked` flag are per-process. In a clustered
  deployment a revoke handled on worker A cannot tear down a live
  connection on worker B, and worker B's in-process backstop will not see
  it. **Ruling:** out of scope — same boundary SEC-A drew for the
  cross-process last-admin race. The store-wiring (`RevokeAllFor`,
  `grants.Revoke`, `tokens.Revoke`) *does* propagate cross-process for new
  connections and reconnects, because the store is the source of truth at
  auth time; only a *live, already-open* connection on *another* worker is
  the residual gap. Filed as a follow-up Feature (store-backed per-request
  re-validation or a shared revocation channel). Cost if wrong: in a
  multi-worker deployment a revoked principal's live connection on a
  different worker survives until it disconnects. Medium, but bounded and
  explicitly tracked.
- **IdP password-rotation session invalidation.** `idp-host.RoutePassword`
  is IdP-realm-side and does not touch host sessions; out of scope (a
  different layer and credential world).
- **Re-authorize-in-place (instead of teardown) for role revoke.** The
  fork chose teardown; rebuilding an `AccessContext` in place on a live
  connection is not pursued. Teardown + reconnect is simpler and the
  reconnect rebuild is the existing, tested path.

## Approach (the how that is decided)

- **Teardown mechanism.** `InvalidatePrincipal` iterates the principal's
  handlers and calls `handler.Revoke()`. `Revoke()` sets `revoked = true`
  (so `Dispatch` rejects any subsequent RPC with `RevokedError`), begins
  draining, and disposes the connection (which closes the underlying
  WebSocket). The existing ws `close` callback then runs the normal
  cleanup (`handler.Dispose()` — now idempotent — `handlers.delete`,
  `registry.Remove`, `registry.Release`). Disposing is made idempotent so
  the direct `Revoke()`-driven dispose and the `close`-event dispose do not
  double-dispose.
- **Backstop.** The `revoked` flag checked in `Dispatch` covers the race
  where an RPC is already past `authorize` / in flight when teardown fires,
  and any handler the synchronous iteration might miss. In-process only
  (see OUT).
- **No secret handling changes.** Invalidation keys on `(tenantId,
  principalId)` identifiers only; tokens/secrets are never logged, echoed,
  or placed in keys. Audit entries are unchanged (identifiers only).
- **Layering.** Everything is within `src/host` / `src/cluster` (the server
  host layer). `AdminService` depends on the host-layer interfaces
  `IPrincipalInvalidator` and `ISessionManager`; it never imports or calls
  the host concretely. No engine-upward call is introduced.

## Constraints (Global)

- ASCII + LF for every touched file. At base: `server-connection-handler.ts`,
  `admin-service.ts`, `pragmatic-server-host.ts` are LF / 0 non-ASCII;
  `worker-host.ts` is LF with exactly **3 non-ASCII bytes — preserve them**.
  The new `principal-connection-registry.ts` and new tests are LF / ASCII.
  Byte-scan base + each touched file on the way out. Never `sed -i`.
- OOP + Allman braces; no inline string literals (hoist error messages /
  codes to `private static readonly` constants); enums over string unions;
  PascalCase public members; no module-level free functions or state (the
  registry's `Map` is a per-instance field).
- Never log/echo/return a password, token, or secret.
- Gate: realm `npm test` (`tsx --test "src/**/*.test.ts"`) +
  `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit
  path; never `git add -A`; never docs.

## Review focus

- **Revoke actually reaches live connections:** after `RevokeRole` /
  `RevokeToken` / `DisableAccount`, an already-open connection for that
  principal is force-closed, and an RPC that arrives on it before the close
  completes is rejected with `RevokedError` (not served).
- **Reconnect reflects the new state:** a reconnect after `RevokeRole`
  rebuilds the `AccessContext` without the revoked role; after
  `DisableAccount` the reconnect is rejected (sessions were
  `RevokeAllFor`-deleted); after `RevokeToken` the token no longer
  resolves.
- **No double-dispose / no leak:** `Dispose()` is idempotent; the registry
  `Remove` runs on close so the index does not retain dead handlers (a
  teardown must not leave a stale entry that a later `InvalidatePrincipal`
  dereferences).
- **Scope isolation:** invalidating principal A does not tear down
  principal B's connections, and does not tear down A's connections on a
  *different* tenant.
- **Disable is store + live:** `DisableAccount` both `RevokeAllFor`-deletes
  sessions and tears down live connections; a teardown failure does not
  roll back or hide the committed disable.
- **Both hosts wired:** the registry Add/Remove and the `AdminService`
  invalidator/`sessions` injection are present in **both**
  `PragmaticServerHost` and `worker-host`.
- **Backward-compatible construction:** the two new `AdminService` ctor
  params are optional-last; an `AdminService` built without them (existing
  tests) behaves exactly as before (no teardown, no session revoke).
- **EOL:** all touched files keep their base EOL; `worker-host.ts` keeps
  its 3 non-ASCII bytes; new files LF / ASCII.
