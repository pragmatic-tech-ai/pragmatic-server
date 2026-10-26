# Dclbo In-cluster env status reconcile via the health monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-cluster environment's `record.status` tracks its real workload state (Running/Stopped) out-of-band, reconciled by the already-running background `TenantHealthMonitor`, with zero latency added to any list endpoint.

**Architecture:** Three small, independent changes. (1) `HiveHealthProducer.Produce` becomes per-env fault-tolerant — a single env whose `orchestrator.Health` throws is omitted, not allowed to blank the whole hive. (2) `EnvironmentService` gains a public `ReconcileStatus(name, ready)` that maps `ready`→Running/Stopped and writes through the existing private `SetStatus` ONLY when the stored status differs, never touching a `Failed` record and no-oping on an absent one. (3) `TenantHealthMonitor` gains an optional narrow `IEnvStatusReconciler` collaborator; in its existing per-hive probe pass it reconciles each successfully-probed env's status. Both wiring sites pass the `EnvironmentService` as the reconciler. `ListReconciled` and the Docker path are untouched.

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`. Single repo: pragmatic-server. No cluster needed for the unit work; the gated live smoke is operator-run on docker-desktop.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-dclbo-in-cluster-status-reconcile-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state. Allman braces. No inline string literals (hoist to `private static readonly` PascalCase). PascalCase interfaces + public methods.
- Secret-safety (verbatim): credentials/keys/tokens/secrets/inner-error-text held server-side by name only — NEVER in logs, DTOs, errors, thrown messages, or persisted records. A caught `orchestrator.Health` error must NOT have its message copied into any DTO, log line, or event payload.
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root. LF-only. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Status reconcile writes Running/Stopped ONLY — never Failed (terminal, create-rollback only) and never Unknown. The `TenantHealthMonitor` never imports `EnvStatus`: the reconciler takes a `ready: boolean` and the service derives the status.
- No synchronous cluster probe added to any list endpoint. `EnvironmentService.ListReconciled` stays exactly `registry.Reconcile()` + `registry.List()`. `EnvironmentRegistry` and the Docker reconcile path are untouched.
- No worktree; branch `feat/sp-hive-dclbo-status-reconcile` off master.

## Review Focus

1. **No list-time hang (RF1)** — no list endpoint gains a synchronous per-env `kubectl` probe; `ListReconciled` body is unchanged. (Pinned by the existing `environment-service` ListReconciled test staying green + a grep in the final review; no new probe call in the diff.)
2. **Per-env fault tolerance (RF2)** — one env's thrown `Health` must not blank the hive nor abort sibling reconcile. (Task 1 test: first env throws, second still produced.)
3. **No flap on transient error (RF3)** — an omitted (errored) env is never reconciled, so a transient `Health` throw leaves `record.status` unchanged. (Task 1 omits it; Task 3 test: an errored/omitted env triggers no reconciler call.)
4. **Write-only-on-change (RF4)** — a record already at the derived status triggers no `Put`/`Changed` event (no per-tick storm). (Task 2 test: already-target → no write, no notify.)
5. **Failed stays terminal (RF5)** — a `Failed` record is never flipped to Running/Stopped by reconcile; unbound Docker records keep their registry reconcile. (Task 2 test: Failed record + ready → no write.)

---

## Task 1: `HiveHealthProducer.Produce` per-env fault tolerance

**Files:**
- Modify: `admin/control-plane/hive-health-producer.ts` (`Produce` wraps each env's `orchestrator.Health` in a per-env guard; on throw, omit that env and continue)
- Test: `admin/control-plane/tests/hive-health-producer.test.ts` (create)

**Interfaces:**
- Consumes: `IHiveOrchestrator.Health(workload): Promise<WorkloadHealth>`, `IEnvironmentHealthSource.List()`, `EnvironmentPlacement.WorkloadFor(env)` (all unchanged).
- Produces: `Produce(hive): Promise<HiveHealthDto[]>` — same shape; the returned list now contains only successfully-probed envs (DTO shape unchanged; an env whose `Health` throws is simply absent from the list). `this.orchestrators.For(hive)` staying outside the guard: a failure to resolve the orchestrator still rejects the whole hive (not a per-env condition).

- [ ] **Step 1: Write failing tests.** With a fake orchestrator whose `Health` throws for the FIRST matching env and resolves for the SECOND: `Produce(hive)` resolves (does not reject), and the returned list contains exactly the second env's DTO (first omitted). A second test: when `orchestrators.For` itself throws, `Produce` rejects (hive-level failure preserved). Assert no caught error text appears in any returned DTO field.
- [ ] **Step 2: Run tests — expect fail** (`npx tsx --test admin/control-plane/tests/hive-health-producer.test.ts`).
- [ ] **Step 3: Implement** — in the `for` loop, wrap the `await orchestrator.Health(...)` + `dtos.push(...)` in `try { … } catch { continue }`. No logging of the caught error (no secret leak). `orchestrators.For(hive)` stays above the loop, unguarded.
- [ ] **Step 4: Run tests — expect pass.** Then `tsc` (tools, tenant-admin).
- [ ] **Step 5: Commit** (branch `feat/sp-hive-dclbo-status-reconcile` off master).

## Task 2: `EnvironmentService.ReconcileStatus(name, ready)`

**Files:**
- Modify: `admin/control-plane/environment-service.ts` (new public `ReconcileStatus`; reuses the existing private `SetStatus`)
- Test: `admin/control-plane/tests/environment-service.test.ts` (extend)

**Interfaces:**
- Consumes: the existing private `SetStatus(rec, status)`, `this.registry.Get(name)`, `EnvStatus`.
- Produces: `public async ReconcileStatus(name: string, ready: boolean): Promise<void>` — derives `target = ready ? EnvStatus.Running : EnvStatus.Stopped`; `const rec = this.registry.Get(name)`; returns (no-op) if `rec === undefined` (env deleted mid-tick), if `rec.status === EnvStatus.Failed` (terminal, never reconciled), or if `rec.status === target` (idempotent — no `Put`, no `Changed` event); otherwise `await this.SetStatus(rec, target)`. This is the structural shape `IEnvStatusReconciler` (declared in Task 3) matches.

- [ ] **Step 1: Write failing tests.** Using the existing `environment-service.test.ts` harness (fake registry recording `Put` + a `Changed`-event counter): (a) a `Running` record + `ReconcileStatus(name, false)` → one `Put` with `Stopped` and one `Changed` event; (b) a `Stopped` record + `ReconcileStatus(name, false)` → NO `Put`, NO event (RF4); (c) a `Failed` record + `ReconcileStatus(name, true)` → NO `Put` (RF5); (d) an absent name → resolves, NO `Put`; (e) a `Running` record + `ReconcileStatus(name, true)` → NO `Put` (idempotent true path); (f) an `Unknown` record + `ReconcileStatus(name, true)` → `Put` with `Running`.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** `ReconcileStatus` as specified; no new string literals needed (uses enum values).
- [ ] **Step 4: Run tests — expect pass.** Confirm the existing `ListReconciled` test is still green and its body still only calls `registry.Reconcile()` + `List()` (RF1).
- [ ] **Step 5: Commit.**

## Task 3: `TenantHealthMonitor` reconciles status + wire both sites

**Files:**
- Modify: `admin/control-plane/tenant-health-monitor.ts` (declare `IEnvStatusReconciler`; add optional ctor param `reconciler?`; reconcile each probed env in `Probe`)
- Modify: `admin/control-plane/server.ts:175`, `admin/control-plane/tenant-admin-server.ts:183` (pass `service` as the new last arg)
- Test: `admin/control-plane/tests/tenant-health-monitor.test.ts` (extend)

**Interfaces:**
- Consumes: `IEnvStatusReconciler.ReconcileStatus(environmentName, ready)` (satisfied structurally by `EnvironmentService.ReconcileStatus`, Task 2); the producer's now-clean DTO list (Task 1).
- Produces: `export interface IEnvStatusReconciler { ReconcileStatus(environmentName: string, ready: boolean): Promise<void> }` (declared here, mirroring the existing `IHiveLister` seam). `TenantHealthMonitor` ctor gains a trailing optional `private readonly reconciler?: IEnvStatusReconciler` AFTER `probeTimeoutMs` (so the 19 existing test constructions and their arg order are untouched). In `Probe`, for every DTO in the produced list, `await this.ReconcileSafely(dto.environmentName, dto.ready)` where `ReconcileSafely` calls `this.reconciler?.ReconcileStatus(...)` inside a `try { … } catch { }` (a reconcile throw, e.g. a `registry.Put` failure, must never abort the tick or the loop, and nothing secret is logged). When `reconciler` is undefined the monitor behaves exactly as today (status not reconciled) — the degrade-cleanly path.

- [ ] **Step 1: Write failing tests.** With the existing fake directory/producer plus a new **recording reconciler** (captures `(name, ready)` calls): (a) a hive with two envs, producer returns `ready:true` for env A and `ready:false` for env B → reconciler called `('A', true)` and `('B', false)`; (b) with NO reconciler passed (existing ctor arity) the monitor still runs and emits `HealthChanged` exactly as the existing tests expect (no regression — assert via an existing-style scenario); (c) a reconciler whose `ReconcileStatus` rejects does not stop the loop — a subsequent tick still reconciles the other envs / reschedules (reuse the generation/interval harness). Because Task 1 omits errored envs, an env absent from the producer's list yields no reconciler call (RF3) — assert with a producer returning only env A while the directory/List knows A and B.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the interface, the optional ctor param, and the `ReconcileSafely` call in `Probe`'s DTO loop; then update both wiring sites to append `service`. Keep `EnvStatus` out of the monitor.
- [ ] **Step 4: Run tests — expect pass.** Then the full control-plane unit suite + `tsc` (tools, tenant-admin, build). Grep the list routes/`ListReconciled` to confirm no synchronous probe was added (RF1).
- [ ] **Step 5: Promote the gated smoke** — extend the DclYs Stop/Start smoke (`admin/control-plane/in-cluster-env-create-smoke.ts`) with the monitor enabled: after an out-of-band `kubectl scale --replicas=0` (NO explicit Stop), within one monitor interval a subsequent env list reports the in-cluster env `Stopped`; after `scale --replicas=1`, `Running`. Mark operator-run (a subagent cannot reach the cluster).
- [ ] **Step 6: Commit.**

---

## Self-Review

- **Spec coverage:** per-env fault tolerance (Task 1), monitor-push status reconcile with write-only-on-change + Failed-terminal + ready-derivation (Task 2), monitor wiring + degrade-cleanly + smoke (Task 3). `ListReconciled`/Docker/`EnvironmentRegistry` untouched (Global Constraints + RF1). Deleted-deployment NotFound→Stopped is the filed follow-up, explicitly out of scope (a thrown `Health` is omitted by Task 1 → left unchanged by design).
- **Step scan:** each step writes one thing; test steps carry concrete `(name, ready)`/status assertions.
- **Type consistency:** `ReconcileStatus(name: string, ready: boolean): Promise<void>` identical across the service method (Task 2) and the `IEnvStatusReconciler` seam (Task 3); monitor ctor param is trailing-optional so existing arity holds.
- **Review Focus:** RF1 (Task 2 green + final grep), RF2 (Task 1), RF3 (Tasks 1+3), RF4/RF5 (Task 2) all pinned.
- **Proportion:** three small tasks; plan carries the decisions (optional-trailing dep, ready→status in the service, omit-on-throw) and assertions, no code bodies.
