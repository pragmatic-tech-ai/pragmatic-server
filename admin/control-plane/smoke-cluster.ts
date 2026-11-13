/**
 * Which local cluster the gated real-cluster smokes run against. They default to Docker Desktop's built-in Kubernetes
 * (context `docker-desktop`, a kind node named `desktop-control-plane`), which is itself a kind cluster; any other kind
 * cluster works the same way. Set PRAGMATIC_SMOKE_CONTEXT to its kubectl context (e.g. `kind-pragmatic-images`) and the
 * node container follows (`<name>-control-plane`); PRAGMATIC_SMOKE_NODE overrides the node when it does not.
 */
export class SmokeCluster
{
    public static readonly ContextEnv = 'PRAGMATIC_SMOKE_CONTEXT'
    public static readonly NodeEnv = 'PRAGMATIC_SMOKE_NODE'
    public static readonly DefaultContext = 'docker-desktop'
    public static readonly DefaultNode = 'desktop-control-plane'
    private static readonly KindContextPrefix = 'kind-'
    private static readonly ControlPlaneSuffix = '-control-plane'

    /** The kubectl context the smokes drive. */
    public static Context(env: NodeJS.ProcessEnv = process.env): string
    {
        return SmokeCluster.Setting(env, SmokeCluster.ContextEnv) ?? SmokeCluster.DefaultContext
    }

    /** The kind node container images are loaded into (see KindImageLoader). */
    public static Node(env: NodeJS.ProcessEnv = process.env): string
    {
        const explicit = SmokeCluster.Setting(env, SmokeCluster.NodeEnv)
        if (explicit !== undefined)
        {
            return explicit
        }
        const context = SmokeCluster.Setting(env, SmokeCluster.ContextEnv)
        if (context !== undefined && context.startsWith(SmokeCluster.KindContextPrefix))
        {
            return context.slice(SmokeCluster.KindContextPrefix.length) + SmokeCluster.ControlPlaneSuffix
        }
        return SmokeCluster.DefaultNode
    }

    private static Setting(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]
        return value === undefined || value.length === 0 ? undefined : value
    }
}
