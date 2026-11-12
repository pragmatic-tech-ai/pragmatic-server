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

/** The role variable holds a value that is not a known role (the value itself is never echoed). */
export class ControlPlaneRoleInvalidError extends Error
{
    private static readonly ErrorName = 'ControlPlaneRoleInvalidError'
    private static readonly MessageText = 'PRAGMATIC_CONTROL_PLANE_ROLE must be one of: all, edge, admin'

    public constructor()
    {
        super(ControlPlaneRoleInvalidError.MessageText)
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
    private static readonly Known: readonly ControlPlaneRole[] = [ControlPlaneRole.All, ControlPlaneRole.Edge, ControlPlaneRole.Admin]

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
            throw new ControlPlaneRoleInvalidError()
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

    /** Refuses an edge process with no agent-channel port: it would serve nothing. */
    public static RequireListener(role: ControlPlaneRole, agentChannelEnabled: boolean): void
    {
        if (role === ControlPlaneRole.Edge && !agentChannelEnabled)
        {
            throw new EdgeRoleWithoutChannelError()
        }
    }
}
