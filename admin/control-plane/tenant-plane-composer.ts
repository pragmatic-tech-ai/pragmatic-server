import { OidcRelyingParty } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { IOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { AuditRegistry } from './audit-record.js'
import { AuditThrottle } from './audit-throttle.js'
import type { IEnvironmentReach } from './environment-endpoints.js'
import type { EnvironmentPlacement } from './environment-placement.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { IdpAdminClient } from './idp-admin-client.js'
import type { IIdpService } from './idp-service.js'
import type { IEnvironmentService } from './control-plane-host.js'
import { TenantOidcClients, type TenantOidcClientSecrets } from './tenant-auth/tenant-oidc-clients.js'
import { TenantPrincipalSessions } from './tenant-auth/tenant-principal-sessions.js'
import { TenantSessionGate } from './tenant-auth/tenant-session-gate.js'
import type { TenantSessions } from './tenant-auth/tenant-sessions.js'
import type { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import { DesktopAuthGate } from './tenant-auth/desktop-auth-gate.js'
import { DesktopEndpoint } from './tenant-auth/desktop-endpoint.js'
import { DesktopRelay, WsUpstreamDialer } from './tenant-auth/desktop-relay.js'
import { DesktopSignInFlows } from './tenant-auth/desktop-sign-in-flows.js'
import { DesktopTargets } from './tenant-auth/desktop-targets.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import { TenantApiEndpoint } from './tenant-api/tenant-api-endpoint.js'
import type { TenantGraphAccess } from './tenant-api/tenant-graph-access.js'
import { TenantEventBus } from './tenant-api/tenant-events.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'
import type { ITenantEmailDomains } from './tenant-api/tenant-email-domains.js'
import { TenantConfigurationEndpoint } from './tenant-api/tenant-configuration-endpoint.js'
import type { ConfigurationService } from './configuration/configuration-service.js'

/** What the desktop relay needs beyond the tenant plane: how environments are reached, and where relays are audited. */
export type DesktopRelayWiring = { endpoints: IEnvironmentReach; audit: AuditRegistry }

/** What a tenant plane is built from; the stores behind Sessions, FlowStates and ClientSecrets are the host's database. */
export interface TenantPlaneParts
{
    readonly Idp: IIdpService
    readonly Directory: ITenantDirectory
    readonly Service: IEnvironmentService
    readonly Rollout: IRolloutClient
    readonly Orchestrators: HiveOrchestratorFactory
    readonly Placement: EnvironmentPlacement
    readonly Sessions: TenantSessions
    readonly Resolver: TenantHostResolver
    /** The pending OIDC sign-ins (SqlOidcFlowStateStore in production). */
    readonly FlowStates: IOidcFlowStateStore
    /** Where the console's OIDC client secrets live and how long they are kept. */
    readonly ClientSecrets: TenantOidcClientSecrets
    /** Ends a principal's sessions and sockets; shared with the platform's Owner reset. Default: one over Sessions. */
    readonly Principals?: TenantPrincipalSessions
    /** Behind a trusted proxy (the relay reads the end user's address from the last x-forwarded-for hop). */
    readonly TrustedProxy?: boolean
    /** Mounts the Plexus `/desktop/*` surface. */
    readonly Desktop?: boolean
    /** Mounts the desktop relay with the desktop surface: how environments are reached and where relays are audited. */
    readonly Relay?: DesktopRelayWiring
    /** Mounts `/tenant-api/settings/email-domains`. */
    readonly EmailDomains?: ITenantEmailDomains
    /** The one tenant an in-hive console serves: mounts `GET /desktop/console`. */
    readonly ConsoleTenantId?: string
    /** Mounts the graph routes of the tenant's Development environments. */
    readonly Graphs?: TenantGraphAccess
    /** Mounts the configuration repository's routes (the in-hive console). */
    readonly Configuration?: ConfigurationService
}

/**
 * The tenant plane's composition, shared by both of its hosts: the full control plane (server.ts, which also composes the
 * dev-box Docker and kind drivers) and the in-hive tenant admin (tenant-admin-server.ts, which must not). It holds the
 * plane's pre-A5 data-root file names (the importer's reader), its listener settings parsers and BuildTenantPlane, and
 * imports no host-specific driver.
 */
export class TenantPlaneComposer
{
    public static readonly EnvPortFloor = 8100
    public static readonly RegistryFile = 'registry.json'
    public static readonly MasterKeyFileName = 'master.key'
    /** The tenant plane's own audit of desktop relays (who contributed / published what, and refusals). */
    public static readonly DesktopAuditFile = 'tenant-desktop-audit.json'
    public static readonly TenantGraphAuditFile = 'tenant-graph-audit.json'
    public static readonly TenantAdminClientsFile = 'tenant-admin-clients.json'
    /** The pre-A5 sealed OIDC client secrets folder (file identity stores under the master key). */
    public static readonly TenantAdminOidcDir = 'tenant-admin-oidc'
    public static readonly ParentSegment = '..'
    public static readonly DistSegment = 'dist'
    public static readonly TenantPortalSegment = 'tenant-portal'
    public static readonly MaxPort = 65535
    private static readonly BadTenantExternalPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: '
    private static readonly BadTenantPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_PORT: '
    private static readonly DefaultTenantBind = '127.0.0.1'
    private static readonly DefaultExternalScheme = 'https'
    private static readonly DefaultSecretTtlHours = 168
    private static readonly MsPerHour = 3600000
    private static readonly DefaultHealthProbeMs = 30000
    private static readonly MinHealthProbeMs = 1000
    private static readonly MaxHealthProbeMs = 2147483647
    // Above the default probe interval (30s) so a legitimately slow-but-healthy probe is not treated as wedged.
    private static readonly DefaultHealthProbeTimeoutMs = 60000
    private static readonly PositiveIntegerPattern = /^[0-9]+$/
    private static readonly TrueToken = 'true'
    private static readonly OneToken = '1'

    /** Pure: whether an env flag is set to true ('true' or '1'). */
    public static ReadsTrue(raw: string | undefined): boolean
    {
        return raw === TenantPlaneComposer.TrueToken || raw === TenantPlaneComposer.OneToken
    }

    /** The lifetime of the OIDC client secrets for a TTL in hours. */
    public static SecretTtlMsOf(hours: number): number
    {
        return hours * TenantPlaneComposer.MsPerHour
    }

    /**
     * Gate-free composition of the tenant plane; callers decide whether the plane is active (ControlPlaneServer.ComposeTenantPlane
     * gates on env, the standalone server always builds it). See TenantPlaneParts for what each optional part mounts.
     */
    public static BuildTenantPlane(parts: TenantPlaneParts): TenantPlane
    {
        const sessions = parts.Sessions
        const relyingParty = new OidcRelyingParty(parts.FlowStates)
        const clients = new TenantOidcClients(parts.Idp, parts.Directory, conn => new IdpAdminClient(conn), parts.Resolver, parts.ClientSecrets)
        const gate = new TenantSessionGate(sessions.Store, sessions.Cookie, parts.Resolver, parts.Directory)
        const api = new TenantApiEndpoint(parts.Service, parts.Directory, parts.Rollout, parts.Orchestrators, parts.Placement, parts.EmailDomains, parts.Graphs)
        const events = new TenantEventBus()
        const principals = parts.Principals ?? new TenantPrincipalSessions(sessions.Store)
        const plane: TenantPlane = { sessions, gate, relyingParty, clients, api, events, principals }
        if (parts.Configuration !== undefined)
        {
            plane.configuration = new TenantConfigurationEndpoint(parts.Configuration)
        }
        if (parts.Desktop === true)
        {
            // Given the tenant records, a bearer of a deleted (or deleted and re-created) tenant is refused.
            const desktopGate = new DesktopAuthGate(sessions.Store, parts.Directory)
            const targets = new DesktopTargets(parts.Service)
            if (parts.Relay !== undefined)
            {
                plane.relay = new DesktopRelay(desktopGate, targets, parts.Service, parts.Relay.endpoints, parts.Relay.audit, new WsUpstreamDialer(), new AuditThrottle(), parts.TrustedProxy ?? false)
            }
            // A desktop sign-out also closes the relays opened under that session.
            plane.desktop = new DesktopEndpoint({ RelyingParty: relyingParty, Clients: clients }, sessions, desktopGate, new DesktopSignInFlows(), targets, parts.Directory,
                session => api.Profile(session), plane.relay, parts.ConsoleTenantId)
        }
        return plane
    }

    /** The externally-visible tenant origin scheme; defaults to https when unset or blank. */
    public static TenantScheme(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? TenantPlaneComposer.DefaultExternalScheme : raw
    }

    /** The tenant listener bind address; defaults to loopback (proxy-fronted) when unset or blank. */
    public static TenantBind(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? TenantPlaneComposer.DefaultTenantBind : raw
    }

    /** Pure: the tenant origin's optional external port; undefined when unset or blank, throws naming the variable when invalid. */
    public static TenantExternalPort(raw: string | undefined): number | undefined
    {
        if (raw === undefined || raw === '')
        {
            return undefined
        }
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > TenantPlaneComposer.MaxPort)
        {
            throw new Error(TenantPlaneComposer.BadTenantExternalPortPrefix + raw)
        }
        return port
    }

    public static ResolveTenantPort(raw: string | undefined): number
    {
        const port = Number(raw)
        if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 1 || port > TenantPlaneComposer.MaxPort)
        {
            throw new Error(TenantPlaneComposer.BadTenantPortPrefix + String(raw))
        }
        return port
    }

    /** Pure: parses the tenant-admin secret TTL in hours; anything but a positive integer yields the default. */
    public static ParseSecretTtlHours(raw: string | undefined): number
    {
        if (raw === undefined || !TenantPlaneComposer.PositiveIntegerPattern.test(raw))
        {
            return TenantPlaneComposer.DefaultSecretTtlHours
        }
        const hours = Number.parseInt(raw, 10)
        return hours > 0 ? hours : TenantPlaneComposer.DefaultSecretTtlHours
    }

    /** Pure: parses the tenant health probe interval in ms; 0 disables, a positive integer within [Min, Max] is honoured, anything else (including out-of-range) yields the default. */
    public static ParseHealthProbeMs(raw: string | undefined): number
    {
        return TenantPlaneComposer.ParseProbeMs(raw, TenantPlaneComposer.DefaultHealthProbeMs)
    }

    /** Pure: parses the per-probe timeout in ms; 0 disables the deadline, a positive integer within [Min, Max] is honoured, anything else yields the default. */
    public static ParseHealthProbeTimeoutMs(raw: string | undefined): number
    {
        return TenantPlaneComposer.ParseProbeMs(raw, TenantPlaneComposer.DefaultHealthProbeTimeoutMs)
    }

    private static ParseProbeMs(raw: string | undefined, fallback: number): number
    {
        if (raw === undefined || !TenantPlaneComposer.PositiveIntegerPattern.test(raw))
        {
            return fallback
        }
        const ms = Number.parseInt(raw, 10)
        if (ms === 0)
        {
            return 0
        }
        if (ms < TenantPlaneComposer.MinHealthProbeMs || ms > TenantPlaneComposer.MaxHealthProbeMs)
        {
            return fallback
        }
        return ms
    }
}
