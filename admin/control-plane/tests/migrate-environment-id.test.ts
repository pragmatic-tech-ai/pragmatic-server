import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentIdMigrator } from '../migrate-environment-id.js'

class Fixture
{
    public static readonly File = 'registry.json'
    public static readonly Root = 'environments'

    public static async Run(body: (dataRoot: string) => Promise<void>): Promise<void>
    {
        const dataRoot = await mkdtemp(join(tmpdir(), 'migrate-env-'))
        try
        {
            await writeFile(join(dataRoot, Fixture.File), JSON.stringify({
                [Fixture.Root]: {
                    legacy: { name: 'legacy', tenantId: 'contoso', port: 1 },
                    migrated: { name: 'migrated', environmentId: 'acme', port: 2 },
                    platform: { name: 'platform', environmentId: 'zed', tenantId: 'plat-tenant', port: 3 },
                },
            }))
            await body(dataRoot)
        }
        finally
        {
            await rm(dataRoot, { recursive: true, force: true })
        }
    }

    public static async Read(dataRoot: string): Promise<Record<string, Record<string, unknown>>>
    {
        const parsed = JSON.parse(await readFile(join(dataRoot, Fixture.File), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
        return parsed[Fixture.Root]!
    }
}

describe('EnvironmentIdMigrator', () =>
{
    it('renames legacy tenantId, leaves migrated and platform records, is idempotent', async () =>
    {
        await Fixture.Run(async dataRoot =>
        {
            const migrator = new EnvironmentIdMigrator()
            assert.deepEqual(await migrator.Migrate(dataRoot), { changed: 1 })
            const envs = await Fixture.Read(dataRoot)
            assert.deepEqual(envs.legacy, { name: 'legacy', environmentId: 'contoso', port: 1 })
            assert.deepEqual(Object.keys(envs.legacy!), ['name', 'environmentId', 'port'])
            assert.deepEqual(envs.migrated, { name: 'migrated', environmentId: 'acme', port: 2 })
            assert.deepEqual(envs.platform, { name: 'platform', environmentId: 'zed', tenantId: 'plat-tenant', port: 3 })
            assert.deepEqual(await migrator.Migrate(dataRoot), { changed: 0 })
        })
    })

    it('returns zero when environments.json is absent', async () =>
    {
        const dataRoot = await mkdtemp(join(tmpdir(), 'migrate-env-'))
        try
        {
            assert.deepEqual(await new EnvironmentIdMigrator().Migrate(dataRoot), { changed: 0 })
        }
        finally
        {
            await rm(dataRoot, { recursive: true, force: true })
        }
    })
})
