import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { PragmaticClient, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { BundleBuilder, EnvKind, TenantPurposeName } from '../../../environments/seed/bundle.js'
import { HelloAppBuilder } from './hello-app-builder.js'
import type { BuiltHelloApp } from './hello-app-builder.js'

/** Opt-in gate for the SP0 capstone e2e (needs Docker + the pragmatic-server:sp0 image + a Playwright chromium). */
class Gate
{
    private static readonly Var = 'SP0_E2E'
    private static readonly On = '1'

    public static get Enabled(): boolean
    {
        return process.env[Gate.Var] === Gate.On
    }
}

/** Acquires an ephemeral TCP port by binding and releasing a throwaway listener. */
class FreePort
{
    private static readonly Loopback = '127.0.0.1'

    public static Acquire(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const probe = createServer()
            probe.on('error', reject)
            probe.listen(0, FreePort.Loopback, () =>
            {
                const port = (probe.address() as AddressInfo).port
                probe.close(() => resolve(port))
            })
        })
    }
}

/**
 * The runtime tenant's security model. An identity-configured tenant with NO security model fails closed
 * (AccessDepthEvaluator.DenyAll), so its access-depth read filter strips EVERY instance — the authenticated admin
 * would see nothing. This seeds the minimum that lets the bootstrapped admin read the deployed app: organization-level
 * Read on the fixture's one concept. A general mechanism that grants a tenant admin/owner read over ANY deployed app's
 * concepts without hand-authoring per-concept privileges (a deploy-time grant or a wildcard privilege) is a deferred v1
 * Feature; the skeleton seeds the single concept its own fixture authors.
 */
class RuntimeSecurityModel
{
    private static readonly AdminPrincipalId = 'admin'
    private static readonly AppConcept = 'hello.greeting'
    private static readonly OrgUnitId = 'org'
    private static readonly OrgUnitName = 'Organization'
    private static readonly ReaderRoleId = 'app-reader'
    private static readonly ReaderRoleName = 'App Reader'

    public static Config(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: RuntimeSecurityModel.OrgUnitId, name: RuntimeSecurityModel.OrgUnitName }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: RuntimeSecurityModel.AdminPrincipalId, homeBusinessUnit: RuntimeSecurityModel.OrgUnitId, teams: [] }] },
            ownershipRules: [],
            roles: [{ id: RuntimeSecurityModel.ReaderRoleId, name: RuntimeSecurityModel.ReaderRoleName, privileges: [{ action: PrivilegeAction.Read, concept: RuntimeSecurityModel.AppConcept, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: RuntimeSecurityModel.AdminPrincipalId, roles: [RuntimeSecurityModel.ReaderRoleId] }], teamRoles: [] },
        }
    }
}

/**
 * Stands up a one-tenant Runtime server inside the captured Docker image, following the recipe: it seeds a config bundle,
 * mounts it read-only, runs the published image with a unique container, and polls /healthz. The base dir points at the
 * non-root runtime user's own home (a writable, ephemeral location) rather than a fresh Docker volume: a plain named
 * volume mounts into /data owned by root, which the image's non-root user (uid 10001) cannot write, so the first tenant
 * materialization would fail. A real deployment supplies a volume whose ownership the runtime user can write (an
 * orchestrator fsGroup / init chown); this ephemeral test needs no persistence and so avoids the volume entirely.
 */
class RuntimeTenant
{
    private static readonly Image = 'pragmatic-server:sp0'
    private static readonly TenantId = 'sp0'
    private static readonly EnvName = 'sp0'
    private static readonly BundlePrefix = 'sp0-bundle-'
    private static readonly SeedPrefix = 'sp0-seed-'
    private static readonly NamePrefix = 'sp0-e2e-'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly MasterKeyFile = 'master.key'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly SecurityModelFile = 'security-model.json'
    private static readonly Utf8 = 'utf8'
    private static readonly Docker = 'docker'
    private static readonly RunVerb = 'run'
    private static readonly RunFlag = '-d'
    private static readonly NameFlag = '--name'
    private static readonly PortFlag = '-p'
    private static readonly VolumeFlag = '-v'
    private static readonly EnvFlag = '-e'
    private static readonly ImageInspect = 'image'
    private static readonly InspectVerb = 'inspect'
    private static readonly RemoveVerb = 'rm'
    private static readonly ForceFlag = '-f'
    private static readonly ContainerPort = '8080'
    private static readonly TenantsMount = ':/cfg/tenants.json:ro'
    private static readonly SecretsMount = ':/cfg/provisioned-secrets.json:ro'
    private static readonly MasterKeyMount = ':/run/secrets/master_key:ro'
    // The generated bundle's data dir holds identity/tenant-config.json (with the security model) and is also
    // where the runtime writes deployed apps + the durable store; mounted read-write at the base dir.
    private static readonly DataDir = 'data'
    private static readonly DataMount = ':/home/pragmatic/data'
    private static readonly Loopback = 'http://localhost:'
    private static readonly HealthPath = '/healthz'
    private static readonly LoginPath = '/auth/login?environment=sp0'
    private static readonly BrowserLoginPath = '/auth/browser-login?environment=sp0'
    private static readonly AppPath = '/app/sp0/hello/'
    private static readonly WsPath = '/?environment=sp0'
    private static readonly WsScheme = 'ws://localhost:'
    private static readonly JsonHeader = { 'Content-Type': 'application/json' }
    private static readonly PostMethod = 'POST'
    private static readonly OkStatus = 200
    private static readonly HealthTimeoutMs = 120000
    private static readonly HealthPollMs = 1000
    private static readonly ImageMissing = 'the pragmatic-server:sp0 image is absent: build it first (see the SP0 Dockerfile recipe)'
    private static readonly HealthNeverReady = 'the runtime tenant container never reported /healthz=200'
    private static readonly PortEnv = 'PRAGMATIC_PORT=8080'
    private static readonly BaseDirEnv = 'PRAGMATIC_BASE_DIR=/home/pragmatic/data'
    private static readonly TenantsFileEnv = 'PRAGMATIC_TENANTS_FILE=/cfg/tenants.json'
    private static readonly MasterKeyEnv = 'PRAGMATIC_MASTER_KEY_FILE=/run/secrets/master_key'
    private static readonly SecretsEnv = 'PRAGMATIC_PROVISIONED_SECRETS_FILE=/cfg/provisioned-secrets.json'
    private static readonly DeploymentModeEnv = 'PRAGMATIC_DEPLOYMENT_MODE=local'
    private static readonly AllowedOriginsEnv = 'PRAGMATIC_ALLOWED_ORIGINS='

    private readonly bundleDir: string
    private readonly seedDir: string
    private readonly container: string
    private started = false

    public constructor(private readonly port: number)
    {
        const unique = randomBytes(6).toString('hex')
        this.bundleDir = mkdtempSync(join(tmpdir(), RuntimeTenant.BundlePrefix))
        this.seedDir = mkdtempSync(join(tmpdir(), RuntimeTenant.SeedPrefix))
        this.container = RuntimeTenant.NamePrefix + unique
    }

    public get Base(): string
    {
        return RuntimeTenant.Loopback + this.port
    }

    public get WsUrl(): string
    {
        return RuntimeTenant.WsScheme + this.port + RuntimeTenant.WsPath
    }

    public get Origin(): string
    {
        return RuntimeTenant.Loopback + this.port
    }

    public get AppUrl(): string
    {
        return this.Base + RuntimeTenant.AppPath
    }

    public get BrowserLoginUrl(): string
    {
        return this.Base + RuntimeTenant.BrowserLoginPath
    }

    public get Email(): string
    {
        return BundleBuilder.AdminEmailPrefix + RuntimeTenant.TenantId + BundleBuilder.AdminEmailSuffix
    }

    public get Password(): string
    {
        const secrets = JSON.parse(readFileSync(join(this.bundleDir, RuntimeTenant.SecretsFile), RuntimeTenant.Utf8)) as Record<string, string>
        return secrets[RuntimeTenant.TenantId + BundleBuilder.AdminSecretSuffix]!
    }

    public static RequireImage(): void
    {
        try
        {
            execFileSync(RuntimeTenant.Docker, [RuntimeTenant.ImageInspect, RuntimeTenant.InspectVerb, RuntimeTenant.Image], { stdio: 'ignore' })
        }
        catch
        {
            throw new Error(RuntimeTenant.ImageMissing)
        }
    }

    public async StartAsync(): Promise<void>
    {
        // Seed the tenant's security model before Generate reads it: without one, an identity-configured tenant denies
        // all reads and the browser's live query would come back empty.
        writeFileSync(join(this.seedDir, RuntimeTenant.SecurityModelFile), JSON.stringify(RuntimeSecurityModel.Config()))
        await BundleBuilder.Generate(
            { name: RuntimeTenant.EnvName, kind: EnvKind.Dev, tenantId: RuntimeTenant.TenantId, purpose: TenantPurposeName.Runtime, hostPort: this.port },
            this.bundleDir, this.seedDir)
        execFileSync(RuntimeTenant.Docker, this.RunArgs(), { stdio: 'ignore' })
        this.started = true
        await this.WaitForHealthy()
    }

    /** Obtains an admin bearer token the way a Node publisher would, via the Bearer login route. */
    public async BearerAsync(): Promise<string>
    {
        const response = await fetch(this.Base + RuntimeTenant.LoginPath, {
            method: RuntimeTenant.PostMethod,
            headers: RuntimeTenant.JsonHeader,
            body: JSON.stringify({ email: this.Email, password: this.Password }),
        })
        assert.equal(response.status, RuntimeTenant.OkStatus)
        return ((await response.json()) as { token: string }).token
    }

    public Stop(): void
    {
        if (this.started)
        {
            RuntimeTenant.Quiet(() => execFileSync(RuntimeTenant.Docker, [RuntimeTenant.RemoveVerb, RuntimeTenant.ForceFlag, this.container], { stdio: 'ignore' }))
        }
        RuntimeTenant.Quiet(() => rmSync(this.bundleDir, { recursive: true, force: true }))
        RuntimeTenant.Quiet(() => rmSync(this.seedDir, { recursive: true, force: true }))
    }

    private RunArgs(): string[]
    {
        return [
            RuntimeTenant.RunVerb, RuntimeTenant.RunFlag, RuntimeTenant.NameFlag, this.container,
            RuntimeTenant.PortFlag, this.port + ':' + RuntimeTenant.ContainerPort,
            RuntimeTenant.VolumeFlag, join(this.bundleDir, RuntimeTenant.TenantsFile) + RuntimeTenant.TenantsMount,
            RuntimeTenant.VolumeFlag, join(this.bundleDir, RuntimeTenant.SecretsFile) + RuntimeTenant.SecretsMount,
            RuntimeTenant.VolumeFlag, join(this.bundleDir, RuntimeTenant.MasterKeyFile) + RuntimeTenant.MasterKeyMount,
            RuntimeTenant.VolumeFlag, join(this.bundleDir, RuntimeTenant.DataDir) + RuntimeTenant.DataMount,
            RuntimeTenant.EnvFlag, RuntimeTenant.BaseDirEnv,
            RuntimeTenant.EnvFlag, RuntimeTenant.TenantsFileEnv,
            RuntimeTenant.EnvFlag, RuntimeTenant.MasterKeyEnv,
            RuntimeTenant.EnvFlag, RuntimeTenant.SecretsEnv,
            RuntimeTenant.EnvFlag, RuntimeTenant.PortEnv,
            RuntimeTenant.EnvFlag, RuntimeTenant.DeploymentModeEnv,
            RuntimeTenant.EnvFlag, RuntimeTenant.AllowedOriginsEnv + this.Origin,
            RuntimeTenant.Image,
        ]
    }

    private async WaitForHealthy(): Promise<void>
    {
        const deadline = Date.now() + RuntimeTenant.HealthTimeoutMs
        while (Date.now() < deadline)
        {
            if (await this.Healthy())
            {
                return
            }
            await new Promise<void>(resolve => setTimeout(resolve, RuntimeTenant.HealthPollMs))
        }
        throw new Error(RuntimeTenant.HealthNeverReady)
    }

    private async Healthy(): Promise<boolean>
    {
        try
        {
            return (await fetch(this.Base + RuntimeTenant.HealthPath)).status === RuntimeTenant.OkStatus
        }
        catch
        {
            return false
        }
    }

    private static Quiet(action: () => void): void
    {
        try
        {
            action()
        }
        catch
        {
            // teardown is best-effort
        }
    }
}

/** Drives a real chromium: it carries the browser session cookie, loads the served app, and awaits the live value. */
class BrowserProof
{
    private static readonly RenderTimeoutMs = 60000

    public static async AssertLiveValue(tenant: RuntimeTenant, needle: string): Promise<void>
    {
        const browser = await chromium.launch()
        try
        {
            await BrowserProof.Render(browser, tenant, needle)
        }
        finally
        {
            await browser.close()
        }
    }

    private static async Render(browser: Browser, tenant: RuntimeTenant, needle: string): Promise<void>
    {
        const context = await browser.newContext()
        const login = await context.request.post(tenant.BrowserLoginUrl, { data: { email: tenant.Email, password: tenant.Password } })
        assert.ok(login.ok())
        const page = await context.newPage()
        await page.goto(tenant.AppUrl)
        await page.getByText(needle).first().waitFor({ timeout: BrowserProof.RenderTimeoutMs })
    }
}

/** Shared expectations for the shaped deploy request and the live-only proof value. */
class HelloExpectation
{
    public static readonly LiveValue = 'hello from the tenant'
    public static readonly Version = '0.1.0'
    public static readonly PackageId = 'hello-app'
    public static readonly IndexFile = 'index.html'

    public static AssertDeployShape(built: BuiltHelloApp): void
    {
        const params = built.DeployParams()
        assert.equal(params.appName, HelloAppBuilder.AppName)
        assert.equal(params.appVersion, HelloExpectation.Version)
        assert.ok(params.packages.some(p => p.id === HelloExpectation.PackageId && p.version === HelloExpectation.Version))
        assert.ok(params.uiBundle.some(asset => asset.path === HelloExpectation.IndexFile))
        assert.equal(built.IndexHtml().includes(HelloExpectation.LiveValue), false)
    }
}

test('SP0 capstone: a remote app deploys to a Docker runtime tenant and a browser renders a live tenant value', { skip: !Gate.Enabled, timeout: 600000 }, async () =>
{
    RuntimeTenant.RequireImage()
    const tenant = new RuntimeTenant(await FreePort.Acquire())
    let built: BuiltHelloApp | undefined
    let client: PragmaticClient | undefined
    try
    {
        await tenant.StartAsync()
        built = await HelloAppBuilder.Build()
        HelloExpectation.AssertDeployShape(built)
        const bearer = await tenant.BearerAsync()
        client = await PragmaticClient.ConnectAsync(tenant.WsUrl, { bearerToken: bearer })
        const result = await client.DeployApplication(built.DeployParams())
        assert.equal(result.status, AppWriteStatus.Applied)
        await BrowserProof.AssertLiveValue(tenant, HelloExpectation.LiveValue)
    }
    finally
    {
        await client?.DisposeAsync()
        tenant.Stop()
        built?.Dispose()
    }
})
