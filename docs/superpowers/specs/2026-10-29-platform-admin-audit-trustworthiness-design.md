# Platform-Admin — Audit Trustworthiness (deferred burn-down D1)

**Status:** design (fork pending)
**Date:** 2026-10-29
**Program:** Program 2 — server/platform/identity hardening. First spec of the *deferred-backlog burn-down* (user: "lets work deferreds and close them").
**Depends on:** PA-G9 Activity History (the three audit/observation/ledger stores + Activity view + `/api/activity`).

## Intent and why

PA-G9 shipped the operator-action audit log, but it does not yet tell the
whole truth, and three deferred items (topic-file line 522) name the gaps:

1. **Invisible outcomes.** An authorized mutation whose handler *throws* is
   answered `500` but never audited — the post-dispatch audit emit
   (`control-plane-host.ts` ~674) lives inside the `try`, so the exception
   jumps past it to the `catch` at ~679. The operator did a thing, it
   failed, and the log is silent. Likewise the bad-origin `403` transport
   guard (~637) is never audited.
2. **The bad-origin 403 is *deliberately* unaudited today** (inline comment
   at ~638): "it has no actor, and auditing it would let an unauthenticated
   cross-origin caller flood the capped log." That rationale is the same
   flood concern behind the throttle/quota deferred — so the two are
   coupled. A flood mitigation is the *precondition* that makes recording
   pre-auth denials safe.
3. **Severity is flattened.** The portal `ActivityViewModel.ToneFor` maps
   `2xx→Success` and *everything else→Warning*, so a `500` server error
   reads the same as a routine `403`. `PillTone.Danger` already exists
   (used by Disconnected/Degraded) and is unused here.

This spec finishes the subsystem so **every operator-relevant outcome is
recorded, a pre-auth flood cannot evict genuine history, and the portal
shows severity honestly** — the reported==enforced spine extended to the
audit log's own completeness.

## Goals

- Audit the authorized-mutation **500 handler-throw** outcome (always; it
  is `who !== null`, never a flood risk).
- Protect the capped audit ring so **unauthenticated / denied floods cannot
  evict authorized history** (mechanism chosen at the fork below).
- Under that protection, audit the **bad-origin 403** for completeness and
  consistency with the already-audited anonymous `401`.
- Portal: **Danger tone for 5xx**, Warning for 4xx, Success for 2xx, in the
  Activity view.

## Non-goals / anti-goals

- **No durable/DB audit archive**, no exportable log beyond the JSON ring —
  stays a filed Feature.
- **No semantic/domain audit events** (richer than the boundary
  method+path) — stays a filed Feature.
- **No distributed / cross-process throttle** — in-memory only, matching
  `LoginThrottle`. A multi-replica deployment is out of scope.
- **No tenant-facing ledger route/view** — that is a separate burn-down
  spec (spans the tenant-admin app).
- **Never a fabricated backend.** All mechanisms are in-memory, in-process.
- The audit store continues to **persist no request body/header/token/
  password/reason** — only `{actor, method, path, status, at}`. Nothing in
  this spec adds a field that could carry a secret.

## Constraints (Global)

- New `.ts` files: pure ASCII, LF only. `control-plane-host.ts` keeps
  exactly its 6 pre-existing non-ASCII bytes (byte-scan every touched file).
- OOP + Allman braces; no module-level free functions or state; no inline
  string literals (hoist to `private static readonly`); enums over string
  unions; VMs extend `Observable`.
- Control-plane gate: `npx tsx --test admin/control-plane/tests/*.test.ts`
  **and** `npm run typecheck:tools`. Portal gate:
  `npm --prefix admin/portal test` **and**
  `npm --prefix admin/portal run typecheck`. Run sequentially.
- Best-effort audit is preserved: an audit append still **never throws and
  never alters the operator response** (`RecordAudit` swallows + logs).
- Merge locally (ff-only into master); **NEVER push.**

## Decided design (not forked)

### Item 1 — audit the 500 handler-throw (always)

Restructure `Handle` so the post-dispatch audit of an authorized mutation
fires on the **final response** whether the handler returned normally or
threw. Today:

```
const handled = await this.RouteApi(req, res, path)   // may throw
if (!handled) { await PlaneHttp.ServeStatic(...) }
// emit here — SKIPPED when RouteApi throws
if (who !== null && IsMutating && isApi && !isPublic) { RecordAudit(..., res.statusCode) }
```

Target: the emit runs in a `finally` (or equivalent) after `WriteError`
has set `res.statusCode` to 500, keyed on the same guard
(`who !== null && IsMutating && isApi && !isPublic`) and on
`res.statusCode` as the final outcome. A thrown handler → `catch` writes
500 → `finally` audits the 500. A normal return → `finally` audits the
real status (unchanged behavior for the success path). The emit must read
`res.statusCode` *after* the response is written, exactly as today.

### Item 4 — Danger tone (portal)

`ActivityViewModel.ToneFor(status)`: `2xx → Success`, `5xx → Danger`,
everything else → `Warning`. New `private static readonly` bounds for the
5xx range. Update the existing test that asserts "401/403/500 all Warning"
to assert `500 → Danger`, `401/403 → Warning`.

## Open decisions (FORK — security-sensitive)

### Q1 — anti-flood mechanism for the capped audit ring

- **A. Quota-partition eviction (in `AuditRegistry`).** When over the
  1000-cap, evict the oldest **denied/anonymous** entries (status 401/403
  or actor `(anonymous)`) *before* any authorized entry; only fall back to
  evicting authorized history once no denied entries remain. No request is
  ever rejected, every outcome stays auditable, no new ctor wiring. Pure
  in-memory policy change. **(Recommended.)**
- **B. Per-IP rate throttle (`LoginThrottle`-style).** Reject anonymous /
  pre-auth mutating floods with `429 + Retry-After` *before* auditing, so
  flood volume never reaches the ring. New optional-last ctor param on
  `ControlPlaneHost`, wired in `server.ts` + fixture. Adds a reject path.
- **C. Both.** Throttle at the door + quota partition in the ring
  (defense in depth).

### Q2 — completeness: which now-invisible outcomes to start auditing

- **A. Both the bad-origin 403 and the 500 handler-throw** (full
  completeness; Origin-403 safe under Q1's mechanism). Replace the inline
  "deliberately not audited" rationale with the new one. **(Recommended.)**
- **B. 500 handler-throw only** — keep the bad-origin 403 unaudited per the
  existing comment (no change to the pre-auth transport path).

> The 500 handler-throw (Item 1) is audited regardless of Q2 — it is an
> authorized outcome, never a flood risk. Q2 governs only the pre-auth
> bad-origin 403.

## Files (anticipated; finalized in the plan)

- `admin/control-plane/audit-record.ts` — quota-partition eviction (if Q1
  A/C).
- `admin/control-plane/control-plane-host.ts` — finally-audit the final
  outcome (Item 1); audit the bad-origin 403 (if Q2 A); throttle wiring (if
  Q1 B/C). Keeps its 6 non-ASCII bytes.
- `admin/control-plane/audit-throttle.ts` (NEW, only if Q1 B/C).
- `admin/control-plane/server.ts` + `tests/rollout-fixture.ts` — throttle
  wiring (only if Q1 B/C).
- `admin/portal/src/activity-view-model.ts` + its test — Danger tone
  (Item 4).
- Tests alongside each.

## Review focus (spec-implied, likely to bite)

- Eviction under a burst that is *all authorized* (quota partition must
  still evict oldest-authorized when no denied entries exist — never grow
  unbounded).
- The 500-throw audit must not double-audit a normal success, and must not
  audit twice when both the try-emit and finally-emit could run — there is
  exactly **one** emit site after restructure.
- A denied/anonymous entry under quota partition must still be *visible*
  until genuinely evicted (don't drop it on write).
- Best-effort invariant holds: audit failure never changes the 200/403/500
  the operator sees.
- Byte-scan: `control-plane-host.ts` stays at 6 non-ASCII; new files 0.
