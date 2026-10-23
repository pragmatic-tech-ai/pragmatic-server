# Dedicated tenant listener + host→tenant login mapping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split the tenant admin plane onto its own dedicated listener (operator stays loopback-only), and derive the tenant from a per-tenant subdomain so the portal no longer needs a `?tenant=` param.

**Architecture:** A new `TenantPlaneHost` owns a second `http.Server`/`WebSocketServer` serving ONLY the tenant routes; `ControlPlaneHost` reverts to operator-only. A `TenantHostResolver` maps `<label>.<baseDomain>` → tenant id (validated against the directory). Shared HTTP primitives move to a stateless `PlaneHttp` helper. The relying-party's callback URL becomes per-call (derived from the request host), touching the #6 durable path.

**Tech Stack:** TypeScript (tsx, node:test), node `http`/`ws`, existing `PlatformDirectory`/`JsonRecordStore`, the #6 durable relying-party.

**Spec:** `docs/superpowers/specs/2026-10-24-sp-hive-7-tenant-listener-host-mapping-design.md` — read it with this plan; it carries the exact decisions, the normalization rule, and the Review Focus.

## Global Constraints

- OOP (methods/static methods on classes, no free functions or module-level mutable state), Allman braces, NO inline string literals (hoist to `private static readonly` PascalCase constants), PascalCase interfaces/public methods, enums over string-literal sets.
- SECURITY: the client secret / IdP admin token / auth code / inner-error text never returned, logged, thrown, or persisted; `TenantLoginError` stays no-arg/fixed-message/no-cause. Plane isolation must be STRUCTURAL: the operator listener serves no tenant route and the tenant listener serves no `/api/*` or operator static — regardless of `Host`.
- Tenant-id↔label normalization: the resolver lowercases the label and does an exact `directory.GetTenant(label)`; subdomain login requires a lowercase DNS-safe tenant id; no `?tenant=` fallback (documented in README).
- Tests live under `tests/`. Control-plane: `npx tsx --test "admin/control-plane/tests/*.test.ts"`. Portal: `npm --prefix admin/tenant-portal test`. Do NOT `npm install` at the repo root. Operator loopback bind unchanged; tenant bind defaults to `127.0.0.1`.
- Behaviour-preserving refactors (Task 1, Task 5) are proven green by the existing full suite.

## Review Focus

- **Cross-plane isolation:** `/api/*` on the tenant listener → 404 (no such route; NOT today's 403); `/tenant-api/*` on the operator listener → not routed. — Tasks 4 & 5.
- **Host resolution:** `acme.admin.example.com` → `acme` (known tenant); unknown label, bare `admin.example.com`, nested `a.b.admin.example.com`, foreign domain, and an UPPERCASE/`_` label → all refused. — Task 2.
- **Callback correctness:** begin on `acme.admin.example.com` authorizes + registers with `redirect_uri = https://acme.admin.example.com/tenant-auth/oidc/callback`; the callback on that host completes. — Tasks 3 & 4.
- **Fail-closed:** tenant env unset → no tenant listener; operator byte-neutral. — Tasks 5 & 7.
- **Portal no-param:** with no `?tenant=`/stored tenant, login still reached (no prompt); post-login `pts_session` cookie flow intact. — Task 6.
- **ws host-gating:** a tenant ws upgrade on a non-tenant host refused on the dedicated listener. — Task 4.

---

### Task 1: `PlaneHttp` shared HTTP primitives

**Files:** Create `admin/control-plane/plane-http.ts`; Modify `admin/control-plane/control-plane-host.ts`; Test `admin/control-plane/tests/plane-http.test.ts`.

**Interfaces — Produces:** `class PlaneHttp` with static methods lifted verbatim (behaviour-identical) from `ControlPlaneHost`: `HostIn(req, allowed)`, `OriginInHosts(req, allowed)`/`OriginHost(origin)`, `IsMutating(req)`, `WriteJson(res, status, body)`, `WriteNotFound(res)`, `ServeStatic(req, res, path, rootAbs)` (with the traversal guard, `MimeTypes`, percent-decode), and the shared `HostHeaderPattern`. Consumed by Tasks 2 and 4.

- [ ] **Step 1:** Write `plane-http.test.ts` pinning the lifted behaviour: `HostIn` match/no-match/port-strip/malformed; `IsMutating` POST/DELETE/PUT vs GET; `ServeStatic` serves a file, 404s a missing one, refuses `../` and encoded traversal, sets the right MIME; `OriginInHosts` absent-ok / match / foreign-reject.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Create `PlaneHttp` by MOVING those methods/consts out of `ControlPlaneHost` (not reimplementing), then have `ControlPlaneHost` call `PlaneHttp.*`. Keep behaviour byte-identical (the operator `ServeStatic` currently takes the root via `StaticRootFor`; pass the operator root in).
- [ ] **Step 4:** Run `plane-http.test.ts` (pass) AND the whole control-plane suite (`npx tsx --test "admin/control-plane/tests/*.test.ts"`) — must stay green, proving the refactor preserved behaviour.
- [ ] **Step 5:** Commit (`refactor(control-plane): extract shared PlaneHttp HTTP primitives`).

### Task 2: `TenantHostResolver`

**Files:** Create `admin/control-plane/tenant-auth/tenant-host-resolver.ts`; Test `admin/control-plane/tests/tenant-host-resolver.test.ts`.

**Interfaces — Consumes:** `PlaneHttp` host pattern (Task 1), `PlatformDirectory.GetTenant` (exists, exact case-sensitive lookup). **Produces:** `class TenantHostResolver` ctor `(baseDomain: string, externalScheme: string, directory: PlatformDirectory)`; `TenantFor(hostHeader?: string): string | undefined` (strip `.<baseDomain>` case-insensitively + port, lowercase the single label, reject dot-in-label, return it iff `GetTenant(label)` exists); `Accepts(hostHeader?): boolean`; `CallbackFor(hostHeader: string): string` = `${scheme}://${hostLower}${CallbackPath}` where `CallbackPath = '/tenant-auth/oidc/callback'`.

- [ ] **Step 1:** Write tests per the Review-Focus "Host resolution" bullet (known `acme`→`acme`; unknown label→undefined; bare base domain→undefined; nested `a.b.<base>`→undefined; foreign domain→undefined; `ACME`/`ac_me` label→undefined via the lowercase-exact-GetTenant rule; `CallbackFor` builds the right URL). Use a stub `PlatformDirectory` with a known tenant.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement per spec §2 (including the normalization rule).
- [ ] **Step 4:** Run, pass.
- [ ] **Step 5:** Commit (`feat(tenant): subdomain host→tenant resolver`).

### Task 3: Relying-party callback URL per call

**Files:** Modify `admin/control-plane/tenant-auth/tenant-oidc-relying-party.ts`; Modify `admin/control-plane/tests/tenant-oidc-relying-party.test.ts`.

**Interfaces — Produces:** `ITenantOidcRelyingParty.Begin(tenantId: string, callbackUrl: string)` and `Complete(tenantId, code, state, callbackUrl)`; the ctor `callbackUrl` (currently 4th positional) is REMOVED. `configFor` takes the callback; `RegisterClient` redirectUris use it. Consumed by Tasks 4 & 7.

- [ ] **Step 1:** Update the existing RP tests to pass `IdpFixture.CallbackUrl` at `Begin`/`Complete` and drop it from the ctor; keep every assertion (durable reuse/rotate/persist/missing/no-leak/coalescing/legacy). Add one test that two different callback URLs are each honored as the `redirect_uri` (recording factory).
- [ ] **Step 2:** Run, verify the signature change makes them fail to compile/run.
- [ ] **Step 3:** Move `callbackUrl` from the ctor to the `Begin`/`Complete` params; thread it to `configFor` (used by BOTH, since `Complete`'s token exchange consumes `RedirectUri`) and to `RegisterClient`. Update `ITenantOidcRelyingParty`.
- [ ] **Step 4:** Run the RP suite (pass).
- [ ] **Step 5:** Commit (`refactor(tenant): relying-party callback URL per login (host-derived)`).

### Task 4: `TenantPlaneHost` + host-derived auth endpoint

**Files:** Create `admin/control-plane/tenant-plane-host.ts`; Modify `admin/control-plane/tenant-auth/tenant-auth-endpoint.ts`; Create `admin/control-plane/tests/tenant-plane-host.test.ts` (absorb the tenant/static/streaming cases from `control-plane-host-tenant.test.ts` + `tenant-streaming.test.ts`); Modify `admin/control-plane/tests/tenant-auth-endpoint.test.ts`.

**Interfaces — Consumes:** `PlaneHttp` (T1), `TenantHostResolver` (T2), the per-call RP (T3), `TenantPlane` (gate/api/events/sessions/staticRoot), `IEnvironmentService.OnChanged`. **Produces:** `class TenantPlaneHost` with `Listen(port, bind)`, `Close()`, `Address()`; it resolves `tenantId`/`callbackUrl` from each request host via the resolver and threads them into `TenantAuthEndpoint.Handle(req,res,path,tenantId,callbackUrl)` and the data API.

- [ ] **Step 1:** Write `tenant-plane-host.test.ts`: host-validation (unknown/foreign host → 403 before routing, HTTP and ws); `/tenant-auth/oidc/begin` on a tenant host redirects to authorize (stub RP) using the host-derived tenant + `redirect_uri`; `/tenant-api/*` gated by the cookie; tenant static served, traversal refused; events + logs ws delivered only to the owning tenant and refused without the cookie (move the streaming cases); `/api/ping` on this listener → 404 (structural isolation). Update `tenant-auth-endpoint.test.ts` for the new `Handle(…, tenantId, callbackUrl)` signature (drop the `?tenant=` query cases; assert the passed tenant/callback are used).
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement `TenantPlaneHost` by MOVING the tenant HTTP/ws logic out of `ControlPlaneHost` (`RouteTenant`→its own Handle, `UpgradeTenantEvents`/`UpgradeTenantLogs`/`TrackTenant`/`RemoveTenant`/`TenantUpgradeAllowed`, the `OnChanged→events` subscription + `TenantEventFor`) and routing through `PlaneHttp` + `TenantHostResolver`. `TenantAuthEndpoint.Handle` gains `tenantId`/`callbackUrl` params and drops the `?tenant=` reads; `begin`→`rp.Begin(tenantId, callbackUrl)`, `callback`→`rp.Complete(tenantId, code, state, callbackUrl)`.
- [ ] **Step 4:** Run the new harness + `tenant-auth-endpoint.test.ts` (pass).
- [ ] **Step 5:** Commit (`feat(tenant): dedicated TenantPlaneHost listener with host-derived tenant`).

### Task 5: `ControlPlaneHost` sheds the tenant plane

**Files:** Modify `admin/control-plane/control-plane-host.ts`; Modify `admin/control-plane/tests/control-plane-host-tenant.test.ts` (reduce to the operator-only cross-plane assertions) and any `ControlPlaneHost` ctor sites.

**Interfaces — Consumes:** nothing new; removes `tenantAuth`. After this task `ControlPlaneHost` has no tenant knowledge.

- [ ] **Step 1:** Update `control-plane-host-tenant.test.ts`: the "serves tenant bundle"/streaming/tenant-route cases are gone (they live in Task 4's harness now); keep/replace with an assertion that the operator host, with NO tenant plane, behaves exactly as before and that a would-be tenant path (`/tenant-api/...`) is just operator static/404. Confirm the operator suite is otherwise untouched.
- [ ] **Step 2:** Run, verify the stale tenant-plane construction no longer compiles (ctor no longer takes `tenantAuth`).
- [ ] **Step 3:** Remove from `ControlPlaneHost`: the `tenantAuth` ctor param + fields (`tenantStaticRootAbs`, `tenantChangeSubscription`), `RouteTenant`, `StaticRootFor` (serve the operator root directly), the tenant branches in `RouteUpgrade`, the tenant ws handlers that moved in Task 4, the `OnChanged` subscription + `TenantEventFor`; collapse `HostAccepted` back to `HostAllowed` (loopback only). `Close()` no longer tears down tenant sockets.
- [ ] **Step 4:** Run the whole control-plane suite — green (operator behaviour preserved; tenant behaviour now proven by Task 4's harness).
- [ ] **Step 5:** Commit (`refactor(control-plane): operator host sheds the tenant plane (now structural)`).

### Task 6: Portal retires `?tenant=`

**Files:** Modify `admin/tenant-portal/src/tenant-app.ts`, `admin/tenant-portal/src/tenant-api-client.ts`; Modify `admin/tenant-portal/tests/tenant-app.test.ts`, `admin/tenant-portal/tests/tenant-api-client.test.ts`.

**Interfaces — Produces:** `BeginLogin()` navigates to `/tenant-auth/oidc/begin` with no tenant param. `ITenantEnvironment` + `BrowserTenantEnvironment` + the prompt view are removed; `TenantApp` login no longer resolves a tenant client-side.

- [ ] **Step 1:** Update the portal tests: delete the prompt / query-tenant / stored-tenant cases; assert `BeginLogin()` navigates to the bare begin path; assert boot→login reaches the server without a tenant param; keep the post-login session/cookie cases.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Remove the `?tenant=` read, sessionStorage, prompt view, and `ITenantEnvironment`; simplify `TenantApp` boot/login accordingly; `BeginLogin()` drops its argument + query.
- [ ] **Step 4:** Run `npm --prefix admin/tenant-portal test` (pass) + `npm --prefix admin/tenant-portal run typecheck`.
- [ ] **Step 5:** Commit (`feat(tenant-portal): derive tenant from host, retire ?tenant=`).

### Task 7: `server.ts` wiring + config + README

**Files:** Modify `admin/control-plane/server.ts`, `admin/README.md`; Modify `admin/control-plane/tests/tenant-plane-compose.test.ts`.

**Interfaces — Consumes:** `TenantPlaneHost` (T4), `TenantHostResolver` (T2), the per-call RP (T3), `ControlPlaneHost` without `tenantAuth` (T5).

- [ ] **Step 1:** Rewrite `tenant-plane-compose.test.ts` for the new composition: parse helpers for the new env (`PRAGMATIC_TENANT_ADMIN_PORT`/`_BIND`/`_BASE_DOMAIN`/`_EXTERNAL_SCHEME`); compose returns a `TenantPlaneHost` (durable RP, resolver) when the env is set, `undefined`/operator-only when not (fail-closed); assert the default bind `127.0.0.1` and scheme `https`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** In `Main()`: build the operator `ControlPlaneHost` (no tenantAuth) and, when the tenant env is set, a `TenantPlaneHost` (resolver from base-domain+scheme+directory; gate/api/events/sessions/tenant-static; the #6 durable relying-party + master key + admin-client registry + TTL moved here). Start the operator listener on `127.0.0.1:PRAGMATIC_ADMIN_PORT` and the tenant listener on `PRAGMATIC_TENANT_ADMIN_BIND:PRAGMATIC_TENANT_ADMIN_PORT`; `Close()` stops both. Remove `PRAGMATIC_TENANT_ADMIN_HOSTS`/`_CALLBACK_URL`; add the new vars. Update `admin/README.md` (new vars + the lowercase-DNS-safe tenant-id requirement).
- [ ] **Step 4:** `npm run typecheck:tools` clean; `npx tsx --test "admin/control-plane/tests/*.test.ts"` + `npm --prefix admin/tenant-portal test` all green.
- [ ] **Step 5:** Commit (`feat(tenant): start a dedicated tenant listener; subdomain host→tenant login`).

---

## Notes for the executor

- Strict order: **1 → 2 → 3 → 4 → 5 → 7**; **6** (portal) is independent and may run any time. Task 5 depends on Task 4 having a home for the tenant logic.
- Security-core (adversarial review on the most capable model): **Task 4** (the auth plane + isolation) and **Task 5** (operator isolation). Task 3 touches OIDC — standard review with a leak check.
- Tasks 1 and 5 are behaviour-preserving for the operator surface — the existing full suite is the gate.
- After Task 7, whole-branch review on the most capable model, then the finish menu (merge locally per the standing preference; never push without explicit instruction).
