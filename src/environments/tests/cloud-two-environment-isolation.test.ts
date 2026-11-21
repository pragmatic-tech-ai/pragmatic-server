import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/pragmatic-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { CloudPlatform } from '../../platform/cloud-platform.js'
import { DeploymentMode } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import type { PragmaticServer } from '../../pragmatic-server.js'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'

class TwoEnvironmentFixture
{
    private static readonly EnvironmentOneId = 't1'
    private static readonly EnvironmentTwoId = 't2'
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
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put(TwoEnvironmentFixture.MasterKeyRef, Buffer.alloc(32, 3).toString('base64'))
        return CloudPlatform.Create({ session: new PgSession(SqlTestSessions.MemPool()), storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: TwoEnvironmentFixture.MasterKeyRef })
    }

    public static Provisioning(): InMemoryEnvironmentProvisioning
    {
        const entries = new Map<string, EnvironmentProvisioning>([
            [TwoEnvironmentFixture.EnvironmentOneId, { displayName: 'Environment One', bootstrap: { adminEmail: TwoEnvironmentFixture.Admin1Email, adminPrincipalId: TwoEnvironmentFixture.Admin1Id, adminPasswordRef: TwoEnvironmentFixture.Admin1Ref, ownerGrant: true } }],
            [TwoEnvironmentFixture.EnvironmentTwoId, { displayName: 'Environment Two', bootstrap: { adminEmail: TwoEnvironmentFixture.Admin2Email, adminPrincipalId: TwoEnvironmentFixture.Admin2Id, adminPasswordRef: TwoEnvironmentFixture.Admin2Ref, ownerGrant: true } }],
        ])
        return new InMemoryEnvironmentProvisioning(entries)
    }

    public static async SeedAndAuth(server: PragmaticServer, email: string, ref: string, pw: string)
    {
        const pack = await server.Pack()
        await pack.Secrets.Put(ref, pw)
        await server.SeedBootstrapForTest()
        return pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, email), new PresentedSecret(pw), server.Realm())
    }

    public static async Run(): Promise<void>
    {
        const baseDir = mkdtempSync(join(tmpdir(), TwoEnvironmentFixture.TempPrefix))
        const platform = await TwoEnvironmentFixture.Platform()
        const registry = new EnvironmentRegistry(baseDir, { base64Env: TwoEnvironmentFixture.UnusedEnv }, TwoEnvironmentFixture.Provisioning(), new InMemoryEnvironmentCoordinator(), platform, DeploymentMode.Cloud)
        try
        {
            const s1 = await registry.ServerFor(TwoEnvironmentFixture.EnvironmentOneId)
            const s2 = await registry.ServerFor(TwoEnvironmentFixture.EnvironmentTwoId)
            assert.ok((await TwoEnvironmentFixture.SeedAndAuth(s1, TwoEnvironmentFixture.Admin1Email, TwoEnvironmentFixture.Admin1Ref, TwoEnvironmentFixture.Admin1Pw)) instanceof AuthenticatedResult)
            assert.ok((await TwoEnvironmentFixture.SeedAndAuth(s2, TwoEnvironmentFixture.Admin2Email, TwoEnvironmentFixture.Admin2Ref, TwoEnvironmentFixture.Admin2Pw)) instanceof AuthenticatedResult)
            const pack1 = await s1.Pack()
            const cross = await pack1.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, TwoEnvironmentFixture.Admin2Email), new PresentedSecret(TwoEnvironmentFixture.Admin2Pw), s1.Realm())
            assert.ok(!(cross instanceof AuthenticatedResult))
            const pack2 = await s2.Pack()
            assert.equal(await pack1.Directory.Lookup(TwoEnvironmentFixture.Admin2Id, s1.Realm()), null)
            assert.notEqual(await pack2.Directory.Lookup(TwoEnvironmentFixture.Admin2Id, s2.Realm()), null)
            assert.equal(await pack2.Directory.Lookup(TwoEnvironmentFixture.Admin1Id, s2.Realm()), null)
            assert.notEqual(await pack1.Directory.Lookup(TwoEnvironmentFixture.Admin1Id, s1.Realm()), null)
            assert.equal(await pack1.Secrets.Get(TwoEnvironmentFixture.Admin2Ref), null)
            assert.equal(await pack1.Secrets.Get(TwoEnvironmentFixture.Admin1Ref), TwoEnvironmentFixture.Admin1Pw)
            assert.equal(await pack2.Secrets.Get(TwoEnvironmentFixture.Admin1Ref), null)
        }
        finally
        {
            await registry.DisposeAll()
            rmSync(baseDir, { recursive: true, force: true })
        }
    }
}

test('two cloud environments over one DB + object store authenticate independently and stay isolated', async () =>
{
    await TwoEnvironmentFixture.Run()
})
