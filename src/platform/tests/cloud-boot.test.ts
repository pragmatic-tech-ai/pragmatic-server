import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AuthMethod, Role, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/pragmatic-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { CloudPlatform } from '../cloud-platform.js'
import { DeploymentMode } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { PragmaticServer } from '../../pragmatic-server.js'

class CloudServerFixture
{
    public static async Platform(key: number): Promise<CloudPlatform>
    {
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put('cluster/master-key', Buffer.alloc(32, key).toString('base64'))
        return CloudPlatform.Create({ session: new PgSession(SqlTestSessions.MemPool()), storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: 'cluster/master-key' })
    }

    public static Options(platform: CloudPlatform, environmentId: string)
    {
        return {
            packagesRoot: `environments/${environmentId}/packages`,
            deploymentMode: DeploymentMode.Cloud,
            platform,
            identity: {
                identityRoot: `environments/${environmentId}/identity`,
                masterKey: { base64Env: 'UNUSED_CLOUD_KEY' },
                environment: { id: environmentId, displayName: 'Cloud Environment' },
                bootstrap: { adminEmail: 'admin@x.io', adminPrincipalId: 'admin', adminPasswordRef: `${environmentId}/bootstrap/admin`, ownerGrant: true },
            },
        }
    }
}

test('a PragmaticServer boots on DeploymentMode.Cloud and authenticates a seeded Owner admin', async () =>
{
    const platform = await CloudServerFixture.Platform(9)
    const environmentId = `cloud-${randomUUID()}`
    const options = CloudServerFixture.Options(platform, environmentId)
    const server = new PragmaticServer(options)
    try
    {
        await server.Start()
        const pack = await server.Pack()
        await pack.Secrets.Put(options.identity.bootstrap.adminPasswordRef, 'admin-pw-12345')
        await server.SeedBootstrapForTest()
        const result = await pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, 'admin@x.io'), new PresentedSecret('admin-pw-12345'), server.Realm())
        assert.ok(result instanceof AuthenticatedResult)
        const grants = await pack.Grants.GrantsFor('admin', server.Realm())
        assert.ok(grants.some(grant => grant.Role === Role.Owner))
    }
    finally
    {
        await server.Dispose()
    }
})

test('cloud boot denies an unknown account (deny-by-default)', async () =>
{
    const platform = await CloudServerFixture.Platform(5)
    const environmentId = `cloud-${randomUUID()}`
    const server = new PragmaticServer(CloudServerFixture.Options(platform, environmentId))
    try
    {
        await server.Start()
        const pack = await server.Pack()
        const result = await pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, 'ghost@x.io'), new PresentedSecret('whatever-123'), server.Realm())
        assert.ok(!(result instanceof AuthenticatedResult))
    }
    finally
    {
        await server.Dispose()
    }
})
