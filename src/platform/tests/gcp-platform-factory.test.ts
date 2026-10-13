import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { GcpPlatformFactory } from '../gcp-platform-factory.js'
import type { ICloudBackends } from '../gcp-platform-factory.js'
import { CloudPlatform } from '../cloud-platform.js'

class FakeBackends implements ICloudBackends
{
    public DisposeCount = 0
    public readonly Storage = new ObjectStoreProviderRegistry()
    public readonly SecretManager = new CloudSecretManagerSecretStore()
    public readonly Session: PgSession

    public constructor()
    {
        const pg = newDb().adapters.createPg()
        this.Session = new PgSession(new pg.Pool() as unknown as Pool)
    }

    public async Dispose(): Promise<void>
    {
        this.DisposeCount++
    }
}

test('CreateWith builds a CloudPlatform and Dispose tears the backends down exactly once', async () =>
{
    const backends = new FakeBackends()
    await backends.SecretManager.Put('cluster/master-key', Buffer.alloc(32, 7).toString('base64'))
    const bundle = await GcpPlatformFactory.CreateWith(backends, 'cluster/master-key')
    assert.ok(bundle.Platform instanceof CloudPlatform)
    assert.equal(bundle.Platform.ResolveMasterKey({ keyFilePath: 'ignored' })[0], 7)
    assert.equal(backends.DisposeCount, 0)
    await bundle.Dispose()
    assert.equal(backends.DisposeCount, 1)
})

test('CreateWith disposes the backends and rethrows when the master key is absent', async () =>
{
    const backends = new FakeBackends()
    await assert.rejects(() => GcpPlatformFactory.CreateWith(backends, 'absent'))
    assert.equal(backends.DisposeCount, 1)
})
