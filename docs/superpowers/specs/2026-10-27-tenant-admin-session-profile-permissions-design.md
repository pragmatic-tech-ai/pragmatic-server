# Tenant-Admin Session Profile & Admin Permissions (SP-ADMIN TA-3) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, server `admin/control-plane/*` + portal `admin/tenant-portal/*`. Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Admin-apps build → Tenant Admin. Third tenant spec (after TA-1 UI kit @114195d, TA-2 shell/IA @ad5b9d7). First TA spec with server work. Reconciliation: `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` (§0.4, §1.5, §3 "Shell/all" rows).
**Design source:** `dev-kit/design/admin-apps/src/tctx.jsx` (`canDo`), `tenant-data.js` (`ADMIN_PERMS`, `roles[].admin`, `tenant` identity, `me`), `tenant.jsx` (identity plate, user menu role, `Act`/denied copy), `tenant2.jsx` (Users & Access denied); brief §5.1/§5.5/§6.1/§6.4.

## Intent

Give the tenant portal a real answer to "who am I, where am I, and what may I do." Today the identity plate shows a raw `tenantId`, the user menu shows only an email, and every action is unconditionally enabled because the server grants every authenticated tenant session full admin power. TA-3 replaces all three with truth: a single server read (`GET /tenant-api/profile`) returns the tenant display name, organisation and hive identity for the plate, the admin's role label for the user menu, and the admin's four admin capabilities — and the server **enforces** the capabilities it reports, so the UI never claims a denial that wouldn't happen (nor enables an action that would 403). This is the enabler TA-8 (Users & Access) and TA-13 (Settings) gate on, and it lights up the kit's already-built `Act` (visible-when-denied) and `ScreenHost` Denied state end-to-end.

## The four admin capabilities (design vocabulary, verbatim)

From `tenant-data.js:9` `ADMIN_PERMS`:

| id | label | help |
|---|---|---|
| `envs` | Manage environments | Create, start, stop, restart and delete environments. |
| `adopt` | Adopt versions | Move environments to a newer version offered by Pragmatic. |
| `access` | Manage users & access | Create and disable accounts, grant roles, issue tokens and edit this security model. |
| `settings` | Manage tenant settings | Change the tenant profile and identity provider settings. |

The design's two portal roles and their capabilities (`tenant-data.js:43-44`): **Tenant owner** → all four true; **Environment admin** → `envs` + `adopt` true, `access` + `settings` false.

## Goals

- A **server-authoritative capability model**: one helper (`TenantAdminCapabilities`) derives, from the validated `TenantSession` + the tenant read-model, (a) a `roleLabel` and (b) the four capability booleans. The derivation is the **single source of truth** used by both the profile read and the route guard, so reported capabilities and enforced capabilities cannot drift.
- A new gated read **`GET /tenant-api/profile`** returning a `TenantProfileDto`: principal + email, role label, tenant identity (id, display name, organisation), hive identity (id, display name), the four capabilities, and the owner contact (for the denied "ask X" copy). Session-tenant-scoped, generic errors, **no secret material**.
- **Server enforcement** of the two capabilities whose routes exist today: `access` gates the Users & Access **write** routes (accounts create/delete, grants, tokens issue/revoke, security-model PUT); `settings` gates `PUT admin/config`. A denied capability returns a generic **403**. `envs`/`adopt` routes stay open (returned `true` for everyone — honest, matching no enforcement yet; TA-4/5/6 own those routes).
- A portal **client method** `Profile()`, the **DTO** mirrored into `tenant-types.ts`, and the test fake extended with a `/tenant-api/profile` branch.
- **Wire the plate**: `IdentityPlate` fed real `{ org, tenant: displayName, hive: displayName }` (it already omits org when absent). **Wire the user menu**: show the role label. Both at `TenantApp.Boot`, from one `Profile()` read held on the app.
- **Gate Users & Access** on `access`: `UsersAccessHubView` resolves the kit `ScreenHost` **Denied** state (copy from the profile's owner contact) when `access` is false, instead of routing into the sub-screens.
- Every new surface covers the five states; the denied state is **shown, not hidden**.

## Non-goals / anti-goals (this spec)

- **Enforcing `envs`/`adopt`, or gating their UI.** Those routes stay open and their caps return `true`; TA-4/TA-5/TA-6 own that UI and may tighten the routes then. TA-3 only carries the booleans.
- **A full admin-role store / assigning admin roles.** TA-3 derives the role from the one real signal the server already has (the tenant's recorded owner). There is no UI or API to *assign* "Environment admin" to a principal; every non-owner authenticated portal session **is** an Environment admin. A richer admin-RBAC store is a later Feature if the product needs more than owner/non-owner.
- **Read-gating the Users & Access GETs.** `access` is "Manage" = write. Reads stay open; the UI's Denied state is a UX choice not to show an area you cannot manage, which remains honest because no management action is reachable.
- **Settings UI.** There is no Settings screen yet (TA-13); `settings` is carried and `PUT admin/config` is enforced, but no view gates on it in TA-3 (the Settings nav item is still `ComingSoon`).
- **Operator/platform-plane roles.** `OperatorRole` (Full/ReadOnly) is the platform console; untouched.
- **Multi-hive selection.** One-tenant/one-hive holds; the plate's hive is the tenant's single hive (first by creation if several seeded). TA-12 owns real hive/connection identity.

## Rulings

- **R1 — one derivation, used by both the read and the guard.** `TenantAdminCapabilities.For(session, tenant)` returns `{ roleLabel, capabilities }`. The profile handler and every capability guard call *this* function; neither computes capabilities independently. *Why:* the brief's honesty rule ("denied shown, not hidden"; never fabricate) requires reported == enforced. A single function makes that true by construction. *Cost if wrong:* n/a — structural.
- **R2 — role derivation: owner vs Environment admin, from the recorded tenant owner.** A session is **Tenant owner** iff the tenant record records an owner and it matches the session (`ownerPrincipalId === session.principalId`, or `ownerEmail === session.email` when the principal id is unset). **Fail-open on a missing owner:** if the tenant record records *no* owner at all, treat the session as owner (we cannot distinguish, and the alternative locks out all access/settings management — a fabricated denial, which is worse than a fabricated grant the provisioner is expected to prevent). Any other authenticated session is **Environment admin**. *Why:* `ownerPrincipalId`/`ownerEmail` is the only real role signal server-side (`platform-records.ts:40-42`); production provisioning sets it, so fail-open only affects legacy/test tenants. *Cost if wrong:* a later admin-role store refines the mapping; the capability seam is unchanged.
- **R3 — capability → route map (what `access`/`settings` actually gate).** `access` gates: `POST .../admin/accounts`, `DELETE .../admin/accounts/:principal`, `POST`+`DELETE .../admin/grants`, `POST`+`DELETE .../admin/tokens`, `PUT .../admin/security-model`. `settings` gates: `PUT .../admin/config`. Everything else (all GETs, env start/stop/restart/create, hive target, env credential ops) stays open. Denied → generic **403** (`TenantApiError.ForbiddenStatus`, added B1-3). *Why:* "Manage users & access" / "Manage tenant settings" are exactly these writes. *Cost if wrong:* the map is one table in the endpoint; adjusting membership is local.
- **R4 — `GET /tenant-api/profile` is a new gated tenant-api route, not a tenant-auth change.** It needs the directory (`GetTenant`, `ListHives`) and the validated session, both in scope in `TenantApiEndpoint.Handle`. The existing `GET /tenant-auth/session` (`{tenantId, principalId, email?}`) is unchanged and stays the auth probe. *Why:* profile is tenant-scoped data, not auth. *Cost if wrong:* moving it is mechanical.
- **R5 — boot keeps `Session()` as the auth probe; `Profile()` is a second read, with graceful fallback.** `Boot` calls `Session()` (null → login) then `Profile()`. If `Profile()` fails (older server without the route, or any error), fall back to TA-2 behaviour: plate `tenant = session.tenantId`, no org, hive placeholder, no role label, and capabilities **default permissive** (no gating) — never fabricate a denial from a failed read. *Why:* two small reads at boot is fine; the fallback keeps the portal usable against a server that has not deployed the route. *Cost if wrong:* n/a.
- **R6 — organisation is optional end-to-end, threaded through the seed read-model.** The org name is the platform's `ClientRecord.displayName`, absent from the tenant plane. Add an optional `organisation` to the tenant directory read-model (the hive's denormalized seed snapshot — the hive must not call back to the platform for it), populated at bootstrap from the provisioning input when supplied; the profile reads it and the plate shows it, omitting the segment when absent (already supported). *Why:* "converge to the designs" + "build backends as needed", but without a deep `PlatformDirectory` coupling in the hive. *Cost if wrong:* if the provisioner never supplies it, the plate reads "tenant / hive" — honest and strictly better than today's raw id.
- **R7 — gate Users & Access at the hub, server enforcement behind it.** `UsersAccessHubView` shows the kit Denied state when `!access` (copy: what "Users & Access", need "the Manage users & access permission", who the owner contact) rather than routing into the four sub-screens. The server 403 enforcement (R3) stands behind it so a direct call is still refused. *Why:* the design shows the whole area denied for Environment admins (`tenant2.jsx:80`). *Cost if wrong:* the gate is one `ScreenHost` wrap; removing it is trivial.

## Architecture

**Server (`admin/control-plane/`):**

| File | Change |
|---|---|
| `tenant-api/tenant-admin-capabilities.ts` (new) | `TenantAdminCapabilities` — `static For(session: TenantSession, tenant: TenantRecord \| undefined): { roleLabel: string; capabilities: AdminCapabilities }`; the role-derivation (R2) and the role→caps map (design table). `AdminCapabilities` type `{ envs; adopt; access; settings }`. Role-label constants. |
| `tenant-api/tenant-profile-dto.ts` (new) | `TenantProfileDto` + `AdminCapabilitiesDto` wire types + a mapper assembling them from session + tenant record + hive record + capabilities + owner contact. |
| `tenant-api/tenant-directory.ts` | `ITenantDirectory`: add `GetOrganisation(tenantId: string): string \| undefined` (reads the seed's optional org). |
| `tenant-api/seeded-tenant-directory.ts` | `TenantDirectorySeed`: optional `organisation?: string`; implement `GetOrganisation`. |
| `tenant-admin-bootstrap.ts` | thread an optional `organisation` from `TenantBootstrapInput` into the seed (populate when supplied). |
| `tenant-api/tenant-api-endpoint.ts` | add `GET /tenant-api/profile` (reads `GetTenant`/`GetOrganisation`/`ListHives`[0] + `TenantAdminCapabilities.For`, emits `TenantProfileDto`); apply the capability guard (R3) on the seven write routes — a `RequireCapability` helper that computes caps via the same `TenantAdminCapabilities.For` and writes generic 403 when false. |

**Portal (`admin/tenant-portal/`):**

| File | Change |
|---|---|
| `src/tenant-types.ts` | add `AdminCapabilitiesDto`, `TenantProfileDto` (mirrored verbatim); extend `ITenantNavigator` with `get Profile(): TenantProfileDto \| undefined` (and convenience `get Capabilities(): AdminCapabilitiesDto \| undefined`, `get OwnerContact(): string \| undefined`, derived from it). |
| `src/tenant-api-client.ts` | `async Profile(): Promise<TenantProfileDto>` (GET `/tenant-api/profile`, Send<T> shape). |
| `src/tenant-app.ts` | `Boot`: after `Session()`, `Profile()` with try/fallback (R5); hold the profile; build plate from `{ org: organisation, tenant: tenant.displayName, hive: hive.displayName }`; pass `roleLabel` to `UserMenu`; implement the navigator getters. |
| `src/user-menu.ts` | ctor input `roleLabel?: string`; render it under/next to the email (role label was explicitly deferred here in TA-2). |
| `src/identity-plate.ts` | no change (already `{ org?, tenant, hive }`). |
| `src/users-access-hub-view.ts` | wrap content in a kit `ScreenHost` gated by `Navigator?.Capabilities?.access !== false`; Denied `{ what, need, who: Navigator?.OwnerContact }` when denied. |
| `tests/fake-tenant-control-plane.ts` | `/tenant-api/profile` branch returning a canned `TenantProfileDto` (owner, all caps, org + hive names); canned constants for org/role. |

**Capability honesty invariant (the property the whole spec turns on):** for any session, the `capabilities` object returned by `GET /tenant-api/profile` equals the set of capability-gated routes that session may call without a 403. Guaranteed by R1 (one derivation) + R3 (the guard calls it).

## Trust-boundary / security UX

- **No secrets.** The profile carries identity and booleans only — no tokens, no credential refs, no secret values.
- **Reported == enforced** (the honesty invariant). The `Act`/`ScreenHost` denied affordances now reflect real server behaviour; a denied button is one that really would 403.
- **Session-tenant-scoped**, generic errors, 404-not-403 on foreign resources preserved for the new route (it only reads the session's own tenant).
- **Fail-open on missing owner** (R2) is a deliberate, documented choice: a fabricated *grant* that provisioning is expected to prevent, chosen over a fabricated *denial* that would lock a real owner out of access management.
- **No cross-tenant/hive hint, no platform affordance** in any new copy; the role label and plate describe this one tenant/hive only.

## Testing

- **Server (`admin/control-plane/tests/*.test.ts`, node:test via `tsx`):**
  - `TenantAdminCapabilities.For`: owner (matching principal → all true, label "Tenant owner"); owner-by-email when principal unset; non-owner (envs/adopt true, access/settings false, label "Environment admin"); no-owner-recorded → owner (fail-open).
  - `GET /tenant-api/profile`: returns tenant display name, hive id+name, org when seeded / omitted when not, role label and the four caps; owner vs non-owner differ as above; foreign tenant not reachable (host scoping).
  - **Enforcement:** non-owner → 403 on each of the seven write routes (accounts ×2, grants ×2, tokens ×2, security-model PUT, config PUT) with a generic body; owner → the pre-TA-3 success; no-owner tenant → open (fail-open); GETs and env/adopt routes open for everyone. **Review Focus:** confirm existing `tenant-api-mutate.test.ts` sessions still pass — they rely on fail-open (no owner seeded) or an owner-matching session; adjust the test directory's owner if a mutate test now 403s.
- **Portal (`admin/tenant-portal/tests/*.test.ts`, `tsx --test`):**
  - `TenantApiClient.Profile()` shape; stub-client `Boot` builds the plate from the profile (org/tenant/hive) and the user menu shows the role label; **fallback path** — a throwing `Profile()` yields the TA-2 plate (tenantId, no org, placeholder hive) and permissive (ungated) capabilities.
  - `UserMenu` renders the role label when given, omits it cleanly when absent.
  - `UsersAccessHubView`: Denied state (with the owner-contact "who") when `access` is false; populated routing when true.
  - e2e fake compiles and serves `/tenant-api/profile`; the existing Playwright spec still boots.
- **Gates:** `npx tsx --test "admin/control-plane/tests/*.test.ts"`; `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`; root `npm test` (unchanged `src/**`) stays green. All touched files **LF**, **pure ASCII** (straight apostrophes; em dash `—` in `.ts`; docs may use real em dash) — verify with a byte scan, not grep (bit TA-1 twice). OOP/Allman/PascalCase/no-inline-literals; any VM extends `Observable`. DTOs mirrored by hand into `tenant-types.ts` (the portal never imports pragmatic-protocol).

## Left to the plan

Exact field layout of `UserMenu`'s role line (stacked under email vs chip); whether the navigator exposes `Profile` only or also the `Capabilities`/`OwnerContact` conveniences (recommend both, derived); the precise `RequireCapability` helper signature and where the route→capability table sits in the endpoint; whether `TenantBootstrapInput` gains `organisation` or the bootstrap derives it (recommend an optional input field, no `PlatformDirectory` coupling); the owner-contact string (owner display name vs email) for the denied "who"; and task decomposition (likely: (1) capabilities helper + profile DTO + route + directory/seed org + bootstrap; (2) enforce access/settings on the write routes; (3) portal DTO + client `Profile()` + fake; (4) wire plate + user menu + boot + navigator getters + fallback; (5) gate Users & Access hub on `access`).
