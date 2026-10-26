import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdpService } from '../idp-service.js'
import { DockerIdpDriver } from '../docker-idp-driver.js'
import type { IIdpWorkloadDriver, IdpWorkloadRequest, IdpWorkloadResult } from '../idp-workload-driver.js'
import { IdpStatus } from '../idp-record.js'
import type { IdpRecord } from '../idp-record.js'
import { IdpRegistry } from '../idp-registry.js'
import type { IdpContainerEnv, IdpContainerSpec } from '../idp-container-env.js'
import type { PortAllocator } from '../port-allocator.js'

class FakeContainers
{
    public readonly Calls: string[] = []
    public Specs: IdpContainerSpec[] = []
    public FailHealthy = false
    public FailHealthyOnCalls: number[] = []
    public SeenToken = ''
    private healthCallCount = 0

    public async Up(spec: IdpContainerSpec): Promise<void>
    {
        this.Calls.push('Up')
        this.Specs.push(spec)
    }

    public async Down(name: string): Promise<void>
    {
        this.Calls.push('Down:' + name)
    }

    public async RemoveVolume(name: string): Promise<void>
    {
        this.Calls.push('RemoveVolume:' + name)
    }

    public async SeedVolume(volume: string, dir: string): Promise<void>
    {
        this.Calls.push('SeedVolume:' + volume)
        assert.ok(existsSync(join(dir, 'tls', 'ca.crt')))
        this.SeenToken = readFileSync(join(dir, 'secrets', 'admin-token'), 'utf8')
    }

    public async WaitHealthy(): Promise<void>
    {
        this.Calls.push('WaitHealthy')
        this.healthCallCount++
        if (this.FailHealthy || this.FailHealthyOnCalls.includes(this.healthCallCount))
        {
            throw new Error('not healthy')
        }
    }
}

class FakeAllocator
{
    public async Allocate(): Promise<number>
    {
        return 12100
    }
}

class Fixture
{
    public Root = mkdtempSync(join(tmpdir(), 'idpsvc-'))
    public Containers = new FakeContainers()
    public Registry = new IdpRegistry(join(this.Root, 'idps.json'))
    public Service = new IdpService(this.Registry, new DockerIdpDriver(new FakeAllocator() as unknown as PortAllocator, this.Containers as unknown as IdpContainerEnv, this.Root, 'img:1'))

    public Dispose(): void
    {
        rmSync(this.Root, { recursive: true, force: true })
    }
}

test('EnsureForTenant launches fresh: mints CA, writes token, seeds, ups, persists Running', async () =>
{
    const fx = new Fixture()
    try
    {
        const conn = await fx.Service.EnsureForTenant('t1', 'Tenant One')
        const dir = join(fx.Root, 'idp', 't1')
        for (const f of ['ca.crt', 'server.key', 'server.crt'])
        {
            assert.ok(existsSync(join(dir, 'tls', f)), f)
        }
        assert.ok(!existsSync(join(dir, 'tls', 'ca.key')))
        const tokenFile = join(dir, 'secrets', 'admin-token')
        assert.ok(existsSync(tokenFile))
        if (process.platform !== 'win32')
        {
            assert.equal(statSync(tokenFile).mode & 0o777, 0o600)
        }
        assert.deepEqual(fx.Containers.Calls.filter(c => !c.startsWith('Down') && !c.startsWith('Remove')), ['SeedVolume:pragmatic-idp-data-t1', 'Up', 'WaitHealthy'])
        assert.equal(conn.baseUrl, 'https://host.docker.internal:12100')
        assert.ok(Buffer.isBuffer(conn.ca) && conn.ca.length > 0)
        assert.ok(conn.adminToken.length > 0)
        const rec = fx.Registry.Get('t1')
        assert.equal(rec?.status, IdpStatus.Running)
        assert.equal(rec?.port, 12100)
        assert.equal(rec?.baseUrl, conn.baseUrl)
    }
    finally
    {
        fx.Dispose()
    }
})

test('failure rolls back, persists no Running record, and never leaks the admin token', async () =>
{
    const fx = new Fixture()
    try
    {
        fx.Containers.FailHealthy = true
        let caught: unknown
        try
        {
            await fx.Service.EnsureForTenant('t1', 'T')
        }
        catch (e)
        {
            caught = e
        }
        assert.ok(caught instanceof Error)
        assert.ok(fx.Containers.Calls.includes('Down:pragmatic-idp-t1'))
        assert.ok(fx.Containers.Calls.includes('RemoveVolume:pragmatic-idp-data-t1'))
        assert.equal(fx.Registry.Get('t1'), undefined)
        const secret = fx.Containers.SeenToken
        assert.ok(!existsSync(join(fx.Root, 'idp', 't1', 'secrets')))
        assert.ok(secret.length > 0)
        assert.ok(!String(caught).includes(secret))
        assert.ok(!(caught as Error).stack?.includes(secret))
    }
    finally
    {
        fx.Dispose()
    }
})

test('second EnsureForTenant reuses the running IdP without relaunching', async () =>
{
    const fx = new Fixture()
    try
    {
        const first = await fx.Service.EnsureForTenant('t1', 'T')
        const second = await fx.Service.EnsureForTenant('t1', 'T')
        assert.equal(fx.Containers.Calls.filter(c => c === 'Up').length, 1)
        assert.equal(second.adminToken, first.adminToken)
        assert.ok(second.ca.equals(first.ca))
        assert.equal(second.baseUrl, first.baseUrl)
    }
    finally
    {
        fx.Dispose()
    }
})

test('unhealthy reuse recovers in place on the same port and volume, never removing it', async () =>
{
    const fx = new Fixture()
    try
    {
        const first = await fx.Service.EnsureForTenant('t1', 'T')   // fresh launch: WaitHealthy call #1 ok
        fx.Containers.FailHealthyOnCalls = [2]                       // #2 = the reuse probe fails; #3 = recovery succeeds
        const recovered = await fx.Service.EnsureForTenant('t1', 'T')
        // Recovery brought it back with a second Up after a Down, and NEVER removed the volume.
        assert.equal(fx.Containers.Calls.filter(c => c === 'Up').length, 2)
        assert.ok(fx.Containers.Calls.includes('Down:pragmatic-idp-t1'))
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
        const relaunch = fx.Containers.Specs[1]
        assert.equal(relaunch.port, 12100)                          // same port -> issuer/discovery URL unchanged
        assert.equal(relaunch.volumeName, 'pragmatic-idp-data-t1')  // same volume -> realm/accounts/clients preserved
        assert.equal(recovered.baseUrl, first.baseUrl)
        assert.equal(recovered.adminToken, first.adminToken)
        assert.ok(recovered.ca.equals(first.ca))
    }
    finally
    {
        fx.Dispose()
    }
})

test('recovery that cannot come back rejects and still never removes the identity volume', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.FailHealthy = true     // both the reuse probe and the recovery health check fail
        await assert.rejects(fx.Service.EnsureForTenant('t1', 'T'), /recovery failed/)
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
    }
    finally
    {
        fx.Dispose()
    }
})

test('concurrent EnsureForTenant for one new tenant launches once and returns the same connection', async () =>
{
    const fx = new Fixture()
    try
    {
        const [a, b] = await Promise.all([fx.Service.EnsureForTenant('t1', 'T'), fx.Service.EnsureForTenant('t1', 'T')])
        assert.equal(fx.Containers.Calls.filter(c => c === 'Up').length, 1)
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('Down') || c.startsWith('RemoveVolume')))
        assert.equal(a.adminToken, b.adminToken)
        assert.ok(a.ca.equals(b.ca))
        assert.equal(a.baseUrl, b.baseUrl)
    }
    finally
    {
        fx.Dispose()
    }
})

test('invalid tenantId is rejected before anything launches', async () =>
{
    const fx = new Fixture()
    try
    {
        for (const bad of ['a/b', 'a:b', '', '..'])
        {
            await assert.rejects(fx.Service.EnsureForTenant(bad, 'T'), /invalid tenantId/)
        }
        assert.deepEqual(fx.Containers.Calls, [])
    }
    finally
    {
        fx.Dispose()
    }
})

class FakeDriver implements IIdpWorkloadDriver
{
    public static readonly SecretToken = 'tok-SECRET-123'
    public static readonly SecretCa = 'CA-SECRET-BYTES'
    public Requests: IdpWorkloadRequest[] = []
    public Fail = false
    public Discarded: string[] = []
    public Reuse = false

    public async Discard(record: { tenantId: string }): Promise<void>
    {
        this.Discarded.push(record.tenantId)
    }

    public async EnsureRunning(request: IdpWorkloadRequest): Promise<IdpWorkloadResult>
    {
        this.Requests.push(request)
        if (this.Fail)
        {
            throw new Error('driver exploded')
        }
        if (this.Reuse && request.existing !== undefined)
        {
            return { record: request.existing, connection: { baseUrl: request.existing.baseUrl, browserBaseUrl: request.existing.baseUrl, ca: Buffer.from(FakeDriver.SecretCa), adminToken: FakeDriver.SecretToken, adminTokenRef: request.existing.adminTokenRef, caDir: request.existing.caDir } }
        }
        const record = {
            tenantId: request.tenantId, port: 8443, baseUrl: 'https://idp.svc:8443', containerName: 'c', volumeName: 'v',
            caDir: 'ca-ref', adminTokenRef: 'admin-ref', createdAt: '2026-01-01T00:00:00.000Z', status: IdpStatus.Running
        }
        return {
            record,
            connection: { baseUrl: record.baseUrl, browserBaseUrl: record.baseUrl, ca: Buffer.from(FakeDriver.SecretCa), adminToken: FakeDriver.SecretToken, adminTokenRef: 'admin-ref', caDir: 'ca-ref' }
        }
    }
}

test('EnsureForTenant delegates to the injected driver and persists the driver record', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-drv-'))
    try
    {
        const registry = new IdpRegistry(join(root, 'idps.json'))
        const driver = new FakeDriver()
        const service = new IdpService(registry, driver)
        const conn = await service.EnsureForTenant('t9', 'Tenant Nine')
        assert.equal(driver.Requests.length, 1)
        assert.equal(driver.Requests[0]!.tenantId, 't9')
        assert.equal(driver.Requests[0]!.displayName, 'Tenant Nine')
        assert.equal(driver.Requests[0]!.existing, undefined)
        assert.equal(conn.baseUrl, 'https://idp.svc:8443')
        const rec = registry.Get('t9')
        assert.equal(rec?.baseUrl, 'https://idp.svc:8443')
        assert.equal(rec?.adminTokenRef, 'admin-ref')
        assert.equal(rec?.status, IdpStatus.Running)
        // Second call hands the persisted record back to the driver.
        await service.EnsureForTenant('t9', 'Tenant Nine')
        assert.equal(driver.Requests[1]!.existing?.port, 8443)
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('driver failure persists nothing, propagates, and no secret material reaches the registry file or error', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-drv-'))
    try
    {
        const registry = new IdpRegistry(join(root, 'idps.json'))
        const driver = new FakeDriver()
        driver.Fail = true
        const service = new IdpService(registry, driver)
        await assert.rejects(() => service.EnsureForTenant('t9', 'T'), (e: Error) => !e.message.includes(FakeDriver.SecretToken) && !e.message.includes(FakeDriver.SecretCa))
        assert.equal(registry.Get('t9'), undefined)
        driver.Fail = false
        await service.EnsureForTenant('t9', 'T')
        const persisted = readFileSync(join(root, 'idps.json'), 'utf8')
        assert.ok(!persisted.includes(FakeDriver.SecretToken))
        assert.ok(!persisted.includes(FakeDriver.SecretCa))
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

class ThrowingRegistry extends IdpRegistry
{
    public PutCalls = 0
    public FailPut = false

    public override async Put(record: IdpRecord): Promise<void>
    {
        this.PutCalls++
        if (this.FailPut)
        {
            throw new Error('disk full')
        }
        await super.Put(record)
    }
}

test('Put failure after a create discards the new record via the driver, then rethrows', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-drv-'))
    try
    {
        const registry = new ThrowingRegistry(join(root, 'idps.json'))
        registry.FailPut = true
        const driver = new FakeDriver()
        const service = new IdpService(registry, driver)
        await assert.rejects(() => service.EnsureForTenant('t9', 'T'), /disk full/)
        assert.deepEqual(driver.Discarded, ['t9'])
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('reuse of an existing record neither re-Puts nor Discards', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-drv-'))
    try
    {
        const registry = new ThrowingRegistry(join(root, 'idps.json'))
        const driver = new FakeDriver()
        driver.Reuse = true
        const service = new IdpService(registry, driver)
        await service.EnsureForTenant('t9', 'T')
        assert.equal(registry.PutCalls, 1)
        registry.FailPut = true
        await service.EnsureForTenant('t9', 'T')
        assert.equal(registry.PutCalls, 1)
        assert.deepEqual(driver.Discarded, [])
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})
