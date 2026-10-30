# SEC-B: IdP Login + Password-Route Brute-force Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add brute-force throttling + lockout (stricter policy: 3 attempts / 15-min window / 30-min lockout) to the per-tenant IdP realm's unauthenticated credential routes — the authorize login and the self-service password rotation.

**Architecture:** A realm-local `IdpLoginThrottle` (mirroring the proven control-plane `LoginThrottle`: combined key, bounded, lock-preserving eviction, optimistic count-at-gate) is owned by `IdpHost` and shared across the login path (`AuthorizeEndpoint.HandlePost`) and the password-rotation path (`IdpHost.RoutePassword`). Keyed by combined `(tenantId, email, client-IP)` so a lockout never cascades to other accounts.

**Spec:** `docs/superpowers/specs/2026-10-30-sec-b-idp-login-throttle-design.md` (fork decision + rulings — read it).

## Global Constraints

- ASCII + LF for every touched file (`src/idp/idp-host.ts`, `src/idp/authorize-endpoint.ts`, new `src/idp/idp-login-throttle.ts`, tests under `src/idp/tests/` — all LF, 0 non-ASCII at base; preserve). Byte-scan base + each touched file on the way out. Never `sed -i`.
- Never log/echo/return a password/token/secret. A throttle key is derived from email + ip only, never the password. Locked/failed responses must be generic (NO account-existence oracle).
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); enums over unions; PascalCase public members; the throttle Map is a per-instance field (no module-level state).
- Gate: `npm test` (`tsx --test src/**/*.test.ts`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- Lockout enforced AND DoS-safe: 3 failures lock the (tenant,email,ip) key; CheckAllowed precedes the credential check (locked request never reaches Authenticate/RotatePassword); a lock on one key never locks another account; optimistic count-at-gate (no await between Check and Record); locked entries survive eviction under key-spray.
- No account-existence oracle: throttling + locked + failure responses identical for existent/non-existent emails.
- Shared counter across both surfaces (failed rotation and failed login for the same key count together).
- No secret in keys/logs/responses; Retry-After is seconds only.
- Token/client-secret + admin routes unchanged.
- EOL: all touched files LF, 0 non-ASCII; new file LF/ASCII.

---

### Task 1: `IdpLoginThrottle` (the throttle class + unit tests)

**Files:** `src/idp/idp-login-throttle.ts` (NEW, LF/ASCII), `src/idp/tests/idp-login-throttle.test.ts` (NEW, LF/ASCII).

**Interfaces:**
- Produces: `IdpLoginThrottle` with `CheckAllowed(tenantId: string, email: string, ip: string): { allowed: boolean; retryAfterMs: number }`, `RecordFailure(tenantId, email, ip): void`, `Clear(tenantId, email, ip): void`, `Size(): number`; optional ctor options `{ maxAttempts?, windowMs?, lockoutMs?, maxKeys?, now? }`. A `LoginThrottleDecision`-style return type.

- [ ] Failing unit tests: (a) `maxAttempts - 1` failures stay allowed; the `maxAttempts`-th failure locks → CheckAllowed returns `{ allowed:false, retryAfterMs>0 }`; (b) a request during lockout stays denied; (c) after `lockoutMs` (advance the injected `now`) a fresh attempt is allowed and the window reset; (d) `Clear` wipes the counter; (e) a lock on `(t,a@x,ip1)` leaves `(t,b@x,ip1)` and `(t,a@x,ip2)` allowed; (f) with `maxKeys` small, spraying distinct keys never evicts a LOCKED entry (the locked key stays denied); (g) defaults are 3 / 15min / 30min.
- [ ] Implement `IdpLoginThrottle` mirroring `admin/control-plane/login-throttle.ts` logic (combined key over the three parts with a NUL separator; fresh-window vs increment; lock at threshold; optimistic; amortised Prune; lock-preserving `EvictOne` that never evicts the just-recorded key). Inject `now` for tests. Defaults: `maxAttempts=3`, `windowMs=15*60*1000`, `lockoutMs=30*60*1000`, `maxKeys=10000`. No inline literals; Allman; PascalCase.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (both files LF, 0 non-ASCII). Commit (explicit paths).

### Task 2: Wire the throttle into the authorize-login and password-rotation routes

**Files:** `src/idp/idp-host.ts` (LF), `src/idp/authorize-endpoint.ts` (LF), tests `src/idp/tests/authorize-endpoint.test.ts` + `src/idp/tests/idp-host-admin.test.ts` (or a focused new `src/idp/tests/idp-host-throttle.test.ts`, LF) — match base EOL of any existing file edited.

**Interfaces:**
- Consumes: `IdpLoginThrottle` (Task 1); `AuthorizeEndpoint.HandlePost`; `realm.Authenticate` (null = fail), `realm.RotatePassword` (false = fail).
- Produces: `AuthorizeEndpoint.HandlePost(tenantId, query, cookieHeader, form, clientIp)` (new last param); `IdpHost` owns one shared `IdpLoginThrottle` (optional-last ctor param, default `new IdpLoginThrottle()`).

- [ ] Failing tests: (login) 3 bad POST logins for one (tenant,email,ip) → the 4th returns an `error` result with status 429 and a `Retry-After`, and `realm.Authenticate` is NOT called for the 4th (spy/fake); a correct login before the threshold succeeds and resets (a later bad attempt starts fresh); a bad login for a NON-existent email is throttled identically (no existence difference in status/body); a lock on email A does not lock email B from the same IP. (rotation) wrong current password 3x → 429 + Retry-After on the 4th and `RotatePassword` not called; a correct rotation clears; a failed rotation and a failed login for the same key count toward the SAME lock. (shared) assert the cross-surface shared counter.
- [ ] Implement: add the shared `IdpLoginThrottle` to `IdpHost` (optional-last ctor param). Inject it into `AuthorizeEndpoint` (ctor collaborator) and add the `clientIp` param to `HandlePost`; in `HandlePost`, only when a login is actually attempted (email+password present and realm known): `CheckAllowed` → on locked return `{ kind:'error', status:429, body:{ error:<generic>, ... } }`; else **COUNT-AT-GATE**: `RecordFailure` SYNCHRONOUSLY (optimistic, before the await — Argon2/async yields the loop, so recording after would let a concurrent burst bypass the gate; mirror control-plane HandleLogin), then `await Authenticate`; on success `Clear`; on failure do NOT record again. In `idp-host.RouteAuthorize` pass `req.socket.remoteAddress ?? ''`; in `WriteAuthorize`/the 429 path set `Retry-After` (seconds) from retryAfterMs + `no-store`. In `idp-host.RoutePassword`: `CheckAllowed` before `realm.RotatePassword` (locked → 429 + Retry-After + generic body); else `RecordFailure` synchronously, then `await RotatePassword`; on true `Clear`; on false no extra record. Add a concurrency test: N>maxAttempts concurrent guesses for one key → at most maxAttempts reach the realm. Use the SAME throttle instance + same key scheme for both. Hoist all new strings/headers to constants. No account-existence oracle.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (all touched files match base EOL; new file LF). Commit (explicit paths).

## Final verification (whole branch)

- `npm test` (`tsx --test src/**/*.test.ts`) — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: LF, 0 non-ASCII.
