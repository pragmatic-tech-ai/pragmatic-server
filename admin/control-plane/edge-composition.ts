import { isIP } from 'node:net'
import { EdgeHost } from './edge-host.js'
import { InternalApiClient, InternalApiLink } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { RemoteAgentChannelBackend } from './remote-agent-channel-backend.js'
import { RemoteDesktopDiscoveryBackend } from './remote-desktop-discovery-backend.js'

/** The composed keyless edge: its listener and where to bind it. */
export interface ComposedEdge
{
    Host: EdgeHost
    Port: number
    Bind: string
    TrustedProxy: boolean
}

/**
 * Composes the keyless platform edge (bin/pragmatic-platform-edged). Reads only its own five settings, never a data root, key, registry or
 * the master key: everything it answers comes from admin's internal API.
 */
export class EdgeComposition
{
    private static readonly PortEnvVar = 'PRAGMATIC_AGENT_CHANNEL_PORT'
    private static readonly BindEnvVar = 'PRAGMATIC_AGENT_CHANNEL_BIND'
    private static readonly AdminUrlEnvVar = 'PRAGMATIC_EDGE_ADMIN_URL'
    private static readonly TrustedProxyEnvVar = 'PRAGMATIC_EDGE_TRUSTED_PROXY'
    private static readonly DefaultBind = '0.0.0.0'
    private static readonly MaxPort = 65535
    private static readonly TrueValues: ReadonlySet<string> = new Set(['true', '1'])
    private static readonly HttpSchemes: ReadonlySet<string> = new Set(['http:', 'https:'])
    private static readonly BadPort = 'PRAGMATIC_AGENT_CHANNEL_PORT must be a port 1-65535 for the edge'
    private static readonly BadBind = 'PRAGMATIC_AGENT_CHANNEL_BIND must be an IP address'
    private static readonly BadAdminUrl = 'PRAGMATIC_EDGE_ADMIN_URL must be the http(s) URL of admin\'s internal API'
    private static readonly MissingSecret = 'PRAGMATIC_INTERNAL_API_SECRET_FILE is required for the edge'

    public static Compose(env: NodeJS.ProcessEnv): ComposedEdge
    {
        const E = EdgeComposition
        const port = Number(env[E.PortEnvVar]?.trim() ?? '')
        if (!Number.isInteger(port) || port < 1 || port > E.MaxPort)
        {
            throw new Error(E.BadPort)
        }
        const bind = env[E.BindEnvVar]?.trim() || E.DefaultBind
        if (isIP(bind) === 0)
        {
            throw new Error(E.BadBind)
        }
        const adminUrl = E.AdminUrlOf(env[E.AdminUrlEnvVar])
        const secretFile = env[InternalApiLink.SecretFileEnvVar]?.trim() ?? ''
        if (secretFile === '')
        {
            throw new Error(E.MissingSecret)
        }
        const client = new InternalApiClient(adminUrl, InternalApiLink.Credential(secretFile))
        const trustedProxy = E.TrueValues.has(env[E.TrustedProxyEnvVar]?.trim().toLowerCase() ?? '')
        const host = new EdgeHost(new RemoteAgentChannelBackend(client), new RemoteDesktopDiscoveryBackend(client), trustedProxy)
        return { Host: host, Port: port, Bind: bind, TrustedProxy: trustedProxy }
    }

    private static AdminUrlOf(raw: string | undefined): string
    {
        const value = raw?.trim() ?? ''
        let url: URL
        try
        {
            url = new URL(value)
        }
        catch
        {
            throw new Error(EdgeComposition.BadAdminUrl)
        }
        if (!EdgeComposition.HttpSchemes.has(url.protocol))
        {
            throw new Error(EdgeComposition.BadAdminUrl)
        }
        return value
    }
}

/** What EdgeShutdown closes: the edge's listener. */
export interface IClosable
{
    Close(): Promise<void>
}

/**
 * The edge's SIGTERM/SIGINT handling. It runs as PID 1 in its container, where a signal without a handler is ignored,
 * so `podman stop` would otherwise wait out its timeout and SIGKILL in-flight requests. Closes the listener, then exits
 * 128+signal; exits even when closing fails.
 */
export class EdgeShutdown
{
    private static readonly Signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    private static readonly SignalExitBase = 128
    private static readonly SignalNumbers: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15 }

    public static Install(host: IClosable, proc: NodeJS.Process = process): void
    {
        for (const signal of EdgeShutdown.Signals)
        {
            proc.once(signal, () =>
            {
                const code = EdgeShutdown.SignalExitBase + (EdgeShutdown.SignalNumbers[signal] ?? 0)
                host.Close().then(() => proc.exit(code), () => proc.exit(code))
            })
        }
    }
}
