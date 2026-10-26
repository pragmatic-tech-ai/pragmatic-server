import { strict as assert } from 'node:assert'
import { afterEach, describe, it, mock } from 'node:test'
import { TenantHealthMonitor, type IEnvStatusReconciler } from '../tenant-health-monitor.js'
import { TenantEventBus, TenantEventType, type TenantEvent } from '../tenant-api/tenant-events.js'
import type { HiveHealthDto, HiveHealthProducer } from '../hive-health-producer.js'
import type { PlatformDirectory } from '../platform-directory.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

/** A `PlatformDirectory` stand-in whose `ListHives` returns a script the test swaps between ticks. */
class FakeDirectory
{
    public Hives: HiveRecord[] = []

    public ListHives(): readonly HiveRecord[]
    {
        return this.Hives
    }

    public AsDirectory(): PlatformDirectory
    {
        return this as unknown as PlatformDirectory
    }
}

/** A `HiveHealthProducer` stand-in: per-hive scripted DTO lists, or a thrower for a chosen hive. Counts calls. */
class FakeProducer
{
    private readonly scripts = new Map<string, HiveHealthDto[]>()
    private readonly throwers = new Set<string>()
    public readonly Calls: string[] = []

    public Script(hiveId: string, dtos: HiveHealthDto[]): void
    {
        this.scripts.set(hiveId, dtos)
    }

    public Throw(hiveId: string): void
    {
        this.throwers.add(hiveId)
    }

    public async Produce(hive: HiveRecord): Promise<HiveHealthDto[]>
    {
        this.Calls.push(hive.id)
        if (this.throwers.has(hive.id))
        {
            throw new Error(FakeProducer.OrchestratorUnreachable)
        }
        return this.scripts.get(hive.id) ?? []
    }

    public AsProducer(): HiveHealthProducer
    {
        return this as unknown as HiveHealthProducer
    }

    private static readonly OrchestratorUnreachable = 'orchestrator unreachable'
}

/** A manually-resolved `HiveHealthProducer` stand-in used to probe the no-overlap / clean-teardown behaviour. */
class DeferredProducer
{
    public readonly Calls: string[] = []
    private resolvers: Array<(dtos: HiveHealthDto[]) => void> = []

    public async Produce(hive: HiveRecord): Promise<HiveHealthDto[]>
    {
        this.Calls.push(hive.id)
        return new Promise<HiveHealthDto[]>(resolve => this.resolvers.push(resolve))
    }

    public ResolveAll(): void
    {
        const pending = this.resolvers
        this.resolvers = []
        for (const resolve of pending)
        {
            resolve([])
        }
    }

    public AsProducer(): HiveHealthProducer
    {
        return this as unknown as HiveHealthProducer
    }
}

/** A producer that never resolves for chosen hives (a wedged orchestrator) and returns scripted DTOs for the rest. */
class HangingProducer
{
    private readonly hung = new Set<string>()
    private readonly scripts = new Map<string, HiveHealthDto[]>()
    private readonly resolvers = new Map<string, (dtos: HiveHealthDto[]) => void>()
    public readonly Calls: string[] = []

    public Hang(hiveId: string): void
    {
        this.hung.add(hiveId)
    }

    public Unhang(hiveId: string): void
    {
        this.hung.delete(hiveId)
    }

    public Script(hiveId: string, dtos: HiveHealthDto[]): void
    {
        this.scripts.set(hiveId, dtos)
    }

    /** Settles a previously-hung probe's pending promise late, to prove a resolution after its timeout is harmless. */
    public Release(hiveId: string, dtos: HiveHealthDto[]): void
    {
        this.resolvers.get(hiveId)?.(dtos)
    }

    public Produce(hive: HiveRecord): Promise<HiveHealthDto[]>
    {
        this.Calls.push(hive.id)
        if (this.hung.has(hive.id))
        {
            return new Promise<HiveHealthDto[]>(resolve => this.resolvers.set(hive.id, resolve))
        }
        return Promise.resolve(this.scripts.get(hive.id) ?? [])
    }

    public AsProducer(): HiveHealthProducer
    {
        return this as unknown as HiveHealthProducer
    }
}

class Recorder
{
    public readonly Events = new Map<string, TenantEvent[]>()

    public Watch(bus: TenantEventBus, tenantId: string): void
    {
        this.Events.set(tenantId, [])
        bus.On(tenantId, e => this.Events.get(tenantId)!.push(e))
    }

    public For(tenantId: string): readonly TenantEvent[]
    {
        return this.Events.get(tenantId) ?? []
    }

    public Total(): number
    {
        let sum = 0
        for (const list of this.Events.values())
        {
            sum += list.length
        }
        return sum
    }
}

class Hives
{
    public static Bound(id: string, tenantId: string): HiveRecord
    {
        return {
            id, tenantId, displayName: id, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Provision }, createdAt: '2026-01-01T00:00:00Z'
        }
    }

    public static Unbound(id: string): HiveRecord
    {
        const bound: { tenantId?: string } & Omit<HiveRecord, 'tenantId'> = Hives.Bound(id, '')
        delete bound.tenantId
        return bound as unknown as HiveRecord
    }
}

class Health
{
    public static Dto(environmentName: string, ready: boolean, detail: string): HiveHealthDto
    {
        return { environmentName, ready, runningImage: 'img:' + environmentName, detail }
    }
}

/** Drives the private `Tick` directly so tests sequence states without waiting on real timers. */
class Driver
{
    public static Tick(monitor: TenantHealthMonitor): Promise<void>
    {
        return (monitor as unknown as { Tick(): Promise<void> }).Tick()
    }
}

/** Records every `(environmentName, ready)` the monitor reconciles; optionally rejects after recording. */
class RecordingReconciler implements IEnvStatusReconciler
{
    public readonly Calls: Array<{ name: string; ready: boolean }> = []

    public constructor(private readonly rejectFor?: string)
    {
    }

    public async ReconcileStatus(environmentName: string, ready: boolean): Promise<void>
    {
        this.Calls.push({ name: environmentName, ready })
        if (this.rejectFor === environmentName)
        {
            throw new Error(RecordingReconciler.PutFailed)
        }
    }

    private static readonly PutFailed = 'registry put failed'
}

const Interval = 1000

describe('TenantHealthMonitor', () =>
{
    afterEach(() =>
    {
        mock.timers.reset()
    })

    it('emits nothing on the first tick (baseline seed)', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)

        assert.equal(recorder.Total(), 0)
    })

    it('emits exactly one HealthChanged, to the owning tenant only, when an env flips ready true->false', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        recorder.Watch(bus, 't2')
        directory.Hives = [Hives.Bound('h1', 't1'), Hives.Bound('h2', 't2')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        producer.Script('h2', [Health.Dto('prod', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Script('h1', [Health.Dto('dev', false, 'crash-looping')])
        await Driver.Tick(monitor)

        assert.equal(recorder.For('t1').length, 1)
        assert.deepEqual(recorder.For('t1')[0], { type: TenantEventType.HealthChanged, environmentName: 'dev' })
        assert.equal(recorder.For('t2').length, 0)
    })

    it('emits a HealthChanged for a detail-only change', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Script('h1', [Health.Dto('dev', true, 'restarting (1)')])
        await Driver.Tick(monitor)

        assert.equal(recorder.For('t1').length, 1)
        assert.equal(recorder.For('t1')[0].environmentName, 'dev')
    })

    it('emits nothing on a tick with no change', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        await Driver.Tick(monitor)
        await Driver.Tick(monitor)

        assert.equal(recorder.Total(), 0)
    })

    it('newly appearing env in an already-seen hive emits a HealthChanged', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Script('h1', [Health.Dto('dev', true, 'ok'), Health.Dto('test', true, 'ok')])
        await Driver.Tick(monitor)

        assert.equal(recorder.For('t1').length, 1)
        assert.equal(recorder.For('t1')[0].environmentName, 'test')
    })

    it('isolates a hive whose Produce throws while a sibling still emits its change', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        recorder.Watch(bus, 't2')
        directory.Hives = [Hives.Bound('bad', 't1'), Hives.Bound('good', 't2')]
        producer.Script('good', [Health.Dto('prod', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Throw('bad')
        producer.Script('good', [Health.Dto('prod', false, 'down')])
        await Driver.Tick(monitor)

        assert.equal(recorder.For('t1').length, 0)
        assert.equal(recorder.For('t2').length, 1)
        assert.equal(recorder.For('t2')[0].environmentName, 'prod')
    })

    it('never emits for an unbound hive (no tenantId)', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        directory.Hives = [Hives.Unbound('orphan')]
        producer.Script('orphan', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Script('orphan', [Health.Dto('dev', false, 'down')])
        await Driver.Tick(monitor)

        assert.equal(recorder.Total(), 0)
        assert.equal(producer.Calls.filter(c => c === 'orphan').length, 0)
    })

    it('prunes a removed env and emits no HealthChanged for it', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok'), Health.Dto('test', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        await Driver.Tick(monitor)
        assert.equal(recorder.Total(), 0)

        // A later reappearance of the removed env is a fresh observation on an already-seen hive -> one emit.
        producer.Script('h1', [Health.Dto('dev', true, 'ok'), Health.Dto('test', false, 'down')])
        await Driver.Tick(monitor)
        assert.equal(recorder.For('t1').length, 1)
        assert.equal(recorder.For('t1')[0].environmentName, 'test')
    })

    it('prunes a removed hive so its snapshot cannot leak, and a reappearance reseeds silently', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        // The hive leaves the listing (deleted / unbound); its snapshot must be pruned, not retained forever.
        directory.Hives = []
        await Driver.Tick(monitor)

        // It reappears with a different health. A leaked snapshot would diff against the stale 'ready' and emit;
        // a correctly pruned snapshot treats this as a first observation and stays silent.
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', false, 'crash-looping')])
        await Driver.Tick(monitor)

        assert.equal(recorder.Total(), 0)
    })

    it('seeds a hive first seen on a later tick silently, then emits on its next change', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        recorder.Watch(bus, 't2')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        // A second hive joins the platform after the baseline tick: its first observation must emit nothing.
        directory.Hives = [Hives.Bound('h1', 't1'), Hives.Bound('h2', 't2')]
        producer.Script('h2', [Health.Dto('prod', true, 'ok')])
        await Driver.Tick(monitor)
        assert.equal(recorder.Total(), 0)

        producer.Script('h2', [Health.Dto('prod', false, 'down')])
        await Driver.Tick(monitor)
        assert.equal(recorder.For('t2').length, 1)
        assert.equal(recorder.For('t2')[0].environmentName, 'prod')
        assert.equal(recorder.For('t1').length, 0)
    })

    it('does not overlap: a second entry while a tick is in flight is a no-op', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new DeferredProducer()
        const bus = new TenantEventBus()
        directory.Hives = [Hives.Bound('h1', 't1')]
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        const first = Driver.Tick(monitor)
        const second = Driver.Tick(monitor)
        assert.equal(producer.Calls.length, 1)

        producer.ResolveAll()
        await first
        await second
        assert.equal(producer.Calls.length, 1)
    })

    it('Stop before an in-flight tick resolves prevents any reschedule', async () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        const directory = new FakeDirectory()
        const producer = new DeferredProducer()
        const bus = new TenantEventBus()
        directory.Hives = [Hives.Bound('h1', 't1')]
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        monitor.Start()
        monitor.Start() // already started -> no-op
        mock.timers.tick(Interval)
        assert.equal(producer.Calls.length, 1)

        monitor.Stop()
        producer.ResolveAll()
        await new Promise<void>(resolve => setImmediate(resolve))

        mock.timers.tick(Interval * 5)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(producer.Calls.length, 1)
    })

    it('a Stop then Start during an in-flight tick runs one chain, not two', async () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        const directory = new FakeDirectory()
        const producer = new DeferredProducer()
        const bus = new TenantEventBus()
        directory.Hives = [Hives.Bound('h1', 't1')]
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        monitor.Start()
        mock.timers.tick(Interval) // first probe is now in flight (deferred)
        assert.equal(producer.Calls.length, 1)

        // Restart while the first probe is still awaiting: the stale in-flight tick must not reschedule a second chain.
        monitor.Stop()
        monitor.Start()
        producer.ResolveAll()
        await new Promise<void>(resolve => setImmediate(resolve))

        // Exactly one live chain remains: each interval advances the probe count by one, never two.
        mock.timers.tick(Interval)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(producer.Calls.length, 2)
        producer.ResolveAll()
        await new Promise<void>(resolve => setImmediate(resolve))
        mock.timers.tick(Interval)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(producer.Calls.length, 3)
    })

    it('Stop before the first timer fires cancels the pending probe entirely', async () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('dev', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        monitor.Start()
        monitor.Stop()
        mock.timers.tick(Interval * 5)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(producer.Calls.length, 0)
    })

    it('times out a hung probe so the loop is not wedged and a sibling still emits', async () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        const directory = new FakeDirectory()
        const producer = new HangingProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        recorder.Watch(bus, 't2')
        directory.Hives = [Hives.Bound('bad', 't1'), Hives.Bound('good', 't2')]
        producer.Hang('bad')
        producer.Script('good', [Health.Dto('prod', true, 'ok')])
        const ProbeTimeout = 5000
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval, ProbeTimeout)

        // First tick: the hung hive must not hold the tick open — its probe times out and the good hive still runs (baseline).
        const first = Driver.Tick(monitor)
        await new Promise<void>(resolve => setImmediate(resolve))
        mock.timers.tick(ProbeTimeout)
        await first
        assert.equal(recorder.Total(), 0)

        // Second tick proves the loop was released (not wedged on the hung probe): the good env flips and emits.
        producer.Script('good', [Health.Dto('prod', false, 'down')])
        const second = Driver.Tick(monitor)
        await new Promise<void>(resolve => setImmediate(resolve))
        mock.timers.tick(ProbeTimeout)
        await second
        assert.equal(producer.Calls.filter(c => c === 'good').length, 2)
        assert.equal(recorder.For('t2').length, 1)
        assert.equal(recorder.For('t2')[0].environmentName, 'prod')
        assert.equal(recorder.For('t1').length, 0)
    })

    it('a hung probe that settles after its timeout neither emits nor seeds a baseline', async () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        const directory = new FakeDirectory()
        const producer = new HangingProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Hang('h1')
        const ProbeTimeout = 5000
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval, ProbeTimeout)

        const first = Driver.Tick(monitor)
        await new Promise<void>(resolve => setImmediate(resolve))
        mock.timers.tick(ProbeTimeout) // the probe times out and is skipped, so no snapshot is seeded for h1
        await first

        // The wedged producer returns LATE (ready=true); the already-rejected tick must discard it — no emit, no snapshot.
        producer.Release('h1', [Health.Dto('dev', true, 'ok')])
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(recorder.Total(), 0)

        // A fresh tick now makes the FIRST real observation (ready=false). If the late settle had wrongly seeded
        // (true,'ok') as the baseline, this would diff and emit; a correct skip means this is baseline -> silent.
        producer.Unhang('h1')
        producer.Script('h1', [Health.Dto('dev', false, 'down')])
        await Driver.Tick(monitor)
        assert.equal(recorder.Total(), 0)
    })

    it('with the timeout disabled (0) a slow probe is awaited to completion', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new DeferredProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval, 0)

        const tick = Driver.Tick(monitor)
        assert.equal(producer.Calls.length, 1)
        producer.ResolveAll()
        await tick
        assert.equal(recorder.Total(), 0)
    })

    it('Stop is safe to call repeatedly and before Start', () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), new TenantEventBus(), Interval)

        monitor.Stop()
        monitor.Stop()
        assert.ok(true)
    })

    it('reconciles every probed env with its ready flag', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const reconciler = new RecordingReconciler()
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('A', true, 'ok'), Health.Dto('B', false, 'scaled to 0')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), new TenantEventBus(), Interval, 60000, reconciler)

        await Driver.Tick(monitor)

        assert.deepEqual(reconciler.Calls, [{ name: 'A', ready: true }, { name: 'B', ready: false }])
    })

    it('without a reconciler still probes and emits HealthChanged', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('A', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval)

        await Driver.Tick(monitor)
        producer.Script('h1', [Health.Dto('A', false, 'down')])
        await Driver.Tick(monitor)

        assert.equal(recorder.For('t1').length, 1)
    })

    it('a rejecting reconciler does not abort the tick or later ticks', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const bus = new TenantEventBus()
        const recorder = new Recorder()
        recorder.Watch(bus, 't1')
        const reconciler = new RecordingReconciler('A')
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('A', true, 'ok'), Health.Dto('B', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), bus, Interval, 60000, reconciler)

        await Driver.Tick(monitor)
        producer.Script('h1', [Health.Dto('A', true, 'ok'), Health.Dto('B', false, 'down')])
        await Driver.Tick(monitor)

        assert.deepEqual(reconciler.Calls.map(c => c.name), ['A', 'B', 'A', 'B'])
        assert.equal(recorder.For('t1').length, 1)
    })

    it('does not reconcile an env the producer omitted (RF3)', async () =>
    {
        const directory = new FakeDirectory()
        const producer = new FakeProducer()
        const reconciler = new RecordingReconciler()
        directory.Hives = [Hives.Bound('h1', 't1')]
        producer.Script('h1', [Health.Dto('A', true, 'ok')])
        const monitor = new TenantHealthMonitor(directory.AsDirectory(), producer.AsProducer(), new TenantEventBus(), Interval, 60000, reconciler)

        await Driver.Tick(monitor)

        assert.deepEqual(reconciler.Calls, [{ name: 'A', ready: true }])
    })
})
