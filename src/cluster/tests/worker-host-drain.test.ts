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
import { WorkerHost } from '../worker-host.js'
import { MachineTls } from '../machine-tls.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { StructuredLogger } from '../../observability/logger.js'
import { DrainController } from '../../observability/drain-controller.js'
import type { Observability } from '../../observability/observability.js'
import type { IInFlightSource } from '../../observability/drain-controller.js'

class Fixture
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')
    public static readonly KeyEnv = 'PS_WHD_KEY'

    public static Tls(): MachineTlsRef
    {
        return { certFile: join(Fixture.Dir, 'server.pem'), keyFile: join(Fixture.Dir, 'server.key'), caFile: join(Fixture.Dir, 'ca.pem') }
    }

    public static ClientTls(): MachineTlsRef
    {
        return { certFile: join(Fixture.Dir, 'client.pem'), keyFile: join(Fixture.Dir, 'client.key'), caFile: join(Fixture.Dir, 'ca.pem') }
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'T1' }]]))
    }

    public static NewBaseDir(): string
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-whd-'))
        mkdirSync(join(baseDir, 't1'), { recursive: true })
        cpSync(join(Fixture.Dir, '..', 'sample-solution'), join(baseDir, 't1', 'solution'), { recursive: true })
        process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
        return baseDir
    }

    public static Cleanup(baseDir: string): void
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixture.KeyEnv]
    }

    public static Start(baseDir: string, drainTimeoutMs: number, lines?: string[], observability?: Observability): Promise<WorkerHost>
    {
        const logger = lines === undefined ? undefined : StructuredLogger.ToSink(line => lines.push(line))
        return WorkerHost.StartAsync({ port: 0, baseDir, masterKey: { base64Env: Fixture.KeyEnv }, provisioning: Fixture.Provisioning(), tls: Fixture.Tls(), healthPort: 0, drainTimeoutMs, logger, observability })
    }

    public static Events(lines: string[]): Record<string, unknown>[]
    {
        return lines.map(line => JSON.parse(line) as Record<string, unknown>)
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

    public static async Token(worker: WorkerHost): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor('t1')
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant('t1', Role.Admin, new ResourceRef(ResourceKind.Tenant, 't1', [])))
        return (await pack.Tokens.Issue(server.Tenant(), 't1', [], null)).Token
    }

    public static Dial(worker: WorkerHost, token: string): WebSocket
    {
        const address = worker.Address()
        const client = MachineTls.Client(Fixture.ClientTls())
        return new WebSocket(`wss://${address.host}:${address.port}/`, { key: client.key, cert: client.cert, ca: client.ca, rejectUnauthorized: true, servername: '127.0.0.1', headers: { 'x-pragmatic-tenant': 't1', authorization: `Bearer ${token}` } })
    }

    public static async Connect(worker: WorkerHost): Promise<WebSocket>
    {
        const ws = Fixture.Dial(worker, await Fixture.Token(worker))
        await new Promise<void>((resolve, reject) =>
        {
            ws.once('open', () => resolve())
            ws.once('error', reject)
        })
        return ws
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

    public static Pause(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
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

test('worker /readyz flips to 503 before close while in-flight is held, and the drain is bounded', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const worker = await Fixture.Start(baseDir, 800)
    worker.SetDrainSourceForTest(new HeldSource(1))
    const healthPort = worker.HealthAddressForTest().port
    try
    {
        assert.equal(await Fixture.Get(healthPort, '/readyz'), 200)
        const disposing = worker.DisposeAsync()
        await Fixture.Pause(30)
        assert.equal(await Fixture.Get(healthPort, '/readyz'), 503)
        await disposing
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})

test('concurrent DisposeAsync calls both stay pending while held, then resolve together with teardown run once', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const events: string[] = []
    const worker = await Fixture.Start(baseDir, 3000, undefined, new FakeObservability(events).AsObservability())
    const held = new HeldSource(1)
    worker.SetDrainSourceForTest(held)
    worker.SetDrainControllerForTest(new DrainController(3000))
    try
    {
        const first = worker.DisposeAsync()
        const second = worker.DisposeAsync()
        assert.equal(await Pending.IsPending(first, 80), true)
        assert.equal(await Pending.IsPending(second, 10), true)
        assert.deepEqual(events, [])
        held.Release()
        await Promise.all([first, second])
        assert.deepEqual(events, ['shutdown'])
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})

test('on timeout a live ws client is terminated and the log shows drained=false with positive remaining', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const lines: string[] = []
    const worker = await Fixture.Start(baseDir, 100, lines)
    worker.SetDrainSourceForTest(new HeldSource(1))
    worker.SetDrainControllerForTest(new FakeClock().Controller(100))
    try
    {
        const ws = await Fixture.Connect(worker)
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
        await worker.DisposeAsync()
        await closed
        const complete = Fixture.Events(lines).find(entry => entry['event'] === 'drain-complete')
        assert.ok(complete !== undefined)
        assert.equal(complete['drained'], false)
        assert.ok(Number(complete['remaining']) > 0)
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})

test('an upgrade arriving mid-drain is answered 503 and attaches no handler', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const worker = await Fixture.Start(baseDir, 3000)
    const held = new HeldSource(1)
    worker.SetDrainSourceForTest(held)
    try
    {
        const token = await Fixture.Token(worker)
        const disposing = worker.DisposeAsync()
        await Fixture.Pause(40)
        const before = worker.HandlerCountForTest()
        assert.equal(await Fixture.Status(Fixture.Dial(worker, token)), 503)
        assert.equal(worker.HandlerCountForTest(), before)
        assert.equal(before, 0)
        held.Release()
        await disposing
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})

test('a throw in the readiness-close step is logged by step name and later teardown still runs', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const events: string[] = []
    const lines: string[] = []
    const worker = await Fixture.Start(baseDir, 100, lines, new FakeObservability(events).AsObservability())
    worker.SetDrainControllerForTest(new FakeClock().Controller(100))
    const internals = worker as unknown as { httpsServer: { closeIdleConnections: () => void } }
    const original = internals.httpsServer.closeIdleConnections.bind(internals.httpsServer)
    let calls = 0
    internals.httpsServer.closeIdleConnections = () =>
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
        await worker.DisposeAsync()
        assert.deepEqual(events, ['shutdown'])
        const failed = Fixture.Events(lines).find(entry => entry['event'] === 'drain-failed')
        assert.ok(failed !== undefined)
        assert.equal(failed['step'], 'readiness-close')
        assert.ok(!lines.some(line => line.includes('boom')))
        assert.ok(Fixture.Events(lines).some(entry => entry['event'] === 'drain-complete'))
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})

test('a throwing in-flight source degrades to zero: clean drain-begin and a bounded drain', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const lines: string[] = []
    const worker = await Fixture.Start(baseDir, 100, lines)
    worker.SetDrainSourceForTest({ InFlight: () => { throw new Error('boom') } })
    worker.SetDrainControllerForTest(new FakeClock().Controller(100))
    try
    {
        await worker.DisposeAsync()
        const entries = Fixture.Events(lines)
        const begin = entries.find(entry => entry['event'] === 'drain-begin')
        assert.ok(begin !== undefined)
        assert.equal(begin['inFlight'], 0)
        assert.ok(!entries.some(entry => entry['event'] === 'drain-failed'))
        const complete = entries.find(entry => entry['event'] === 'drain-complete')
        assert.ok(complete !== undefined)
        assert.equal(complete['drained'], true)
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})

test('the heartbeat monitor watches a live ws client and is emptied on dispose', async () =>
{
    const baseDir = Fixture.NewBaseDir()
    const worker = await Fixture.Start(baseDir, 100)
    worker.SetDrainControllerForTest(new FakeClock().Controller(100))
    try
    {
        const ws = await Fixture.Connect(worker)
        assert.equal(worker.HeartbeatCountForTest(), 1)
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
        await worker.DisposeAsync()
        await closed
        assert.equal(worker.HeartbeatCountForTest(), 0)
    }
    finally
    {
        Fixture.Cleanup(baseDir)
    }
})
