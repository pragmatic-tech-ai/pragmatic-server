# Operator-Console Security Hardening (SP-ADMIN Spec A) — Design

**Status:** design
**Date:** 2026-10-26
**Program:** Backlog Program 2 (server/platform/identity hardening), sub-cluster SP-ADMIN, Spec A of 3.
**Reconciles with:** `2026-10-25-platform-and-tenant-admin-app-separation-design.md` — the operator API (`ControlPlaneHost`) stays **loopback-by-default**; the public surface is the separate agent-channel server, not this API. This spec makes non-localhost exposure *safe when opted into*, without changing the default.

## Intent

Close the security deferreds filed against `ControlPlaneHost` + `admin/portal` so the operator console is safe to expose beyond loopback, leaks no open event stream after logout, and enforces operator roles:

1. Login rate-limiting / lockout (`/api/login` has no throttle).
2. Close `/api/events` sockets on logout/expiry (open sockets currently survive logout; `clients` is an unkeyed `Set<WebSocket>`) **and authenticate the events upgrade with a WS-subprotocol ticket**.
3. Cross-origin / DNS-rebinding defense + explicit allowed-host config (today only a hardcoded loopback `AllowedHosts` set + Origin-equality on mutating requests; `SessionCookie` already sets `HttpOnly; SameSite=Strict; Path=/`).
4. Masked password field + submit-on-Enter in the portal login (Mural TS `TextBox` has no masked mode and exposes no key event).
5. **Operator RBAC** — operator roles (Full vs ReadOnly) over the existing todl-identity grant model, enforced so read-only operators cannot mutate.

## Current state (recon)

- `ControlPlaneHost`: `AllowedHosts = {localhost,127.0.0.1,[::1]}`; `HostAllowed`/`OriginAllowed(req)` (absent Origin allowed, present must equal own origin); mutating requests already require `OriginAllowed` + `application/json`; `/api/login|session|logout|events`. `/api/events` upgrade checks host+origin+session then adds the socket to `private readonly clients = new Set<WebSocket>()`. No session→socket association; no per-socket revalidation.
- `OperatorIdentity` (`@pragmatic-tech-ai/todl-identity`): single Owner operator, `Authenticate(email,password): OperatorSession|null` (`{token, expiresAt}`), `ValidateToken(token): OperatorPrincipal|null`, `Revoke(token)`. Sessions live in an identity pack.
- `SessionCookie`: `cp_session`, `HttpOnly; SameSite=Strict; Path=/`, `Secure` when configured, `Max-Age`.
- `admin/portal/src/login-view.ts` uses a Mural `TextBox`; Mural TS `TextBox` is `../mural/src/basic/textbox.*` (`.ts` + `.template.mu`), no password/echo-mask, no public key event.

## Scope & design

### 1. Login rate-limiting / lockout

A dependency-free, in-memory `LoginThrottle` class (new, `admin/control-plane/login-throttle.ts`):

- Keyed by `(normalizedEmail, clientIp)`. Tracks consecutive failures with timestamps.
- After `MaxAttempts` failures within `WindowMs`, the key is **locked** for `LockoutMs` (fixed, not growing — simpler and bounded); `/api/login` returns `429` with a generic message and a `Retry-After` header, **before** calling `operator.Authenticate` (so a locked key costs no credential check).
- A successful auth clears the key. A clock seam (`now: () => number`) makes it unit-testable.
- Bounds memory: prune entries older than `WindowMs+LockoutMs` on each access; cap the map size and evict oldest on overflow.
- `clientIp` from the socket remote address (do **not** trust `X-Forwarded-For` unless a configured trusted-proxy flag is set — ruling below).

`Ruling:` fixed lockout window, not exponential/stateful backoff, and in-memory not Redis. — Why: single-process operator console; dependency-free; bounded. — Cost if wrong: a multi-replica or restart-resilient throttle is a later Feature (pairs with the existing Phase7 Redis item).

### 2. Events-socket: WS-subprotocol ticket auth + close on logout/expiry

- **WS-subprotocol ticket.** A browser `WebSocket` cannot set a custom request header but *can* set a subprotocol (`new WebSocket(url, [ticket])`). Mint a short-lived, single-use **events ticket** from a new cookie-authed HTTP endpoint `GET /api/events-ticket` (subject to the existing Host/Origin guards); return the opaque ticket; the portal opens the events WS with the ticket as its sole `Sec-WebSocket-Protocol` value. The upgrade validates the ticket against an in-memory `EventsTicketStore` (TTL + single-use), resolves it to the session token, and echoes the accepted subprotocol. A cross-origin page cannot obtain a ticket (the mint endpoint is same-origin + cookie-gated), so this authenticates the socket independent of cookie-on-WS behavior.
- **Registry.** Replace `clients: Set<WebSocket>` with `clientsByToken: Map<string, Set<WebSocket>>`. On a validated upgrade, register the socket under the resolved session token; on socket `close`, deregister (and drop empty sets).
- `/api/logout`: after `operator.Revoke(token)` + clearing cookie, **close all sockets registered under that token** (close code = going-away).
- **Expiry:** a periodic sweep (`RevalidateIntervalMs`) walks `clientsByToken`, re-`ValidateToken`s each token once, and closes every socket whose token no longer validates. Covers server-side expiry and externally-revoked sessions without per-message cost.
- The broadcast path (`environments-changed`) iterates the flattened sockets; unchanged payload.

`Ruling:` WS auth via a single-use subprotocol ticket minted over cookie-authed HTTP, not the raw session token in the subprotocol. — Why: keeps the long-lived session token out of the `Sec-WebSocket-Protocol` header, is browser-settable, and a cross-origin page cannot mint a ticket. — Cost if wrong: a longer-lived ws token is a trivial relaxation.

`Ruling:` token-keyed map + periodic revalidation sweep, rather than per-message cookie re-check. — Why: the event payload carries no data/secrets, so bounded-latency closure (one sweep interval) is sufficient and cheap. — Cost if wrong: a stricter per-message gate is a trivial follow-up.

### 3. Cross-origin / DNS-rebinding defense + allowed-host config

- Promote `AllowedHosts` from a hardcoded loopback set to a value seeded from config: default = the loopback set; an explicit `allowedHosts: string[]` (compose option) **adds** permitted host:authority values for non-localhost exposure. Host header must match an allowed host (DNS-rebinding defense — a rebinding attack arrives with an attacker Host).
- Keep: `SameSite=Strict` cookie, Origin-equality on mutating, json-only POST. Layered model = SameSite + Origin + Host-allowlist (CSRF + DNS-rebinding) for HTTP, plus the WS-subprotocol ticket (§2) for the socket.
- **The HTTP custom-header defense is NOT built here** — it is filed as a backlog TODO Feature (an additional defense-in-depth layer on top of SameSite+Origin+Host-allowlist). This spec's HTTP defense is the allowed-host config + the existing SameSite/Origin/json guards.

`Ruling:` allowed-host config + the existing SameSite/Origin/json guards for HTTP; the extra non-forgeable custom-header layer is deferred (filed as a Project #1 Feature) per the approver. — Why: `SameSite=Strict`+HttpOnly already blocks cross-site cookie send; the Host allowlist closes DNS-rebinding; the custom header is additional depth, not a gap. — Cost if wrong: the filed Feature adds the header later with no rework.

### 5. Operator RBAC (roles: Full vs ReadOnly)

The operator identity is a principal in a `control-plane` todl-identity tenant pack that already carries a full PP security model (grants/roles/privileges); today the single admin gets an Owner grant (`ServerBootstrap.SeedAsync ... ownerGrant:true`). Fold role-based authorization in:

- **Role on the principal.** Extend `OperatorPrincipal` with a `role: OperatorRole` (`Full` | `ReadOnly`, an enum — enums-over-string-literals), derived from the principal's grants in the pack (Owner/full-authz ⇒ `Full`; a read-only grant ⇒ `ReadOnly`). `ValidateToken` returns it.
- **Enforcement gate.** A single authorization gate on `ControlPlaneHost` classifies each route as **read** or **mutate** (the mutating set already drives the Origin/json checks — reuse `IsMutating` plus the explicit action routes: provision, publish, withdraw/restore, gating/selection edits, token rotate, create-operator, etc.). A `ReadOnly` operator calling a mutating route gets `403` with a generic message; reads/observe are allowed. `Full` is unrestricted. This realizes the UX brief's read-only-observer vs full-operator split.
- **Provisioning a second role.** Add the ability to create an operator account with a role: a bootstrap/compose path (seed a `ReadOnly` operator) **and** a minimal mutating admin endpoint `POST /api/operators` (create operator: email, initial password ref, role) guarded by `Full`. Rich operator-account management UI stays with the portal/Spec B; this spec provides the role model, enforcement, and the create path so RBAC is real and testable end-to-end.
- Map `Full`/`ReadOnly` onto todl-identity grants via the pack's existing grant API (read it; do not invent a parallel role store).

`Ruling:` two roles (Full, ReadOnly) via todl-identity grants, enforced by a route-class gate, plus a Full-guarded create-operator endpoint. — Why: the approver folded RBAC into this slice; two roles match the UX brief and the deferred's "operator" model; reusing the identity pack's grants avoids a parallel RBAC. — Cost if wrong: more granular roles (e.g. publish-only) are an additive later Feature.

### 4. Masked password + submit-on-Enter (Mural TS)

In the TS Mural sibling (`../mural/src/basic/textbox.*`):

- Add a boolean `IsPassword` dependency property (default false). When true, the control **renders** a mask glyph (`•`, a hoisted constant) per character while the real text stays in `Text`/the binding — masking is a render-time transform only; selection/caret/editing operate on the true text.
- Add a `KeyDown`/submit affordance: expose a public event (or a `SubmitRequested` signal) that fires on Enter, so a login view can submit without a mouse. Follow Mural's existing signal/event conventions (do not invent a seam; see the control's existing event surface).
- Build mural (`npm run build` in the mural sibling) so the server/portal consume the updated `dist` (workspace build propagation).

In `admin/portal/src/login-view.ts`: set `IsPassword` on the password `TextBox`; wire Enter → submit; `api-client.ts` adds the custom console header.

`Ruling:` extend the existing `TextBox` with `IsPassword` rather than add a separate `PasswordBox` control. — Why: smaller surface, reuses all editing/binding behavior, matches the deferred's wording ("masked input mode"). — Cost if wrong: a dedicated `PasswordBox` can wrap it later.

## Out of scope / non-goals

- The HTTP custom-header defense-in-depth layer (filed as a Project #1 TODO Feature). Rich operator-account management UI (portal/Spec B). More granular operator roles beyond Full/ReadOnly. Redis/multi-replica throttle & session store. The registry-based Mural deps + bundled-Playwright portal build (separate SP-ADMIN operator-note Feature). Anything in Spec B (admin UX) or Spec C (store/perf).

## Testing

- `LoginThrottle`: unit tests with a fake clock (lock after N, unlock after LockoutMs, clear on success, pruning/eviction).
- Host/origin/custom-header gating: unit tests on the request-guard predicates (allowed/rejected matrices incl. rebinding Host + missing custom header + cross-origin).
- Socket close: unit/integration on `clientsByToken` (logout closes that token's sockets; sweep closes expired; close deregisters).
- Mural `TextBox` `IsPassword`: Mural's own test harness (render shows mask, `Text` keeps the real value, Enter fires submit).
- Admin test runner `npx tsx --test admin/control-plane/tests/<file>.test.ts`; type gates `tsc -p tsconfig.tools.json` + `-p tsconfig.tenant-admin.json`; Mural tests per the mural repo; LF endings; OOP/Allman/PascalCase/no-inline-literals.

## Left to the plan

Exact file list and task decomposition; the precise Mural event/signal name (read the control's existing surface); the compose-option plumbing for `allowedHosts` + `trustedProxy`; whether the revalidation sweep lives on `ControlPlaneHost` or a small `SocketRegistry` helper (prefer a class).
