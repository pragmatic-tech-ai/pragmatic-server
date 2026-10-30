# SEC-A: AdminService + JSON-RPC dispatch security hardening

**Status:** design — 2026-10-30. No fork (all three are unambiguous correctness
fixes). **Program:** suite security-hardening batch (backlog survey, user chose
"security-hardening batch"). Batch SEC-A = the three tightly-scoped
`src/host` correctness fixes; the other batch items (live grant/session
invalidation on revoke; operator + tenant-IdP rate-limiting) are separate
follow-up specs (they touch other subsystems / carry policy choices).

## Scope

- **IN (3 items, all `src/host`):**
  1. **Atomic last-administrator revoke** — close the check-then-revoke race in
     `AdminService.RevokeRole`.
  2. **Reject foreign-tenant resource refs** — defense-in-depth guard in the
     `AdminService` mutations that take a `ResourceRef`.
  3. **Scrub internal error messages in the JSON-RPC dispatch response** — a raw
     thrown error's `.message` must not reach the client.
- **OUT (separate specs):** live grant/session invalidation on revoke (needs a
  session-invalidation seam + an aggressiveness decision); operator login
  rate-limiting / lockout (control-plane) and tenant-IdP login/password throttle
  (idp-host) — different subsystems, policy knobs.

## Context (verified)

- `src/host/admin-service.ts` `AdminService` (LF, 0 non-ASCII). `RevokeRole`
  (line 116) does a **non-atomic** read-check-write for the last-admin
  invariant: reads `grants.GrantsOn(tenant-root)`, filters the remaining
  Administer-covering grants excluding the target, throws
  `LastAdministratorError` if none remain, THEN `grants.Revoke`. No lock — two
  concurrent `RevokeRole` calls each targeting one of the last two admins each
  see the other as "remaining" and both proceed → tenant left with zero admins.
- `GrantRole`/`RevokeRole` accept `resource: ResourceRef`, which carries a
  `TenantId`. The RPC path (`ParseMutation`) pins `resource` to
  `this.accessContext.Tenant.Id`, so the live RPC caller cannot supply a foreign
  tenant today — but `AdminService` itself does not validate it (an alternate
  caller, a future path, or a bug could pass a foreign ref). `ListGrants`
  already filters by `grant.Resource.TenantId === this.tenant.Id`.
- `src/host/server-connection-handler.ts` (LF, 0 non-ASCII). `Dispatch`'s
  `fail(error)` (line 288) just re-throws; `AdminCall` (line 906) maps a short
  whitelist of known admin errors to `ResponseError(InvalidRequest, msg)` and
  **re-throws everything else raw** (line 922). A raw `Error` then reaches the
  vscode-jsonrpc layer, which serializes its `.message` into the error response
  — leaking internal detail (paths, SQL, stack-adjacent text) to the client.
  Intentional, safe errors are already `ResponseError` instances by the time
  they reach `fail` (InvalidParams/InvalidRequest/RateLimited/Draining/
  CypherTimeout, and the admin whitelist). `ErrorCodes` is re-exported from
  vscode-jsonrpc (`ErrorCodes.InternalError`); the app already uses a generic
  `'internal error'` string at other boundaries (auth-http-endpoint, idp-host).

## Items + acceptance + rulings

1. **Atomic last-administrator revoke.** **Ruling:** serialize the
   admin-count-affecting grant mutations per tenant through a single in-process
   async lock (the `IdpService.Serialized(key, work)` pattern), so the
   read-check-revoke in `RevokeRole` is evaluated atomically against any
   concurrent `RevokeRole`/`GrantRole` on the same tenant. Scope the lock key to
   `this.tenant.Id`. *Why:* the invariant ("a tenant always retains >=1
   administrator") can only be enforced if the check and the revoke are not
   interleaved. *Cost if wrong:* grant/revoke calls serialize per tenant (they
   are rare admin operations — negligible). Acceptance: two concurrent
   `RevokeRole` calls each targeting one of the last two Owner/admin grants →
   exactly ONE throws `LastAdministratorError`, the other succeeds, and the
   tenant retains exactly one administrator (never zero). Existing single-call
   behaviour (self-lockout guard, normal revoke, the existing last-admin throw)
   unchanged.

2. **Reject foreign-tenant resource refs (defense-in-depth).** Add
   `ForeignTenantResourceError` and, at the TOP of every `AdminService` mutation
   that takes a `ResourceRef` (`GrantRole`, `RevokeRole`), throw it when
   `resource.TenantId !== this.tenant.Id` — before any store read/write or
   audit. Wire the new error into `AdminCall`'s known-error whitelist so it
   surfaces as `ResponseError(InvalidRequest, …)` (NOT scrubbed as internal by
   item 3). *Why:* `AdminService` must not mutate grants scoped to another
   tenant even if a caller supplies a foreign ref. *Cost if wrong:* none (the
   live RPC path already pins the tenant; this is belt-and-suspenders).
   Acceptance: `GrantRole`/`RevokeRole` with a `resource.TenantId` != the
   service's tenant throws `ForeignTenantResourceError`, performs no store
   mutation and writes no audit event; a matching-tenant ref is unaffected.

3. **Scrub internal error messages in the dispatch response.** In
   `server-connection-handler.ts`, at the single dispatch choke point (`fail`,
   or an equivalent wrap around the handler result/rejection), map any thrown
   value that is **not** a `ResponseError` to
   `new ResponseError(ErrorCodes.InternalError, <generic constant>)` (hoist the
   message, e.g. `'internal error'`), so a raw `Error.message` never reaches the
   client. A `ResponseError` (every intentional, client-safe error) passes
   through byte-identical. **Ruling:** scrub the CLIENT-facing message only;
   do not suppress server-side observability — the error still flows through the
   existing `instrumentation` failure path (do NOT invent a new logger here).
   *Why:* internal error text is an information-disclosure leak. *Cost if
   wrong:* a client sees a generic message instead of internal detail for
   unexpected errors — intended. Acceptance: a handler throwing
   `new Error('secret internal detail')` yields a client `ResponseError` with
   code `InternalError` and the generic message, NEVER `'secret internal
   detail'`; a handler throwing `ResponseError(InvalidParams, 'x')` reaches the
   client unchanged (code + message preserved); the dispatch `inFlight`
   bookkeeping is unchanged.

## Constraints (Global)

- ASCII + LF for every touched file (`admin-service.ts`,
  `server-connection-handler.ts`, and tests under `src/host/tests/` — all LF, 0
  non-ASCII at base; preserve). Byte-scan base and each touched file on the way
  out. Never `sed -i`.
- Never leak a secret/token/internal path in any error, audit, or log. Audit
  events carry identifiers only (unchanged).
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; PascalCase public
  members; no module-level free functions/state.
- Gate: `npm test` (`tsx --test src/**/*.test.ts`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path;
  never `git add -A`; never docs.

## Review focus

- **Last-admin race genuinely closed:** the fix must make the check+revoke
  atomic against a concurrent revoke of the *other* last admin (a test must
  drive both concurrently and prove exactly one wins, count never hits zero).
  No deadlock, no cross-tenant serialization bottleneck beyond per-tenant.
- **Foreign-tenant guard precedes all side effects:** no store mutation, no
  audit on a foreign ref; the live same-tenant path is unchanged; the new error
  surfaces as a clean client error, not an internal one.
- **Scrub completeness + safety:** every raw (non-ResponseError) throw is
  scrubbed to a generic InternalError; NO intentional `ResponseError`
  (InvalidParams/InvalidRequest/RateLimited/Draining/CypherTimeout/admin
  whitelist/ForeignTenantResourceError) is altered; server-side observability
  preserved; inFlight bookkeeping intact.
- **No credential/path leak** anywhere on these paths.
- **EOL:** all touched files stay LF, 0 non-ASCII.
