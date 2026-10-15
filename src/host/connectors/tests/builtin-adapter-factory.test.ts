import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { DataSourceKind, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import type { ResolvedConnection } from '@pragmatic-tech-ai/todl'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { BuiltinAdapterFactory } from '../builtin-adapter-factory.js'
import { BuiltinStoreEngine } from '../builtin-store-engine.js'
import { StorageDocumentSession } from '../storage-document-session.js'
import { SqliteDocumentSession } from '../sqlite-document-session.js'
import { NodePlatform } from '../../../platform/node-platform.js'
import { CloudPlatform } from '../../../platform/cloud-platform.js'

class BuiltinFixture
{
    private static readonly Prefix = 'builtin-factory-'
    private static readonly Source = 'Customer'
    private static readonly IdKey = 'id'
    private static readonly MasterRef = 'cluster/master-key'
    private static readonly CloudMessage = /built-in store is not available on the cloud platform/

    public static async RoundTrip(engine: BuiltinStoreEngine): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), BuiltinFixture.Prefix))
        try
        {
            const factory = new BuiltinAdapterFactory((root, eng) => new NodePlatform().CreateAppDataStore(root, eng))
            const connection: ResolvedConnection = { Kind: DataSourceKind.Builtin, Config: { [BuiltinAdapterFactory.DataRootKey]: dir, [BuiltinAdapterFactory.EngineKey]: engine } }
            assert.equal(factory.Kind, DataSourceKind.Builtin)
            const adapter = await factory.Open(connection)
            const result = await adapter.Apply({
                Source: BuiltinFixture.Source,
                IdKey: BuiltinFixture.IdKey,
                Operations: [{ Kind: WriteOperationKind.Upsert, Key: 'c1', Fields: { name: 'Ada' } }]
            })
            assert.equal(result.Applied, 1)
            const rows = await adapter.Query({ Source: BuiltinFixture.Source, Fields: [BuiltinFixture.IdKey, 'name'] })
            assert.equal(rows.length, 1)
            assert.equal(rows[0]['name'], 'Ada')
            assert.equal(rows[0][BuiltinFixture.IdKey], 'c1')
            await adapter.Dispose()
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static Sessions(): void
    {
        const dir = mkdtempSync(join(tmpdir(), BuiltinFixture.Prefix))
        try
        {
            const platform = new NodePlatform()
            assert.ok(platform.CreateAppDataStore(dir, BuiltinStoreEngine.Document) instanceof StorageDocumentSession)
            const sqlite = platform.CreateAppDataStore(dir, BuiltinStoreEngine.Sqlite)
            assert.ok(sqlite instanceof SqliteDocumentSession)
            void sqlite.Dispose?.()
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static async CloudThrows(): Promise<void>
    {
        const pg = newDb().adapters.createPg()
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put(BuiltinFixture.MasterRef, Buffer.alloc(32, 1).toString('base64'))
        const platform = await CloudPlatform.Create({ session: new PgSession(new pg.Pool() as unknown as Pool), storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: BuiltinFixture.MasterRef })
        assert.throws(() => platform.CreateAppDataStore('x', BuiltinStoreEngine.Document), BuiltinFixture.CloudMessage)
    }
}

test('factory over document engine round-trips', () => BuiltinFixture.RoundTrip(BuiltinStoreEngine.Document))
test('factory over sqlite engine round-trips', () => BuiltinFixture.RoundTrip(BuiltinStoreEngine.Sqlite))
test('NodePlatform builds the engine-specific session', () => BuiltinFixture.Sessions())
test('CloudPlatform has no built-in store', () => BuiltinFixture.CloudThrows())
