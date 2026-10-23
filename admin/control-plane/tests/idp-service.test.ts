import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdpService } from '../idp-service.js'
import { IdpStatus } from '../idp-record.js'
import { IdpRegistry } from '../idp-registry.js'
import type { IdpContainerEnv, IdpContainerSpec } from '../idp-container-env.js'
import type { PortAllocator } from '../port-allocator.js'

class FakeContainers
{
    public readonly Calls: string[] = []
    public Specs: IdpContainerSpec[] = []
    public FailHealthy = false
    public SeenToken = ''

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
        if (this.FailHealthy)
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
    public Service = new IdpService(new FakeAllocator() as unknown as PortAllocator, this.Containers as unknown as IdpContainerEnv, this.Registry, this.Root, 'img:1')

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
        for (const f of ['ca.key', 'ca.crt', 'server.key', 'server.crt'])
        {
            assert.ok(existsSync(join(dir, 'tls', f)), f)
        }
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

test('reuse falls through to a fresh launch when the IdP is unhealthy', async () =>
{
    const fx = new Fixture()
    try
    {
        await fx.Service.EnsureForTenant('t1', 'T')
        fx.Containers.FailHealthy = true
        // unhealthy reuse -> cleanup -> relaunch, whose own WaitHealthy also fails -> rejects
        await assert.rejects(fx.Service.EnsureForTenant('t1', 'T'))
        assert.equal(fx.Containers.Calls.filter(c => c === 'Up').length, 2)
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
