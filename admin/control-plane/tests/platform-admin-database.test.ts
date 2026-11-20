import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { PlatformAdminDatabase, PlatformAdminDatabaseMissingError, PlatformAdminRegistry } from '../platform-admin-database.js'

class DatabaseFixture
{
    public static readonly Prefix = 'padmin-db-'
    public static readonly UrlFileName = 'database-url'
    public static readonly LiveUrlEnvVar = 'PRAGMATIC_TEST_PG_URL'
    public static readonly SearchPathOption = '-c search_path='

    /** The live test database's URL, pointed at `schema` (the URL's own query is kept). */
    public static SchemaUrl(schema: string): string
    {
        const url = new URL(process.env[DatabaseFixture.LiveUrlEnvVar] as string)
        url.searchParams.set('options', DatabaseFixture.SearchPathOption + schema)
        return url.toString()
    }
}

describe('PlatformAdminDatabase', () =>
{
    it('refuses to open without PRAGMATIC_ADMIN_DATABASE_URL_FILE (unset or blank), naming the setting', async () =>
    {
        await assert.rejects(PlatformAdminDatabase.Open({}), PlatformAdminDatabaseMissingError)
        await assert.rejects(PlatformAdminDatabase.Open({ PRAGMATIC_ADMIN_DATABASE_URL_FILE: '  ' }), /PRAGMATIC_ADMIN_DATABASE_URL_FILE/)
    })

    it('an unreadable URL file fails naming the file, never a URL', async () =>
    {
        const dir = await mkdtemp(join(tmpdir(), DatabaseFixture.Prefix))
        try
        {
            const missing = join(dir, DatabaseFixture.UrlFileName)
            await assert.rejects(PlatformAdminDatabase.Open({ PRAGMATIC_ADMIN_DATABASE_URL_FILE: missing }), (err: Error) => err.message.includes(missing))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('every registry is a distinct lower-case table name', () =>
    {
        const names = Object.values(PlatformAdminRegistry)
        assert.equal(new Set(names).size, names.length)
        assert.ok(names.every(n => /^[a-z][a-z0-9_]{0,47}$/.test(n)))
    })

    SqlTestSessions.Describe('PlatformAdminDatabase', (makeSession, backend) =>
    {
        it(`${backend}: opens every store of the console over one session, twice (migrations run once)`, async () =>
        {
            const session = await makeSession()
            for (let round = 0; round < 2; round++)
            {
                const database = PlatformAdminDatabase.Over(session)
                for (const registry of Object.values(PlatformAdminRegistry))
                {
                    assert.equal(await (await database.Map(registry)).IsEmpty(), true)
                }
                await database.Signatures()
                const repositories = await database.SessionRepositories()
                assert.ok(repositories.Sessions && repositories.Tickets && repositories.Throttles)
                assert.deepEqual(await (await database.Audit()).Recent(1), [])
                await database.Close()
            }
        })
    })

    SqlTestSessions.DescribeLive('PlatformAdminDatabase', makeDatabase =>
    {
        it('live: opens the database a URL file names and writes through it', async () =>
        {
            const live = await makeDatabase()
            const dir = await mkdtemp(join(tmpdir(), DatabaseFixture.Prefix))
            try
            {
                const urlFile = join(dir, DatabaseFixture.UrlFileName)
                await writeFile(urlFile, DatabaseFixture.SchemaUrl(live.Schema) + '\n')
                const database = await PlatformAdminDatabase.Open({ PRAGMATIC_ADMIN_DATABASE_URL_FILE: urlFile })
                try
                {
                    const clients = await database.Map<{ id: string }>(PlatformAdminRegistry.Clients)
                    await clients.Save(new Map([['acme', { id: 'acme' }]]), new Set(['acme']))
                }
                finally
                {
                    await database.Close()
                }
                const rows = await live.Session().Query('SELECT id FROM records_clients', [])
                assert.deepEqual(rows.map(r => r.id), ['acme'])
            }
            finally
            {
                await rm(dir, { recursive: true, force: true })
                await live.Dispose()
            }
        })
    })
})
