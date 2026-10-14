import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { AuditEvent, AuditEventKind } from '@pragmatic-tech-ai/todl-identity'
import { AuditTamperDetected } from '@pragmatic-tech-ai/todl-identity-host'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { CloudPlatform } from '../cloud-platform.js'

/** Reopen over an already-provisioned pg-mem db: pg-mem rejects a repeated constrained CREATE TABLE, so the
 *  reopen session skips CREATE TABLE statements (the tables already exist) and passes everything else through. */
class ReopenSession implements ISqlSession
{
    private static readonly CreateTablePrefix = 'CREATE TABLE'

    private readonly inner: ISqlSession

    public constructor(inner: ISqlSession)
    {
        this.inner = inner
    }

    public Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        return this.inner.Query(sql, params)
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        if (sql.trimStart().toUpperCase().startsWith(ReopenSession.CreateTablePrefix))
        {
            return 0
        }
        return this.inner.Execute(sql, params)
    }
}

class AnchoringFixture
{
    public static readonly MasterRef = 'cluster/master-key'
    public static readonly AnchorRef = 'cluster/anchor-key'

    public static async SecretManager(withAnchor: boolean): Promise<CloudSecretManagerSecretStore>
    {
        const sm = new CloudSecretManagerSecretStore()
        await sm.Put(AnchoringFixture.MasterRef, Buffer.alloc(32, 7).toString('base64'))
        if (withAnchor)
        {
            await sm.Put(AnchoringFixture.AnchorRef, 'anchor-secret-key-material')
        }
        return sm
    }

    public static Session(): PgSession
    {
        const db = newDb()
        const pg = db.adapters.createPg()
        return new PgSession(new pg.Pool() as unknown as Pool)
    }

    public static Event(tenant: string, action: string): AuditEvent
    {
        return new AuditEvent(AuditEventKind.AdminAction, tenant, 'p1', new Date('2026-01-01T00:00:00Z'), new Map([['action', action]]))
    }
}

test('anchoring on: audit records are checkpointed into identity_audit_anchor', async () =>
{
    const session = AnchoringFixture.Session()
    const secretManager = await AnchoringFixture.SecretManager(true)
    const platform = await CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef, auditAnchorKeyRef: AnchoringFixture.AnchorRef })
    const audit = await platform.AuditSink()
    await audit.Record(AnchoringFixture.Event('t1', 'a'))
    await audit.Record(AnchoringFixture.Event('t2', 'x'))
    const rows = await session.Query('SELECT tenant_id, seq FROM identity_audit_anchor ORDER BY tenant_id, seq', [])
    assert.equal(rows.length, 2)
})

test('anchoring on: a tail DELETE is detected fail-closed when a fresh platform reopens the store', async () =>
{
    const session = AnchoringFixture.Session()
    const secretManager = await AnchoringFixture.SecretManager(true)
    const first = await CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef, auditAnchorKeyRef: AnchoringFixture.AnchorRef })
    const audit = await first.AuditSink()
    await audit.Record(AnchoringFixture.Event('t1', 'a'))
    await audit.Record(AnchoringFixture.Event('t1', 'b'))
    await audit.Record(AnchoringFixture.Event('t1', 'c'))
    await session.Execute('DELETE FROM identity_audit WHERE tenant_id = $1 AND seq >= $2', ['t1', 2])
    const second = await CloudPlatform.Create({ session: new ReopenSession(session), storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef, auditAnchorKeyRef: AnchoringFixture.AnchorRef })
    await assert.rejects(() => second.AuditSink(), AuditTamperDetected)
})

test('anchor key ref set but secret absent: Create rejects without leaking', async () =>
{
    const session = AnchoringFixture.Session()
    const secretManager = await AnchoringFixture.SecretManager(false)
    await secretManager.Put('cluster/unrelated', 'anchor-secret-key-material')
    await assert.rejects(() => CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef, auditAnchorKeyRef: AnchoringFixture.AnchorRef }), (e) =>
    {
        assert.ok(e instanceof Error)
        assert.ok(!e.message.includes('anchor-secret-key-material'))
        return /anchor/i.test(e.message)
    })
})

test('anchoring off: no identity_audit_anchor table is created', async () =>
{
    const session = AnchoringFixture.Session()
    const secretManager = await AnchoringFixture.SecretManager(false)
    const platform = await CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef })
    const audit = await platform.AuditSink()
    await audit.Record(AnchoringFixture.Event('t1', 'a'))
    await assert.rejects(() => session.Query('SELECT * FROM identity_audit_anchor', []), /does not exist/)
})

test('anchor key ref set but secret is empty: Create rejects', async () =>
{
    const session = AnchoringFixture.Session()
    const secretManager = await AnchoringFixture.SecretManager(false)
    await secretManager.Put(AnchoringFixture.AnchorRef, '')
    await assert.rejects(() => CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef, auditAnchorKeyRef: AnchoringFixture.AnchorRef }), /anchor/i)
})
