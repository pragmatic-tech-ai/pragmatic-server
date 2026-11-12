/**
 * Which listeners one control-plane process starts (`PRAGMATIC_CONTROL_PLANE_ROLE`). `all` is today's single process;
 * `edge` runs only the agent-channel listener (the pragmatic-platform-edge image); `admin` runs everything except it
 * (the pragmatic-platform-admin image). Both images share one closure until the real split.
 */
export enum ControlPlaneRole
{
    All = 'all',
    Edge = 'edge',
    Admin = 'admin',
}

/** The listeners a role starts. */
export interface IControlPlaneListeners
{
    OperatorHost: boolean
    AgentChannel: boolean
    TenantPlane: boolean
}

/** Starts each listener a composed control plane holds; ControlPlaneStart decides which of them a role starts. */
export interface IControlPlaneListenerStarts
{
    StartOperatorHost(): Promise<void>
    StartAgentChannel(): Promise<void>
    StartTenantPlane(): Promise<void>
}

/** The role variable holds a value that is not a known role (the value itself is never echoed). */
export class ControlPlaneRoleInvalidError extends Error
{
    private static readonly ErrorName = 'ControlPlaneRoleInvalidError'
    private static readonly MessagePrefix = 'PRAGMATIC_CONTROL_PLANE_ROLE must be one of: '
    private static readonly Separator = ', '

    public constructor(allowed: readonly string[])
    {
        super(ControlPlaneRoleInvalidError.MessagePrefix + allowed.join(ControlPlaneRoleInvalidError.Separator))
        this.name = ControlPlaneRoleInvalidError.ErrorName
    }
}

/** The edge role was asked for without an agent channel to listen on, so the process would start nothing. */
export class EdgeRoleWithoutChannelError extends Error
{
    private static readonly ErrorName = 'EdgeRoleWithoutChannelError'
    private static readonly MessageText = 'PRAGMATIC_CONTROL_PLANE_ROLE=edge needs PRAGMATIC_AGENT_CHANNEL_PORT set to a port 1-65535'

    public constructor()
    {
        super(EdgeRoleWithoutChannelError.MessageText)
        this.name = EdgeRoleWithoutChannelError.ErrorName
    }
}

export class ControlPlaneRoles
{
    public static readonly EnvVar = 'PRAGMATIC_CONTROL_PLANE_ROLE'
    public static readonly Known: readonly ControlPlaneRole[] = Object.values(ControlPlaneRole)

    /** Pure: the role named by the environment; unset or blank is `all`. */
    public static Of(env: NodeJS.ProcessEnv): ControlPlaneRole
    {
        const raw = env[ControlPlaneRoles.EnvVar]
        if (raw === undefined || raw === '')
        {
            return ControlPlaneRole.All
        }
        const role = ControlPlaneRoles.Known.find(r => r === raw)
        if (role === undefined)
        {
            throw new ControlPlaneRoleInvalidError(ControlPlaneRoles.Known)
        }
        return role
    }

    /** Pure: the listeners the role starts. */
    public static ListenersOf(role: ControlPlaneRole): IControlPlaneListeners
    {
        const edge = role === ControlPlaneRole.Edge
        const admin = role === ControlPlaneRole.Admin
        return { OperatorHost: !edge, AgentChannel: !admin, TenantPlane: !edge }
    }

    /**
     * Pure: whether the role opens the operator-side state (operator accounts, the master key and the sealed secrets,
     * the environment reconcile, the account back-fill, the DNS re-check). The edge serves only the agent channel, so a
     * co-deployed edge never repeats that work.
     */
    public static ServesOperators(role: ControlPlaneRole): boolean
    {
        return role !== ControlPlaneRole.Edge
    }

    /** Refuses an edge process with no agent-channel port: it would serve nothing. */
    public static RequireListener(role: ControlPlaneRole, agentChannelEnabled: boolean): void
    {
        if (role === ControlPlaneRole.Edge && !agentChannelEnabled)
        {
            throw new EdgeRoleWithoutChannelError()
        }
    }
}

/** The start sequence of one control-plane process: operator host, then agent channel, then tenant plane, as its role allows. */
export class ControlPlaneStart
{
    public constructor(private readonly role: ControlPlaneRole)
    {
    }

    public async Run(listeners: IControlPlaneListenerStarts): Promise<void>
    {
        const starts = ControlPlaneRoles.ListenersOf(this.role)
        if (starts.OperatorHost)
        {
            await listeners.StartOperatorHost()
        }
        if (starts.AgentChannel)
        {
            await listeners.StartAgentChannel()
        }
        if (starts.TenantPlane)
        {
            await listeners.StartTenantPlane()
        }
    }
}
