import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { AuditRegistry } from './audit-record.js'
import { AuditThrottle } from './audit-throttle.js'
import { LocalDesktopDiscoveryBackend } from './desktop-discovery-backend.js'
import { InternalApiCredential } from './internal-api-credential.js'
import { InternalApiHost } from './internal-api-host.js'
import { InfraTargetMode, InfraTargetModes } from './infra-target-mode.js'
import { NoTargetEnvironmentRuntime, NoTargetHiveOrchestratorFactory, NoTargetIdpDriver, NoTargetImageDigest } from './no-infra-target.js'
import type { IAgentChannelBackend } from './agent-channel-backend.js'
import { EdgeComposition, EdgeShutdown } from './edge-composition.js'
import { DesktopDiscoveryEndpoint } from './desktop-discovery-endpoint.js'
import { TenantAccountIndex } from './tenant-account-index.js'
import { OperatorAuthorization } from './operator-authorization.js'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ControlPlaneHost } from './control-plane-host.js'
import { LoginThrottle } from './login-throttle.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { PlatformHiveOrchestratorFactory } from './platform-hive-orchestrator-factory.js'
import { constants as osConstants } from 'node:os'
import { ClusterTunnelPool } from './cluster-tunnel-pool.js'
import { EnvironmentEndpoints } from './environment-endpoints.js'
import { NodeProcessSpawner } from './kubectl.js'
import { ManifestRegistry } from './manifest-record.js'
import { AdoptionLedgerRegistry } from './adoption-ledger-record.js'
import { GatingRegistry } from './gating-record.js'
import { SelectionRegistry } from './selection-record.js'
import { AgentChannelHost } from './agent-channel-host.js'
import { LocalAgentChannelBackend } from './local-agent-channel-backend.js'
import { HiveObservationRegistry } from './hive-observation-record.js'
import { HiveAgentInstaller, SystemInstallClock } from './hive-agent-installer.js'
import { HiveAgentUninstaller } from './hive-agent-uninstaller.js'
import { ConsoleFingerprintKeys } from './console-fingerprint-keys.js'
import { ConsoleAdvertRegistry } from './console-advert-registry.js'
import { ConsoleAdvertReceiver } from './console-advert-receiver.js'
import { ConsoleOwnerResets } from './console-owner-resets.js'
import { ConsoleDomainApprovals } from './console-domain-approvals.js'
import { PlatformEmailDomains } from './platform-email-domains.js'
import { DomainVerificationRechecker } from './domain-verification-rechecker.js'
import { DomainTxtVerifier, NodeTxtResolver } from './txt-resolver.js'
import type { ITenantEmailDomains } from './tenant-api/tenant-email-domains.js'
import { DevCertificateAuthority } from './dev-certificate-authority.js'
import { InHiveIdpAdmin } from './in-hive-idp-admin.js'
import { SealedSecretStore } from './sealed-secret-store.js'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'
import { PlatformConsoleImageApproval, TenantConsoleInstaller } from './tenant-console-installer.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { ReleasePolicyRegistry } from './release-policy-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { DockerEnvAdapter } from './docker-env-port.js'
import { BundleBuilderAdapter, UserSeederAdapter } from './environment-seed-port.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { ClientRegistry } from './client-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { TenantRegistry } from './tenant-registry.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { UiDeployActuator } from './ui-deploy-actuator.js'
import { OciRegistryClient } from './oci-registry-client.js'
import { InClusterRegistry } from './in-cluster-registry.js'
import { UiArtifactSigner } from './ui-artifact-signer.js'
import { FileKeyStore, type IKeyStore } from './key-store.js'
import { KeyStores } from './key-stores.js'
import { PinnedKeyStore } from './pinned-key-store.js'
import { ManifestSigner, type IManifestSigner } from './manifest-signer.js'
import { PlatformImageSigner, PlatformSigningKey } from './platform-signing-key.js'
import type { IImageSigner } from './image-signer.js'
import { DockerImageDigest, type IImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { FileSignatureStore } from './signature-store.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { EnvironmentService } from './environment-service.js'
import { GraphService } from './graph-service.js'
import { OperatorIdentity, type OperatorComposeOptions } from './operator-identity.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpRegistry } from './idp-registry.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { IdpService, type IIdpService } from './idp-service.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { TenantProvisioningService } from './tenant-provisioning-service.js'
import type { TenantSessionStore } from './tenant-auth/tenant-session.js'
import { TenantPrincipalSessions } from './tenant-auth/tenant-principal-sessions.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { MasterKeyFile } from './master-key-file.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import { TenantGraphAccess } from './tenant-api/tenant-graph-access.js'
import { InProcessRolloutClient } from './tenant-api/in-process-rollout-client.js'
import { TenantPlaneComposer, type DesktopRelayWiring } from './tenant-plane-composer.js'
import { TenantPlaneHost } from './tenant-plane-host.js'
import { TenantHealthMonitor } from './tenant-health-monitor.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import type { IEnvironmentService } from './control-plane-host.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'
import { ControlPlaneRoles, ControlPlaneStart, ControlPlaneRole, type IControlPlaneListenerStarts } from './control-plane-role.js'
import { ReleaseCatalogConfig, type IReleaseServices } from './release/release-catalog-config.js'
import type { ReleasePoll } from './release/release-poll.js'

/** The composed tenant listener, its port/bind already validated (so a bad tenant port fails before any socket binds). */
interface ITenantPlaneStart
{
    host: TenantPlaneHost
    port: number
    bind: string
    scheme: string
    baseDomain: string
}

/** The operator side of a composed control plane: absent for the edge role. */
interface IOperatorSideStart
{
    host: ControlPlaneHost
    port: number
    bind: string
    tenant: ITenantPlaneStart | undefined
}

/** Admin's internal API listener for the edge; absent unless PRAGMATIC_ADMIN_INTERNAL_PORT is set. */
interface IInternalApiStart
{
    host: InternalApiHost
    settings: InternalApiSettings
}

/** The parsed internal-API settings. */
export interface InternalApiSettings
{
    Port: number
    Bind: string
    SecretFile: string
}

/** The agent-channel listener; `raw` is the port variable as given, for the invalid-port warning. */
interface IAgentChannelStart
{
    /** Undefined for a role that never serves the channel (admin): nothing is composed for it. */
    host: AgentChannelHost | undefined
    port: number
    raw: string | undefined
    bind: string
}

/** What ControlPlaneServer.Main composed for each listener; ControlPlaneStart decides which of them this role starts. */
class ComposedListeners implements IControlPlaneListenerStarts
{
    private static readonly ListeningPrefix = 'Control plane listening on http://localhost:'
    private static readonly ListeningSuffix = '/'
    private static readonly AgentChannelListeningPrefix = 'Agent channel listening on '
    private static readonly AgentChannelInvalidPortWarning = 'Ignoring invalid PRAGMATIC_AGENT_CHANNEL_PORT (expected an integer 1-65535); agent channel not started: '
    private static readonly TenantListeningPrefix = 'Tenant plane listening on '
    private static readonly InternalListeningPrefix = 'Internal API listening on '
    private static readonly SchemeHostSeparator = '://'
    private static readonly HostPortSeparator = ':'

    public constructor(private readonly operator: IOperatorSideStart | undefined, private readonly channel: IAgentChannelStart, private readonly internal?: IInternalApiStart)
    {
    }

    public async StartInternalApi(): Promise<void>
    {
        const i = this.internal
        if (i === undefined)
        {
            return
        }
        await i.host.Listen(i.settings.Port, i.settings.Bind)
        console.log(ComposedListeners.InternalListeningPrefix + i.settings.Bind + ComposedListeners.HostPortSeparator + String(i.settings.Port))
    }

    /** No tenant route is mounted on the operator listener. It binds PRAGMATIC_ADMIN_BIND (default loopback); a
     *  container publishes it on host loopback only. */
    public async StartOperatorHost(): Promise<void>
    {
        if (this.operator === undefined)
        {
            return
        }
        await this.operator.host.Listen(this.operator.port, this.operator.bind)
        console.log(ComposedListeners.ListeningPrefix + String(this.operator.port) + ComposedListeners.ListeningSuffix)
    }

    public async StartAgentChannel(): Promise<void>
    {
        const L = ComposedListeners
        const c = this.channel
        if (c.host === undefined)
        {
            return
        }
        if (c.port === ControlPlaneServer.AgentChannelDisabled)
        {
            if (c.raw !== undefined && c.raw !== '')
            {
                console.warn(L.AgentChannelInvalidPortWarning + c.raw)
            }
            return
        }
        await c.host.Listen(c.port, c.bind)
        console.log(L.AgentChannelListeningPrefix + c.bind + L.HostPortSeparator + String(c.port))
    }

    public async StartTenantPlane(): Promise<void>
    {
        const L = ComposedListeners
        const t = this.operator?.tenant
        if (t === undefined)
        {
            return
        }
        await t.host.Listen(t.port, t.bind)
        console.log(L.TenantListeningPrefix + t.scheme + L.SchemeHostSeparator + t.baseDomain + L.HostPortSeparator + String(t.port) + L.ListeningSuffix)
    }
}

export class ControlPlaneServer
{
    private static readonly PortEnvVar = 'PRAGMATIC_ADMIN_PORT'
    private static readonly AdminBindEnvVar = 'PRAGMATIC_ADMIN_BIND'
    private static readonly EdgeListeningPrefix = 'Edge listening on '
    private static readonly EdgeTrustedProxySuffix = ' (client addresses from the trusted proxy)'
    private static readonly HostPortText = ':'
    private static readonly InternalPortEnvVar = 'PRAGMATIC_ADMIN_INTERNAL_PORT'
    private static readonly InternalBindEnvVar = 'PRAGMATIC_ADMIN_INTERNAL_BIND'
    private static readonly DisabledPortText = '0'
    private static readonly BadInternalPortPrefix = 'Invalid PRAGMATIC_ADMIN_INTERNAL_PORT (expected 0 or a port 1-65535): '
    private static readonly BadInternalBindPrefix = 'Invalid PRAGMATIC_ADMIN_INTERNAL_BIND (expected an IP address or localhost): '
    private static readonly InternalSecretRequired = 'PRAGMATIC_ADMIN_INTERNAL_PORT is set, so PRAGMATIC_INTERNAL_API_SECRET_FILE is required'
    private static readonly DefaultAdminBind = '127.0.0.1'
    private static readonly LocalhostName = 'localhost'
    private static readonly BadAdminBindPrefix = 'Invalid PRAGMATIC_ADMIN_BIND (expected an IP address or localhost): '
    private static readonly ExitEvent = 'exit'
    private static readonly ShutdownSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    private static readonly SignalExitBase = 128
    private static readonly DefaultPort = 7000
    public static readonly IdpPortFloor = 12100
    public static readonly IdpsFile = 'idps.json'
    private static readonly MaxPort = TenantPlaneComposer.MaxPort
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_ADMIN_PORT: '
    private static readonly DataDir = 'data'
    private static readonly DataRootEnvVar = 'PRAGMATIC_ADMIN_DATA_ROOT'
    private static readonly KeysDirName = PlatformHiveOrchestratorFactory.KeysDirName
    private static readonly SigningKeyRefEnvVar = 'PRAGMATIC_ADMIN_SIGNING_KEY_REF'
    private static readonly TempSuffix = '.tmp'
    private static readonly PublicKeyMode = 0o644
    private static readonly SignaturesFileName = PlatformHiveOrchestratorFactory.SignaturesFileName
    private static readonly TrustAdoptedPrefix = 'Platform signing key '
    private static readonly TrustAdoptedInfix = ' set as the trust root of hives: '
    private static readonly HiveIdSeparator = ', '
    private static readonly HttpScheme = 'http://'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly AuditFile = 'audit.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly HiveObservationsFile = 'hive-observations.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'
    private static readonly ReleasePoliciesFile = 'release-policies.json'
    private static readonly AdoptionLedgerFile = 'adoption-ledger.json'
    /** The operator portal SPA is served from `<compiled control plane>/../portal/dist`. */
    public static readonly PortalSegment = 'portal'
    private static readonly MasterKeyEnvVar = 'PRAGMATIC_ADMIN_MASTER_KEY_FILE'
    private static readonly OperatorEmailEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_EMAIL'
    private static readonly OperatorPasswordEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD'
    private static readonly InfraTargetLogPrefix = 'Infrastructure target: '
    private static readonly OperatorPasswordFileEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE'
    private static readonly PasswordBothSetMessage = 'Set either PRAGMATIC_ADMIN_OPERATOR_PASSWORD or PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE, not both'
    private static readonly PasswordFileUnreadableMessage = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE must name a readable file'
    private static readonly PasswordFileNotOneLineMessage = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE must hold one non-blank line (a password that can be typed)'
    private static readonly LineBreak = /[\r\n]/
    private static readonly Utf8 = 'utf8'
    private static readonly TrailingNewline = /\r?\n$/
    private static readonly SecureCookieEnvVar = 'PRAGMATIC_ADMIN_SECURE_COOKIE'
    private static readonly DefaultOperatorEmail = 'admin@control-plane.test'
    private static readonly IdentitySegment = 'identity'
    private static readonly TrustedProxyEnvVar = 'PRAGMATIC_ADMIN_TRUSTED_PROXY'
    private static readonly AllowedHostsEnvVar = 'PRAGMATIC_ADMIN_ALLOWED_HOSTS'
    private static readonly ListSeparator = ','
    private static readonly TenantPortEnvVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    private static readonly TenantBindEnvVar = 'PRAGMATIC_TENANT_ADMIN_BIND'
    private static readonly TenantBaseDomainEnvVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    private static readonly TenantSchemeEnvVar = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME'
    private static readonly TenantExternalPortEnvVar = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT'
    private static readonly ExternalPortWarningPrefix = '[control-plane] tenant listener on port '
    private static readonly ExternalPortWarningSuffix = ' with PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT unset: without a proxy on 80/443, the OIDC callback and the Origin checks need PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT set to the port browsers use.'
    private static readonly ProxyPorts: ReadonlySet<number> = new Set([80, 443])
    /** Sentinel returned by ParseAgentChannelPort when the agent channel is not configured (or the port is invalid). */
    public static readonly AgentChannelDisabled = 0
    private static readonly AgentChannelPortEnvVar = 'PRAGMATIC_AGENT_CHANNEL_PORT'
    private static readonly AgentChannelBindEnvVar = 'PRAGMATIC_AGENT_CHANNEL_BIND'
    private static readonly DefaultAgentChannelBind = '0.0.0.0'
    private static readonly AgentChannelUrlEnvVar = 'PRAGMATIC_AGENT_CHANNEL_URL'
    private static readonly HttpProtocols: ReadonlySet<string> = new Set(['http:', 'https:'])
    private static readonly AgentChannelUrlInvalidWarning = 'Ignoring invalid PRAGMATIC_AGENT_CHANNEL_URL (expected an absolute http(s) URL); hive install bundles are unavailable: '
    // How a pod in Docker Desktop's Kubernetes reaches this machine; override with PRAGMATIC_AGENT_CHANNEL_URL elsewhere.
    private static readonly DefaultAgentChannelUrlPrefix = 'http://host.docker.internal:'
    private static readonly SecretTtlEnvVar = 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS'
    private static readonly HealthProbeMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS'
    private static readonly HealthProbeTimeoutMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS'
    public static readonly TenantAccountsFile = 'tenant-accounts.json'
    public static readonly ConsoleAdvertsFile = ConsoleAdvertRegistry.FileName
    public static readonly ConsoleDomainApprovalsFile = ConsoleDomainApprovals.FileName
    public static readonly ConsoleOwnerResetsFile = ConsoleOwnerResets.FileName
    public static readonly DesktopTenantPlaneUrlEnvVar = 'PRAGMATIC_DESKTOP_TENANT_PLANE_URL'
    private static readonly LoopbackHttpPrefix = 'http://127.0.0.1:'

    public static async Main(): Promise<void>
    {
        // The role and the agent-channel port are read first, so an unknown role (or an edge with no channel port) fails
        // before any state is touched; `all` composes and starts everything, as before the role existed.
        const role = ControlPlaneRoles.Of(process.env)
        const agentChannelRaw = process.env[ControlPlaneServer.AgentChannelPortEnvVar]
        const agentChannelPort = ControlPlaneServer.ParseAgentChannelPort(agentChannelRaw)
        ControlPlaneRoles.RequireListener(role, agentChannelPort !== ControlPlaneServer.AgentChannelDisabled)
        if (role === ControlPlaneRole.Edge)
        {
            // The keyless edge: no data root, key, registry or master key is ever opened; admin answers over the internal API.
            const edge = EdgeComposition.Compose(process.env)
            await edge.Host.Listen(edge.Port, edge.Bind)
            EdgeShutdown.Install(edge.Host)
            console.log(ControlPlaneServer.EdgeListeningPrefix + edge.Bind + ControlPlaneServer.HostPortText + String(edge.Port)
                + (edge.TrustedProxy ? ControlPlaneServer.EdgeTrustedProxySuffix : ''))
            return
        }
        // From here on the role is `all` or `admin`: both open the operator-side state.
        const here = dirname(fileURLToPath(import.meta.url))
        const dataRoot = ControlPlaneServer.DataRootOf(process.env, here)
        mkdirSync(dataRoot, { recursive: true })
        const opts = ControlPlaneServer.ReadOperatorOptions(process.env, dataRoot)
        const operator = await OperatorIdentity.Compose(opts)
        const masterKey = MasterKeyFile.Load(opts.masterKeyFile)
        // D28 interim: with no Docker/cluster target, every docker/kind/kubectl seam below is wired to a refusing stand-in
        // (environments, IdP, orchestrators, image digests), so nothing spawns them whatever records exist.
        const infra = InfraTargetModes.Parse(process.env)
        console.log(ControlPlaneServer.InfraTargetLogPrefix + infra)
        const noTarget = infra === InfraTargetMode.None
        const docker = new DockerEnvAdapter(new DockerEnv())
        const hostRuntime = noTarget ? new NoTargetEnvironmentRuntime() : undefined
        const registry = new EnvironmentRegistry(join(dataRoot, TenantPlaneComposer.RegistryFile), hostRuntime ?? docker)
        const digests: IImageDigest = noTarget ? new NoTargetImageDigest() : new DockerImageDigest()
        await registry.Load()
        await registry.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dataRoot, ControlPlaneServer.ClientsFile)),
            new TenantRegistry(join(dataRoot, ControlPlaneServer.TenantsFile)),
            new HiveRegistry(join(dataRoot, ControlPlaneServer.HivesFile)),
            registry)
        await directory.Load()
        // Every role: the deployment registry the agent channel serves is built over the manifest signer, which needs the
        // platform key (the trust-root back-fill this runs is idempotent, so a co-deployed edge and admin agree).
        // One key store for every signer: the signing-key file (if any) is read once, here.
        const keys = KeyStores.Of(dataRoot, process.env, ControlPlaneServer.SigningKeyRefOf(process.env))
        const signing = await ControlPlaneServer.PlatformSigningOf(process.env, dataRoot, directory, keys, digests)
        const allocator = new PortAllocator(TenantPlaneComposer.EnvPortFloor, new NetPortProbe())
        const bundle = new BundleBuilderAdapter()
        const seeder = new UserSeederAdapter(new UserSeeder())
        const proxy = new AdminProxy(new WsAdminConnector())
        const idpService = new IdpService(new IdpRegistry(join(dataRoot, ControlPlaneServer.IdpsFile)), noTarget
            ? new NoTargetIdpDriver()
            : new DockerIdpDriver(new PortAllocator(ControlPlaneServer.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), dataRoot, DockerEnv.ImageName))
        const orchestrators = noTarget ? new NoTargetHiveOrchestratorFactory() : new PlatformHiveOrchestratorFactory(undefined, dataRoot, digests)
        const placement = new EnvironmentPlacement(directory)
        // In-cluster environments are reached through pooled kubectl port-forwards; every tunnel dies with the process.
        const tunnels = new ClusterTunnelPool()
        ControlPlaneServer.CloseOnShutdown(tunnels)
        const endpoints = new EnvironmentEndpoints(orchestrators, directory, tunnels, new NodeProcessSpawner())
        const service = new EnvironmentService(registry, allocator, new EnvironmentRuntimeResolver(hostRuntime ?? new DockerEnvironmentRuntime(docker, bundle), new InClusterEnvironmentRuntime(orchestrators, placement, directory, bundle, signing.PlatformSigner), directory, orchestrators), seeder, dataRoot, proxy, directory, idpService, conn => new IdpAdminClient(conn), ControlPlaneServer.UiDeployerOf(orchestrators, registry, keys), endpoints)
        const graphService = new GraphService(registry, proxy, service)
        const staticRoot = join(here, TenantPlaneComposer.ParentSegment, ControlPlaneServer.PortalSegment, TenantPlaneComposer.DistSegment)
        const manifests = new ManifestRegistry(join(dataRoot, ControlPlaneServer.ManifestsFile))
        const audit = new AuditRegistry(join(dataRoot, ControlPlaneServer.AuditFile))
        const desktopAudit = new AuditRegistry(join(dataRoot, TenantPlaneComposer.DesktopAuditFile))
        const graphAudit = new AuditRegistry(join(dataRoot, TenantPlaneComposer.TenantGraphAuditFile))
        const gating = new GatingRegistry(join(dataRoot, ControlPlaneServer.GatingFile))
        const selections = new SelectionRegistry(join(dataRoot, ControlPlaneServer.SelectionsFile))
        const observations = new HiveObservationRegistry(join(dataRoot, ControlPlaneServer.HiveObservationsFile))
        const registrations = new RolloutRegistrationRegistry(join(dataRoot, ControlPlaneServer.RegistrationsFile))
        const policies = new ReleasePolicyRegistry(join(dataRoot, ControlPlaneServer.ReleasePoliciesFile))
        const ledger = new AdoptionLedgerRegistry(join(dataRoot, ControlPlaneServer.AdoptionLedgerFile))
        const adminClientRegistry = new TenantAdminClientRegistry(join(dataRoot, TenantPlaneComposer.TenantAdminClientsFile))
        const accountIndex = new TenantAccountIndex(join(dataRoot, ControlPlaneServer.TenantAccountsFile))
        const adverts = new ConsoleAdvertRegistry(join(dataRoot, ControlPlaneServer.ConsoleAdvertsFile))
        const approvals = new ConsoleDomainApprovals(join(dataRoot, ControlPlaneServer.ConsoleDomainApprovalsFile))
        // Operator Owner resets of in-hive consoles: recorded by the console installer, answered to the console in its advert.
        const ownerResets = new ConsoleOwnerResets(join(dataRoot, ControlPlaneServer.ConsoleOwnerResetsFile))
        await Promise.all([manifests.Load(), audit.Load(), desktopAudit.Load(), graphAudit.Load(), gating.Load(), selections.Load(), observations.Load(), registrations.Load(), policies.Load(), ledger.Load(), adminClientRegistry.Load(), accountIndex.Load(), adverts.Load(), approvals.Load(), ownerResets.Load()])
        await accountIndex.BackfillFrom(directory)
        const deployments = new PlatformDeploymentRegistry(manifests, gating, selections, registrations, directory, orchestrators, registry, placement, observations, ControlPlaneServer.ManifestSignerOf(signing.PlatformSigner.KeyRef, dataRoot, signing.ImageSigner, digests), policies, ledger)
        // The release catalogue and its poll are operator-side: composed (and their settings validated) before any listener
        // starts, and never by the edge.
        const releases = ControlPlaneServer.ReleasesOf(role, process.env, join(here, TenantPlaneComposer.ParentSegment, TenantPlaneComposer.ParentSegment), deployments)
        const agentChannelUrlRaw = process.env[ControlPlaneServer.AgentChannelUrlEnvVar]
        const agentChannelUrl = ControlPlaneServer.AgentChannelUrl(agentChannelPort, agentChannelUrlRaw)
        const agentChannelUrlSet = agentChannelUrlRaw !== undefined && agentChannelUrlRaw !== ''
        if (agentChannelUrl === undefined && (agentChannelUrlSet || agentChannelPort !== ControlPlaneServer.AgentChannelDisabled))
        {
            console.warn(ControlPlaneServer.AgentChannelUrlInvalidWarning + String(agentChannelUrlRaw))
        }
        // One email-domain service for the operator routes, the control-plane tenant plane and the console adverts the agent
        // channel receives, over the shared adverts and approvals.
        const domainVerifier = new DomainTxtVerifier(new NodeTxtResolver())
        const emailDomains = new PlatformEmailDomains(directory, adverts, approvals, domainVerifier)
        const agentBackend = ControlPlaneServer.AgentChannelBackendOf(deployments, directory, adverts, ownerResets, emailDomains)
        const channel = ControlPlaneServer.AgentChannelOf(role, agentBackend)
        const agentBind = ControlPlaneServer.ParseAgentChannelBind(process.env[ControlPlaneServer.AgentChannelBindEnvVar])
        const channelStart: IAgentChannelStart = { host: channel, port: agentChannelPort, raw: agentChannelRaw, bind: agentBind }
        // One tenant session store for the tenant plane and the Owner password reset (which ends the Owner's sessions).
        const tenantSessions = TenantPlaneComposer.TenantSessionsOf(dataRoot)
        const principalSessions = new TenantPrincipalSessions(tenantSessions)
        const provisioning = new TenantProvisioningService(idpService, directory, conn => new IdpAdminClient(conn), principalSessions, accountIndex)
        // Installs a Local hive's agent through the same cluster access the orchestrators already hold; off with the channel.
        const agentInstaller = new HiveAgentInstaller(directory, orchestrators, deployments, observations, agentChannelUrl)
        // Console keys and the dev CA are sealed under the master key; discovery and the console installer share one fingerprint-key source.
        const sealed = await SealedSecretStore.Open(join(dataRoot, SealedSecretStore.FileName), masterKey)
        const fingerprintKeys = new ConsoleFingerprintKeys(sealed)
        const discoveryBackend = new LocalDesktopDiscoveryBackend(accountIndex, directory, ControlPlaneServer.DesktopTenantPlaneUrlOf(process.env),
            adverts, fingerprintKeys, approvals, registry)
        const discovery = new DesktopDiscoveryEndpoint(discoveryBackend, DesktopDiscoveryEndpoint.NewThrottle())
        const internalSettings = ControlPlaneServer.InternalApiSettingsOf(process.env)
        const internalStart: IInternalApiStart | undefined = internalSettings === undefined ? undefined
            : { host: new InternalApiHost(InternalApiCredential.FromFile(internalSettings.SecretFile), agentBackend, discoveryBackend), settings: internalSettings }
        // Installs a Local hive's tenant console through the same cluster access.
        const consoleInstaller = new TenantConsoleInstaller(directory, orchestrators, new TenantAdminBootstrap(deployments), fingerprintKeys,
            new DevCertificateAuthority(join(dataRoot, DevCertificateAuthority.DirName), sealed), new InHiveIdpAdmin(orchestrators, sealed),
            new PlatformConsoleImageApproval(signing.PlatformSigner, PlatformHiveOrchestratorFactory.VerifierFor(dataRoot, digests)),
            keys, agentChannelUrl, new SystemInstallClock(), adverts, ownerResets)
        // Daily DNS re-check of verified domains (after approvals.Load; its interval timer is unref'd, so no shutdown hook).
        new DomainVerificationRechecker(approvals, domainVerifier).Start()
        const host = new ControlPlaneHost(service, graphService, staticRoot, operator, opts.secureCookie, directory, deployments, provisioning, observations, new LoginThrottle(), opts.trustedProxy, undefined, undefined, undefined, opts.allowedHosts, new OperatorAuthorization(), audit, new AuditThrottle(), idpService, agentChannelUrl, agentInstaller, new HiveAgentUninstaller(orchestrators), discovery, consoleInstaller, adverts, approvals, emailDomains, releases?.Refresher)
        const port = ControlPlaneServer.ResolvePort(process.env[ControlPlaneServer.PortEnvVar])
        const tenantPlane = ControlPlaneServer.ComposeTenantPlane(process.env, dataRoot, idpService, directory, opts.secureCookie, service, new InProcessRolloutClient(deployments), orchestrators, placement,
            masterKey, adminClientRegistry, TenantPlaneComposer.ParseSecretTtlHours(process.env[ControlPlaneServer.SecretTtlEnvVar]), tenantSessions, principalSessions,
            { endpoints, audit: desktopAudit }, emailDomains, new TenantGraphAccess(graphService, graphAudit))
        // Resolve (and validate) the tenant port + bind BEFORE binding the operator listener, so a misconfigured
        // tenant port fails fast at startup rather than after the operator socket is already live.
        let tenantStart: ITenantPlaneStart | undefined
        if (tenantPlane !== undefined)
        {
            const baseDomain = process.env[ControlPlaneServer.TenantBaseDomainEnvVar] as string
            const scheme = TenantPlaneComposer.TenantScheme(process.env[ControlPlaneServer.TenantSchemeEnvVar])
            const externalPort = TenantPlaneComposer.TenantExternalPort(process.env[ControlPlaneServer.TenantExternalPortEnvVar])
            const resolver = new TenantHostResolver(baseDomain, scheme, directory, externalPort)
            const tenantStaticRoot = join(here, TenantPlaneComposer.ParentSegment, TenantPlaneComposer.TenantPortalSegment, TenantPlaneComposer.DistSegment)
            const probeMs = TenantPlaneComposer.ParseHealthProbeMs(process.env[ControlPlaneServer.HealthProbeMsEnvVar])
            const probeTimeoutMs = TenantPlaneComposer.ParseHealthProbeTimeoutMs(process.env[ControlPlaneServer.HealthProbeTimeoutMsEnvVar])
            const monitor = probeMs > 0
                ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), tenantPlane.events, probeMs, probeTimeoutMs, service)
                : undefined
            // The host attaches its sockets to tenantPlane.principals (principalSessions), which the Owner reset also ends.
            const tenantHost = new TenantPlaneHost(tenantPlane, resolver, tenantStaticRoot, service, monitor)
            const tenantPort = TenantPlaneComposer.ResolveTenantPort(process.env[ControlPlaneServer.TenantPortEnvVar])
            const portWarning = ControlPlaneServer.ExternalPortWarning(tenantPort, externalPort)
            if (portWarning !== undefined)
            {
                console.warn(portWarning)
            }
            const tenantBind = TenantPlaneComposer.TenantBind(process.env[ControlPlaneServer.TenantBindEnvVar])
            tenantStart = { host: tenantHost, port: tenantPort, bind: tenantBind, scheme, baseDomain }
        }
        // The admin role still derives the channel URL above (hive bundles point at the edge) but does not listen on it.
        await new ControlPlaneStart(role).Run(new ComposedListeners({ host, port, bind: ControlPlaneServer.AdminBindOf(process.env), tenant: tenantStart }, channelStart, internalStart))
        // The poll's timer is unref'd, so it never holds the process open; it is also stopped on shutdown, beside the tunnels.
        if (releases?.Poll !== undefined)
        {
            releases.Poll.Start()
            ControlPlaneServer.StopOnShutdown(releases.Poll)
        }
    }

    /** The public agent-channel host for a role that serves it (`all`); undefined for `admin`, whose channel the edge serves. */
    public static AgentChannelOf(role: ControlPlaneRole, backend: IAgentChannelBackend): AgentChannelHost | undefined
    {
        return ControlPlaneRoles.ServesAgentChannel(role) ? new AgentChannelHost(backend) : undefined
    }

    /** The in-process agent channel (registries + console advert receiver), shared by the public channel and the internal API. */
    public static AgentChannelBackendOf(deployments: PlatformDeploymentRegistry, directory: PlatformDirectory, adverts: ConsoleAdvertRegistry,
        ownerResets: ConsoleOwnerResets, emailDomains: PlatformEmailDomains): LocalAgentChannelBackend
    {
        return new LocalAgentChannelBackend(deployments, new ConsoleAdvertReceiver(directory, adverts, undefined, ownerResets, emailDomains))
    }

    /** PRAGMATIC_ADMIN_INTERNAL_PORT (0/blank = off), _BIND (default loopback) and PRAGMATIC_INTERNAL_API_SECRET_FILE (required when on). */
    public static InternalApiSettingsOf(env: NodeJS.ProcessEnv): InternalApiSettings | undefined
    {
        const C = ControlPlaneServer
        const rawPort = env[C.InternalPortEnvVar]?.trim() ?? ''
        if (rawPort === '' || rawPort === C.DisabledPortText)
        {
            return undefined
        }
        const port = Number(rawPort)
        if (!Number.isInteger(port) || port < 1 || port > C.MaxPort)
        {
            throw new Error(C.BadInternalPortPrefix + rawPort)
        }
        const rawBind = env[C.InternalBindEnvVar]?.trim() ?? ''
        const bind = rawBind === '' ? C.DefaultAdminBind : rawBind
        if (isIP(bind) === 0 && bind !== C.LocalhostName)
        {
            throw new Error(C.BadInternalBindPrefix + rawBind)
        }
        const secretFile = env[InternalApiCredential.SecretFileEnvVar]?.trim() ?? ''
        if (secretFile === '')
        {
            throw new Error(C.InternalSecretRequired)
        }
        return { Port: port, Bind: bind, SecretFile: secretFile }
    }

    /**
     * Stops the release poll when the process ends. The SIGINT/SIGTERM handlers CloseOnShutdown installs exit the process,
     * which runs this 'exit' hook too.
     */
    public static StopOnShutdown(poll: ReleasePoll): void
    {
        process.once(ControlPlaneServer.ExitEvent, () => poll.Stop())
    }

    /**
     * The release catalogue (POST /api/releases/refresh) and its periodic poll, for roles that serve operators only: the edge
     * never reads the release settings. Undefined there, and when no credential file is configured.
     */
    public static ReleasesOf(role: ControlPlaneRole, env: NodeJS.ProcessEnv, repoRoot: string, deployments: PlatformDeploymentRegistry): IReleaseServices | undefined
    {
        return ControlPlaneRoles.ServesOperators(role) ? ReleaseCatalogConfig.Compose(env, repoRoot, deployments) : undefined
    }

    /** Derives operator-identity compose options and cookie policy from the environment (reads the password file, if one is named). */
    public static ReadOperatorOptions(env: NodeJS.ProcessEnv, dataRoot: string): OperatorComposeOptions & { secureCookie: boolean; trustedProxy: boolean; allowedHosts: readonly string[] }
    {
        const password = ControlPlaneServer.InitialPasswordOf(env)
        const secure = env[ControlPlaneServer.SecureCookieEnvVar]
        const proxied = env[ControlPlaneServer.TrustedProxyEnvVar]
        return {
            masterKeyFile: env[ControlPlaneServer.MasterKeyEnvVar] ?? join(dataRoot, TenantPlaneComposer.MasterKeyFileName),
            identityRoot: join(dataRoot, ControlPlaneServer.IdentitySegment),
            operatorEmail: env[ControlPlaneServer.OperatorEmailEnvVar] ?? ControlPlaneServer.DefaultOperatorEmail,
            initialPassword: password === undefined || password === '' ? undefined : password,
            secureCookie: TenantPlaneComposer.ReadsTrue(secure),
            trustedProxy: TenantPlaneComposer.ReadsTrue(proxied),
            allowedHosts: ControlPlaneServer.ParseHostList(env[ControlPlaneServer.AllowedHostsEnvVar]),
        }
    }

    /**
     * The first-start operator password: PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE (one trailing newline stripped) or the
     * PRAGMATIC_ADMIN_OPERATOR_PASSWORD value, never both. Errors name the settings only, never a value or a path.
     */
    private static InitialPasswordOf(env: NodeJS.ProcessEnv): string | undefined
    {
        const value = env[ControlPlaneServer.OperatorPasswordEnvVar]
        const file = env[ControlPlaneServer.OperatorPasswordFileEnvVar]?.trim() ?? ''
        if (file === '')
        {
            return value
        }
        if (value !== undefined && value !== '')
        {
            throw new Error(ControlPlaneServer.PasswordBothSetMessage)
        }
        let content: string
        try
        {
            content = readFileSync(file, ControlPlaneServer.Utf8)
        }
        catch
        {
            throw new Error(ControlPlaneServer.PasswordFileUnreadableMessage)
        }
        const password = content.replace(ControlPlaneServer.TrailingNewline, '')
        // A blank or multi-line seed could never be typed at the sign-in form: refuse it at start, not at first sign-in.
        if (password.trim() === '' || ControlPlaneServer.LineBreak.test(password))
        {
            throw new Error(ControlPlaneServer.PasswordFileNotOneLineMessage)
        }
        return password
    }

    /** Pure: splits a comma-separated host list, trimming blanks and dropping empties. */
    public static ParseHostList(raw: string | undefined): string[]
    {
        return (raw ?? '').split(ControlPlaneServer.ListSeparator).map(h => h.trim()).filter(h => h.length > 0)
    }

    /**
     * Composes the optional tenant plane from the environment. The dedicated tenant listener activates only when
     * both `PRAGMATIC_TENANT_ADMIN_PORT` and `PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN` are present; otherwise the plane
     * is off (fail-closed) and only the operator listener runs, exactly as before. The callback is derived per
     * request from the tenant subdomain host by `TenantPlaneHost`, so no callback is wired here.
     */
    public static ComposeTenantPlane(
        env: NodeJS.ProcessEnv,
        dataRoot: string,
        idpService: IIdpService,
        directory: ITenantDirectory,
        secureCookie: boolean,
        service: IEnvironmentService,
        rollout: IRolloutClient,
        orchestrators: HiveOrchestratorFactory,
        placement: EnvironmentPlacement,
        masterKey: Buffer,
        adminClientRegistry: TenantAdminClientRegistry,
        secretTtlHours: number,
        sessions?: TenantSessionStore,
        principals?: TenantPrincipalSessions,
        relay?: DesktopRelayWiring,
        emailDomains?: ITenantEmailDomains,
        graphs?: TenantGraphAccess): TenantPlane | undefined
    {
        const port = env[ControlPlaneServer.TenantPortEnvVar]
        const baseDomain = env[ControlPlaneServer.TenantBaseDomainEnvVar]
        if (port === undefined || port === '' || baseDomain === undefined || baseDomain === '')
        {
            return undefined
        }
        // The control plane's tenant plane is the one Plexus talks to, so it carries the desktop surface.
        return TenantPlaneComposer.BuildTenantPlane(dataRoot, idpService, directory, secureCookie, service, rollout, orchestrators, placement,
            masterKey, adminClientRegistry, secretTtlHours, sessions, principals, TenantPlaneComposer.ReadsTrue(env[TenantAdminEnv.TrustedProxy]), true, relay, emailDomains, undefined, graphs)
    }

    /** PRAGMATIC_ADMIN_BIND: the operator listener's address. Blank or unset = loopback (the laptop's default). */
    public static AdminBindOf(env: NodeJS.ProcessEnv): string
    {
        const raw = env[ControlPlaneServer.AdminBindEnvVar]?.trim() ?? ''
        if (raw === '')
        {
            return ControlPlaneServer.DefaultAdminBind
        }
        if (isIP(raw) === 0 && raw !== ControlPlaneServer.LocalhostName)
        {
            throw new Error(ControlPlaneServer.BadAdminBindPrefix + raw)
        }
        return raw
    }

    /** Pure: the state folder; PRAGMATIC_ADMIN_DATA_ROOT (resolved) when set, so a test stack never shares the developer's `data` folder beside the server. */
    public static DataRootOf(env: NodeJS.ProcessEnv, here: string): string
    {
        const raw = env[ControlPlaneServer.DataRootEnvVar]
        return raw !== undefined && raw !== '' ? resolve(raw) : join(here, ControlPlaneServer.DataDir)
    }

    /** Pure: the agent-channel port, or AgentChannelDisabled when unset, blank, or not an integer in 1..65535. */
    public static ParseAgentChannelPort(raw: string | undefined): number
    {
        const port = Number(raw)
        if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 1 || port > ControlPlaneServer.MaxPort)
        {
            return ControlPlaneServer.AgentChannelDisabled
        }
        return port
    }

    /**
     * Pure: the pod-visible agent-channel URL hive bootstraps point at; undefined while the channel is disabled or when the
     * override is not an absolute http(s) URL (hive pages then say the channel is not configured, rather than handing
     * clients a bundle whose agent cannot dial).
     */
    public static AgentChannelUrl(port: number, raw: string | undefined): string | undefined
    {
        // A set override names where hives dial in, whether or not this process serves the channel itself (the edge does).
        if (raw !== undefined && raw !== '')
        {
            return ControlPlaneServer.IsHttpUrl(raw) ? raw : undefined
        }
        if (port === ControlPlaneServer.AgentChannelDisabled)
        {
            return undefined
        }
        return ControlPlaneServer.DefaultAgentChannelUrlPrefix + String(port)
    }

    private static IsHttpUrl(raw: string): boolean
    {
        try
        {
            return ControlPlaneServer.HttpProtocols.has(new URL(raw).protocol)
        }
        catch
        {
            return false
        }
    }

    /** Pure: the agent-channel bind address; defaults to all interfaces (the channel is the public, bearer-authenticated surface). */
    public static ParseAgentChannelBind(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? ControlPlaneServer.DefaultAgentChannelBind : raw
    }

    /**
     * Where the desktop app finds the tenant plane: `PRAGMATIC_DESKTOP_TENANT_PLANE_URL` when set, else the loopback
     * tenant listener when the tenant plane is enabled (both port and base domain set), else undefined (discovery then
     * answers without `tenantPlaneUrl` and lists only tenants with a console of their own).
     */
    public static DesktopTenantPlaneUrlOf(env: NodeJS.ProcessEnv): string | undefined
    {
        const explicit = env[ControlPlaneServer.DesktopTenantPlaneUrlEnvVar]
        if (explicit !== undefined && explicit !== '')
        {
            return explicit
        }
        const port = env[ControlPlaneServer.TenantPortEnvVar]
        const baseDomain = env[ControlPlaneServer.TenantBaseDomainEnvVar]
        if (port === undefined || port === '' || baseDomain === undefined || baseDomain === '')
        {
            return undefined
        }
        return ControlPlaneServer.LoopbackHttpPrefix + port
    }

    /** Pure: the startup warning for a tenant listener off 80/443 with no external port set (a proxy-less run needs it); undefined otherwise. */
    public static ExternalPortWarning(tenantPort: number, externalPort: number | undefined): string | undefined
    {
        return externalPort !== undefined || ControlPlaneServer.ProxyPorts.has(tenantPort)
            ? undefined
            : ControlPlaneServer.ExternalPortWarningPrefix + String(tenantPort) + ControlPlaneServer.ExternalPortWarningSuffix
    }

    /** The UI deploy actuator: pushes via the control-plane registry address and signs with the control plane's key store. */
    private static UiDeployerOf(orchestrators: HiveOrchestratorFactory, registry: EnvironmentRegistry, keys: IKeyStore): UiDeployActuator
    {
        return new UiDeployActuator(new OciRegistryClient(ControlPlaneServer.HttpScheme + InClusterRegistry.PushBase()), new UiArtifactSigner(keys), keys, orchestrators, new K8sManifestBuilder(), registry)
    }

    /** The platform signing key ref: the operator's own (PRAGMATIC_ADMIN_SIGNING_KEY_REF, trimmed) or the generated platform key. */
    public static SigningKeyRefOf(env: NodeJS.ProcessEnv): string
    {
        const ref = env[ControlPlaneServer.SigningKeyRefEnvVar]
        return typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : PlatformSigningKey.DefaultRef
    }

    /**
     * The platform signing key, ready to use: generated on first start unless an operator named their own (which must
     * then be in the key store - checked here, so a typo fails the start instead of every later deploy). It becomes the
     * trust root of every hive that has none; that back-fill is permanent, so hives keep the key they were given even if
     * the operator later names another one. Returns one shared image signer and the platform signer built over it.
     */
    public static async PlatformSigningOf(env: NodeJS.ProcessEnv, dataRoot: string, directory: PlatformDirectory,
        keys: IKeyStore = KeyStores.Of(dataRoot, env, ControlPlaneServer.SigningKeyRefOf(env)), digests: IImageDigest = new DockerImageDigest()): Promise<{ ImageSigner: IImageSigner; PlatformSigner: PlatformImageSigner }>
    {
        const C = ControlPlaneServer
        const keysDir = join(dataRoot, C.KeysDirName)
        const ref = C.SigningKeyRefOf(env)
        if (keys instanceof PinnedKeyStore)
        {
            // The private key stays in memory; only its public half goes to disk, where every verifier reads it.
            await C.WritePublicKey(keysDir, ref, keys.PublicPem)
        }
        else if (ref === PlatformSigningKey.DefaultRef)
        {
            await PlatformSigningKey.Ensure(keysDir, ref)
        }
        else
        {
            PlatformSigningKey.Require(keysDir, ref)
        }
        const adopted = await directory.UseDefaultTrustRoot(ref)
        if (adopted.length > 0)
        {
            console.log(C.TrustAdoptedPrefix + ref + C.TrustAdoptedInfix + adopted.join(C.HiveIdSeparator))
        }
        const imageSigner = C.ImageSignerOf(dataRoot, keys, digests)
        return { ImageSigner: imageSigner, PlatformSigner: new PlatformImageSigner(imageSigner, ref) }
    }

    /** Writes `<ref>.pub` atomically (temp file + rename), replacing a stale one. Public material only. */
    private static async WritePublicKey(keysDir: string, ref: string, publicPem: string): Promise<void>
    {
        const C = ControlPlaneServer
        await mkdir(keysDir, { recursive: true })
        const path = join(keysDir, ref + FileKeyStore.PublicSuffix)
        const temp = path + C.TempSuffix
        await writeFile(temp, publicPem, { mode: C.PublicKeyMode })
        await rename(temp, path)
    }

    /** The registry manifest signer: publishes are signed with the platform signing key `ref`, through the shared image signer. */
    public static ManifestSignerOf(ref: string, dataRoot: string, signer: IImageSigner, digests: IImageDigest = new DockerImageDigest()): IManifestSigner
    {
        const store = new FileSignatureStore(join(dataRoot, ControlPlaneServer.SignaturesFileName))
        return new ManifestSigner(digests, signer, store, ref)
    }

    /** Signs images into the same signature store the hive orchestrators verify against, with keys from the key store. */
    public static ImageSignerOf(dataRoot: string, keys: IKeyStore = new FileKeyStore(join(dataRoot, ControlPlaneServer.KeysDirName)), digests: IImageDigest = new DockerImageDigest()): ImageSigner
    {
        const store = new FileSignatureStore(join(dataRoot, ControlPlaneServer.SignaturesFileName))
        return new ImageSigner(digests, store, keys)
    }

    private static ResolvePort(raw: string | undefined): number
    {
        if (raw === undefined || raw === '')
        {
            return ControlPlaneServer.DefaultPort
        }
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > ControlPlaneServer.MaxPort)
        {
            throw new Error(ControlPlaneServer.BadPortPrefix + raw)
        }
        return port
    }

    /**
     * Kills every pooled tunnel when the process ends. SIGINT/SIGTERM are handled so the exit hook runs (a signal's
     * default action skips 'exit'); the process then exits with the conventional 128 + signal number.
     */
    public static CloseOnShutdown(tunnels: ClusterTunnelPool): void
    {
        process.once(ControlPlaneServer.ExitEvent, () => tunnels.CloseAll())
        for (const signal of ControlPlaneServer.ShutdownSignals)
        {
            process.once(signal, () =>
            {
                tunnels.CloseAll()
                process.exit(ControlPlaneServer.SignalExitBase + osConstants.signals[signal])
            })
        }
    }

    /** True when this module is the process entry point (not when imported by tests). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (ControlPlaneServer.IsEntryPoint())
{
    await ControlPlaneServer.Main()
}
