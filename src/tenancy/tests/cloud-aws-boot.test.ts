import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import pg from 'pg'
import type { Pool } from 'pg'
import { AwsCloudBackends } from '@pragmatic-tech-ai/todl-platform-aws'
import { AwsEmulatorFactories } from '@pragmatic-tech-ai/todl-platform-aws/testing'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { AwsPlatformFactory } from '../../platform/aws-platform-factory.js'
import type { ICloudBackends } from '../../platform/cloud-bundle.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { DeploymentProvider } from '../../platform/deployment-provider.js'
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
    private static readonly TestRegion = 'us-east-1'
    private static readonly TestRdsHost = 'db.test'
    private static readonly TestRdsUser = 'test-user'
    private static readonly TestRdsDatabase = 'test-db'

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
            cloudProvider: DeploymentProvider.Aws,
            awsRegion: CloudBootFixture.TestRegion,
            s3Bucket: CloudBootFixture.TestBucket,
            rdsHost: CloudBootFixture.TestRdsHost,
            rdsUser: CloudBootFixture.TestRdsUser,
            rdsDatabase: CloudBootFixture.TestRdsDatabase,
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
        const bundle = await AwsPlatformFactory.CreateWith(backends, this.MasterKeyRef)
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

/** Gated emulator variant: real AwsCloudBackends wiring with the SDK clients pointed at local emulators
 *  (an S3-compatible store + a Secrets Manager emulator) and a plain pg pool on local Postgres
 *  (there is no RDS emulator, so the IAM/secret-auth pool path is bypassed). */
class EmulatorAwsGate
{
    private static readonly OptInVar = 'PRAGMATIC_TEST_AWS_CLOUD'
    private static readonly S3EndpointVar = 'PRAGMATIC_TEST_S3_ENDPOINT'
    private static readonly SecretsEndpointVar = 'PRAGMATIC_TEST_SECRETS_ENDPOINT'
    private static readonly PgUrlVar = 'PRAGMATIC_TEST_PG_URL'
    private static readonly BucketVar = 'PRAGMATIC_TEST_S3_BUCKET'
    private static readonly RegionVar = 'PRAGMATIC_TEST_AWS_REGION'
    private static readonly DefaultBucket = 'pragmatic-test'
    private static readonly DefaultRegion = 'us-east-1'
    private static readonly RunPrefix = 'run-'
    private static readonly SkipReason = 'set PRAGMATIC_TEST_AWS_CLOUD=1 plus PRAGMATIC_TEST_S3_ENDPOINT, PRAGMATIC_TEST_SECRETS_ENDPOINT and PRAGMATIC_TEST_PG_URL to run'

    public static get Skip(): string | false
    {
        const required = [EmulatorAwsGate.OptInVar, EmulatorAwsGate.S3EndpointVar, EmulatorAwsGate.SecretsEndpointVar, EmulatorAwsGate.PgUrlVar]
        return required.every(name => (process.env[name] ?? '').length > 0) ? false : EmulatorAwsGate.SkipReason
    }

    public static async Run(): Promise<void>
    {
        const runId = EmulatorAwsGate.RunPrefix + randomBytes(8).toString('hex')
        const fixture = new CloudBootFixture(CloudBootFixture.Namespace(runId))
        const baseDir = CloudBootFixture.MakeBaseDir()
        try
        {
            const region = process.env[EmulatorAwsGate.RegionVar] ?? EmulatorAwsGate.DefaultRegion
            const config = fixture.CloudConfig(baseDir, {
                awsRegion: region,
                s3Bucket: process.env[EmulatorAwsGate.BucketVar] ?? EmulatorAwsGate.DefaultBucket,
                s3Prefix: runId,
            })
            const factories = AwsEmulatorFactories.ForTest({
                s3Endpoint: process.env[EmulatorAwsGate.S3EndpointVar]!,
                secretsEndpoint: process.env[EmulatorAwsGate.SecretsEndpointVar]!,
                region,
                CreatePool: async () =>
                {
                    const pool = new pg.Pool({ connectionString: process.env[EmulatorAwsGate.PgUrlVar] })
                    return { Pool: pool, Dispose: async () => { await pool.end() } }
                },
            })
            const backends = await AwsCloudBackends.Create({
                s3Bucket: config.s3Bucket!,
                s3Prefix: config.s3Prefix,
                awsRegion: region,
                rdsHost: config.rdsHost!,
                rdsUser: config.rdsUser!,
                rdsDatabase: config.rdsDatabase!,
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

test('cloud mode (aws) boots end-to-end over an injected bundle and serves two isolated tenants', async () =>
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

test('cloud mode boots over real AwsCloudBackends wiring against local emulators and keeps two tenants isolated', { skip: EmulatorAwsGate.Skip }, async () =>
{
    await EmulatorAwsGate.Run()
})
