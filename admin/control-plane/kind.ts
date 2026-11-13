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
    private static readonly ImageArchive = 'image-archive'
    private static readonly Docker = 'docker'
    private static readonly SaveVerb = 'save'
    private static readonly PlatformFlag = '--platform'
    private static readonly OutputFlag = '-o'
    private static readonly ImageTmpPrefix = 'kind-img-'
    private static readonly ImageArchiveName = 'image.tar'
    private static readonly Arm64Arch = 'arm64'
    private static readonly LinuxArm64 = 'linux/arm64'
    private static readonly LinuxAmd64 = 'linux/amd64'
    private static readonly NoClustersSentinel = 'No kind clusters found.'
    private static readonly Newline = '\n'
    private static readonly ConfigFlag = '--config'
    private static readonly ConfigFileName = 'kind-config.yaml'
    private static readonly TmpPrefix = 'kind-cfg-'
    private static readonly TcpLine = '    protocol: TCP'
    private static readonly ContainerPortPrefix = '  - containerPort: '
    private static readonly HostPortPrefix = '    hostPort: '
    private static readonly ListenAddressLine = '    listenAddress: "127.0.0.1"'
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

    /**
     * Upper bound on one image load (save + `kind load image-archive`): the agent image is ~2 GB, well past NodeExecFile's default, and a
     * load cut short leaves the node to pull an image it cannot reach.
     */
    public static readonly ImageLoadTimeoutMs = 20 * 60 * 1000

    /** `imageExec` runs image loads only (give it ImageLoadTimeoutMs); every other call uses `exec`. */
    public constructor(private readonly exec: IExecFile, private readonly imageExec: IExecFile = exec)
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
            lines.push(KindCli.ContainerPortPrefix + String(port), KindCli.HostPortPrefix + String(port), KindCli.ListenAddressLine, KindCli.TcpLine)
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

    /**
     * Saves the image's host-platform variant to a temporary archive and loads that. `kind load docker-image` imports with
     * --all-platforms, which fails ("content digest ... not found") when Docker's containerd image store holds only the
     * host platform of a multi-platform image (e.g. `registry:2` pulled on this machine).
     */
    public async LoadImage(image: string, clusterName: string): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), KindCli.ImageTmpPrefix))
        const archive = join(dir, KindCli.ImageArchiveName)
        try
        {
            await this.Invoke(
                [KindCli.SaveVerb, KindCli.PlatformFlag, KindCli.HostPlatform(), KindCli.OutputFlag, archive, image],
                this.imageExec,
                KindCli.Docker)
            await this.Invoke([KindCli.Load, KindCli.ImageArchive, archive, KindCli.NameFlag, clusterName], this.imageExec)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    /** The host's Linux platform (`linux/amd64` or `linux/arm64`): the variant a local kind node runs. */
    public static HostPlatform(): string
    {
        return process.arch === KindCli.Arm64Arch ? KindCli.LinuxArm64 : KindCli.LinuxAmd64
    }

    private async Invoke(args: readonly string[], exec: IExecFile = this.exec, program: string = KindCli.Kind): Promise<string>
    {
        try
        {
            const result = await exec.Run(program, args)
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
