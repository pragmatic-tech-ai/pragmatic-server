# Tenant Adoption Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant see its own version-change timeline (gated/ungated/selected/adopted, plus withdrawn/restored for versions it encountered) on the Releases view, via a session-scoped tenant-plane route over both rollout seams.

**Architecture:** The union + tenant isolation live server-side in the registry (hive→tenant resolution). A tenant-safe DTO (no tenantId) is mapped at both control-plane boundaries. The seam is **hive-keyed** (matching the agent channel and `StatusFor(hiveId)`). The tenant endpoint scopes by `session.tenantId` exactly as its sibling routes do.

**Tech Stack:** TypeScript (Node ESM), node:test, admin/control-plane + admin/tenant-portal (Mural kit).

**Spec:** docs/superpowers/specs/2026-10-29-tenant-adoption-ledger-design.md

**Owner decisions (fork 2026-10-29):** Q1 placement = **Releases "Version history" panel**. Q2 scope = **Also show withdrawn/restored** (version-aware union, scoped to the tenant's own versions).

## Global Constraints

- New `.ts`: pure ASCII, LF only. Byte-scan every touched file → `0 0 N`. (No `control-plane-host.ts` in this spec.)
- OOP + Allman braces; no module-level free functions/state; no inline string literals (hoist to `private static readonly`); enums over string unions; VMs extend `Observable`; PascalCase public methods.
- `admin/tenant-portal` is a SEPARATE app — it must NOT import from `admin/portal`. Replicate the small action→label map locally.
- **Tenant isolation is absolute:** no route/client/DTO/registry method ever accepts a caller-supplied tenant id; the tenant id is resolved server-side from the hive (agent channel / in-process) or the `session.tenantId` (tenant endpoint). The tenant-safe DTO carries NO `tenantId`.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`; tenant-portal `npm --prefix admin/tenant-portal test` + `npm --prefix admin/tenant-portal run typecheck`. node:test summary `ℹ`; grep `"(tests|pass|fail) [0-9]"`.
- Merge locally (ff-only into master); **NEVER push.** Stage by explicit path. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Isolation / no leak:** a tenant reading its ledger sees ONLY its own gated/ungated/selected/adopted events; withdrawn/restored appear ONLY for versions in the tenant's own event set — a withdrawn for a version the tenant never encountered must NOT appear (Task 1 tests this directly). Seeded tenant-B events never appear for tenant-A.
- **No tenantId in the wire DTO** at either boundary.
- **Empty/absent:** no ledger configured, unknown hive, or a tenant with no events → `[]` / empty-state panel, never an error.
- **Limit bound:** results are bounded by a server-side cap (no unbounded response).
- **Ordering:** newest-first everywhere.

---

### Task 1: Registry union query — `ForTenantIncludingVersionEvents`

**Files:**
- Modify: `admin/control-plane/adoption-ledger-record.ts`
- Test: `admin/control-plane/tests/adoption-ledger-record.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `AdoptionLedgerRegistry.ForTenantIncludingVersionEvents(tenantId: string, limit: number): readonly AdoptionLedgerRecord[]`.
- Semantics: let `tenantRecs` = records with `tenantId === tenantId` (gated/ungated/selected/adopted). Let `tenantVersions = new Set(tenantRecs.map(r => r.version))`. Let `versionRecs` = records with `(action === 'withdrawn' || action === 'restored')` AND `tenantId === undefined` AND `tenantVersions.has(version)`. Return `[...tenantRecs, ...versionRecs]` sorted by `at` descending (newest-first), sliced to `limit`. The two sets are disjoint (one has the tenantId, the other has none) so no dedup needed. Keep existing `ForTenant`/`ForHive` untouched.

- [ ] **Step 1: Write failing tests:**
  - **tenant isolation:** seed tenant-A `gated` v1 and tenant-B `gated` v2 → `ForTenantIncludingVersionEvents('A', 50)` contains v1, never v2.
  - **version-scoped withdraw (the fork's point):** seed tenant-A `adopted` v1; a global `withdrawn` v1 (no tenantId); a global `withdrawn` v9 (no tenantId, A never saw v9). Result contains the v1 withdraw, NOT the v9 withdraw.
  - **restored too:** global `restored` v1 (tenant saw v1) appears.
  - **newest-first + limit:** ordering by `at` desc; `limit` caps the count.
  - **empty:** unknown tenant → `[]`.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/adoption-ledger-record.test.ts` → FAIL (method missing).
- [ ] **Step 3: Implement** the method.
- [ ] **Step 4: Run** the file → PASS. Byte-scan.
- [ ] **Step 5: Commit** the two files by explicit path.

---

### Task 2: Registry hive→tenant passthrough — `LedgerForHive`

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts`
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (extend)

**Interfaces:**
- Consumes: `this.hives.GetHive(hiveId)` (resolves hive→tenantId), `this.ledger?` (Task 1 method).
- Produces: `PlatformDeploymentRegistry.LedgerForHive(hiveId: string, limit: number): readonly AdoptionLedgerRecord[]` — `GetHive(hiveId)`; if the hive is unknown or `this.ledger` is undefined → `[]`; else `this.ledger.ForTenantIncludingVersionEvents(hive.tenantId, limit)`. (This is the single server-side place hive→tenant is resolved for the ledger.)

- [ ] **Step 1: Write failing test:** with a seeded hive owning tenant T and ledger events for T + a version-scoped withdraw, `LedgerForHive(hiveId, 50)` returns T's union; an unknown hiveId → `[]`; a registry with no ledger → `[]`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** PASS + full control-plane gate + byte-scan. **Step 5: Commit** by explicit path.

---

### Task 3: Rollout seam — `IRolloutClient.LedgerFor` + tenant-safe DTO + both clients

**Files:**
- Modify: `admin/control-plane/tenant-api/rollout-client.ts` (interface + DTO + mapper)
- Modify: `admin/control-plane/tenant-api/in-process-rollout-client.ts`
- Modify: `admin/control-plane/tenant-api/http-rollout-client.ts`
- Test: `admin/control-plane/tests/` rollout-client tests (extend the existing in-process/http client tests if present, else create `rollout-client-ledger.test.ts`)

**Interfaces:**
- Produces: `export type AdoptionLedgerDto = { version: string; action: LedgerAction; at: string; hiveId?: string }` (NO tenantId) in `rollout-client.ts`; `LedgerAction` imported from `../adoption-ledger-record.js`. A `static` mapper (e.g. on a small class) `records → AdoptionLedgerDto[]` stripping tenantId. `IRolloutClient` gains `LedgerFor(hiveId: string, limit: number): Promise<readonly AdoptionLedgerDto[]>`.
- InProcess: `LedgerFor` = map `this.deployments.LedgerForHive(hiveId, limit)` → DTO.
- Http: `LedgerFor` = `GET /agent/hives/:id/ledger?limit=` over the channel (mirror `StatusFor`: `AssertBoundHive`, `Send`, `ReadJson`, validate it is an array of `{version,action,at}` shape, else `RolloutUnavailableError(MalformedMessage)`); add a `LedgerSegment = '/ledger'` + `LimitParam`. Returns the validated DTOs.

- [ ] **Step 1: Write failing tests:** InProcess `LedgerFor` returns DTOs with NO `tenantId` field; Http `LedgerFor` parses a well-formed agent response and rejects a malformed one with `RolloutUnavailableError`.
- [ ] **Step 2–4:** red → implement → green + byte-scan.
- [ ] **Step 5: Commit** the four files by explicit path.

---

### Task 4: Agent-channel route — `GET /agent/hives/:id/ledger`

**Files:**
- Modify: `admin/control-plane/agent-channel-host.ts`
- Test: `admin/control-plane/tests/agent-channel-host*.test.ts` (extend)

**Interfaces:**
- Consumes: `this.deployments.LedgerForHive` (Task 2); the DTO mapper (Task 3).
- Add `'ledger'` to `RoutePattern` alternation and to the read-methods map (GET); a `LedgerSegment = 'ledger'` + `LimitParam`/default-cap constants. The case: after `VerifyAgentToken(id, bearer)`, `WriteJson(res, 200, <mapper>(this.deployments.LedgerForHive(id, limit)))` — tenant-safe DTOs, limit from `?limit` clamped to a cap (reuse the host's existing clamp helper or a local one). Mirror the `status` case exactly for auth/validation.

- [ ] **Step 1: Write failing test:** a bearer-authenticated `GET /agent/hives/:id/ledger` returns the hive's tenant union as DTOs (no tenantId); missing/invalid bearer → 401; unknown hive → the same shape the other read routes use for unknown.
- [ ] **Step 2–4:** red → implement → green + full control-plane gate + byte-scan.
- [ ] **Step 5: Commit** by explicit path.

---

### Task 5: Tenant-plane route — `GET /tenant-api/hives/:id/ledger`

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts`
- Test: `admin/control-plane/tests/` tenant-api endpoint tests (extend)

**Interfaces:**
- Consumes: `this.rolloutClient.LedgerFor` (Task 3).
- Add a `LedgerSegment = 'ledger'` constant and extend `HiveSubPathPattern`'s leaf alternation to `(rollout|health|ledger)`. In `RouteHiveSub`, after the existing `hive === undefined || hive.tenantId !== session.tenantId → 404` guard, add a `sub === LedgerSegment` branch: `this.WriteJson(res, StatusOk, [...await this.rolloutClient.LedgerFor(hive.id, <cap>)])`. The ownership guard (already present) is the isolation boundary — a cross-tenant or unknown hive 404s before `LedgerFor` is called.

- [ ] **Step 1: Write failing test:** a session for tenant-A reading `/tenant-api/hives/<A-hive>/ledger` gets A's union; reading `/tenant-api/hives/<B-hive>/ledger` → 404 (not 403), and `LedgerFor` is never reached for B. Empty ledger → `[]`.
- [ ] **Step 2–4:** red → implement → green + full control-plane gate + byte-scan.
- [ ] **Step 5: Commit** by explicit path.

---

### Task 6: Tenant portal — Releases "Version history" panel

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (DTO + `IReleasesSource` extension)
- Modify: `admin/tenant-portal/src/tenant-api-client.ts` (`ListHiveLedger`)
- Modify: `admin/tenant-portal/src/releases-view-model.ts` (ledger rows + action→label)
- Modify: `admin/tenant-portal/src/releases-view.ts` ("Version history" Section panel)
- Test: `admin/tenant-portal/tests/releases-view-model.test.ts` (extend)

**Interfaces:**
- `tenant-types.ts`: `AdoptionLedgerDto = { version: string; action: string; at: string; hiveId?: string }`; extend `IReleasesSource` with `ListLedger(hiveId: string): Promise<readonly AdoptionLedgerDto[]>` (the client already knows the hive id).
- `tenant-api-client.ts`: `ListHiveLedger(hiveId)` → `GET /tenant-api/hives/:id/ledger` (mirror the existing rollout/health fetch helpers; add a `LedgerLeaf = 'ledger'`).
- `releases-view-model.ts`: on `Load`, also fetch the ledger; expose `LedgerRows: readonly LedgerRow[]` (`{ version, actionLabel, whenLabel }`) with a local `private static readonly` action→friendly-label map (replicate the platform-admin mapping; do NOT import admin/portal). Newest-first already from the server. Raise a property-changed for the new rows.
- `releases-view.ts`: render a `Section` titled "Version history" (a kit `DataTable` of Version / Action / When), empty-state when no rows.

- [ ] **Step 1: Write failing tests** (extend releases VM test): a fake `IReleasesSource` returning ledger DTOs → `LedgerRows` maps action→label and formats `whenLabel`; empty → empty rows; the action-label map covers all six `LedgerAction` values.
- [ ] **Step 2–4:** red → implement → green + `npm --prefix admin/tenant-portal test` + `npm --prefix admin/tenant-portal run typecheck` + byte-scan.
- [ ] **Step 5: Commit** the five files by explicit path.
