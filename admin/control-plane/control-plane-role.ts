/**
 * Which listeners one control-plane process starts (`PRAGMATIC_CONTROL_PLANE_ROLE`). `all` is the single dev process
 * (it also serves the agent channel); `admin` runs everything except the public channel, plus the internal API (the
 * pragmatic-platform-admin image). `edge` is recognised only to be refused: the keyless edge has its own entry
 * (bin/pragmatic-platform-edged, the pragmatic-platform-edge image), so a stale unit asking the console for it fails loudly.
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
    /** Admin's internal API for the edge (started only when PRAGMATIC_ADMIN_INTERNAL_PORT is set). */
    InternalApi: boolean
}

/** Starts each listener a composed control plane holds; ControlPlaneStart decides which of them a role starts. */
export interface IControlPlaneListenerStarts
{
    StartOperatorHost(): Promise<void>
    StartAgentChannel(): Promise<void>
    StartTenantPlane(): Promise<void>
    StartInternalApi(): Promise<void>
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

/** The console was asked to run the edge, which has its own entry now. */
export class EdgeRoleRefusedError extends Error
{
    private static readonly ErrorName = 'EdgeRoleRefusedError'
    private static readonly MessageText = '=edge: the platform edge runs bin/pragmatic-platform-edged, not the console'

    public constructor(envVar: string)
    {
        super(envVar + EdgeRoleRefusedError.MessageText)
        this.name = EdgeRoleRefusedError.ErrorName
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

    /** Pure: the listeners a console role starts (only `all` serves the agent channel; `edge` is refused before). */
    public static ListenersOf(role: ControlPlaneRole): IControlPlaneListeners
    {
        return { OperatorHost: true, AgentChannel: role === ControlPlaneRole.All, TenantPlane: true, InternalApi: true }
    }

    /** Pure: whether the role composes the agent channel at all (its host and the console advert receiver behind it). */
    public static ServesAgentChannel(role: ControlPlaneRole): boolean
    {
        return ControlPlaneRoles.ListenersOf(role).AgentChannel
    }

    /** Refuses role `edge`: the console is not the edge any more (it has its own entry). */
    public static RequireConsole(role: ControlPlaneRole): void
    {
        if (role === ControlPlaneRole.Edge)
        {
            throw new EdgeRoleRefusedError(ControlPlaneRoles.EnvVar)
        }
    }
}

/** The start sequence of one control-plane process: operator host, internal API, agent channel, then tenant plane, as its role allows. */
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
        if (starts.InternalApi)
        {
            await listeners.StartInternalApi()
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
