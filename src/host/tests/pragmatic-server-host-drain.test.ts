import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { StructuredLogger } from '../../observability/logger.js'
import type { IInFlightSource } from '../../observability/drain-controller.js'

class DrainFixture
{
    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]]))
    }

    public static async Start(baseDir: string, drainTimeoutMs: number, lines?: string[]): Promise<PragmaticServerHost>
    {
        const keyPath = join(baseDir, 'key')
        writeFileSync(keyPath, randomBytes(32))
        const logger = lines === undefined ? undefined : StructuredLogger.ToSink(line => lines.push(line))
        return PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { keyFilePath: keyPath }, provisioning: DrainFixture.Provisioning(), drainTimeoutMs, logger })
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
    try
    {
        const started = Date.now()
        await host.DisposeAsync()
        assert.ok(Date.now() - started < 3000)
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
