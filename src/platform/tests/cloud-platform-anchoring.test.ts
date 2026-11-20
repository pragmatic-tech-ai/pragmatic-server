import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AuditEvent, AuditEventKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { AuditTamperDetected } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { CloudPlatform } from '../cloud-platform.js'

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
        return new PgSession(SqlTestSessions.MemPool())
    }

    public static Event(environment: string, action: string): AuditEvent
    {
        return new AuditEvent(AuditEventKind.AdminAction, environment, 'p1', new Date('2026-01-01T00:00:00Z'), new Map([['action', action]]))
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
    const rows = await session.Query('SELECT realm_id, seq FROM identity_audit_anchor ORDER BY realm_id, seq', [])
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
    await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1 AND seq >= $2', ['t1', 2])
    const second = await CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: AnchoringFixture.MasterRef, auditAnchorKeyRef: AnchoringFixture.AnchorRef })
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
