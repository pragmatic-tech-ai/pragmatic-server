import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { AwsPlatformFactory } from '../aws-platform-factory.js'
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

class AwsConfigs
{
    public static Complete(overrides: Partial<ServerConfig> = {}): ServerConfig
    {
        return {
            host: '127.0.0.1',
            port: 0,
            baseDir: 'unused',
            masterKey: { base64Env: 'PS_CLOUD_UNUSED' },
            deploymentMode: DeploymentMode.Cloud,
            cloudProvider: DeploymentProvider.Aws,
            awsRegion: 'us-east-1',
            s3Bucket: 'test-bucket',
            rdsHost: 'db.test',
            rdsUser: 'test-user',
            rdsDatabase: 'test-db',
            cloudMasterKeyRef: 'cluster/master-key',
            ...overrides,
        }
    }
}

test('Create throws when the cloud master key ref is absent', async () =>
{
    await assert.rejects(() => AwsPlatformFactory.Create(AwsConfigs.Complete({ cloudMasterKeyRef: undefined })), /PRAGMATIC_CLOUD_MASTER_KEY_REF is required/)
})

test('Create throws when an AWS config field is absent', async () =>
{
    await assert.rejects(() => AwsPlatformFactory.Create(AwsConfigs.Complete({ s3Bucket: undefined })), /requires complete AWS configuration/)
})

test('CreateWith builds a CloudPlatform and Dispose tears the backends down exactly once', async () =>
{
    const backends = new FakeBackends()
    await backends.SecretManager.Put('cluster/master-key', Buffer.alloc(32, 7).toString('base64'))
    const bundle = await AwsPlatformFactory.CreateWith(backends, 'cluster/master-key')
    assert.ok(bundle.Platform instanceof CloudPlatform)
    assert.equal(backends.DisposeCount, 0)
    await bundle.Dispose()
    assert.equal(backends.DisposeCount, 1)
})

test('CreateWith disposes the backends once and rethrows the original error when platform construction fails', async () =>
{
    const backends = new FakeBackends()
    await assert.rejects(() => AwsPlatformFactory.CreateWith(backends, 'absent'), Error)
    assert.equal(backends.DisposeCount, 1)
})
