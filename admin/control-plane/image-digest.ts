import { NodeExecFile, type IExecFile } from './kubectl.js'

export interface IImageDigest
{
    Of(imageRef: string): Promise<string>
}

/** Reads an image's content digest (its docker image id) from the local docker CLI. */
export class DockerImageDigest implements IImageDigest
{
    private static readonly Docker = 'docker'
    private static readonly ImageCommand = 'image'
    private static readonly InspectCommand = 'inspect'
    private static readonly FormatFlag = '--format'
    private static readonly IdTemplate = '{{.Id}}'

    public constructor(private readonly exec: IExecFile = new NodeExecFile())
    {
    }

    public async Of(imageRef: string): Promise<string>
    {
        const result = await this.exec.Run(DockerImageDigest.Docker, [
            DockerImageDigest.ImageCommand,
            DockerImageDigest.InspectCommand,
            imageRef,
            DockerImageDigest.FormatFlag,
            DockerImageDigest.IdTemplate,
        ])
        return result.stdout.trim()
    }
}
