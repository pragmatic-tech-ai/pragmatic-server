# TA-13 - Settings (Hive & domain, Tenant profile, Identity provider) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD).
**Area:** Tenant Admin > Settings (left-nav item, currently a ComingSoon placeholder).
**Builds on:** the left-nav shell (`NavSection.Settings`), the existing `GET admin/profile` (`TenantProfileDto`) and hive list (`HiveDto`).
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 1.7 and section 4 item 13.

## The scope decision (recon finding + ruling)

The design's Settings page is editable (Tenant profile Edit) and has credential Rotate/Revoke. Recon found the backend does not support those, by deliberate architecture:

- **`ITenantDirectory` is read-only on purpose** - its own doc says "only what it reads, nothing it could mutate." The less-trusted self-service tenant plane cannot write platform directory records. There is **no tenant-profile update path**, and adding one would cross the trust boundary the architecture draws. So **Tenant-profile Edit is deferred** (filed GAP), not faked.
- **`HiveRecord` carries no `baseDomain`/`region`/`namespace`/address-pattern** - only `displayName`, `cluster { backend, mode }`, `registry { mode, endpoint }`, `createdAt`. Those design fields do not exist; showing them would fabricate data. **Hive & domain shows the real fields, read-only**; the missing fields are deferred.
- **`TenantRecord` carries the tenant's own IdP coordinates by reference** - `idpBaseUrl`, `idpCaRef`, `idpAdminTokenRef` (references, the CA material and admin token themselves are never stored here). There is **no stored issuer/session-lifetime/MFA/federation config**, and **no Rotate/Revoke mechanism** in the tenant plane (the directory is read-only; rotation is a platform/IdP operation the tenant admin cannot perform here). A Rotate/Revoke button that rotates nothing would be dangerously dishonest about a security control, so those are **deferred**.
- `HiveDto` deliberately omits raw server-side reference names from the tenant surface ("the less-trusted self-service tenant has no use for" `agentTokenRef`/`configRef`/...). TA-13 keeps that posture: it never exposes a raw `idpCaRef`/`idpAdminTokenRef` string; it reports only the tenant's own IdP **base URL** (which the tenant already knows - it is where their users sign in) and a **presence** indicator (configured / not configured) per credential.

**Ruling: TA-13 is a read-only Settings page.** It shows exactly what exists, honestly, with one minimal backend touch (below). Everything editable, rotatable, or backed by config that does not exist is a deferred GAP. This is the standing never-invent-a-backend / secrets-by-reference-only / reported==enforced discipline applied to a security-sensitive surface.

## The one honest backend touch

`GET admin/profile` already loads the `TenantRecord` to build `TenantProfileDto`. TA-13 **extends `TenantProfileDto` with an optional `idp` presence block** - no new route:

```
idp?: { baseUrl?: string; signingCaConfigured: boolean; adminTokenConfigured: boolean }
```

derived in `TenantProfileMapper` from `TenantRecord.idpBaseUrl` and the *presence* of `idpCaRef` / `idpAdminTokenRef`. The raw ref strings and any secret material are **never** placed on the DTO - only the base URL (safe) and two booleans. This is the minimal, safe way to give the IdP tab real content without a mutation surface or a leak.

## Goals

- A **Settings** page replacing the ComingSoon placeholder on `NavSection.Settings`, with three tabs via the kit `Tabs`.
- **Hive & domain** (read-only): the hive's display name, cluster backend/mode, registry mode/endpoint, created-at - from the existing `HiveDto`. An honest note that these are platform-managed and read-only.
- **Tenant profile** (read-only): tenant display name, id, organisation, owner contact, the signed-in admin's role label, and the hive name - from the existing `TenantProfileDto`. The "Edit" affordance is **absent** (not a disabled button that implies a capability); a one-line honest note that profile changes are made by the platform operator.
- **Identity provider** (read-only): the tenant's IdP **base URL** (issuer), and a credential presence list rendered with the kit `SecretTable`-style by-reference display - entries "Signing CA" and "Admin token" with a Configured / Not configured status and **no value, no raw ref, and no Rotate/Revoke action** (deferred). An honest note that IdP credentials are managed by the platform and shown by reference only.
- Honest **loading / error / permission / empty** states via `ScreenHost`.
- The page is **read-only**: it reads the profile (and the hive) once and renders.

## Non-goals

- **Tenant-profile editing** - no write path exists (read-only directory by architecture); deferred GAP.
- **Credential Rotate/Revoke** and a `smtp-relay` credential - no rotation mechanism; no smtp-relay ref on the record; deferred GAP. Absolutely no button that claims to rotate/revoke a secret it cannot.
- **IdP issuer-vs-baseUrl distinction, session lifetime, MFA, federation config** - not stored; deferred GAP.
- **Hive baseDomain / region / namespace / address-pattern** - not on `HiveRecord`; deferred GAP.
- **Exposing raw `idpCaRef`/`idpAdminTokenRef` strings or any secret value** - never; presence booleans + base URL only.
- A new mutation route or any change to `ITenantDirectory`'s read-only contract.

## Anti-goals (a failure even if it "works")

- A Rotate/Revoke or Edit control that looks functional but changes nothing - the honesty invariant on a *security* control; reported == enforced. If it cannot act, it is not shown.
- Leaking a raw credential reference name or value onto the tenant surface - keep the `HiveDto` posture.
- Showing a fabricated base domain / region / session-lifetime to fill the mockup.
- Anything cross-tenant/hive/platform.

## Information architecture (the decided shape)

- `NavSection.Settings` renders a new `SettingsView` (replacing the ComingSoon placeholder), with a kit `Tabs` of three entries: **Hive & domain**, **Tenant profile**, **Identity provider**.
- A `SettingsViewModel` (extends `Observable`) backed by a thin `ISettingsSource` that reuses the existing reads: `GetProfile(): Promise<TenantProfileDto>` and `ListHives(): Promise<HiveDto[]>` (both already on `TenantApiClient`). The IdP presence comes from `TenantProfileDto.idp` (the extension). 401 -> rethrow to login; 403 -> Forbidden; else -> Error; no profile/hive -> honest empty.
- Each tab is a read-only key/value display (reuse the kit `KeyValueGrid`/`Section`); the IdP credential list reuses the `SecretTable`-style by-reference rendering but with no Revoke action (or a plain read-only presence list if a no-action SecretTable is awkward - builder's call).

## What's left to the builder (plan + implementation calls)

- Exact copy for each tab's fields, the read-only/platform-managed notes, and the "Configured / Not configured" statuses (all hoisted to `private static readonly`; reuse the TA-8 `SecretTable`/`PillKind` and the kit `KeyValueGrid`/`Section`/`Tabs`/`ScreenHost`).
- Whether the IdP credential presence uses `SecretTable` with `canRevoke:false` (no Revoke rendered) or a simpler read-only list - prefer whichever renders cleanly with no action affordance.
- The exact `idp` presence derivation in `TenantProfileMapper` (base URL copied as-is; `signingCaConfigured = idpCaRef !== undefined`; `adminTokenConfigured = idpAdminTokenRef !== undefined`) and a server test asserting the DTO never carries the raw refs or any value.
- Whether the Tenant-profile and Hive tabs read the hive from `ListHives()[0]` (one hive per tenant, as Overview/Releases/Connection do) or from `TenantProfileDto.hive` - prefer the profile's `hive` for the name and the hive list only if more cluster/registry detail is needed.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public, no inline string literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `admin/tenant-portal/tests/` (portal) and the control-plane's `tests/` (server).
- New portal `.ts` files pure ASCII + LF; byte-scan after every write. The server DTO change is in `admin/control-plane/tenant-api/tenant-profile-dto.ts` - match that file's existing EOL (check and preserve; do not `sed -i` if CRLF). `tenant-app.ts` is CRLF - change only the one Settings nav case + import.
- **Security:** the server change exposes base URL + two booleans ONLY; a server test must assert no raw ref / no secret value is ever serialized. Nothing cross-tenant; reported capability == enforced.
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Server gate: repo-root `npm test` + `typecheck:tools`. BOTH green on the merged result (TA-13 is the first TA spec that touches the server, so the control-plane suite matters).

## Review focus (inputs no happy-path test exercises)

- The extended `TenantProfileDto.idp` **never** carries `idpCaRef`/`idpAdminTokenRef` raw strings or any secret material - only `baseUrl` + two booleans. (Server test.)
- A tenant with no IdP configured (`idpBaseUrl`/refs absent, pre-6c tenant) -> the IdP tab shows an honest "not configured" state, not a crash or a blank. (Both layers.)
- A 401 from the profile read -> login (not an error tab); 403 -> Forbidden; other -> Error. (VM tests.)
- No hive / no profile -> honest empty, not a misleading populated tab. (VM tests.)
- No Edit, Rotate, or Revoke control renders anywhere on the page (grep-gate / view test) - the deferred security controls must not appear as dead buttons.
- The Hive & domain tab shows only the real fields; no baseDomain/region/namespace placeholder appears. (View test.)
