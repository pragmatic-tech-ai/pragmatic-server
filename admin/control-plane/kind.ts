import { KubectlError } from './kubectl.js'
import type { IExecFile } from './kubectl.js'

export interface IKind
{
    CreateCluster(name: string): Promise<void>
    DeleteCluster(name: string): Promise<void>
    ListClusters(): Promise<readonly string[]>
    LoadImage(image: string, clusterName: string): Promise<void>
}

/** A failed kind invocation. Stderr is redacted of secret-looking tokens before it is surfaced. */
export class KindError extends Error
{
    private static readonly Prefix = 'kind failed: '
    private static readonly ErrorName = 'KindError'

    public constructor(rawStderr: string)
    {
        super(KindError.Prefix + KubectlError.Redact(rawStderr).trim())
        this.name = KindError.ErrorName
    }
}

export class KindCli implements IKind
{
    private static readonly Kind = 'kind'
    private static readonly Create = 'create'
    private static readonly Delete = 'delete'
    private static readonly Cluster = 'cluster'
    private static readonly NameFlag = '--name'
    private static readonly Get = 'get'
    private static readonly Clusters = 'clusters'
    private static readonly Load = 'load'
    private static readonly DockerImage = 'docker-image'
    private static readonly NoClustersSentinel = 'No kind clusters found.'
    private static readonly Newline = '\n'

    public constructor(private readonly exec: IExecFile)
    {
    }

    public async CreateCluster(name: string): Promise<void>
    {
        await this.Invoke([KindCli.Create, KindCli.Cluster, KindCli.NameFlag, name])
    }

    public async DeleteCluster(name: string): Promise<void>
    {
        await this.Invoke([KindCli.Delete, KindCli.Cluster, KindCli.NameFlag, name])
    }

    public async ListClusters(): Promise<readonly string[]>
    {
        const stdout = await this.Invoke([KindCli.Get, KindCli.Clusters])
        return stdout
            .split(KindCli.Newline)
            .map(line => line.trim())
            .filter(line => line.length > 0 && line !== KindCli.NoClustersSentinel)
    }

    public async LoadImage(image: string, clusterName: string): Promise<void>
    {
        await this.Invoke([KindCli.Load, KindCli.DockerImage, image, KindCli.NameFlag, clusterName])
    }

    private async Invoke(args: readonly string[]): Promise<string>
    {
        try
        {
            const result = await this.exec.Run(KindCli.Kind, args)
            return result.stdout
        }
        catch (e: unknown)
        {
            throw new KindError(KindCli.Describe(e))
        }
    }

    private static Describe(e: unknown): string
    {
        const err = e as { stderr?: unknown; message?: unknown } | null | undefined
        if (typeof err?.stderr === 'string' && err.stderr.length > 0)
        {
            return err.stderr
        }
        return typeof err?.message === 'string' ? err.message : String(e)
    }
}
