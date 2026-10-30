# SEC-A: AdminService + JSON-RPC Dispatch Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three `src/host` security correctness fixes — atomic last-administrator revoke, foreign-tenant resource-ref rejection (defense-in-depth), and scrubbing internal error messages out of the JSON-RPC dispatch response.

**Architecture:** `AdminService` gains a per-tenant serialization lock around its grant mutations (closing the last-admin check-then-revoke race) and a foreign-tenant `ResourceRef` guard; `ServerConnectionHandler`'s dispatch choke point maps any non-`ResponseError` throw to a generic `InternalError` so raw `.message` text never reaches the client.

**Spec:** `docs/superpowers/specs/2026-10-30-sec-a-admin-dispatch-hardening-design.md` (rulings — read it).

## Global Constraints

- ASCII + LF for every touched file (`src/host/admin-service.ts`, `src/host/server-connection-handler.ts`, tests under `src/host/tests/` — all LF, 0 non-ASCII at base; preserve). Byte-scan base + each touched file on the way out. Never `sed -i`.
- Never leak a secret/token/internal path/message in any error, audit, or response. Audit carries identifiers only.
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); enums over unions; PascalCase public members; no module-level free functions/state.
- Gate: `npm test` (`tsx --test src/**/*.test.ts`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- Last-admin race truly closed: a test drives two concurrent `RevokeRole`s on the last two admins; exactly one throws `LastAdministratorError`, count never reaches zero; no deadlock; serialization is per-tenant only.
- Foreign-tenant guard precedes all side effects (no store mutation, no audit); same-tenant path unchanged; new error surfaces as a clean client error (whitelisted in `AdminCall`), not scrubbed as internal.
- Scrub: every non-`ResponseError` throw → generic `InternalError`; NO intentional `ResponseError` altered; server-side observability (instrumentation failure path) preserved; `inFlight` bookkeeping intact.
- No credential/path/message leak anywhere.
- EOL: all touched files stay LF, 0 non-ASCII.

---

### Task 1: AdminService hardening — foreign-tenant guard + atomic last-admin revoke (items 2 + 1)

**Files:** `src/host/admin-service.ts` (LF), `src/host/tests/admin-service.test.ts` (LF), and `src/host/server-connection-handler.ts` (LF) for the one-line `AdminCall` whitelist addition.

**Interfaces:**
- Produces: `ForeignTenantResourceError` (exported from admin-service.ts); unchanged public method signatures for `GrantRole`/`RevokeRole`.

- [ ] **Item 2 (foreign-tenant guard) first.** Failing tests: `GrantRole` and `RevokeRole` with a `resource` whose `TenantId !== tenant.Id` throw `ForeignTenantResourceError`, and (assert via fakes) the grant store is NOT mutated and NO audit event is recorded; a matching-tenant ref behaves exactly as today.
- [ ] Implement `ForeignTenantResourceError` (Allman, named, PascalCase) and a private guard `AssertOwnTenant(resource: ResourceRef): void` (or inline check) invoked at the very top of `GrantRole` and `RevokeRole`, before any store/audit call. Add the error to `AdminCall`'s known-error whitelist in `server-connection-handler.ts` (so it maps to `ResponseError(ErrorCodes.InvalidRequest, …)`, NOT scrubbed by Task 2). Import it there.
- [ ] **Item 1 (atomic last-admin revoke).** Failing test: two `RevokeRole` promises started concurrently (not awaited between), each targeting one of the last two Administer-covering grants on the tenant root, resolve so that EXACTLY ONE throws `LastAdministratorError` and the other succeeds; afterwards exactly one administrator grant remains (never zero). (Use the suite's existing fake grant store; if it resolves synchronously, interleave via a store whose `GrantsOn`/`Revoke` await a microtask so the race is real.)
- [ ] Implement a per-tenant async serialization lock (the `IdpService.Serialized(key, work)` pattern: chain on a `Map<string, Promise>` keyed by `this.tenant.Id`) and run the body of `GrantRole` and `RevokeRole` inside it, so the last-admin read-check-revoke is atomic against a concurrent mutation. Keep the self-lockout guard and existing single-call behaviour intact. No cross-tenant blocking.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan all three files (stay LF, 0 non-ASCII). Commit (explicit paths).

### Task 2: Scrub internal error messages in the dispatch response (item 4)

**Files:** `src/host/server-connection-handler.ts` (LF), tests under `src/host/tests/` (match base EOL — add to an existing dispatch/connection test or a new `src/host/tests/dispatch-error-scrub.test.ts`, LF).

**Interfaces:**
- Consumes: `ResponseError`, `ErrorCodes` (from `@pragmatic-tech-ai/pragmatic-protocol`).

- [ ] Failing tests: a dispatched handler that throws `new Error('secret internal detail')` results in the client receiving a `ResponseError` whose code is `ErrorCodes.InternalError` and whose message is the generic constant — and NEVER contains `'secret internal detail'`; a handler that throws `new ResponseError(ErrorCodes.InvalidParams, 'bad field X')` reaches the client unchanged (same code + message); a handler that throws a `ResponseError` with the rate-limited/draining code passes through unchanged. (Drive these through the real dispatch path / a fake connection the suite already uses.)
- [ ] Implement: at the single dispatch choke point (the `fail` path in `Dispatch`, and/or wrapping the handler rejection), map any thrown value that is NOT an `instanceof ResponseError` to `new ResponseError(ErrorCodes.InternalError, ServerConnectionHandler.<GenericInternalMessage>)` (hoist the message constant, e.g. `'internal error'`). A `ResponseError` is re-thrown unchanged. Preserve the `inFlight--` bookkeeping on both the settle and fail paths. Do NOT suppress the existing `instrumentation` failure path (server-side observability must still see the real error). Do NOT alter `AdminCall`'s existing mappings (its outputs are already `ResponseError`).
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (server-connection-handler.ts + test stay LF, 0 non-ASCII). Commit (explicit paths).

## Final verification (whole branch)

- `npm test` (`tsx --test src/**/*.test.ts`) — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: LF, 0 non-ASCII.
