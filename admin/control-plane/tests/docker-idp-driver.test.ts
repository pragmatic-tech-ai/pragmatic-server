import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerIdpDriver } from '../docker-idp-driver.js'
import { IdpDatabaseSecret } from '../idp-workload-driver.js'
import type { IdpContainerEnv, IdpContainerSpec } from '../idp-container-env.js'
import type { PortAllocator } from '../port-allocator.js'

/** Records what the driver hands the container seam, and what the database files held when the volume was seeded. */
class DatabaseContainers
{
    public readonly Specs: IdpContainerSpec[] = []
    public readonly SeededPasswords: string[] = []
    public Healthy = true

    public async StaleImageOf(): Promise<undefined>
    {
        return undefined
    }

    public async Up(spec: IdpContainerSpec): Promise<void>
    {
        this.Specs.push(spec)
    }

    public async Down(): Promise<void>
    {
    }

    public async RemoveVolume(): Promise<void>
    {
    }

    public async SeedVolume(_volume: string, dir: string): Promise<void>
    {
        this.SeededPasswords.push(readFileSync(join(dir, 'secrets', 'database-password'), 'utf8'))
    }

    public async WaitHealthy(): Promise<void>
    {
        if (!this.Healthy)
        {
            throw new Error('not healthy')
        }
    }
}

class DriverFixture
{
    public readonly Root = mkdtempSync(join(tmpdir(), 'idpdb-'))
    public readonly Containers = new DatabaseContainers()
    public readonly Driver = new DockerIdpDriver({ Allocate: async () => 12100 } as unknown as PortAllocator, this.Containers as unknown as IdpContainerEnv, this.Root, 'img:1')

    public File(name: string): string
    {
        return join(this.Root, 'idp', 't1', 'secrets', name)
    }

    public Dispose(): void
    {
        rmSync(this.Root, { recursive: true, force: true })
    }
}

test('a launch mints the database password once, with the URL over it beside it, both readable by the IdP user only', async () =>
{
    const fx = new DriverFixture()
    try
    {
        const result = await fx.Driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        const password = readFileSync(fx.File('database-password'), 'utf8')
        assert.ok(password.length >= 32)
        assert.equal(readFileSync(fx.File('database-url'), 'utf8'), IdpDatabaseSecret.UrlOf(password))
        if (process.platform !== 'win32')
        {
            assert.equal(statSync(fx.File('database-password')).mode & 0o777, 0o600)
            assert.equal(statSync(fx.File('database-url')).mode & 0o777, 0o600)
        }
        assert.deepEqual(fx.Containers.SeededPasswords, [password])
        // Nothing secret reaches the container seam's spec (and so no docker argument).
        assert.ok(!JSON.stringify(fx.Containers.Specs).includes(password))
        assert.ok(!JSON.stringify(result.record).includes(password))
    }
    finally
    {
        fx.Dispose()
    }
})

test('recovery keeps an existing database password and mints one for an IdP from before it had a database', async () =>
{
    const fx = new DriverFixture()
    try
    {
        const first = await fx.Driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        const password = readFileSync(fx.File('database-password'), 'utf8')
        // An unhealthy IdP is recovered in place (and here fails again): the password is re-seeded as it is.
        const again = new DatabaseContainers()
        again.Healthy = false
        await assert.rejects(new DockerIdpDriver({ Allocate: async () => 12100 } as unknown as PortAllocator, again as unknown as IdpContainerEnv, fx.Root, 'img:1')
            .EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [], existing: first.record }))
        assert.equal(readFileSync(fx.File('database-password'), 'utf8'), password)
        assert.deepEqual(again.SeededPasswords, [password])

        rmSync(fx.File('database-password'))
        rmSync(fx.File('database-url'))
        const legacy = new DatabaseContainers()
        legacy.Healthy = false
        await assert.rejects(new DockerIdpDriver({ Allocate: async () => 12100 } as unknown as PortAllocator, legacy as unknown as IdpContainerEnv, fx.Root, 'img:1')
            .EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [], existing: first.record }))
        const minted = readFileSync(fx.File('database-password'), 'utf8')
        assert.notEqual(minted, password)
        assert.equal(readFileSync(fx.File('database-url'), 'utf8'), IdpDatabaseSecret.UrlOf(minted))
        assert.deepEqual(legacy.SeededPasswords, [minted])
    }
    finally
    {
        fx.Dispose()
    }
})

test('a failed launch removes the database files with the rest of the tenant dir', async () =>
{
    const fx = new DriverFixture()
    try
    {
        fx.Containers.Healthy = false
        await assert.rejects(fx.Driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] }))
        assert.ok(!existsSync(fx.File('database-password')))
    }
    finally
    {
        fx.Dispose()
    }
})
