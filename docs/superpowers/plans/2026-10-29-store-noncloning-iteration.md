# Store Non-Cloning Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the fleet/observation read path deep-cloning the entire observation store; filter over live references and clone only the per-hive subset returned.

**Architecture:** Add a `protected` non-cloning iterator to `JsonRecordStore`; rewrite `HiveObservationRegistry.AscendingFor` to use it, cloning only its ≤`MaxPerHive` result. No public API/behavior change.

**Tech Stack:** TypeScript (Node ESM), node:test, admin/control-plane.

**Spec:** docs/superpowers/specs/2026-10-29-store-noncloning-iteration-design.md

## Global Constraints

- New/modified `.ts`: pure ASCII, LF only. Byte-scan every touched file → `0 0 N`.
- OOP + Allman braces; no module-level free functions/state; no inline string literals; PascalCase public methods.
- Control-plane gate: `npx tsx --test admin/control-plane/tests/*.test.ts` AND `npm run typecheck:tools`. node:test summary lines prefixed with `ℹ`; grep `"(tests|pass|fail) [0-9]"`.
- Merge locally (ff-only into master); **NEVER push.** Stage by explicit path. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- Defensive copy preserved: mutating a record returned by `LatestRecord`/`HistoryFor`/`LatestFor` must not change a later read (Task 1 tests this directly).
- Reading hive A must not clone hive B's records (perf assertion via a `structuredClone` spy / call-count, or by asserting `List` is not called on the path).
- Ordering unchanged: ascending stable on `reportedAt`; `HistoryFor` newest-first + limited.

---

### Task 1: Non-cloning internal iterator + observation registry rewrite

**Files:**
- Modify: `admin/control-plane/json-record-store.ts`
- Modify: `admin/control-plane/hive-observation-record.ts`
- Test: `admin/control-plane/tests/hive-observation-record.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `JsonRecordStore` gains `protected Values(): IterableIterator<TRecord>` returning `this.records.values()` (the live refs, no clone). Public `List`/`Get`/`Put`/`Remove`/`Load` unchanged.
- `HiveObservationRegistry.AscendingFor(hiveId)` now iterates `this.Values()`; returns a `structuredClone`d, ascending-sorted copy of the per-hive subset. `LatestFor`/`LatestRecord`/`HistoryFor` signatures + semantics unchanged.

- [ ] **Step 1: Write failing / characterizing tests** in `tests/hive-observation-record.test.ts` (reuse the temp-dir + Load fixture pattern from the sibling store tests):
  - **defensive copy preserved:** record a snapshot for hive `h1`; call `LatestRecord('h1')`, mutate the returned object's `environments` (push/alter); call `LatestRecord('h1')` again and assert the second read is unaffected (deep-equal to the originally recorded shape). Likewise mutate an element from `HistoryFor('h1', 10)` and assert a re-read is clean.
  - **isolation across hives:** snapshots for `h1` and `h2`; `LatestFor('h1')` returns only h1's environments; `LatestRecord('h2')` only h2's.
  - **ordering:** three snapshots for `h1` with increasing `reportedAt` → `HistoryFor('h1', 10)` newest-first; `LatestRecord('h1')` is the newest; `AscendingFor` behavior visible through these.
  - **no cross-hive clone (perf):** spy on `structuredClone` (e.g. wrap/replace `globalThis.structuredClone` for the duration, restore in `finally`) or count clones; with many h2 records present, a single `LatestRecord('h1')` must clone at most h1's records (`<= MaxPerHive`), NOT the whole store. Assert the clone count is bounded by h1's record count, independent of h2's volume. (If spying on the global is awkward in this runner, instead assert via a subclass test that overrides nothing and measure that reading h1 does not depend on h2 volume — but prefer the clone-count spy.)
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/hive-observation-record.test.ts` → the no-cross-hive-clone test FAILs against today's `List()`-based `AscendingFor` (it clones the whole store); the defensive-copy and ordering tests should PASS already (characterizing — they must stay green after the change).
- [ ] **Step 3: Implement** — add `protected Values()` to `JsonRecordStore`; rewrite `AscendingFor` to `[...this.Values()].filter(r => r.hiveId === hiveId).sort(...)` then `.map(r => structuredClone(r))` (clone the per-hive subset). Keep the oldest-first stable sort. Do NOT change any public signature.
- [ ] **Step 4: Run** the test file → all PASS. Then the FULL gate: `npx tsx --test admin/control-plane/tests/*.test.ts` and `npm run typecheck:tools`. Byte-scan both modified files + the test → `0 0 N`.
- [ ] **Step 5: Commit** `git add admin/control-plane/json-record-store.ts admin/control-plane/hive-observation-record.ts admin/control-plane/tests/hive-observation-record.test.ts && git commit`.
