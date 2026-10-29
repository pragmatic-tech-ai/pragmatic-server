# Per-Hive Release Policy — holds, floors + the floor-blocked tag (deferred burn-down D4)

**Status:** design — FORK RESOLVED 2026-10-29: Q1 = **most-restrictive (max) floor**; Q2 = **include per-hive channels**.
**Date:** 2026-10-29
**Program:** Program 2 deferred burn-down, spec D4. Completes the PA-G5 release-policy granularity.

## Intent and why

PA-G5 shipped a per-TENANT release policy (one fail-closed evaluator:
withdrawn → hold → channel-subscription → min-version floor). But a tenant
can own multiple hives (`directory.ListHives(tenantId)` is 1:many), and an
operator sometimes needs to act on ONE hive without touching the tenant's
others — **freeze a single hive** (a customer mid-incident) or **raise a
sensitive hive's version floor** — leaving the rest of the tenant's hives
unaffected. Today there is no per-hive knob.

Separately, the operator portal's blocked-reason tag
(`ReleasePolicyViewModel.BlockedLabel`) recomputes the withdrawn, channel and
hold reasons but NOT the version floor — it has no version comparator — so a
version blocked *only* by the floor shows no reason (the PA-G5 deferred
"floor-only-blocked row tag, needs a portal comparator — skipped").

## Goals

- **Per-hive HOLD** and **per-hive FLOOR** (min-version), composed with the
  tenant policy inside the SAME single fail-closed evaluator, applied on the
  **pull** path (`AdoptableFor(hive)`) and the **push** path
  (`Record(hiveId,…)` / `SelectTarget` / `RecordAdoption`) — the paths that
  have a concrete hive. The tenant-wide offered list (`AdoptableForTenant`,
  `GET /api/tenants/:id/manifests`) stays tenant-only (no hive context).
- **Operator host routes** to set/clear a hive hold and a hive floor,
  mirroring the tenant-policy routes, Full-gated (operator-only; the
  tenant-admin app gets no per-hive policy control).
- **Portal:** show per-hive policy + controls, and recompute the
  **floor-only-blocked tag** with a replicated portal version comparator.

## Composition rules

- **Hold is additive (ruled, NOT forked):** a version is held for a hive if
  the tenant is held OR that hive is held. A per-hive hold can only *add* a
  block; it never lifts a tenant hold. (A hold is purely restrictive, so
  additive is the only safe reading.)
- **Floor composition (Q1 = most-restrictive):** effective floor =
  `max(tenant.minVersion, hive.minVersion)` by `VersionOrder`. A per-hive
  floor can only raise, never lower below the tenant floor.
- **Channel composition (Q2 = include per-hive channels; most-restrictive to
  match Q1):** a version is channel-blocked for a hive if the tenant's
  non-empty channel set excludes the manifest's channel OR the hive's
  non-empty channel set excludes it — i.e. the allowed set is the
  INTERSECTION of the two non-empty sets (an absent/empty set at a level =
  no restriction at that level). A per-hive channel subscription can only
  narrow within what the tenant allows; it can never admit a channel the
  tenant forbids (a hive subscribed only to a tenant-forbidden channel sees
  nothing — fail-closed).
- Evaluation order is unchanged: withdrawn → hold(tenant OR hive) →
  channels(tenant AND hive) → floor(max). `withdrawn` is manifest-level
  (hive-independent).

## Open decisions (FORK)

### Q1 — per-hive floor composition (security-sensitive)

- **A. Most-restrictive — effective floor = max(tenant floor, hive floor).**
  A hive can be floored *higher* than its tenant, but a per-hive floor can
  never let a hive adopt a version *below* the tenant floor. Fail-closed: a
  per-hive knob can only tighten, never loosen tenant-level safety.
  **(Recommended.)**
- **B. Hive-overrides-tenant — the hive floor replaces the tenant floor for
  that hive** (when set). Enables a *lower* per-hive pin (canary/exception
  hive on an older line), but a per-hive floor can then let a hive escape a
  tenant-level minimum.

> They differ only when a hive floor is set *below* the tenant floor; when
> the hive floor is higher, both yield the hive floor.

### Q2 — scope

- **A. Per-hive HOLD + FLOOR only** (channels stay tenant-level). Matches the
  deferred's wording; tightest surface. **(Recommended.)**
- **B. Also per-hive CHANNEL subscription** (a hive could sit on `early`
  while its tenant is `stable`). More surface (another mutation, route,
  control, and a channel-composition rule to decide).

## Design (decided parts)

- `ReleasePolicyRecord` gains optional `hiveId?: string`. A **tenant policy**
  keeps `id == tenantId`; a **hive policy** is stored under a hive-scoped key
  (e.g. a `h:<hiveId>` prefix so it can't collide with a tenant id) and
  carries both the owning `tenantId` and `hiveId`. Only `hold`/`minVersion`
  are meaningful on a hive policy (channels per Q2).
- `BlockReasonFor(tenantId, hiveId: string | undefined, manifest)` — the one
  evaluator both planes call; `hiveId === undefined` means tenant-only
  (offered list), a concrete `hiveId` composes the hive policy per the rules
  above. Pull/push paths pass the real hive id.
- New registry mutations: `SetHoldForHive` / `ClearHoldForHive` /
  `SetMinVersionForHive` / `ClearMinVersionForHive`, mirroring the tenant
  ones. `AllPolicies()` already returns the whole list (tenant + hive rows).
- Host: a `HivePolicyPathPattern` for `/api/hives/:id/policy/(min-version|hold)`
  mirroring `RouteTenantPolicy`; Full-gated; same 400/409 error mapping.
- Portal: a replicated `VersionOrder`-style comparator so `BlockedLabel`
  adds the floor reason; per-hive policy rows/controls in the release-policy
  view (display + set/clear).

## Constraints (Global)

- New `.ts`: ASCII, LF. Byte-scan each touched file; preserve each file's base
  EOL (several admin files are CRLF at base — match base, don't flip).
  `control-plane-host.ts` keeps its 6 non-ASCII bytes.
- OOP + Allman; no module-level free functions/state; no inline string
  literals; enums over string unions; VMs extend `Observable`; PascalCase.
  `admin/portal` must not import from `admin/control-plane` (replicate the
  comparator).
- Gates: control-plane `npx tsx --test …/tests/*.test.ts` + `typecheck:tools`;
  portal `npm --prefix admin/portal test` + typecheck.
- Merge locally (ff-only); **NEVER push.**

## Review focus

- **Fail-closed composition:** the pull/push evaluator must apply the hive
  rules; a per-hive hold or floor must block exactly the intended hive and no
  other hive of the same tenant. (Per Q1-A a hive can never adopt below the
  tenant floor.)
- **Offered-list unchanged:** `AdoptableForTenant` / the tenant-admin offered
  list stays tenant-only — no per-hive leakage into a tenant-wide view.
- **reported == enforced:** the portal floor tag must match what the
  evaluator actually blocks (same comparison), including the composed floor.
- **Key isolation:** a hive-policy key can never collide with a tenant-policy
  key; clearing one never clears the other.
- **Back-compat:** a tenant with no hive policy behaves exactly as PA-G5.
