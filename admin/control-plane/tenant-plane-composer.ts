import { join } from 'node:path'
import type { AuditRegistry } from './audit-record.js'
import { AuditThrottle } from './audit-throttle.js'
import type { IEnvironmentReach } from './environment-endpoints.js'
import type { EnvironmentPlacement } from './environment-placement.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { IdpAdminClient } from './idp-admin-client.js'
import type { IIdpService } from './idp-service.js'
import { LoginThrottle } from './login-throttle.js'
import type { IEnvironmentService } from './control-plane-host.js'
import type { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantOidcRelyingParty, type TenantAdminDurability } from './tenant-auth/tenant-oidc-relying-party.js'
import { TenantSessionStore } from './tenant-auth/tenant-session.js'
import { TenantPrincipalSessions } from './tenant-auth/tenant-principal-sessions.js'
import { TenantAuthEndpoint } from './tenant-auth/tenant-auth-endpoint.js'
import { TenantPasswordChange } from './tenant-auth/tenant-password-change.js'
import { IdpPasswordClient } from './tenant-auth/idp-password-client.js'
import { TenantAuthGate } from './tenant-auth/tenant-auth-gate.js'
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

/** What the desktop relay needs beyond the tenant plane: how environments are reached, and where relays are audited. */
export type DesktopRelayWiring = { endpoints: IEnvironmentReach; audit: AuditRegistry }

/**
 * The tenant plane's composition, shared by both of its hosts: the full control plane (server.ts, which also composes the
 * dev-box Docker and kind drivers) and the in-hive tenant admin (tenant-admin-server.ts, which must not). It holds the
 * plane's data-root file names, its listener settings parsers and BuildTenantPlane, and imports no host-specific driver.
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
    public static readonly ParentSegment = '..'
    public static readonly DistSegment = 'dist'
    public static readonly TenantPortalSegment = 'tenant-portal'
    public static readonly MaxPort = 65535
    private static readonly BadTenantExternalPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: '
    private static readonly BadTenantPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_PORT: '
    private static readonly DefaultTenantBind = '127.0.0.1'
    private static readonly DefaultExternalScheme = 'https'
    private static readonly TenantSessionsFile = 'tenant-sessions.json'
    private static readonly TenantSessionTtlMs = 12 * 60 * 60 * 1000
    private static readonly DefaultSecretTtlHours = 168
    private static readonly MsPerHour = 3600000
    private static readonly DefaultHealthProbeMs = 30000
    private static readonly MinHealthProbeMs = 1000
    private static readonly MaxHealthProbeMs = 2147483647
    // Above the default probe interval (30s) so a legitimately slow-but-healthy probe is not treated as wedged.
    private static readonly DefaultHealthProbeTimeoutMs = 60000
    private static readonly TenantAdminOidcDir = 'tenant-admin-oidc'
    private static readonly PositiveIntegerPattern = /^[0-9]+$/
    private static readonly TrueToken = 'true'
    private static readonly OneToken = '1'

    /** Pure: whether an env flag is set to true ('true' or '1'). */
    public static ReadsTrue(raw: string | undefined): boolean
    {
        return raw === TenantPlaneComposer.TrueToken || raw === TenantPlaneComposer.OneToken
    }

    /**
     * Gate-free composition of the tenant plane; callers decide whether the plane is active (ControlPlaneServer.ComposeTenantPlane
     * gates on env, the standalone server always builds it). `withDesktop` mounts the Plexus `/desktop/*` surface; it is off by default.
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
        sessions: TenantSessionStore = TenantPlaneComposer.TenantSessionsOf(dataRoot),
        principals: TenantPrincipalSessions = new TenantPrincipalSessions(sessions),
        trustedProxy: boolean = false,
        withDesktop: boolean = false,
        relay?: DesktopRelayWiring,
        emailDomains?: ITenantEmailDomains,
        consoleTenantId?: string,
        graphs?: TenantGraphAccess): TenantPlane
    {
        const durability: TenantAdminDurability = {
            storeRoot: join(dataRoot, TenantPlaneComposer.TenantAdminOidcDir),
            masterKey,
            registry: adminClientRegistry,
            secretTtlMs: secretTtlHours * TenantPlaneComposer.MsPerHour,
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

    /** The tenant session store under the data root (one instance per process: the plane and the Owner reset share it). */
    public static TenantSessionsOf(dataRoot: string): TenantSessionStore
    {
        return new TenantSessionStore(join(dataRoot, TenantPlaneComposer.TenantSessionsFile), TenantPlaneComposer.TenantSessionTtlMs)
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
