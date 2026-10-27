# Tenant-Admin Session Profile & Admin Permissions (TA-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-authoritative admin-capability model + `GET /tenant-api/profile`, enforced on the access/settings write routes, wired into the portal's identity plate, user menu, and a gated Users & Access hub.

**Architecture:** One derivation (`TenantAdminCapabilities.For`) feeds both the profile read and the route guard, so reported capabilities equal enforced capabilities (the honesty invariant). The portal fetches the profile once at boot, holds it, and drives the plate / user-menu / denied-state from it, with a permissive fallback when the read fails.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers). Server: `node:http`, node:test via `tsx`. Portal: Mural controls (`@pragmatic-tech-ai/mural/*`), `tsx --test`, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-session-profile-permissions-design.md`

## Global Constraints

- Merge-local only; **never push**. Branch off `master`.
- **Pure ASCII** in every `.ts` file: straight apostrophes `'`, em dash written `—`, no smart quotes. Verify with a python byte scan (`sum(c>127 ...)` == 0), NOT grep (encoding bit TA-1 twice).
- **LF** line endings on every file touched by this plan (all identified targets are LF today).
- OOP, Allman braces (opening brace on its own line for class/method/control blocks), PascalCase for public methods and interfaces, no inline string literals (hoist to `private static readonly`), enums over string unions, any view-model extends `Observable`.
- DTO wire shapes are mirrored BY HAND into `admin/tenant-portal/src/tenant-types.ts` ("the portal never imports pragmatic-protocol"); server and portal copies must match field-for-field.
- New routes stay session-tenant-scoped, return generic error bodies, carry no secret material, and preserve 404-not-403 on foreign resources.
- Fix ALL review findings including Minors (standing rule). The mural repo's pre-existing WIP is never touched or staged; stage only this plan's files by path.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Capability honesty invariant:** reported caps (`GET profile`) must equal enforced caps. A route guarded in Task 2 that is NOT reflected in the Task 1 derivation (or vice-versa) is the defect. Test: owner and non-owner each get profile caps that match exactly which write routes 403. (Tasks 1+2.)
- **Existing mutate tests under enforcement:** `admin/control-plane/tests/tenant-api-mutate.test.ts` calls the now-guarded write routes. Under Task 2 they pass only if the test's tenant records no owner (fail-open) or an owner matching the test session. Test: run the full control-plane suite after Task 2; any new 403 means the test directory needs its owner aligned (adjust the fixture, do not weaken the guard). (Task 2.)
- **Fallback never fabricates a denial:** if `Profile()` throws at boot, capabilities default permissive (ungated) and the plate falls back to the session tenantId — not a Denied state. Test: a throwing stub `Profile()` yields a usable portal, Users & Access NOT denied. (Task 4+5.)
- **Org absent path:** a profile with no `organisation` renders the plate as "tenant / hive" with no stray separator. Test: plate from a profile lacking org omits the segment. (Task 4.)
- **No-owner fail-open:** a tenant record with neither `ownerPrincipalId` nor `ownerEmail` yields owner (all caps), not a lockout. Test in Task 1 and an enforcement open-path in Task 2.

---

### Task 1: Capability model, profile DTO, route, and org read-model

**Files:**
- Create: `admin/control-plane/tenant-api/tenant-admin-capabilities.ts`
- Create: `admin/control-plane/tenant-api/tenant-profile-dto.ts`
- Modify: `admin/control-plane/tenant-api/tenant-directory.ts` (add `GetOrganisation`)
- Modify: `admin/control-plane/tenant-api/seeded-tenant-directory.ts` (seed `organisation?`, implement `GetOrganisation`)
- Modify: `admin/control-plane/tenant-admin-bootstrap.ts` (thread optional `organisation` into the seed)
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (add `GET /tenant-api/profile`)
- Test: `admin/control-plane/tests/tenant-admin-capabilities.test.ts`, `admin/control-plane/tests/tenant-api-profile.test.ts`

**Interfaces:**
- Consumes: `TenantSession` (`tenant-auth/tenant-session.ts`: `{ id, tenantId, principalId, email?, expiresAt }`); `TenantRecord` (`platform-records.ts`: has `displayName`, `clientId`, `ownerEmail?`, `ownerPrincipalId?`); `HiveRecord` (`id`, `displayName`); `ITenantDirectory.GetTenant/GetHive/ListHives`; endpoint's `this.directory`, `this.WriteJson(res, status, body)`, `session` param; `TenantApiError.ForbiddenStatus = 403` convention (server writes 403 bodies directly).
- Produces:
  - `type AdminCapabilities = { envs: boolean; adopt: boolean; access: boolean; settings: boolean }`
  - `class TenantAdminCapabilities { static For(session: TenantSession, tenant: TenantRecord | undefined): { roleLabel: string; capabilities: AdminCapabilities } }` with public `static readonly OwnerRoleLabel = 'Tenant owner'`, `static readonly AdminRoleLabel = 'Environment admin'`, and a `static IsOwner(session, tenant): boolean`.
  - `type AdminCapabilitiesDto = AdminCapabilities` and `type TenantProfileDto = { principalId: string; email?: string; roleLabel: string; tenant: { id: string; displayName: string; organisation?: string }; hive: { id: string; displayName: string }; capabilities: AdminCapabilitiesDto; ownerContact?: string }` plus `class TenantProfileMapper { static ToDto(session, tenant, hive, organisation, caps): TenantProfileDto }`.
  - `ITenantDirectory.GetOrganisation(tenantId: string): string | undefined`.
  - Route `GET /tenant-api/profile`.

- [ ] **Step 1: Write failing tests for `TenantAdminCapabilities.For`** in `tests/tenant-admin-capabilities.test.ts`: owner by matching `ownerPrincipalId` → `{ roleLabel: 'Tenant owner', capabilities: all true }`; owner by `ownerEmail` when `ownerPrincipalId` undefined; non-owner → `{ roleLabel: 'Environment admin', capabilities: { envs:true, adopt:true, access:false, settings:false } }`; tenant with neither owner field → owner (fail-open); `tenant === undefined` → owner (fail-open).
- [ ] **Step 2: Run, verify fail** (module/function missing).
- [ ] **Step 3: Implement `TenantAdminCapabilities`** (Allman, constants hoisted; `For` derives via `IsOwner` then maps role→caps per the design table). Capabilities are plain data objects (`{ a: 1 }` literal form is allowed).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Add `organisation` to the read-model.** `TenantDirectorySeed` gains `organisation?: string`; `SeededTenantDirectory` stores it and implements `GetOrganisation(tenantId)` returning it only for the seeded tenant id (else `undefined`); add `GetOrganisation` to `ITenantDirectory`. In `tenant-admin-bootstrap.ts`, add optional `organisation?` to `TenantBootstrapInput` and set `seed.organisation` from it when present (no `PlatformDirectory` call).
- [ ] **Step 6: Write failing test for `GET /tenant-api/profile`** in `tests/tenant-api-profile.test.ts` using the existing harness pattern (`ResRecorder`, a `SeededTenantDirectory` with a tenant + one hive, a constructed `TenantSession`): asserts status 200 and a `TenantProfileDto` with the tenant display name, hive id+name, `organisation` present when seeded (and absent when not), role label and caps for owner vs non-owner.
- [ ] **Step 7: Run, verify fail** (route 404s).
- [ ] **Step 8: Implement the route** in `tenant-api-endpoint.ts`: a `ProfilePath = '/tenant-api/profile'` constant, an `if (path === TenantApiEndpoint.ProfilePath)` in the `MethodGet` block calling a private `RouteProfile(res, session)` that reads `this.directory.GetTenant(session.tenantId)`, `this.directory.GetOrganisation(session.tenantId)`, `this.directory.ListHives(session.tenantId)[0]`, computes caps via `TenantAdminCapabilities.For`, and emits `TenantProfileMapper.ToDto(...)` with `this.WriteJson(res, 200, dto)`. Owner contact = tenant `ownerEmail` (fallback the owner display if later available).
- [ ] **Step 9: Run both test files, verify pass.**
- [ ] **Step 10: Typecheck** `npm run typecheck:tools` (and `npm run build` if the server tsconfig covers these files); ASCII+LF byte-scan the new/modified files.
- [ ] **Step 11: Commit** (`feat(control-plane): admin-capability model + GET /tenant-api/profile`).

### Task 2: Enforce access + settings on the write routes

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts`
- Test: `admin/control-plane/tests/tenant-api-capability-guard.test.ts`
- Possibly modify: `admin/control-plane/tests/tenant-api-mutate.test.ts` fixture (only if a session now 403s — align the fixture's owner, never weaken the guard)

**Interfaces:**
- Consumes: `TenantAdminCapabilities.For` (Task 1); the endpoint's existing write-route dispatch (`RouteAdmin`/`DispatchAdmin` at the account/grant/token/security-model/config handlers; env credential routes stay open).
- Produces: a private `RequireCapability(res, session, capability: keyof AdminCapabilities): boolean` that computes caps (via `TenantAdminCapabilities.For` using `this.directory.GetTenant(session.tenantId)`) and, when false, writes a generic 403 (`{"error":"forbidden"}`) and returns `false`; callers `return true` (handled) when it returns false.

- [ ] **Step 1: Write failing tests** in `tests/tenant-api-capability-guard.test.ts`: with a tenant whose owner does NOT match the session (non-owner), each of the seven write routes returns 403 with a generic body; with an owner-matching session each returns its pre-TA-3 success; with a no-owner tenant each is open (fail-open); a GET (snapshot) and an env action (start) stay open for a non-owner.
- [ ] **Step 2: Run, verify fail** (routes currently succeed for non-owner).
- [ ] **Step 3: Implement `RequireCapability`** and insert the guard at the head of each access route (`POST`/`DELETE accounts`, `POST`/`DELETE grants`, `POST`/`DELETE tokens`, `PUT security-model`) with capability `access`, and at `PUT config` with capability `settings`. Keep a single route→capability decision (a small private table or explicit per-handler calls); do not guard GETs, env actions, hive target, or credential routes.
- [ ] **Step 4: Run the new test file, verify pass.**
- [ ] **Step 5: Run the FULL control-plane suite** `npx tsx --test "admin/control-plane/tests/*.test.ts"`. If `tenant-api-mutate.test.ts` (or any other) now 403s, align that fixture's tenant owner to the test session (or seed no owner) so the guard is exercised honestly; do not relax the guard.
- [ ] **Step 6: Typecheck + ASCII/LF byte-scan.**
- [ ] **Step 7: Commit** (`feat(control-plane): enforce access/settings capabilities on write routes`).

### Task 3: Portal DTO, client method, and test fake

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts`
- Modify: `admin/tenant-portal/src/tenant-api-client.ts`
- Modify: `admin/tenant-portal/tests/fake-tenant-control-plane.ts`
- Test: `admin/tenant-portal/tests/tenant-api-client.test.ts` (extend if present, else add a focused test)

**Interfaces:**
- Consumes: server `TenantProfileDto`/`AdminCapabilitiesDto` shapes (Task 1) — mirror verbatim; `TenantApiClient.Send<T>(route, init)` pattern (`Session()` at client:103 is the template); the fake's `Handle` dispatch ladder + `Json(res, status, body)`.
- Produces:
  - In `tenant-types.ts`: `export type AdminCapabilitiesDto = { envs: boolean; adopt: boolean; access: boolean; settings: boolean }` and `export type TenantProfileDto = { principalId: string; email?: string; roleLabel: string; tenant: { id: string; displayName: string; organisation?: string }; hive: { id: string; displayName: string }; capabilities: AdminCapabilitiesDto; ownerContact?: string }`; extend `interface ITenantNavigator` with `get Profile(): TenantProfileDto | undefined`, `get Capabilities(): AdminCapabilitiesDto | undefined`, `get OwnerContact(): string | undefined`.
  - `TenantApiClient.Profile(): Promise<TenantProfileDto>` (GET `/tenant-api/profile`).
  - Fake: a `ProfilePath` constant + canned `TenantProfileDto` (owner, all caps, seeded org + hive display names, `ownerContact`), new canned static fields for org/role.

- [ ] **Step 1: Mirror the DTOs** into `tenant-types.ts` and extend `ITenantNavigator` with the three getters. (This will break compilation of `tenant-app.ts` and any other `ITenantNavigator` implementors — Tasks 4 implement them; test `Nav` stubs get the getters in Task 4. If the suite must stay green between tasks, add the getters returning `undefined` to existing stubs here.)
- [ ] **Step 2: Write a failing client test** asserting `Profile()` issues GET `/tenant-api/profile` and returns the parsed DTO (reuse the existing client-test harness / fetch stub pattern).
- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement `Profile()`** on `TenantApiClient` (route constant hoisted, `return await this.Send<TenantProfileDto>(TenantApiClient.ProfileRoute, undefined)`).
- [ ] **Step 5: Extend the fake** with the `/tenant-api/profile` branch returning the canned owner profile; canned org/role/caps as static fields next to the existing identity constants.
- [ ] **Step 6: Run portal tests + `typecheck`.** Verify fail only where Tasks 4/5 are pending (navigator getters on the real app); the client test + fake compile.
- [ ] **Step 7: ASCII/LF byte-scan; commit** (`feat(tenant-portal): profile DTO + client Profile() + fake`).

### Task 4: Wire the identity plate, user menu role, and boot

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts`
- Modify: `admin/tenant-portal/src/user-menu.ts`
- Modify: `admin/tenant-portal/tests/tenant-app.test.ts` (+ the `Nav`/navigator stubs there)
- Test: `admin/tenant-portal/tests/user-menu.test.ts` (extend)

**Interfaces:**
- Consumes: `TenantApiClient.Profile()` (Task 3); `TenantProfileDto`, the `ITenantNavigator` getters (Task 3); `IdentityPlate({ org?, tenant, hive })` (unchanged); `TenantApp.HivePlaceholder` fallback constant.
- Produces: `UserMenu` ctor input `roleLabel?: string` + rendered role line; `TenantApp` holds `private profile: TenantProfileDto | undefined` and implements `get Profile()/get Capabilities()/get OwnerContact()`; `Boot` fetches the profile with fallback (R5).

- [ ] **Step 1: Write failing tests.** `tenant-app.test.ts`: a stub client whose `Profile()` returns a DTO (org "Northwind Group", tenant display "Northwind Production", hive display "hv-...") → after `Boot`, the plate shows those three and the user menu shows the role label; a stub whose `Profile()` throws → plate shows `session.tenantId`, no org, `HivePlaceholder`, and `Capabilities` is `undefined` (permissive). `user-menu.test.ts`: role label rendered when passed, absent cleanly when not.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `UserMenu` role line** (ctor `roleLabel?`, hoisted no-literal; render under the email; keep `InitialsFor`).
- [ ] **Step 4: Implement `Boot` + navigator getters** in `tenant-app.ts`: after `Session()`, `try { this.profile = await this.client.Profile() } catch { this.profile = undefined }`; `BuildTopBar` uses the profile when present (`org: profile.tenant.organisation`, `tenant: profile.tenant.displayName`, `hive: profile.hive.displayName`, `roleLabel: profile.roleLabel`) else the TA-2 fallback; add `get Profile()/Capabilities()/OwnerContact()` returning from `this.profile`.
- [ ] **Step 5: Update the test `Nav`/navigator stubs** to implement the three getters (return a fixture profile or `undefined`).
- [ ] **Step 6: Run portal tests + `typecheck`, verify pass.**
- [ ] **Step 7: ASCII/LF byte-scan; commit** (`feat(tenant-portal): wire identity plate + user-menu role from profile`).

### Task 5: Gate the Users & Access hub on the access capability

**Files:**
- Modify: `admin/tenant-portal/src/users-access-hub-view.ts`
- Test: `admin/tenant-portal/tests/users-access-hub-view.test.ts` (extend)

**Interfaces:**
- Consumes: `ITenantNavigator.Capabilities`/`OwnerContact` (Tasks 3/4); kit `ScreenHost` (`ScreenHostInputs { allowed, ... , denied?: DeniedStateConfig }`, resolves Denied when `!allowed`); `DeniedStateConfig { what?, need?, who? }`.
- Produces: the hub resolves a Denied `ScreenHost` when `access` is false, else its existing default `UsersAccessView` + sub-screen button row.

- [ ] **Step 1: Write failing tests.** With a navigator whose `Capabilities.access === false`, the hub's `ScreenHost.State === Denied` and the denied copy carries `what` "Users & Access", `need` "the Manage users & access permission", `who` = `Navigator.OwnerContact`. With `access === true` (or `Capabilities === undefined`, the permissive fallback), the hub shows the populated content and the sub-screen row.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement the gate:** in the hub's build, read `this.Navigator?.Capabilities?.access`; treat `undefined` as allowed (permissive fallback); wrap the content in a `ScreenHost({ allowed, denied: { what, need, who } })` (constants hoisted). Keep the existing routing when allowed.
- [ ] **Step 4: Run portal tests + `typecheck`, verify pass.**
- [ ] **Step 5: ASCII/LF byte-scan; commit** (`feat(tenant-portal): gate Users & Access hub on the access capability`).

## Self-review notes

- Spec coverage: capability model (T1), profile route + identity + org (T1), enforcement/honesty invariant (T2), portal DTO/client/fake (T3), plate + user-menu role + boot/fallback (T4), Users & Access denied gating (T5). All design goals mapped.
- Type consistency: `AdminCapabilities` (server) and `AdminCapabilitiesDto` (portal) are the same four-boolean shape; `TenantProfileDto` identical field-for-field across `tenant-profile-dto.ts` and `tenant-types.ts`; `TenantAdminCapabilities.For` is the sole derivation used by both route (T1) and guard (T2).
- Proportion: plan carries interfaces + exact DTO shapes + the route→capability map; bodies left to the implementer except where the signature fixes them.
