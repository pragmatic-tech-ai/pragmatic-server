import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { AuditRegistry } from './audit-record.js'
import { BundleBuilderAdapter, UserSeederAdapter } from './environment-seed-port.js'
import { NoHostEnvironmentRuntime } from './no-host-environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { InClusterEnvironmentReach } from './in-cluster-environment-reach.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { GraphService } from './graph-service.js'
import { TenantGraphAccess } from './tenant-api/tenant-graph-access.js'
import type { IEnvironmentReach } from './environment-endpoints.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { InClusterOrchestration } from './in-cluster-hive-orchestrator.js'
import { IngressTlsPolicy, type IngressTls } from './ingress-tls.js'
import { HttpsKubeTransport, InClusterServiceAccount, KubeApiClient } from './kube-api-client.js'
import type { PinnedImageVerifier } from './pinned-image-verifier.js'
import { IdpAdminClient } from './idp-admin-client.js'
import type { IIdpService } from './idp-service.js'
import { InjectedIdpService } from './injected-idp-service.js'
import { UnconfiguredIdpService } from './unconfigured-idp-service.js'
import { MasterKeyFile } from './master-key-file.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { TenantPlaneComposer } from './tenant-plane-composer.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import { ConsoleFingerprint } from './console-advert-contract.js'
import { ConsoleAdvertSender, HttpConsoleAdvertTransport, IntervalAdvertTimer, SeededConsoleAccounts, type IOwnerResetFollower } from './console-advert-sender.js'
import { ConsoleEmailDomainStore } from './console-email-domain-store.js'
import { ConsoleOwnerResetFollower } from './console-owner-reset-follower.js'
import { ConsoleFingerprintKeys } from './console-fingerprint-keys.js'
import { ConsoleRegistration } from './console-registration.js'
import type { SeededTenantDirectory } from './tenant-api/seeded-tenant-directory.js'
import { ConsoleDelivery } from './console-delivery.js'
import { TenantAdminDatabase, TenantAdminRegistry } from './tenant-admin-database.js'
import { TenantAdminImport } from './tenant-admin-import.js'
import type { IRecordMap } from './record-map.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'
import { UnconfiguredRolloutClient } from './tenant-api/unconfigured-rollout-client.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import { HttpRolloutClient } from './tenant-api/http-rollout-client.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantHostResolver, type ConsoleHostAlias } from './tenant-auth/tenant-host-resolver.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import { TenantSessions } from './tenant-auth/tenant-sessions.js'
import { TenantHealthMonitor } from './tenant-health-monitor.js'
import { TenantConsoleHost } from './tenant-console-host.js'
import { ConfigurationService } from './configuration/configuration-service.js'
import { ConfigurationTargets } from './configuration/configuration-targets.js'
import { ConsoleComponents } from './configuration/console-components.js'
import { KubeConfigurationApplier, UnavailableConfigurationApplier } from './configuration/kube-configuration-applier.js'

export type TenantAdminConfig = {
    readonly dataRoot: string
    readonly port: number
    readonly bind: string
    readonly baseDomain: string
    readonly scheme: string
    /** The tenant origin's externally visible port, when it is not the scheme default (proxy-less runs). */
    readonly externalPort: number | undefined
    readonly secureCookie: boolean
    /** Whether the tenant listener is behind a trusted proxy (PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY). */
    readonly trustedProxy: boolean
    readonly secretTtlHours: number
    readonly probeMs: number
    readonly probeTimeoutMs: number
    /** The console's own host (PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST); it answers for the seeded tenant. */
    readonly consoleHost: string | undefined
    /** Path of the mounted account-email fingerprint key (PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE); undefined outside a console pod. */
    readonly fingerprintKeyFile: string | undefined
    /** How environment Ingresses get TLS; undefined = none configured. */
    readonly ingressTls: IngressTls | undefined
}

/** Everything the console advert sender needs, once every setting is present and the key file is good. */
type AdvertSettings = {
    readonly url: string
    readonly token: string
    readonly hiveId: string
    readonly key: Buffer
    readonly consoleUrl: string
}

export type TenantAdminComposition = {
    readonly directory: SeededTenantDirectory
    readonly rollout: IRolloutClient
    readonly plane: TenantPlane
    readonly host: TenantConsoleHost
    readonly monitor: TenantHealthMonitor | undefined
    readonly config: TenantAdminConfig
    /** How this console reaches environments in its own hive; undefined outside a pod. */
    readonly reach: IEnvironmentReach | undefined
    /** The console's own email domains (seeded from the tenant record until first saved). */
    readonly emailDomains: ConsoleEmailDomainStore
    /** Tells the control plane about this console; undefined unless every advert setting is present (a real console pod). */
    readonly advert: ConsoleAdvertSender | undefined
    /** The desktop relay's audit, loaded before the plane is built. */
    readonly desktopAudit: AuditRegistry
    /** The graph routes' audit, loaded before the plane is built. */
    readonly graphAudit: AuditRegistry
    /**
     * Whether the platform still takes this console's adverts (stored in the console's database): the advert sender
     * feeds it, and the host refuses the desktop surface and the relay while it is Refused. Without an advert sender it opens
     * Registered regardless of the file and does not gate the host (nothing could ever restore Registered).
     */
    readonly registration: ConsoleRegistration
    /** The console's own Postgres database; closed with the console. */
    readonly database: TenantAdminDatabase
}

/**
 * The standalone tenant-admin process: boots ONLY the tenant plane over its own data root. Tenant and hive identity
 * come from a seed file (`seed.json`) instead of the operator's PlatformDirectory, and rollout reads/actions go
 * through an injected IRolloutClient. There is no operator plane and no agent channel here.
 * It serves the Plexus desktop surface (`/desktop/*`, including the `/desktop/console` lookup of its one tenant); the
 * desktop relay to environments only in a pod, where the in-cluster reach exists (outside one it has no way to reach them).
 */
export class TenantAdminServer
{
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly MissingMasterKeyPrefix = 'Tenant-admin master key file not found: '
    private static readonly ListeningTemplate = 'Tenant plane listening on {scheme}://{domain}:{port}/'
    private static readonly SchemeToken = '{scheme}'
    private static readonly DomainToken = '{domain}'
    private static readonly PortToken = '{port}'
    private static readonly EmptyString = ''
    private static readonly NoIdentityMessage = 'The seed names no hive for the in-cluster console.'
    private static readonly ConsoleUrlScheme = 'https://'
    private static readonly AdvertOffPrefix = '[console-advert] off: '
    /** Logged once at Compose when there is no advert sender, so the registration cannot gate the desktop. */
    public static readonly RegistrationGateOffLine = '[console-registration] gate off: the advert is not configured, so the registration never refuses the desktop'
    private static readonly NotSetSuffix = ' is not set'
    private static readonly BadKeyInfix = ' does not name a readable key file of '
    private static readonly BytesSuffix = ' bytes'

    private running: TenantAdminComposition | undefined
    /** Whether Run opened the running composition's database (and Close therefore ends it). */
    private ownsDatabase = false

    public constructor(
        private readonly config: TenantAdminConfig,
        private readonly rollout: IRolloutClient)
    {
    }

    /** Entry point used by the bin: reads config from the environment and runs with the default rollout client. */
    public static async Main(): Promise<void>
    {
        const config = TenantAdminServer.ReadConfig(process.env)
        await new TenantAdminServer(config, TenantAdminServer.RolloutClientFrom(process.env)).Run()
    }

    /** The HTTP rollout client when the agent-channel URL is configured (token + hive id then required); otherwise the default. */
    public static RolloutClientFrom(env: NodeJS.ProcessEnv): IRolloutClient
    {
        const url = env[TenantAdminEnv.RolloutUrl]
        if (url === undefined || url === TenantAdminServer.EmptyString)
        {
            return TenantAdminServer.DefaultRolloutClient()
        }
        return new HttpRolloutClient(
            url,
            TenantAdminServer.Required(env, TenantAdminEnv.RolloutToken),
            TenantAdminServer.Required(env, TenantAdminEnv.RolloutHiveId))
    }

    /** The default rollout client; the in-container HTTP client replaces it when the operator link is wired. */
    public static DefaultRolloutClient(): IRolloutClient
    {
        return new UnconfiguredRolloutClient()
    }

    /** Pure: derives the config from the environment; a missing required variable throws naming it. */
    public static ReadConfig(env: NodeJS.ProcessEnv): TenantAdminConfig
    {
        const dataRoot = TenantAdminServer.Required(env, TenantAdminEnv.DataRoot)
        const portRaw = TenantAdminServer.Required(env, TenantAdminEnv.Port)
        const baseDomain = TenantAdminServer.Required(env, TenantAdminEnv.BaseDomain)
        return {
            dataRoot,
            port: TenantPlaneComposer.ResolveTenantPort(portRaw),
            bind: TenantPlaneComposer.TenantBind(env[TenantAdminEnv.Bind]),
            baseDomain,
            scheme: TenantPlaneComposer.TenantScheme(env[TenantAdminEnv.Scheme]),
            externalPort: TenantPlaneComposer.TenantExternalPort(env[TenantAdminEnv.ExternalPort]),
            secureCookie: TenantPlaneComposer.ReadsTrue(env[TenantAdminEnv.SecureCookie]),
            trustedProxy: TenantPlaneComposer.ReadsTrue(env[TenantAdminEnv.TrustedProxy]),
            secretTtlHours: TenantPlaneComposer.ParseSecretTtlHours(env[TenantAdminEnv.SecretTtl]),
            probeMs: TenantPlaneComposer.ParseHealthProbeMs(env[TenantAdminEnv.HealthProbeMs]),
            probeTimeoutMs: TenantPlaneComposer.ParseHealthProbeTimeoutMs(env[TenantAdminEnv.HealthProbeTimeoutMs]),
            consoleHost: TenantAdminServer.OptionalOf(env, TenantAdminEnv.ConsoleHost),
            fingerprintKeyFile: TenantAdminServer.OptionalOf(env, TenantAdminEnv.FingerprintKeyFile),
            ingressTls: IngressTlsPolicy.FromEnv(env),
        }
    }

    /**
     * The console's advert sender: undefined (and one log line naming the missing setting's env var, never a value) unless
     * consoleHost, a ConsoleFingerprintKeys.KeyBytes key file and RolloutUrl / RolloutToken / RolloutHiveId are all present.
     * It dials home over the same agent channel, bearer and hive as the HTTP rollout client. consoleUrl = 'https://' + consoleHost.
     * Every 200 answer is handed to `follower` (the console's ConsoleOwnerResetFollower) when one is given, and every
     * outcome to `registration` (the console's ConsoleRegistration) when one is given. Building it attaches its transport as
     * `domains`' verify channel (see SenderFrom).
     */
    public static AdvertSenderOf(env: NodeJS.ProcessEnv, cfg: TenantAdminConfig, tenant: TenantRecord, domains: ConsoleEmailDomainStore, log: (line: string) => void = TenantAdminServer.LogLine, follower?: IOwnerResetFollower, registration?: ConsoleRegistration): ConsoleAdvertSender | undefined
    {
        const settings = TenantAdminServer.AdvertSettingsOf(env, cfg, log)
        return settings === undefined ? undefined : TenantAdminServer.SenderFrom(settings, tenant, domains, log, follower, registration)
    }

    /** The advert's settings, or undefined after one log line naming the first missing or bad one (never a value). */
    private static AdvertSettingsOf(env: NodeJS.ProcessEnv, cfg: TenantAdminConfig, log: (line: string) => void): AdvertSettings | undefined
    {
        const S = TenantAdminServer
        const url = S.OptionalOf(env, TenantAdminEnv.RolloutUrl)
        const token = S.OptionalOf(env, TenantAdminEnv.RolloutToken)
        const hiveId = S.OptionalOf(env, TenantAdminEnv.RolloutHiveId)
        if (cfg.consoleHost === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.ConsoleHost + S.NotSetSuffix)
        }
        if (cfg.fingerprintKeyFile === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.FingerprintKeyFile + S.NotSetSuffix)
        }
        if (url === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutUrl + S.NotSetSuffix)
        }
        if (token === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutToken + S.NotSetSuffix)
        }
        if (hiveId === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutHiveId + S.NotSetSuffix)
        }
        const key = ConsoleFingerprint.ReadKeyFile(cfg.fingerprintKeyFile)
        if (key === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.FingerprintKeyFile + S.BadKeyInfix + ConsoleFingerprintKeys.KeyBytes + S.BytesSuffix)
        }
        return { url, token, hiveId, key, consoleUrl: S.ConsoleUrlScheme + cfg.consoleHost }
    }

    /**
     * The sender over one agent-channel transport, which is also attached as `domains`' verify channel, so a Verify on this
     * console reaches the platform over the same channel, bearer and hive as the advert.
     */
    private static SenderFrom(settings: AdvertSettings, tenant: TenantRecord, domains: ConsoleEmailDomainStore, log: (line: string) => void, follower?: IOwnerResetFollower, registration?: ConsoleRegistration): ConsoleAdvertSender
    {
        const transport = new HttpConsoleAdvertTransport(settings.url, settings.token, settings.hiveId)
        domains.AttachVerifyChannel(transport)
        return new ConsoleAdvertSender(transport, new SeededConsoleAccounts(tenant), domains,
            settings.key, settings.consoleUrl, new IntervalAdvertTimer(), log, follower, registration)
    }

    /**
     * The console's registration and whether it gates the host. Only an advert answer can restore Registered, so without
     * an advert sender a saved Refused state could never clear: the registration then opens Registered without reading the
     * file (which is left alone), does not gate the desktop, and one fixed line says so.
     */
    private static async RegistrationOf(stored: IRecordMap<unknown>, advertConfigured: boolean, log: (line: string) => void): Promise<ConsoleRegistration>
    {
        if (advertConfigured)
        {
            // Never throws: a missing or bad record opens Registered, so the desktop is never locked out by it.
            return ConsoleRegistration.Open(stored, log)
        }
        log(TenantAdminServer.RegistrationGateOffLine)
        return ConsoleRegistration.OpenRegistered(stored, log)
    }

    /**
     * In-cluster the operator provisioned the IdP, so the pod only CONNECTS (injected env + mounted Secret files). Without that
     * injection there is no IdP: the console never launches one (that is the platform's job, and the dev-box Docker IdP
     * driver is not part of this app).
     */
    public static BuildIdpService(env: NodeJS.ProcessEnv): IIdpService
    {
        return InjectedIdpService.FromEnv(env) ?? new UnconfiguredIdpService()
    }

    /**
     * What the console needs to orchestrate its own hive through the Kubernetes API: the API client over the pod's service
     * account, the identity from the seed (tenant + the hive it was installed into) and the pinned-image allow-list the
     * platform delivered. No network call.
     */
    public static InClusterOrchestrationOf(account: InClusterServiceAccount, directory: SeededTenantDirectory, verifier: PinnedImageVerifier): InClusterOrchestration
    {
        const hive = TenantAdminServer.FirstHiveOf(directory)
        return {
            client: new KubeApiClient(new HttpsKubeTransport(account)),
            identity: { tenantId: hive.tenantId, hiveId: hive.id },
            verifier,
        }
    }

    /** The tenant portal bundle folder: PRAGMATIC_TENANT_ADMIN_PORTAL_DIR (resolved) when set, else the shipped `admin/tenant-portal/dist`. */
    public static PortalRootOf(env: NodeJS.ProcessEnv): string
    {
        const raw = env[TenantAdminEnv.PortalDir]?.trim() ?? TenantAdminServer.EmptyString
        if (raw !== TenantAdminServer.EmptyString)
        {
            return resolve(raw)
        }
        return join(dirname(fileURLToPath(import.meta.url)), TenantPlaneComposer.ParentSegment, TenantPlaneComposer.TenantPortalSegment, TenantPlaneComposer.DistSegment)
    }

    /**
     * Builds the whole tenant plane over the console's own database (opened from PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE,
     * or the one given) without binding anything: the platform's delivery (seed, verified images), every store, services,
     * plane (with the desktop surface; its relay only in a pod), host, health monitor, the console's email domains, the
     * desktop and graph audits, the console registration (gating the host only when there is an advert sender) and (in a
     * configured console) its advert sender. A database that holds none of the console's records while the data root still
     * holds pre-A5 ones is imported first (TenantAdminImport.ImportIfPending; the files stay as the backup).
     */
    public async Compose(env: NodeJS.ProcessEnv = process.env, serviceAccountRoot?: string, log: (line: string) => void = TenantAdminServer.LogLine, database?: TenantAdminDatabase): Promise<TenantAdminComposition>
    {
        const cfg = this.config
        const dataRoot = cfg.dataRoot
        const keyPath = join(dataRoot, TenantPlaneComposer.MasterKeyFileName)
        if (!existsSync(keyPath))
        {
            throw new Error(TenantAdminServer.MissingMasterKeyPrefix + keyPath)
        }
        const masterKey = MasterKeyFile.Load(keyPath)
        const db = database ?? await TenantAdminDatabase.Open(env)
        try
        {
            await TenantAdminImport.ImportIfPending(dataRoot, db, log)
            return await this.ComposeOver(db, masterKey, env, serviceAccountRoot, log)
        }
        catch (err)
        {
            if (database === undefined)
            {
                await db.Close()
            }
            throw err
        }
    }

    private async ComposeOver(db: TenantAdminDatabase, masterKey: Buffer, env: NodeJS.ProcessEnv, serviceAccountRoot: string | undefined, log: (line: string) => void): Promise<TenantAdminComposition>
    {
        const cfg = this.config
        const dataRoot = cfg.dataRoot
        const R = TenantAdminRegistry
        const directory = await ConsoleDelivery.Seed(dataRoot, await db.Map(R.DirectorySeed))
        const verifier = await ConsoleDelivery.VerifiedImages(dataRoot, await db.Map(R.VerifiedImages))
        // No host (Docker) backend: the console runs environments only in its own hive, so an unbound record never runs here.
        const noHost = new NoHostEnvironmentRuntime()
        const registry = new EnvironmentRegistry(await db.Map(R.Environments), noHost)
        await registry.Load()
        const adminClients = new TenantAdminClientRegistry(await db.Map(R.TenantAdminClients))
        await adminClients.Load()
        const idpService = TenantAdminServer.BuildIdpService(env)
        const account = InClusterServiceAccount.Detect(env, serviceAccountRoot)
        const inCluster = account === undefined ? undefined : TenantAdminServer.InClusterOrchestrationOf(account, directory, verifier)
        const orchestrators = inCluster === undefined ? new HiveOrchestratorFactory() : new HiveOrchestratorFactory(undefined, dataRoot, inCluster)
        const placement = new EnvironmentPlacement(directory, cfg.ingressTls)
        const reach = inCluster === undefined ? undefined : new InClusterEnvironmentReach(orchestrators.For(TenantAdminServer.FirstHiveOf(directory)).Kubectl)
        // No PlatformImageSigner here, deliberately: the platform signing key's private half never ships into a hive, so
        // the in-hive tenant admin cannot sign. It runs only images the platform signed (its hive's verification decides).
        const proxy = new AdminProxy(new WsAdminConnector())
        const service = new EnvironmentService(registry, new PortAllocator(TenantPlaneComposer.EnvPortFloor, new NetPortProbe()), new EnvironmentRuntimeResolver(noHost, new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter()), directory, orchestrators), new UserSeederAdapter(new UserSeeder()), dataRoot, proxy, directory, idpService, conn => new IdpAdminClient(conn), undefined, reach)
        const tenant = directory.Tenant
        const emailDomains = await ConsoleEmailDomainStore.Open(await db.Map(R.EmailDomains), tenant.id, tenant.emailDomains)
        const desktopAudit = new AuditRegistry(await db.Map(R.DesktopAudit))
        await desktopAudit.Load()
        const graphAudit = new AuditRegistry(await db.Map(R.GraphAudit))
        await graphAudit.Load()
        // Graphs live in the environments, so outside a pod (no reach) the routes answer 503 instead of calling out.
        const graphs = new TenantGraphAccess(reach === undefined ? undefined : new GraphService(registry, proxy, service), graphAudit)
        // The desktop surface is always served; the relay only when this console can reach its environments (in a pod).
        const relay = reach === undefined ? undefined : { endpoints: reach, audit: desktopAudit }
        const resolver = new TenantHostResolver(cfg.baseDomain, cfg.scheme, directory, cfg.externalPort, TenantAdminServer.ConsoleAliasOf(cfg, directory))
        const sessions = new TenantSessions(await db.SessionRepositories(), cfg.secureCookie)
        const plane = TenantPlaneComposer.BuildTenantPlane({
            Idp: idpService,
            Directory: directory,
            Service: service,
            Rollout: this.rollout,
            Orchestrators: orchestrators,
            Placement: placement,
            Sessions: sessions,
            Resolver: resolver,
            FlowStates: await db.FlowStates(),
            ClientSecrets: { Store: await db.Secrets(masterKey), Registry: adminClients, TtlMs: TenantPlaneComposer.SecretTtlMsOf(cfg.secretTtlHours) },
            TrustedProxy: cfg.trustedProxy,
            Desktop: true,
            Relay: relay,
            EmailDomains: emailDomains,
            ConsoleTenantId: tenant.id,
            Graphs: graphs,
            // The console writes configurations next to its environments' deployments through its own cluster access.
            Configuration: new ConfigurationService(await db.Configuration(), ConsoleComponents.Release(), new ConfigurationTargets(registry),
                inCluster === undefined ? new UnavailableConfigurationApplier() : new KubeConfigurationApplier(inCluster.client)),
        })
        const monitor = cfg.probeMs > 0
            ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), plane.events, cfg.probeMs, cfg.probeTimeoutMs, service)
            : undefined
        const advertSettings = TenantAdminServer.AdvertSettingsOf(env, cfg, log)
        const registration = await TenantAdminServer.RegistrationOf(await db.Map(R.Registration), advertSettings !== undefined, log)
        // No advert sender, no gate: nothing could ever lift a refusal.
        const host = new TenantConsoleHost({
            Plane: plane,
            Resolver: resolver,
            Service: service,
            PortalRoot: TenantAdminServer.PortalRootOf(env),
            Monitor: monitor,
            Registration: advertSettings === undefined ? undefined : registration,
            Audit: await db.Audit(),
            TrustedProxy: cfg.trustedProxy,
        })
        // An operator Owner reset reaches this console in the advert answer; the follower then ends the Owner's sessions, sockets
        // and relays (the host has attached both to plane.principals above).
        const follower = new ConsoleOwnerResetFollower(plane.principals, tenant, await db.Map(R.OwnerResetApplied))
        const advert = advertSettings === undefined ? undefined : TenantAdminServer.SenderFrom(advertSettings, tenant, emailDomains, log, follower, registration)
        return { directory, rollout: this.rollout, plane, host, monitor, config: cfg, reach, emailDomains, advert, desktopAudit, graphAudit, registration, database: db }
    }

    /**
     * Composes, binds the tenant listener, then starts the advert (its first send awaited; a failure is logged, never thrown).
     * `database` replaces the one the environment names (tests).
     */
    public async Run(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = TenantAdminServer.LogLine, database?: TenantAdminDatabase): Promise<TenantAdminComposition>
    {
        const composition = await this.Compose(env, undefined, log, database)
        const cfg = composition.config
        try
        {
            await composition.host.Listen(cfg.port, cfg.bind)
        }
        catch (err)
        {
            if (database === undefined)
            {
                await composition.database.Close()
            }
            throw err
        }
        // Only a listener that bound counts as running, so Close after a failed Listen has nothing to stop.
        this.running = composition
        this.ownsDatabase = database === undefined
        console.log(TenantAdminServer.ListeningLine(cfg))
        await composition.advert?.Start()
        return composition
    }

    /**
     * Stops the advert (aborting a send in flight and waiting for it to end, so nothing is logged afterwards), closes the
     * tenant listener started by Run (which also closes the desktop relay and awaits its pending audit writes), then the
     * database Run opened (even when closing the listener failed; a database the caller passed stays theirs); a no-op
     * when nothing runs.
     */
    public async Close(): Promise<void>
    {
        const composition = this.running
        this.running = undefined
        if (composition === undefined)
        {
            return
        }
        composition.advert?.Stop()
        await composition.advert?.Idle()
        try
        {
            await composition.host.Close()
        }
        finally
        {
            if (this.ownsDatabase)
            {
                await composition.database.Close()
            }
        }
    }

    private static AdvertOff(log: (line: string) => void, reason: string): undefined
    {
        log(TenantAdminServer.AdvertOffPrefix + reason)
        return undefined
    }

    private static LogLine(line: string): void
    {
        console.error(line)
    }

    private static ListeningLine(cfg: TenantAdminConfig): string
    {
        return TenantAdminServer.ListeningTemplate
            .replace(TenantAdminServer.SchemeToken, cfg.scheme)
            .replace(TenantAdminServer.DomainToken, cfg.baseDomain)
            .replace(TenantAdminServer.PortToken, String(cfg.port))
    }

    private static ConsoleAliasOf(cfg: TenantAdminConfig, directory: SeededTenantDirectory): ConsoleHostAlias | undefined
    {
        return cfg.consoleHost === undefined ? undefined : { host: cfg.consoleHost, tenantId: TenantAdminServer.FirstHiveOf(directory).tenantId }
    }

    /** The seed's first hive: the console's own identity. Throws NoIdentityMessage when the seed has none. */
    private static FirstHiveOf(directory: SeededTenantDirectory): HiveRecord
    {
        const hive = directory.ListHives()[0]
        if (hive === undefined)
        {
            throw new Error(TenantAdminServer.NoIdentityMessage)
        }
        return hive
    }

    private static OptionalOf(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]
        return value === undefined || value === TenantAdminServer.EmptyString ? undefined : value
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value === TenantAdminServer.EmptyString)
        {
            throw new Error(TenantAdminServer.MissingEnvPrefix + name)
        }
        return value
    }
}
