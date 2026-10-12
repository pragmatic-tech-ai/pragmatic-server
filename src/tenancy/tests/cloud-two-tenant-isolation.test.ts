import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { CloudPlatform } from '../../platform/cloud-platform.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { TenantRegistry, InMemoryTenantProvisioning } from '../tenant-registry.js'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'
import type { PragmaticServer } from '../../pragmatic-server.js'
import type { TenantProvisioning } from '../tenant-provisioning.js'

class TwoTenantFixture
{
    private static readonly TenantOneId = 't1'
    private static readonly TenantTwoId = 't2'
    private static readonly Admin1Id = 'admin1'
    private static readonly Admin2Id = 'admin2'
    private static readonly MasterKeyRef = 'cluster/master-key'
    private static readonly UnusedEnv = 'PS_CLOUD_UNUSED'
    private static readonly TempPrefix = 'ps-cloud2t-'
    private static readonly Admin1Email = 'admin1@x.io'
    private static readonly Admin2Email = 'admin2@x.io'
    private static readonly Admin1Ref = 't1/bootstrap/admin'
    private static readonly Admin2Ref = 't2/bootstrap/admin'
    private static readonly Admin1Pw = 'pw-t1-123456'
    private static readonly Admin2Pw = 'pw-t2-123456'

    public static async Platform(): Promise<CloudPlatform>
    {
        const db = newDb()
        const pg = db.adapters.createPg()
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put(TwoTenantFixture.MasterKeyRef, Buffer.alloc(32, 3).toString('base64'))
        return CloudPlatform.Create({ session: new PgSession(new pg.Pool() as unknown as Pool), storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: TwoTenantFixture.MasterKeyRef })
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>([
            [TwoTenantFixture.TenantOneId, { displayName: 'Tenant One', bootstrap: { adminEmail: TwoTenantFixture.Admin1Email, adminPrincipalId: TwoTenantFixture.Admin1Id, adminPasswordRef: TwoTenantFixture.Admin1Ref, ownerGrant: true } }],
            [TwoTenantFixture.TenantTwoId, { displayName: 'Tenant Two', bootstrap: { adminEmail: TwoTenantFixture.Admin2Email, adminPrincipalId: TwoTenantFixture.Admin2Id, adminPasswordRef: TwoTenantFixture.Admin2Ref, ownerGrant: true } }],
        ])
        return new InMemoryTenantProvisioning(entries)
    }

    public static async SeedAndAuth(server: PragmaticServer, email: string, ref: string, pw: string)
    {
        const pack = await server.Pack()
        await pack.Secrets.Put(ref, pw)
        await server.SeedBootstrapForTest()
        return pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, email), new PresentedSecret(pw), server.Tenant())
    }

    public static async Run(): Promise<void>
    {
        const baseDir = mkdtempSync(join(tmpdir(), TwoTenantFixture.TempPrefix))
        const platform = await TwoTenantFixture.Platform()
        const registry = new TenantRegistry(baseDir, { base64Env: TwoTenantFixture.UnusedEnv }, TwoTenantFixture.Provisioning(), new InMemoryTenantCoordinator(), platform, DeploymentMode.Cloud)
        try
        {
            const s1 = await registry.ServerFor(TwoTenantFixture.TenantOneId)
            const s2 = await registry.ServerFor(TwoTenantFixture.TenantTwoId)
            assert.ok((await TwoTenantFixture.SeedAndAuth(s1, TwoTenantFixture.Admin1Email, TwoTenantFixture.Admin1Ref, TwoTenantFixture.Admin1Pw)) instanceof AuthenticatedResult)
            assert.ok((await TwoTenantFixture.SeedAndAuth(s2, TwoTenantFixture.Admin2Email, TwoTenantFixture.Admin2Ref, TwoTenantFixture.Admin2Pw)) instanceof AuthenticatedResult)
            const pack1 = await s1.Pack()
            const cross = await pack1.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, TwoTenantFixture.Admin2Email), new PresentedSecret(TwoTenantFixture.Admin2Pw), s1.Tenant())
            assert.ok(!(cross instanceof AuthenticatedResult))
            const pack2 = await s2.Pack()
            assert.equal(await pack1.Directory.Lookup(TwoTenantFixture.Admin2Id, s1.Tenant()), null)
            assert.notEqual(await pack2.Directory.Lookup(TwoTenantFixture.Admin2Id, s2.Tenant()), null)
            assert.equal(await pack2.Directory.Lookup(TwoTenantFixture.Admin1Id, s2.Tenant()), null)
            assert.notEqual(await pack1.Directory.Lookup(TwoTenantFixture.Admin1Id, s1.Tenant()), null)
            assert.equal(await pack1.Secrets.Get(TwoTenantFixture.Admin2Ref), null)
            assert.equal(await pack1.Secrets.Get(TwoTenantFixture.Admin1Ref), TwoTenantFixture.Admin1Pw)
            assert.equal(await pack2.Secrets.Get(TwoTenantFixture.Admin1Ref), null)
        }
        finally
        {
            await registry.DisposeAll()
            rmSync(baseDir, { recursive: true, force: true })
        }
    }
}

test('two cloud tenants over one DB + object store authenticate independently and stay isolated', async () =>
{
    await TwoTenantFixture.Run()
})
