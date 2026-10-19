import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { WebSocket } from 'ws'
import {
    PragmaticClient,
    AppWriteStatus,
    AppWriteOpKind,
    AdminProtocol,
    WsMessageSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
    createMessageConnection,
    NullLogger,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, SecurityModelDto, PrivilegeDto, AppWriteOpDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import { BundleBuilder, EnvKind, TenantPurposeName } from '../../../environments/seed/bundle.js'
import { Sp1AppBuilder } from './sp1-app-builder.js'
import type { BuiltSp1App } from './sp1-app-builder.js'

/** Opt-in gate for the SP1 capstone e2e (needs Docker + the pragmatic-server:sp1 image + a Playwright chromium). */
class Gate
{
    private static readonly Var = 'SP1_E2E'
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
 * The reader principal the RBAC proof denies, plus the distinctive field values the e2e writes and re-reads.
 * The reader is created at runtime through the admin protocol (CreateAccount + GrantRole Editor), so it ends up
 * an Editor-coarse account the browser/wire can log in as — reaching the per-concept gate, not the dispatch gate.
 */
class Sp1Accounts
{
    public static readonly ReaderPrincipalId = 'reader'
    public static readonly ReaderEmail = 'reader@sp1.test'
    public static readonly ReaderPassword = 'reader-e2e-pass-phrase-123'
    /** Coarse role that confers Write without Administer, so the reader's write is denied by the per-concept model, not dispatch. */
    public static readonly EditorRole = 'Editor'

    public static readonly TitleAlpha = 'sp1 task alpha'
    public static readonly TitleBeta = 'sp1 task beta edited'
    public static readonly TitleGamma = 'sp1 reader forbidden'
}

/**
 * The per-concept security model configured LIVE through the admin path: the admin principal gets
 * Create/Read/Update/Delete and the reader gets Read only, both at organization level on the deployed
 * concept. No per-concept roles are seeded at build time — this is applied after deploy to prove the
 * gate is real and the config path is load-bearing, and to prove the live authorizer reload (no restart).
 */
class Sp1SecurityModel
{
    private static readonly OrgUnitId = 'org'
    private static readonly OrgUnitName = 'Organization'
    private static readonly AdminPrincipalId = 'admin'
    private static readonly AdminRoleId = 'app-admin'
    private static readonly AdminRoleName = 'App Admin'
    private static readonly ReaderRoleId = 'app-reader'
    private static readonly ReaderRoleName = 'App Reader'

    public static Config(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: Sp1SecurityModel.OrgUnitId, name: Sp1SecurityModel.OrgUnitName }],
            teams: [],
            membership: {
                claimsMapping: [],
                overrides: [
                    { principalId: Sp1SecurityModel.AdminPrincipalId, homeBusinessUnit: Sp1SecurityModel.OrgUnitId, teams: [] },
                    { principalId: Sp1Accounts.ReaderPrincipalId, homeBusinessUnit: Sp1SecurityModel.OrgUnitId, teams: [] },
                ],
            },
            ownershipRules: [],
            roles: [
                { id: Sp1SecurityModel.AdminRoleId, name: Sp1SecurityModel.AdminRoleName, privileges: Sp1SecurityModel.Crud() },
                { id: Sp1SecurityModel.ReaderRoleId, name: Sp1SecurityModel.ReaderRoleName, privileges: [Sp1SecurityModel.Privilege(PrivilegeAction.Read)] },
            ],
            roleAssignment: {
                claimsMapping: [],
                overrides: [
                    { principalId: Sp1SecurityModel.AdminPrincipalId, roles: [Sp1SecurityModel.AdminRoleId] },
                    { principalId: Sp1Accounts.ReaderPrincipalId, roles: [Sp1SecurityModel.ReaderRoleId] },
                ],
                teamRoles: [],
            },
        }
    }

    private static Crud(): PrivilegeDto[]
    {
        return [PrivilegeAction.Create, PrivilegeAction.Read, PrivilegeAction.Update, PrivilegeAction.Delete].map(a => Sp1SecurityModel.Privilege(a))
    }

    private static Privilege(action: PrivilegeAction): PrivilegeDto
    {
        return { action, concept: Sp1AppBuilder.Concept, level: AccessLevel.Organization }
    }
}

/**
 * Stands up a one-tenant Runtime server inside the captured Docker image (same recipe as SP0): seeds a config
 * bundle, mounts it read-only, runs the published image, polls /healthz. Deliberately seeds NO security model,
 * so an identity-configured tenant fails closed until the admin configures roles live through the admin path.
 */
class RuntimeTenant
{
    private static readonly Image = 'pragmatic-server:sp1'
    private static readonly TenantId = 'sp1'
    private static readonly EnvName = 'sp1'
    private static readonly BundlePrefix = 'sp1-bundle-'
    private static readonly SeedPrefix = 'sp1-seed-'
    private static readonly NamePrefix = 'sp1-e2e-'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly MasterKeyFile = 'master.key'
    private static readonly TenantsFile = 'tenants.json'
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
    private static readonly DataDir = 'data'
    private static readonly DataMount = ':/home/pragmatic/data'
    private static readonly Loopback = 'http://localhost:'
    private static readonly HealthPath = '/healthz'
    private static readonly LoginPath = '/auth/login?tenant=sp1'
    private static readonly BrowserLoginPath = '/auth/browser-login?tenant=sp1'
    private static readonly AppPath = '/app/sp1/tasks/'
    private static readonly WsPath = '/?tenant=sp1'
    private static readonly WsScheme = 'ws://localhost:'
    private static readonly JsonHeader = { 'Content-Type': 'application/json' }
    private static readonly PostMethod = 'POST'
    private static readonly OkStatus = 200
    private static readonly HealthTimeoutMs = 120000
    private static readonly HealthPollMs = 1000
    private static readonly ImageMissing = 'the pragmatic-server:sp1 image is absent: build it first (DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<npmrc> -t pragmatic-server:sp1 .)'
    private static readonly HealthNeverReady = 'the runtime tenant container never reported /healthz=200'
    private static readonly PortEnv = 'PRAGMATIC_PORT=8080'
    private static readonly BaseDirEnv = 'PRAGMATIC_BASE_DIR=/home/pragmatic/data'
    private static readonly TenantsFileEnv = 'PRAGMATIC_TENANTS_FILE=/cfg/tenants.json'
    private static readonly MasterKeyEnv = 'PRAGMATIC_MASTER_KEY_FILE=/run/secrets/master_key'
    private static readonly SecretsEnv = 'PRAGMATIC_PROVISIONED_SECRETS_FILE=/cfg/provisioned-secrets.json'
    private static readonly DeploymentModeEnv = 'PRAGMATIC_DEPLOYMENT_MODE=local'
    private static readonly AllowedOriginsEnv = 'PRAGMATIC_ALLOWED_ORIGINS='
    private static readonly BearerScheme = 'Bearer '

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

    public get AdminEmail(): string
    {
        return BundleBuilder.AdminEmailPrefix + RuntimeTenant.TenantId + BundleBuilder.AdminEmailSuffix
    }

    public get AdminPassword(): string
    {
        const secrets = JSON.parse(readFileSync(join(this.bundleDir, RuntimeTenant.SecretsFile), RuntimeTenant.Utf8)) as Record<string, string>
        return secrets[RuntimeTenant.TenantId + BundleBuilder.AdminSecretSuffix]!
    }

    public get BearerHeaderPrefix(): string
    {
        return RuntimeTenant.BearerScheme
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
        // Intentionally seed NO security model: an identity-configured tenant with none fails closed, so the
        // admin's first create is denied until roles are configured live below (proving the gate + config path).
        await BundleBuilder.Generate(
            { name: RuntimeTenant.EnvName, kind: EnvKind.Dev, tenantId: RuntimeTenant.TenantId, purpose: TenantPurposeName.Runtime, hostPort: this.port },
            this.bundleDir, this.seedDir)
        execFileSync(RuntimeTenant.Docker, this.RunArgs(), { stdio: 'ignore' })
        this.started = true
        await this.WaitForHealthy()
    }

    /** Obtains a bearer token the way a Node client would, via the Bearer login route. */
    public async BearerFor(email: string, password: string): Promise<string>
    {
        const response = await fetch(this.Base + RuntimeTenant.LoginPath, {
            method: RuntimeTenant.PostMethod,
            headers: RuntimeTenant.JsonHeader,
            body: JSON.stringify({ email, password }),
        })
        assert.equal(response.status, RuntimeTenant.OkStatus)
        return ((await response.json()) as { token: string }).token
    }

    public AdminBearer(): Promise<string>
    {
        return this.BearerFor(this.AdminEmail, this.AdminPassword)
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

/**
 * A raw admin JSON-RPC connection (admin methods are not on PragmaticClient): opens an authenticated WebSocket
 * and sends the admin/* requests the capstone needs — create the reader account, grant it the coarse role, and
 * set the per-concept security model live.
 */
class AdminWire
{
    private static readonly OpenEvent = 'open'
    private static readonly ErrorEvent = 'error'
    private static readonly AuthHeader = 'authorization'

    private constructor(private readonly ws: WebSocket, private readonly connection: MessageConnection)
    {
    }

    public static async Connect(tenant: RuntimeTenant): Promise<AdminWire>
    {
        const bearer = await tenant.AdminBearer()
        const ws = new WebSocket(tenant.WsUrl, { headers: { [AdminWire.AuthHeader]: tenant.BearerHeaderPrefix + bearer } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once(AdminWire.OpenEvent, () => resolve())
            ws.once(AdminWire.ErrorEvent, reject)
        })
        const socket = new WsMessageSocket(ws)
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        connection.listen()
        return new AdminWire(ws, connection)
    }

    public async CreateAccount(email: string, principalId: string, password: string): Promise<void>
    {
        await this.connection.sendRequest(AdminProtocol.CreateAccount, { email, principalId, password })
    }

    public async GrantRole(subject: string, role: string): Promise<void>
    {
        await this.connection.sendRequest(AdminProtocol.GrantRole, { subject, role })
    }

    public async SetSecurityModel(securityModel: SecurityModelDto): Promise<void>
    {
        await this.connection.sendRequest(AdminProtocol.SetSecurityModel, { securityModel })
    }

    public Dispose(): void
    {
        this.connection.dispose()
        this.ws.close()
    }
}

/**
 * A data session for one principal: binds the deployed app (the same OpenApplication the generated app does),
 * then writes through WriteAppData and re-reads through the Cypher query the generated remote read leg uses.
 */
class DataSession
{
    private static readonly Query = 'MATCH (n) RETURN n'

    private constructor(private readonly client: PragmaticClient)
    {
    }

    public static async Open(tenant: RuntimeTenant, bearer: string): Promise<DataSession>
    {
        const client = await PragmaticClient.ConnectAsync(tenant.WsUrl, { bearerToken: bearer })
        await client.OpenApplication(Sp1AppBuilder.AppName)
        return new DataSession(client)
    }

    public Create(fields: Record<string, unknown>): Promise<AppWriteResultDto>
    {
        return this.Write({ op: AppWriteOpKind.Create, concept: Sp1AppBuilder.Concept, fields })
    }

    public Update(id: string, fields: Record<string, unknown>): Promise<AppWriteResultDto>
    {
        return this.Write({ op: AppWriteOpKind.Update, concept: Sp1AppBuilder.Concept, id, fields })
    }

    public Delete(id: string): Promise<AppWriteResultDto>
    {
        return this.Write({ op: AppWriteOpKind.Delete, concept: Sp1AppBuilder.Concept, id })
    }

    /** Serializes every row of the current read into one string; the caller asserts a title's presence/absence. */
    public async ReadDump(): Promise<string>
    {
        let dump = ''
        for await (const page of this.client.QueryAll(DataSession.Query))
        {
            dump += JSON.stringify(page.items)
        }
        return dump
    }

    public DisposeAsync(): Promise<void>
    {
        return this.client.DisposeAsync()
    }

    private Write(op: AppWriteOpDto): Promise<AppWriteResultDto>
    {
        return this.client.WriteAppData({ operations: [op] })
    }
}

/** Drives a real chromium: cookie-logs in as the given principal, loads the served app, and awaits the live value. */
class BrowserProof
{
    private static readonly RenderTimeoutMs = 60000

    public static async AssertSees(tenant: RuntimeTenant, email: string, password: string, needle: string): Promise<void>
    {
        const browser = await chromium.launch()
        try
        {
            await BrowserProof.Render(browser, tenant, email, password, needle)
        }
        finally
        {
            await browser.close()
        }
    }

    private static async Render(browser: Browser, tenant: RuntimeTenant, email: string, password: string, needle: string): Promise<void>
    {
        const context = await browser.newContext()
        const login = await context.request.post(tenant.BrowserLoginUrl, { data: { email, password } })
        assert.ok(login.ok())
        const page = await context.newPage()
        await page.goto(tenant.AppUrl)
        await page.getByText(needle).first().waitFor({ timeout: BrowserProof.RenderTimeoutMs })
    }
}

/** Asserts a single-op write result carried exactly one result with the expected status. */
class WriteAssert
{
    public static Status(result: AppWriteResultDto, expected: AppWriteStatus): string | undefined
    {
        assert.equal(result.results.length, 1)
        assert.equal(result.results[0]!.status, expected)
        return result.results[0]!.id
    }
}

test('SP1 capstone: generate a per-concept CRUD app, configure roles live, admin CRUD + reader RBAC denial', { skip: !Gate.Enabled, timeout: 900000 }, async () =>
{
    RuntimeTenant.RequireImage()
    const tenant = new RuntimeTenant(await FreePort.Acquire())
    let built: BuiltSp1App | undefined
    let deployClient: PragmaticClient | undefined
    let admin: DataSession | undefined
    let reader: DataSession | undefined
    let adminWire: AdminWire | undefined
    try
    {
        await tenant.StartAsync()

        // (b) Build the GENERATED per-concept CRUD app and deploy it.
        built = await Sp1AppBuilder.Build()
        deployClient = await PragmaticClient.ConnectAsync(tenant.WsUrl, { bearerToken: await tenant.AdminBearer() })
        const deployed = await deployClient.DeployApplication(built.DeployParams())
        assert.equal(deployed.status, AppWriteStatus.Applied)

        // (c) Before any role config, an admin create is DENIED — the per-concept gate is real.
        admin = await DataSession.Open(tenant, await tenant.AdminBearer())
        WriteAssert.Status(await admin.Create({ [Sp1AppBuilder.TitleField]: Sp1Accounts.TitleAlpha }), AppWriteStatus.Denied)

        // (d) Seed the reader and configure roles LIVE through the admin path (no redeploy / restart).
        adminWire = await AdminWire.Connect(tenant)
        await adminWire.CreateAccount(Sp1Accounts.ReaderEmail, Sp1Accounts.ReaderPrincipalId, Sp1Accounts.ReaderPassword)
        await adminWire.GrantRole(Sp1Accounts.ReaderPrincipalId, Sp1Accounts.EditorRole)
        await adminWire.SetSecurityModel(Sp1SecurityModel.Config())

        // (e) Admin CRUD takes effect live on the already-open connection: create -> read -> edit -> read.
        const id = WriteAssert.Status(await admin.Create({ [Sp1AppBuilder.TitleField]: Sp1Accounts.TitleAlpha }), AppWriteStatus.Applied)!
        assert.ok((await admin.ReadDump()).includes(Sp1Accounts.TitleAlpha))

        WriteAssert.Status(await admin.Update(id, { [Sp1AppBuilder.TitleField]: Sp1Accounts.TitleBeta }), AppWriteStatus.Applied)
        const afterEdit = await admin.ReadDump()
        assert.ok(afterEdit.includes(Sp1Accounts.TitleBeta))
        assert.equal(afterEdit.includes(Sp1Accounts.TitleAlpha), false)

        // The served, generated app renders the live edited value to a real admin browser session.
        await BrowserProof.AssertSees(tenant, tenant.AdminEmail, tenant.AdminPassword, Sp1Accounts.TitleBeta)

        // (f) A read-only reader's create/edit/delete are each DENIED, and the row is unchanged.
        reader = await DataSession.Open(tenant, await tenant.BearerFor(Sp1Accounts.ReaderEmail, Sp1Accounts.ReaderPassword))
        WriteAssert.Status(await reader.Create({ [Sp1AppBuilder.TitleField]: Sp1Accounts.TitleGamma }), AppWriteStatus.Denied)
        WriteAssert.Status(await reader.Update(id, { [Sp1AppBuilder.TitleField]: Sp1Accounts.TitleGamma }), AppWriteStatus.Denied)
        WriteAssert.Status(await reader.Delete(id), AppWriteStatus.Denied)
        const afterReader = await admin.ReadDump()
        assert.ok(afterReader.includes(Sp1Accounts.TitleBeta))
        assert.equal(afterReader.includes(Sp1Accounts.TitleGamma), false)

        // (e cont.) Admin deletes the row; the re-read confirms it is gone.
        WriteAssert.Status(await admin.Delete(id), AppWriteStatus.Applied)
        assert.equal((await admin.ReadDump()).includes(Sp1Accounts.TitleBeta), false)
    }
    finally
    {
        await admin?.DisposeAsync()
        await reader?.DisposeAsync()
        adminWire?.Dispose()
        await deployClient?.DisposeAsync()
        tenant.Stop()
        built?.Dispose()
    }
})
