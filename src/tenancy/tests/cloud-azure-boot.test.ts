import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { newDb } from 'pg-mem'
import pg from 'pg'
import type { Pool } from 'pg'
import { AzureCloudBackends } from '@pragmatic-tech-ai/todl-platform-azure'
import { AzureEmulatorFactories } from '@pragmatic-tech-ai/todl-platform-azure/testing'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { AzurePlatformFactory } from '../../platform/azure-platform-factory.js'
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
class AzureCloudBootFixture
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
    private static readonly TestBlobAccount = 'testacct'
    private static readonly TestBlobContainer = 'test-container'
    private static readonly TestKeyVaultUrl = 'https://test.vault.azure.net'
    private static readonly TestPgHost = 'db.postgres.database.azure.com'
    private static readonly TestPgUser = 'test-user'
    private static readonly TestPgDatabase = 'test-db'

    public constructor(private readonly ns: string = '')
    {
    }

    public get MasterKeyRef(): string
    {
        return this.ns + AzureCloudBootFixture.MasterKeyBase
    }

    private get TenantOneId(): string
    {
        return this.ns + AzureCloudBootFixture.TenantOneBase
    }

    private get TenantTwoId(): string
    {
        return this.ns + AzureCloudBootFixture.TenantTwoBase
    }

    private get Admin1Ref(): string
    {
        return this.ns + AzureCloudBootFixture.Admin1RefBase
    }

    private get Admin2Ref(): string
    {
        return this.ns + AzureCloudBootFixture.Admin2RefBase
    }

    public CloudConfig(baseDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig
    {
        return {
            host: AzureCloudBootFixture.Loopback,
            port: 0,
            baseDir,
            masterKey: { base64Env: AzureCloudBootFixture.UnusedEnv },
            deploymentMode: DeploymentMode.Cloud,
            cloudProvider: DeploymentProvider.Azure,
            blobAccount: AzureCloudBootFixture.TestBlobAccount,
            blobContainer: AzureCloudBootFixture.TestBlobContainer,
            keyVaultUrl: AzureCloudBootFixture.TestKeyVaultUrl,
            azpgHost: AzureCloudBootFixture.TestPgHost,
            azpgUser: AzureCloudBootFixture.TestPgUser,
            azpgDatabase: AzureCloudBootFixture.TestPgDatabase,
            cloudMasterKeyRef: this.MasterKeyRef,
            ...overrides,
        }
    }

    public Provisioning(): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>([
            [this.TenantOneId, { displayName: 'Tenant One', bootstrap: { adminEmail: AzureCloudBootFixture.Admin1Email, adminPrincipalId: AzureCloudBootFixture.Admin1Id, adminPasswordRef: this.Admin1Ref, ownerGrant: true } }],
            [this.TenantTwoId, { displayName: 'Tenant Two', bootstrap: { adminEmail: AzureCloudBootFixture.Admin2Email, adminPrincipalId: AzureCloudBootFixture.Admin2Id, adminPasswordRef: this.Admin2Ref, ownerGrant: true } }],
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
        const bundle = await AzurePlatformFactory.CreateWith(backends, this.MasterKeyRef)
        let host: PragmaticServerHost | undefined
        try
        {
            host = await PragmaticServerHost.StartAsync(ServerBootstrap.ComposeOptions(config, this.Provisioning(), bundle.Platform))
            await this.AssertIsolation(host)
        }
        finally
        {
            await AzureCloudBootFixture.IsolatedCleanup(host, bundle)
        }
    }

    public static Namespace(prefix: string): string
    {
        return prefix + AzureCloudBootFixture.Separator
    }

    public static MakeBaseDir(): string
    {
        return mkdtempSync(join(tmpdir(), AzureCloudBootFixture.TempPrefix))
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
        assert.ok((await AzureCloudBootFixture.SeedAndAuth(s1, AzureCloudBootFixture.Admin1Email, this.Admin1Ref, AzureCloudBootFixture.Admin1Pw)) instanceof AuthenticatedResult)
        assert.ok((await AzureCloudBootFixture.SeedAndAuth(s2, AzureCloudBootFixture.Admin2Email, this.Admin2Ref, AzureCloudBootFixture.Admin2Pw)) instanceof AuthenticatedResult)
        const pack1 = await s1.Pack()
        const cross = await pack1.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, AzureCloudBootFixture.Admin2Email), new PresentedSecret(AzureCloudBootFixture.Admin2Pw), s1.Tenant())
        assert.ok(!(cross instanceof AuthenticatedResult))
        const pack2 = await s2.Pack()
        assert.equal(await pack1.Directory.Lookup(AzureCloudBootFixture.Admin2Id, s1.Tenant()), null)
        assert.notEqual(await pack2.Directory.Lookup(AzureCloudBootFixture.Admin2Id, s2.Tenant()), null)
        assert.equal(await pack2.Directory.Lookup(AzureCloudBootFixture.Admin1Id, s2.Tenant()), null)
        assert.notEqual(await pack1.Directory.Lookup(AzureCloudBootFixture.Admin1Id, s1.Tenant()), null)
        assert.equal(await pack1.Secrets.Get(this.Admin2Ref), null)
        assert.equal(await pack1.Secrets.Get(this.Admin1Ref), AzureCloudBootFixture.Admin1Pw)
        assert.equal(await pack2.Secrets.Get(this.Admin1Ref), null)
    }
}

/** Gated emulator variant: real AzureCloudBackends wiring with Blob pointed at Azurite, a real Key Vault
 *  (there is no emulator) and a plain pg pool on local Postgres (there is no Flexible Server emulator). */
class EmulatorAzureGate
{
    private static readonly OptInVar = 'PRAGMATIC_TEST_AZURE_CLOUD'
    private static readonly BlobConnVar = 'PRAGMATIC_TEST_BLOB_CONNSTR'
    private static readonly KeyVaultVar = 'PRAGMATIC_TEST_KEYVAULT_ENDPOINT'
    private static readonly PgUrlVar = 'PRAGMATIC_TEST_PG_URL'
    private static readonly RunPrefix = 'run-'
    private static readonly IdentityPackage = '@azure/identity'
    private static readonly SkipReason = 'set PRAGMATIC_TEST_AZURE_CLOUD=1 plus PRAGMATIC_TEST_BLOB_CONNSTR, PRAGMATIC_TEST_KEYVAULT_ENDPOINT and PRAGMATIC_TEST_PG_URL to run'

    public static get Skip(): string | false
    {
        const required = [EmulatorAzureGate.OptInVar, EmulatorAzureGate.BlobConnVar, EmulatorAzureGate.KeyVaultVar, EmulatorAzureGate.PgUrlVar]
        return required.every(name => (process.env[name] ?? '').length > 0) ? false : EmulatorAzureGate.SkipReason
    }

    /** Loads DefaultAzureCredential lazily, resolved from the azure platform package's own dependency tree,
     *  so pragmatic-server needs no direct @azure/identity dependency on the default path. */
    private static async NewCredential(): Promise<Parameters<typeof AzureEmulatorFactories.ForTest>[0]['credential']>
    {
        const entry = fileURLToPath(import.meta.resolve('@pragmatic-tech-ai/todl-platform-azure'))
        const identityPath = createRequire(entry).resolve(EmulatorAzureGate.IdentityPackage)
        const identity = await import(pathToFileURL(identityPath).href) as { DefaultAzureCredential: new () => Parameters<typeof AzureEmulatorFactories.ForTest>[0]['credential'] }
        return new identity.DefaultAzureCredential()
    }

    public static async Run(): Promise<void>
    {
        const runId = EmulatorAzureGate.RunPrefix + randomBytes(8).toString('hex')
        const fixture = new AzureCloudBootFixture(AzureCloudBootFixture.Namespace(runId))
        const baseDir = AzureCloudBootFixture.MakeBaseDir()
        try
        {
            const config = fixture.CloudConfig(baseDir, {
                keyVaultUrl: process.env[EmulatorAzureGate.KeyVaultVar]!,
                blobPrefix: runId,
            })
            const factories = AzureEmulatorFactories.ForTest({
                blobConnectionString: process.env[EmulatorAzureGate.BlobConnVar]!,
                keyVaultUrl: process.env[EmulatorAzureGate.KeyVaultVar]!,
                credential: await EmulatorAzureGate.NewCredential(),
                CreatePool: async () =>
                {
                    const pool = new pg.Pool({ connectionString: process.env[EmulatorAzureGate.PgUrlVar] })
                    return { Pool: pool, Dispose: async () => { await pool.end() } }
                },
            })
            const backends = await AzureCloudBackends.Create({
                blobAccount: config.blobAccount!,
                blobContainer: config.blobContainer!,
                blobPrefix: config.blobPrefix,
                keyVaultUrl: config.keyVaultUrl!,
                azpgHost: config.azpgHost!,
                azpgUser: config.azpgUser!,
                azpgDatabase: config.azpgDatabase!,
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
            AzureCloudBootFixture.RemoveBaseDir(baseDir)
        }
    }
}

test('cloud mode without a platform bundle still fails closed (the gap this stage closes)', () =>
{
    const fixture = new AzureCloudBootFixture()
    const baseDir = AzureCloudBootFixture.MakeBaseDir()
    try
    {
        assert.throws(() => ServerBootstrap.ComposeOptions(fixture.CloudConfig(baseDir), fixture.Provisioning(), undefined), /requires a configured platform/)
    }
    finally
    {
        AzureCloudBootFixture.RemoveBaseDir(baseDir)
    }
})

test('cloud mode (azure) boots end-to-end over an injected bundle and serves two isolated tenants', async () =>
{
    const fixture = new AzureCloudBootFixture()
    const baseDir = AzureCloudBootFixture.MakeBaseDir()
    try
    {
        const backends = await fixture.DoubleBackends()
        await fixture.BootAndAssert(backends, fixture.CloudConfig(baseDir))
        assert.equal(backends.disposeCalls, 1)
    }
    finally
    {
        AzureCloudBootFixture.RemoveBaseDir(baseDir)
    }
})

test('cloud mode boots over real AzureCloudBackends wiring against local emulators and keeps two tenants isolated', { skip: EmulatorAzureGate.Skip }, async () =>
{
    await EmulatorAzureGate.Run()
})
