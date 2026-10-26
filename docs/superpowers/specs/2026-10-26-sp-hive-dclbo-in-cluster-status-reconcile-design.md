# Dclbo — Real in-cluster env status reconcile via the health monitor (design)

**Status:** approved for planning (AFK autonomous run; merge locally, never push).
**Project item:** `PVTI_lADOE0Zc984Biu4ozhDclbo` (Kind=Feature) — "Real in-cluster env status/health wiring".
**Spun off from:** P2 in-cluster-env-create. The reconcile loop Docker-probes unbound records only; a
hive-bound (in-cluster) record's `status` stays at whatever an explicit lifecycle call last wrote, so an
out-of-band change (crash, eviction, scale) never updates it.

## Intent & why

For Docker, `EnvironmentRegistry.Reconcile` (`admin/control-plane/environment-registry.ts:70-82`) probes the
container on every `ListReconciled` and flips `record.status` Running↔Stopped. For in-cluster it `continue`s
past the record (`:74`) with the comment "status is owned by the hive agent" — but nothing writes it back,
so after Create the record reads `Running` forever even if the pod crashed or was scaled to zero
out-of-band. Explicit transitions ARE reflected (Create/Start→Running, Stop→Stopped via `SetStatus`); the
gap is the out-of-band reconcile. The stale value is read by the tenant env list
(`tenant-api-endpoint.ts:149-151`), the operator list (`control-plane-host.ts:519`), the tenant-portal tree
label (`tenant-tree-view.ts:92`), and the `RequireRunning` gate (`loop-orchestrator.ts:470-477`).

## Design — push status from the background health monitor, NOT a synchronous list-time probe (ruling)

The obvious approach — probe the cluster inside `EnvironmentService.ListReconciled` — is REJECTED. `kubectl get`
runs with a 300 s timeout (`kubectl.ts:43`); probing sequentially on every list, on the OPERATOR endpoint that
spans all hives, would let one wedged/unreachable hive hang every env list for minutes. Today the operator
list never touches `kubectl` for in-cluster records; a list-time probe would newly couple list latency to
cluster reachability. (A local `docker inspect` is not a remote `kubectl get` that can hang — so "same cost
as Docker's probe" does not hold.)

Instead, reconcile `record.status` from the **already-running background `TenantHealthMonitor`**
(`admin/control-plane/tenant-health-monitor.ts`), which:
- runs a self-rescheduling loop in the SAME process that owns the env records — wired in both the collapsed
  dev server (`server.ts:175`) and the split tenant-admin (`tenant-admin-server.ts:183`);
- already produces per-env `{ ready, detail, runningImage }` via `HiveHealthProducer.Produce` (which already
  holds the `EnvironmentService`) and already DIFFS `{ready,detail}` against a snapshot and emits
  `HealthChanged`;
- already carries a bounded `probeTimeoutMs` (so a slow hive can't wedge the loop).

So the mirror (`record.status`) is refreshed in the background, authoritative for every reader (list/tree/
gate), with ZERO latency added to any list and no new way for a down hive to block a read. This makes the
"status is owned by the hive agent" comment's spirit real (the control-plane monitor owns it), without
building a hive-agent reporter.

## The mechanism

- `TenantHealthMonitor` gains a narrow status-writer dependency (inject the `EnvironmentService`, used only to
  `SetStatus`, OR a one-method `IEnvStatusReconciler` the service implements — builder's choice, keep it
  narrow). In the monitor's per-hive tick, AFTER producing per-env health, for each env whose CLEAN `ready`
  implies a status different from the stored `record.status`, call `SetStatus(env, ready ? Running : Stopped)`.
- `HiveHealthProducer.Produce` (`hive-health-producer.ts:35-45`) becomes **per-env fault-tolerant**: today its
  `for` loop `await`s `orchestrator.Health` with no per-env guard, so ONE env whose deployment is missing
  (`kubectl get` exits non-zero → `KubectlError`) throws for the WHOLE hive, blanking every env's health. Wrap
  each env's `Health` in a per-env guard so a single failure yields an "unknown" entry (or is omitted) without
  aborting the others. This also hardens the existing `/tenant-api/hives/:id/health` route.
- Status derivation: a CLEAN probe returning `ready=false` (deployment exists, 0 ready replicas — scale-to-zero
  or CrashLoopBackOff) → `Stopped`; `ready=true` → `Running`. A probe ERROR (the env's `Health` threw —
  transient kubectl error OR a deleted deployment) → leave `record.status` UNCHANGED (never flap a record to
  Stopped on a transient failure).
- **Running/Stopped only — no Failed** (uniform with Docker; `Failed` stays the create-rollback terminal state
  and is never reconciled). The live `HiveHealthDto.detail` still carries crash reasons for the portal detail
  view.
- `EnvironmentService.ListReconciled` is UNCHANGED (no synchronous in-cluster probe) — it keeps returning the
  stored status, which the monitor now keeps fresh.

## Decisions (mine, as the builder — AFK)

- **Monitor-push over list-time probe** — rationale above (no list-latency/hang hazard; the monitor already
  has the bounded-timeout loop and the per-env ready signal; it runs where the records live).
- **Write only on change; never flap on error** — `SetStatus` only when the derived status differs from the
  stored one (avoids needless `Put` + a spurious `Changed`/`HealthChanged` storm every tick); a per-env
  `Health` throw leaves that record's status untouched.
- **Per-env fault tolerance in `Produce`** — one unreachable env must not blank the hive's health nor abort the
  status reconcile of its siblings. (Side benefit: the health route stops failing wholesale on one bad env.)
- **Deleted-deployment edge accepted, documented.** Because a deleted (not merely scaled-to-zero) deployment
  makes `Health` throw (NotFound), such a record stays at its last status until the env is deleted or the
  deployment returns. This is an abnormal out-of-band action (deleting a Deployment without deleting the env);
  handling it distinctly (NotFound→Stopped) would need `kubectl get --ignore-not-found` plumbing and is a
  filed follow-up, not this task. Scale-to-zero and CrashLoop — the realistic cases — reconcile correctly.
- **Degrades cleanly when the monitor is disabled.** If `TenantHealthMonitor` is not wired (e.g. probe
  interval 0), status falls back to explicit-transition-only — exactly today's behavior. No regression.
- **No change to `EnvironmentRegistry`** (keeps its Docker-only `IContainerProbe` boundary), the Docker
  reconcile path, `ListReconciled`, or the portal detail view's live overlay.

## Non-goals / anti-goals

- No synchronous cluster probe on any list endpoint (the rejected hazard).
- No distinct "unhealthy/crashed" env state (would be a new concept Docker lacks; detail view shows reasons).
- No NotFound→Stopped special-casing for a deleted deployment (filed follow-up).
- No hive-agent status reporter; no change to `EnvironmentRegistry` deps or the Docker probe.
- No new periodic timer — reuse the monitor's existing loop.

## Component shape (for the plan)

- `admin/control-plane/hive-health-producer.ts` — `Produce` wraps each env's `orchestrator.Health` in a
  per-env guard; on failure, the env's entry is marked unknown/omitted (decide one and keep the DTO shape
  stable for existing consumers) rather than throwing the whole hive. Add a `healthy`/`error` discriminator
  only if needed to let the monitor tell "clean not-ready" from "probe errored"; otherwise expose the per-env
  outcome the monitor needs.
- `admin/control-plane/tenant-health-monitor.ts` — gains the status-writer dep; in the per-hive tick, after
  producing, reconciles each env's `record.status` from its CLEAN ready (Running/Stopped), writing only on
  change, skipping envs whose probe errored.
- `admin/control-plane/server.ts` + `admin/control-plane/tenant-admin-server.ts` — pass the status-writer
  (the existing `service`) into the `TenantHealthMonitor` constructor at both wiring sites.
- No change to `environment-service.ts` beyond (optionally) exposing the narrow `SetStatus` as the writer
  the monitor consumes; `ListReconciled` untouched.

## Verification

- **Unit (`tsx --test`, no cluster):**
  - `HiveHealthProducer.Produce`: with two hive envs where the FIRST env's `Health` throws, the SECOND env's
    health is still produced (per-env fault tolerance); the failing env is surfaced as unknown/omitted, not a
    thrown hive.
  - `TenantHealthMonitor` tick: an env whose clean `ready` is `false` while its record is `Running` →
    `SetStatus(Stopped)`; `ready` `true` while `Stopped` → `SetStatus(Running)`; an env already at the derived
    status → NO `SetStatus` call; an env whose probe errored → status unchanged AND siblings still reconciled;
    a `Failed` record is never flipped. Use a scriptable fake producer + a recording status-writer.
  - No synchronous probe added to `EnvironmentService.ListReconciled` (it still calls only
    `registry.Reconcile()` + `List()`).
- **Gated live smoke (operator-run, docker-desktop):** reuse the DclYs Stop/Start smoke with the monitor
  enabled — after an out-of-band `kubectl scale --replicas=0` (NO explicit Stop), within one monitor interval
  a subsequent env list reports the in-cluster env `Stopped`; after `scale --replicas=1`, `Running`.
- control-plane unit suite green; `tsc` tools+tenant-admin+build clean.

## Review focus (likely-to-bite, pin each in a task test)

1. **No list-time hang** — no endpoint gains a synchronous per-env `kubectl` probe; `ListReconciled` is
   unchanged. (Unit: ListReconciled still only reconciles Docker + lists. Review: grep the list routes.)
2. **Per-env fault tolerance** — one env's failed `Health` must not blank the hive or abort sibling status
   reconcile. (Unit: first-env-throws, second still produced + reconciled.)
3. **No flap on transient error** — a probe error leaves `record.status` unchanged, not Stopped. (Unit.)
4. **Write-only-on-change** — a record already at the derived status triggers no `SetStatus`/event (no tick
   storm). (Unit.)
5. **Failed stays terminal; Docker untouched** — a `Failed` record is never reconciled; unbound records keep
   their Docker-probe reconcile. (Unit.)
