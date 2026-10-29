# SP-HIVE orchestrator-lifecycle wiring (SH-B)

**Status:** design — 2026-10-30.
**Program:** SP-HIVE 100% burn-down, batch SH-B. Closes three SP-HIVE-5 /
in-cluster orchestrator-lifecycle gaps.

## Intent and why

Three gaps in the in-cluster (kind) orchestrator lifecycle: a deleted hive
leaves its kind cluster running, a provisioned env's image is never distributed
into the kind node (only the smokes `LoadImage` it), and a Stopped env's
database StatefulSet keeps consuming a pod. Each is a wiring gap — the
capabilities (`DestroyCluster`, `kind.LoadImage`, `Scale`) exist; nothing calls
them on the real path. Built as wiring + unit tests against fakes; the gated
live-kind smokes that prove end-to-end behaviour are separate (bucket 3).

## Items + acceptance + rulings

1. **DeleteHive → DestroyCluster** (SP-HIVE-5). `platform-directory.DeleteHive`
   only removes the hive record; a Provision-mode kind hive's cluster is left
   running. **Ruling:** wire cluster teardown at the layer that has orchestrator
   access (the provisioning/host hive-delete path, NOT `platform-directory`,
   which must stay orchestrator-free). Only for a **Provision-mode** hive with a
   kind cluster (Attach-mode has no cluster to destroy). `DeleteHive` already
   throws `HiveHasEnvironmentsError` if the hive still has environments, so
   teardown only runs for an empty hive. **Order (fail-closed):** destroy the
   cluster first; only on success remove the record. If destroy fails, surface
   the error and leave the record so the operator can retry (never orphan a live
   cluster behind a deleted record). Unit test with a fake orchestrator:
   Provision-mode delete calls `DestroyCluster` then removes; a destroy failure
   leaves the record; Attach-mode delete never calls `DestroyCluster`.

2. **provisioned-registry-into-kind image distribution** (SP-HIVE-5).
   `KindHiveOrchestrator.Apply` delegates to `inner.Apply` without distributing
   the workload image into the kind node, so a provisioned env can't pull its
   image (smokes work only because they `kind.LoadImage` explicitly). **Ruling:**
   `KindHiveOrchestrator.Apply` loads the workload image into its cluster via
   `kind.LoadImage(image, clusterName)` BEFORE `inner.Apply`. Idempotent /
   best-effort is fine (kind load is repeatable). Unit test: Apply calls
   `LoadImage(workloadImage, clusterName)` before `inner.Apply`.

3. **In-cluster Stop → also scale the DB StatefulSet to zero** (DclYs follow-up).
   `InClusterEnvironmentRuntime.Stop` scales only the server Deployment to 0; a
   Stopped env with a database keeps an idle DB pod. The DclYs design
   deliberately left the DB up to avoid a Start-time DB-readiness race.
   **Ruling:** scale the DB StatefulSet to 0 on Stop AND fix the race the
   original design worried about — on **Start**, bring the DB StatefulSet up
   **first and wait for its readiness** before scaling the server Deployment up,
   so the server never starts against an unready DB. Only when the workload has
   a database; a DB-less env is unchanged. This needs an orchestrator capability
   to scale/await the DB StatefulSet (add a targeted method, e.g.
   `ScaleDatabase(workload, replicas)` + reuse `WaitHealthy`/a DB-ready wait, or
   extend `Scale` to cover the StatefulSet — implementer's call, keep it minimal
   and OOP). Unit test with a fake orchestrator: Stop scales both server→0 and
   DB→0; Start brings DB→1 (awaited) before server→1; a DB-less env scales only
   the server.

## Constraints (Global)

- ASCII + LF. Byte-scan each touched file (`0 0 N`); `k8s-manifest-builder.ts`
  (if touched) stays `15 0 N`. (These items mostly touch
  `kind-hive-orchestrator.ts`, `in-cluster-environment-runtime.ts`,
  `hive-orchestrator.ts`, the provisioning/host hive-delete path, and tests —
  all 0 non-ASCII at base; byte-scan to confirm.)
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; PascalCase public
  members; no module-level free functions/state.
- Gates: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` +
  `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.**

## Review focus

- **Fail-closed delete:** a failed `DestroyCluster` must NOT remove the hive
  record (no orphaned live cluster behind a deleted record); Attach-mode never
  calls `DestroyCluster`.
- **No DB-readiness race on Start:** the server Deployment must not scale up
  until the DB StatefulSet is ready (the exact concern the DclYs design
  deferred this item over).
- **Backward-compatible Stop/Start for DB-less envs:** unchanged behaviour.
- **Idempotent image load:** re-Apply must not fail on an already-loaded image.
