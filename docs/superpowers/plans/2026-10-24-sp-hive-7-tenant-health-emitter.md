# Tenant health-changed emitter (probe loop) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Emit `HealthChanged` on the tenant bus when a workload's health flips without a lifecycle change, via a periodic probe loop — so the portal reflects live health transitions.

**Architecture:** A new `TenantHealthMonitor` runs `HiveHealthProducer` per hive on a self-rescheduling timer, diffs against a per-env snapshot, and emits `HealthChanged` scoped to the hive's tenant. Composed in `server.ts`, owned (Start/Stop) by `TenantPlaneHost`. No portal change (`HealthChanged` is already accepted and the open pane already refetches on any event).

**Tech Stack:** TypeScript (tsx, node:test), existing `HiveHealthProducer`/`TenantEventBus`/`PlatformDirectory`.

**Spec:** `docs/superpowers/specs/2026-10-24-sp-hive-7-tenant-health-emitter-design.md` — read it with this plan.

## Global Constraints

- OOP (methods on classes, no free functions/module state), Allman braces, NO inline string literals (hoist to `private static readonly`), PascalCase interfaces/public methods.
- SECURITY: `HealthChanged` carries only `{ type, environmentName }`; emits scoped to the hive's own tenant; probe failures swallowed without logging secret/record material. Operator plane untouched.
- Tests under `tests/`; run `npx tsx --test "admin/control-plane/tests/*.test.ts"`. Do NOT `npm install` at the repo root.

## Review Focus

- Change emits one event; steady state and the first (baseline) tick emit nothing. — Task 1.
- No overlapping ticks; `Stop()` halts the loop and an in-flight tick does not reschedule; no leaked timer. — Task 1.
- Per-hive `Produce` error isolation (one bad hive doesn't stop the loop or other emits; no secret logged). — Task 1.
- Unbound hive (no tenantId) emits nothing; emit goes only to the owning tenant. — Task 1.
- Config: `PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS=0` disables; `ParseHealthProbeMs` defaults/validates. — Task 2.
- Removed env pruned, emits no `HealthChanged`. — Task 1.

---

### Task 1: `TenantHealthMonitor`

**Files:** Create `admin/control-plane/tenant-health-monitor.ts`; Test `admin/control-plane/tests/tenant-health-monitor.test.ts`.

**Interfaces — Produces:** `class TenantHealthMonitor` ctor `(directory: PlatformDirectory, producer: HiveHealthProducer, events: TenantEventBus, intervalMs: number)`; `Start(): void`; `Stop(): void`. Consumes `directory.ListHives()`, `producer.Produce(hive)`, `events.Emit(tenantId, event)`.

Make the loop testable without real timers: drive ticks deterministically. Expose a `private async Tick(): Promise<void>` and have the tests either call a test-only tick entry or inject fakes and advance via awaiting; prefer a design where the tick logic is a method the test can invoke directly (e.g. `Start` schedules `Tick` but the test calls `Tick` itself and asserts emissions), so no real `setTimeout` wait is needed. The no-overlap/reschedule behaviour is verified by a separate test that checks a second `Tick` is not entered while the first is in flight (a slow fake `Produce`), and that `Stop` prevents a reschedule.

- [ ] **Step 1: Failing tests** with a fake `PlatformDirectory` (`ListHives` returns controlled `HiveRecord`s with/without `tenantId`), a fake `HiveHealthProducer` (returns a scripted `HiveHealthDto[]` per hive, or throws for one hive), and a real `TenantEventBus` recording emits per tenant. Cover every Review-Focus bullet: first tick emits nothing (baseline); an env flipping `ready`/`detail` on a later tick emits exactly one `HealthChanged` to the hive's tenant; a no-change tick emits nothing; a hive whose `Produce` throws is skipped without aborting other hives' emits; an unbound hive emits nothing; a removed env is pruned and emits nothing; `Stop` during an in-flight (slow) `Produce` prevents a reschedule and the loop does not overlap.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement per spec: snapshot `Map<hiveId, Map<envName,{ready,detail}>>`; self-rescheduling `setTimeout` chain with a `running`/`stopped` guard; per-hive try/catch isolation; baseline-on-first-observation; prune removed envs; emit scoped to `hive.tenantId`. Hoist the event-type and any literals.
- [ ] **Step 4:** Run, pass; full control-plane suite green.
- [ ] **Step 5: Commit** (`feat(tenant): health-changed probe-loop monitor`).

### Task 2: Config parse + wiring

**Files:** Modify `admin/control-plane/tenant-plane-host.ts` (optional monitor dep + Start/Stop), `admin/control-plane/server.ts` (ParseHealthProbeMs + compose + inject); Test `admin/control-plane/tests/tenant-plane-compose.test.ts` (extend) and/or a small parse test.

**Interfaces — Consumes:** `TenantHealthMonitor` (Task 1), `HiveHealthProducer`, the existing compose wiring.

- [ ] **Step 1: Failing test** for `ControlPlaneServer.ParseHealthProbeMs(raw)`: `30000` for undefined/empty/`'-5'`/`'abc'`/`'1.5'`; `0` for `'0'`; the integer for `'5000'`. Env var name + default as `private static readonly`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Add an optional `monitor?: TenantHealthMonitor` param to `TenantPlaneHost`; `Listen` calls `monitor?.Start()`, `Close` calls `monitor?.Stop()`. In `server.ts` `Main()`, when the tenant plane is active AND `ParseHealthProbeMs(env[...]) > 0`, build `new HiveHealthProducer(service, orchestrators, placement)` and `new TenantHealthMonitor(directory, producer, tenantPlane.events, intervalMs)` and pass it to the `TenantPlaneHost`. Keep the port-before-bind ordering intact.
- [ ] **Step 4:** `npm run typecheck:tools` clean; full control-plane suite green; parse test passes.
- [ ] **Step 5: Commit** (`feat(tenant): start the health probe monitor from the control plane`).

---

## Notes for the executor

- Order 1 → 2. Task 1 holds the subtle logic (timer/diff/isolation) and gets a careful review; Task 2 is wiring.
- No portal change: `HealthChanged` is already an accepted event type and `TenantApp` already refreshes the open pane on any event.
- After Task 2, whole-branch review, then the finish menu (merge locally per the standing preference; never push without explicit instruction).
