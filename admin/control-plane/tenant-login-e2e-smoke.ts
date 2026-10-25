/**
 * GATED real-login browser e2e smoke (SP-HIVE-7 deferral #11). NOT a *.test.ts and NOT in any test glob.
 *
 * Requires Docker Desktop with its built-in Kubernetes (context `docker-desktop`), a FRESH `pragmatic-server:dev`
 * image in the local image store (the per-tenant IdP container and the hive workload both run from it), and the
 * Playwright Chromium browser. Run with:
 *
 *   npx tsx admin/control-plane/tenant-login-e2e-smoke.ts
 *
 * Proves the whole tenant-admin loop end to end: it composes the real control plane in-process (as server.ts and
 * idp-federation-smoke.ts do), provisions tenant `acme` (launching its IdP container), creates a hive plus one
 * hive-bound environment brought up on the hive's cluster, publishes + gates a real v1/v2 version set, then plays a
 * real Playwright Chromium: the headless browser completes the REAL tenant-admin OIDC login against the tenant's own
 * `pragmatic-idp` container through the real relying-party and the subdomain-routed tenant plane, boots the portal
 * past login with a real `pts_session`, navigates the hive tree, and drives the "set target" -> "confirm" UI to roll
 * the hive from v1 to the gated v2. The roll is asserted against LIVE control-plane state (`TargetFor`), never a
 * fake recorder. The owner one-time password, tokens and cookies are captured but NEVER printed. Containers, the
 * k8s namespace, the extra image tags and the temp dir are always torn down.
 *
 * Why the environment is brought up on the hive cluster (and not via EnvironmentService.Create as idp-federation's
 * CreateBound does): a Local/Attach hive's detail health probe and its roll Push both go through the kubectl
 * orchestrator, so the hive-bound environment must be a real workload on that cluster -- a plain docker-container
 * environment is invisible to the hive's orchestrator and would make the hive-detail health 500. This mirrors the
 * proven rollout-push-smoke.ts, which is the real-cluster model for an observable roll.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { ClientRegistry } from './client-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { TenantRegistry } from './tenant-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpRegistry } from './idp-registry.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { IdpService } from './idp-service.js'
import type { IdpConnection } from './idp-service.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { TenantProvisioningService } from './tenant-provisioning-service.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { ManifestRegistry } from './manifest-record.js'
import { GatingRegistry } from './gating-record.js'
import { SelectionRegistry } from './selection-record.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { HiveObservationRegistry } from './hive-observation-record.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindImageLoader } from './kind-image-loader.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { FileKeyStore } from './key-store.js'
import { FileSignatureStore } from './signature-store.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import { TenantPlaneHost } from './tenant-plane-host.js'
import { ControlPlaneServer } from './server.js'
import { InProcessRolloutClient } from './tenant-api/in-process-rollout-client.js'

/**
 * A resolver whose callback KEEPS the request host's port. The production `TenantHostResolver` strips the port (the
 * tenant plane sits behind a proxy on :443, so the callback is portless by design); this smoke binds the plane to an
 * ephemeral loopback port, so the browser's OIDC callback must carry that port to come back to us. This is the ONE
 * allowed test-only seam; production behaviour is untouched.
 */
class PortedTenantHostResolver extends TenantHostResolver
{
    // Pinned to production's TenantHostResolver.CallbackPath (a private static there, so it cannot be imported); keep in
    // lockstep if that path ever changes so the callback does not silently diverge only here.
    private static readonly PortedCallbackPath = '/tenant-auth/oidc/callback'
    // Each class owns its scheme-separator constant (as production's TenantHostResolver does); the private static there
    // is not importable across the class boundary.
    private static readonly PortedSchemeSeparator = '://'

    public constructor(
        baseDomain: string,
        private readonly scheme: string,
        directory: PlatformDirectory)
    {
        super(baseDomain, scheme, directory)
    }

    public override CallbackFor(hostHeader: string): string
    {
        return this.scheme + PortedTenantHostResolver.PortedSchemeSeparator + hostHeader.toLowerCase() + PortedTenantHostResolver.PortedCallbackPath
    }
}

/** The real control-plane services this smoke composes in-process, plus the orchestration handles the roll needs. */
type ComposedPlane = {
    directory: PlatformDirectory
    idpService: IdpService
    service: EnvironmentService
    environments: EnvironmentRegistry
    deployments: PlatformDeploymentRegistry
    orchestrators: HiveOrchestratorFactory
    placement: EnvironmentPlacement
    adminClientRegistry: TenantAdminClientRegistry
}

export class TenantLoginE2eSmoke
{
    private static readonly TempPrefix = 'tenant-login-e2e-smoke-'
    private static readonly StaticDir = 'static'
    private static readonly OrchestratorDir = 'orchestrator'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly IdpsFile = 'idps.json'
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly ObservationsFile = 'hive-observations.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'
    private static readonly TenantAdminClientsFile = 'tenant-admin-clients.json'

    private static readonly EnvPortFloor = 8100
    private static readonly IdpPortFloor = 12100
    private static readonly SecretTtlHours = 168
    private static readonly MasterKeyBytes = 32
    // Smoke-only: the plane is served over loopback http, so the browser must send a non-Secure pts_session cookie.
    private static readonly SecureCookie = false

    private static readonly TenantId = 'acme'
    private static readonly ClientId = 'acme-admin'
    private static readonly DisplayName = 'Acme'
    private static readonly OwnerEmail = 'owner@acme.test'
    private static readonly BaseDomain = 'admin.localtest'
    private static readonly ExternalScheme = 'http'
    private static readonly BindHost = '127.0.0.1'

    private static readonly HiveId = 'acme-hive'
    private static readonly HiveDisplayName = 'Smoke Hive'
    private static readonly K8sContext = 'docker-desktop'
    private static readonly SigningKeyRef = 'smoke-signing'

    private static readonly BaseImage = 'pragmatic-server:dev'
    private static readonly ImageV1 = 'pragmatic-server:v1'
    private static readonly ImageV2 = 'pragmatic-server:v2'
    private static readonly VersionV1 = 'v1'
    private static readonly VersionV2 = 'v2'

    private static readonly Docker = 'docker'
    private static readonly TagVerb = 'tag'
    private static readonly RmiVerb = 'rmi'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly GetVerb = 'get'
    private static readonly NamespaceKind = 'namespace'
    private static readonly NotFoundWord = 'NotFound'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''

    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Utf8 = 'utf8'
    private static readonly Base64 = 'base64'

    private static readonly BootBaseDirKey = 'PRAGMATIC_BASE_DIR'
    private static readonly BootBaseDir = '/tmp/pragmatic-data'
    private static readonly BootTenantKey = 'PRAGMATIC_ENVIRONMENT_ID'
    private static readonly BootMasterKeyEnvKey = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly BootMasterKeyVar = 'SMOKE_MASTER_KEY_B64'

    private static readonly TenantPortEnvKey = 'PRAGMATIC_TENANT_ADMIN_PORT'
    private static readonly TenantPortEnvValue = '1'
    private static readonly TenantBaseDomainEnvKey = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'

    private static readonly TenantPortalRel = '../tenant-portal/dist'
    private static readonly HostResolverRules = '--host-resolver-rules=MAP *.admin.localtest 127.0.0.1, MAP host.docker.internal 127.0.0.1'
    private static readonly EmailSelector = 'input[name=email]'
    private static readonly PasswordSelector = 'input[name=password]'
    private static readonly SubmitSelector = 'button[type=submit]'
    private static readonly FormSelector = 'form'
    private static readonly SessionCookieName = 'pts_session'
    private static readonly RootPath = '/'

    // Portal text the browser drives. Mirrors the portal's own constants (TenantTreeView.RootLabel,
    // HiveDetailView.SetTargetLabel / ConfirmLabel); hoisted here so the smoke owns its literals without a
    // cross-package import that may not resolve under tsx.
    private static readonly RootLabel = 'My Hives'
    private static readonly SetTargetLabel = 'Set as target'
    private static readonly ConfirmLabel = 'Confirm'

    private static readonly TargetPathFragment = '/tenant-api/hives/'
    private static readonly TargetPathLeaf = '/target'
    private static readonly MethodPost = 'POST'
    private static readonly StatusNoContent = 204

    private static readonly FormWaitMs = 30000
    private static readonly PortalWaitMs = 45000
    private static readonly RollWaitMs = 45000

    private static readonly PassTag = 'PASS: '
    private static readonly FailTag = 'FAIL: '
    private static readonly InfoTag = 'INFO: '
    private static readonly DetailSep = ' -- '
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TeardownWarn = 'WARN best-effort teardown failed: '
    private static readonly TeardownWhatSep = ' -- '
    private static readonly OverallPass = 'OVERALL PASS: real browser completed the tenant-admin OIDC login, booted the portal, and rolled the hive v1 -> v2'
    private static readonly OverallFail = 'OVERALL FAIL'

    private static readonly InfoPublished = 'published + gated versions: '
    private static readonly InfoRunningImage = 'hive running image after roll: '
    private static readonly VersionSep = ', '
    private static readonly PlaneUndefined = 'ComposeTenantPlane returned undefined'

    private static readonly HostSep = '.'
    private static readonly PortSep = ':'
    private static readonly SchemeSeparator = '://'
    private static readonly PortDetail = 'port='
    private static readonly UrlDetail = 'url='
    private static readonly SessionDetail = 'session='
    private static readonly HostDetail = ' host='
    private static readonly StatusDetail = 'status='
    private static readonly TargetDetail = 'target='
    private static readonly LoginFormStillPresent = 'login form still present'
    private static readonly IdpRecordNotFound = 'idp record not found after Provision'
    private static readonly EnvRecordNotFound = 'environment record not found after Put'

    private static readonly M_IdpHealthy = 'idp healthy: the per-tenant pragmatic-idp container is up over TLS'
    private static readonly M_EnvHealthy = 'env healthy: the hive-bound environment is up on the cluster running v1'
    private static readonly M_ListenerUp = 'listener up: the tenant plane is serving on an ephemeral loopback port'
    private static readonly M_LoginForm = 'login form shown: the browser auto-redirected to the IdP and the login form rendered'
    private static readonly M_LandedSession = 'landed back with session: the browser is back on the tenant host with a pts_session cookie'
    private static readonly M_PortalBooted = 'portal booted: the signed-in tenant portal rendered past the login screen'
    private static readonly M_RollPosted = 'roll posted: the set-target -> confirm UI POSTed the roll and the tenant plane answered 204'
    private static readonly M_RollRecorded = 'roll recorded: live control-plane TargetFor(hive) is v2 after the browser roll'

    private static readonly EnvNameSuffix = '-env'

    private failed = false
    private dataRoot = TenantLoginE2eSmoke.EmptyString
    private tagged = false
    private readonly exec = new NodeExecFile()
    private readonly envName = TenantLoginE2eSmoke.HiveId + TenantLoginE2eSmoke.EnvNameSuffix
    private idpContainers: IdpContainerEnv | undefined
    private idpRegistry: IdpRegistry | undefined

    public static async Main(): Promise<void>
    {
        const smoke = new TenantLoginE2eSmoke()
        const ok = await smoke.Run()
        console.log(ok ? TenantLoginE2eSmoke.OverallPass : TenantLoginE2eSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = TenantLoginE2eSmoke
        try
        {
            // Inside the try so the finally's Cleanup reclaims the temp dir even if the static-subdir mkdir throws.
            this.dataRoot = mkdtempSync(join(tmpdir(), S.TempPrefix))
            mkdirSync(join(this.dataRoot, S.StaticDir), { recursive: true })
            await this.Scenario()
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.stack ?? err.message : String(err)))
        }
        finally
        {
            await this.Cleanup()
        }
        return !this.failed
    }

    private async Scenario(): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        const plane = await this.Compose()
        await this.TagImages()
        await this.SignBoth()

        // Provision the tenant: launches its IdP container and returns the one-time owner password (never printed).
        await plane.directory.CreateClient({ id: S.ClientId, displayName: S.DisplayName })
        const provisioning = new TenantProvisioningService(plane.idpService, plane.directory, conn => new IdpAdminClient(conn))
        const provisioned = await provisioning.Provision({ id: S.TenantId, clientId: S.ClientId, displayName: S.DisplayName, ownerEmail: S.OwnerEmail })
        const ownerPassword = provisioned.ownerPassword
        const conn = await plane.idpService.EnsureForTenant(S.TenantId, S.DisplayName)
        await this.CheckIdpHealthy(conn)

        // The hive (the roll subject) and its gated v1/v2 version set.
        const hive = await plane.directory.CreateHive({
            id: S.HiveId,
            tenantId: S.TenantId,
            displayName: S.HiveDisplayName,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.K8sContext },
            registry: { mode: InfraMode.Attach },
            trustRootRef: S.SigningKeyRef,
        })
        await plane.deployments.Publish(S.VersionV1, S.ImageV1)
        await plane.deployments.Publish(S.VersionV2, S.ImageV2)
        await plane.deployments.Gate(S.TenantId, S.VersionV1)
        await plane.deployments.Gate(S.TenantId, S.VersionV2)
        console.log(S.InfoTag + S.InfoPublished + S.VersionV1 + S.VersionSep + S.VersionV2)

        // Bring one hive-bound environment up on the cluster on v1, then record v1 as the hive's current target so the
        // portal shows v1 as Current and v2 as the single available roll target.
        const orchestrator = await this.BringUpEnvironment(plane, hive)
        if (orchestrator === undefined)
        {
            return
        }
        await plane.deployments.SelectTarget(S.HiveId, S.VersionV1)

        const host = await this.Listen(plane)
        if (host === undefined)
        {
            return
        }
        try
        {
            await this.DriveBrowser(host.Address().port, ownerPassword)
            await this.CheckRollRecorded(plane, orchestrator)
        }
        finally
        {
            await host.Close()
        }
    }

    /** Puts a hive-bound environment record, applies it on the hive cluster on v1, and gates its health. [env healthy] */
    private async BringUpEnvironment(plane: ComposedPlane, hive: HiveRecord): Promise<IHiveOrchestrator | undefined>
    {
        const S = TenantLoginE2eSmoke
        await plane.environments.Put(this.NewRecord())
        const record = this.FindEnv(plane)
        if (record === undefined)
        {
            this.Check(S.M_EnvHealthy, false, S.EnvRecordNotFound)
            return undefined
        }
        const workload = this.BootWorkload(plane.placement.WorkloadFor(record))
        const orchestrator = plane.orchestrators.For(hive)
        await orchestrator.Apply({ ...workload, image: S.ImageV1 })
        await orchestrator.WaitHealthy(workload)
        const health = await orchestrator.Health(workload)
        this.Check(S.M_EnvHealthy, health.ready && health.runningImage === S.ImageV1, health.detail)
        return orchestrator
    }

    private FindEnv(plane: ComposedPlane): EnvironmentRecord | undefined
    {
        return plane.service.List().find(r => r.name === this.envName)
    }

    /** Composes the real tenant plane and starts its host on an ephemeral loopback port. [listener up] */
    private async Listen(plane: ComposedPlane): Promise<TenantPlaneHost | undefined>
    {
        const S = TenantLoginE2eSmoke
        const env: NodeJS.ProcessEnv = { [S.TenantPortEnvKey]: S.TenantPortEnvValue, [S.TenantBaseDomainEnvKey]: S.BaseDomain }
        const masterKey = randomBytes(S.MasterKeyBytes)
        const tenantPlane = ControlPlaneServer.ComposeTenantPlane(
            env, this.dataRoot, plane.idpService, plane.directory, S.SecureCookie, plane.service, new InProcessRolloutClient(plane.deployments),
            plane.orchestrators, plane.placement, masterKey, plane.adminClientRegistry, S.SecretTtlHours)
        if (tenantPlane === undefined)
        {
            this.Check(S.M_ListenerUp, false, S.PlaneUndefined)
            return undefined
        }
        const resolver = new PortedTenantHostResolver(S.BaseDomain, S.ExternalScheme, plane.directory)
        const here = dirname(fileURLToPath(import.meta.url))
        const host = new TenantPlaneHost(tenantPlane, resolver, join(here, S.TenantPortalRel), plane.service)
        await host.Listen(0, S.BindHost)
        const port = host.Address().port
        this.Check(S.M_ListenerUp, Number.isInteger(port) && port > 0, S.PortDetail + String(port))
        return host
    }

    private async DriveBrowser(port: number, ownerPassword: string): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        const tenantHost = S.TenantId + S.HostSep + S.BaseDomain + S.PortSep + String(port)
        const origin = S.ExternalScheme + S.SchemeSeparator + tenantHost
        const browser = await chromium.launch({ args: [S.HostResolverRules] })
        try
        {
            const context = await browser.newContext({ ignoreHTTPSErrors: true })
            const page = await context.newPage()

            // The portal boots, finds no session, and AUTO-redirects to /tenant-auth/oidc/begin -> the IdP login page.
            await page.goto(origin + S.RootPath)
            await page.waitForSelector(S.EmailSelector, { timeout: S.FormWaitMs })
            this.Check(S.M_LoginForm, new URL(page.url()).host !== tenantHost, S.UrlDetail + page.url())

            // Submit the owner credentials; the IdP 302s to the callback which sets pts_session and returns to the portal.
            await page.fill(S.EmailSelector, S.OwnerEmail)
            await page.fill(S.PasswordSelector, ownerPassword)
            await page.click(S.SubmitSelector)

            await page.waitForURL(url => url.host === tenantHost, { timeout: S.PortalWaitMs })
            const cookies = await context.cookies()
            const hasSession = cookies.some(c => c.name === S.SessionCookieName && c.value !== S.EmptyString)
            const backOnTenant = new URL(page.url()).host === tenantHost
            this.Check(S.M_LandedSession, hasSession && backOnTenant, S.SessionDetail + String(hasSession) + S.HostDetail + new URL(page.url()).host)

            await page.waitForFunction(label => document.body.innerText.includes(label), S.RootLabel, { timeout: S.PortalWaitMs })
            this.Check(S.M_PortalBooted, await page.$(S.FormSelector) === null, S.LoginFormStillPresent)

            await this.DriveRoll(page)
        }
        finally
        {
            await browser.close()
        }
    }

    /** Navigates the tree to the hive, opens its detail, and drives set-target -> confirm to roll v1 -> v2. [roll posted] */
    private async DriveRoll(page: import('playwright').Page): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        // The portal tree renders the hive node directly under the root (no manual expand needed), so clicking the
        // display name opens the hive detail.
        await page.getByText(S.HiveDisplayName, { exact: true }).click()
        await page.getByText(S.SetTargetLabel, { exact: true }).click()
        const posted = page.waitForResponse(
            resp => resp.request().method() === S.MethodPost
                && resp.url().includes(S.TargetPathFragment)
                && new URL(resp.url()).pathname.endsWith(S.TargetPathLeaf),
            { timeout: S.RollWaitMs })
        await page.getByText(S.ConfirmLabel, { exact: true }).click()
        const response = await posted
        this.Check(S.M_RollPosted, response.status() === S.StatusNoContent, S.StatusDetail + String(response.status()))
    }

    /** Asserts the roll took effect against LIVE control-plane state, never a fake recorder. [roll recorded] */
    private async CheckRollRecorded(plane: ComposedPlane, orchestrator: IHiveOrchestrator): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        const target = plane.deployments.TargetFor(S.HiveId)
        this.Check(S.M_RollRecorded, target?.version === S.VersionV2, S.TargetDetail + String(target?.version))
        const record = this.FindEnv(plane)
        if (record === undefined)
        {
            console.log(S.InfoTag + S.InfoRunningImage + S.EnvRecordNotFound)
            return
        }
        try
        {
            const health = await orchestrator.Health(this.BootWorkload(plane.placement.WorkloadFor(record)))
            console.log(S.InfoTag + S.InfoRunningImage + String(health.runningImage))
        }
        catch (e)
        {
            console.log(S.InfoTag + S.InfoRunningImage + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    /** Composes the real control-plane services under the temp dataRoot (as server.ts Main does). */
    private async Compose(): Promise<ComposedPlane>
    {
        const S = TenantLoginE2eSmoke
        const docker = new DockerEnvAdapter(new DockerEnv())
        const environments = new EnvironmentRegistry(join(this.dataRoot, S.RegistryFile), docker)
        await environments.Load()
        await environments.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(this.dataRoot, S.ClientsFile)),
            new TenantRegistry(join(this.dataRoot, S.TenantsFile)),
            new HiveRegistry(join(this.dataRoot, S.HivesFile)),
            environments)
        await directory.Load()
        this.idpContainers = new IdpContainerEnv(new ExecFileDockerExec())
        this.idpRegistry = new IdpRegistry(join(this.dataRoot, S.IdpsFile))
        const idpService = new IdpService(this.idpRegistry, new DockerIdpDriver(new PortAllocator(S.IdpPortFloor, new NetPortProbe()), this.idpContainers, this.dataRoot, DockerEnv.ImageName))
        const service = new EnvironmentService(
            environments, new PortAllocator(S.EnvPortFloor, new NetPortProbe()), new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new UserSeederAdapter(new UserSeeder()),
            this.dataRoot, new AdminProxy(new WsAdminConnector()), directory, idpService, conn => new IdpAdminClient(conn))
        const orchestrators = new HiveOrchestratorFactory(S.K8sContext, join(this.dataRoot, S.OrchestratorDir))
        const manifests = new ManifestRegistry(join(this.dataRoot, S.ManifestsFile))
        const gating = new GatingRegistry(join(this.dataRoot, S.GatingFile))
        const selections = new SelectionRegistry(join(this.dataRoot, S.SelectionsFile))
        const registrations = new RolloutRegistrationRegistry(join(this.dataRoot, S.RegistrationsFile))
        const adminClientRegistry = new TenantAdminClientRegistry(join(this.dataRoot, S.TenantAdminClientsFile))
        await Promise.all([manifests.Load(), gating.Load(), selections.Load(), registrations.Load(), adminClientRegistry.Load()])
        const placement = new EnvironmentPlacement(directory)
        const observations = new HiveObservationRegistry(join(this.dataRoot, S.ObservationsFile))
        await observations.Load()
        const deployments = new PlatformDeploymentRegistry(manifests, gating, selections, registrations, directory, orchestrators, environments, placement, observations)
        return { directory, idpService, service, environments, deployments, orchestrators, placement, adminClientRegistry }
    }

    /**
     * Two refs of the same dev image bits: the roll is observable through the ref the Deployment runs. The refs are
     * then loaded into the kind node's containerd (see KindImageLoader): Docker Desktop's k8s node has its own image
     * store, so a bare host `docker tag` is invisible to it and, with IfNotPresent and no registry, a stale node copy
     * of the tag would otherwise shadow the freshly built bits and boot old code.
     */
    private async TagImages(): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        this.tagged = true
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.ImageV1])
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.ImageV2])
        await new KindImageLoader().Load(S.ImageV1, S.ImageV2)
    }

    /** Signs both bare image refs with a throwaway dev key into the orchestrator dataRoot stores; the private PEM is never logged. */
    private async SignBoth(): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        const orchestratorRoot = join(this.dataRoot, S.OrchestratorDir)
        const keysDir = join(orchestratorRoot, S.KeysDirName)
        mkdirSync(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        writeFileSync(join(keysDir, S.SigningKeyRef + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        writeFileSync(join(keysDir, S.SigningKeyRef + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
        const signer = new ImageSigner(new DockerImageDigest(), new FileSignatureStore(join(orchestratorRoot, S.SignaturesFileName)), new FileKeyStore(keysDir))
        await signer.Sign(S.ImageV1, S.SigningKeyRef)
        await signer.Sign(S.ImageV2, S.SigningKeyRef)
    }

    /** A throwaway dev-blank environment bound to the smoke hive, owned by the hive tenant. */
    private NewRecord(): EnvironmentRecord
    {
        const S = TenantLoginE2eSmoke
        return {
            name: this.envName,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: S.TenantId,
            hiveId: S.HiveId,
            hostPort: 0,
            containerName: this.envName,
            volumeName: this.envName,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
    }

    /** SMOKE-ONLY boot config (same approach as rollout-push-smoke): throwaway random key, never logged or written to disk. */
    private BootWorkload(stock: EnvironmentWorkload): EnvironmentWorkload
    {
        const S = TenantLoginE2eSmoke
        const boot = {
            [S.BootBaseDirKey]: S.BootBaseDir,
            [S.BootTenantKey]: this.envName,
            [S.BootMasterKeyEnvKey]: S.BootMasterKeyVar,
            [S.BootMasterKeyVar]: randomBytes(S.MasterKeyBytes).toString(S.Base64),
        }
        return { ...stock, env: { ...stock.env, ...boot } }
    }

    private async CheckIdpHealthy(conn: IdpConnection): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        try
        {
            await this.idpRegistry?.Load()
            const record = this.idpRegistry?.Get(S.TenantId)
            if (record === undefined || this.idpContainers === undefined)
            {
                throw new Error(S.IdpRecordNotFound)
            }
            await this.idpContainers.WaitHealthy(record.port, conn.ca)
            this.Check(S.M_IdpHealthy, true)
        }
        catch (e)
        {
            this.Check(S.M_IdpHealthy, false, e instanceof Error ? e.message : String(e))
        }
    }

    private Check(label: string, ok: boolean, detail = TenantLoginE2eSmoke.EmptyString): void
    {
        const S = TenantLoginE2eSmoke
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === S.EmptyString ? S.EmptyString : S.DetailSep + KubectlError.Redact(detail)
        console.log((ok ? S.PassTag : S.FailTag) + label + suffix)
    }

    /** Best-effort teardown: the k8s namespace, the extra image tags, the tenant's IdP container + volume, then the temp dataRoot. Never throws. */
    private async Cleanup(): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        const namespace = K8sManifestBuilder.NamespaceOf(this.envName)
        await this.BestEffort(namespace, async () =>
        {
            if (await this.NamespaceExists(namespace))
            {
                await new KubectlCli(S.K8sContext).DeleteNamespace(namespace)
            }
        })
        if (this.tagged)
        {
            await this.BestEffort(S.ImageV1, async () => { await this.exec.Run(S.Docker, [S.RmiVerb, S.ImageV1]) })
            await this.BestEffort(S.ImageV2, async () => { await this.exec.Run(S.Docker, [S.RmiVerb, S.ImageV2]) })
        }
        await this.BestEffort(S.TenantId, async () =>
        {
            await this.idpRegistry?.Load()
            const record = this.idpRegistry?.Get(S.TenantId)
            if (record !== undefined && this.idpContainers !== undefined)
            {
                await this.idpContainers.Down(record.containerName)
                await this.idpContainers.RemoveVolume(record.volumeName)
            }
        })
        await this.BestEffort(this.dataRoot, async () => { rmSync(this.dataRoot, { recursive: true, force: true }) })
    }

    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = TenantLoginE2eSmoke
        try
        {
            await this.exec.Run(S.Kubectl, [S.ContextFlag, S.K8sContext, S.GetVerb, S.NamespaceKind, namespace])
            return true
        }
        catch (e)
        {
            const stderr = String((e as { stderr?: unknown }).stderr ?? S.EmptyString)
            if (stderr.includes(S.NotFoundWord))
            {
                return false
            }
            throw e
        }
    }

    private async BestEffort(what: string, action: () => Promise<unknown>): Promise<void>
    {
        const S = TenantLoginE2eSmoke
        try
        {
            await action()
        }
        catch (e)
        {
            console.log(S.TeardownWarn + what + S.TeardownWhatSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (TenantLoginE2eSmoke.IsEntryPoint())
{
    await TenantLoginE2eSmoke.Main()
}
