# Tenant Adoption Ledger — route + view (deferred burn-down D3)

**Status:** design (fork pending — product/UX, not a security choice)
**Date:** 2026-10-29
**Program:** Program 2 deferred burn-down, spec D3.

## Intent and why

The control-plane already records a registry-level **adoption ledger**
(`AdoptionLedgerRegistry`) — an append-only version-change timeline of
`gated | ungated | withdrawn | restored | selected | adopted` events — and
PA-G9 exposed the per-hive slice to platform operators
(`GET /api/hives/:id/ledger`). The registry also has a **`ForTenant(tenantId,
limit)`** query, but **no tenant-plane route and no tenant-admin view** — a
tenant cannot see its own version history. This spec closes that gap: a
tenant sees the timeline of what happened to the versions offered to it and
adopted by its hive.

## Goals

- A tenant-plane read route `GET /tenant-api/ledger` (name TBD in plan)
  returning the session tenant's adoption-ledger slice, newest-first,
  bounded by a `limit` query (clamped).
- The narrow `IRolloutClient` seam gains a ledger read; both the in-process
  and HTTP implementations honor it; the registry gains a
  `LedgerForTenant(tenantId, limit)` passthrough to the existing
  `AdoptionLedgerRegistry.ForTenant`.
- A tenant-admin view surfacing the timeline (placement per fork Q1), with
  friendly action labels (reusing the platform-admin ledger label mapping as
  precedent) and relative timestamps.

## Security — tenant isolation (forced, NOT forked)

The tenant-api endpoint's invariant is absolute and already enforced on every
route: the tenant id comes **only** from the gate-validated
`session.tenantId`, never from a query string or body, so a tenant-A session
can never read tenant-B's data. The ledger route follows this verbatim —
`rolloutClient.LedgerForTenant(session.tenantId, limit)`. No route, client
method, or DTO ever accepts a caller-supplied tenant id. This is a
correctness requirement, not an option; it is the #1 review invariant.

## Non-goals / anti-goals

- **No new persisted data / no backend fabrication.** `ForTenant` already
  exists; this is route + seam + view only.
- **No tenant-facing mutation** of the ledger (it is append-only, emitted by
  the registry on real version changes).
- **No cross-tenant or platform-global data** leaked to a tenant beyond what
  fork Q2 decides.
- No change to the platform-admin side (`/api/hives/:id/ledger` stays).

## Open decisions (FORK — product/UX)

### Q1 — where the tenant sees it

- **A. A "Version history" panel on the existing Releases view.** The
  Releases view is already the tenant's version/adopt surface (it lists
  manifests + drives the Adopt wizard); the ledger is the "what happened to
  these versions" companion. Symmetric with the platform-admin hive-detail
  "Version history" panel. No new nav section. **(Recommended.)**
- **B. A new "Activity" nav section** — a dedicated tenant activity page,
  symmetric with the platform-admin Activity nav. More surface, its own
  view/view-model/nav wiring.
- **C. A panel on the tenant hive-detail view** (`hive-detail-view.ts`) —
  closest to the platform-admin placement, but the tenant hive-detail is a
  less-trafficked screen than Releases.

### Q2 — scope of events shown

- **A. Tenant-scoped only** (`ForTenant` as-is): `gated`/`ungated` (carry
  `tenantId`) and `selected`/`adopted` (carry the hive's `tenantId`).
  Platform-global `withdrawn`/`restored` events carry **no** `tenantId` and
  so do not appear. No backend change, no platform-cadence leakage.
  **(Recommended.)**
- **B. Also surface `withdrawn`/`restored`** for versions, so a tenant sees
  when a version it was offered/adopted was pulled. Requires widening the
  tenant query (a version-aware union, since those records have no tenantId)
  and deliberately exposes platform withdrawal decisions to tenants. More
  backend; a transparency-vs-noise judgment.

## Anticipated files (finalized in the plan)

- `admin/control-plane/platform-deployment-registry.ts` — `LedgerForTenant`.
- `admin/control-plane/tenant-api/rollout-client.ts` — `IRolloutClient`
  ledger method + a ledger DTO.
- `admin/control-plane/tenant-api/in-process-rollout-client.ts` +
  `http-rollout-client.ts` — implement it.
- `admin/control-plane/tenant-api/tenant-api-endpoint.ts` — the route
  (session-scoped).
- `admin/tenant-portal/src/tenant-api-client.ts` + `tenant-types.ts` — client
  method + DTO.
- the view/view-model per Q1 (Releases panel / new Activity section /
  hive-detail panel).
- tests across control-plane + tenant-portal.

## Constraints (Global)

- New `.ts`: pure ASCII, LF only; byte-scan each touched file. (No file in
  this spec is `control-plane-host.ts`.)
- OOP + Allman braces; no module-level free functions/state; no inline string
  literals; enums over string unions; VMs extend `Observable`; PascalCase
  public methods. `admin/tenant-portal` is a SEPARATE app — it must NOT
  import from `admin/portal`.
- Gate asymmetry: control-plane via `npx tsx --test
  admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`;
  tenant-portal via `npm --prefix admin/tenant-portal test` + `npm --prefix
  admin/tenant-portal run typecheck`.
- Merge locally (ff-only into master); **NEVER push.**

## Review focus

- **Tenant isolation:** the route/client/DTO never accept a caller-supplied
  tenant id; a tenant-A session reading the ledger gets only tenant-A events
  (test with seeded tenant-B events present).
- **Empty/absent:** no ledger configured, or a tenant with no events →
  `[]` / empty-state, never an error.
- **Limit clamp:** an out-of-range or garbage `limit` is clamped, not
  trusted.
- **No secret / no cross-tenant field** in the DTO (only version, action,
  at, and optionally hive/env already owned by the tenant).
