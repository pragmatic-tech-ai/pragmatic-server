import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import pg from 'pg'
import type { Pool } from 'pg'
import { GcpCloudBackends } from '@pragmatic-tech-ai/todl-platform-gcp'
import { GcpEmulatorFactories } from '@pragmatic-tech-ai/todl-platform-gcp/testing'
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

/** One cloud-boot scenario. `ns` namespaces tenant ids, secret refs and the master-key ref so runs sharing an emulator do not collide. */
class CloudBootFixture
{
    private static readonly Separator = '-'
    private static readonly TenantOneBase = 't1'
    private static readonly TenantTwoBase = 't2'
    private static readonly MasterKeyBase = 'cluster/master-key'
    private static readonly Admin1RefBase = 'bootstrap/admin1'
    private static readonly Admin2RefBase = 'bootstrap/admin2'
    private static readonly Admin1Id = 'admin1'
    private static readonly Admin2Id = 'admin2'
    private static readonly UnusedEnv = 'PS_CLOUD_UNUSED'
    private static readonly TempPrefix = 'ps-cloudboot-'
    private static readonly Loopback = '127.0.0.1'
    private static readonly Admin1Email = 'admin1@x.io'
    private static readonly Admin2Email = 'admin2@x.io'
    private static readonly Admin1Pw = 'pw-t1-123456'
    private static readonly Admin2Pw = 'pw-t2-123456'
    private static readonly TestBucket = 'test-bucket'
    private static readonly TestProject = 'test-project'
    private static readonly TestInstance = 'test-project:region:instance'
    private static readonly TestSqlUser = 'test-user'
    private static readonly TestSqlDatabase = 'test-db'

    public constructor(private readonly ns: string = '')
    {
    }

    public get MasterKeyRef(): string
    {
        return this.ns + CloudBootFixture.MasterKeyBase
    }

    private get TenantOneId(): string
    {
        return this.ns + CloudBootFixture.TenantOneBase
    }

    private get TenantTwoId(): string
    {
        return this.ns + CloudBootFixture.TenantTwoBase
    }

    private get Admin1Ref(): string
    {
        return this.ns + CloudBootFixture.Admin1RefBase
    }

    private get Admin2Ref(): string
    {
        return this.ns + CloudBootFixture.Admin2RefBase
    }

    public CloudConfig(baseDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig
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
            cloudMasterKeyRef: this.MasterKeyRef,
            ...overrides,
        }
    }

    public Provisioning(): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>([
            [this.TenantOneId, { displayName: 'Tenant One', bootstrap: { adminEmail: CloudBootFixture.Admin1Email, adminPrincipalId: CloudBootFixture.Admin1Id, adminPasswordRef: this.Admin1Ref, ownerGrant: true } }],
            [this.TenantTwoId, { displayName: 'Tenant Two', bootstrap: { adminEmail: CloudBootFixture.Admin2Email, adminPrincipalId: CloudBootFixture.Admin2Id, adminPasswordRef: this.Admin2Ref, ownerGrant: true } }],
        ])
        return new InMemoryTenantProvisioning(entries)
    }

    public async DoubleBackends(): Promise<CountingBackends>
    {
        const db = newDb().adapters.createPg()
        const secretManager = new CloudSecretManagerSecretStore()
        await this.PutMasterKey(secretManager)
        return new CountingBackends(new ObjectStoreProviderRegistry(), secretManager, new PgSession(new db.Pool() as unknown as Pool))
    }

    public async PutMasterKey(secrets: ICloudBackends['SecretManager']): Promise<void>
    {
        await secrets.Put(this.MasterKeyRef, Buffer.alloc(32, 3).toString('base64'))
    }

    /** Boots a cloud-mode host over the bundle built from `backends`, runs the two-tenant isolation assertions,
     *  then disposes host and bundle. Cleanup is isolated so a cleanup throw never masks an assertion failure. */
    public async BootAndAssert(backends: ICloudBackends, config: ServerConfig): Promise<void>
    {
        const bundle = await GcpPlatformFactory.CreateWith(backends, this.MasterKeyRef)
        let host: PragmaticServerHost | undefined
        try
        {
            host = await PragmaticServerHost.StartAsync(ServerBootstrap.ComposeOptions(config, this.Provisioning(), bundle.Platform))
            await this.AssertIsolation(host)
        }
        finally
        {
            await CloudBootFixture.IsolatedCleanup(host, bundle)
        }
    }

    public static Namespace(prefix: string): string
    {
        return prefix + CloudBootFixture.Separator
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

    private async AssertIsolation(host: PragmaticServerHost): Promise<void>
    {
        const registry = host.RegistryForTest()
        const s1 = await registry.ServerFor(this.TenantOneId)
        const s2 = await registry.ServerFor(this.TenantTwoId)
        assert.ok((await CloudBootFixture.SeedAndAuth(s1, CloudBootFixture.Admin1Email, this.Admin1Ref, CloudBootFixture.Admin1Pw)) instanceof AuthenticatedResult)
        assert.ok((await CloudBootFixture.SeedAndAuth(s2, CloudBootFixture.Admin2Email, this.Admin2Ref, CloudBootFixture.Admin2Pw)) instanceof AuthenticatedResult)
        const pack1 = await s1.Pack()
        const cross = await pack1.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, CloudBootFixture.Admin2Email), new PresentedSecret(CloudBootFixture.Admin2Pw), s1.Tenant())
        assert.ok(!(cross instanceof AuthenticatedResult))
        const pack2 = await s2.Pack()
        assert.equal(await pack1.Directory.Lookup(CloudBootFixture.Admin2Id, s1.Tenant()), null)
        assert.notEqual(await pack2.Directory.Lookup(CloudBootFixture.Admin2Id, s2.Tenant()), null)
        assert.equal(await pack2.Directory.Lookup(CloudBootFixture.Admin1Id, s2.Tenant()), null)
        assert.notEqual(await pack1.Directory.Lookup(CloudBootFixture.Admin1Id, s1.Tenant()), null)
        assert.equal(await pack1.Secrets.Get(this.Admin2Ref), null)
        assert.equal(await pack1.Secrets.Get(this.Admin1Ref), CloudBootFixture.Admin1Pw)
        assert.equal(await pack2.Secrets.Get(this.Admin1Ref), null)
    }
}

/** Gated emulator variant: real GcpCloudBackends wiring with the SDK clients pointed at local emulators
 *  (fake-gcs-server + a plaintext-gRPC Secret Manager emulator) and a plain pg pool on local Postgres
 *  (there is no Cloud SQL emulator, so the connector is bypassed). */
class EmulatorGcpGate
{
    private static readonly OptInVar = 'PRAGMATIC_TEST_GCP_CLOUD'
    private static readonly GcsEndpointVar = 'PRAGMATIC_TEST_GCS_ENDPOINT'
    private static readonly SecretEndpointVar = 'PRAGMATIC_TEST_GCP_SECRET_ENDPOINT'
    private static readonly PgUrlVar = 'PRAGMATIC_TEST_PG_URL'
    private static readonly BucketVar = 'PRAGMATIC_TEST_GCS_BUCKET'
    private static readonly ProjectVar = 'PRAGMATIC_TEST_GCP_PROJECT'
    private static readonly DefaultBucket = 'pragmatic-test'
    private static readonly DefaultProject = 'test-project'
    private static readonly RunPrefix = 'run-'
    private static readonly SkipReason = 'set PRAGMATIC_TEST_GCP_CLOUD=1 plus PRAGMATIC_TEST_GCS_ENDPOINT, PRAGMATIC_TEST_GCP_SECRET_ENDPOINT and PRAGMATIC_TEST_PG_URL to run'

    public static get Skip(): string | false
    {
        const required = [EmulatorGcpGate.OptInVar, EmulatorGcpGate.GcsEndpointVar, EmulatorGcpGate.SecretEndpointVar, EmulatorGcpGate.PgUrlVar]
        return required.every(name => (process.env[name] ?? '').length > 0) ? false : EmulatorGcpGate.SkipReason
    }

    public static async Run(): Promise<void>
    {
        const runId = EmulatorGcpGate.RunPrefix + randomBytes(8).toString('hex')
        const fixture = new CloudBootFixture(CloudBootFixture.Namespace(runId))
        const baseDir = CloudBootFixture.MakeBaseDir()
        try
        {
            const project = process.env[EmulatorGcpGate.ProjectVar] ?? EmulatorGcpGate.DefaultProject
            const config = fixture.CloudConfig(baseDir, {
                gcpProject: project,
                gcsBucket: process.env[EmulatorGcpGate.BucketVar] ?? EmulatorGcpGate.DefaultBucket,
                gcsPrefix: runId,
            })
            const factories = GcpEmulatorFactories.ForTest({
                gcsEndpoint: process.env[EmulatorGcpGate.GcsEndpointVar]!,
                secretEndpoint: process.env[EmulatorGcpGate.SecretEndpointVar]!,
                CreatePool: async () =>
                {
                    const pool = new pg.Pool({ connectionString: process.env[EmulatorGcpGate.PgUrlVar] })
                    return { Pool: pool, Dispose: async () => { await pool.end() } }
                },
            })
            const backends = await GcpCloudBackends.Create({
                gcsBucket: config.gcsBucket!,
                gcsPrefix: config.gcsPrefix,
                gcpProject: project,
                cloudSqlInstance: config.cloudSqlInstance!,
                cloudSqlUser: config.cloudSqlUser!,
                cloudSqlDatabase: config.cloudSqlDatabase!,
            }, factories)
            try
            {
                await fixture.PutMasterKey(backends.SecretManager)
            }
            catch (error)
            {
                await backends.Dispose().catch(() => undefined)
                throw error
            }
            await fixture.BootAndAssert(backends, config)
        }
        finally
        {
            CloudBootFixture.RemoveBaseDir(baseDir)
        }
    }
}

test('cloud mode without a platform bundle still fails closed (the gap this stage closes)', () =>
{
    const fixture = new CloudBootFixture()
    const baseDir = CloudBootFixture.MakeBaseDir()
    try
    {
        assert.throws(() => ServerBootstrap.ComposeOptions(fixture.CloudConfig(baseDir), fixture.Provisioning(), undefined), /requires a configured platform/)
    }
    finally
    {
        CloudBootFixture.RemoveBaseDir(baseDir)
    }
})

test('cloud mode boots end-to-end over an injected bundle and serves two isolated tenants', async () =>
{
    const fixture = new CloudBootFixture()
    const baseDir = CloudBootFixture.MakeBaseDir()
    try
    {
        const backends = await fixture.DoubleBackends()
        await fixture.BootAndAssert(backends, fixture.CloudConfig(baseDir))
        assert.equal(backends.disposeCalls, 1)
    }
    finally
    {
        CloudBootFixture.RemoveBaseDir(baseDir)
    }
})

test('cloud mode boots over real GcpCloudBackends wiring against local emulators and keeps two tenants isolated', { skip: EmulatorGcpGate.Skip }, async () =>
{
    await EmulatorGcpGate.Run()
})
