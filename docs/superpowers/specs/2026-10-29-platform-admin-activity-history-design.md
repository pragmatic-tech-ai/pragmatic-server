# Platform Admin — Activity History (G9) Design

**Status:** PROPOSED — surfaced for owner review before SDD (an audit log is a security-forensic record: it must be honest, complete at its chosen boundary, and never store secrets).
**Date:** 2026-10-29
**Spec id:** PA-G9 (Program 2, Platform Admin)
**Builds on:** the central request pipeline in `admin/control-plane/control-plane-host.ts` (`Handle` → `Authorize` → `RouteApi`); the thin live `/api/events` WS change-nudge (which persists nothing).

---

## 1. Intent and why

Today the platform keeps **no history of operator actions**. `/api/events` is a live WebSocket that only broadcasts a `{ type }` "something changed, re-fetch" nudge — nothing is persisted, and there is no Activity screen. An operator cannot answer "who published 1.4.0?", "when was tenant X put on hold and by whom?", or "what changed last Tuesday?". Hive health observations are likewise **latest-only** (`HiveObservationRegistry.RecordSnapshot` overwrites per hive), so there is no "Observed history" either.

Activity History adds an **append-only audit log of operator actions** with a query route and an Activity screen, recorded at the one authorization boundary every mutation already passes through.

## 2. Security / honesty spine (load-bearing)

- **Honest at its boundary.** An audit entry is written for a mutating operator request **after** it is dispatched, capturing what actually happened: the authenticated **actor**, the HTTP **method**, the request **path** (resource + action), the response **status** (outcome), and the **timestamp**. The log records the *authorization boundary truth* — the same boundary that enforces RBAC — not a hopeful pre-image. A 4xx/5xx outcome is recorded as such (a failed/blocked action is still activity).
- **No secrets, by construction.** The audit NEVER stores a request body, header, cookie, token, password, or reason text. Only `{ actor, method, path, status, at }`. Paths carry only platform ids (tenant/hive/version) that are already non-secret and already on the wire; operator-mutation **targets live in the body (email)** and are therefore *not* captured (a deliberate limitation — see §6/§8, fileable enrichment). This makes it impossible for the audit to leak a one-time password, signing key ref, or hold reason.
- **Append-only + bounded.** Entries are immutable once written and capped at a fixed maximum (oldest dropped) so the on-disk log cannot grow without bound. No mutation route can edit or delete an entry (there is no such API).
- **Read is operator-gated like everything else;** the Activity query is a normal authenticated GET (visible to any operator, ReadOnly included — reads are not Full-gated, consistent with `GET /api/rollouts`).
- New `.ts` pure ASCII + LF; `control-plane-host.ts` keeps its 6 pre-existing non-ASCII bytes.

## 3. What exists vs. what is a gap (recon result)

| Capability | Exists? | Note |
|---|---|---|
| Central request boundary with actor + method + path | yes | `ControlPlaneHost.Handle` resolves `who = Principal(req)` and runs `Authorize` for every non-public API path before `RouteApi`. The single natural emit seam. |
| Mutating-request detection | yes | `PlaneHttp.IsMutating(req)` (POST/PUT/DELETE/PATCH) already used for the Origin check. |
| Persisted audit of actions | no | **GAP** — nothing is stored; `/api/events` is a live nudge only. |
| Activity nav section / view | no | **GAP** — nav has 9 sections (Fleet…Settings); no Activity. |
| Observed **history** (health time-series) | no | `HiveObservationRegistry` keeps only the latest snapshot per hive (`Put` upserts by hiveId). Optional scope add (§4 (B)). |
| Adoption ledger (version-change history) | no | Deferred from PA-G5; a *view* over audit select/gate/withdraw/policy entries (§4 (C)). |

## 4. Scope options surfaced (the fork)

- **(A) Operator action audit log (recommended).** A new append-only `AuditRegistry` + a single emit at the host boundary recording every **authorized mutating** API request as `{ id, actor, method, path, status, at }`; a `GET /api/activity` query (newest-first, capped/paginated); a new `PaSection.Activity` nav item + `ActivityView` that renders friendly action labels from method+path. The honest core of "the audit store". Self-contained to this repo.
- **(B) A + Observed history.** Also change `HiveObservationRegistry` from latest-only to an append-only, per-hive bounded time-series + surface recent observations on the hive/fleet detail. A different data stream (health, not actions), smaller, orthogonal.
- **(C) A + adoption-ledger view.** Also surface the version-change history per hive/release by filtering the audit to adoption/select/gate/withdraw/policy actions on the release/hive detail (materializes the PA-G5 deferred).

Everything below the fork is written for **(A)**; (B) and (C) slot on top.

## 5. Design (scope A)

**New state — `AuditRecord` + `AuditRegistry`** (`audit-record.ts`, a `JsonRecordStore` keyed by a unique id so each entry is distinct — append, never upsert):

```ts
export type AuditRecord = {
    id: string       // randomUUID per entry (unique => append-only under the keyed store)
    actor: string    // who.email ?? who.principalId ?? '' (anonymous never reaches here — mutations require auth)
    method: string   // POST | PUT | DELETE | PATCH
    path: string     // the /api/... path (resource + action; NO query string, NO body)
    status: number   // the response status the handler wrote (200/201/204/4xx/5xx)
    at: string       // ISO timestamp
}
```

`AuditRegistry` adds `async Append(entry): Promise<void>` (Put with a fresh `randomUUID`, then evict oldest beyond `MaxEntries` — a hoisted cap, e.g. 1000) and `Recent(limit): readonly AuditRecord[]` (List sorted by `at` desc, sliced). Loaded in `server.ts` + `ManifestPublish`-style compose and passed to the host.

**Host emit seam** (`control-plane-host.ts`, the one place): in `Handle`, after `const handled = await this.RouteApi(req, res, path)` for an `/api/` path that is **mutating** (`PlaneHttp.IsMutating(req)`), **not public**, and had a resolved `who`, append `{ actor: who.email ?? who.principalId ?? '', method, path, status: res.statusCode, at: now }`. Appending is **best-effort and must never break the response** — wrap in try/catch, swallow+log on failure (the request already succeeded; a full audit disk must not 500 the operator). The `who` resolved earlier in `Handle` is reused (no second `Principal` call). Reads (GET) are not audited.

**Route** — `GET /api/activity?limit=N` → `this.audit.Recent(limit)` (default/clamped cap). A normal authenticated GET (not Full-gated). Add `ActivityAllPath = '/api/activity'`.

**Portal:**
- `nav-model.ts`: add `PaSection.Activity` (a new nav item, e.g. under a top-level or an "Operations" group, glyph from the existing catalog — e.g. a history/clock glyph if present, else `KitGlyph.Server`-family; use an existing glyph only).
- `app.ts`: dispatch `PaSection.Activity` → `new ActivityView(this.client, operator)` (replacing its ComingSoon fallthrough).
- `api-client.ts`: `ListActivity(limit?): Promise<ActivityDto[]>` → `GET /api/activity`. `ActivityDto = { actor; method; path; status; at }` in `portal-types.ts`.
- `activity-view.ts` + `activity-view-model.ts`: a `DataTable` of recent entries — **When** (relative/abs time), **Who** (actor), **Action** (a friendly label derived in the VM from method+path, e.g. `POST /api/manifests` → "Published a version"; `POST /api/tenants/:id/policy/hold` → "Held a tenant"; unknown → `METHOD path`), **Outcome** (a status pill: 2xx success / 4xx-5xx a warning/error tone). The VM derivation is pure and table-driven (a hoisted path→label map with id placeholders). ScreenHost 5-state; Refresh re-fetches.

## 6. Decisions ruled (no owner input needed)
- **Audit at the HTTP boundary, not per-service.** One honest emit seam vs. instrumenting every service with typed domain events. *Cost if wrong:* the action label is derived from method+path, not a rich domain payload; richer semantic events are a deferred enrichment. The boundary audit is complete (every mutation passes it) and DRY.
- **Store method+path+status+actor+at only — never a body.** *Cost if wrong:* operator-mutation targets (email in body) and reasons (hold/withdraw) are not in the audit; acceptable to guarantee zero secret leakage. Fileable: a curated, redaction-safe target field.
- **Bounded ring (cap newest N).** *Cost if wrong:* very old activity ages out; a durable archive is out of scope for a JSON store.
- **Best-effort append (never fails the request).** *Cost if wrong:* an audit write lost under disk pressure is a gap, logged to stderr; the operator action itself is unaffected (correct priority — availability over audit completeness under failure).

## 7. Decisions surfaced for owner sign-off

> **OWNER DECISIONS (2026-10-29): ALL THREE scopes (A + B + C), and RECORD 401/403 DENIALS too.** This expands the spec into one activity/history subsystem with **three distinct stores**, plus the denial emit points. Two mechanism rulings this forces (controller):
> - **(C) adoption ledger is a REGISTRY-LEVEL semantic stream, NOT a filter over the (A) action audit.** Reason: the (A) audit is the HTTP operator boundary and deliberately stores no body — but a hive **adoption** arrives over the public agent channel (never the operator host), and `gate`'s version is in the request *body*. So those version-changes are invisible to (A). (C) is therefore a separate append-only `AdoptionLedgerRegistry` emitted from inside `PlatformDeploymentRegistry` (Gate/Ungate, SetWithdrawn restore/withdraw, and `Record` = select/adopt), which HAS the semantic data (tenantId/hiveId/version/action/at). It records the **version-change event and its target**, not an operator actor — "what happened to this hive/tenant"; the (A) action audit separately answers "**who** did which operator action". Together they satisfy the intent without threading an operator identity through the registry (an optional-last ctor param, same pattern as the PA-G5 `policies?` store, so the smokes stay untouched).
> - **(B) Observed history is a bounded per-hive append time-series** replacing the latest-only upsert, keeping `LatestFor` (newest) working for the existing `StatusFor`/Fleet path, adding `HistoryFor(hiveId, limit)`.
> - Denials: the 401 (anonymous actor `'(anonymous)'`) and 403 (role-denied, real actor) mutation returns in `Handle` each also append one (A) entry with the denial status.

1. **Scope — (A) action audit log only (recommended) / (B) + Observed history / (C) + adoption-ledger view.** (§4.) **CHOSEN: all three.**
2. **Record denied/unauthenticated attempts too?** **CHOSEN: yes, include 401/403.** The 401 (no session) and 403 (ReadOnly/role) returns happen in `Handle` **before** `RouteApi`. Recording them too (a) surfaces probing / failed privilege use — real security value — but (b) means an unauthenticated 401 has no actor (store `'(anonymous)'`) and adds two more emit points. **Recommended: record authorized attempts (success and handler-level 4xx/5xx) now; add 401/403 denials as a small follow-up** — keeps one emit seam. vs. **record denials now too.**

## 8. Deferred Features (file as Project #1 Kind=Feature)
- Semantic/domain audit events (rich payload per action, redaction-safe target) beyond the boundary method+path.
- Audit of 401/403 denials (if not chosen in §7.2).
- Durable/exportable audit archive beyond the bounded JSON ring (e.g. the audit store backing a real adoption ledger, SIEM export).
- (If scope A) Observed health history; adoption-ledger view.

## 9. Security invariants (review checklist)
- No audit entry ever contains a body, header, token, password, or reason — only `{ actor, method, path, status, at }`.
- The audit append is best-effort: a failing/full audit store never changes the operator response status.
- Entries are append-only + capped; there is no edit/delete API.
- Every mutating authorized operator request produces exactly one entry with the actual response status (no pre-image optimism; a blocked 409/403-from-handler is recorded as such).
- `GET /api/activity` is authenticated (any operator) and returns only the fixed shape, newest-first, capped.
- New `.ts` pure ASCII + LF; `control-plane-host.ts` keeps its 6 pre-existing non-ASCII bytes.

## 10. Testing / gates
- **Control-plane:** `AuditRegistry` append + unique-id + cap-eviction + Recent-ordering; a host test that a mutating request (e.g. publish, gate, policy hold) writes one entry with the right actor/method/path/status, that a GET writes none, that a handler 4xx is recorded with that status, that a failing audit append does NOT change the response, and that `GET /api/activity` returns newest-first capped. Gate: `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`.
- **Portal:** `ActivityViewModel` label derivation (table-driven: known paths → friendly labels, unknown → raw, status → tone); `ActivityView` renders the table + 5-state; nav item routes to it. Gate: `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`.
