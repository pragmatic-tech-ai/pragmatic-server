# SEC-E: Revoke record shares on delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A record delete that applies removes all of that record's share grants, so reusing the same `(concept, recordId)` later inherits no access (closes the stale-share resurrection bug).

**Architecture:** Add `ShareStore.RevokeAllForRecord(concept, recordId)` (built on existing `ListForRecord` + public `Revoke`), and call it from `PragmaticServer.WriteForPragmaticApp` for each applied `Delete` op, guarded fail-closed like `ShareIndexFor`. The per-request `ShareGrantIndex` needs no change (rebuilt from the store each request).

**Spec:** `docs/superpowers/specs/2026-10-30-sec-e-revoke-shares-on-delete-design.md` (rulings — read it).

## Global Constraints

- ASCII + LF. All touched files are LF / 0 non-ASCII at base — preserve. Byte-scan base + each touched file. Never `sed -i`.
- OOP + Allman braces; no inline string literals (reuse existing class constants; `AppWriteStatus`/`AppWriteOpKind` are protocol enums); PascalCase public members; no module-level state.
- Gate: realm `npm test` (`tsx --test "src/**/*.test.ts"`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- Deleting a shared record removes every grant for `(concept, recordId)` (all subjects/rights); `ListForRecord` then returns empty.
- Delete + recreate of the same id → a previously-shared principal has no inherited read/write/assign/share access to the new record.
- Only `Applied` deletes revoke; `Denied`/`Invalid`/`NotProcessed` deletes and all upserts do not. Correct op↔result index correlation in a mixed batch.
- Fail-closed where the share store is unavailable (write still succeeds, no revoke attempted, no error leaks).
- No over-revoke across records/concepts.
- EOL: touched files LF / 0 non-ASCII.

---

### Task 1: `ShareStore.RevokeAllForRecord`

**Files:** `src/host/sharing/share-store.ts` (LF), `src/host/sharing/tests/share-store.test.ts` (LF, extend — it uses an inline `FakeSession` implementing `Find`/`Upsert`/`Delete`).

**Interfaces:**
- Consumes: existing `ListForRecord(concept, recordId)` and public `Revoke(concept, recordId, kind, subjectId)`.
- Produces: `public async RevokeAllForRecord(concept: string, recordId: string): Promise<number>` — removes all grants for the record, returns the count removed.

- [ ] Failing tests (extend `share-store.test.ts`, mirror its `FakeSession` + the existing `'grant round-trips through list; revoke removes it'` test): (a) grant two subjects on `(C, "r1")` and one subject on `(C, "r2")`, then `RevokeAllForRecord(C, "r1")` returns 2, `ListForRecord(C, "r1")` is empty, and `ListForRecord(C, "r2")` still has its 1 grant (no over-revoke); (b) `RevokeAllForRecord` on a record with no grants returns 0 and does not throw; (c) grants for a *different concept* with the same recordId string are untouched (confirm the concept is part of the match).
- [ ] Implement: `RevokeAllForRecord` = `const grants = await this.ListForRecord(concept, recordId); for (const grant of grants) { await this.Revoke(grant.concept, grant.recordId, grant.subject.kind, grant.subject.id) } return grants.length`. Allman; PascalCase; no new literals.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan both files LF / 0 non-ASCII. Commit (explicit paths).

### Task 2: Revoke shares for applied deletes in `WriteForPragmaticApp`

**Files:** `src/pragmatic-server.ts` (LF), `src/host/cypher/tests/server-record-sharing.test.ts` (LF, extend — full e2e via `PragmaticServer` + `PpSecurityHarness`; it already reaches `server.AppShareStore(name)` and deletes a shared record `rec-del`).

**Interfaces:**
- Consumes: `ShareStore.RevokeAllForRecord` (Task 1); `this.AppShareStore(name)`; `writer.Apply(operations)` returning `{ results: AppWriteOpResultDto[] }` positionally aligned to `operations`; `AppWriteOpKind.Delete` and `AppWriteStatus.Applied` (protocol enums — import as needed; the writer already uses `AppWriteStatus`).
- Produces: `WriteForPragmaticApp` revokes shares for applied deletes; a private helper method (e.g. `RevokeSharesForDeletedRecords(name, operations, result)`).

- [ ] Failing test (extend `server-record-sharing.test.ts`): share a record (e.g. `rec-del`) Read (and ideally one more right) to a principal/team; confirm the share is visible/effective; delete `rec-del` (assert the op result is Applied); then assert the grant is gone — either `server.AppShareStore(name).ListForRecord(concept, 'rec-del')` is empty, AND/OR recreate `rec-del` and assert the previously-shared principal can NOT read it (no stale widening). Also add a negative: a delete that is Denied (principal lacks Delete) does NOT remove the share (mirror an existing denied-delete setup if present), and an upsert does not remove shares.
- [ ] Implement: in `WriteForPragmaticApp`, change `return writer.Apply(operations)` to capture `const result = await writer.Apply(operations)`, then `await this.RevokeSharesForDeletedRecords(name, operations, result)`, then `return result`. The private `RevokeSharesForDeletedRecords(name, operations, result)`: obtain the store in a `try { store = this.AppShareStore(name) } catch { return }` (fail-closed like `ShareIndexFor`); loop `index` over `operations`, and when `operations[index].op === AppWriteOpKind.Delete` && `operations[index].id` is non-empty && `result.results[index]?.status === AppWriteStatus.Applied`, `await store.RevokeAllForRecord(operations[index].concept, operations[index].id)`. Allman; hoist any new literal to a constant (there should be none new); no behavior change to the returned result.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan both files LF / 0 non-ASCII. Commit (explicit paths).

## Final verification (whole branch)

- `npm test` — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan touched files: LF, 0 non-ASCII.
