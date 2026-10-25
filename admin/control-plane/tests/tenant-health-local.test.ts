import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TenantHealthMonitor } from '../tenant-health-monitor.js'
import { TenantEventBus, TenantEventType, type TenantEvent } from '../tenant-api/tenant-events.js'
import type { HiveHealthDto, HiveHealthProducer } from '../hive-health-producer.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

/** Scripted producer: returns the current DTO list for every hive. */
class ScriptedProducer
{
    public Dtos: HiveHealthDto[] = []

    public async Produce(_hive: HiveRecord): Promise<HiveHealthDto[]>
    {
        return this.Dtos
    }

    public AsProducer(): HiveHealthProducer
    {
        return this as unknown as HiveHealthProducer
    }
}

class OneHiveDirectory
{
    public ListHives(): readonly HiveRecord[]
    {
        return [{
            id: 'h1', tenantId: 't1', displayName: 'h1', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Provision }, createdAt: '2026-01-01T00:00:00Z'
        }]
    }
}

/** Replaces global fetch for the duration of a test and records every outbound call. */
class OutboundSpy
{
    public readonly Calls: string[] = []
    private original: typeof fetch | undefined = undefined

    public Install(): void
    {
        this.original = globalThis.fetch
        globalThis.fetch = (async (input: unknown) =>
        {
            this.Calls.push(String(input))
            return new Response('{}')
        }) as typeof fetch
    }

    public Restore(): void
    {
        if (this.original !== undefined)
        {
            globalThis.fetch = this.original
        }
    }
}

class SourceFiles
{
    private static readonly Here = dirname(fileURLToPath(import.meta.url))
    /** Files making up the tenant admin's local health path. */
    public static readonly HealthPath = ['../tenant-health-monitor.ts', '../hive-health-producer.ts']
    public static readonly Forbidden = [/rollout-client/i, /IRolloutClient/, /HttpRolloutClient/, /ReportSnapshot/, /agent-channel/i, /\/agent\/hives/]

    public static Read(relative: string): string
    {
        return readFileSync(join(SourceFiles.Here, relative), 'utf8')
    }
}

describe('tenant health stays local (rollout agent is the sole up-reporter)', () =>
{
    const spy = new OutboundSpy()

    beforeEach(() => spy.Install())
    afterEach(() => spy.Restore())

    it('monitor takes no rollout/channel collaborator and only emits to the TenantEventBus', async () =>
    {
        const producer = new ScriptedProducer()
        const bus = new TenantEventBus()
        const events: TenantEvent[] = []
        bus.On('t1', e => events.push(e))
        producer.Dtos = [{ environmentName: 'dev', ready: true, runningImage: 'i', detail: 'ok' }]
        const monitor = new TenantHealthMonitor(new OneHiveDirectory(), producer.AsProducer(), bus, 1000)
        const tick = (monitor as unknown as { Tick(): Promise<void> }).Tick.bind(monitor)

        await tick()
        producer.Dtos = [{ environmentName: 'dev', ready: false, runningImage: 'i', detail: 'down' }]
        await tick()

        assert.deepEqual(events, [{ type: TenantEventType.HealthChanged, environmentName: 'dev' }])
        // Constructor is (directory, producer, events, intervalMs, probeTimeoutMs): no slot for a rollout client.
        assert.ok(TenantHealthMonitor.length <= 4)
        assert.equal(spy.Calls.length, 0, 'a health tick must make no outbound call')
    })

    it('health path sources reference no rollout client, snapshot report or agent channel', () =>
    {
        for (const file of SourceFiles.HealthPath)
        {
            const source = SourceFiles.Read(file)
            for (const pattern of SourceFiles.Forbidden)
            {
                assert.ok(!pattern.test(source), `${file} must not match ${pattern}`)
            }
        }
    })
})
