# SEC-E: Revoke a record's shares when the record is deleted (stale-share resurrection)

**Status:** design — FORK-FREE (the only conceivable "fork", intentionally
preserving shares across delete+recreate, is a security anti-pattern — the
reported bug — so revoke-on-delete is the unambiguous correct behavior).
**Program:** suite security-hardening (SP-5 follow-up / platform record
sharing). **Source item:** "[platform] SP-5 follow-up: revoke record shares on
delete (stale-share resurrection)".

## Problem (confirmed by recon)

Per-app record shares live in `ShareStore` (one document per grant in the
reserved `__shares` collection), keyed by `(concept, recordId, subjectKind,
subjectId)` where `recordId` is the **bare app-logical business key** the
client supplies — stable across delete and recreate. The runtime delete path
(`PragmaticServer.WriteForPragmaticApp` -> `RuntimeAppWriter.Apply` ->
`PlanDelete` -> adapter row/node delete) **never touches `ShareStore`**. So:

1. A record `(concept, "o1")` is shared to principal/team P (Read/Update/
   Delete/Assign/Share).
2. The record is deleted (delete op applies).
3. A new record is created with the same id `"o1"`.
4. The surviving grant docs — still keyed `(concept, "o1")` — are rebuilt into
   the per-request `ShareGrantIndex` and **silently re-widen** P's read
   visibility (`ShareWideningInstanceFilter`) and write/assign/re-share power
   (`ShareWideningWriteAuthorizer`, the by-id Update/Delete/Assign gates) over
   the *new* data. P regains access it was never re-granted.

`ShareStore` has no "remove all grants for a record" primitive — only
single-subject `Revoke(concept, recordId, kind, subjectId)`. An existing test
(`server-record-sharing.test.ts`) even deletes a shared record and never checks
the grant is gone — the grant survives.

## Goal

A record delete that actually applies removes **all** of that record's share
grants, so a later record reusing the same `(concept, recordId)` starts with no
inherited access.

## Scope

### IN

1. **`ShareStore.RevokeAllForRecord(concept: string, recordId: string):
   Promise<number>`** — enumerate the record's grants (`ListForRecord`) and
   delete each via the existing public `Revoke(...)`; return the count removed.
   Built entirely on existing `IDocumentSession` primitives (no new store
   capability, no backend). The per-request `ShareGrantIndex` needs no change —
   it is rebuilt from the store each request, so clearing the store entries is
   sufficient.

2. **Call it at the delete seam in `PragmaticServer.WriteForPragmaticApp`.**
   After `writer.Apply(operations)` returns its positionally-aligned
   `{ results }`, for each operation `i` where `operations[i].op ===
   AppWriteOpKind.Delete` **and** `result.results[i].status ===
   AppWriteStatus.Applied` (and the op has a non-empty id), call
   `store.RevokeAllForRecord(operations[i].concept, operations[i].id)` using
   `store = this.AppShareStore(name)`. This keeps `RuntimeAppWriter` entirely
   store-agnostic. Factor the loop into a private helper method (OOP, no inline
   literals).

3. **Fail-closed guard.** `AppShareStore(name)` can throw where
   `CreateAppDataStore` is unsupported (e.g. Cloud) — mirror `ShareIndexFor`'s
   existing swallow: if the store can't be obtained, perform no revokes
   (sharing is simply inactive there) and never let it break the write result.

### OUT (rulings)

- **Assignment grants / owner columns.** There is no separate assignment store:
  `Assign` writes owner/owningBU **columns on the record row** (gone with the
  delete) plus `PrivilegeAction.Assign` entries in `__shares` (cleared by
  `RevokeAllForRecord` like every other right). So no separate assignment
  cascade is needed — covered.
- **Child/cascade.** Shares are a flat `(concept, recordId)` map with no
  parent/child relation; delete is per-record and so is the revoke. N/A.
- **Transactional atomicity.** The revoke runs after the adapter delete, not in
  the same transaction, so a crash in the (small) window between could leave
  stale grants. **Ruling:** acceptable — strictly better than today (never
  revoked) and consistent with the store's existing non-transactional usage.
  Not blocking; a hardening follow-up (transactional/idempotent cleanup or a
  sweep) can be filed if desired. Cost if wrong: a crash mid-delete leaves a
  stale grant exactly as today. Low.
- **Upsert/update ops.** Only `Delete` orphans a record's shares; upsert keeps
  the record, so its shares remain valid. Revoke is scoped to applied deletes.

## Approach (the how that is decided)

- `RevokeAllForRecord` reuses `ListForRecord` + the public `Revoke` (no
  duplication of `KeyFor`/`Delete`).
- The seam lives in `WriteForPragmaticApp` (not `RuntimeAppWriter`) so the
  writer stays store-agnostic; `this.AppShareStore(name)` is already in scope
  there (the method already calls `ShareIndexFor`).
- No secret/token handling; no audit change; layering unchanged (all within
  `src/host/sharing` + `src/pragmatic-server.ts`, host layer).

## Constraints (Global)

- ASCII + LF. At base, all touched files are LF / 0 non-ASCII — preserve:
  `src/host/sharing/share-store.ts`, `src/pragmatic-server.ts`, and the tests.
  Byte-scan base + each touched file. Never `sed -i`.
- OOP + Allman braces; no inline string literals (reuse the class's existing
  `private static readonly` constants / enums; `AppWriteStatus` +
  `AppWriteOpKind` are protocol enums); PascalCase public members; no
  module-level state.
- Gate: realm `npm test` (`tsx --test "src/**/*.test.ts"`) +
  `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path;
  never `git add -A`; never docs.

## Review focus

- **Shares gone after an applied delete:** deleting a shared record removes
  every grant for `(concept, recordId)` (all subjects, all rights) from the
  store; a subsequent `ListForRecord` returns empty.
- **No resurrection:** after delete + recreate of the same id, a previously-
  shared principal has NO inherited read/write/assign/share access to the new
  record (the per-request index no longer sees the grants).
- **Only applied deletes revoke:** a delete that is `Denied`/`Invalid`/
  `NotProcessed` does NOT revoke shares (the record still exists); an upsert
  never revokes.
- **Correct op↔result correlation:** the revoke uses the same index into
  `operations` and `result.results`; a mix of upserts and deletes in one batch
  revokes only the applied-delete records.
- **Fail-closed:** where the share store is unavailable, the write still
  succeeds and no revoke is attempted (no thrown error leaks into the write
  result).
- **No over-revoke:** revoking record A's shares never touches record B's, nor
  a different concept's.
- **EOL:** touched files LF / 0 non-ASCII.
