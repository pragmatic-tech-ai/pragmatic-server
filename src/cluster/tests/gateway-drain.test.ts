import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trace, metrics } from '@opentelemetry/api'
import { WebSocket } from 'ws'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { Gateway } from '../gateway.js'
import { WorkerHost } from '../worker-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import type { IWorkerRouter, WorkerEndpoint } from '../worker-router.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { StructuredLogger } from '../../observability/logger.js'
import { DrainController } from '../../observability/drain-controller.js'
import type { Observability } from '../../observability/observability.js'
import type { IInFlightSource } from '../../observability/drain-controller.js'

class StubRouter implements IWorkerRouter
{
    private readonly endpoint: WorkerEndpoint

    public constructor(endpoint: WorkerEndpoint = { host: '127.0.0.1', port: 1 })
    {
        this.endpoint = endpoint
    }

    public RouteOrSpawn(): Promise<WorkerEndpoint>
    {
        return Promise.resolve(this.endpoint)
    }

    public Drain(): Promise<void>
    {
        return Promise.resolve()
    }
}

class GwFixture
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')
    public static readonly KeyEnv = 'PS_GWD_KEY'

    public static Tls(): MachineTlsRef
    {
        return { certFile: join(GwFixture.Dir, 'server.pem'), keyFile: join(GwFixture.Dir, 'server.key'), caFile: join(GwFixture.Dir, 'ca.pem') }
    }

    public static ClientTls(): MachineTlsRef
    {
        return { certFile: join(GwFixture.Dir, 'client.pem'), keyFile: join(GwFixture.Dir, 'client.key'), caFile: join(GwFixture.Dir, 'ca.pem') }
    }

    public static Events(lines: string[]): Record<string, unknown>[]
    {
        return lines.map(line => JSON.parse(line) as Record<string, unknown>)
    }

    public static Pause(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }

    public static Get(port: number, path: string): Promise<number>
    {
        return new Promise((resolve, reject) =>
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

    public static Status(ws: WebSocket): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            ws.once('unexpected-response', (_req, res) =>
            {
                resolve(res.statusCode ?? 0)
                ws.terminate()
            })
            ws.once('open', () =>
            {
                resolve(101)
                ws.terminate()
            })
            ws.once('error', reject)
        })
    }
}

class BackingWorker
{
    public readonly BaseDir: string
    public readonly Worker: WorkerHost

    private constructor(baseDir: string, worker: WorkerHost)
    {
        this.BaseDir = baseDir
        this.Worker = worker
    }

    public static async Start(): Promise<BackingWorker>
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-gwd-'))
        mkdirSync(join(baseDir, 't1'), { recursive: true })
        cpSync(join(GwFixture.Tls().certFile, '..', '..', 'sample-solution'), join(baseDir, 't1', 'solution'), { recursive: true })
        process.env[GwFixture.KeyEnv] = randomBytes(32).toString('base64')
        const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'T1' }]]))
        const worker = await WorkerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { base64Env: GwFixture.KeyEnv }, provisioning, tls: GwFixture.Tls() })
        return new BackingWorker(baseDir, worker)
    }

    public async Token(): Promise<string>
    {
        const server = await this.Worker.RegistryForTest().ServerFor('t1')
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant('t1', Role.Admin, new ResourceRef(ResourceKind.Tenant, 't1', [])))
        return (await pack.Tokens.Issue(server.Tenant(), 't1', [], null)).Token
    }

    public async Stop(): Promise<void>
    {
        await this.Worker.DisposeAsync()
        rmSync(this.BaseDir, { recursive: true, force: true })
        delete process.env[GwFixture.KeyEnv]
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

class Pending
{
    public static async IsPending(promise: Promise<void>, windowMs: number): Promise<boolean>
    {
        const marker = Symbol('pending')
        const winner = await Promise.race([promise.then(() => 'done' as const), new Promise<symbol>(resolve => setTimeout(() => resolve(marker), windowMs))])
        return winner === marker
    }
}

test('gateway /readyz flips to 503 before close while a connection is held, and the drain is bounded (Review Focus 1, 2)', async () =>
{
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls(), drainTimeoutMs: 800 })
    gateway.SetDrainSourceForTest(new HeldSource(1))
    const port = gateway.Address().port
    assert.equal(await GwFixture.Get(port, '/readyz'), 200)
    const started = Date.now()
    const disposing = gateway.DisposeAsync()
    await GwFixture.Pause(30)
    assert.equal(await GwFixture.Get(port, '/readyz'), 503)
    await disposing
    assert.ok(Date.now() - started < 3000)
})

test('concurrent DisposeAsync calls both stay pending while held, then resolve together with teardown run once', async () =>
{
    const events: string[] = []
    const observability = new FakeObservability(events).AsObservability()
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls(), drainTimeoutMs: 3000, observability })
    const held = new HeldSource(1)
    gateway.SetDrainSourceForTest(held)
    gateway.SetDrainControllerForTest(new DrainController(3000))
    const first = gateway.DisposeAsync()
    const second = gateway.DisposeAsync()
    assert.equal(await Pending.IsPending(first, 80), true)
    assert.equal(await Pending.IsPending(second, 10), true)
    assert.deepEqual(events, [])
    held.Release()
    await Promise.all([first, second])
    assert.deepEqual(events, ['shutdown'])
})

test('on timeout a live bridged client is terminated and the log shows drained=false with positive remaining', async () =>
{
    const backing = await BackingWorker.Start()
    const lines: string[] = []
    const logger = StructuredLogger.ToSink(line => lines.push(line))
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(backing.Worker.Address()), tls: GwFixture.ClientTls(), serverName: '127.0.0.1', logger, drainTimeoutMs: 100 })
    try
    {
        const token = await backing.Token()
        const ws = new WebSocket(`ws://127.0.0.1:${gateway.Address().port}/?environment=t1`, { headers: { authorization: `Bearer ${token}` } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once('open', () => resolve())
            ws.once('error', reject)
        })
        assert.equal(gateway.ClientCountForTest(), 1)
        gateway.SetDrainControllerForTest(new FakeClock().Controller(100))
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
        await gateway.DisposeAsync()
        await closed
        const complete = GwFixture.Events(lines).find(entry => entry['event'] === 'drain-complete')
        assert.ok(complete !== undefined)
        assert.equal(complete['drained'], false)
        assert.ok(Number(complete['remaining']) > 0)
    }
    finally
    {
        await gateway.DisposeAsync()
        await backing.Stop()
    }
})

test('an upgrade arriving mid-drain is answered 503 and adds no client', async () =>
{
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls(), drainTimeoutMs: 3000 })
    const held = new HeldSource(1)
    gateway.SetDrainSourceForTest(held)
    const disposing = gateway.DisposeAsync()
    await GwFixture.Pause(40)
    const before = gateway.ClientCountForTest()
    assert.equal(await GwFixture.Status(new WebSocket(`ws://127.0.0.1:${gateway.Address().port}/?environment=t1`)), 503)
    assert.equal(gateway.ClientCountForTest(), before)
    held.Release()
    await disposing
})

test('a throw in the readiness-close step is logged by step name and later teardown still runs', async () =>
{
    const events: string[] = []
    const lines: string[] = []
    const logger = StructuredLogger.ToSink(line => lines.push(line))
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls(), logger, drainTimeoutMs: 100, observability: new FakeObservability(events).AsObservability() })
    gateway.SetDrainControllerForTest(new FakeClock().Controller(100))
    const internals = gateway as unknown as { httpServer: { closeIdleConnections: () => void } }
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
    await gateway.DisposeAsync()
    assert.deepEqual(events, ['shutdown'])
    const failed = GwFixture.Events(lines).find(entry => entry['event'] === 'drain-failed')
    assert.ok(failed !== undefined)
    assert.equal(failed['step'], 'readiness-close')
    assert.ok(!lines.some(line => line.includes('boom')))
    assert.ok(GwFixture.Events(lines).some(entry => entry['event'] === 'drain-complete'))
})

test('a throwing in-flight source degrades to zero: clean drain-begin and a bounded drain', async () =>
{
    const lines: string[] = []
    const logger = StructuredLogger.ToSink(line => lines.push(line))
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls(), logger, drainTimeoutMs: 100 })
    gateway.SetDrainSourceForTest({ InFlight: () => { throw new Error('boom') } })
    gateway.SetDrainControllerForTest(new FakeClock().Controller(100))
    await gateway.DisposeAsync()
    const entries = GwFixture.Events(lines)
    const begin = entries.find(entry => entry['event'] === 'drain-begin')
    assert.ok(begin !== undefined)
    assert.equal(begin['inFlight'], 0)
    assert.ok(!entries.some(entry => entry['event'] === 'drain-failed'))
    const complete = entries.find(entry => entry['event'] === 'drain-complete')
    assert.ok(complete !== undefined)
    assert.equal(complete['drained'], true)
})

test('the heartbeat monitor watches both the client leg and the worker leg and is emptied on dispose', async () =>
{
    const backing = await BackingWorker.Start()
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(backing.Worker.Address()), tls: GwFixture.ClientTls(), serverName: '127.0.0.1', drainTimeoutMs: 100 })
    try
    {
        const token = await backing.Token()
        const ws = new WebSocket(`ws://127.0.0.1:${gateway.Address().port}/?environment=t1`, { headers: { authorization: `Bearer ${token}` } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once('open', () => resolve())
            ws.once('error', reject)
        })
        assert.equal(gateway.HeartbeatCountForTest(), 2)
        gateway.SetDrainControllerForTest(new FakeClock().Controller(100))
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
        await gateway.DisposeAsync()
        await closed
        assert.equal(gateway.HeartbeatCountForTest(), 0)
    }
    finally
    {
        await gateway.DisposeAsync()
        await backing.Stop()
    }
})
