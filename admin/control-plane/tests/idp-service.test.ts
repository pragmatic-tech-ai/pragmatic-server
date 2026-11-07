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
import type { IdpContainerEnv, IdpContainerSpec, StaleImage } from '../idp-container-env.js'
import type { PortAllocator } from '../port-allocator.js'

class FakeContainers
{
    public readonly Calls: string[] = []
    public Specs: IdpContainerSpec[] = []
    public FailHealthy = false
    public FailHealthyOnCalls: number[] = []
    public SeenToken = ''
    public Stale: StaleImage | undefined
    /** Images whose Up throws (a broken rebuild). */
    public FailUpFor: string[] = []
    /** The CA each WaitHealthy call trusted, in call order. */
    public readonly HealthCas: Buffer[] = []
    private healthCallCount = 0

    public async StaleImageOf(name: string, image: string): Promise<StaleImage | undefined>
    {
        this.Calls.push('StaleImageOf:' + name + '@' + image)
        return this.Stale
    }

    public async Up(spec: IdpContainerSpec): Promise<void>
    {
        this.Calls.push('Up')
        this.Specs.push(spec)
        if (this.FailUpFor.includes(spec.image))
        {
            throw new Error('image does not start')
        }
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

    public async WaitHealthy(_port: number, ca: Buffer): Promise<void>
    {
        this.Calls.push('WaitHealthy')
        this.HealthCas.push(ca)
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

test('a healthy IdP on a rebuilt image is refreshed in place onto the current image, keeping port, volume and CA', async () =>
{
    const fx = new Fixture()
    try
    {
        const first = await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.Stale = { running: 'sha256:old', current: 'sha256:new' }
        const mark = fx.Containers.Calls.length
        const refreshed = await fx.Service.EnsureForTenant('t1', 'T')
        assert.deepEqual(fx.Containers.Calls.slice(mark), ['WaitHealthy', 'StaleImageOf:pragmatic-idp-t1@img:1', 'Down:pragmatic-idp-t1', 'SeedVolume:pragmatic-idp-data-t1', 'Up', 'WaitHealthy'])
        const relaunch = fx.Containers.Specs[1]
        assert.equal(relaunch.image, 'img:1')
        assert.equal(relaunch.port, 12100)
        assert.equal(relaunch.volumeName, 'pragmatic-idp-data-t1')
        assert.equal(refreshed.baseUrl, first.baseUrl)
        assert.ok(refreshed.ca.equals(first.ca))
    }
    finally
    {
        fx.Dispose()
    }
})

test('a rebuilt image that cannot start brings the IdP back on the image it ran, and that build is not retried', async () =>
{
    const fx = new Fixture()
    try
    {
        const first = await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.Stale = { running: 'sha256:old', current: 'sha256:new' }
        fx.Containers.FailUpFor = ['img:1']
        const kept = await fx.Service.EnsureForTenant('t1', 'T')
        assert.deepEqual(fx.Containers.Specs.slice(1).map(s => s.image), ['img:1', 'sha256:old'])
        assert.equal(kept.baseUrl, first.baseUrl)
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
        const ups = fx.Containers.Specs.length
        await fx.Service.EnsureForTenant('t1', 'T')
        assert.equal(fx.Containers.Specs.length, ups)
        fx.Containers.Stale = { running: 'sha256:old', current: 'sha256:newer' }
        fx.Containers.FailUpFor = []
        await fx.Service.EnsureForTenant('t1', 'T')
        assert.equal(fx.Containers.Specs.length, ups + 1)
        assert.equal(fx.Containers.Specs[ups].image, 'img:1')
    }
    finally
    {
        fx.Dispose()
    }
})

test('an IdP kept on its fallback build that later goes unhealthy is recovered on that build, not the refused one', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.Stale = { running: 'sha256:old', current: 'sha256:new' }
        fx.Containers.FailUpFor = ['img:1']
        await fx.Service.EnsureForTenant('t1', 'T')
        const ups = fx.Containers.Specs.length
        fx.Containers.FailHealthyOnCalls = [fx.Containers.HealthCas.length + 1]   // the next reuse probe misses
        const recovered = await fx.Service.EnsureForTenant('t1', 'T')
        assert.deepEqual(fx.Containers.Specs.slice(ups).map(s => s.image), ['sha256:old'])
        assert.equal(recovered.baseUrl, 'https://host.docker.internal:12100')
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
    }
    finally
    {
        fx.Dispose()
    }
})

test('an unhealthy IdP whose fallback build is gone is recovered on the tag', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.Stale = { running: 'sha256:old', current: 'sha256:new' }
        fx.Containers.FailUpFor = ['img:1']
        await fx.Service.EnsureForTenant('t1', 'T')
        const ups = fx.Containers.Specs.length
        fx.Containers.FailUpFor = ['sha256:old']
        fx.Containers.FailHealthyOnCalls = [fx.Containers.HealthCas.length + 1]
        await fx.Service.EnsureForTenant('t1', 'T')
        assert.deepEqual(fx.Containers.Specs.slice(ups).map(s => s.image), ['sha256:old', 'img:1'])
    }
    finally
    {
        fx.Dispose()
    }
})

test('a rebuilt image that cannot start, with the old image gone too, rejects with the refresh failure and keeps the volume', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.Stale = { running: 'sha256:old', current: 'sha256:new' }
        fx.Containers.FailUpFor = ['img:1', 'sha256:old']
        await assert.rejects(fx.Service.EnsureForTenant('t1', 'T'), /recovery failed[\s\S]*image does not start/)
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
    }
    finally
    {
        fx.Dispose()
    }
})

test('a healthy IdP on the current image is reused after one image check', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        await fx.Service.EnsureForTenant('t1', 'T')
        assert.equal(fx.Containers.Calls.filter(c => c.startsWith('StaleImageOf')).length, 1)
        assert.equal(fx.Containers.Calls.filter(c => c === 'Up').length, 1)
    }
    finally
    {
        fx.Dispose()
    }
})

test('a reused IdP whose tls dir was deleted is recovered with a freshly minted CA that the health check trusts', async () =>
{
    const fx = new Fixture()
    try
    {
        const first = await fx.Service.EnsureForTenant('t1', 'T')
        rmSync(join(fx.Root, 'idp', 't1', 'tls'), { recursive: true, force: true })
        const mark = fx.Containers.Calls.length
        const recovered = await fx.Service.EnsureForTenant('t1', 'T')
        assert.deepEqual(fx.Containers.Calls.slice(mark), ['Down:pragmatic-idp-t1', 'SeedVolume:pragmatic-idp-data-t1', 'Up', 'WaitHealthy'])
        const minted = readFileSync(join(fx.Root, 'idp', 't1', 'tls', 'ca.crt'))
        assert.ok(!recovered.ca.equals(first.ca))
        assert.ok(recovered.ca.equals(minted))
        assert.ok(fx.Containers.HealthCas[fx.Containers.HealthCas.length - 1].equals(minted))
        assert.equal(recovered.baseUrl, first.baseUrl)
        assert.equal(recovered.adminToken, first.adminToken)
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
    }
    finally
    {
        fx.Dispose()
    }
})

test('a tls dir missing only its CA file is not re-minted: recovery fails and keeps the volume', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        rmSync(join(fx.Root, 'idp', 't1', 'tls', 'ca.crt'), { force: true })
        await assert.rejects(fx.Service.EnsureForTenant('t1', 'T'), /recovery failed/)
        assert.ok(!existsSync(join(fx.Root, 'idp', 't1', 'tls', 'ca.crt')))
        assert.ok(!fx.Containers.Calls.some(c => c.startsWith('RemoveVolume')))
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

class TeardownCase
{
    public static readonly TenantId = 't9'
    public static readonly Absent = 'nobody'
    public static readonly DriverFailure = 'discard failed'
    public static readonly DbFile = 'idps.json'
    public static readonly Prefix = 'idpsvc-td-'
}

class FailingDiscardDriver extends FakeDriver
{
    public override async Discard(): Promise<void>
    {
        throw new Error(TeardownCase.DriverFailure)
    }
}

test('TeardownForTenant discards the tenant IdP via the driver and forgets its record', async () =>
{
    const root = mkdtempSync(join(tmpdir(), TeardownCase.Prefix))
    try
    {
        const registry = new IdpRegistry(join(root, TeardownCase.DbFile))
        const driver = new FakeDriver()
        const service = new IdpService(registry, driver)
        await service.EnsureForTenant(TeardownCase.TenantId, 'T')
        await service.TeardownForTenant(TeardownCase.TenantId)
        assert.deepEqual(driver.Discarded, [TeardownCase.TenantId])
        await registry.Load()
        assert.equal(registry.Get(TeardownCase.TenantId), undefined)
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('TeardownForTenant with no IdP record is a safe no-op', async () =>
{
    const root = mkdtempSync(join(tmpdir(), TeardownCase.Prefix))
    try
    {
        const driver = new FakeDriver()
        const service = new IdpService(new IdpRegistry(join(root, TeardownCase.DbFile)), driver)
        await service.TeardownForTenant(TeardownCase.Absent)
        assert.deepEqual(driver.Discarded, [])
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('TeardownForTenant keeps the record when the driver Discard fails (retryable)', async () =>
{
    const root = mkdtempSync(join(tmpdir(), TeardownCase.Prefix))
    try
    {
        const registry = new IdpRegistry(join(root, TeardownCase.DbFile))
        await new IdpService(registry, new FakeDriver()).EnsureForTenant(TeardownCase.TenantId, 'T')
        const failing = new IdpService(registry, new FailingDiscardDriver())
        await assert.rejects(() => failing.TeardownForTenant(TeardownCase.TenantId), new RegExp(TeardownCase.DriverFailure))
        await registry.Load()
        assert.notEqual(registry.Get(TeardownCase.TenantId), undefined)
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('ConnectForTenant returns undefined for a tenant with no record and never creates or allocates', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-conn-'))
    try
    {
        const registry = new IdpRegistry(join(root, 'idps.json'))
        const driver = new FakeDriver()
        const service = new IdpService(registry, driver)
        assert.equal(await service.ConnectForTenant('ghost'), undefined)
        assert.equal(driver.Requests.length, 0)
        assert.equal(registry.Get('ghost'), undefined)
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('ConnectForTenant returns a connection to an existing Running record via the reuse path', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-conn-'))
    try
    {
        const registry = new IdpRegistry(join(root, 'idps.json'))
        await registry.Put({
            tenantId: 't7', port: 8443, baseUrl: 'https://idp.svc:8443', containerName: 'c', volumeName: 'v',
            caDir: 'ca-ref', adminTokenRef: 'admin-ref', createdAt: '2026-01-01T00:00:00.000Z', status: IdpStatus.Running
        })
        const driver = new FakeDriver()
        driver.Reuse = true
        const service = new IdpService(registry, driver)
        const conn = await service.ConnectForTenant('t7')
        assert.equal(conn?.baseUrl, 'https://idp.svc:8443')
        assert.equal(driver.Requests.length, 1)
        assert.deepEqual(driver.Requests[0]!.takenPorts, [])
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('ConnectForTenant relaunches an existing non-Running record via the launch path', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-conn-'))
    try
    {
        const registry = new IdpRegistry(join(root, 'idps.json'))
        await registry.Put({
            tenantId: 't8', port: 8444, baseUrl: 'https://idp.svc:8444', containerName: 'c8', volumeName: 'v8',
            caDir: 'ca-ref', adminTokenRef: 'admin-ref', createdAt: '2026-01-01T00:00:00.000Z', status: IdpStatus.Failed
        })
        await registry.Put({
            tenantId: 'other', port: 8445, baseUrl: 'https://idp.svc:8445', containerName: 'c9', volumeName: 'v9',
            caDir: 'ca-ref', adminTokenRef: 'admin-ref', createdAt: '2026-01-01T00:00:00.000Z', status: IdpStatus.Running
        })
        const driver = new FakeDriver()
        const service = new IdpService(registry, driver)
        const conn = await service.ConnectForTenant('t8')
        assert.ok(conn !== undefined)
        assert.equal(driver.Requests.length, 1)
        assert.equal(driver.Requests[0]!.existing?.status, IdpStatus.Failed)
        assert.ok(driver.Requests[0]!.takenPorts.includes(8445))
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('ConnectForTenant racing a TeardownForTenant never recreates the torn-down tenant', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'idpsvc-conn-'))
    try
    {
        const registry = new IdpRegistry(join(root, 'idps.json'))
        await registry.Put({
            tenantId: 't6', port: 8446, baseUrl: 'https://idp.svc:8446', containerName: 'c6', volumeName: 'v6',
            caDir: 'ca-ref', adminTokenRef: 'admin-ref', createdAt: '2026-01-01T00:00:00.000Z', status: IdpStatus.Running
        })
        const driver = new FakeDriver()
        const service = new IdpService(registry, driver)
        const teardown = service.TeardownForTenant('t6')
        const connect = service.ConnectForTenant('t6')
        await teardown
        assert.equal(await connect, undefined)
        assert.equal(driver.Requests.length, 0)
        assert.equal(registry.Get('t6'), undefined)
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})
