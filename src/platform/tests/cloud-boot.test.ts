import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { AuthMethod, Role, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { CloudPlatform } from '../cloud-platform.js'
import { DeploymentMode } from '../deployment-mode.js'
import { PragmaticServer } from '../../pragmatic-server.js'

class CloudServerFixture
{
    public static async Platform(key: number): Promise<CloudPlatform>
    {
        const db = newDb()
        const pg = db.adapters.createPg()
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put('cluster/master-key', Buffer.alloc(32, key).toString('base64'))
        return CloudPlatform.Create({ session: new PgSession(new pg.Pool() as unknown as Pool), storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: 'cluster/master-key' })
    }

    public static Options(platform: CloudPlatform, tenantId: string)
    {
        return {
            packagesRoot: `tenants/${tenantId}/packages`,
            deploymentMode: DeploymentMode.Cloud,
            platform,
            identity: {
                identityRoot: `tenants/${tenantId}/identity`,
                masterKey: { base64Env: 'UNUSED_CLOUD_KEY' },
                tenant: { id: tenantId, displayName: 'Cloud Tenant' },
                bootstrap: { adminEmail: 'admin@x.io', adminPrincipalId: 'admin', adminPasswordRef: `${tenantId}/bootstrap/admin`, ownerGrant: true },
            },
        }
    }
}

test('a PragmaticServer boots on DeploymentMode.Cloud and authenticates a seeded Owner admin', async () =>
{
    const platform = await CloudServerFixture.Platform(9)
    const tenantId = `cloud-${randomUUID()}`
    const options = CloudServerFixture.Options(platform, tenantId)
    const server = new PragmaticServer(options)
    try
    {
        await server.Start()
        const pack = await server.Pack()
        await pack.Secrets.Put(options.identity.bootstrap.adminPasswordRef, 'admin-pw-12345')
        await server.SeedBootstrapForTest()
        const result = await pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, 'admin@x.io'), new PresentedSecret('admin-pw-12345'), server.Tenant())
        assert.ok(result instanceof AuthenticatedResult)
        const grants = await pack.Grants.GrantsFor('admin', server.Tenant())
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
    const tenantId = `cloud-${randomUUID()}`
    const server = new PragmaticServer(CloudServerFixture.Options(platform, tenantId))
    try
    {
        await server.Start()
        const pack = await server.Pack()
        const result = await pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, 'ghost@x.io'), new PresentedSecret('whatever-123'), server.Tenant())
        assert.ok(!(result instanceof AuthenticatedResult))
    }
    finally
    {
        await server.Dispose()
    }
})
