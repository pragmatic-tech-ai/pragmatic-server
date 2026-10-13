import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gateway } from '../gateway.js'
import type { IWorkerRouter, WorkerEndpoint } from '../worker-router.js'
import type { MachineTlsRef } from '../machine-tls.js'
import type { IInFlightSource } from '../../observability/drain-controller.js'

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

class GwFixture
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')

    public static Tls(): MachineTlsRef
    {
        return { certFile: join(GwFixture.Dir, 'server.pem'), keyFile: join(GwFixture.Dir, 'server.key'), caFile: join(GwFixture.Dir, 'ca.pem') }
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
}

test('gateway /readyz flips to 503 before close while a connection is held, and the drain is bounded (Review Focus 1, 2)', async () =>
{
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls(), drainTimeoutMs: 80 })
    const held: IInFlightSource = { InFlight: () => 1 }
    gateway.SetDrainSourceForTest(held)
    const port = gateway.Address().port
    assert.equal(await GwFixture.Get(port, '/readyz'), 200)
    const started = Date.now()
    const disposing = gateway.DisposeAsync()
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    assert.equal(await GwFixture.Get(port, '/readyz'), 503)
    await disposing
    assert.ok(Date.now() - started < 3000)
})

test('gateway DisposeAsync is idempotent: concurrent calls share one promise', async () =>
{
    const gateway = await Gateway.StartAsync({ host: '127.0.0.1', port: 0, router: new StubRouter(), tls: GwFixture.Tls() })
    const first = gateway.DisposeAsync()
    const second = gateway.DisposeAsync()
    assert.equal(first, second)
    await first
})
