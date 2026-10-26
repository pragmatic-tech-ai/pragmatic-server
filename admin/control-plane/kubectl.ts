import { execFile } from 'node:child_process'

export interface IExecFile
{
    Run(file: string, args: readonly string[], stdin?: string): Promise<{ stdout: string; stderr: string }>
}

export interface IKubectl
{
    Apply(manifestJson: string): Promise<void>
    RolloutStatus(namespace: string, deployment: string): Promise<void>
    SetImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    Scale(namespace: string, deployment: string, replicas: number): Promise<void>
    RolloutRestart(namespace: string, deployment: string): Promise<void>
    Get(namespace: string, resource: string): Promise<string>
    DeleteNamespace(namespace: string): Promise<void>
}

/** A failed kubectl invocation. Stderr is redacted of secret-looking tokens before it is surfaced. */
export class KubectlError extends Error
{
    private static readonly Redacted = '[REDACTED]'
    private static readonly SecretPattern = /(password|passwd|token|secret)\s*[=:]\s*\S+|[A-Za-z0-9+/_=-]{32,}/gi
    private static readonly Prefix = 'kubectl failed: '
    private static readonly ErrorName = 'KubectlError'

    public constructor(rawStderr: string)
    {
        super(KubectlError.Prefix + KubectlError.Redact(rawStderr).trim())
        this.name = KubectlError.ErrorName
    }

    public static Redact(text: string): string
    {
        return text.replace(KubectlError.SecretPattern, KubectlError.Redacted)
    }
}

/** Real IExecFile: node execFile, argument array (never a shell), 16 MB buffer, optional stdin. */
export class NodeExecFile implements IExecFile
{
    private static readonly MaxBuffer = 16 * 1024 * 1024
    /** Upper bound on one kubectl invocation, so a wedged `rollout status` cannot hang forever. */
    private static readonly TimeoutMs = 300000
    private static readonly ErrorEvent = 'error'

    public Run(file: string, args: readonly string[], stdin?: string): Promise<{ stdout: string; stderr: string }>
    {
        return new Promise((resolve, reject) =>
        {
            const child = execFile(file, [...args], { maxBuffer: NodeExecFile.MaxBuffer, timeout: NodeExecFile.TimeoutMs }, (err, stdout, stderr) =>
            {
                if (err)
                {
                    reject(Object.assign(new Error(err.message), { stderr }))
                    return
                }
                resolve({ stdout, stderr })
            })
            if (stdin !== undefined)
            {
                // EPIPE if kubectl exits before draining stdin: the exit code is the source of truth.
                child.stdin?.on(NodeExecFile.ErrorEvent, () => undefined)
                child.stdin?.end(stdin)
            }
        })
    }
}

export class KubectlCli implements IKubectl
{
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly ApplyVerb = 'apply'
    private static readonly FileFlag = '-f'
    private static readonly Stdin = '-'
    private static readonly Rollout = 'rollout'
    private static readonly Status = 'status'
    private static readonly Restart = 'restart'
    private static readonly Set = 'set'
    private static readonly Image = 'image'
    private static readonly ScaleVerb = 'scale'
    private static readonly ReplicasFlag = '--replicas='
    private static readonly GetVerb = 'get'
    private static readonly OutputFlag = '-o'
    private static readonly Json = 'json'
    private static readonly Delete = 'delete'
    private static readonly Namespace = 'namespace'
    private static readonly IgnoreNotFound = '--ignore-not-found'
    private static readonly NamespaceFlag = '-n'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly Assign = '='

    public constructor(private readonly context: string, private readonly exec: IExecFile = new NodeExecFile())
    {
    }

    public get Context(): string
    {
        return this.context
    }

    public async Apply(manifestJson: string): Promise<void>
    {
        await this.Invoke([KubectlCli.ApplyVerb, KubectlCli.FileFlag, KubectlCli.Stdin], manifestJson)
    }

    public async RolloutStatus(namespace: string, deployment: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Rollout, KubectlCli.Status, KubectlCli.DeploymentPrefix + deployment, KubectlCli.NamespaceFlag, namespace])
    }

    public async SetImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Set, KubectlCli.Image, KubectlCli.DeploymentPrefix + deployment, container + KubectlCli.Assign + image, KubectlCli.NamespaceFlag, namespace])
    }

    public async Scale(namespace: string, deployment: string, replicas: number): Promise<void>
    {
        await this.Invoke([KubectlCli.ScaleVerb, KubectlCli.DeploymentPrefix + deployment, KubectlCli.ReplicasFlag + String(replicas), KubectlCli.NamespaceFlag, namespace])
    }

    public async RolloutRestart(namespace: string, deployment: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Rollout, KubectlCli.Restart, KubectlCli.DeploymentPrefix + deployment, KubectlCli.NamespaceFlag, namespace])
    }

    public Get(namespace: string, resource: string): Promise<string>
    {
        return this.Invoke([KubectlCli.GetVerb, resource, KubectlCli.NamespaceFlag, namespace, KubectlCli.OutputFlag, KubectlCli.Json])
    }

    public async DeleteNamespace(namespace: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Delete, KubectlCli.Namespace, namespace, KubectlCli.IgnoreNotFound])
    }

    private async Invoke(args: readonly string[], stdin?: string): Promise<string>
    {
        const full = [KubectlCli.ContextFlag, this.context, ...args]
        try
        {
            const result = await this.exec.Run(KubectlCli.Kubectl, full, stdin)
            return result.stdout
        }
        catch (e)
        {
            const err = e as { stderr?: unknown; message?: unknown }
            const raw = typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : String(err.message ?? e)
            throw new KubectlError(raw)
        }
    }
}
