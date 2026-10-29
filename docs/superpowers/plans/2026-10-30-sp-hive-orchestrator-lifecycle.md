# SP-HIVE Orchestrator Lifecycle (SH-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire three in-cluster (kind) orchestrator-lifecycle gaps — destroy a deleted hive's cluster, distribute the provisioned image into kind, and scale the DB StatefulSet down on Stop / back up (readiness-first) on Start.

**Architecture:** Wiring of existing capabilities (`DestroyCluster`, `kind.LoadImage`, `Scale`) into the real paths, each with unit tests against fakes. Live-kind end-to-end proof is a separate gated smoke (out of scope).

**Spec:** `docs/superpowers/specs/2026-10-30-sp-hive-orchestrator-lifecycle-design.md` (acceptance + rulings live there — read it).

## Global Constraints

- ASCII + LF. Byte-scan each touched file (`0 0 N`); if `k8s-manifest-builder.ts` is touched it stays `15 0 N`.
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); enums over string unions; PascalCase public members; no module-level free functions/state.
- Gates: `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never stage docs.

## Review Focus

- A failed `DestroyCluster` must NOT remove the hive record; Attach-mode never calls `DestroyCluster`.
- On Start, the server must not scale up until the DB StatefulSet is ready (no readiness race).
- DB-less envs: Stop/Start unchanged.
- Re-Apply must not fail on an already-loaded image (idempotent load).

---

### Task 1: DeleteHive → DestroyCluster (Provision-mode, fail-closed)

**Files:** the host/provisioning hive-delete path (locate the caller of `directory.DeleteHive` that has orchestrator-factory access — `control-plane-host.ts` `DeletePlatform` and/or `provisioning-orchestrator.ts`), `admin/control-plane/kind-hive-orchestrator.ts` (`DestroyCluster` exists), tests under `admin/control-plane/tests/`.

- [ ] Failing test: deleting a Provision-mode kind hive (no envs) calls `DestroyCluster` then removes the record; a `DestroyCluster` rejection leaves the record present and surfaces the error; an Attach-mode hive delete never calls `DestroyCluster`.
- [ ] Implement: resolve the hive's orchestrator (Provision-mode kind only) at the delete path; destroy-then-remove; keep `platform-directory.DeleteHive` orchestrator-free (do the teardown in the caller that owns orchestrators). Preserve the existing `HiveHasEnvironmentsError` guard.
- [ ] Verify control-plane gate + typecheck:tools; byte-scan touched files. Commit (explicit paths).

### Task 2: registry-into-kind image distribution on Apply

**Files:** `admin/control-plane/kind-hive-orchestrator.ts`, `admin/control-plane/kind.ts` (`LoadImage` exists), tests.

- [ ] Failing test: `KindHiveOrchestrator.Apply(workload)` calls `kind.LoadImage(workload image, clusterName)` BEFORE `inner.Apply(workload)`.
- [ ] Implement: load the workload image into the cluster before delegating to `inner.Apply`; idempotent/best-effort.
- [ ] Verify + byte-scan + commit (explicit paths).

### Task 3: Stop scales DB StatefulSet to 0; Start brings it up readiness-first

**Files:** `admin/control-plane/in-cluster-environment-runtime.ts`, `admin/control-plane/hive-orchestrator.ts` (interface + a targeted DB-scale/await capability), the kind orchestrator impl, tests.

- [ ] Failing test: Stop of an env WITH a database scales server→0 and DB StatefulSet→0; Start brings DB→1 and awaits readiness BEFORE server→1; a DB-less env scales only the server on Stop/Start (unchanged).
- [ ] Implement: add the minimal orchestrator capability to scale + await the DB StatefulSet (new method or extend `Scale`, implementer's call, OOP + no inline literals); wire `InClusterEnvironmentRuntime.Stop`/`Start` accordingly; gate on `workload.database !== undefined`.
- [ ] Verify control-plane gate + typecheck:tools; byte-scan touched files. Commit (explicit paths).

## Final verification (whole branch)

- `npx tsx --test admin/control-plane/tests/*.test.ts` — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: `0 0 N` (k8s-manifest-builder.ts, if touched, `15 0 N`).
