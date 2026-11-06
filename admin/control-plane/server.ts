import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AuditRegistry } from './audit-record.js'
import { AuditThrottle } from './audit-throttle.js'
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
import { constants as osConstants } from 'node:os'
import { ClusterTunnelPool } from './cluster-tunnel-pool.js'
import { EnvironmentEndpoints, type IEnvironmentReach } from './environment-endpoints.js'
import { NodeProcessSpawner } from './kubectl.js'
import { ManifestRegistry } from './manifest-record.js'
import { AdoptionLedgerRegistry } from './adoption-ledger-record.js'
import { GatingRegistry } from './gating-record.js'
import { SelectionRegistry } from './selection-record.js'
import { AgentChannelHost } from './agent-channel-host.js'
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
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
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
import { FileKeyStore } from './key-store.js'
import { ManifestSigner, type IManifestSigner } from './manifest-signer.js'
import { PlatformImageSigner, PlatformSigningKey } from './platform-signing-key.js'
import type { IImageSigner } from './image-signer.js'
import { DockerImageDigest } from './image-digest.js'
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
import { TenantSessionStore } from './tenant-auth/tenant-session.js'
import { TenantPrincipalSessions } from './tenant-auth/tenant-principal-sessions.js'
import { TenantOidcRelyingParty, type TenantAdminDurability } from './tenant-auth/tenant-oidc-relying-party.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { MasterKeyFile } from './master-key-file.js'
import { TenantAuthEndpoint } from './tenant-auth/tenant-auth-endpoint.js'
import { TenantPasswordChange } from './tenant-auth/tenant-password-change.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import { IdpPasswordClient } from './tenant-auth/idp-password-client.js'
import { TenantAuthGate } from './tenant-auth/tenant-auth-gate.js'
import { DesktopAuthGate } from './tenant-auth/desktop-auth-gate.js'
import { DesktopEndpoint } from './tenant-auth/desktop-endpoint.js'
import { DesktopRelay, WsUpstreamDialer } from './tenant-auth/desktop-relay.js'
import { DesktopSignInFlows } from './tenant-auth/desktop-sign-in-flows.js'
import { DesktopTargets } from './tenant-auth/desktop-targets.js'
import { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import { TenantApiEndpoint } from './tenant-api/tenant-api-endpoint.js'
import { TenantGraphAccess } from './tenant-api/tenant-graph-access.js'
import { InProcessRolloutClient } from './tenant-api/in-process-rollout-client.js'
import { TenantEventBus } from './tenant-api/tenant-events.js'
import { TenantPlaneHost } from './tenant-plane-host.js'
import { TenantHealthMonitor } from './tenant-health-monitor.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import type { IEnvironmentService } from './control-plane-host.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'

/** What the desktop relay needs beyond the tenant plane: how environments are reached, and where relays are audited. */
export type DesktopRelayWiring = { endpoints: IEnvironmentReach; audit: AuditRegistry }

export class ControlPlaneServer
{
    private static readonly PortEnvVar = 'PRAGMATIC_ADMIN_PORT'
    private static readonly ExitEvent = 'exit'
    private static readonly ShutdownSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    private static readonly SignalExitBase = 128
    private static readonly DefaultPort = 7000
    public static readonly EnvPortFloor = 8100
    public static readonly IdpPortFloor = 12100
    public static readonly IdpsFile = 'idps.json'
    private static readonly MaxPort = 65535
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_ADMIN_PORT: '
    private static readonly BindHost = '127.0.0.1'
    private static readonly DataDir = 'data'
    public static readonly RegistryFile = 'registry.json'
    private static readonly KeysDirName = HiveOrchestratorFactory.KeysDirName
    private static readonly SigningKeyRefEnvVar = 'PRAGMATIC_ADMIN_SIGNING_KEY_REF'
    private static readonly SignaturesFileName = HiveOrchestratorFactory.SignaturesFileName
    private static readonly TrustAdoptedPrefix = 'Platform signing key '
    private static readonly TrustAdoptedInfix = ' set as the trust root of hives: '
    private static readonly HiveIdSeparator = ', '
    private static readonly HttpScheme = 'http://'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly AuditFile = 'audit.json'
    /** The tenant plane's own audit of desktop relays (who contributed / published what, and refusals). */
    public static readonly DesktopAuditFile = 'tenant-desktop-audit.json'
    public static readonly TenantGraphAuditFile = 'tenant-graph-audit.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly HiveObservationsFile = 'hive-observations.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'
    private static readonly ReleasePoliciesFile = 'release-policies.json'
    private static readonly AdoptionLedgerFile = 'adoption-ledger.json'
    public static readonly ParentSegment = '..'
    private static readonly PortalSegment = 'portal'
    public static readonly DistSegment = 'dist'
    public static readonly TenantPortalSegment = 'tenant-portal'
    private static readonly ListeningPrefix = 'Control plane listening on http://localhost:'
    private static readonly ListeningSuffix = '/'
    private static readonly MasterKeyEnvVar = 'PRAGMATIC_ADMIN_MASTER_KEY_FILE'
    private static readonly OperatorEmailEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_EMAIL'
    private static readonly OperatorPasswordEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD'
    private static readonly SecureCookieEnvVar = 'PRAGMATIC_ADMIN_SECURE_COOKIE'
    private static readonly DefaultOperatorEmail = 'admin@control-plane.test'
    public static readonly MasterKeyFileName = 'master.key'
    private static readonly IdentitySegment = 'identity'
    private static readonly TrustedProxyEnvVar = 'PRAGMATIC_ADMIN_TRUSTED_PROXY'
    private static readonly AllowedHostsEnvVar = 'PRAGMATIC_ADMIN_ALLOWED_HOSTS'
    private static readonly ListSeparator = ','
    private static readonly TrueToken = 'true'
    private static readonly OneToken = '1'
    private static readonly TenantPortEnvVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    private static readonly TenantBindEnvVar = 'PRAGMATIC_TENANT_ADMIN_BIND'
    private static readonly TenantBaseDomainEnvVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    private static readonly TenantSchemeEnvVar = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME'
    private static readonly TenantExternalPortEnvVar = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT'
    private static readonly BadTenantExternalPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: '
    private static readonly ExternalPortWarningPrefix = '[control-plane] tenant listener on port '
    private static readonly ExternalPortWarningSuffix = ' with PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT unset: without a proxy on 80/443, the OIDC callback and the Origin checks need PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT set to the port browsers use.'
    private static readonly ProxyPorts: ReadonlySet<number> = new Set([80, 443])
    private static readonly DefaultTenantBind = '127.0.0.1'
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
    private static readonly AgentChannelListeningPrefix = 'Agent channel listening on '
    private static readonly AgentChannelInvalidPortWarning = 'Ignoring invalid PRAGMATIC_AGENT_CHANNEL_PORT (expected an integer 1-65535); agent channel not started: '
    private static readonly DefaultExternalScheme = 'https'
    private static readonly BadTenantPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_PORT: '
    private static readonly TenantListeningPrefix = 'Tenant plane listening on '
    private static readonly SchemeHostSeparator = '://'
    private static readonly HostPortSeparator = ':'
    private static readonly TenantSessionsFile = 'tenant-sessions.json'
    private static readonly TenantSessionTtlMs = 12 * 60 * 60 * 1000
    private static readonly SecretTtlEnvVar = 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS'
    private static readonly DefaultSecretTtlHours = 168
    private static readonly MsPerHour = 3600000
    private static readonly HealthProbeMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS'
    private static readonly DefaultHealthProbeMs = 30000
    private static readonly MinHealthProbeMs = 1000
    private static readonly MaxHealthProbeMs = 2147483647
    private static readonly HealthProbeTimeoutMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS'
    // Above the default probe interval (30s) so a legitimately slow-but-healthy probe is not treated as wedged.
    private static readonly DefaultHealthProbeTimeoutMs = 60000
    public static readonly TenantAdminClientsFile = 'tenant-admin-clients.json'
    public static readonly TenantAccountsFile = 'tenant-accounts.json'
    public static readonly ConsoleAdvertsFile = ConsoleAdvertRegistry.FileName
    public static readonly ConsoleDomainApprovalsFile = ConsoleDomainApprovals.FileName
    public static readonly ConsoleOwnerResetsFile = ConsoleOwnerResets.FileName
    public static readonly DesktopTenantPlaneUrlEnvVar = 'PRAGMATIC_DESKTOP_TENANT_PLANE_URL'
    private static readonly LoopbackHttpPrefix = 'http://127.0.0.1:'
    private static readonly TenantAdminOidcDir = 'tenant-admin-oidc'
    private static readonly PositiveIntegerPattern = /^[0-9]+$/

    public static async Main(): Promise<void>
    {
        const here = dirname(fileURLToPath(import.meta.url))
        const dataRoot = join(here, ControlPlaneServer.DataDir)
        mkdirSync(dataRoot, { recursive: true })
        const opts = ControlPlaneServer.ReadOperatorOptions(process.env, dataRoot)
        const operator = await OperatorIdentity.Compose(opts)
        const masterKey = MasterKeyFile.Load(opts.masterKeyFile)
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, ControlPlaneServer.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dataRoot, ControlPlaneServer.ClientsFile)),
            new TenantRegistry(join(dataRoot, ControlPlaneServer.TenantsFile)),
            new HiveRegistry(join(dataRoot, ControlPlaneServer.HivesFile)),
            registry)
        await directory.Load()
        const signing = await ControlPlaneServer.PlatformSigningOf(process.env, dataRoot, directory)
        const allocator = new PortAllocator(ControlPlaneServer.EnvPortFloor, new NetPortProbe())
        const bundle = new BundleBuilderAdapter()
        const seeder = new UserSeederAdapter(new UserSeeder())
        const proxy = new AdminProxy(new WsAdminConnector())
        const idpService = new IdpService(new IdpRegistry(join(dataRoot, ControlPlaneServer.IdpsFile)), new DockerIdpDriver(new PortAllocator(ControlPlaneServer.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), dataRoot, DockerEnv.ImageName))
        const orchestrators = new HiveOrchestratorFactory(undefined, dataRoot)
        const placement = new EnvironmentPlacement(directory)
        // In-cluster environments are reached through pooled kubectl port-forwards; every tunnel dies with the process.
        const tunnels = new ClusterTunnelPool()
        ControlPlaneServer.CloseOnShutdown(tunnels)
        const endpoints = new EnvironmentEndpoints(orchestrators, directory, tunnels, new NodeProcessSpawner())
        const service = new EnvironmentService(registry, allocator, new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, bundle), new InClusterEnvironmentRuntime(orchestrators, placement, directory, bundle, signing.PlatformSigner), directory, orchestrators), seeder, dataRoot, proxy, directory, idpService, conn => new IdpAdminClient(conn), ControlPlaneServer.UiDeployerOf(dataRoot, orchestrators, registry), endpoints)
        const graphService = new GraphService(registry, proxy, service)
        const staticRoot = join(here, ControlPlaneServer.ParentSegment, ControlPlaneServer.PortalSegment, ControlPlaneServer.DistSegment)
        const manifests = new ManifestRegistry(join(dataRoot, ControlPlaneServer.ManifestsFile))
        const audit = new AuditRegistry(join(dataRoot, ControlPlaneServer.AuditFile))
        const desktopAudit = new AuditRegistry(join(dataRoot, ControlPlaneServer.DesktopAuditFile))
        const graphAudit = new AuditRegistry(join(dataRoot, ControlPlaneServer.TenantGraphAuditFile))
        const gating = new GatingRegistry(join(dataRoot, ControlPlaneServer.GatingFile))
        const selections = new SelectionRegistry(join(dataRoot, ControlPlaneServer.SelectionsFile))
        const observations = new HiveObservationRegistry(join(dataRoot, ControlPlaneServer.HiveObservationsFile))
        const registrations = new RolloutRegistrationRegistry(join(dataRoot, ControlPlaneServer.RegistrationsFile))
        const policies = new ReleasePolicyRegistry(join(dataRoot, ControlPlaneServer.ReleasePoliciesFile))
        const ledger = new AdoptionLedgerRegistry(join(dataRoot, ControlPlaneServer.AdoptionLedgerFile))
        const adminClientRegistry = new TenantAdminClientRegistry(join(dataRoot, ControlPlaneServer.TenantAdminClientsFile))
        const accountIndex = new TenantAccountIndex(join(dataRoot, ControlPlaneServer.TenantAccountsFile))
        const adverts = new ConsoleAdvertRegistry(join(dataRoot, ControlPlaneServer.ConsoleAdvertsFile))
        const approvals = new ConsoleDomainApprovals(join(dataRoot, ControlPlaneServer.ConsoleDomainApprovalsFile))
        // Operator Owner resets of in-hive consoles: recorded by the console installer, answered to the console in its advert.
        const ownerResets = new ConsoleOwnerResets(join(dataRoot, ControlPlaneServer.ConsoleOwnerResetsFile))
        await Promise.all([manifests.Load(), audit.Load(), desktopAudit.Load(), graphAudit.Load(), gating.Load(), selections.Load(), observations.Load(), registrations.Load(), policies.Load(), ledger.Load(), adminClientRegistry.Load(), accountIndex.Load(), adverts.Load(), approvals.Load(), ownerResets.Load()])
        await accountIndex.BackfillFrom(directory)
        const deployments = new PlatformDeploymentRegistry(manifests, gating, selections, registrations, directory, orchestrators, registry, placement, observations, ControlPlaneServer.ManifestSignerOf(signing.PlatformSigner.KeyRef, dataRoot, signing.ImageSigner), policies, ledger)
        // One tenant session store for the tenant plane and the Owner password reset (which ends the Owner's sessions).
        const tenantSessions = ControlPlaneServer.TenantSessionsOf(dataRoot)
        const principalSessions = new TenantPrincipalSessions(tenantSessions)
        const provisioning = new TenantProvisioningService(idpService, directory, conn => new IdpAdminClient(conn), principalSessions, accountIndex)
        const agentChannelRaw = process.env[ControlPlaneServer.AgentChannelPortEnvVar]
        const agentChannelPort = ControlPlaneServer.ParseAgentChannelPort(agentChannelRaw)
        const agentChannelUrlRaw = process.env[ControlPlaneServer.AgentChannelUrlEnvVar]
        const agentChannelUrl = ControlPlaneServer.AgentChannelUrl(agentChannelPort, agentChannelUrlRaw)
        if (agentChannelPort !== ControlPlaneServer.AgentChannelDisabled && agentChannelUrl === undefined)
        {
            console.warn(ControlPlaneServer.AgentChannelUrlInvalidWarning + String(agentChannelUrlRaw))
        }
        // Installs a Local hive's agent through the same cluster access the orchestrators already hold; off with the channel.
        const agentInstaller = new HiveAgentInstaller(directory, orchestrators, deployments, observations, agentChannelUrl)
        // Console keys and the dev CA are sealed under the master key; discovery and the console installer share one fingerprint-key source.
        const sealed = await SealedSecretStore.Open(join(dataRoot, SealedSecretStore.FileName), masterKey)
        const fingerprintKeys = new ConsoleFingerprintKeys(sealed)
        const discovery = new DesktopDiscoveryEndpoint(accountIndex, directory, ControlPlaneServer.DesktopTenantPlaneUrlOf(process.env), DesktopDiscoveryEndpoint.NewThrottle(),
            adverts, fingerprintKeys, approvals, registry)
        // Installs a Local hive's tenant console through the same cluster access.
        const consoleInstaller = new TenantConsoleInstaller(directory, orchestrators, new TenantAdminBootstrap(deployments), fingerprintKeys,
            new DevCertificateAuthority(join(dataRoot, DevCertificateAuthority.DirName), sealed), new InHiveIdpAdmin(orchestrators, sealed),
            new PlatformConsoleImageApproval(signing.PlatformSigner, HiveOrchestratorFactory.VerifierFor(dataRoot)),
            new FileKeyStore(join(dataRoot, ControlPlaneServer.KeysDirName)), agentChannelUrl, new SystemInstallClock(), adverts, ownerResets)
        // One email-domain service for the operator routes and the control-plane tenant plane, over the shared adverts and approvals.
        const domainVerifier = new DomainTxtVerifier(new NodeTxtResolver())
        const emailDomains = new PlatformEmailDomains(directory, adverts, approvals, domainVerifier)
        // Daily DNS re-check of verified domains (after approvals.Load; its interval timer is unref'd, so no shutdown hook).
        new DomainVerificationRechecker(approvals, domainVerifier).Start()
        const host = new ControlPlaneHost(service, graphService, staticRoot, operator, opts.secureCookie, directory, deployments, provisioning, observations, new LoginThrottle(), opts.trustedProxy, undefined, undefined, undefined, opts.allowedHosts, new OperatorAuthorization(), audit, new AuditThrottle(), idpService, agentChannelUrl, agentInstaller, new HiveAgentUninstaller(orchestrators), discovery, consoleInstaller, adverts, approvals, emailDomains)
        const port = ControlPlaneServer.ResolvePort(process.env[ControlPlaneServer.PortEnvVar])
        const tenantPlane = ControlPlaneServer.ComposeTenantPlane(process.env, dataRoot, idpService, directory, opts.secureCookie, service, new InProcessRolloutClient(deployments), orchestrators, placement,
            masterKey, adminClientRegistry, ControlPlaneServer.ParseSecretTtlHours(process.env[ControlPlaneServer.SecretTtlEnvVar]), tenantSessions, principalSessions,
            { endpoints, audit: desktopAudit }, emailDomains, new TenantGraphAccess(graphService, graphAudit))
        // Resolve (and validate) the tenant port + bind BEFORE binding the operator listener, so a misconfigured
        // tenant port fails fast at startup rather than after the operator socket is already live.
        let tenantStart: { host: TenantPlaneHost; port: number; bind: string; scheme: string; baseDomain: string } | undefined
        if (tenantPlane !== undefined)
        {
            const baseDomain = process.env[ControlPlaneServer.TenantBaseDomainEnvVar] as string
            const scheme = ControlPlaneServer.TenantScheme(process.env[ControlPlaneServer.TenantSchemeEnvVar])
            const externalPort = ControlPlaneServer.TenantExternalPort(process.env[ControlPlaneServer.TenantExternalPortEnvVar])
            const resolver = new TenantHostResolver(baseDomain, scheme, directory, externalPort)
            const tenantStaticRoot = join(here, ControlPlaneServer.ParentSegment, ControlPlaneServer.TenantPortalSegment, ControlPlaneServer.DistSegment)
            const probeMs = ControlPlaneServer.ParseHealthProbeMs(process.env[ControlPlaneServer.HealthProbeMsEnvVar])
            const probeTimeoutMs = ControlPlaneServer.ParseHealthProbeTimeoutMs(process.env[ControlPlaneServer.HealthProbeTimeoutMsEnvVar])
            const monitor = probeMs > 0
                ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), tenantPlane.events, probeMs, probeTimeoutMs, service)
                : undefined
            // The host attaches its sockets to tenantPlane.principals (principalSessions), which the Owner reset also ends.
            const tenantHost = new TenantPlaneHost(tenantPlane, resolver, tenantStaticRoot, service, monitor)
            const tenantPort = ControlPlaneServer.ResolveTenantPort(process.env[ControlPlaneServer.TenantPortEnvVar])
            const portWarning = ControlPlaneServer.ExternalPortWarning(tenantPort, externalPort)
            if (portWarning !== undefined)
            {
                console.warn(portWarning)
            }
            const tenantBind = ControlPlaneServer.TenantBind(process.env[ControlPlaneServer.TenantBindEnvVar])
            tenantStart = { host: tenantHost, port: tenantPort, bind: tenantBind, scheme, baseDomain }
        }
        // The operator listener is structurally loopback-only: no tenant route is mounted on it.
        await host.Listen(port, ControlPlaneServer.BindHost)
        console.log(ControlPlaneServer.ListeningPrefix + String(port) + ControlPlaneServer.ListeningSuffix)
        if (agentChannelPort === ControlPlaneServer.AgentChannelDisabled && agentChannelRaw !== undefined && agentChannelRaw !== '')
        {
            console.warn(ControlPlaneServer.AgentChannelInvalidPortWarning + agentChannelRaw)
        }
        if (agentChannelPort !== ControlPlaneServer.AgentChannelDisabled)
        {
            const agentBind = ControlPlaneServer.ParseAgentChannelBind(process.env[ControlPlaneServer.AgentChannelBindEnvVar])
            await new AgentChannelHost(deployments, new ConsoleAdvertReceiver(directory, adverts, undefined, ownerResets, emailDomains)).Listen(agentChannelPort, agentBind)
            console.log(ControlPlaneServer.AgentChannelListeningPrefix + agentBind + ControlPlaneServer.HostPortSeparator + String(agentChannelPort))
        }
        if (tenantStart !== undefined)
        {
            await tenantStart.host.Listen(tenantStart.port, tenantStart.bind)
            console.log(ControlPlaneServer.TenantListeningPrefix + tenantStart.scheme + ControlPlaneServer.SchemeHostSeparator + tenantStart.baseDomain + ControlPlaneServer.HostPortSeparator + String(tenantStart.port) + ControlPlaneServer.ListeningSuffix)
        }
    }

    /** Pure: derives operator-identity compose options and cookie policy from the environment. */
    public static ReadOperatorOptions(env: NodeJS.ProcessEnv, dataRoot: string): OperatorComposeOptions & { secureCookie: boolean; trustedProxy: boolean; allowedHosts: readonly string[] }
    {
        const password = env[ControlPlaneServer.OperatorPasswordEnvVar]
        const secure = env[ControlPlaneServer.SecureCookieEnvVar]
        const proxied = env[ControlPlaneServer.TrustedProxyEnvVar]
        return {
            masterKeyFile: env[ControlPlaneServer.MasterKeyEnvVar] ?? join(dataRoot, ControlPlaneServer.MasterKeyFileName),
            identityRoot: join(dataRoot, ControlPlaneServer.IdentitySegment),
            operatorEmail: env[ControlPlaneServer.OperatorEmailEnvVar] ?? ControlPlaneServer.DefaultOperatorEmail,
            initialPassword: password === undefined || password === '' ? undefined : password,
            secureCookie: secure === ControlPlaneServer.TrueToken || secure === ControlPlaneServer.OneToken,
            trustedProxy: proxied === ControlPlaneServer.TrueToken || proxied === ControlPlaneServer.OneToken,
            allowedHosts: ControlPlaneServer.ParseHostList(env[ControlPlaneServer.AllowedHostsEnvVar]),
        }
    }

    /** Pure: whether an env flag is set to true ('true' or '1'). */
    public static ReadsTrue(raw: string | undefined): boolean
    {
        return raw === ControlPlaneServer.TrueToken || raw === ControlPlaneServer.OneToken
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
        return ControlPlaneServer.BuildTenantPlane(dataRoot, idpService, directory, secureCookie, service, rollout, orchestrators, placement,
            masterKey, adminClientRegistry, secretTtlHours, sessions, principals, ControlPlaneServer.ReadsTrue(env[TenantAdminEnv.TrustedProxy]), true, relay, emailDomains, undefined, graphs)
    }

    /**
     * Gate-free composition of the tenant plane; callers decide whether the plane is active (ComposeTenantPlane gates on env,
     * the standalone server always builds it). `withDesktop` mounts the Plexus `/desktop/*` surface; it is off by default.
     * The desktop relay is mounted with it when `relay` supplies how environments are reached and where relays are audited.
     * `emailDomains` mounts `/tenant-api/settings/email-domains` (unrouted without it). `consoleTenantId` is the one tenant
     * an in-hive console serves: it mounts `GET /desktop/console` (absent on the control plane, where that is not a route).
     * `graphs` mounts the graph routes of the tenant's Development environments (unrouted without it).
     */
    public static BuildTenantPlane(
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
        sessions: TenantSessionStore = ControlPlaneServer.TenantSessionsOf(dataRoot),
        principals: TenantPrincipalSessions = new TenantPrincipalSessions(sessions),
        trustedProxy: boolean = false,
        withDesktop: boolean = false,
        relay?: DesktopRelayWiring,
        emailDomains?: ITenantEmailDomains,
        consoleTenantId?: string,
        graphs?: TenantGraphAccess): TenantPlane
    {
        const durability: TenantAdminDurability = {
            storeRoot: join(dataRoot, ControlPlaneServer.TenantAdminOidcDir),
            masterKey,
            registry: adminClientRegistry,
            secretTtlMs: secretTtlHours * ControlPlaneServer.MsPerHour,
        }
        const rp = new TenantOidcRelyingParty(idpService, directory, conn => new IdpAdminClient(conn), undefined, undefined, durability)
        const passwordChange = new TenantPasswordChange(idpService, new IdpPasswordClient(), principals, secureCookie, trustedProxy)
        const endpoint = new TenantAuthEndpoint(rp, sessions, secureCookie, passwordChange)
        const gate = new TenantAuthGate(sessions)
        const api = new TenantApiEndpoint(service, directory, rollout, orchestrators, placement, emailDomains, graphs)
        const events = new TenantEventBus()
        const plane: TenantPlane = { endpoint, gate, api, events, isDurable: rp.IsDurable, principals }
        if (withDesktop)
        {
            // Given the tenant records, a bearer of a deleted (or deleted and re-created) tenant is refused.
            const desktopGate = new DesktopAuthGate(sessions, directory)
            const targets = new DesktopTargets(service, directory)
            if (relay !== undefined)
            {
                plane.relay = new DesktopRelay(desktopGate, targets, service, relay.endpoints, relay.audit, new WsUpstreamDialer(), new AuditThrottle(), trustedProxy)
            }
            // A desktop sign-out also closes the relays opened under that session.
            plane.desktop = new DesktopEndpoint(rp, sessions, desktopGate, new DesktopSignInFlows(), targets, directory,
                session => api.Profile(session), new LoginThrottle(), DesktopEndpoint.NewBeginThrottle(), trustedProxy, plane.relay, consoleTenantId)
        }
        return plane
    }

    /** The externally-visible tenant origin scheme; defaults to https when unset or blank. */
    public static TenantScheme(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? ControlPlaneServer.DefaultExternalScheme : raw
    }

    /** The tenant listener bind address; defaults to loopback (proxy-fronted) when unset or blank. */
    public static TenantBind(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? ControlPlaneServer.DefaultTenantBind : raw
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
        if (port === ControlPlaneServer.AgentChannelDisabled)
        {
            return undefined
        }
        if (raw === undefined || raw === '')
        {
            return ControlPlaneServer.DefaultAgentChannelUrlPrefix + String(port)
        }
        return ControlPlaneServer.IsHttpUrl(raw) ? raw : undefined
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
     * tenant listener when the tenant plane is enabled (both port and base domain set), else undefined (discovery answers 503).
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

    /** The tenant session store under the data root (one instance per process: the plane and the Owner reset share it). */
    public static TenantSessionsOf(dataRoot: string): TenantSessionStore
    {
        return new TenantSessionStore(join(dataRoot, ControlPlaneServer.TenantSessionsFile), ControlPlaneServer.TenantSessionTtlMs)
    }

    /** Pure: the startup warning for a tenant listener off 80/443 with no external port set (a proxy-less run needs it); undefined otherwise. */
    public static ExternalPortWarning(tenantPort: number, externalPort: number | undefined): string | undefined
    {
        return externalPort !== undefined || ControlPlaneServer.ProxyPorts.has(tenantPort)
            ? undefined
            : ControlPlaneServer.ExternalPortWarningPrefix + String(tenantPort) + ControlPlaneServer.ExternalPortWarningSuffix
    }

    /** Pure: the tenant origin's optional external port; undefined when unset or blank, throws naming the variable when invalid. */
    public static TenantExternalPort(raw: string | undefined): number | undefined
    {
        if (raw === undefined || raw === '')
        {
            return undefined
        }
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > ControlPlaneServer.MaxPort)
        {
            throw new Error(ControlPlaneServer.BadTenantExternalPortPrefix + raw)
        }
        return port
    }

    public static ResolveTenantPort(raw: string | undefined): number
    {
        const port = Number(raw)
        if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 1 || port > ControlPlaneServer.MaxPort)
        {
            throw new Error(ControlPlaneServer.BadTenantPortPrefix + String(raw))
        }
        return port
    }

    /** Pure: parses the tenant-admin secret TTL in hours; anything but a positive integer yields the default. */
    public static ParseSecretTtlHours(raw: string | undefined): number
    {
        if (raw === undefined || !ControlPlaneServer.PositiveIntegerPattern.test(raw))
        {
            return ControlPlaneServer.DefaultSecretTtlHours
        }
        const hours = Number.parseInt(raw, 10)
        return hours > 0 ? hours : ControlPlaneServer.DefaultSecretTtlHours
    }

    /** Pure: parses the tenant health probe interval in ms; 0 disables, a positive integer within [Min, Max] is honoured, anything else (including out-of-range) yields the default. */
    public static ParseHealthProbeMs(raw: string | undefined): number
    {
        if (raw === undefined || !ControlPlaneServer.PositiveIntegerPattern.test(raw))
        {
            return ControlPlaneServer.DefaultHealthProbeMs
        }
        const ms = Number.parseInt(raw, 10)
        if (ms === 0)
        {
            return 0
        }
        if (ms < ControlPlaneServer.MinHealthProbeMs || ms > ControlPlaneServer.MaxHealthProbeMs)
        {
            return ControlPlaneServer.DefaultHealthProbeMs
        }
        return ms
    }

    /** Pure: parses the per-probe timeout in ms; 0 disables the deadline, a positive integer within [Min, Max] is honoured, anything else yields the default. */
    public static ParseHealthProbeTimeoutMs(raw: string | undefined): number
    {
        if (raw === undefined || !ControlPlaneServer.PositiveIntegerPattern.test(raw))
        {
            return ControlPlaneServer.DefaultHealthProbeTimeoutMs
        }
        const ms = Number.parseInt(raw, 10)
        if (ms === 0)
        {
            return 0
        }
        if (ms < ControlPlaneServer.MinHealthProbeMs || ms > ControlPlaneServer.MaxHealthProbeMs)
        {
            return ControlPlaneServer.DefaultHealthProbeTimeoutMs
        }
        return ms
    }

    /** The UI deploy actuator: pushes via the control-plane registry address and signs with the keys under dataRoot. */
    private static UiDeployerOf(dataRoot: string, orchestrators: HiveOrchestratorFactory, registry: EnvironmentRegistry): UiDeployActuator
    {
        const keys = new FileKeyStore(join(dataRoot, ControlPlaneServer.KeysDirName))
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
    public static async PlatformSigningOf(env: NodeJS.ProcessEnv, dataRoot: string, directory: PlatformDirectory): Promise<{ ImageSigner: IImageSigner; PlatformSigner: PlatformImageSigner }>
    {
        const C = ControlPlaneServer
        const keysDir = join(dataRoot, C.KeysDirName)
        const ref = C.SigningKeyRefOf(env)
        if (ref === PlatformSigningKey.DefaultRef)
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
        const imageSigner = C.ImageSignerOf(dataRoot)
        return { ImageSigner: imageSigner, PlatformSigner: new PlatformImageSigner(imageSigner, ref) }
    }

    /** The registry manifest signer: publishes are signed with the platform signing key `ref`, through the shared image signer. */
    public static ManifestSignerOf(ref: string, dataRoot: string, signer: IImageSigner): IManifestSigner
    {
        const store = new FileSignatureStore(join(dataRoot, ControlPlaneServer.SignaturesFileName))
        return new ManifestSigner(new DockerImageDigest(), signer, store, ref)
    }

    /** Signs images into the same signature store the hive orchestrators verify against, with keys from the key store. */
    public static ImageSignerOf(dataRoot: string): ImageSigner
    {
        const digests = new DockerImageDigest()
        const store = new FileSignatureStore(join(dataRoot, ControlPlaneServer.SignaturesFileName))
        return new ImageSigner(digests, store, new FileKeyStore(join(dataRoot, ControlPlaneServer.KeysDirName)))
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
