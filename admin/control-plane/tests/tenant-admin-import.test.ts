import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { TenantAdminImportBin } from '../bin/pragmatic-tenant-admin-import.js'
import { ConsoleDelivery } from '../console-delivery.js'
import { ConsoleRegistration, ConsoleEmailDomainStore, RecordSlot } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConsoleOwnerResetFollower } from '../console-owner-reset-follower.js'
import { TenantAdminDatabase, TenantAdminDatabaseMissingError, TenantAdminRegistry } from '../tenant-admin-database.js'
import { TenantAdminDataRoot, TenantAdminImport, TenantAdminImportRefusedError } from '../tenant-admin-import.js'

/** A pre-A5 in-hive console data root, written in the layout the console wrote before its database. */
class ConsoleDataRootFixture
{
    public static readonly Prefix = 'tenant-admin-import-'
    public static readonly Env = { name: 'dev1', type: 'development', template: 'dev-blank', environmentId: 'e1', tenantId: 'acme', hiveId: 'h1', hostPort: 8101, containerName: 'c', volumeName: 'v', bundleDir: '/b', createdAt: '2026-01-01T00:00:00Z', status: 'running' }
    public static readonly Client = { id: 'acme', tenantId: 'acme', clientId: 'pragmatic-tenant-admin', secretRef: 'tenant-admin-oidc/acme', rotatedAt: '2026-01-02T00:00:00.000Z' }
    public static readonly Audit = { id: 'a1', actor: 'acme/ann@acme.test', method: 'contribute', path: 'dev1', status: 200, at: '2026-01-03T00:00:00.000Z' }
    public static readonly Seed = { tenant: { id: 'acme', clientId: 'c', displayName: 'Acme', createdAt: '2026-01-01T00:00:00Z' }, hives: [{ id: 'h1', tenantId: 'acme', displayName: 'H', createdAt: '2026-01-01T00:00:00Z', cluster: {}, registry: {} }] }
    public static readonly Images = [{ imageRef: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@sha256:' + 'a'.repeat(64) }]

    public static async Write(root: string): Promise<void>
    {
        const F = ConsoleDataRootFixture
        const files: [string, unknown][] = [
            ['registry.json', { environments: { dev1: F.Env } }],
            ['tenant-admin-clients.json', { 'tenant-admin-clients': { acme: F.Client } }],
            ['tenant-desktop-audit.json', { audit: { a1: F.Audit } }],
            ['tenant-graph-audit.json', { audit: {} }],
            ['email-domains.json', { domains: ['acme.test'] }],
            ['console-registration.json', { state: 'refused' }],
            ['owner-reset-applied.json', { appliedAt: '2026-01-04T00:00:00.000Z' }],
            ['seed.json', F.Seed],
            ['verified-images.json', F.Images],
            ['tenant-sessions.json', { tokenFormat: 'sha256', sessions: { x: { id: 'x', tenantId: 'acme', principalId: 'p', expiresAt: '2099-01-01T00:00:00Z' } } }],
        ]
        for (const [name, body] of files)
        {
            await writeFile(join(root, name), JSON.stringify(body, null, 2))
        }
    }

    /** Every file of the folder with its bytes. */
    public static async Snapshot(root: string): Promise<Map<string, string>>
    {
        const out = new Map<string, string>()
        for (const name of (await readdir(root)).sort())
        {
            out.set(name, await readFile(join(root, name), 'utf8'))
        }
        return out
    }

    public static Database(): TenantAdminDatabase
    {
        return TenantAdminDatabase.Over(new PgSession(SqlTestSessions.MemPool()))
    }
}

describe('TenantAdminDatabase', () =>
{
    it('refuses to open without PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE (unset or blank), naming the setting', async () =>
    {
        await assert.rejects(TenantAdminDatabase.Open({}), TenantAdminDatabaseMissingError)
        await assert.rejects(TenantAdminDatabase.Open({ PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE: ' ' }), /PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE/)
    })

    it('every registry is a distinct lower-case table name', () =>
    {
        const names = Object.values(TenantAdminRegistry)
        assert.equal(new Set(names).size, names.length)
        assert.ok(names.every(n => /^[a-z][a-z0-9_]{0,47}$/.test(n)))
    })

    SqlTestSessions.Describe('TenantAdminDatabase', (makeSession, backend) =>
    {
        it(`${backend}: opens every store of the console over one session, twice (migrations run once)`, async () =>
        {
            const session = await makeSession()
            for (let round = 0; round < 2; round++)
            {
                const database = TenantAdminDatabase.Over(session)
                for (const registry of Object.values(TenantAdminRegistry))
                {
                    assert.equal(await (await database.Map(registry)).IsEmpty(), true)
                }
                const repositories = await database.SessionRepositories()
                assert.ok(repositories.Sessions && repositories.Tickets && repositories.Throttles)
                assert.deepEqual(await (await database.Audit()).Recent(1), [])
                await (await database.FlowStates()).Take('nothing')
                const secrets = await database.Secrets(Buffer.alloc(32, round + 1))
                assert.equal(await secrets.Get('tenant-admin-oidc/acme'), null)
                assert.deepEqual(await (await database.Configuration()).Components('acme'), [])
                await database.Close()
            }
        })
    })
})

describe('TenantAdminImport', () =>
{
    let root = ''

    beforeEach(async () =>
    {
        root = await mkdtemp(join(tmpdir(), ConsoleDataRootFixture.Prefix))
        await ConsoleDataRootFixture.Write(root)
    })

    afterEach(async () =>
    {
        await rm(root, { recursive: true, force: true })
    })

    it('moves every record into the database under its keys, plus the last delivery; sessions and secrets are not imported', async () =>
    {
        const F = ConsoleDataRootFixture
        const database = F.Database()
        const before = await F.Snapshot(root)
        const report = await new TenantAdminImport(root, database).Run(false)
        assert.deepEqual(report.ToJson().counts, {
            records_console_email_domains: 1, records_console_registration: 1, records_desktop_audit: 1, records_directory_seed: 1, records_environments: 1,
            records_graph_audit: 0, records_owner_reset_applied: 1, records_tenant_admin_clients: 1, records_verified_images: 1,
        })
        assert.equal(report.Skipped.length, 2)
        assert.deepEqual(Object.fromEntries(await (await database.Map(TenantAdminRegistry.Environments)).Load()), { dev1: F.Env })
        assert.deepEqual(Object.fromEntries(await (await database.Map(TenantAdminRegistry.TenantAdminClients)).Load()), { acme: F.Client })
        assert.deepEqual(Object.fromEntries(await (await database.Map(TenantAdminRegistry.DesktopAudit)).Load()), { a1: F.Audit })
        assert.deepEqual(await RecordSlot.Of(await database.Map(TenantAdminRegistry.EmailDomains), ConsoleEmailDomainStore.DomainsKey).Read(), ['acme.test'])
        assert.equal(await RecordSlot.Of(await database.Map(TenantAdminRegistry.Registration), ConsoleRegistration.StateKey).Read(), 'refused')
        assert.equal(await RecordSlot.Of(await database.Map(TenantAdminRegistry.OwnerResetApplied), ConsoleOwnerResetFollower.AppliedKey).Read(), '2026-01-04T00:00:00.000Z')
        assert.deepEqual(await RecordSlot.Of(await database.Map(TenantAdminRegistry.DirectorySeed), ConsoleDelivery.SeedKey).Read(), F.Seed)
        assert.deepEqual(await RecordSlot.Of(await database.Map(TenantAdminRegistry.VerifiedImages), ConsoleDelivery.ImagesKey).Read(), F.Images)
        assert.deepEqual(await F.Snapshot(root), before, 'the data root is only read')
    })

    it('refuses a database that already holds records unless forced; a forced re-run writes the same state', async () =>
    {
        const database = ConsoleDataRootFixture.Database()
        await new TenantAdminImport(root, database).Run(false)
        await assert.rejects(new TenantAdminImport(root, database).Run(false), (e: Error) => e instanceof TenantAdminImportRefusedError && e.message.includes('records_environments'))
        const again = await new TenantAdminImport(root, database).Run(true)
        assert.equal(again.Counts.get('records_environments'), 1)
        assert.equal((await (await database.Map(TenantAdminRegistry.Environments)).Load()).size, 1)
    })

    it('at start: imports a pending data root once, and never over records or without pre-A5 files', async () =>
    {
        const database = ConsoleDataRootFixture.Database()
        const lines: string[] = []
        assert.ok(await TenantAdminImport.ImportIfPending(root, database, line => lines.push(line)) !== undefined)
        assert.equal(lines.length, 1)
        assert.equal(await TenantAdminImport.ImportIfPending(root, database, line => lines.push(line)), undefined)
        const empty = await mkdtemp(join(tmpdir(), ConsoleDataRootFixture.Prefix))
        try
        {
            await writeFile(join(empty, ConsoleDelivery.SeedFile), JSON.stringify(ConsoleDataRootFixture.Seed))
            assert.equal(TenantAdminDataRoot.HoldsRecords(empty), false, 'a delivery alone is no pre-A5 record')
            assert.equal(await TenantAdminImport.ImportIfPending(empty, ConsoleDataRootFixture.Database(), line => lines.push(line)), undefined)
        }
        finally
        {
            await rm(empty, { recursive: true, force: true })
        }
        assert.equal(lines.length, 1)
    })

    it('a failed import is not finished: the next start imports the whole data root again', async () =>
    {
        const database = ConsoleDataRootFixture.Database()
        const audit = join(root, 'tenant-desktop-audit.json')
        const good = await readFile(audit, 'utf8')
        await writeFile(audit, '{ not json')
        await assert.rejects(TenantAdminImport.ImportIfPending(root, database, () => undefined))
        assert.equal(await TenantAdminImport.Finished(database), false, 'a failed import is not a finished one')
        await writeFile(audit, good)
        const report = await TenantAdminImport.ImportIfPending(root, database, () => undefined)
        assert.equal(report?.Counts.get('records_environments'), 1)
        assert.equal(report?.Counts.get('records_desktop_audit'), 1)
    })

    it('the CLI: usage 2, a report on stdout, refused 3 without --force, 0 with it', async () =>
    {
        const database = ConsoleDataRootFixture.Database()
        const out: string[] = []
        const err: string[] = []
        assert.equal(await TenantAdminImportBin.Run([], {}, l => out.push(l), l => err.push(l), database), TenantAdminImportBin.UsageExit)
        assert.equal(await TenantAdminImportBin.Run(['--data-root', root], {}, l => out.push(l), l => err.push(l), database), 0)
        assert.equal((JSON.parse(out[0] as string) as { counts: Record<string, number> }).counts.records_environments, 1)
        assert.equal(await TenantAdminImportBin.Run(['--data-root', root], {}, l => out.push(l), l => err.push(l), database), TenantAdminImportBin.RefusedExit)
        assert.equal(await TenantAdminImportBin.Run(['--data-root', root, '--force'], {}, l => out.push(l), l => err.push(l), database), 0)
        assert.equal(await TenantAdminImportBin.Run(['--data-root', root], {}, l => out.push(l), l => err.push(l)), TenantAdminImportBin.FailedExit, 'no database setting')
    })
})
