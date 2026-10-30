# SEC-B: Brute-force throttle for the per-tenant IdP login + password routes

**Status:** design — FORK RESOLVED 2026-10-30: lockout policy = **stricter**
(3 attempts / 15-min window / 30-min lockout). **Program:** suite
security-hardening batch. SEC-B = the one remaining buildable item in the batch
after SEC-A; the other two batch candidates (operator login rate-limiting;
close /api/events sockets on logout/expiry) were VERIFIED already shipped and
marked Done.

## Scope

- **IN:** add brute-force throttling + lockout to the per-tenant IdP realm's
  unauthenticated credential-checking routes in `src/idp`:
  1. **Authorize login** (`RouteAuthorize` POST → `AuthorizeEndpoint.HandlePost`
     → `realm.Authenticate(email, password)`).
  2. **Self-service password rotation** (`idp-host.RoutePassword` →
     `realm.RotatePassword(email, current, next)` — unauthenticated, verifies
     the current password).
- **OUT (fork choice + rulings):** the OAuth **token / client-secret** endpoint
  (`RouteToken`) — machine-to-machine confidential-client creds, lower
  brute-force risk, and throttling risks breaking legitimate client retry
  bursts. The admin endpoint (`RouteAdmin`) is already bearer-gated
  constant-work and is NOT a password surface. Trusted-XFF real-client-IP
  extraction (the realm sits behind an ingress) — deferred; see the IP ruling.

## Context (verified)

- The control-plane ALREADY ships `admin/control-plane/login-throttle.ts`
  (`LoginThrottle`: combined `(email, ip)` key, 5 attempts / 15-min window /
  15-min lockout, bounded keys with lock-preserving eviction, optimistic
  count-at-gate, Clear-on-success) wired into operator `HandleLogin`. SEC-B
  MIRRORS this proven design with stricter numbers, as a realm-local class.
- The IdP realm (`src/idp`, run as its own workload via `idp-main.ts`) exposes
  `RouteAuthorize` / `RouteToken` / `RoutePassword` in `idp-host.ts` with **no
  throttle**. `AuthorizeEndpoint.HandlePost` has exactly one caller
  (`idp-host.ts:431`). `AuthorizeResult` already has a
  `{ kind: 'error'; status; body }` variant (can carry 429). `realm.Authenticate`
  returns `AuthenticatedResult | null` (null = bad credentials);
  `realm.RotatePassword` returns `boolean` (false = wrong current password).
- idp-host sees the client only via `req.socket.remoteAddress`.

## Items + acceptance + rulings

1. **Realm-local throttle** (`src/idp/idp-login-throttle.ts`, NEW, LF/ASCII).
   Mirror `LoginThrottle`'s logic: a `Map`-backed throttle with a combined key,
   `CheckAllowed → { allowed, retryAfterMs }`, `RecordFailure`, `Clear`, `Size`,
   bounded `maxKeys` with lock-preserving eviction (spraying keys can never shed
   a lock), optimistic count-at-gate, amortised prune. **Ruling (fork =
   stricter):** defaults `maxAttempts = 3`, `windowMs = 15*60*1000`,
   `lockoutMs = 30*60*1000`. **Ruling (key):** combined key over
   `(tenantId, email, ip)` — a lockout is scoped to one (account, source) pair
   and NEVER cascades to other accounts (DoS-safe; behind an ingress that
   collapses client IPs it degrades to per-(tenant,email), still account-safe).
   **Ruling (IP):** use `req.socket.remoteAddress` with NO x-forwarded-for trust
   (conservative — never trust a spoofable header for a lockout decision); an
   absent IP maps to a fixed empty bucket (so the key degrades to
   tenant+email, never errors). Acceptance: 3 failures on a key lock it for the
   lockout window (CheckAllowed → not allowed + retryAfterMs); a 4th within
   lockout stays denied; after the window a fresh attempt is allowed; Clear
   wipes the counter; a lock on key A does not affect key B; the map never
   exceeds maxKeys and a locked entry is retained under eviction pressure.

2. **Wire the throttle into the two credential routes** (`src/idp/idp-host.ts`,
   `src/idp/authorize-endpoint.ts`, LF). One shared throttle instance owned by
   `IdpHost` (constructed in its ctor; optional-last ctor param defaulting to a
   `new IdpLoginThrottle()` so existing construction keeps working), used for
   BOTH surfaces (a failed password-rotation and a failed login brute-force the
   same secret, so they share the key/counter). **Ruling:** inject the shared
   throttle into `AuthorizeEndpoint` (ctor collaborator) and add a `clientIp`
   parameter to `HandlePost`; `idp-host.RouteAuthorize` passes
   `req.socket.remoteAddress`; `idp-host.RoutePassword` uses the same throttle
   directly.
   - **Authorize login (COUNT-AT-GATE):** after field validation + realm
     lookup, `CheckAllowed(tenant, email, ip)`; if locked, return
     `{ kind: 'error', status: 429, body }` with a generic retry message (NO
     account-existence signal) — and the host sets `Retry-After`. Else
     `RecordFailure(tenant, email, ip)` SYNCHRONOUSLY (optimistic count, BEFORE
     the await — `realm.Authenticate` runs Argon2 + async I/O and yields the
     event loop, so recording after the await lets a concurrent burst all pass
     the gate before any count lands; this mirrors the control-plane
     `HandleLogin`), then `await realm.Authenticate`; on success `Clear` (wipes
     the optimistic failure); on failure do NOT record again (already counted at
     the gate). Throttle BY the submitted email even when the account does not
     exist (so probing cannot distinguish existence) — but only count when a
     login was actually attempted (email + password present + realm known), not
     on a malformed form (the malformed early-returns precede the RecordFailure).
   - **Password rotation (COUNT-AT-GATE):** after parsing email/current/next +
     realm lookup, `CheckAllowed`; if locked, 429 + `Retry-After` + generic body.
     Else `RecordFailure` synchronously (optimistic), then
     `await realm.RotatePassword`; on true `Clear`; on false do NOT record again
     (just the existing 401). Malformed-body early-returns precede RecordFailure.
   - Acceptance: 3 bad logins for one (tenant,email,ip) → the 4th returns 429
     with Retry-After and `realm.Authenticate` is NOT called for it; a correct
     login before lockout succeeds and resets the counter; the same for password
     rotation (wrong current password counted, 429 after the threshold,
     `RotatePassword` not called while locked); a successful auth/rotation
     clears the counter; a locked email does not lock a different email from the
     same IP; no response reveals whether the account exists; the token endpoint
     is unaffected.

## Constraints (Global)

- ASCII + LF for every touched file (`idp-host.ts`, `authorize-endpoint.ts`,
  the new `idp-login-throttle.ts`, and tests under `src/idp/tests/` — all LF, 0
  non-ASCII at base; preserve). Byte-scan base + each touched file on the way
  out. Never `sed -i`.
- Never log/echo/return a password, token, or secret. A throttle key is
  derived from the email + ip (identifiers), never from the password. Locked and
  failed responses must be generic (no account-existence oracle).
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; PascalCase public
  members; no module-level free functions/state (the throttle's Map is a
  per-instance field).
- Gate: `npm test` (`tsx --test src/**/*.test.ts`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path;
  never `git add -A`; never docs.

## Review focus

- **Lockout actually enforced AND DoS-safe:** 3 failures lock the (tenant,
  email, ip) key; CheckAllowed precedes the credential check (a locked request
  never reaches `Authenticate`/`RotatePassword`); a lock on one key never locks
  another account; optimistic count-at-gate (no await between Check and Record)
  so a parallel burst can't exceed the threshold; locked entries survive
  eviction under key-spray.
- **No account-existence oracle:** throttling, locked responses, and failure
  responses are identical for existent and non-existent emails; nothing in a
  response or its timing reveals existence beyond what already existed.
- **Shared counter across both surfaces:** a failed rotation and a failed login
  for the same (tenant,email,ip) count toward the same lock.
- **No secret leakage:** keys/logs/responses never contain a password/secret;
  Retry-After carries only seconds.
- **Scope:** the token/client-secret and admin routes are unchanged.
- **EOL:** all touched files LF, 0 non-ASCII; the new file LF/ASCII.
