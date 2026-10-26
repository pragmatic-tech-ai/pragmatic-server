# Operator-Console Security Hardening (SP-ADMIN Spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ControlPlaneHost` + `admin/portal` safe to expose beyond loopback and leak no event stream after logout — login throttle/lockout, logout/expiry socket closure, cross-origin/DNS-rebinding defense + allowed-host config, and a masked/Enter-submit password field in Mural.

**Architecture:** Four independent-ish changes. Tasks 1–3 live in `pragmatic-server/admin/control-plane` + `admin/portal`; Task 4 lives in the TS Mural sibling (`../mural`) and is consumed via rebuilt `dist`. Each guard is a small class with a clock/IO seam so it unit-tests without a live server.

**Tech Stack:** TypeScript (NodeNext), `ws`, `@pragmatic-tech-ai/todl-identity` (existing `OperatorIdentity`), Mural (TS sibling). No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-admin-operator-console-security-hardening-design.md` (read it; this plan argues from it).

## Global Constraints

- OOP, Allman braces, PascalCase public members/interfaces, **no inline string/number literals** (hoist to `private static readonly`). LF endings (match any pre-existing CRLF in a touched file; new files LF). NodeNext `.js` import specifiers.
- Secrets/tokens/passwords/inner-error-text held server-side by name only — never in logs, DTOs, thrown messages, or the event payload. Generic client-facing messages (no credential-existence oracle on login).
- Operator API stays **loopback-by-default**; `allowedHosts`/`trustedProxy` are opt-in compose options.
- Type gates: `npx tsc -p tsconfig.tools.json --noEmit` AND `-p tsconfig.tenant-admin.json --noEmit` (server). Admin tests: `npx tsx --test admin/control-plane/tests/<file>.test.ts`. Mural: the mural repo's own build + test. Never `npm install` at repo root; rebuild the mural `dist` after Task 4 so the server/portal see it.
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Never merge/push without explicit instruction.

## Review Focus

- **Login throttle must gate before the credential check and not leak which keys are locked vs. wrong-password** — both return a generic failure; only the status differs (429 vs 401) + `Retry-After`. → Task 1 tests the pre-Authenticate gate + generic message.
- **The events WS ticket must be single-use, short-TTL, and unmintable cross-origin** — a reused or expired ticket is rejected on upgrade; the mint endpoint is cookie-gated + Host/Origin-guarded. → Task 2 ticket tests.
- **A rebinding request (attacker Host, valid cookie) must be rejected** even on GET; an explicitly-configured `allowedHosts` entry is accepted. → Task 3 gating matrix.
- **Logout/expiry must actually close the socket, and a closed socket must deregister** (no leak, no double-close, no unbounded map growth). → Task 2 tests close-on-logout, sweep-closes-expired, close-deregisters.
- **A ReadOnly operator must be blocked (403) on every mutating route and allowed on reads; Full is unrestricted** — no mutating route is reachable without a Full role. → Task 5 route-class authorization matrix.
- **Masking is render-only: the bound `Text` must still hold the true password** (a submit reads the real value, not masked glyphs). → Task 4 asserts `Text` unmasked while render is masked.
- **The throttle map, the ticket store, and the socket map are bounded** (TTL/pruning/eviction; empty sets dropped) so a hostile client cannot grow memory without bound. → Tasks 1 & 2.

---

### Task 1: `LoginThrottle` + wire into `/api/login`

**Files:**
- Create: `admin/control-plane/login-throttle.ts`
- Test: `admin/control-plane/tests/login-throttle.test.ts`
- Modify: `admin/control-plane/control-plane-host.ts` (login handler + compose option + client-IP extraction)

**Interfaces:**
- Produces: `class LoginThrottle` with ctor `(options?: { maxAttempts?; windowMs?; lockoutMs?; maxKeys?; now?: () => number })` and methods `CheckAllowed(email: string, ip: string): { allowed: boolean; retryAfterMs: number }`, `RecordFailure(email, ip): void`, `Clear(email, ip): void`. Hoist all defaults/strings as constants. Key = normalized(email)+'\u0000'+ip (null-joined to avoid ambiguity).
- Consumes (host): client IP from `req.socket.remoteAddress`, or the last `X-Forwarded-For` hop only when a `trustedProxy` compose flag is set (default off).

- [ ] **Step 1: Write failing tests** — lock after `maxAttempts` failures within `windowMs` (CheckAllowed → allowed:false + retryAfterMs>0); unlock after `lockoutMs`; `Clear` resets; failures outside `windowMs` don't accumulate; map prunes stale keys and evicts oldest past `maxKeys`. Fake `now`.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement `LoginThrottle`.**
- [ ] **Step 4: Wire into the login handler** — before `operator.Authenticate`, `CheckAllowed`; if blocked, `429` + `Retry-After` (seconds) + generic message. On `Authenticate===null` → `RecordFailure` + existing 401 generic. On success → `Clear`. Add `trustedProxy?: boolean` compose option; extract client IP accordingly.
- [ ] **Step 5: Run tests + both server type-gates; verify pass/clean.**
- [ ] **Step 6: Commit** — `feat: operator login rate-limiting + lockout`.

---

### Task 2: Events-socket — WS-subprotocol ticket auth + session→socket registry + close on logout/expiry

**Files:**
- Create: `admin/control-plane/operator-socket-registry.ts`, `admin/control-plane/events-ticket-store.ts`
- Test: `admin/control-plane/tests/operator-socket-registry.test.ts`, `admin/control-plane/tests/events-ticket-store.test.ts`
- Modify: `admin/control-plane/control-plane-host.ts` (new `GET /api/events-ticket`; validate the subprotocol ticket on upgrade; replace `clients` set; logout closes token's sockets; revalidation sweep; broadcast iterates registry), `admin/portal/src/api-client.ts` (fetch a ticket then open the WS with it as the subprotocol)

**Interfaces:**
- Produces: `class EventsTicketStore` with ctor `(options?: { ttlMs?; maxTickets?; now?: () => number; randomId?: () => string })` and `Mint(token: string): string` (opaque single-use id bound to the session token), `Redeem(ticket: string): string | null` (returns the session token once, then invalidates; null if unknown/expired/used), bounded + TTL-pruned. `class OperatorSocketRegistry` with `Add(token: string, ws: WebSocketLike): void` (auto-deregister on `close`), `CloseToken(token): void`, `All(): Iterable<WebSocketLike>`, `Tokens(): string[]`, `Size(): number`. `WebSocketLike = { close(): void; on(event, cb): void }` so tests use a fake, no real `ws`.
- Consumes (host): the `cp_session` token (validated) for `Mint`; the upgrade's `Sec-WebSocket-Protocol` for `Redeem`; `operator.ValidateToken` for the sweep. Portal: `GET /api/events-ticket` → `new WebSocket(url, [ticket])`.

- [ ] **Step 1: Write failing tests** — `EventsTicketStore`: `Mint` then `Redeem` returns the token once and null on a second `Redeem` (single-use); expired ticket (fake clock past ttl) → null; unknown → null; bounded eviction. `OperatorSocketRegistry`: `Add` then socket emits `close` → deregistered (`Size` drops); `CloseToken` closes every socket under that token and removes the entry; `All` enumerates across tokens; empty token-sets dropped.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement `EventsTicketStore` + `OperatorSocketRegistry`.**
- [ ] **Step 4: Integrate in host** — add `GET /api/events-ticket` (cookie-authed via `Principal`, Host/Origin-guarded) returning `{ ticket: store.Mint(token) }`; in `UpgradeOperatorEvents` read the single subprotocol value, `Redeem` it to a session token (reject the upgrade if null) instead of/in addition to the cookie check, echo the accepted subprotocol on handshake, and register the socket under the redeemed token; `/api/logout` calls `CloseToken(token)` after `Revoke` + cookie-clear; add a `setInterval` revalidation sweep (`RevalidateIntervalMs`, hoisted) that `ValidateToken`s each `Tokens()` entry once and `CloseToken`s any that no longer validate; clear the interval on host `Stop`/close; broadcast iterates `All()`.
- [ ] **Step 5: Portal** — `api-client.ts` does `GET /api/events-ticket` then `new WebSocket(wsUrl, [ticket])`; handle ticket-fetch failure (no socket).
- [ ] **Step 6: Run tests + both type-gates; verify pass/clean.**
- [ ] **Step 7: Commit** — `feat: WS-subprotocol ticket auth + close operator event sockets on logout/expiry`.

---

### Task 3: Allowed-host config + DNS-rebinding defense

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (allowed-host from config)
- Test: `admin/control-plane/tests/control-plane-host-guards.test.ts` (new, if the guard predicates are extractable; otherwise extend existing host tests)

**Interfaces:**
- Produces: compose option `allowedHosts?: readonly string[]` merged into the loopback default set; `HostAllowed` reads the merged set.
- Consumes: existing `IsMutating`, Origin/Host helpers.

> The HTTP custom-header defense is filed as a Project #1 TODO Feature and is **not** built here (approver decision). WS auth is the subprotocol ticket in Task 2. This task only adds the allowed-host config + rebinding defense; SameSite/Origin/json guards are unchanged.

- [ ] **Step 1: Write failing tests** — a request with an attacker `Host` not in the allowed set is rejected (even GET); a loopback Host passes with no config; an explicitly-configured `allowedHosts` entry is accepted; a mutating request from a disallowed Origin is still rejected (unchanged). Drive via small request-shaped fixtures against the extracted predicates.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** — seed `AllowedHosts` from `{loopback...} ∪ allowedHosts` (compose option); `HostAllowed` reads it; keep SameSite/Origin/json untouched.
- [ ] **Step 4: Run tests + both type-gates; verify clean.**
- [ ] **Step 5: Commit** — `feat: allowed-host config + DNS-rebinding defense for the operator API`.

---

### Task 4: Mural `TextBox` masked mode + submit-on-Enter; use in portal login

**Files:**
- Modify (Mural sibling `../mural`): `src/basic/textbox.ts` (+ `.template.mu` if the mask affects the template) — add `IsPassword` DP + mask-glyph render + Enter/submit event.
- Test (Mural sibling): the TextBox control test (`src/resources/pragmatic/tests/controls-textbox.test.ts` or the control's own test home) — mask renders, `Text` holds the true value, Enter fires submit.
- Modify: `admin/portal/src/login-view.ts` (set `IsPassword`; wire Enter → submit).

**Interfaces:**
- Produces (Mural): `IsPassword` dependency property (default false); a public submit/accept event or signal following the control's existing event convention (READ the control's current surface before naming it — do not invent a seam); mask glyph constant.
- Consumes (portal): the new property + event.

- [ ] **Step 1: Read `../mural/src/basic/textbox.ts` fully** — learn its DP declaration pattern, render path, and existing event/signal surface. Note the exact convention in the task report.
- [ ] **Step 2: Write failing Mural test** — with `IsPassword=true`, the rendered text is masked glyphs of the right length while `Text` equals the typed value; Enter raises the submit event once.
- [ ] **Step 3: Run the Mural test, verify fail.**
- [ ] **Step 4: Implement** `IsPassword` (render-only mask) + the Enter/submit event, matching the control's conventions. Allman/PascalCase/no-inline-literals; match the file's existing line endings.
- [ ] **Step 5: Run the Mural test + mural typecheck; `npm run build` in `../mural` so `dist` updates.**
- [ ] **Step 6: Wire `login-view.ts`** — `IsPassword` on the password field; Enter → submit. Server/portal typecheck clean against the rebuilt mural `dist`.
- [ ] **Step 7: Commit** — split into two commits if the repos are separate: one in `../mural` (`feat: TextBox IsPassword mask + submit-on-Enter`) and one in `pragmatic-server` (`feat: masked password + Enter submit in operator login`). Record both SHAs.

> **Executor note:** Task 4 spans two git repos. Commit Mural changes in the mural repo and server/portal changes in pragmatic-server; the branch/merge rhythm (finishing-a-development-branch) applies per-repo. Rebuild the mural `dist` before the server typecheck in Step 6, per workspace build propagation.

---

### Task 5: Operator RBAC — roles (Full / ReadOnly) + route-class enforcement + create-operator

**Files:**
- Modify: `admin/control-plane/operator-identity.ts` (`OperatorRole` enum; `OperatorPrincipal.role` derived from grants; a `CreateOperator(email, password, role)` method; seed a ReadOnly operator path)
- Create: `admin/control-plane/operator-authorization.ts` (route-class gate)
- Test: `admin/control-plane/tests/operator-authorization.test.ts`, extend `admin/control-plane/tests/operator-identity.test.ts` (role derivation + create)
- Modify: `admin/control-plane/control-plane-host.ts` (apply the gate on every route; `POST /api/operators` guarded by Full)

**Interfaces:**
- Produces: `enum OperatorRole { Full, ReadOnly }` (enums-over-string-literals). `OperatorPrincipal` gains `role: OperatorRole`, derived from the pack's grants (Owner/full-authz ⇒ Full; the read-only grant ⇒ ReadOnly) — read todl-identity's grant API; do not invent a parallel store. `class OperatorAuthorization` with `IsMutatingRoute(method, path): boolean` (reuse/extend the host's existing `IsMutating` + the explicit action-route set) and `Authorize(role, method, path): boolean` (ReadOnly ⇒ false on mutating routes; Full ⇒ true). `IOperatorIdentity.CreateOperator(email: string, password: string, role: OperatorRole): Promise<void>`.
- Consumes: `ValidateToken` (now returns `role`); `ServerBootstrap.SeedAsync` grant seams.

- [ ] **Step 1: Write failing tests** — `OperatorAuthorization.Authorize`: ReadOnly blocked on each mutating route class (provision/publish/withdraw/gating/selection/token-rotate/create-operator) and allowed on reads/observe; Full allowed everywhere. `operator-identity`: a freshly-created ReadOnly operator validates with `role=ReadOnly`; the bootstrapped admin validates with `role=Full`; `CreateOperator` creates an authenticatable account with the given role (no password in any thrown/logged text).
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** `OperatorRole`, role derivation in `ValidateToken`, `CreateOperator` (grant the role via the pack API), and `OperatorAuthorization`.
- [ ] **Step 4: Enforce in host** — after `Principal`/`ValidateToken`, pass the role through the `OperatorAuthorization` gate for every authenticated route; a ReadOnly operator on a mutating route gets `403` + generic message. Add `POST /api/operators` (create operator: email, initial password, role) guarded by Full; secrets by ref, never echoed.
- [ ] **Step 5: Run tests + both type-gates; verify pass/clean.**
- [ ] **Step 6: Commit** — `feat: operator roles (Full/ReadOnly) + route-class authorization + create-operator`.

> **Executor note:** derive roles from the identity pack's existing grant/security model — the operator tenant already carries the PP model. If the pack has no ready read-only grant preset, model ReadOnly as "authenticated principal without the Owner/mutate grant" and make the gate deny-by-default on mutating routes for any non-Full principal. Record the grant mechanism you used in the task report.
