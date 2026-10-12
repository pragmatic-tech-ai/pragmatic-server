import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Gateway } from '../gateway.js'
import { InMemoryWorkerRouter } from '../worker-router.js'
import type { MachineTlsRef } from '../machine-tls.js'

class Tls
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')

    public static Ref(): MachineTlsRef
    {
        return { certFile: join(Tls.Dir, 'server.pem'), keyFile: join(Tls.Dir, 'server.key'), caFile: join(Tls.Dir, 'ca.pem') }
    }
}

class Http
{
    public static Get(port: number, path: string): Promise<{ status: number; body: string }>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res =>
            {
                let body = ''
                res.on('data', c => { body += c })
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

test('the gateway serves /healthz and /readyz on its front door', async () =>
{
    const router = new InMemoryWorkerRouter({ host: '127.0.0.1', port: 1 })
    const gateway = await Gateway.StartAsync({ port: 0, router, tls: Tls.Ref() })
    try
    {
        const health = await Http.Get(gateway.Address().port, '/healthz')
        assert.equal(health.status, 200)
        const ready = await Http.Get(gateway.Address().port, '/readyz')
        assert.equal(ready.status, 200)
    }
    finally
    {
        await gateway.DisposeAsync()
    }
})

test('a non-health request without a tenant still returns 400 (health does not shadow the proxy path)', async () =>
{
    const router = new InMemoryWorkerRouter({ host: '127.0.0.1', port: 1 })
    const gateway = await Gateway.StartAsync({ port: 0, router, tls: Tls.Ref() })
    try
    {
        const res = await Http.Get(gateway.Address().port, '/solution')
        assert.equal(res.status, 400)
    }
    finally
    {
        await gateway.DisposeAsync()
    }
})
