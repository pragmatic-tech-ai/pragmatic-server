import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { PragmaticClient, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { BaseRole, type ISecurityModelConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import { BundleBuilder, EnvKind, EnvironmentPurposeName } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HelloAppBuilder, type BuiltHelloApp } from './hello-app-builder.js'

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
 * The runtime environment's security model (tier 1). An identity-configured environment with NO security setting fails closed
 * (the empty model: every runtime scope is deny-all), so the authenticated admin would see nothing. This seeds the
 * minimum that lets the bootstrapped admin read the deployed app: the admin holds the SystemAdministrator base role,
 * which reads every concept unrestricted. A narrower, per-concept admin-read mechanism for non-administrators without
 * hand-authoring package roles remains a deferred v1 Feature.
 */
class RuntimeSecurityModel
{
    private static readonly AdminPrincipalId = 'admin'
    private static readonly OrgUnitId = 'org'
    private static readonly OrgUnitName = 'Organization'

    public static Config(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: RuntimeSecurityModel.OrgUnitId, name: RuntimeSecurityModel.OrgUnitName }],
            users: [{ principalId: RuntimeSecurityModel.AdminPrincipalId, businessUnitId: RuntimeSecurityModel.OrgUnitId }],
            teams: [],
            roleAssignments: [{ role: BaseRole.SystemAdministrator, principalIds: [RuntimeSecurityModel.AdminPrincipalId], teamIds: [] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: [],
        }
    }
}

/**
 * Stands up a one-environment Runtime server inside the captured Docker image, following the recipe: it seeds a config bundle,
 * mounts it read-only, runs the published image with a unique container, and polls /healthz. The base dir points at the
 * non-root runtime user's own home (a writable, ephemeral location) rather than a fresh Docker volume: a plain named
 * volume mounts into /data owned by root, which the image's non-root user (uid 10001) cannot write, so the first environment
 * materialization would fail. A real deployment supplies a volume whose ownership the runtime user can write (an
 * orchestrator fsGroup / init chown); this ephemeral test needs no persistence and so avoids the volume entirely.
 */
class RuntimeEnvironment
{
    private static readonly Image = 'pragmatic-server:sp0'
    private static readonly EnvironmentId = 'sp0'
    private static readonly EnvName = 'sp0'
    private static readonly BundlePrefix = 'sp0-bundle-'
    private static readonly SeedPrefix = 'sp0-seed-'
    private static readonly NamePrefix = 'sp0-e2e-'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly MasterKeyFile = 'master.key'
    private static readonly EnvironmentsFile = 'environments.json'
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
    private static readonly EnvironmentsMount = ':/cfg/environments.json:ro'
    private static readonly SecretsMount = ':/cfg/provisioned-secrets.json:ro'
    private static readonly MasterKeyMount = ':/run/secrets/master_key:ro'
    // The generated bundle's data dir holds identity/realm-config.json (with the security model) and is also
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
    private static readonly HealthNeverReady = 'the runtime environment container never reported /healthz=200'
    private static readonly PortEnv = 'PRAGMATIC_PORT=8080'
    private static readonly BaseDirEnv = 'PRAGMATIC_BASE_DIR=/home/pragmatic/data'
    private static readonly EnvironmentsFileEnv = 'PRAGMATIC_ENVIRONMENTS_FILE=/cfg/environments.json'
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
        this.bundleDir = mkdtempSync(join(tmpdir(), RuntimeEnvironment.BundlePrefix))
        this.seedDir = mkdtempSync(join(tmpdir(), RuntimeEnvironment.SeedPrefix))
        this.container = RuntimeEnvironment.NamePrefix + unique
    }

    public get Base(): string
    {
        return RuntimeEnvironment.Loopback + this.port
    }

    public get WsUrl(): string
    {
        return RuntimeEnvironment.WsScheme + this.port + RuntimeEnvironment.WsPath
    }

    public get Origin(): string
    {
        return RuntimeEnvironment.Loopback + this.port
    }

    public get AppUrl(): string
    {
        return this.Base + RuntimeEnvironment.AppPath
    }

    public get BrowserLoginUrl(): string
    {
        return this.Base + RuntimeEnvironment.BrowserLoginPath
    }

    public get Email(): string
    {
        return BundleBuilder.AdminEmailPrefix + RuntimeEnvironment.EnvironmentId + BundleBuilder.AdminEmailSuffix
    }

    public get Password(): string
    {
        const secrets = JSON.parse(readFileSync(join(this.bundleDir, RuntimeEnvironment.SecretsFile), RuntimeEnvironment.Utf8)) as Record<string, string>
        return secrets[RuntimeEnvironment.EnvironmentId + BundleBuilder.AdminSecretSuffix]!
    }

    public static RequireImage(): void
    {
        try
        {
            execFileSync(RuntimeEnvironment.Docker, [RuntimeEnvironment.ImageInspect, RuntimeEnvironment.InspectVerb, RuntimeEnvironment.Image], { stdio: 'ignore' })
        }
        catch
        {
            throw new Error(RuntimeEnvironment.ImageMissing)
        }
    }

    public async StartAsync(): Promise<void>
    {
        // Seed the environment's security model before Generate reads it: without one, an identity-configured environment denies
        // all reads and the browser's live query would come back empty.
        writeFileSync(join(this.seedDir, RuntimeEnvironment.SecurityModelFile), JSON.stringify(RuntimeSecurityModel.Config()))
        await BundleBuilder.Generate(
            { name: RuntimeEnvironment.EnvName, kind: EnvKind.Dev, environmentId: RuntimeEnvironment.EnvironmentId, purpose: EnvironmentPurposeName.Runtime, hostPort: this.port },
            this.bundleDir, this.seedDir)
        execFileSync(RuntimeEnvironment.Docker, this.RunArgs(), { stdio: 'ignore' })
        this.started = true
        await this.WaitForHealthy()
    }

    /** Obtains an admin bearer token the way a Node publisher would, via the Bearer login route. */
    public async BearerAsync(): Promise<string>
    {
        const response = await fetch(this.Base + RuntimeEnvironment.LoginPath, {
            method: RuntimeEnvironment.PostMethod,
            headers: RuntimeEnvironment.JsonHeader,
            body: JSON.stringify({ email: this.Email, password: this.Password }),
        })
        assert.equal(response.status, RuntimeEnvironment.OkStatus)
        return ((await response.json()) as { token: string }).token
    }

    public Stop(): void
    {
        if (this.started)
        {
            RuntimeEnvironment.Quiet(() => execFileSync(RuntimeEnvironment.Docker, [RuntimeEnvironment.RemoveVerb, RuntimeEnvironment.ForceFlag, this.container], { stdio: 'ignore' }))
        }
        RuntimeEnvironment.Quiet(() => rmSync(this.bundleDir, { recursive: true, force: true }))
        RuntimeEnvironment.Quiet(() => rmSync(this.seedDir, { recursive: true, force: true }))
    }

    private RunArgs(): string[]
    {
        return [
            RuntimeEnvironment.RunVerb, RuntimeEnvironment.RunFlag, RuntimeEnvironment.NameFlag, this.container,
            RuntimeEnvironment.PortFlag, this.port + ':' + RuntimeEnvironment.ContainerPort,
            RuntimeEnvironment.VolumeFlag, join(this.bundleDir, RuntimeEnvironment.EnvironmentsFile) + RuntimeEnvironment.EnvironmentsMount,
            RuntimeEnvironment.VolumeFlag, join(this.bundleDir, RuntimeEnvironment.SecretsFile) + RuntimeEnvironment.SecretsMount,
            RuntimeEnvironment.VolumeFlag, join(this.bundleDir, RuntimeEnvironment.MasterKeyFile) + RuntimeEnvironment.MasterKeyMount,
            RuntimeEnvironment.VolumeFlag, join(this.bundleDir, RuntimeEnvironment.DataDir) + RuntimeEnvironment.DataMount,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.BaseDirEnv,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.EnvironmentsFileEnv,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.MasterKeyEnv,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.SecretsEnv,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.PortEnv,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.DeploymentModeEnv,
            RuntimeEnvironment.EnvFlag, RuntimeEnvironment.AllowedOriginsEnv + this.Origin,
            RuntimeEnvironment.Image,
        ]
    }

    private async WaitForHealthy(): Promise<void>
    {
        const deadline = Date.now() + RuntimeEnvironment.HealthTimeoutMs
        while (Date.now() < deadline)
        {
            if (await this.Healthy())
            {
                return
            }
            await new Promise<void>(resolve => setTimeout(resolve, RuntimeEnvironment.HealthPollMs))
        }
        throw new Error(RuntimeEnvironment.HealthNeverReady)
    }

    private async Healthy(): Promise<boolean>
    {
        try
        {
            return (await fetch(this.Base + RuntimeEnvironment.HealthPath)).status === RuntimeEnvironment.OkStatus
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

    public static async AssertLiveValue(environment: RuntimeEnvironment, needle: string): Promise<void>
    {
        const browser = await chromium.launch()
        try
        {
            await BrowserProof.Render(browser, environment, needle)
        }
        finally
        {
            await browser.close()
        }
    }

    private static async Render(browser: Browser, environment: RuntimeEnvironment, needle: string): Promise<void>
    {
        const context = await browser.newContext()
        const login = await context.request.post(environment.BrowserLoginUrl, { data: { email: environment.Email, password: environment.Password } })
        assert.ok(login.ok())
        const page = await context.newPage()
        await page.goto(environment.AppUrl)
        await page.getByText(needle).first().waitFor({ timeout: BrowserProof.RenderTimeoutMs })
    }
}

/** Shared expectations for the shaped deploy request and the live-only proof value. */
class HelloExpectation
{
    public static readonly LiveValue = 'hello from the environment'
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

test('SP0 capstone: a remote app deploys to a Docker runtime environment and a browser renders a live environment value', { skip: !Gate.Enabled, timeout: 600000 }, async () =>
{
    RuntimeEnvironment.RequireImage()
    const environment = new RuntimeEnvironment(await FreePort.Acquire())
    let built: BuiltHelloApp | undefined
    let client: PragmaticClient | undefined
    try
    {
        await environment.StartAsync()
        built = await HelloAppBuilder.Build()
        HelloExpectation.AssertDeployShape(built)
        const bearer = await environment.BearerAsync()
        client = await PragmaticClient.ConnectAsync(environment.WsUrl, { bearerToken: bearer })
        const result = await client.DeployApplication(built.DeployParams())
        assert.equal(result.status, AppWriteStatus.Applied)
        await BrowserProof.AssertLiveValue(environment, HelloExpectation.LiveValue)
    }
    finally
    {
        await client?.DisposeAsync()
        environment.Stop()
        built?.Dispose()
    }
})
