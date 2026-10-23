# SP-HIVE-7 #8 — Tenant health-changed emitter (probe loop)

**Status:** design. Implements the remaining half of deferral issue #8.

## Problem

The tenant event bus already defines `TenantEventType.HealthChanged`, and the portal already reacts to any tenant event by refreshing the open detail pane (`TenantApp.OnTenantEvent` → `current.Refresh()` refetches health; the tree ignores it). But **nothing ever emits `HealthChanged`**: the bus only emits lifecycle events from `EnvironmentService.OnChanged`. So when a workload's health flips without a lifecycle/status change (e.g. a container goes unhealthy, a pod crash-loops), the portal does not learn of it until the next lifecycle event or a manual refresh.

The create/delete lifecycle half of #8 already shipped; this adds the health emitter.

## Decision

A **probe loop** (the issue's own suggested approach, and the general one — an agent-`Report` hook would only cover pull-agent hives, not docker). A periodic monitor runs the existing `HiveHealthProducer` per hive, diffs against the last snapshot, and emits `HealthChanged` on the tenant bus for each environment whose health changed, scoped to the hive's owning tenant.

No portal change: `HealthChanged` is already an accepted event type and the open pane already refetches on it.

## Design

### `TenantHealthMonitor` (new) — `admin/control-plane/tenant-health-monitor.ts`

```ts
export class TenantHealthMonitor
{
    public constructor(
        directory: PlatformDirectory,       // ListHives() → HiveRecord[] (each has id + optional tenantId)
        producer: HiveHealthProducer,       // Produce(hive) → HiveHealthDto[] (ready, detail, ...)
        events: TenantEventBus,
        intervalMs: number,
        now?: () => number)                 // reserved for tests; not required
    public Start(): void                    // schedules the first tick; no-op if already started
    public Stop(): void                     // stops the loop; safe to call repeatedly
}
```

Behaviour:
- **Self-rescheduling tick (no overlap):** uses a `setTimeout` chain, not `setInterval` — each tick runs the full probe, then schedules the next `intervalMs` after it COMPLETES. A slow probe can never pile up overlapping runs. `Stop` clears the pending timer and sets a stopped flag so an in-flight tick does not reschedule.
- **Per-hive error isolation:** a hive whose `producer.Produce` throws (orchestrator unreachable, etc.) is skipped for that tick — it neither aborts the loop nor the other hives, and nothing is logged that could carry a secret.
- **Audience scoping:** a hive with no `tenantId` (unbound) has no tenant audience and is skipped.
- **Diff:** the monitor keeps a snapshot `Map<hiveId, Map<envName, { ready, detail }>>`. For each env in a hive's current health list, if `ready` or `detail` differs from the snapshot (including first-ever observation where the snapshot has no entry — see below), emit `events.Emit(hive.tenantId, { type: HealthChanged, environmentName })` and update the snapshot. Envs that disappeared from a hive are pruned from the snapshot (lifecycle delete already emits its own event, so no HealthChanged is emitted for a removed env).
- **First observation:** the very first tick establishes the baseline snapshot and emits NOTHING (no spurious "changed" on startup); only subsequent differences emit. (Equivalently: seed the snapshot on the first tick per hive without emitting.)

### Configuration

- `PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS` — the probe interval. Default **30000** (30s). A value of `0` (or a non-positive/invalid value) **disables** the monitor (it is never started). Parsed by a pure `ControlPlaneServer.ParseHealthProbeMs(raw): number` (returns 30000 for undefined/empty/invalid; the integer ms for a valid positive integer; 0 for `'0'`).

### Wiring

`TenantHealthMonitor` is composed in `server.ts` `Main()` (which has `directory`, `orchestrators`, `placement`, `service`) using a `HiveHealthProducer(service, orchestrators, placement)`, and injected into `TenantPlaneHost` as an optional dependency. `TenantPlaneHost.Listen` calls `monitor.Start()` (when present and interval > 0); `TenantPlaneHost.Close` calls `monitor.Stop()`. The monitor only exists when the tenant plane is active (fail-closed with it). When the interval is 0, no monitor is constructed/started.

## Security invariants

`HealthChanged` carries only `{ type, environmentName }` — no secret, no detail text, no cross-tenant data; it is scoped to the hive's own tenant via `events.Emit(tenantId, …)`. Probe failures are swallowed without logging record/secret material. The operator plane is untouched.

## Non-goals

An event-driven (agent-Report) health signal; per-env configurable intervals; health history/metrics; emitting the health detail text in the event (the portal refetches the full health DTO itself); back-pressure beyond the no-overlap guard.

## Review Focus

- **Change emits, steady state is quiet:** a hive whose env flips `ready true→false` emits exactly one `HealthChanged` for that env to that tenant; a tick with no change emits nothing; the first tick emits nothing (baseline).
- **No overlap / clean teardown:** a probe slower than the interval does not overlap; `Stop()` halts the loop and an in-flight tick does not reschedule; no leaked timer after `Close`.
- **Per-hive error isolation:** one hive’s `Produce` throwing does not stop the loop or suppress other hives’ emits, and logs no secret.
- **Audience scoping:** an unbound hive (no tenantId) emits nothing; an emit goes only to the owning tenant.
- **Disabled by config:** `PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS=0` → monitor never starts; `ParseHealthProbeMs` defaults/validates correctly.
- **Removed env:** an env that disappears from a hive’s health list is pruned and does not emit `HealthChanged`.
