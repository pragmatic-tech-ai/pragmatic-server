import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import { AuditEvent, AuditEventKind } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import type { ICloudBackends } from '../cloud-bundle.js'
import { GcpPlatformFactory } from '../gcp-platform-factory.js'
import { AwsPlatformFactory } from '../aws-platform-factory.js'
import { AzurePlatformFactory } from '../azure-platform-factory.js'

class FactoryFixture
{
    public static readonly Factories = [
        ['gcp', GcpPlatformFactory],
        ['aws', AwsPlatformFactory],
        ['azure', AzurePlatformFactory],
    ] as const

    public static async Backends(): Promise<ICloudBackends>
    {
        const db = newDb()
        const pg = db.adapters.createPg()
        const session = new PgSession(new pg.Pool() as unknown as Pool)
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put('m', Buffer.alloc(32, 7).toString('base64'))
        await secretManager.Put('a', 'anchor-secret-key-material')
        return { Session: session, Storage: new ObjectStoreProviderRegistry(), SecretManager: secretManager, Dispose: () => Promise.resolve() }
    }
}

for (const [name, factory] of FactoryFixture.Factories)
{
    test(`${name}: CreateWith forwards the anchor key ref so the audit store is anchored`, async () =>
    {
        const backends = await FactoryFixture.Backends()
        const bundle = await factory.CreateWith(backends, 'm', 'a', 1)
        const audit = await bundle.Platform.AuditSink()
        await audit.Record(new AuditEvent(AuditEventKind.AdminAction, 't1', 'p1', new Date('2026-01-01T00:00:00Z'), new Map([['action', 'a']])))
        const rows = await backends.Session.Query('SELECT seq FROM identity_audit_anchor WHERE tenant_id = $1', ['t1'])
        assert.ok(rows.length >= 1)
    })

    test(`${name}: CreateWith without an anchor ref leaves the store unanchored (no table)`, async () =>
    {
        const backends = await FactoryFixture.Backends()
        const bundle = await factory.CreateWith(backends, 'm')
        const audit = await bundle.Platform.AuditSink()
        await audit.Record(new AuditEvent(AuditEventKind.AdminAction, 't1', 'p1', new Date('2026-01-01T00:00:00Z'), new Map([['action', 'a']])))
        await assert.rejects(() => backends.Session.Query('SELECT * FROM identity_audit_anchor', []), /does not exist/)
    })
}
