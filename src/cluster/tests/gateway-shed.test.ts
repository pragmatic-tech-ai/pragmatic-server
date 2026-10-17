import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { TransportCloseCode } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Gateway } from '../gateway.js'
import type { IWorkerRouter, WorkerEndpoint } from '../worker-router.js'
import type { MachineTlsRef } from '../machine-tls.js'

class StubRouter implements IWorkerRouter
{
    public RouteOrSpawn(): Promise<WorkerEndpoint>
    {
        return Promise.resolve({ host: '127.0.0.1', port: 1 })
    }

    public Drain(): Promise<void>
    {
        return Promise.resolve()
    }
}

class FakeWs extends EventEmitter
{
    public readyState: number = WebSocket.OPEN
    public bufferedAmount: number
    public readonly Sent: unknown[] = []
    public readonly Closed: number[] = []
    public Terminated = false

    public constructor(bufferedAmount: number)
    {
        super()
        this.bufferedAmount = bufferedAmount
    }

    public send(data: unknown): void
    {
        this.Sent.push(data)
    }

    public close(code?: number): void
    {
        this.Closed.push(code ?? 0)
    }

    public terminate(): void
    {
        this.Terminated = true
    }

    public AsWs(): WebSocket
    {
        return this as unknown as WebSocket
    }
}

class ShedFixture
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')
    private static readonly MessageEvent = 'message'

    public static Tls(): MachineTlsRef
    {
        return { certFile: join(ShedFixture.Dir, 'server.pem'), keyFile: join(ShedFixture.Dir, 'server.key'), caFile: join(ShedFixture.Dir, 'ca.pem') }
    }

    public static Start(hardBytes: number): Promise<Gateway>
    {
        const wsResilience = { heartbeatIntervalMs: 30000, readIdleMs: 60000, backpressureSoftBytes: 1, backpressureHardBytes: hardBytes, backpressureGraceMs: 0, maxInboundBytes: 16777216 }
        return Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: ShedFixture.Tls(), wsResilience })
    }

    public static Frame(from: FakeWs): void
    {
        from.emit(ShedFixture.MessageEvent, Buffer.from('x'), false)
    }
}

test('gateway sheds a slow destination leg with 1013 and removes it from the worker set', async () =>
{
    const gateway = await ShedFixture.Start(10)
    try
    {
        const client = new FakeWs(0)
        const worker = new FakeWs(20)
        gateway.BridgeForTest(client.AsWs(), worker.AsWs())
        assert.equal(gateway.WorkerSocketCountForTest(), 1)
        ShedFixture.Frame(client)
        assert.deepEqual(worker.Closed, [TransportCloseCode.TryAgainLater])
        assert.equal(worker.Terminated, true)
        assert.equal(worker.Sent.length, 0)
        assert.equal(gateway.WorkerSocketCountForTest(), 0)
    }
    finally
    {
        await gateway.DisposeAsync()
    }
})

test('gateway forwards to a destination whose buffer is under the hard limit', async () =>
{
    const gateway = await ShedFixture.Start(10)
    try
    {
        const client = new FakeWs(0)
        const worker = new FakeWs(5)
        gateway.BridgeForTest(client.AsWs(), worker.AsWs())
        ShedFixture.Frame(client)
        assert.equal(worker.Sent.length, 1)
        assert.deepEqual(worker.Closed, [])
        assert.equal(worker.Terminated, false)
    }
    finally
    {
        await gateway.DisposeAsync()
    }
})

test('gateway sheds a slow client leg (worker-to-client) and tears down the peer worker leg on client close', async () =>
{
    const gateway = await ShedFixture.Start(10)
    try
    {
        const client = new FakeWs(20)
        const worker = new FakeWs(0)
        gateway.BridgeForTest(client.AsWs(), worker.AsWs())
        ShedFixture.Frame(worker)
        assert.deepEqual(client.Closed, [TransportCloseCode.TryAgainLater])
        assert.equal(client.Terminated, true)
        assert.equal(client.Sent.length, 0)
        assert.deepEqual(worker.Closed, [])
        client.emit('close')
        assert.equal(worker.Closed.length, 1)
        assert.equal(gateway.WorkerSocketCountForTest(), 0)
    }
    finally
    {
        await gateway.DisposeAsync()
    }
})
