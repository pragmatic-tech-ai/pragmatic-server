/**
 * GATED integration smoke for the control plane. NOT part of `tsx --test`.
 *
 * Requires Docker running and the `pragmatic-server:dev` image built (one-time build:
 * see admin/README.md). Run with:
 *
 *   npx tsx admin/control-plane/control-plane-smoke.ts
 *
 * Composes the real stack in-process (as server.ts does), then drives the control-plane
 * HTTP API through create/start/stop/delete for dev-blank and demo-contoso, and verifies
 * the seeded demo users over the admin protocol.
 */
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Repository, toJSON } from '@pragmatic-tech-ai/todl'
import type { PackageDocument } from '@pragmatic-tech-ai/todl'
import { RemoteBindMode } from '@pragmatic-tech-ai/todl/build-system-core'
import { AdminProtocol, AppWriteStatus, CypherProtocol, GraphProtocol, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ContributedPackageDto, GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { BuiltHelloApp } from '../../src/tests/e2e/hello-app-builder.js'
import { HelloAppBuilder } from '../../src/tests/e2e/hello-app-builder.js'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ControlPlaneHost } from './control-plane-host.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { ManifestRegistry } from './manifest-record.js'
import { GatingRegistry } from './gating-record.js'
import { SelectionRegistry } from './selection-record.js'
import { RolloutReportRegistry } from './rollout-report-record.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import type { EnvironmentDto, MakerTokenDto, PromotionResultDto } from './control-plane-host.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import { ClientRegistry } from './client-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { TenantRegistry } from './tenant-registry.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { GraphService } from './graph-service.js'
import { OperatorIdentity } from './operator-identity.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'

type HttpResult = { status: number; json: unknown; setCookie: string[] }

interface TenantsShape
{
    tenants: Record<string, { purpose: number } | undefined>
}

export class ControlPlaneSmoke
{
    private static readonly LoopbackHost = '127.0.0.1'
    private static readonly EnvPortFloor = 8100
    private static readonly TempPrefix = 'cp-smoke-'
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly ReportsFile = 'rollout-reports.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly PlatformTenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly StaticDir = 'static'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly Utf8 = 'utf8'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly DevPurpose = 0
    private static readonly DemoPurpose = 1
    private static readonly EnvironmentsPath = '/api/environments'
    private static readonly PathSep = '/'
    private static readonly StopAction = '/stop'
    private static readonly StartAction = '/start'
    private static readonly HealthPath = '/healthz'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodDelete = 'DELETE'
    private static readonly JsonContentType = 'application/json'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly DevName = 'smoke-dev'
    private static readonly DemoName = 'smoke-demo'
    private static readonly DemoTenant = 'contoso'
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly AdminEmail = 'admin@contoso.test'
    private static readonly AdminPwKey = 'contoso-admin-pw'
    private static readonly DemoPrincipals: readonly string[] = ['rep-boston', 'rep-atlanta', 'manager-north', 'finance']
    private static readonly OperatorEmail = 'smoke-operator@control-plane.test'
    private static readonly OperatorPassword = 'smoke-operator-test-password'
    private static readonly IdentityDir = 'identity'
    private static readonly MasterKeyFile = 'master.key'
    private static readonly LoginPath = '/api/login'
    private static readonly SessionCookieName = 'cp_session'
    private static readonly CookieHeader = 'Cookie'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly CookieAttrSep = ';'
    private static readonly StatusOk = 200
    private static readonly StatusUnauthorized = 401
    private static readonly StatusCreated = 201
    private static readonly StatusConflict = 409
    private static readonly MethodPut = 'PUT'
    private static readonly AdminSegment = '/admin/'
    private static readonly SnapshotLeaf = 'snapshot'
    private static readonly AccountsLeaf = 'accounts'
    private static readonly GrantsLeaf = 'grants'
    private static readonly ConfigLeaf = 'config'
    private static readonly ManagedPrincipal = 'smoke-managed'
    private static readonly ManagedEmail = 'smoke-managed@contoso.test'
    private static readonly ManagedPassword = 'smoke-managed-test-password'
    private static readonly ViewerRole = 'Viewer'
    private static readonly OwnerRole = 'Owner'
    private static readonly TenantKind = 'Tenant'
    private static readonly OwnerSubject = 'admin'
    private static readonly PollTimeoutMs = 90000
    private static readonly PollIntervalMs = 1000
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TimeoutPrefix = 'timed out waiting for '
    private static readonly StatusWord = ' status='
    private static readonly MissingOpen = ' missing=['
    private static readonly MissingClose = '] admin='
    private static readonly Comma = ','
    private static readonly PackagesWord = ' packages='
    private static readonly EmptyString = ''
    private static readonly PromoteDevName = 'smoke-promote-dev'
    private static readonly PromoteRuntimeName = 'smoke-promote-rt'
    private static readonly PromoteGraphName = 'smoke-graph'
    private static readonly PromoteGraphDescription = 'smoke promotion graph'
    private static readonly PromoteSolutionId = 'smoke-solution'
    private static readonly PromoteNamespace = 'smokepromo'
    private static readonly PromoteVersion = '1.0.0'
    private static readonly PromoteConcept = 'Widget'
    private static readonly PromoteBaseConcept = 'Element'
    private static readonly PromoteInstanceSuffix = '.one'
    private static readonly PromoteCypher = 'MATCH (w:Widget) RETURN count(w) AS n'
    private static readonly RepromoteSolutionId = 'smoke-solution-2'
    private static readonly RepromoteNamespace = 'smokepromo2'
    private static readonly RepromoteConcept = 'Gadget'
    private static readonly RepromoteCypher = 'MATCH (g:Gadget) RETURN count(g) AS n'
    private static readonly BundledCypher = 'MATCH (g:greeting) RETURN count(g) AS n'
    private static readonly RepromotedPackageCount = 2
    private static readonly EnvAppName = 'hello-env'
    private static readonly EnvReaderPrincipal = 'env-reader'
    private static readonly EnvReaderEmail = 'env-reader@contoso.test'
    private static readonly EnvReaderPassword = 'env-reader-test-password'
    private static readonly AckOkWord = 'ok='
    private static readonly WsTenantQuery = '/?environment='
    private static readonly GraphsSegment = '/graphs'
    private static readonly PromoteSegment = '/promote'
    private static readonly MakerTokenAction = '/maker-token'
    private static readonly LoadedGraphAction = '/loaded-graph'
    private static readonly PromotedPackageCount = 1
    private static readonly PromoteExpectedRows = 1
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly Labels = {
        Gate401: 'control plane: unauthenticated request returns 401',
        Login: 'control plane: operator login returns 200 and a session cookie',
        CreateDev: 'dev-blank: create returns 201',
        RunningDev: 'dev-blank: reaches running',
        HealthDev: 'dev-blank: /healthz returns 200',
        StopDev: 'dev-blank: stop returns 200',
        StoppedDev: 'dev-blank: reaches stopped',
        StartDev: 'dev-blank: start returns 200',
        RestartedDev: 'dev-blank: running again after start',
        DeleteDev: 'dev-blank: delete returns 200',
        GoneDev: 'dev-blank: no longer listed',
        CreateDemo: 'demo-contoso: create returns 201',
        RunningDemo: 'demo-contoso: reaches running',
        HealthDemo: 'demo-contoso: /healthz returns 200',
        SeededDemo: 'demo-contoso: four demo principals plus admin seeded',
        DeleteDemo: 'demo-contoso: delete returns 200',
        GoneDemo: 'demo-contoso: no longer listed',
        PurposeDev: 'dev-blank: tenants.json purpose is Development (0)',
        PurposeDemo: 'demo-contoso: tenants.json purpose is Runtime (1)',
        ManageSnapshot: 'manage: snapshot returns 200 with admin, demo principals and config',
        ManageCreate: 'manage: create account returns 201',
        ManageListed: 'manage: new account appears in snapshot',
        ManageGrant: 'manage: grant Viewer returns 200',
        ManageRevoke: 'manage: revoke Viewer returns 200',
        ManageGetConfig: 'manage: get config returns 200',
        ManagePutConfig: 'manage: put unchanged config returns 200',
        ManageLockout: 'manage: revoking own Owner grant is refused with 409',
        PromoteCreateDev: 'promote: development env create returns 201 and reaches running',
        PromoteCreateGraph: 'promote: create graph on dev env returns 201',
        PromoteMakerToken: 'promote: maker token mint returns 201 with a token',
        PromoteContribute: 'promote: graph/contribute with maker token returns the graph with its package',
        PromoteCreateRuntime: 'promote: runtime env create returns 201 and reaches running',
        PromoteResult: 'promote: promote returns 200 with graph name, package count and target env',
        PromoteLoaded: 'promote: loaded-graph on the runtime reflects the promoted graph',
        PromoteCypherRead: 'promote: cypher query on the runtime env graph returns the promoted content',
        EnvAppAdminLogin: 'env-app: runtime admin login',
        EnvAppNoAdminPw: 'env-app: provisioned runtime admin password is present',
        EnvAppError: 'env-app: step failed with an unexpected error',
        EnvAppDeploy: 'env-app: environment-bound app deploys to the runtime env',
        EnvAppBundledDeploy: 'env-app: bundled (application-bound) app deploys to the same runtime env',
        EnvAppReaderCreate: 'env-app: runtime reader account created and granted Viewer at Tenant scope',
        EnvAppRead: 'env-app: Viewer reads the promoted env graph with no OpenApplication',
        EnvAppRepromote: 'env-app: re-promote of the changed graph returns 200 with both packages',
        EnvAppLiveRead: 'env-app: same reader connection sees the re-promoted content with no redeploy',
        EnvAppBundledRead: 'env-app: bundled app still reads its own per-app graph unchanged',
        PromoteDeleteDev: 'promote: development env delete returns 200',
        PromoteDeleteRuntime: 'promote: runtime env delete returns 200'
    }

    private failed = false
    private controlPort = 0
    private sessionCookie = ControlPlaneSmoke.EmptyString

    public static async Main(): Promise<void>
    {
        const smoke = new ControlPlaneSmoke()
        const ok = await smoke.Run()
        console.log(ok ? ControlPlaneSmoke.OverallPass : ControlPlaneSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const dataRoot = mkdtempSync(join(tmpdir(), ControlPlaneSmoke.TempPrefix))
        const staticRoot = join(dataRoot, ControlPlaneSmoke.StaticDir)
        mkdirSync(staticRoot, { recursive: true })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, ControlPlaneSmoke.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dataRoot, ControlPlaneSmoke.ClientsFile)),
            new TenantRegistry(join(dataRoot, ControlPlaneSmoke.PlatformTenantsFile)),
            new HiveRegistry(join(dataRoot, ControlPlaneSmoke.HivesFile)),
            registry)
        await directory.Load()
        const allocator = new PortAllocator(ControlPlaneSmoke.EnvPortFloor, new NetPortProbe())
        const proxy = new AdminProxy(new WsAdminConnector())
        const service = new EnvironmentService(registry, allocator, docker, new BundleBuilderAdapter(), new UserSeederAdapter(new UserSeeder()), dataRoot, proxy)
        const operator = await OperatorIdentity.Compose({
            identityRoot: join(dataRoot, ControlPlaneSmoke.IdentityDir),
            masterKeyFile: join(dataRoot, ControlPlaneSmoke.MasterKeyFile),
            operatorEmail: ControlPlaneSmoke.OperatorEmail,
            initialPassword: ControlPlaneSmoke.OperatorPassword
        })
        const orchestrators = new HiveOrchestratorFactory()
        const manifests = new ManifestRegistry(join(dataRoot, ControlPlaneSmoke.ManifestsFile))
        const gating = new GatingRegistry(join(dataRoot, ControlPlaneSmoke.GatingFile))
        const selections = new SelectionRegistry(join(dataRoot, ControlPlaneSmoke.SelectionsFile))
        const reports = new RolloutReportRegistry(join(dataRoot, ControlPlaneSmoke.ReportsFile))
        const registrations = new RolloutRegistrationRegistry(join(dataRoot, ControlPlaneSmoke.RegistrationsFile))
        await Promise.all([manifests.Load(), gating.Load(), selections.Load(), reports.Load(), registrations.Load()])
        const deployments = new PlatformDeploymentRegistry(manifests, gating, selections, reports, registrations, directory, orchestrators, registry, new EnvironmentPlacement(directory))
        const host = new ControlPlaneHost(service, new GraphService(registry, proxy, name => service.AdminInfoFor(name)), staticRoot, operator, false, directory, orchestrators, deployments)
        try
        {
            await host.Listen(0, ControlPlaneSmoke.LoopbackHost)
            this.controlPort = host.Address().port
            if (await this.Authenticate())
            {
                await this.DevLifecycle(dataRoot)
                await this.DemoSeeded(dataRoot)
                await this.PromotionRoundTrip(dataRoot)
            }
        }
        catch (err)
        {
            this.failed = true
            console.log(ControlPlaneSmoke.CrashPrefix + (err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await this.Cleanup()
            await host.Close()
            rmSync(dataRoot, { recursive: true, force: true })
        }
        return !this.failed
    }

    /** Asserts the auth gate is live, then logs in and stores the session cookie; false when no session. */
    private async Authenticate(): Promise<boolean>
    {
        const gated = await this.Api(ControlPlaneSmoke.MethodGet, ControlPlaneSmoke.EnvironmentsPath)
        this.Expect(ControlPlaneSmoke.Labels.Gate401, gated.status === ControlPlaneSmoke.StatusUnauthorized, ControlPlaneSmoke.StatusWord + String(gated.status))
        const login = await this.Api(ControlPlaneSmoke.MethodPost, ControlPlaneSmoke.LoginPath, { email: ControlPlaneSmoke.OperatorEmail, password: ControlPlaneSmoke.OperatorPassword })
        const prefix = ControlPlaneSmoke.SessionCookieName + '='
        const pair = login.setCookie.map(c => c.split(ControlPlaneSmoke.CookieAttrSep)[0]).find(c => c.startsWith(prefix))
        this.Expect(ControlPlaneSmoke.Labels.Login, login.status === ControlPlaneSmoke.StatusOk && pair !== undefined, ControlPlaneSmoke.StatusWord + String(login.status))
        if (pair === undefined)
        {
            return false
        }
        this.sessionCookie = pair
        return true
    }

    /** Best-effort removal of both smoke environments so a rerun starts clean. */
    private async Cleanup(): Promise<void>
    {
        for (const name of [ControlPlaneSmoke.DevName, ControlPlaneSmoke.DemoName, ControlPlaneSmoke.PromoteDevName, ControlPlaneSmoke.PromoteRuntimeName])
        {
            try
            {
                await this.Api(ControlPlaneSmoke.MethodDelete, this.EnvPath(name))
            }
            catch
            {
                // already gone or unreachable: ignore
            }
        }
    }

    private async DevLifecycle(dataRoot: string): Promise<void>
    {
        const L = ControlPlaneSmoke.Labels
        const name = ControlPlaneSmoke.DevName
        const created = await this.Api(ControlPlaneSmoke.MethodPost, ControlPlaneSmoke.EnvironmentsPath, { name, template: Template.DevBlank, type: EnvType.Development })
        this.Expect(L.CreateDev, created.status === ControlPlaneSmoke.StatusCreated, ControlPlaneSmoke.StatusWord + String(created.status))
        const running = await this.WaitFor(name, EnvStatus.Running)
        this.Expect(L.RunningDev, running !== undefined)
        if (running === undefined)
        {
            return
        }
        await this.CheckHealth(L.HealthDev, running.hostPort)
        this.CheckPurpose(L.PurposeDev, dataRoot, name, name, ControlPlaneSmoke.DevPurpose)
        const stop = await this.Api(ControlPlaneSmoke.MethodPost, this.EnvPath(name) + ControlPlaneSmoke.StopAction)
        this.Expect(L.StopDev, stop.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(stop.status))
        this.Expect(L.StoppedDev, (await this.WaitFor(name, EnvStatus.Stopped)) !== undefined)
        const start = await this.Api(ControlPlaneSmoke.MethodPost, this.EnvPath(name) + ControlPlaneSmoke.StartAction)
        this.Expect(L.StartDev, start.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(start.status))
        this.Expect(L.RestartedDev, (await this.WaitFor(name, EnvStatus.Running)) !== undefined)
        const del = await this.Api(ControlPlaneSmoke.MethodDelete, this.EnvPath(name))
        this.Expect(L.DeleteDev, del.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(del.status))
        this.Expect(L.GoneDev, (await this.Find(name)) === undefined)
    }

    private async DemoSeeded(dataRoot: string): Promise<void>
    {
        const L = ControlPlaneSmoke.Labels
        const name = ControlPlaneSmoke.DemoName
        const created = await this.Api(ControlPlaneSmoke.MethodPost, ControlPlaneSmoke.EnvironmentsPath, { name, template: Template.DemoContoso, type: EnvType.Runtime })
        this.Expect(L.CreateDemo, created.status === ControlPlaneSmoke.StatusCreated, ControlPlaneSmoke.StatusWord + String(created.status))
        const running = await this.WaitFor(name, EnvStatus.Running)
        this.Expect(L.RunningDemo, running !== undefined)
        if (running === undefined)
        {
            return
        }
        await this.CheckHealth(L.HealthDemo, running.hostPort)
        this.CheckPurpose(L.PurposeDemo, dataRoot, name, ControlPlaneSmoke.DemoTenant, ControlPlaneSmoke.DemoPurpose)
        await this.CheckSeeded(dataRoot, running.hostPort)
        await this.ManageRoundTrip(name)
        const del = await this.Api(ControlPlaneSmoke.MethodDelete, this.EnvPath(name))
        this.Expect(L.DeleteDemo, del.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(del.status))
        this.Expect(L.GoneDemo, (await this.Find(name)) === undefined)
    }

    /** End to end: dev graph + maker contribute, promote into a runtime env, then read the loaded env graph. */
    private async PromotionRoundTrip(dataRoot: string): Promise<void>
    {
        const S = ControlPlaneSmoke
        const L = S.Labels
        const dev = S.PromoteDevName
        const runtime = S.PromoteRuntimeName
        const graph = S.PromoteGraphName
        const devCreated = await this.Api(S.MethodPost, S.EnvironmentsPath, { name: dev, template: Template.DevBlank, type: EnvType.Development })
        const devRunning = devCreated.status === S.StatusCreated ? await this.WaitFor(dev, EnvStatus.Running) : undefined
        this.Expect(L.PromoteCreateDev, devRunning !== undefined, S.StatusWord + String(devCreated.status))
        if (devRunning === undefined)
        {
            return
        }
        const madeGraph = await this.Api(S.MethodPost, this.EnvPath(dev) + S.GraphsSegment, { name: graph, description: S.PromoteGraphDescription })
        this.Expect(L.PromoteCreateGraph, madeGraph.status === S.StatusCreated, S.StatusWord + String(madeGraph.status))
        const minted = await this.Api(S.MethodPost, this.EnvPath(dev) + S.MakerTokenAction)
        const makerToken = (minted.json as MakerTokenDto | undefined)?.token ?? S.EmptyString
        this.Expect(L.PromoteMakerToken, minted.status === S.StatusCreated && makerToken !== S.EmptyString, S.StatusWord + String(minted.status))
        if (makerToken === S.EmptyString)
        {
            return
        }
        await this.ContributeAs(devRunning.hostPort, dev, makerToken, S.PromoteSolutionId, S.FixturePackage(), S.PromotedPackageCount)

        const rtCreated = await this.Api(S.MethodPost, S.EnvironmentsPath, { name: runtime, template: Template.DemoContoso, type: EnvType.Runtime })
        const rtRunning = rtCreated.status === S.StatusCreated ? await this.WaitFor(runtime, EnvStatus.Running) : undefined
        this.Expect(L.PromoteCreateRuntime, rtRunning !== undefined, S.StatusWord + String(rtCreated.status))
        if (rtRunning === undefined)
        {
            return
        }
        const promotePath = this.EnvPath(dev) + S.GraphsSegment + S.PathSep + encodeURIComponent(graph) + S.PromoteSegment
        const promoted = await this.Api(S.MethodPost, promotePath, { targetEnv: runtime })
        const result = promoted.json as PromotionResultDto | undefined
        const resultOk = promoted.status === S.StatusOk && result?.graphName === graph && result.packageCount === S.PromotedPackageCount && result.targetEnv === runtime
        this.Expect(L.PromoteResult, resultOk, S.StatusWord + String(promoted.status))
        const loadedRes = await this.Api(S.MethodGet, this.EnvPath(runtime) + S.LoadedGraphAction)
        const loaded = loadedRes.json as GraphLoadedDto | null | undefined
        const loadedOk = loadedRes.status === S.StatusOk && loaded?.name === graph && loaded.packages.length === S.PromotedPackageCount && (loaded.promotedAt ?? S.EmptyString) !== S.EmptyString
        this.Expect(L.PromoteLoaded, loadedOk, S.StatusWord + String(loadedRes.status))
        await this.CheckRuntimeGraphRead(dataRoot, rtRunning.hostPort)
        await this.RemoteEnvAppRoundTrip(dataRoot, devRunning.hostPort, rtRunning.hostPort, makerToken)

        const delDev = await this.Api(S.MethodDelete, this.EnvPath(dev))
        this.Expect(L.PromoteDeleteDev, delDev.status === S.StatusOk, S.StatusWord + String(delDev.status))
        const delRt = await this.Api(S.MethodDelete, this.EnvPath(runtime))
        this.Expect(L.PromoteDeleteRuntime, delRt.status === S.StatusOk, S.StatusWord + String(delRt.status))
    }

    /**
     * FR6 proof: deploy an environment-bound remote app to the runtime env, then read the PROMOTED env graph as a real
     * runtime account granted Viewer at Tenant scope (no OpenApplication). Re-promote a changed graph and re-read on the
     * same connection (live, no redeploy); a bundled app on the same tenant still reads its own per-app graph.
     */
    private async RemoteEnvAppRoundTrip(dataRoot: string, devPort: number, rtPort: number, makerToken: string): Promise<void>
    {
        const S = ControlPlaneSmoke
        const L = S.Labels
        const seeder = new UserSeeder()
        const http = S.HttpPrefix + String(rtPort)
        const wsUrl = S.WsPrefix + String(rtPort) + S.WsTenantQuery + S.DemoTenant
        let step = L.EnvAppAdminLogin
        let envApp: BuiltHelloApp | undefined
        let bundledApp: BuiltHelloApp | undefined
        let adminClient: PragmaticClient | undefined
        let readerClient: PragmaticClient | undefined
        try
        {
            const adminToken = await this.RuntimeAdminToken(dataRoot, rtPort, seeder, L.EnvAppNoAdminPw)
            if (adminToken === undefined)
            {
                return
            }
            step = L.EnvAppDeploy
            envApp = await HelloAppBuilder.Build(RemoteBindMode.Environment, S.EnvAppName)
            bundledApp = await HelloAppBuilder.Build()
            adminClient = await PragmaticClient.ConnectAsync(wsUrl, { bearerToken: adminToken })
            const envDeployed = await adminClient.DeployApplication(envApp.DeployParams())
            this.Expect(L.EnvAppDeploy, envDeployed.status === AppWriteStatus.Applied, String(envDeployed.status))
            const bundledDeployed = await adminClient.DeployApplication(bundledApp.DeployParams())
            this.Expect(L.EnvAppBundledDeploy, bundledDeployed.status === AppWriteStatus.Applied, String(bundledDeployed.status))

            step = L.EnvAppReaderCreate
            const adminConn = await seeder.Connect(S.WsPrefix + String(rtPort), S.DemoTenant, adminToken)
            try
            {
                const created = await adminConn.sendRequest(AdminProtocol.CreateAccount, { email: S.EnvReaderEmail, principalId: S.EnvReaderPrincipal, password: S.EnvReaderPassword })
                const granted = await adminConn.sendRequest(AdminProtocol.GrantRole, { subject: S.EnvReaderPrincipal, role: S.ViewerRole, resourceKind: S.TenantKind, resourcePath: [] })
                this.Expect(L.EnvAppReaderCreate, created.ok === true && granted.ok === true, S.AckOkWord + String(created.ok) + S.Comma + String(granted.ok))
            }
            finally
            {
                adminConn.dispose()
            }

            step = L.EnvAppRead
            const readerToken = await seeder.Login(http, S.DemoTenant, S.EnvReaderEmail, S.EnvReaderPassword)
            readerClient = await PragmaticClient.ConnectAsync(wsUrl, { bearerToken: readerToken })
            const first = await ControlPlaneSmoke.ScalarCount(readerClient, S.PromoteCypher)
            this.Expect(L.EnvAppRead, first === S.PromoteExpectedRows, String(first))

            step = L.EnvAppRepromote
            const repromoted = await this.Repromote(devPort, makerToken)
            this.Expect(L.EnvAppRepromote, repromoted.ok, repromoted.detail)
            step = L.EnvAppLiveRead
            const widgets = await ControlPlaneSmoke.ScalarCount(readerClient, S.PromoteCypher)
            const gadgets = await ControlPlaneSmoke.ScalarCount(readerClient, S.RepromoteCypher)
            this.Expect(L.EnvAppLiveRead, widgets === S.PromoteExpectedRows && gadgets === S.PromoteExpectedRows, String(widgets) + S.Comma + String(gadgets))

            step = L.EnvAppBundledRead
            await adminClient.OpenApplication(HelloAppBuilder.AppName)
            const greetings = await ControlPlaneSmoke.ScalarCount(adminClient, S.BundledCypher)
            this.Expect(L.EnvAppBundledRead, greetings === S.PromoteExpectedRows, String(greetings))
        }
        catch (err)
        {
            this.Expect(L.EnvAppError, false, step + S.DetailSep + (err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await readerClient?.DisposeAsync()
            await adminClient?.DisposeAsync()
            envApp?.Dispose()
            bundledApp?.Dispose()
        }
    }

    /** Contributes a second solution (a Gadget package) to the dev graph and promotes it again into the runtime; true on a 200 carrying both packages. */
    private async Repromote(devPort: number, makerToken: string): Promise<{ ok: boolean; detail: string }>
    {
        const S = ControlPlaneSmoke
        await this.ContributeAs(devPort, S.PromoteDevName, makerToken, S.RepromoteSolutionId, S.RepromotePackage(), S.RepromotedPackageCount)
        const path = this.EnvPath(S.PromoteDevName) + S.GraphsSegment + S.PathSep + encodeURIComponent(S.PromoteGraphName) + S.PromoteSegment
        const promoted = await this.Api(S.MethodPost, path, { targetEnv: S.PromoteRuntimeName })
        const result = promoted.json as PromotionResultDto | undefined
        const ok = promoted.status === S.StatusOk && result?.packageCount === S.RepromotedPackageCount
        return { ok, detail: S.StatusWord + String(promoted.status) + S.PackagesWord + String(result?.packageCount) }
    }

    /** Reads the runtime env's provisioned admin password and logs in; reports under the given label and returns undefined when the password is absent. */
    private async RuntimeAdminToken(dataRoot: string, port: number, seeder: UserSeeder, missingLabel: string): Promise<string | undefined>
    {
        const S = ControlPlaneSmoke
        const secrets = JSON.parse(readFileSync(join(dataRoot, S.PromoteRuntimeName, S.SecretsFile), S.Utf8)) as Record<string, string>
        const adminPw = secrets[S.AdminPwKey]
        if (adminPw === undefined)
        {
            this.Expect(missingLabel, false, S.AdminPwKey)
            return undefined
        }
        return seeder.Login(S.HttpPrefix + String(port), S.DemoTenant, S.AdminEmail, adminPw)
    }

    /** Runs a single-row count query and returns the first cell (undefined when absent). */
    private static async ScalarCount(client: PragmaticClient, cypher: string): Promise<unknown>
    {
        for await (const page of client.QueryAll(cypher))
        {
            return page.items[0]?.[0]
        }
        return undefined
    }

    /** A second compiled package (a distinct concept + one instance) used to prove the re-promoted graph is read live. */
    private static RepromotePackage(): ContributedPackageDto
    {
        const S = ControlPlaneSmoke
        const repo = new Repository()
        repo.builder()
            .defineConcept(S.RepromoteConcept)
            .setNamespace(S.RepromoteNamespace)
            .assertInstance(S.RepromoteConcept, S.RepromoteNamespace + S.PromoteInstanceSuffix)
            .commit()
        const document = toJSON(repo) as PackageDocument
        return { id: S.RepromoteNamespace, version: S.PromoteVersion, modelJson: JSON.stringify(document) }
    }

    /** Contributes the small fixture package over a maker-token WS to the dev container and records the outcome; a rejection is reported (message only, never the token) instead of escaping. */
    private async ContributeAs(port: number, tenantId: string, makerToken: string, solutionId: string, pkg: ContributedPackageDto, expectedPackages: number): Promise<void>
    {
        const S = ControlPlaneSmoke
        try
        {
            const conn = await new UserSeeder().Connect(S.WsPrefix + String(port), tenantId, makerToken)
            try
            {
                const detail = await conn.sendRequest(GraphProtocol.Contribute, { graphName: S.PromoteGraphName, solutionId, packages: [pkg] })
                const ok = detail.name === S.PromoteGraphName && detail.packages.length === expectedPackages
                this.Expect(S.Labels.PromoteContribute, ok, detail.name + S.PackagesWord + String(detail.packages.length))
            }
            finally
            {
                conn.dispose()
            }
        }
        catch (err)
        {
            this.Expect(S.Labels.PromoteContribute, false, err instanceof Error ? err.message : String(err))
        }
    }

    /** Opens the runtime tenant as its Owner (no bound app, so cypher resolves to the env graph) and counts the promoted instances. */
    private async CheckRuntimeGraphRead(dataRoot: string, port: number): Promise<void>
    {
        const S = ControlPlaneSmoke
        const seeder = new UserSeeder()
        const token = await this.RuntimeAdminToken(dataRoot, port, seeder, S.Labels.PromoteCypherRead)
        if (token === undefined)
        {
            return
        }
        const conn = await seeder.Connect(S.WsPrefix + String(port), S.DemoTenant, token)
        try
        {
            const page = await conn.sendRequest(CypherProtocol.Query, { cypher: S.PromoteCypher })
            const cell = page.items[0]?.[0]
            this.Expect(S.Labels.PromoteCypherRead, page.items.length === S.PromoteExpectedRows && cell === S.PromoteExpectedRows, String(cell))
        }
        finally
        {
            conn.dispose()
        }
    }

    /** A tiny compiled package with one queryable instance, built through the TODL repository (as the host tests do). */
    private static FixturePackage(): ContributedPackageDto
    {
        const S = ControlPlaneSmoke
        const repo = new Repository()
        repo.builder()
            .defineConcept(S.PromoteBaseConcept)
            .defineConcept(S.PromoteConcept, S.PromoteBaseConcept)
            .setNamespace(S.PromoteNamespace)
            .assertInstance(S.PromoteConcept, S.PromoteNamespace + S.PromoteInstanceSuffix)
            .commit()
        const document = toJSON(repo) as PackageDocument
        return { id: S.PromoteNamespace, version: S.PromoteVersion, modelJson: JSON.stringify(document) }
    }

    private CheckPurpose(label: string, dataRoot: string, envName: string, tenantId: string, expected: number): void
    {
        const tenantsPath = join(dataRoot, envName, ControlPlaneSmoke.TenantsFile)
        const parsed = JSON.parse(readFileSync(tenantsPath, ControlPlaneSmoke.Utf8)) as TenantsShape
        const purpose = parsed.tenants[tenantId]?.purpose
        this.Expect(label, purpose === expected, String(purpose))
    }

    private async CheckSeeded(dataRoot: string, port: number): Promise<void>
    {
        const secretsPath = join(dataRoot, ControlPlaneSmoke.DemoName, ControlPlaneSmoke.SecretsFile)
        const secrets = JSON.parse(readFileSync(secretsPath, ControlPlaneSmoke.Utf8)) as Record<string, string>
        const adminPw = secrets[ControlPlaneSmoke.AdminPwKey]
        if (adminPw === undefined)
        {
            this.Expect(ControlPlaneSmoke.Labels.SeededDemo, false, ControlPlaneSmoke.AdminPwKey)
            return
        }
        const seeder = new UserSeeder()
        const token = await seeder.Login(ControlPlaneSmoke.HttpPrefix + String(port), ControlPlaneSmoke.DemoTenant, ControlPlaneSmoke.AdminEmail, adminPw)
        const conn = await seeder.Connect(ControlPlaneSmoke.WsPrefix + String(port), ControlPlaneSmoke.DemoTenant, token)
        try
        {
            const accounts = await conn.sendRequest(AdminProtocol.ListAccounts, undefined)
            const ids = new Set(accounts.map(a => a.principalId))
            const missing = ControlPlaneSmoke.DemoPrincipals.filter(p => !ids.has(p))
            const hasAdmin = accounts.some(a => a.email === ControlPlaneSmoke.AdminEmail)
            const detail = ControlPlaneSmoke.MissingOpen + missing.join(ControlPlaneSmoke.Comma) + ControlPlaneSmoke.MissingClose + String(hasAdmin)
            this.Expect(ControlPlaneSmoke.Labels.SeededDemo, missing.length === 0 && hasAdmin, detail)
        }
        finally
        {
            conn.dispose()
        }
    }

    /** Drives the admin Manage routes against the running demo environment through the control plane. */
    private async ManageRoundTrip(name: string): Promise<void>
    {
        const S = ControlPlaneSmoke
        const L = S.Labels
        const base = this.EnvPath(name) + S.AdminSegment
        const snapshot = await this.Api(S.MethodGet, base + S.SnapshotLeaf)
        const snap = snapshot.json as { accounts?: { principalId: string; email: string }[]; config?: unknown } | undefined
        const accounts = snap?.accounts ?? []
        const ids = new Set(accounts.map(a => a.principalId))
        const missing = S.DemoPrincipals.filter(p => !ids.has(p))
        const hasAdmin = accounts.some(a => a.email === S.AdminEmail)
        const snapshotOk = snapshot.status === S.StatusOk && missing.length === 0 && hasAdmin && snap?.config !== undefined
        this.Expect(L.ManageSnapshot, snapshotOk, S.StatusWord + String(snapshot.status) + S.MissingOpen + missing.join(S.Comma) + S.MissingClose + String(hasAdmin))

        const create = await this.Api(S.MethodPost, base + S.AccountsLeaf, { principalId: S.ManagedPrincipal, email: S.ManagedEmail, password: S.ManagedPassword })
        this.Expect(L.ManageCreate, create.status === S.StatusCreated, S.StatusWord + String(create.status))
        const after = await this.Api(S.MethodGet, base + S.SnapshotLeaf)
        const listed = ((after.json as { accounts?: { principalId: string }[] } | undefined)?.accounts ?? []).some(a => a.principalId === S.ManagedPrincipal)
        this.Expect(L.ManageListed, after.status === S.StatusOk && listed, S.StatusWord + String(after.status))

        const viewer = { subject: S.ManagedPrincipal, role: S.ViewerRole, resourceKind: S.TenantKind, resourcePath: [] }
        const grant = await this.Api(S.MethodPost, base + S.GrantsLeaf, viewer)
        this.Expect(L.ManageGrant, grant.status === S.StatusOk, S.StatusWord + String(grant.status))
        const revoke = await this.Api(S.MethodDelete, base + S.GrantsLeaf, viewer)
        this.Expect(L.ManageRevoke, revoke.status === S.StatusOk, S.StatusWord + String(revoke.status))

        const config = await this.Api(S.MethodGet, base + S.ConfigLeaf)
        this.Expect(L.ManageGetConfig, config.status === S.StatusOk && config.json !== undefined, S.StatusWord + String(config.status))
        const put = await this.Api(S.MethodPut, base + S.ConfigLeaf, config.json)
        this.Expect(L.ManagePutConfig, put.status === S.StatusOk, S.StatusWord + String(put.status))

        const owner = { subject: S.OwnerSubject, role: S.OwnerRole, resourceKind: S.TenantKind, resourcePath: [] }
        const lockout = await this.Api(S.MethodDelete, base + S.GrantsLeaf, owner)
        this.Expect(L.ManageLockout, lockout.status === S.StatusConflict, S.StatusWord + String(lockout.status))
    }

    private async CheckHealth(label: string, hostPort: number): Promise<void>
    {
        const res = await this.Http(ControlPlaneSmoke.MethodGet, hostPort, ControlPlaneSmoke.HealthPath)
        this.Expect(label, res.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(res.status))
    }

    private EnvPath(name: string): string
    {
        return ControlPlaneSmoke.EnvironmentsPath + ControlPlaneSmoke.PathSep + encodeURIComponent(name)
    }

    private async Find(name: string): Promise<EnvironmentDto | undefined>
    {
        const res = await this.Api(ControlPlaneSmoke.MethodGet, ControlPlaneSmoke.EnvironmentsPath)
        return (res.json as EnvironmentDto[]).find(e => e.name === name)
    }

    /** Polls the list until the named environment has the wanted status; undefined on timeout. */
    private async WaitFor(name: string, status: EnvStatus): Promise<EnvironmentDto | undefined>
    {
        const deadline = Date.now() + ControlPlaneSmoke.PollTimeoutMs
        while (Date.now() < deadline)
        {
            const env = await this.Find(name)
            if (env !== undefined && env.status === status)
            {
                return env
            }
            await new Promise<void>(resolve => setTimeout(resolve, ControlPlaneSmoke.PollIntervalMs))
        }
        console.log(ControlPlaneSmoke.TimeoutPrefix + name + ControlPlaneSmoke.StatusWord + status)
        return undefined
    }

    private Api(method: string, path: string, body?: unknown): Promise<HttpResult>
    {
        const extra: Record<string, string> = {}
        if (this.sessionCookie !== '')
        {
            extra[ControlPlaneSmoke.CookieHeader] = this.sessionCookie
        }
        return this.Http(method, this.controlPort, path, body, extra)
    }

    private Http(method: string, port: number, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<HttpResult>
    {
        return new Promise<HttpResult>((resolve, reject) =>
        {
            const payload = body === undefined ? undefined : JSON.stringify(body)
            const headers: Record<string, string> = { ...extraHeaders }
            if (payload !== undefined)
            {
                headers[ControlPlaneSmoke.ContentTypeHeader] = ControlPlaneSmoke.JsonContentType
            }
            const req = request({ host: ControlPlaneSmoke.LoopbackHost, port, path, method, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on(ControlPlaneSmoke.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(ControlPlaneSmoke.EndEvent, () =>
                {
                    const text = Buffer.concat(chunks).toString(ControlPlaneSmoke.Utf8)
                    let json: unknown = undefined
                    try
                    {
                        json = text === '' ? undefined : JSON.parse(text)
                    }
                    catch
                    {
                        json = text
                    }
                    resolve({ status: res.statusCode ?? 0, json, setCookie: res.headers[ControlPlaneSmoke.SetCookieHeader] ?? [] })
                })
            })
            req.on(ControlPlaneSmoke.ErrorEvent, reject)
            if (payload !== undefined)
            {
                req.write(payload)
            }
            req.end()
        })
    }

    private Expect(label: string, ok: boolean, detail: string = ''): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === '' ? '' : ControlPlaneSmoke.DetailSep + detail
        console.log((ok ? ControlPlaneSmoke.PassTag : ControlPlaneSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (ControlPlaneSmoke.IsEntryPoint())
{
    await ControlPlaneSmoke.Main()
}
