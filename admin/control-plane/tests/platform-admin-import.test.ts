import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { PlatformAdminDatabase, PlatformAdminRegistry } from '../platform-admin-database.js'
import { PlatformAdminImport, PlatformAdminImportPendingError, PlatformAdminImportRefusedError } from '../platform-admin-import.js'
import { OperatorIdentity, OperatorRole } from '../operator-identity.js'
import { OperatorSessions } from '../operator-sessions.js'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { SqlSignatureStore } from '../sql-signature-store.js'

/** The importer's fixture: a copy of the pre-A5 data root layout (generated once with the pre-A5 OperatorIdentity and
 *  SealedSecretStore), its master key, and the golden dump of the database it imports into. */
class ImportFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly DataRoot = join(ImportFixture.Here, 'fixtures', 'platform-admin-data-root')
    public static readonly Golden = join(ImportFixture.Here, 'fixtures', 'platform-admin-import.golden.json')
    public static readonly MasterKeyFile = 'master.key'
    public static readonly AdminEmail = 'ops@pragmatic.test'
    public static readonly AdminPassword = 'fixture-admin-password-1'
    public static readonly ViewerEmail = 'viewer@pragmatic.test'
    public static readonly ViewerPassword = 'fixture-viewer-password'
    public static readonly GoneEmail = 'gone@pragmatic.test'
    public static readonly GonePassword = 'fixture-gone-password-1'
    public static readonly UpdateEnvVar = 'PRAGMATIC_UPDATE_GOLDEN'
    public static readonly TempPrefix = 'padmin-import-'
    public static readonly Utf8 = 'utf8'

    public static MasterKey(): Buffer
    {
        return readFileSync(join(ImportFixture.DataRoot, ImportFixture.MasterKeyFile))
    }

    /** A private copy of the fixture data root (the importer must not write it; the test proves that on the copy). */
    public static CopyDataRoot(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ImportFixture.TempPrefix))
        cpSync(ImportFixture.DataRoot, dir, { recursive: true })
        return dir
    }

    /** Every file under `root` with its content digest. */
    public static Digests(root: string): Record<string, string>
    {
        const out: Record<string, string> = {}
        const walk = (dir: string): void =>
        {
            for (const name of readdirSync(dir))
            {
                const path = join(dir, name)
                if (statSync(path).isDirectory())
                {
                    walk(path)
                }
                else
                {
                    out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
                }
            }
        }
        walk(root)
        return out
    }

    /** What the database holds after an import, without volatile columns (versions, write times) or ciphertexts. */
    public static async Dump(session: ISqlSession, database: PlatformAdminDatabase): Promise<unknown>
    {
        const registries: Record<string, Record<string, unknown>> = {}
        for (const registry of Object.values(PlatformAdminRegistry))
        {
            const map = await database.Map<unknown>(registry)
            registries[registry] = Object.fromEntries([...(await map.Load())].sort(([a], [b]) => a.localeCompare(b)))
        }
        const audit = (await (await database.Audit()).Recent(1000)).map(e => ({ id: e.Id, actor: e.Actor, action: e.Action, target: e.Target, status: e.Status, at: e.At.toISOString(), note: e.Note ?? null }))
            .sort((a, b) => a.id.localeCompare(b.id))
        const stores = await OperatorIdentity.OpenStores(session, ImportFixture.MasterKey())
        const realm = OperatorIdentity.Realm()
        const accounts = [...await stores.Accounts.ListAccounts(realm)].sort((a, b) => a.Email.localeCompare(b.Email))
        const grants: Record<string, unknown> = {}
        for (const principal of [...new Set([OperatorIdentity.BootstrapPrincipalId, ...accounts.map(a => a.PrincipalId)])].sort())
        {
            grants[principal] = (await stores.Grants.GrantsFor(principal, realm)).map(g => JSON.parse(JSON.stringify(g)) as unknown)
        }
        return {
            registries,
            audit,
            identity: { accounts: accounts.map(a => ({ email: a.Email, principalId: a.PrincipalId, secretRef: a.SecretRef, disabled: a.Disabled })), grants },
        }
    }

    public static CheckGolden(actual: unknown): void
    {
        const text = JSON.stringify(actual, null, 2) + '\n'
        if (process.env[ImportFixture.UpdateEnvVar] === '1')
        {
            writeFileSync(ImportFixture.Golden, text)
        }
        assert.ok(existsSync(ImportFixture.Golden), 'golden written')
        assert.deepEqual(JSON.parse(text), JSON.parse(readFileSync(ImportFixture.Golden, ImportFixture.Utf8)))
    }
}

describe('PlatformAdminImport', () =>
{
    const F = ImportFixture

    SqlTestSessions.Describe('PlatformAdminImport', (makeSession, backend) =>
    {
        it(`${backend}: imports the data root into the database (golden), leaving every file as it was`, async () =>
        {
            const root = F.CopyDataRoot()
            try
            {
                const before = F.Digests(root)
                const session = await makeSession()
                const database = PlatformAdminDatabase.Over(session)
                const report = await new PlatformAdminImport(root, database, F.MasterKey()).Run(false)
                assert.deepEqual(F.Digests(root), before, 'the data root is read, never written')
                assert.equal(report.Counts.get('records_clients'), 2)
                assert.equal(report.Counts.get('app_host_audit'), 3)
                assert.equal(report.Counts.get('identity.accounts'), 4)
                F.CheckGolden(await F.Dump(session, database))
            }
            finally
            {
                rmSync(root, { recursive: true, force: true })
            }
        })

        it(`${backend}: the imported console works: operators sign in with their passwords, sealed secrets and signatures read back`, async () =>
        {
            const session = await makeSession()
            const database = PlatformAdminDatabase.Over(session)
            await new PlatformAdminImport(F.DataRoot, database, F.MasterKey()).Run(false)
            const root = mkdtempSync(join(tmpdir(), F.TempPrefix))
            try
            {
                const keyFile = join(root, F.MasterKeyFile)
                writeFileSync(keyFile, F.MasterKey())
                const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
                // No initial password: the imported bootstrap administrator exists, so none is needed.
                const operator = await OperatorIdentity.Compose({ session, masterKeyFile: keyFile, operatorEmail: F.AdminEmail, sessions: sessions.Store })
                assert.equal((await operator.Verify(F.AdminEmail, F.AdminPassword))?.role, OperatorRole.Full)
                assert.equal((await operator.Verify(F.ViewerEmail, F.ViewerPassword))?.role, OperatorRole.ReadOnly)
                assert.equal(await operator.Verify(F.ViewerEmail, F.AdminPassword), null)
                assert.equal(await operator.Verify(F.GoneEmail, F.GonePassword), null, 'a disabled operator stays disabled')
                const sealed = await SealedSecretStore.Open(await database.Map(PlatformAdminRegistry.SealedSecrets), F.MasterKey())
                assert.equal((await sealed.Get('console-fingerprint/acme-hive'))?.toString(), 'fingerprint-key-bytes')
                assert.equal((await sealed.Get('dev-ca/acme-main/key'))?.toString(), 'dev-ca-private-key-bytes')
                const signatures = await SqlSignatureStore.Open(session)
                assert.equal(await signatures.Get('sha256:keyed', 'acme'), 'YWNtZS1zaWc=')
                assert.equal(await signatures.Get('sha256:legacy', 'platform-signing'), 'bGVnYWN5LXNpZw==')
                assert.equal(await signatures.HasKeyed('sha256:legacy', 'platform-signing'), false)
            }
            finally
            {
                rmSync(root, { recursive: true, force: true })
            }
        })

        it(`${backend}: refuses a database that already holds records, unless forced; a forced re-run writes the same state`, async () =>
        {
            const session = await makeSession()
            const database = PlatformAdminDatabase.Over(session)
            await new PlatformAdminImport(F.DataRoot, database, F.MasterKey()).Run(false)
            const first = await F.Dump(session, database)
            await assert.rejects(new PlatformAdminImport(F.DataRoot, database, F.MasterKey()).Run(false), (err: unknown) =>
                err instanceof PlatformAdminImportRefusedError && err.NonEmpty.includes('records_clients') && err.NonEmpty.includes('app_host_audit') && err.NonEmpty.includes('identity.accounts'))
            await new PlatformAdminImport(F.DataRoot, database, F.MasterKey()).Run(true)
            assert.deepEqual(await F.Dump(session, database), first)
        })

        it(`${backend}: the console refuses to start over an empty database while the data root holds records, and starts once imported`, async () =>
        {
            const session = await makeSession()
            const database = PlatformAdminDatabase.Over(session)
            await assert.rejects(PlatformAdminImport.RequireImported(F.DataRoot, database), PlatformAdminImportPendingError)
            const empty = mkdtempSync(join(tmpdir(), F.TempPrefix))
            try
            {
                await PlatformAdminImport.RequireImported(empty, database)
            }
            finally
            {
                rmSync(empty, { recursive: true, force: true })
            }
            await new PlatformAdminImport(F.DataRoot, database, F.MasterKey()).Run(false)
            await PlatformAdminImport.RequireImported(F.DataRoot, database)
        })

        it(`${backend}: an empty data root imports nothing and leaves the database empty`, async () =>
        {
            const root = mkdtempSync(join(tmpdir(), F.TempPrefix))
            try
            {
                const session = await makeSession()
                const database = PlatformAdminDatabase.Over(session)
                const report = await new PlatformAdminImport(root, database, F.MasterKey()).Run(false)
                assert.ok([...report.Counts.values()].every(n => n === 0))
                for (const registry of Object.values(PlatformAdminRegistry))
                {
                    assert.equal(await (await database.Map(registry)).IsEmpty(), true, registry)
                }
                assert.deepEqual(readdirSync(root), [], 'nothing is created in the data root')
            }
            finally
            {
                rmSync(root, { recursive: true, force: true })
            }
        })
    })
})
