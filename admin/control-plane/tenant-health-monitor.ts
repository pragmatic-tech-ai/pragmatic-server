import type { PlatformDirectory } from './platform-directory.js'
import type { HiveHealthDto, HiveHealthProducer } from './hive-health-producer.js'
import type { HiveRecord } from './platform-records.js'
import { TenantEventType, type TenantEventBus } from './tenant-api/tenant-events.js'

/** One environment's last-observed health on a hive: only the fields the diff compares, never a secret. */
type HealthSnapshot = { ready: boolean; detail: string }

/**
 * Periodic probe loop that emits `TenantEventType.HealthChanged` when a hive's live workload health drifts.
 *
 * It runs the existing `HiveHealthProducer` per hive on a self-rescheduling `setTimeout` chain (never `setInterval`,
 * so a slow probe can never pile up), diffs each environment's `ready`/`detail` against the last snapshot, and emits
 * a tenant-scoped `HealthChanged` for every environment whose health changed. The first observation of a hive seeds
 * the baseline silently; unbound hives (no `tenantId`) have no audience and are skipped; a hive whose probe throws is
 * skipped for that tick without aborting the loop or logging anything that could carry a secret.
 *
 * Layering: the monitor only reads the directory/producer and raises `HealthChanged` upward through the event bus; it
 * carries no UX type and the event payload stays `{ type, environmentName }` — no detail text, no cross-tenant data.
 */
export class TenantHealthMonitor
{
    private readonly snapshots = new Map<string, Map<string, HealthSnapshot>>()
    private timer: ReturnType<typeof setTimeout> | undefined = undefined
    private started = false
    private stopped = true
    private running = false
    // Bumped on every Start/Stop so an in-flight tick scheduled by an earlier run cannot reschedule after a
    // Stop (or a Stop→Start restart): a tick reschedules only while its captured generation is still current.
    private generation = 0

    public constructor(
        private readonly directory: PlatformDirectory,
        private readonly producer: HiveHealthProducer,
        private readonly events: TenantEventBus,
        private readonly intervalMs: number)
    {
    }

    /** Schedules the probe loop; a no-op if the monitor is already running. */
    public Start(): void
    {
        if (this.started)
        {
            return
        }
        this.started = true
        this.stopped = false
        this.generation++
        this.Schedule(this.generation)
    }

    /** Stops the loop and clears any pending timer; safe to call repeatedly. An in-flight tick will not reschedule. */
    public Stop(): void
    {
        this.started = false
        this.stopped = true
        this.generation++
        if (this.timer !== undefined)
        {
            clearTimeout(this.timer)
            this.timer = undefined
        }
    }

    private Schedule(generation: number): void
    {
        this.timer = setTimeout(() => { void this.RunAndReschedule(generation) }, this.intervalMs)
    }

    private async RunAndReschedule(generation: number): Promise<void>
    {
        // A timer that fired after a Stop (its callback already queued when Stop ran) belongs to a past generation: drop it.
        if (generation !== this.generation)
        {
            return
        }
        this.timer = undefined
        await this.Tick()
        if (generation === this.generation && !this.stopped)
        {
            this.Schedule(generation)
        }
    }

    /** One probe pass: diffs every bound hive's current health against its snapshot and emits the changes. */
    private async Tick(): Promise<void>
    {
        if (this.running)
        {
            return
        }
        this.running = true
        try
        {
            const seen = new Set<string>()
            for (const hive of this.directory.ListHives())
            {
                // Guards a malformed persisted record: HiveRecord.tenantId is typed non-optional, but records are
                // JSON and not runtime-validated. An unbound hive has no tenant audience, so skip it (and an empty id).
                if (!hive.tenantId)
                {
                    continue
                }
                seen.add(hive.id)
                await this.Probe(hive)
            }
            // Prune snapshots for hives no longer listed (deleted or now unbound) so the map cannot grow unbounded.
            for (const id of [...this.snapshots.keys()])
            {
                if (!seen.has(id))
                {
                    this.snapshots.delete(id)
                }
            }
        }
        finally
        {
            this.running = false
        }
    }

    private async Probe(hive: HiveRecord): Promise<void>
    {
        let dtos: HiveHealthDto[]
        try
        {
            dtos = await this.producer.Produce(hive)
        }
        catch
        {
            return
        }
        const prior = this.snapshots.get(hive.id)
        const next = new Map<string, HealthSnapshot>()
        for (const dto of dtos)
        {
            const current: HealthSnapshot = { ready: dto.ready, detail: dto.detail }
            next.set(dto.environmentName, current)
            if (prior !== undefined && this.HasChanged(prior.get(dto.environmentName), current))
            {
                this.events.Emit(hive.tenantId, { type: TenantEventType.HealthChanged, environmentName: dto.environmentName })
            }
        }
        this.snapshots.set(hive.id, next)
    }

    private HasChanged(before: HealthSnapshot | undefined, after: HealthSnapshot): boolean
    {
        return before === undefined || before.ready !== after.ready || before.detail !== after.detail
    }
}
