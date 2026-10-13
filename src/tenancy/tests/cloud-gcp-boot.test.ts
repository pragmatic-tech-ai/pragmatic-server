import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { GcpCloudBackends } from '@pragmatic-tech-ai/todl-platform-gcp'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { GcpPlatformFactory } from '../../platform/gcp-platform-factory.js'
import type { ICloudBackends } from '../../platform/gcp-platform-factory.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ServerBootstrap } from '../../bin/server-bootstrap.js'
import { PragmaticServerHost } from '../../host/pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../tenant-registry.js'
import type { ServerConfig } from '../../config/server-config.js'
import type { TenantProvisioning } from '../tenant-provisioning.js'
import type { PragmaticServer } from '../../pragmatic-server.js'

class CountingBackends implements ICloudBackends
{
    public disposeCalls = 0

    public constructor(
        public readonly Storage: ICloudBackends['Storage'],
        public readonly SecretManager: ICloudBackends['SecretManager'],
        public readonly Session: ICloudBackends['Session'])
    {
    }

    public async Dispose(): Promise<void>
    {
        this.disposeCalls += 1
    }
}

class CloudBootFixture
{
    public static readonly MasterKeyRef = 'cluster/master-key'
    private static readonly TenantOneId = 't1'
    private static readonly TenantTwoId = 't2'
    private static readonly Admin1Id = 'admin1'
    private static readonly Admin2Id = 'admin2'
    private static readonly UnusedEnv = 'PS_CLOUD_UNUSED'
    private static readonly TempPrefix = 'ps-cloudboot-'
    private static readonly Loopback = '127.0.0.1'
    private static readonly Admin1Email = 'admin1@x.io'
    private static readonly Admin2Email = 'admin2@x.io'
    private static readonly Admin1Ref = 't1/bootstrap/admin'
    private static readonly Admin2Ref = 't2/bootstrap/admin'
    private static readonly Admin1Pw = 'pw-t1-123456'
    private static readonly Admin2Pw = 'pw-t2-123456'
    private static readonly TestBucket = 'test-bucket'
    private static readonly TestProject = 'test-project'
    private static readonly TestInstance = 'test-project:region:instance'
    private static readonly TestSqlUser = 'test-user'
    private static readonly TestSqlDatabase = 'test-db'

    public static CloudConfig(baseDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig
    {
        return {
            host: CloudBootFixture.Loopback,
            port: 0,
            baseDir,
            masterKey: { base64Env: CloudBootFixture.UnusedEnv },
            deploymentMode: DeploymentMode.Cloud,
            gcsBucket: CloudBootFixture.TestBucket,
            gcpProject: CloudBootFixture.TestProject,
            cloudSqlInstance: CloudBootFixture.TestInstance,
            cloudSqlUser: CloudBootFixture.TestSqlUser,
            cloudSqlDatabase: CloudBootFixture.TestSqlDatabase,
            cloudMasterKeyRef: CloudBootFixture.MasterKeyRef,
            ...overrides,
        }
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>([
            [CloudBootFixture.TenantOneId, { displayName: 'Tenant One', bootstrap: { adminEmail: CloudBootFixture.Admin1Email, adminPrincipalId: CloudBootFixture.Admin1Id, adminPasswordRef: CloudBootFixture.Admin1Ref, ownerGrant: true } }],
            [CloudBootFixture.TenantTwoId, { displayName: 'Tenant Two', bootstrap: { adminEmail: CloudBootFixture.Admin2Email, adminPrincipalId: CloudBootFixture.Admin2Id, adminPasswordRef: CloudBootFixture.Admin2Ref, ownerGrant: true } }],
        ])
        return new InMemoryTenantProvisioning(entries)
    }

    public static async DoubleBackends(): Promise<CountingBackends>
    {
        const pg = newDb().adapters.createPg()
        const secretManager = new CloudSecretManagerSecretStore()
        await secretManager.Put(CloudBootFixture.MasterKeyRef, Buffer.alloc(32, 3).toString('base64'))
        return new CountingBackends(new ObjectStoreProviderRegistry(), secretManager, new PgSession(new pg.Pool() as unknown as Pool))
    }

    /** Boots a cloud-mode host over the bundle built from `backends`, runs the two-tenant isolation assertions,
     *  then disposes host and bundle. Cleanup is isolated so a cleanup throw never masks an assertion failure. */
    public static async BootAndAssert(backends: ICloudBackends, config: ServerConfig): Promise<void>
    {
        const bundle = await GcpPlatformFactory.CreateWith(backends, CloudBootFixture.MasterKeyRef)
        let host: PragmaticServerHost | undefined
        try
        {
            host = await PragmaticServerHost.StartAsync(ServerBootstrap.ComposeOptions(config, CloudBootFixture.Provisioning(), bundle.Platform))
            await CloudBootFixture.AssertIsolation(host)
        }
        finally
        {
            await CloudBootFixture.IsolatedCleanup(host, bundle)
        }
    }

    public static MakeBaseDir(): string
    {
        return mkdtempSync(join(tmpdir(), CloudBootFixture.TempPrefix))
    }

    public static RemoveBaseDir(baseDir: string): void
    {
        rmSync(baseDir, { recursive: true, force: true })
    }

    private static async IsolatedCleanup(host: PragmaticServerHost | undefined, bundle: { Dispose(): Promise<void> }): Promise<void>
    {
        try
        {
            await host?.DisposeAsync()
        }
        catch
        {
            // best-effort: must not mask the primary outcome
        }
        try
        {
            await bundle.Dispose()
        }
        catch
        {
            // best-effort: must not mask the primary outcome
        }
    }

    private static async SeedAndAuth(server: PragmaticServer, email: string, ref: string, pw: string)
    {
        const pack = await server.Pack()
        await pack.Secrets.Put(ref, pw)
        await server.SeedBootstrapForTest()
        return pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, email), new PresentedSecret(pw), server.Tenant())
    }

    private static async AssertIsolation(host: PragmaticServerHost): Promise<void>
    {
        const registry = host.RegistryForTest()
        const s1 = await registry.ServerFor(CloudBootFixture.TenantOneId)
        const s2 = await registry.ServerFor(CloudBootFixture.TenantTwoId)
        assert.ok((await CloudBootFixture.SeedAndAuth(s1, CloudBootFixture.Admin1Email, CloudBootFixture.Admin1Ref, CloudBootFixture.Admin1Pw)) instanceof AuthenticatedResult)
        assert.ok((await CloudBootFixture.SeedAndAuth(s2, CloudBootFixture.Admin2Email, CloudBootFixture.Admin2Ref, CloudBootFixture.Admin2Pw)) instanceof AuthenticatedResult)
        const pack1 = await s1.Pack()
        const cross = await pack1.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, CloudBootFixture.Admin2Email), new PresentedSecret(CloudBootFixture.Admin2Pw), s1.Tenant())
        assert.ok(!(cross instanceof AuthenticatedResult))
        const pack2 = await s2.Pack()
        assert.equal(await pack1.Directory.Lookup(CloudBootFixture.Admin2Id, s1.Tenant()), null)
        assert.notEqual(await pack2.Directory.Lookup(CloudBootFixture.Admin2Id, s2.Tenant()), null)
        assert.equal(await pack2.Directory.Lookup(CloudBootFixture.Admin1Id, s2.Tenant()), null)
        assert.notEqual(await pack1.Directory.Lookup(CloudBootFixture.Admin1Id, s1.Tenant()), null)
        assert.equal(await pack1.Secrets.Get(CloudBootFixture.Admin2Ref), null)
        assert.equal(await pack1.Secrets.Get(CloudBootFixture.Admin1Ref), CloudBootFixture.Admin1Pw)
        assert.equal(await pack2.Secrets.Get(CloudBootFixture.Admin1Ref), null)
    }
}

class RealGcpGate
{
    private static readonly OptInVar = 'PRAGMATIC_TEST_GCP_CLOUD'
    private static readonly GcsEndpointVar = 'PRAGMATIC_TEST_GCS_ENDPOINT'
    private static readonly SecretEndpointVar = 'PRAGMATIC_TEST_GCP_SECRET_ENDPOINT'
    private static readonly PgUrlVar = 'PRAGMATIC_TEST_PG_URL'
    private static readonly ProjectVar = 'PRAGMATIC_TEST_GCP_PROJECT'
    private static readonly BucketVar = 'PRAGMATIC_TEST_GCS_BUCKET'
    private static readonly InstanceVar = 'PRAGMATIC_TEST_CLOUDSQL_INSTANCE'
    private static readonly UserVar = 'PRAGMATIC_TEST_CLOUDSQL_USER'
    private static readonly DatabaseVar = 'PRAGMATIC_TEST_CLOUDSQL_DATABASE'
    private static readonly SkipReason = 'set PRAGMATIC_TEST_GCP_CLOUD=1 plus the GCS/secret endpoints, PRAGMATIC_TEST_PG_URL and project/bucket/Cloud SQL vars to run'

    public static get Skip(): string | false
    {
        const required = [RealGcpGate.OptInVar, RealGcpGate.GcsEndpointVar, RealGcpGate.SecretEndpointVar, RealGcpGate.PgUrlVar, RealGcpGate.ProjectVar, RealGcpGate.BucketVar, RealGcpGate.InstanceVar, RealGcpGate.UserVar, RealGcpGate.DatabaseVar]
        return required.every(name => (process.env[name] ?? '').length > 0) ? false : RealGcpGate.SkipReason
    }

    public static Config(baseDir: string): ServerConfig
    {
        return CloudBootFixture.CloudConfig(baseDir, {
            gcpProject: process.env[RealGcpGate.ProjectVar],
            gcsBucket: process.env[RealGcpGate.BucketVar],
            cloudSqlInstance: process.env[RealGcpGate.InstanceVar],
            cloudSqlUser: process.env[RealGcpGate.UserVar],
            cloudSqlDatabase: process.env[RealGcpGate.DatabaseVar],
        })
    }
}

test('cloud mode without a platform bundle still fails closed (the gap this stage closes)', () =>
{
    const baseDir = CloudBootFixture.MakeBaseDir()
    try
    {
        assert.throws(() => ServerBootstrap.ComposeOptions(CloudBootFixture.CloudConfig(baseDir), CloudBootFixture.Provisioning(), undefined), /requires a configured platform/)
    }
    finally
    {
        CloudBootFixture.RemoveBaseDir(baseDir)
    }
})

test('cloud mode boots end-to-end over an injected bundle and serves two isolated tenants', async () =>
{
    const baseDir = CloudBootFixture.MakeBaseDir()
    try
    {
        const backends = await CloudBootFixture.DoubleBackends()
        await CloudBootFixture.BootAndAssert(backends, CloudBootFixture.CloudConfig(baseDir))
        assert.equal(backends.disposeCalls, 1)
    }
    finally
    {
        CloudBootFixture.RemoveBaseDir(baseDir)
    }
})

test('cloud mode boots over real GcpCloudBackends and keeps two tenants isolated', { skip: RealGcpGate.Skip }, async () =>
{
    const baseDir = CloudBootFixture.MakeBaseDir()
    try
    {
        const config = RealGcpGate.Config(baseDir)
        const real = await GcpCloudBackends.Create({
            gcsBucket: config.gcsBucket!,
            gcpProject: config.gcpProject!,
            cloudSqlInstance: config.cloudSqlInstance!,
            cloudSqlUser: config.cloudSqlUser!,
            cloudSqlDatabase: config.cloudSqlDatabase!,
        })
        await real.SecretManager.Put(CloudBootFixture.MasterKeyRef, Buffer.alloc(32, 3).toString('base64'))
        await CloudBootFixture.BootAndAssert(real, config)
    }
    finally
    {
        CloudBootFixture.RemoveBaseDir(baseDir)
    }
})
