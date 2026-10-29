# Store Read Performance — Non-Cloning Internal Iteration (deferred burn-down D2)

**Status:** design (no fork — not security-sensitive)
**Date:** 2026-10-29
**Program:** Program 2 deferred burn-down, spec D2.

## Intent and why

`JsonRecordStore.List()` returns a deep clone of **every** record
(`[...records.values()].map(r => structuredClone(r))`). Registries that
need one entity's records call `List()` and then filter — cloning the whole
store to read a slice of it.

The named hot path: `ControlPlaneHost.BuildFleet()` maps over every hive and
calls `observations.LatestRecord(hive.id)`; each call runs
`HiveObservationRegistry.AscendingFor` → `this.List()`, deep-cloning **all**
observations across **all** hives (a bounded time-series, `MaxPerHive = 50`
each) only to keep one hive's. At N hives that is **N × (N·50) =
O(N²·50) `structuredClone`s** per fleet render — quadratic in hive count.

Fix: give the store a non-cloning, read-only **internal** accessor so a
registry can filter/aggregate over the live records and clone only the small
subset it actually returns — while the public `List()`/`Get()` defensive-copy
guarantee is untouched.

## Goals

- Eliminate the full-store deep clone on the fleet/observation read path.
- The fleet render clones at most each hive's own ≤`MaxPerHive` records per
  call instead of the whole store: **O(N·50)** across the loop, not O(N²·50).
- **No public API or behavior change.** `List()`, `Get()`, `LatestFor`,
  `LatestRecord`, `HistoryFor` keep their signatures and semantics; records
  handed to callers remain independent copies (store state immune to caller
  mutation).

## Non-goals / anti-goals

- **No secondary hiveId index.** The O(N²) *iteration over references* stays
  (cheap: pointer walks, no clone). A per-key index is a separate Feature if
  ever needed.
- **No refactor of the other `List()`-in-loop callers** (environment-service
  port scan, platform-deployment-registry gating/env loops) — the accessor
  is general and they may adopt it later; out of scope here.
- Not security-sensitive; no behavior that touches auth, secrets, or audit.

## Design (decided)

1. `JsonRecordStore` gains `protected Values(): IterableIterator<TRecord>`
   returning `this.records.values()` — the **live** record references, no
   clone. Documented: *internal, read-only; callers must not mutate the
   yielded records.* It is `protected`, so the public defensive-copy surface
   (`List`/`Get`) is unchanged and nothing external can reach live refs.
2. `HiveObservationRegistry.AscendingFor(hiveId)` filters over `this.Values()`
   (not `this.List()`), then returns a **clone of the per-hive subset**
   (`structuredClone`, ≤`MaxPerHive`), sorted ascending. `LatestFor`,
   `LatestRecord`, `HistoryFor` are unchanged — they still receive and hand
   out independent copies, so the public guarantee holds.

## Constraints (Global)

- New/modified `.ts`: pure ASCII, LF only. Byte-scan each touched file
  (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` → `0 0 N`).
- OOP + Allman braces; no module-level free functions/state; no inline string
  literals; PascalCase public methods.
- Control-plane gate: `npx tsx --test admin/control-plane/tests/*.test.ts`
  AND `npm run typecheck:tools`. (No portal change in this spec.)
- Merge locally (ff-only into master); **NEVER push.**

## Review focus (spec-implied)

- **Defensive copy preserved:** mutating a record returned by `LatestRecord`
  / `HistoryFor` / `LatestFor` must NOT change what a later read returns
  (the clone of the subset is what makes this hold after switching off
  `List()`).
- **`Values()` stays internal:** not exported publicly; no external caller
  can obtain a live reference.
- **Fleet path no longer clones other hives' records** — a read for hive A
  does not `structuredClone` hive B's observations.
- **Ordering unchanged:** `AscendingFor` is still oldest-first, stable on
  `reportedAt` ties; `HistoryFor` still newest-first and limited.
