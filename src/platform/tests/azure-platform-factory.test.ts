import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { AzurePlatformFactory } from '../azure-platform-factory.js'
import type { ICloudBackends } from '../cloud-bundle.js'
import { CloudPlatform } from '../cloud-platform.js'
import { DeploymentMode } from '../deployment-mode.js'
import { DeploymentProvider } from '../deployment-provider.js'
import type { ServerConfig } from '../../config/server-config.js'

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

class AzureConfigs
{
    public static Complete(overrides: Partial<ServerConfig> = {}): ServerConfig
    {
        return {
            host: '127.0.0.1',
            port: 0,
            baseDir: 'unused',
            masterKey: { base64Env: 'PS_CLOUD_UNUSED' },
            deploymentMode: DeploymentMode.Cloud,
            cloudProvider: DeploymentProvider.Azure,
            blobAccount: 'testacct',
            blobContainer: 'test-container',
            keyVaultUrl: 'https://test.vault.azure.net',
            azpgHost: 'db.postgres.database.azure.com',
            azpgUser: 'test-user',
            azpgDatabase: 'test-db',
            cloudMasterKeyRef: 'cluster/master-key',
            ...overrides,
        }
    }
}

test('Create throws when the cloud master key ref is absent', async () =>
{
    await assert.rejects(() => AzurePlatformFactory.Create(AzureConfigs.Complete({ cloudMasterKeyRef: undefined })), /PRAGMATIC_CLOUD_MASTER_KEY_REF is required/)
})

test('Create throws when an Azure config field is absent', async () =>
{
    await assert.rejects(() => AzurePlatformFactory.Create(AzureConfigs.Complete({ blobAccount: undefined })), /requires complete Azure configuration/)
})

test('CreateWith builds a CloudPlatform and Dispose tears the backends down exactly once', async () =>
{
    const backends = new FakeBackends()
    await backends.SecretManager.Put('cluster/master-key', Buffer.alloc(32, 7).toString('base64'))
    const bundle = await AzurePlatformFactory.CreateWith(backends, 'cluster/master-key')
    assert.ok(bundle.Platform instanceof CloudPlatform)
    assert.equal(backends.DisposeCount, 0)
    await bundle.Dispose()
    assert.equal(backends.DisposeCount, 1)
})

test('CreateWith disposes the backends once and rethrows the original error when platform construction fails', async () =>
{
    const backends = new FakeBackends()
    const secret = Buffer.alloc(32, 7).toString('base64')
    await backends.SecretManager.Put('cluster/other-key', secret)
    let thrown: unknown
    try
    {
        await AzurePlatformFactory.CreateWith(backends, 'absent')
    }
    catch (error)
    {
        thrown = error
    }
    assert.ok(thrown instanceof Error)
    assert.ok(!thrown.message.includes(secret))
    assert.equal(backends.DisposeCount, 1)
})
