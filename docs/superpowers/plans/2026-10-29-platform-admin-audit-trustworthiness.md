# Audit Trustworthiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the PA-G9 audit subsystem so every operator-relevant outcome is recorded, a pre-auth flood cannot evict genuine history, and the portal shows severity honestly.

**Architecture:** Two in-memory anti-flood mechanisms (defense in depth) + two host audit-completeness fixes + one portal tone fix. (1) `AuditThrottle` rejects pre-auth mutating floods per-IP with 429 before they audit; (2) `AuditRegistry` quota-partition eviction never drops an authored entry while an anonymous one remains; (3) `ControlPlaneHost` audits the authorized 500 handler-throw and the bad-origin 403; (4) `ActivityViewModel` tones 5xx as Danger.

**Tech Stack:** TypeScript (Node ESM), node:test, admin/control-plane + admin/portal (Mural kit).

**Spec:** docs/superpowers/specs/2026-10-29-platform-admin-audit-trustworthiness-design.md

**Owner decisions (fork, 2026-10-29):** Q1 = **Both** (per-IP throttle + quota partition). Q2 = **Both 403 + 500** (audit the bad-origin 403 and the 500-throw).

## Global Constraints

- New `.ts`: pure ASCII, LF only. `control-plane-host.ts` keeps exactly its **6** pre-existing non-ASCII bytes. Byte-scan every touched file: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` → new files `0 0 N`; host `6 0 N`.
- OOP + Allman braces; no module-level free functions or state; no inline string literals (hoist to `private static readonly`); enums over string unions; VMs extend `Observable`; PascalCase public methods/interfaces.
- Control-plane gate: `npx tsx --test admin/control-plane/tests/*.test.ts` AND `npm run typecheck:tools`. Portal gate: `npm --prefix admin/portal test` AND `npm --prefix admin/portal run typecheck`. Sequential. node:test summary lines use `ℹ`; grep `"(tests|pass|fail) [0-9]"`.
- Best-effort audit invariant: an audit append never throws and never alters the operator response.
- Audit store persists only `{actor, method, path, status, at}` — no body/header/token/password/reason. No new field added anywhere.
- Merge locally (ff-only into master); **NEVER push.** Stage by explicit path; never `git add -A`. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **All-authored burst:** quota partition must still evict oldest-*authored* when no anonymous entry remains — the ring never grows past the cap. (Task 2.)
- **Single emit:** after restructuring `Handle`, an authorized mutation is audited exactly once (not once in try and again in finally). (Task 3.)
- **Throttle never hits an authenticated operator:** only the bad-origin and anonymous pre-auth mutating branches consult the throttle; the role-denial 403 (real actor) and every authorized outcome are audited unthrottled. (Task 3.)
- **Back-compat:** a host constructed without an `AuditThrottle` (undefined) throttles nothing — anonymous mutating still returns 401, not 429 — so existing host tests are unaffected. (Task 3.)
- **Anonymous entry stays visible** until genuinely evicted — quota partition drops on *overflow*, never on write. (Task 2.)

---

### Task 1: AuditThrottle (per-IP pre-auth flood throttle)

**Files:**
- Create: `admin/control-plane/audit-throttle.ts`
- Test: `admin/control-plane/tests/audit-throttle.test.ts`

**Interfaces:**
- Produces: `class AuditThrottle` with `public CheckAllowed(ip: string): AuditThrottleDecision` and `public RecordHit(ip: string): void`; `interface AuditThrottleDecision { allowed: boolean; retryAfterMs: number }`; `interface AuditThrottleOptions { maxHits?: number; windowMs?: number; lockoutMs?: number; maxKeys?: number; now?: () => number }`.
- Semantics: keyed on client IP alone. `RecordHit` counts one pre-auth mutating denial in the current window; after `maxHits` hits inside `windowMs` the key locks for `lockoutMs`. `CheckAllowed` returns `{allowed:false, retryAfterMs:lockedUntil-now}` while locked, else `{allowed:true, retryAfterMs:0}`. Stale entries pruned on access; `Map` insertion-order eviction past `maxKeys` (re-insert on update so first key is oldest). Mirror `login-throttle.ts` structure (read it first), but keyed on ip only and with `RecordHit` in place of `RecordFailure`.
- Defaults: `maxHits=30`, `windowMs=60_000`, `lockoutMs=60_000`, `maxKeys=10_000` (all `private static readonly`).

- [ ] **Step 1: Write failing tests** in `tests/audit-throttle.test.ts` (inject `now` + small `maxHits`):
  - allows under threshold: `maxHits:2` → two `RecordHit` then `CheckAllowed` still `allowed:true`.
  - locks at threshold: third `RecordHit` → `CheckAllowed().allowed === false` and `retryAfterMs > 0`.
  - unlocks after lockout: advance `now` past `lockoutMs` → `allowed:true` again.
  - window reset: hits spread past `windowMs` never lock.
  - bounded: with `maxKeys:1`, hitting a second ip evicts the first (first ip allowed again).
  - isolation: two ips counted independently.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/audit-throttle.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `AuditThrottle` in `audit-throttle.ts` per the Interfaces block (adapt `login-throttle.ts`).
- [ ] **Step 4: Run** the test file → PASS. Byte-scan the new file → `0 0 N`.
- [ ] **Step 5: Commit** `git add admin/control-plane/audit-throttle.ts admin/control-plane/tests/audit-throttle.test.ts && git commit`.

---

### Task 2: AuditRegistry quota-partition eviction

**Files:**
- Modify: `admin/control-plane/audit-record.ts`
- Test: `admin/control-plane/tests/audit-record.test.ts` (extend)

**Interfaces:**
- Produces: `AuditRegistry.AnonymousActor` = `'(anonymous)'` as a `public static readonly` (the audit-domain sentinel; Task 3 imports it to replace the host-local copy). Eviction policy change only — `Append`/`Recent`/`List` signatures unchanged.
- Policy: in `Append`, when `List().length > MaxEntries`, evict the excess choosing **oldest anonymous-actor entries first** (`rec.actor === AuditRegistry.AnonymousActor`, ordered by `at` ascending); only when no anonymous entry remains, evict the oldest authored entries. Net: an authored entry is never evicted while any anonymous entry exists.

- [ ] **Step 1: Write failing tests** (extend `audit-record.test.ts`; reuse the temp-dir fixture):
  - **anonymous flood never evicts authored:** append 1 authored entry (actor `'op@x'`), then `MaxEntries` anonymous entries (actor `'(anonymous)'`, increasing `at`). Assert `List().length === MaxEntries` and the authored entry's `at` is still present.
  - **all-authored burst still bounded:** append `MaxEntries + 5` authored entries → `List().length === MaxEntries`, oldest 5 gone, newest present (the existing eviction tests already cover FIFO-by-`at`; add the authored-only assertion if not already implied).
  - **mixed:** authored + anonymous over cap → every authored present, oldest anonymous dropped first.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/audit-record.test.ts` → the new anonymous-flood test FAILs (today evicts strictly oldest-by-`at`, dropping the authored entry).
- [ ] **Step 3: Implement** the partitioned eviction in `Append` + add the `AnonymousActor` static. Keep it allocation-cheap; the existing sort-by-`at` stays, partition the candidate set by actor.
- [ ] **Step 4: Run** the test file → PASS.
- [ ] **Step 5: Commit** `git add admin/control-plane/audit-record.ts admin/control-plane/tests/audit-record.test.ts && git commit`.

---

### Task 3: Host — audit the 500-throw and bad-origin 403; throttle pre-auth floods

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (keeps its 6 non-ASCII bytes)
- Modify: `admin/control-plane/server.ts` (wire `new AuditThrottle()`)
- Test: `admin/control-plane/tests/control-plane-host-audit.test.ts` (extend if present, else create) — follow the existing host-test fixture pattern.

**Interfaces:**
- Consumes: `AuditThrottle` (Task 1); `AuditRegistry.AnonymousActor` (Task 2); existing `this.ClientIp(req)`, `PlaneHttp.IsMutating`, `this.OriginAllowed`, `RecordAudit`.
- Produces: ctor gains `private readonly auditThrottle?: AuditThrottle` as the **new optional-last param** (after `audit`). New `private static readonly` constants: `StatusTooManyRequests = 429`, `RetryAfterHeader = 'retry-after'`, `TooManyRequestsMessage`, and a `ServerErrorFloor`/`MsPerSecond` as needed. Replace the host-local `AnonymousActor` literal with the imported `AuditRegistry.AnonymousActor`.

Changes, each small and independent:

1. **500 handler-throw audited (always).** Restructure the tail of `Handle` so the authorized-mutation audit fires on the **final** `res.statusCode` whether `RouteApi`/`ServeStatic` returned or threw. Capture the audit decision (`shouldAudit = who !== null && IsMutating && isApi && !isPublic`) *before* the try tail, emit in a `finally` (or after the catch writes the error) keyed on `res.statusCode`. Exactly **one** emit site. A thrown handler → `WriteError` sets 500 → audit records 500.
2. **Bad-origin 403 audited + throttled.** In the bad-origin mutating branch (~637): `const ip = this.ClientIp(req); const d = this.auditThrottle?.CheckAllowed(ip); if (d && !d.allowed) { WriteJson(res, 429, {error: TooManyRequestsMessage}) with Retry-After = ceil(retryAfterMs/1000); return }` else write the 403 as today, `await this.RecordAudit(AuditRegistry.AnonymousActor, method, path, 403)`, then `this.auditThrottle?.RecordHit(ip)`. Replace the inline "deliberately NOT audited" comment with the new rationale (audited under throttle+quota protection).
3. **Anonymous 401 throttled.** In the `who === null` branch (~648), apply the same throttle gate **only on the mutating sub-case** (non-mutating anonymous GET keeps writing 401, no throttle, no audit). On the mutating path: 429 when locked, else 401 + existing anonymous audit + `RecordHit(ip)`.
4. **Role-denial 403 (~658) and all authorized outcomes:** unchanged — never throttled, always audited.
5. **server.ts:** pass `new AuditThrottle()` as the new last argument to `new ControlPlaneHost(...)`. (`rollout-fixture.ts` left untouched — optional-last param stays undefined there, so fixture tests see no throttling.)

- [ ] **Step 1: Write failing tests** in the host-audit test:
  - **500-throw audited:** drive an authorized mutating route whose handler throws (stub a collaborator to throw on a known route, following the fixture's injection pattern) → response 500 AND `audit.Recent()` has an entry with `status === 500`, the real actor, that method+path.
  - **bad-origin 403 audited:** authorized cookie but disallowed Origin on a mutating request → 403 AND an audit entry `status:403, actor:(anonymous)`.
  - **throttle trips:** construct the host with `new AuditThrottle({maxHits:2})`; 3 anonymous mutating requests → first two 401, third **429** with a `Retry-After` header; `audit` holds at most 2 anonymous entries from that path.
  - **back-compat:** host with no `AuditThrottle` → anonymous mutating still 401 (never 429).
  - **regression:** an authorized success and a role-denial 403 are each audited exactly once with the real actor.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/control-plane-host-audit.test.ts` → new assertions FAIL.
- [ ] **Step 3: Implement** changes 1–5 above.
- [ ] **Step 4: Run** the host-audit test → PASS. Then the FULL control-plane gate: `npx tsx --test admin/control-plane/tests/*.test.ts` and `npm run typecheck:tools`. Byte-scan `control-plane-host.ts` → `6 0 N`; `server.ts` → `0 0 N`.
- [ ] **Step 5: Commit** `git add admin/control-plane/control-plane-host.ts admin/control-plane/server.ts admin/control-plane/tests/control-plane-host-audit.test.ts && git commit`.

---

### Task 4: Portal — Danger tone for server errors

**Files:**
- Modify: `admin/portal/src/activity-view-model.ts`
- Test: `admin/portal/tests/activity-view-model.test.ts`

**Interfaces:**
- Consumes: `PillTone.Danger` (exists in `./kit`).
- Produces: `ToneFor(status)` → `2xx` Success, `>=500` Danger, else Warning. New `private static readonly ServerErrorMin = 500` (reuse `SuccessMin/SuccessMax`).

- [ ] **Step 1: Update the failing test:** the existing `'tones denied and anonymous attempts as warning'` test asserts 403/401/500 all `Warning`. Change it so `500 → PillTone.Danger` while `401` and `403` stay `Warning`; keep a 2xx→Success assertion.
- [ ] **Step 2: Run** `npm --prefix admin/portal test` (or the single file) → FAIL (500 currently Warning).
- [ ] **Step 3: Implement** the `ToneFor` 5xx→Danger branch.
- [ ] **Step 4: Run** `npm --prefix admin/portal test` AND `npm --prefix admin/portal run typecheck` → PASS. Byte-scan the VM → `0 0 N`.
- [ ] **Step 5: Commit** `git add admin/portal/src/activity-view-model.ts admin/portal/tests/activity-view-model.test.ts && git commit`.
