# Per-Hive Release Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-hive hold/floor/channel release-policy knobs that compose most-restrictively with the tenant policy in the one fail-closed evaluator, plus the operator-portal floor-only-blocked tag.

**Architecture:** Extend the existing `ReleasePolicyRecord`/registry with hive-scoped rows; make the single `BlockReasonFor` evaluator take an optional `hiveId` and compose tenant+hive (hold OR, channels AND/intersection, floor max); apply it on the pull/push paths; add Full-gated operator routes mirroring the tenant-policy routes; surface per-hive policy + a replicated floor comparator in the operator portal.

**Tech Stack:** TypeScript (Node ESM), node:test, admin/control-plane + admin/portal (Mural kit).

**Spec:** docs/superpowers/specs/2026-10-29-per-hive-release-policy-design.md

**Owner decisions (fork 2026-10-29):** Q1 floor = **most-restrictive (max)**. Q2 scope = **include per-hive channels**. Hold = additive (hive held if tenant OR hive held). Channels = intersection (blocked if the tenant's non-empty set OR the hive's non-empty set excludes the manifest channel).

## Global Constraints

- New `.ts`: ASCII, LF. Byte-scan EVERY touched file and PRESERVE its base EOL — several admin files are CRLF at base (e.g. `api-client.ts`); match base, do not flip. `control-plane-host.ts` keeps exactly its 6 non-ASCII bytes. Scan base too: `git show <BASE>:PATH | python -c "import sys;b=sys.stdin.buffer.read();print(b.count(13),b.count(10))"`.
- OOP + Allman braces; no module-level free functions/state; no inline string literals (hoist to `private static readonly`); enums over string unions; VMs extend `Observable`; PascalCase public methods. `admin/portal` must NOT import from `admin/control-plane` (replicate the version comparator).
- Gates: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`; portal `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`. node:test summary `ℹ`; grep `"(tests|pass|fail) [0-9]"`.
- Merge locally (ff-only); **NEVER push.** Stage by explicit path. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Fail-closed composition:** a per-hive hold/floor/channel can only TIGHTEN — a hive can never adopt a version the tenant policy forbids (floor below tenant floor, or a channel the tenant excludes). Prove with tests.
- **Hive isolation:** a hold/floor on hive A does not affect hive B of the same tenant.
- **Offered-list unchanged:** `AdoptableForTenant` / `GET /api/tenants/:id/manifests` stays tenant-only (hiveId undefined) — no per-hive effect leaks into the tenant-wide list.
- **reported == enforced:** the portal floor tag uses the SAME comparison as the evaluator (same version order), including the composed max floor.
- **Key non-collision:** a hive-policy key can never equal a tenant-policy key; clearing one never clears the other.
- **Back-compat:** no hive policy → behaves exactly as PA-G5.

---

### Task 1: Record + per-hive storage mutations

**Files:**
- Modify: `admin/control-plane/release-policy-record.ts` (`+hiveId?`)
- Modify: `admin/control-plane/platform-deployment-registry.ts` (key helper + 6 hive mutations)
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (extend)

**Interfaces:**
- `ReleasePolicyRecord` gains `hiveId?: string`.
- Registry: `private static readonly HiveKeyPrefix = 'h:'`; `private PolicyKeyForHive(hiveId): string` = prefix + hiveId; `private PolicyBaseForHive(tenantId, hiveId): ReleasePolicyRecord` (Get(hiveKey) ?? `{ id: hiveKey, tenantId, hiveId }`); a `SaveHivePolicy(tenantId, hiveId, record)` that forces `id = hiveKey, tenantId, hiveId`.
- Public mutations (mirror the tenant ones, all take `(tenantId, hiveId, …)`): `SetHoldForHive`, `ClearHoldForHive`, `SetMinVersionForHive`, `ClearMinVersionForHive`, `SetChannelsForHive`, `ClearChannelsForHive`. Each returns the saved `ReleasePolicyRecord`. (The owning `tenantId` is needed so the hive policy records which tenant it belongs to; the operator route resolves it from `GetHive(hiveId).tenantId`.)

- [ ] **Step 1: Write failing tests:** set a hive hold/floor/channels → `policies.Get('h:'+hiveId)` round-trips with `hiveId` + `tenantId` set; a tenant policy at `Get(tenantId)` is untouched by a hive mutation and vice-versa (key non-collision); clear removes only the named field.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts` → FAIL.
- [ ] **Step 3: Implement** the record field + helpers + 6 mutations.
- [ ] **Step 4: Run** the file → PASS + full control-plane gate. Byte-scan (match base EOL).
- [ ] **Step 5: Commit** by explicit path.

---

### Task 2: Evaluator composition + pull/push wiring

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts`
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (extend)

**Interfaces:**
- Change `private BlockReasonFor(tenantId: string, manifest)` → `private BlockReasonFor(tenantId: string, hiveId: string | undefined, manifest)`. When `hiveId !== undefined`, also load the hive policy (`policies.Get(PolicyKeyForHive(hiveId))`) and compose:
  - **hold:** blocked if `tenantPolicy.hold` OR `hivePolicy.hold` is set.
  - **channels:** let `channel = manifest.channel ?? Channel.Stable`; blocked if `(tenant.channels?.length && !tenant.channels.includes(channel))` OR `(hive.channels?.length && !hive.channels.includes(channel))`.
  - **floor:** `effective = max(tenant.minVersion, hive.minVersion)` by `VersionOrder` (whichever is the higher version; undefined = no floor at that level); blocked if `effective !== undefined && VersionOrder.Compare(manifest.id, effective) < 0`.
  - evaluation order unchanged: withdrawn → hold → channels → floor; the SAME `PolicyBlock` reasons are returned.
- Rewire callers: `AdoptableFor(hive)` / the pull path → `BlockReasonFor(hive.tenantId, hive.id, m)`; `Record(hiveId,…)` / push → `BlockReasonFor(hive.tenantId, hiveId, m)`. `AdoptableForTenant(tenantId)` (offered list, `GET /api/tenants/:id/manifests`) → `BlockReasonFor(tenantId, undefined, m)` (unchanged behavior).

- [ ] **Step 1: Write failing tests:** (a) a hive hold blocks only that hive's adoption; a sibling hive of the same tenant is unaffected. (b) hive floor HIGHER than tenant tightens (hive can't adopt below the hive floor); hive floor LOWER than tenant floor does NOT loosen (hive still can't adopt below the tenant floor — max). (c) a hive channel subset narrows; a hive channel the tenant excludes yields nothing (fail-closed). (d) `AdoptableForTenant` is unchanged (hiveId undefined — tenant-only). (e) back-compat: no hive policy → identical to pre-change.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** PASS + full control-plane gate. **Step 5: Commit** by explicit path.

---

### Task 3: Operator host routes — `/api/hives/:id/policy/(channels|min-version|hold)`

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (keeps its 6 non-ASCII bytes)
- Test: `admin/control-plane/tests/` host policy test (extend the tenant-policy test file, or the closest host route test)

**Interfaces:**
- Add a `HivePolicyPathPattern` = `^/api/hives/([^/]+)/policy/(channels|min-version|hold)$` (reuse the Policy/Channels/MinVersion/Hold segment constants) and a `RouteHivePolicy(req,res,method,m)` that mirrors `RouteTenantPolicy` but resolves the owning tenant from `this.deployments`/directory (`GetHive(id)` → `tenantId`; 404 when the hive is unknown) and calls the `…ForHive(tenantId, hiveId, …)` mutations. Same body validation, same 400/409 mapping, same hold-actor-from-session. Register it in the route dispatch next to the tenant-policy route. It is a mutating `/api/` route → already Full-gated by the central authorization (confirm ReadOnly is blocked).

- [ ] **Step 1: Write failing tests:** set/clear a hive hold, floor, and channels via the routes → 200 + the persisted hive policy; an unknown hive → 404; a ReadOnly operator → 403; invalid channels/empty reason → 400.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** PASS + full control-plane gate + `typecheck:tools`. Byte-scan host → `6 0 N`. **Step 5: Commit** by explicit path.

---

### Task 4: Portal floor-only-blocked tag

**Files:**
- Create: `admin/portal/src/version-order.ts` (replicated comparator — ASCII, no control-plane import)
- Modify: `admin/portal/src/release-policy-view-model.ts` (`BlockedLabel` floor reason)
- Test: `admin/portal/tests/version-order.test.ts` (new) + `admin/portal/tests/release-policy-view-model.test.ts` (extend)

**Interfaces:**
- `export class VersionOrder { public static Compare(a: string, b: string): -1 | 0 | 1 }` — same semantics as `admin/control-plane/version-order.ts` (dot-split, numeric segments by leading-zero-stripped length-then-lexical so `1.10.0 > 1.9.0`, missing segment lower, non-numeric string fallback, never throws). Replicate; do NOT import the control-plane one.
- `ReleasePolicyViewModel.BlockedLabel`: add a floor branch — when the manifest is not otherwise blocked and `policy.minVersion !== undefined && VersionOrder.Compare(version, policy.minVersion) < 0`, return a "below floor" label (hoist the text to a `private static readonly`). Keep the existing withdrawn/channel/held precedence.

- [ ] **Step 1: Write failing tests:** `version-order.test.ts` pins the ordering cases (incl. `1.10.0 > 1.9.0`, leading zeros, missing segments, non-numeric). The VM test: a version below the tenant floor with no other block → `blockedLabel` is the below-floor label; a version at/above the floor → no floor label.
- [ ] **Step 2: Run** `npm --prefix admin/portal test` → FAIL. **Step 3: Implement.** **Step 4:** PASS + portal typecheck. Byte-scan new file `0 0 N`; preserve base EOL on the VM. **Step 5: Commit** by explicit path.

---

### Task 5: Portal api-client + hive-detail VM per-hive policy

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`PolicyDto` `+hiveId?`)
- Modify: `admin/portal/src/api-client.ts` (**CRLF at base** — keep CRLF) — hive-policy methods
- Modify: `admin/portal/src/hive-detail-view-model.ts` (expose the hive's effective policy)
- Test: `admin/portal/tests/hive-detail-view-model.test.ts` (extend)

**Interfaces:**
- `PolicyDto` gains `hiveId?: string`.
- `api-client.ts`: `SetHiveChannels(hiveId, channels)`, `SetHiveMinVersion(hiveId, version)`, `ClearHiveMinVersion(hiveId)`, `SetHiveHold(hiveId, reason)`, `ClearHiveHold(hiveId)` — mirror the `SetTenant…` methods against a `HivePolicyRoute(hiveId, segment)` = `/api/hives/<enc id>/policy/<segment>`.
- `HiveDetailViewModel`: accept the policies list (or the hive's `PolicyDto`), expose a `HivePolicy` view — `{ heldLabel, held, channelsLabel, minVersionLabel }` for THIS hive (select the policy whose `hiveId === hive.id`), reusing the label conventions from `ReleasePolicyViewModel`.

- [ ] **Step 1: Write failing tests:** the VM, given a hive policy with hold/floor/channels, exposes the right labels; given none, exposes the empty/absent defaults. (api-client route-shape covered by a thin test if the file has client tests, else rely on the host tests.)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** PASS + portal typecheck. Byte-scan — `api-client.ts` stays CRLF; others per base. **Step 5: Commit** by explicit path.

---

### Task 6: Hive-detail view — per-hive policy controls

**Files:**
- Modify: `admin/portal/src/hive-detail-view.ts`
- Modify: `admin/portal/src/hives-view.ts` (fetch policies + pass to the detail VM, mirroring how it already fetches observations/ledger)
- Test: `admin/portal/tests/` hive-detail view test (extend if present)

**Interfaces:**
- Render a "Release policy" `Section` on the hive detail showing the hive's hold/floor/channels with set/clear controls (inline forms, mirroring the tenant controls in `release-policy-view.ts`), wired to the Task-5 api-client methods, refreshing the detail on success. `hives-view.ts`'s `BuildDetail` fetches `ListPolicies()` (already exists) alongside observations/ledger and passes the hive's policy to `HiveDetailViewModel`.

- [ ] **Step 1: Write failing test** (if the view is testable in the portal harness): the detail renders a Release policy section; the controls call the api-client methods. If the view isn't unit-testable, rely on the VM test (Task 5) + typecheck and keep this task's change render-only.
- [ ] **Step 2–4:** red (where testable) → implement → `npm --prefix admin/portal test` + typecheck green. Byte-scan per base EOL.
- [ ] **Step 5: Commit** by explicit path.
