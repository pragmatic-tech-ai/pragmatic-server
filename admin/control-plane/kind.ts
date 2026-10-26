import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KubectlError } from './kubectl.js'
import type { IExecFile } from './kubectl.js'

/** Optional kind cluster config: host ports to map to the node (e.g. 443 for an ingress controller). */
export interface KindClusterConfig
{
    extraPortMappings: readonly number[]
}

export interface IKind
{
    CreateCluster(name: string, config?: KindClusterConfig): Promise<void>
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
    private static readonly ConfigFlag = '--config'
    private static readonly ConfigFileName = 'kind-config.yaml'
    private static readonly TmpPrefix = 'kind-cfg-'
    private static readonly TcpLine = '    protocol: TCP'
    private static readonly ConfigHeader: readonly string[] = [
        'kind: Cluster',
        'apiVersion: kind.x-k8s.io/v1alpha4',
        'nodes:',
        '- role: control-plane',
        '  kubeadmConfigPatches:',
        '  - |',
        '    kind: InitConfiguration',
        '    nodeRegistration:',
        '      kubeletExtraArgs:',
        '        node-labels: "ingress-ready=true"',
        '  extraPortMappings:',
    ]

    public constructor(private readonly exec: IExecFile)
    {
    }

    public async CreateCluster(name: string, config?: KindClusterConfig): Promise<void>
    {
        if (config === undefined || config.extraPortMappings.length === 0)
        {
            await this.Invoke([KindCli.Create, KindCli.Cluster, KindCli.NameFlag, name])
            return
        }
        const dir = mkdtempSync(join(tmpdir(), KindCli.TmpPrefix))
        try
        {
            const file = join(dir, KindCli.ConfigFileName)
            writeFileSync(file, KindCli.RenderConfig(config))
            await this.Invoke([KindCli.Create, KindCli.Cluster, KindCli.NameFlag, name, KindCli.ConfigFlag, file])
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    /** The kind Cluster YAML mapping each port container->host on the single control-plane node (ingress-ready). */
    public static RenderConfig(config: KindClusterConfig): string
    {
        const lines = [...KindCli.ConfigHeader]
        for (const port of config.extraPortMappings)
        {
            lines.push(`  - containerPort: ${port}`, `    hostPort: ${port}`, KindCli.TcpLine)
        }
        return lines.join(KindCli.Newline) + KindCli.Newline
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
