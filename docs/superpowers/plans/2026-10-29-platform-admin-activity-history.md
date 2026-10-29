# Platform Admin — Activity History (G9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one activity/history subsystem — (A) an append-only operator-action audit log recorded at the host authorization boundary (incl. 401/403 denials), (B) a bounded per-hive observed-health time-series, and (C) a registry-level adoption/version-change ledger — each with a query route and a portal surface.

**Architecture:** Three independent append-only, capped `JsonRecordStore`s. (A) `AuditRegistry` is written at the single `ControlPlaneHost.Handle` seam every mutation passes (actor/method/path/status/at, never a body). (B) `HiveObservationRegistry` becomes a per-hive time-series keeping `LatestFor` working. (C) `AdoptionLedgerRegistry` is emitted from inside `PlatformDeploymentRegistry` (gate/ungate/withdraw/restore/select/adopt) with the semantic target (tenant/hive/version). New portal `Activity` nav section + history panels on hive/release detail.

**Tech Stack:** TypeScript (Node, `node:test` via `npx tsx`), the admin control-plane + the separate `admin/portal` Mural app. No new npm dependency. `node:crypto randomUUID` for entry ids.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-activity-history-design.md`

## Global Constraints

- **OOP, no free functions / no module-level mutable state** (module-level `const`/`type`/`enum` only).
- **Allman braces** everywhere (object literals / arrow bodies / one-line `if (x) return;` stay inline).
- **No inline reused string literals** — hoist to `private static readonly` PascalCase constants.
- **View models extend `Observable`.** **PascalCase** interfaces + public methods.
- **New `.ts`: pure ASCII + LF.** `control-plane-host.ts` keeps **exactly its 6 pre-existing non-ASCII bytes** (byte-scan `6 0 N` after every edit; all other new/edited `.ts` must be `0 0 N`). Byte-scan: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"`.
- **Audit stores NEVER contain a request body, header, cookie, token, password, or reason** — only the fields named per store. Append is **best-effort**: a failed/full store append must NEVER change the operator response.
- **Append-only + capped:** no edit/delete API on any of the three stores; each caps to a hoisted `MaxEntries` (evict oldest).
- **Optional-last ctor params** for the two registry stores threaded into `PlatformDeploymentRegistry` (the `ledger?`), mirroring the PA-G5 `policies?` pattern, so the 6 smoke construction sites stay untouched.
- Gate asymmetry: control-plane gate = `npx tsx --test admin/control-plane/tests/*.test.ts` **and** `npm run typecheck:tools`; portal gate = `npm --prefix admin/portal test` **and** `npm --prefix admin/portal run typecheck`.
- Stage only by explicit path (never `git add -A`); `docs/` not staged by task commits. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **No secret ever lands in an audit store.** The (A) seam stores `path` (no query string, no body); (C) stores only tenant/hive/version/action. Test: a password-reset / hold-with-reason / publish mutation produces an (A) entry whose stored fields contain no email/reason/image/token. (Task 2.)
- **Best-effort append never breaks the response.** A throwing audit/ledger store leaves the operator's status untouched. Test: inject a throwing store, assert the mutation still returns its real status. (Tasks 2, 4.)
- **Observed `LatestFor` stays correct after the time-series change.** `StatusFor` (obsolete/ready) and `GET /api/hives/:id/health` must still reflect the NEWEST snapshot once the store appends. Test: two snapshots for one hive → `LatestFor`/`LatestRecord` return the second. (Task 3.)
- **Ledger captures the agent-pull adoption** (over the public channel, not the operator host) — the whole reason (C) is registry-level. Test: `RecordAdoption` writes a ledger entry. (Task 4.)
- **Denial auditing has a safe actor.** A 401 (no session) records actor `'(anonymous)'`, a 403 records the real role-denied actor; neither throws. (Task 2.)

---

### Task 1: Audit store

**Files:** Create `admin/control-plane/audit-record.ts`; Test `admin/control-plane/tests/audit-record.test.ts`.

**Interfaces — Produces:**
- `type AuditRecord = { id: string; actor: string; method: string; path: string; status: number; at: string }`.
- `class AuditRegistry extends JsonRecordStore<AuditRecord>` (RootKey `'audit'`): `async Append(entry: Omit<AuditRecord, 'id'>): Promise<void>` (assign `randomUUID` id, `Put`, then evict oldest beyond a hoisted `MaxEntries = 1000` using `at` order); `Recent(limit: number): readonly AuditRecord[]` (List sorted by `at` desc then sliced to `limit`).

- [ ] **Step 1: Failing test** — Append three entries (distinct `at`), `Recent(2)` returns the two newest in desc order; appending past `MaxEntries` (use a small override OR assert List length never exceeds the cap by appending cap+5 and checking count + that the oldest `at` is gone); each entry gets a unique id.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement.** `randomUUID` from `node:crypto`. Allman, hoisted constants. (Make `MaxEntries` a `private static readonly`; the test can append > cap to exercise eviction rather than needing an override.)
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Byte-scan both `0 0 N`. Commit.**

---

### Task 2: Host action-audit seam + denials + query route

**Files:** Modify `admin/control-plane/control-plane-host.ts` (stays `6 0 N`), `admin/control-plane/server.ts`; Test `admin/control-plane/tests/control-plane-host-activity.test.ts` (new file; mirror the harness of `control-plane-host-rollout.test.ts`).

**Interfaces — Consumes** `AuditRegistry` (T1). **Produces:** audit emit at the central `Handle` seam + `GET /api/activity`.

- Ctor: add `private readonly audit: AuditRegistry = new AuditRegistry(<default path>)` (or thread from `server.ts`; match how other registries are injected — prefer a ctor param with a sensible default so existing host tests that don't pass one still construct). `server.ts` constructs `new AuditRegistry(join(dataRoot, 'audit.json'))`, `Load()`s it, passes it in.
- **Emit points** (all wrapped so a throw is swallowed + logged, never changing the response — a `private async RecordAudit(actor, method, path, status)` best-effort helper):
  1. After `const handled = await this.RouteApi(req, res, path)` — if `path.startsWith(ApiPrefix)` AND `PlaneHttp.IsMutating(req)` AND `!IsPublicApi(path)` AND a `who` was resolved → `RecordAudit(who.email ?? who.principalId ?? '', method, path, res.statusCode)`. (One entry per authorized mutation, real outcome.)
  2. At the **401** early return (no session, mutating api path) → `RecordAudit(AnonymousActor, method, path, 401)` (`AnonymousActor = '(anonymous)'`).
  3. At the **403** role-denied early return (mutating api path) → `RecordAudit(who.email ?? who.principalId ?? '', method, path, 403)`.
  (Only MUTATING requests are audited at all three; GET reads are never audited. Keep the existing control-flow/returns; add the best-effort call before each return.)
- Route: `GET /api/activity` (add `ActivityAllPath = '/api/activity'`) → parse optional `?limit=` (clamp to a hoisted max, default e.g. 200) → `PlaneHttp.WriteJson(res, StatusOk, [...this.audit.Recent(limit)])`. Authenticated GET, NOT Full-gated (reads aren't).

- [ ] **Step 1: Failing tests** (new file): a `POST`/`PUT`/`DELETE` to an existing mutating route writes exactly one audit entry with the right actor/method/path and the handler's real status (e.g. a publish → 201; a bad publish → 400 recorded); a `GET` writes none; a ReadOnly-denied mutation writes a 403 entry with the actor; an unauthenticated mutation writes a 401 entry with `'(anonymous)'`; `GET /api/activity` returns newest-first and honors `limit`; a stored entry's fields contain NO body/secret (assert the path has no query and that a password-reset POST's entry exposes no email); an injected throwing `AuditRegistry` does NOT change the mutation's response status.
- [ ] **Step 2: Run, fail** (`npx tsx --test admin/control-plane/tests/control-plane-host-activity.test.ts`).
- [ ] **Step 3: Implement.** Reuse the `who` already resolved in `Handle`. Hoist every literal. **Byte-scan `control-plane-host.ts` after each edit → `6 0 N`.**
- [ ] **Step 4: Run** the new test + whole control-plane suite + `npm run typecheck:tools`.
- [ ] **Step 5: Final byte-scan (`6 0 N` host; `0 0 N` server/test). Commit.**

---

### Task 3: Observed health history (time-series)

**Files:** Modify `admin/control-plane/hive-observation-record.ts`, `admin/control-plane/control-plane-host.ts` (BuildFleet consumer + a history route), `admin/control-plane/server.ts` (if the observations file/ctor changes); Test `admin/control-plane/tests/hive-observation-record.test.ts` (new) + extend the host test.

**Interfaces — Produces** (on `HiveObservationRegistry`):
- `RecordSnapshot(hiveId, environments)` now APPENDS (unique id e.g. `randomUUID`), evicting oldest beyond a hoisted per-hive cap `MaxPerHive` (e.g. 50).
- `LatestFor(hiveId): HiveHealthDto[]` — UNCHANGED signature, now returns the NEWEST snapshot's environments (by `at`/`reportedAt` desc).
- `LatestRecord(hiveId): HiveObservationRecord | undefined` — newest full record (for `BuildFleet`'s `reportedAt` + environments).
- `HistoryFor(hiveId, limit): readonly HiveObservationRecord[]` — newest-first, sliced.
- `BuildFleet` (`control-plane-host.ts:877`) switches `this.observations.Get(hive.id)` → `this.observations.LatestRecord(hive.id)`. `StatusFor` (registry) + `GET /api/hives/:id/health` keep using `LatestFor` (verify still newest).
- New route `GET /api/hives/:id/observations?limit=` → `HistoryFor` (authenticated GET).

- [ ] **Step 1: Failing tests** — record two snapshots for one hive with distinct timestamps: `LatestFor`/`LatestRecord` return the SECOND; `HistoryFor(hive, 10)` returns both newest-first; a third hive's snapshots don't bleed; appending past `MaxPerHive` evicts that hive's oldest only. Host: `GET /api/hives/:id/observations` returns the series; `BuildFleet`/fleet still shows the latest `lastSeen`.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement.** Give each snapshot a unique id; filter `List()` by `hiveId` for Latest/History; per-hive cap eviction on append. Update the two host consumers + the new route (byte-scan host `6 0 N`).
- [ ] **Step 4: Run** new test + whole control-plane suite + `typecheck:tools`.
- [ ] **Step 5: Byte-scan. Commit.**

---

### Task 4: Adoption ledger (registry-level)

**Files:** Create `admin/control-plane/adoption-ledger-record.ts`; Modify `admin/control-plane/platform-deployment-registry.ts`, `admin/control-plane/server.ts`, `admin/control-plane/tests/rollout-fixture.ts`, `admin/control-plane/control-plane-host.ts` (a ledger route); Test `admin/control-plane/tests/adoption-ledger-record.test.ts` (new) + extend the registry + host tests.

**Interfaces — Produces:**
- `type LedgerAction = 'gated' | 'ungated' | 'withdrawn' | 'restored' | 'selected' | 'adopted'` (module-level union); `type AdoptionLedgerRecord = { id: string; tenantId?: string; hiveId?: string; version: string; action: LedgerAction; at: string }`; `class AdoptionLedgerRegistry extends JsonRecordStore<AdoptionLedgerRecord>` (RootKey `'adoptionLedger'`): `async Append(entry: Omit<AdoptionLedgerRecord,'id'|'at'>): Promise<void>` (randomUUID + at, cap `MaxEntries`), `ForHive(hiveId, limit)`, `ForTenant(tenantId, limit)` (newest-first).
- `PlatformDeploymentRegistry` gains OPTIONAL-LAST ctor param `ledger?: AdoptionLedgerRegistry` (after `policies?`). Emit (best-effort, never throwing into the operation):
  - `Gate` → `gated` (tenantId, version); `Ungate` → `ungated`.
  - `SetWithdrawn(v,true)` → `withdrawn` (version); `(v,false)` → `restored`.
  - `Record` (private, used by both `SelectTarget` and `RecordAdoption`) → emit AFTER the successful selection write: `selected` when called via `SelectTarget`, `adopted` when via `RecordAdoption` (pass a source flag into `Record`, or emit in the two public callers). Include hiveId + version (+ the hive's tenantId).
  - Wire `server.ts` (construct + Load `new AdoptionLedgerRegistry(join(dataRoot,'adoption-ledger.json'))`, pass last) and `rollout-fixture.ts` (pass after the `policies` arg so tests exercise it).
- Route `GET /api/hives/:id/ledger?limit=` → `ForHive` (authenticated GET). (A tenant ledger route is optional; hive ledger covers the detail view.)

- [ ] **Step 1: Failing tests** — registry (via fixture): `Gate`/`Ungate`/`SetWithdrawn(true/false)` each append the right action+target; `SelectTarget` logs `selected`, `RecordAdoption` logs `adopted` (both with hive+version); a blocked adopt (policy) logs NOTHING (emit only after success); `ForHive` newest-first; a throwing ledger store does NOT break `Gate`/`RecordAdoption`. Host: `GET /api/hives/:id/ledger` returns the series.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement.** Emit only on success paths; best-effort wrap. Do NOT touch the 6 smokes (optional param). Byte-scan host `6 0 N`.
- [ ] **Step 4: Run** new + registry + host tests + whole suite + `typecheck:tools`.
- [ ] **Step 5: Byte-scan. Commit.**

---

### Task 5: Portal client + DTOs

**Files:** Modify `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`; Test `admin/portal/tests/api-client.test.ts`.

**Interfaces — Produces:**
- DTOs: `ActivityDto = { actor; method; path; status; at }`; `ObservationDto = { hiveId; environments: { name; ready; image?; detail }[]; reportedAt }` (match the record shape the route returns — confirm against Task 3's route payload; it may return `HiveObservationRecord` as-is, so mirror its fields); `LedgerDto = { tenantId?; hiveId?; version; action: string; at }`.
- Client: `ListActivity(limit?): Promise<ActivityDto[]>` → `GET /api/activity`; `ListHiveObservations(hiveId, limit?): Promise<ObservationDto[]>` → `GET /api/hives/:id/observations`; `ListHiveLedger(hiveId, limit?): Promise<LedgerDto[]>` → `GET /api/hives/:id/ledger`. Hoist route/segment constants; build item routes via `ItemRoute`; `?limit=` appended when provided.

- [ ] **Step 1: Failing tests** — each method hits the expected method+path (incl. the `limit` query when passed) and returns the parsed DTO array. Mirror the existing api-client test harness.
- [ ] **Step 2: Run, fail** (`npm --prefix admin/portal test`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal test + `npm --prefix admin/portal run typecheck`.
- [ ] **Step 5: Byte-scan. Commit.**

---

### Task 6: Activity view + nav section

**Files:** Modify `admin/portal/src/nav-model.ts`, `admin/portal/src/app.ts`; Create `admin/portal/src/activity-view.ts`, `admin/portal/src/activity-view-model.ts`; Test `admin/portal/tests/activity-view-model.test.ts`, `admin/portal/tests/activity-view.test.ts`.

**Interfaces — Consumes** `ActivityDto` + `ListActivity` (T5). **Produces:**
- `nav-model.ts`: add `PaSection.Activity = 'activity'` + a nav item (hoisted label, an existing `KitGlyph`) in a sensible group.
- `app.ts`: dispatch `PaSection.Activity` → `new ActivityView(this.client, operator)` (not the ComingSoon fallthrough).
- `activity-view-model.ts` (`extends Observable`): fetches (or accepts) `ActivityDto[]`, exposes `Rows: ActivityRow[]` `{ whenLabel; actor; actionLabel; status; tone }`. `actionLabel` derived by a PURE static table-driven map of method+path-pattern → friendly label (e.g. `POST /api/manifests` → "Published a version"; `POST /api/tenants/{id}/policy/hold` → "Held a tenant"; `DELETE .../policy/hold` → "Released a hold"; `POST .../gating` → "Gated a version"; unknown → `METHOD path`). `tone` from status (2xx `Success`, 401/403 `Warning`/`Danger`, other 4xx/5xx `Warning`). Hoist the map + labels.
- `activity-view.ts` (ScreenHost 5-state): a `DataTable` (When / Who / Action / Outcome pill); Refresh re-fetches.

- [ ] **Step 1: Failing tests** — VM: known method+path → friendly label; a denied (403) and anonymous (401) row map to the right tone/label; unknown path → raw fallback; status→tone table. View: renders the table + 5-state; nav routes to it (a `PaSection.Activity` → ActivityView test).
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal test + typecheck.
- [ ] **Step 5: Byte-scan. Commit.**

---

### Task 7: Observed history on hive detail

**Files:** Modify `admin/portal/src/hive-detail-view-model.ts`, `admin/portal/src/hive-detail-view.ts`; Test the corresponding existing `admin/portal/tests/hive-detail-view*.test.ts` (match names).

**Interfaces — Consumes** `ListHiveObservations` + `ObservationDto` (T5). **Produces:** the hive-detail VM gains an observations history list; the view renders a compact history panel (a `DataTable` or list of recent snapshots: reportedAt + per-env ready/image summary), below the existing live/observed content. Reuse the existing `observed-env-table` presentation idiom where it fits. Gated as a normal read (no mutation).

- [ ] **Step 1: Failing tests** — VM derives history rows (newest-first, env summary); the view renders the panel with N recent snapshots; empty history shows an empty state.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement.** If the hive-detail view fetches via its own Refresh, add the observations fetch there; don't change its constructor signature if avoidable.
- [ ] **Step 4: Run** portal test + typecheck.
- [ ] **Step 5: Byte-scan. Commit.**

---

### Task 8: Adoption ledger on release/hive detail

**Files:** Modify `admin/portal/src/hive-detail-view-model.ts` + `admin/portal/src/hive-detail-view.ts` (ledger panel on the hive — it has `hiveId`); Test the existing hive-detail test.

**Interfaces — Consumes** `ListHiveLedger` + `LedgerDto` (T5). **Produces:** the hive-detail VM gains a ledger list; the view renders a version-change timeline panel (When / Action / Version), a friendly action label (`gated`→"Gated", `adopted`→"Adopted", `withdrawn`→"Withdrawn", etc. via a hoisted map), newest-first. Read-only.

- [ ] **Step 1: Failing tests** — VM maps ledger entries to rows with friendly action labels newest-first; the view renders the timeline; empty ledger shows an empty state.
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement** (add the ledger fetch to the hive-detail Refresh alongside observations from T7).
- [ ] **Step 4: Run** portal test + typecheck.
- [ ] **Step 5: Byte-scan. Commit.**
