export interface IRolloutTarget
{
    version: string
    image: string
}

export interface IEnvironmentState
{
    environmentName: string
    namespace: string
    deployment: string
    container: string
    runningImage: string | undefined
    ready: boolean
}

export interface ISnapshotEnvironment
{
    environmentName: string
    ready: boolean
    runningImage: string | undefined
    detail: string
}

export interface IRolloutAgentDeps
{
    fetchTarget(): Promise<IRolloutTarget | undefined>
    listEnvironments(): Promise<ReadonlyArray<IEnvironmentState>>
    patchImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    reportSnapshot(environments: ReadonlyArray<ISnapshotEnvironment>): Promise<void>
}

export class RolloutAgent
{
    private static readonly DetailReady = 'ready'
    private static readonly DetailNotReady = 'not ready'

    public constructor(private readonly deps: IRolloutAgentDeps)
    {
    }

    public async Tick(): Promise<void>
    {
        const target = await this.deps.fetchTarget()
        if (target === undefined)
        {
            return
        }
        const envs = await this.deps.listEnvironments()
        for (const env of envs)
        {
            if (env.runningImage !== target.image)
            {
                await this.deps.patchImage(env.namespace, env.deployment, env.container, target.image)
            }
        }
        const snapshot = envs.map(env => this.ToSnapshot(env))
        await this.deps.reportSnapshot(snapshot)
    }

    private ToSnapshot(env: IEnvironmentState): ISnapshotEnvironment
    {
        return {
            environmentName: env.environmentName,
            ready: env.ready,
            runningImage: env.runningImage,
            detail: env.ready ? RolloutAgent.DetailReady : RolloutAgent.DetailNotReady,
        }
    }
}
