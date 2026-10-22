export interface IRolloutTarget
{
    version: string
    image: string
}

export interface IRolloutAgentDeps
{
    fetchTarget(): Promise<IRolloutTarget | undefined>
    readRunningImage(): Promise<string | undefined>
    patchImage(image: string): Promise<void>
    report(runningImage: string, ready: boolean): Promise<void>
}

export class RolloutAgent
{
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
        const running = await this.deps.readRunningImage()
        if (running !== target.image)
        {
            await this.deps.patchImage(target.image)
        }
        await this.deps.report(target.image, true)
    }
}
