/**
 * Whether this admin drives infrastructure on its own host (`local`: the laptop's Docker and kind), has no Docker/cluster
 * target at all (`none`), or pushes to registered clusters on our machines over the mesh (`hosted`: SaaS hives, D30).
 */
export enum InfraTargetMode
{
    Local = 'local',
    None = 'none',
    Hosted = 'hosted'
}

/** Reads PRAGMATIC_ADMIN_INFRA_TARGET. Unset or blank is `local`, so a development setup is unchanged. */
export class InfraTargetModes
{
    public static readonly EnvVar = 'PRAGMATIC_ADMIN_INFRA_TARGET'
    private static readonly BadValueSuffix = ' must be one of: '
    private static readonly ListSeparator = ', '

    public static Parse(env: NodeJS.ProcessEnv): InfraTargetMode
    {
        const raw = env[InfraTargetModes.EnvVar]?.trim().toLowerCase() ?? ''
        if (raw === '')
        {
            return InfraTargetMode.Local
        }
        const mode = Object.values(InfraTargetMode).find(m => m === raw)
        if (mode === undefined)
        {
            throw new Error(InfraTargetModes.EnvVar + InfraTargetModes.BadValueSuffix + Object.values(InfraTargetMode).join(InfraTargetModes.ListSeparator))
        }
        return mode
    }
}
