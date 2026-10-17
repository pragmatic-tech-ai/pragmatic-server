import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { trace, metrics } from '@opentelemetry/api'
import { WebSocket } from 'ws'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { StructuredLogger } from '../../observability/logger.js'
import { DrainController } from '../../observability/drain-controller.js'
import type { Observability } from '../../observability/observability.js'
import type { IInFlightSource } from '../../observability/drain-controller.js'

class DrainFixture
{
    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]]))
    }

    public static async Start(baseDir: string, drainTimeoutMs: number, lines?: string[], observability?: Observability): Promise<PragmaticServerHost>
    {
        const keyPath = join(baseDir, 'key')
        writeFileSync(keyPath, randomBytes(32))
        const logger = lines === undefined ? undefined : StructuredLogger.ToSink(line => lines.push(line))
        return PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { keyFilePath: keyPath }, provisioning: DrainFixture.Provisioning(), drainTimeoutMs, logger, observability })
    }

    public static Get(port: number, path: string): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.on('error', reject)
            req.end()
        })
    }
}

class FakeObservability
{
    public readonly Events: string[]

    public constructor(events: string[])
    {
        this.Events = events
    }

    public Tracer()
    {
        return trace.getTracer('drain-test')
    }

    public Meter()
    {
        return metrics.getMeter('drain-test')
    }

    public Shutdown(): Promise<void>
    {
        this.Events.push('shutdown')
        return Promise.resolve()
    }

    public AsObservability(): Observability
    {
        return this as unknown as Observability
    }
}

class FakeClock
{
    private current = 0

    public Controller(timeoutMs: number): DrainController
    {
        return new DrainController(timeoutMs, () => this.current, ms => { this.current += ms; return Promise.resolve() }, 25)
    }
}

class WsFixture
{
    public static async Connect(host: PragmaticServerHost, tenantId: string): Promise<WebSocket>
    {
        const pack = await host.IdentityPackForTest(tenantId)
        await pack.Grants.Save(new Grant(tenantId, Role.Admin, new ResourceRef(ResourceKind.Tenant, tenantId, [])))
        const tenant = await host.TenantForTest(tenantId)
        const token = (await pack.Tokens.Issue(tenant, tenantId, [], null)).Token
        const address = host.Address()
        const ws = new WebSocket(`ws://${address.host}:${address.port}/?tenant=${tenantId}`, { headers: { authorization: `Bearer ${token}` } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once('open', () => resolve())
            ws.once('error', reject)
        })
        return ws
    }
}

class HeldSource implements IInFlightSource
{
    private count: number

    public constructor(count: number)
    {
        this.count = count
    }

    public Release(): void
    {
        this.count = 0
    }

    public InFlight(): number
    {
        return this.count
    }
}

test('/readyz returns 503 while an in-flight request is still open and before the http server closes (Review Focus 1)', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const host = await DrainFixture.Start(baseDir, 3000)
    const held = new HeldSource(1)
    host.SetDrainSourceForTest(held)
    const port = host.Address().port
    try
    {
        assert.equal(await DrainFixture.Get(port, '/readyz'), 200)
        const disposing = host.DisposeAsync()
        await new Promise<void>(resolve => setTimeout(resolve, 50))
        assert.equal(await DrainFixture.Get(port, '/readyz'), 503)
        assert.equal(await DrainFixture.Get(port, '/healthz'), 200)
        held.Release()
        await disposing
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('a tracked in-flight request completes before the server closes; drain logs carry counts not identifiers', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const lines: string[] = []
    const host = await DrainFixture.Start(baseDir, 3000, lines)
    const held = new HeldSource(2)
    host.SetDrainSourceForTest(held)
    try
    {
        const disposing = host.DisposeAsync()
        await new Promise<void>(resolve => setTimeout(resolve, 50))
        held.Release()
        await disposing
        const drainLines = lines.filter(line => line.includes('drain'))
        assert.ok(drainLines.some(line => line.includes('inFlight') || line.includes('remaining')))
        assert.ok(drainLines.every(line => !line.includes('t1')))
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('a connection still in-flight past the window is terminated, not awaited forever (Review Focus 2)', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const host = await DrainFixture.Start(baseDir, 60)
    host.SetDrainSourceForTest({ InFlight: () => 1 })
    host.SetDrainControllerForTest(new FakeClock().Controller(60))
    try
    {
        const started = Date.now()
        await host.DisposeAsync()
        assert.ok(Date.now() - started < 1000)
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('DisposeAsync is idempotent under a double call and still tears down (Review Focus 3)', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const host = await DrainFixture.Start(baseDir, 0)
    try
    {
        await host.DisposeAsync()
        await host.DisposeAsync()
        assert.equal(host.HandlerCountForTest(), 0)
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('happy path: observability is flushed, and only AFTER the in-flight request completes', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const events: string[] = []
    const fake = new FakeObservability(events)
    const host = await DrainFixture.Start(baseDir, 3000, undefined, fake.AsObservability())
    const held = new HeldSource(1)
    host.SetDrainSourceForTest(held)
    try
    {
        const disposing = host.DisposeAsync()
        await new Promise<void>(resolve => setTimeout(resolve, 80))
        assert.deepEqual(events, [])
        events.push('release')
        held.Release()
        await disposing
        assert.deepEqual(events, ['release', 'shutdown'])
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('concurrent DisposeAsync calls both resolve only after full teardown', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const events: string[] = []
    const host = await DrainFixture.Start(baseDir, 3000, undefined, new FakeObservability(events).AsObservability())
    const held = new HeldSource(1)
    host.SetDrainSourceForTest(held)
    try
    {
        const first = host.DisposeAsync().then(() => events.push('first'))
        const second = host.DisposeAsync().then(() => events.push('second'))
        await new Promise<void>(resolve => setTimeout(resolve, 60))
        assert.deepEqual(events, [])
        held.Release()
        await Promise.all([first, second])
        assert.equal(events[0], 'shutdown')
        assert.deepEqual(events.slice(1).sort(), ['first', 'second'])
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('on timeout a live ws client is terminated and the log shows drained=false with positive remaining', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    mkdirSync(join(baseDir, 't1'), { recursive: true })
    cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), join(baseDir, 't1', 'solution'), { recursive: true })
    const lines: string[] = []
    const keyEnv = 'PS_DRAIN_KEY'
    process.env[keyEnv] = randomBytes(32).toString('base64')
    const logger = StructuredLogger.ToSink(line => lines.push(line))
    const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: DrainFixture.Provisioning(), drainTimeoutMs: 100, logger })
    host.SetDrainSourceForTest({ InFlight: () => 1 })
    host.SetDrainControllerForTest(new FakeClock().Controller(100))
    try
    {
        const ws = await WsFixture.Connect(host, 't1')
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
        await host.DisposeAsync()
        await closed
        const complete = lines.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry['event'] === 'drain-complete')
        assert.ok(complete !== undefined)
        assert.equal(complete['drained'], false)
        assert.ok(Number(complete['remaining']) > 0)
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[keyEnv]
    }
})

test('a draining host answers new requests with 503', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const host = await DrainFixture.Start(baseDir, 3000)
    const held = new HeldSource(1)
    host.SetDrainSourceForTest(held)
    const port = host.Address().port
    try
    {
        const disposing = host.DisposeAsync()
        await new Promise<void>(resolve => setTimeout(resolve, 50))
        assert.equal(await DrainFixture.Get(port, '/?tenant=t1'), 503)
        held.Release()
        await disposing
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('a throw in the readiness-close step does not prevent drain and the remaining teardown', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    const events: string[] = []
    const lines: string[] = []
    const host = await DrainFixture.Start(baseDir, 100, lines, new FakeObservability(events).AsObservability())
    host.SetDrainControllerForTest(new FakeClock().Controller(100))
    const internals = host as unknown as { httpServer: { closeIdleConnections: () => void } }
    const original = internals.httpServer.closeIdleConnections.bind(internals.httpServer)
    let calls = 0
    internals.httpServer.closeIdleConnections = () =>
    {
        calls += 1
        if (calls === 1)
        {
            throw new Error('boom')
        }
        original()
    }
    try
    {
        await host.DisposeAsync()
        assert.deepEqual(events, ['shutdown'])
        assert.ok(lines.some(line => line.includes('drain-failed') && line.includes('readiness-close')))
        assert.ok(lines.some(line => line.includes('drain-complete')))
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
    }
})

test('the heartbeat monitor watches a live ws client and is emptied on dispose', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-drain-'))
    mkdirSync(join(baseDir, 't1'), { recursive: true })
    cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), join(baseDir, 't1', 'solution'), { recursive: true })
    const host = await DrainFixture.Start(baseDir, 100)
    try
    {
        const ws = await WsFixture.Connect(host, 't1')
        assert.equal(host.HeartbeatCountForTest(), 1)
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
        await host.DisposeAsync()
        await closed
        assert.equal(host.HeartbeatCountForTest(), 0)
    }
    finally
    {
        await host.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
    }
})
