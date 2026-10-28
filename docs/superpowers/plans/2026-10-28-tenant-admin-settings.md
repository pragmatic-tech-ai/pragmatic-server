# TA-13 Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Settings page with three tabs (Hive & domain, Tenant profile, Identity provider) showing only data that genuinely exists, plus one minimal safe backend touch: an `idp` presence block on `TenantProfileDto` (base URL + two configured-booleans, never values or raw refs). Editing, Rotate/Revoke, and unstored config are deferred GAPs - no dead controls.

**Architecture:** Mostly portal-only. `GET admin/profile` already loads the `TenantRecord`; `TenantProfileMapper` gains an optional `idp` block derived from `idpBaseUrl` + the *presence* of `idpCaRef`/`idpAdminTokenRef` (raw refs and secret material never serialized). The portal mirrors the type and renders a `SettingsView`/`SettingsViewModel` over the existing profile + hive reads - three read-only tabs, no mutation surface.

**Tech Stack:** TypeScript. Server: `admin/control-plane` (tests run from repo root). Portal: `admin/tenant-portal` (Mural kit, Observable VMs, tsx).

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-settings-design.md`

## Global Constraints

- OOP only; no module-level free functions or mutable module state. Allman braces. PascalCase public methods/interfaces. VMs extend `Observable`. `IDisposable`, not disposer lambdas.
- No inline string literals: hoist every user-facing/reused literal to `private static readonly`. Enums over string-literal unions.
- New portal `.ts` files pure ASCII + LF; byte-scan after every write (0 non-ASCII, 0 CR). The server file `tenant-profile-dto.ts` and `tenant-app.ts` have existing EOL - check and PRESERVE (byte-scan CR==LF if CRLF); never `sed -i` a CRLF file.
- **Security (binding):** the server DTO change exposes `baseUrl` + two booleans ONLY. A server test MUST assert the serialized DTO never contains the raw `idpCaRef`/`idpAdminTokenRef` values or any secret. Keep the `HiveDto` posture: no raw server-side ref names on the tenant surface.
- No new mutation route; no change to `ITenantDirectory`'s read-only contract. No DTO shape change beyond the additive optional `idp` block.
- No Edit / Rotate / Revoke control anywhere (deferred security controls must not render as dead buttons).
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Server gate: repo-root `npm test` + `typecheck:tools`. BOTH green on the merged result.

## Review Focus

- `TenantProfileDto.idp` **never** carries the raw refs or any secret - only `baseUrl` + `signingCaConfigured`/`adminTokenConfigured`. (Task 1 server test asserts the serialized JSON excludes the ref values.)
- A pre-6c tenant with no IdP coordinates -> `idp` omitted (server) and the IdP tab shows an honest "not configured" state (portal), no crash. (Both tasks.)
- 401 -> login; 403 -> Forbidden; other -> Error; no profile/hive -> honest empty. (Task 2 VM tests.)
- No Edit/Rotate/Revoke control renders. (Task 2 view/grep test.)
- Hive & domain shows only real fields; no baseDomain/region/namespace placeholder. (Task 2 view test.)

---

### Task 1: Extend `TenantProfileDto` with a safe `idp` presence block (server + portal type)

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-profile-dto.ts` (add the optional `idp` block to `TenantProfileDto` + derive it in `TenantProfileMapper.ToDto`)
- Modify: `admin/tenant-portal/src/tenant-types.ts` (mirror the optional `idp` block on the portal's `TenantProfileDto`)
- Test: the control-plane test that covers `TenantProfileMapper` (find the existing mapper/profile test under `admin/control-plane/tests/` or alongside; follow its style). If none exists, create `admin/control-plane/tests/tenant-profile-dto.test.ts` matching the repo's server test harness.

**Interfaces:**
- Consumes: `TenantRecord` (`idpBaseUrl?`, `idpCaRef?`, `idpAdminTokenRef?`), the existing `TenantProfileMapper.ToDto(session, tenant, hive, organisation, caps)`.
- Produces (used by Task 2): on BOTH the server and portal `TenantProfileDto`:
  - `idp?: { baseUrl?: string; signingCaConfigured: boolean; adminTokenConfigured: boolean }`
  - Derivation in `TenantProfileMapper.ToDto`: include the `idp` block only when the tenant has any IdP coordinate (`idpBaseUrl !== undefined || idpCaRef !== undefined || idpAdminTokenRef !== undefined`); set `baseUrl = tenant.idpBaseUrl` (omit when undefined), `signingCaConfigured = tenant.idpCaRef !== undefined`, `adminTokenConfigured = tenant.idpAdminTokenRef !== undefined`. The raw ref strings are NEVER copied onto the DTO.

- [ ] **Step 1: Write the failing server test** (control-plane): `ToDto` with a `TenantRecord` carrying `idpBaseUrl`, `idpCaRef`, `idpAdminTokenRef` yields `idp.baseUrl` + both booleans true; `JSON.stringify(dto)` does NOT contain the raw `idpCaRef`/`idpAdminTokenRef` values; a `TenantRecord` with none of the three yields `dto.idp === undefined`; a tenant with only `idpBaseUrl` yields `baseUrl` set and both booleans false.
- [ ] **Step 2: Run it, verify it fails** (repo-root `npm test` filtered to the new/edited test).
- [ ] **Step 3: Implement** the `idp` block on the server `TenantProfileDto` + the derivation in `TenantProfileMapper.ToDto`; mirror the optional `idp` type on the portal `tenant-types.ts` `TenantProfileDto`.
- [ ] **Step 4: Run green.** Repo-root `npm test` + `npm run typecheck:tools` clean; portal `npm run typecheck` clean. Byte-scan: `tenant-types.ts` LF/ASCII; `tenant-profile-dto.ts` EOL preserved.
- [ ] **Step 5: Commit** `feat(tenant-admin): expose tenant IdP presence (base URL + configured flags) on the profile DTO, never values`.

---

### Task 2: `SettingsViewModel` + `SettingsView` (three read-only tabs) + nav wiring

**Files:**
- Create: `admin/tenant-portal/src/settings-view-model.ts`, `admin/tenant-portal/src/settings-view.ts`
- Modify: `admin/tenant-portal/src/tenant-app.ts` (swap the `NavSection.Settings` ComingSoon for `SettingsView`; CRLF preserved; one case + import)
- Test: `admin/tenant-portal/tests/settings-view-model.test.ts`, `admin/tenant-portal/tests/settings-view.test.ts`

**Interfaces:**
- Consumes: Task 1's extended `TenantProfileDto` (incl. `idp`), `HiveDto`, `TenantApiError`; the kit (`Tabs`, `Section`, `KeyValueGrid`, `ScreenHost`, `StatusPill`/`PillKind`, and the `SecretTable` from TA-8 if it renders cleanly with no Revoke, else a read-only list).
- Produces:
  - `export interface ISettingsSource { GetProfile(): Promise<TenantProfileDto>; ListHives(): Promise<HiveDto[]> }` (the existing `TenantApiClient` satisfies both - no client change).
  - `export enum SettingsState { Loading, Ready, NoData, Error, Forbidden }`
  - `class SettingsViewModel extends Observable`: `get State()`, `get Profile(): TenantProfileDto | undefined`, `get Hive(): HiveDto | undefined`, `get Error()`; `async Load()`: `GetProfile()` (and `ListHives()` for cluster/registry detail; take the first hive, one per tenant); map 401 -> rethrow, 403 -> Forbidden, else -> Error; no profile -> NoData. Load-token guard for staleness.
  - `class SettingsView` (extends the view base the other full-page views use): a kit `Tabs` [Hive & domain | Tenant profile | Identity provider]; each tab a read-only `KeyValueGrid`/`Section`; the IdP tab shows `profile.idp?.baseUrl` and a credential presence list (Signing CA / Admin token -> Configured/Not configured `StatusPill`, NO Revoke); honest "not configured" when `idp` is absent; ScreenHost for Loading/Error/NoData/Forbidden; NO Edit/Rotate/Revoke controls anywhere; platform-managed/read-only notes. Test seams: `Vm`, `Tabs`, `StateHost`, per-tab host getters. Subscriptions tracked + disposed.

- [ ] **Step 1: Write failing tests:**
  - VM: Ready with a profile+hive; 401 rethrow; 403 -> Forbidden; generic -> Error; no profile -> NoData; initial Loading.
  - View: `Tabs` has the three entries; Hive & domain shows displayName + cluster backend/mode + registry mode/endpoint and NO baseDomain/region/namespace; Tenant profile shows display name/org/owner/role and has NO Edit control; Identity provider shows the base URL + "Configured"/"Not configured" per credential and has NO Rotate/Revoke control; an absent `idp` renders the honest "not configured" state; Error/NoData/Forbidden hosts render.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the VM + view + nav wiring (`tenant-app.ts` `NavSection.Settings` case constructs `SettingsView(this.client)`, CRLF preserved, import + one case only).
- [ ] **Step 4: Run green.** Portal `npm test` + `npm run typecheck`. Byte-scan the new files (LF/ASCII) + confirm `tenant-app.ts` stayed CRLF.
- [ ] **Step 5: Commit** `feat(tenant-portal): read-only Settings page - Hive & domain, Tenant profile, Identity provider (by reference)`.
