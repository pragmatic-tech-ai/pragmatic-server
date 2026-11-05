import { execFile, spawn, type ChildProcess } from 'node:child_process'

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
    ScaleStatefulSet(namespace: string, statefulSet: string, replicas: number): Promise<void>
    RolloutRestart(namespace: string, deployment: string): Promise<void>
    /** Restarts every deployment in the namespace that matches the label selector. */
    RolloutRestartSelector(namespace: string, selector: string): Promise<void>
    /**
     * Applies a manifest server-side (stdin, forced, under the control plane's field manager): unlike a client-side
     * apply it writes no last-applied-configuration annotation, so a Secret's value is not copied into one.
     */
    ApplyServerSide(manifestJson: string): Promise<void>
    Get(namespace: string, resource: string): Promise<string>
    DeleteNamespace(namespace: string): Promise<void>
    /** One resource ('kind/name') as JSON, or undefined when it does not exist. */
    Find(namespace: string, resource: string): Promise<string | undefined>
    /** Deletes the objects a manifest names (stdin); objects already gone are not an error. */
    DeleteManifest(manifestJson: string): Promise<void>
    /** Deletes every `resource` in the namespace matching the label selector; none matching is not an error. */
    DeleteBySelector(namespace: string, resource: string, selector: string): Promise<void>
    /**
     * Deletes every Namespace that matches the label selector AND whose name starts with `namePrefix` (a matching namespace
     * outside the prefix is left alone); returns the names whose delete failed. A failed listing throws. Refuses an empty prefix.
     */
    DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
}

/** The client-side name fence of DeleteNamespacesBySelector, shared by every IKubectl. */
export class NamespaceSweep
{
    private static readonly EmptyPrefixMessage = 'a namespace sweep needs a non-empty name prefix'

    /** The names that start with `prefix` and are longer than it; throws for an empty prefix. */
    public static Select(names: readonly string[], prefix: string): string[]
    {
        if (prefix.length === 0)
        {
            throw new KubectlError(NamespaceSweep.EmptyPrefixMessage, '', false)
        }
        return names.filter(n => n.startsWith(prefix) && n.length > prefix.length)
    }

    /** Deletes each name through `remove`; a KubectlError marks that name failed, anything else propagates. */
    public static async DeleteEach(names: readonly string[], remove: (name: string) => Promise<void>): Promise<string[]>
    {
        const failed: string[] = []
        for (const name of names)
        {
            try
            {
                await remove(name)
            }
            catch (err)
            {
                if (!(err instanceof KubectlError))
                {
                    throw err
                }
                failed.push(name)
            }
        }
        return failed
    }
}

/** A long-lived child process (a kubectl port-forward): its stdout, a way to stop it, and an exit notification. */
export interface ISpawnedProcess
{
    readonly Stdout: NodeJS.ReadableStream
    Kill(): void
    OnExit(cb: () => void): void
}

/** Starts long-lived processes; the seam that lets tests stand in for kubectl port-forward. */
export interface IProcessSpawner
{
    Spawn(file: string, args: readonly string[]): ISpawnedProcess
}

/** A local tunnel to a cluster port: the loopback port it listens on and the process that holds it open. */
export type PortForwardResult = { LocalPort: number; Process: ISpawnedProcess }

/** A kubectl that can also open a port-forward through its context (KubectlCli; test fakes may implement it too). */
export interface IPortForwardingKubectl extends IKubectl
{
    PortForward(namespace: string, target: string, remotePort: number, spawner: IProcessSpawner): Promise<PortForwardResult>
}

/** A port-forward that never became ready or exited early. Carries a fixed message: process output is never surfaced. */
export class PortForwardError extends Error
{
    public static readonly NotReadyMessage = 'kubectl port-forward did not become ready in time'
    public static readonly ExitedMessage = 'kubectl port-forward exited before forwarding'
    private static readonly ErrorName = 'PortForwardError'

    public constructor(message: string = PortForwardError.ExitedMessage)
    {
        super(message)
        this.name = PortForwardError.ErrorName
    }
}

/** Real IProcessSpawner: node spawn with an argument array (never a shell); stdout piped, stdin and stderr discarded. */
export class NodeProcessSpawner implements IProcessSpawner
{
    private static readonly PortForwardStdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore']

    public Spawn(file: string, args: readonly string[]): ISpawnedProcess
    {
        return new NodeSpawnedProcess(spawn(file, [...args], { stdio: NodeProcessSpawner.PortForwardStdio, windowsHide: true }))
    }
}

/** Wraps a ChildProcess; a spawn failure ('error') counts as an exit, and OnExit after the exit fires at once. */
export class NodeSpawnedProcess implements ISpawnedProcess
{
    private static readonly ExitEvent = 'exit'
    private static readonly ErrorEvent = 'error'

    private exited = false
    private readonly exitCallbacks: (() => void)[] = []

    public constructor(private readonly child: ChildProcess)
    {
        child.once(NodeSpawnedProcess.ExitEvent, () => this.MarkExited())
        // on, not once: a second 'error' (e.g. a failed kill) must not go unhandled and crash the process.
        child.on(NodeSpawnedProcess.ErrorEvent, () => this.MarkExited())
    }

    public get Stdout(): NodeJS.ReadableStream
    {
        return this.child.stdout as NodeJS.ReadableStream
    }

    public Kill(): void
    {
        if (!this.exited)
        {
            this.child.kill()
        }
    }

    public OnExit(cb: () => void): void
    {
        if (this.exited)
        {
            cb()
            return
        }
        this.exitCallbacks.push(cb)
    }

    private MarkExited(): void
    {
        if (this.exited)
        {
            return
        }
        this.exited = true
        for (const cb of this.exitCallbacks.splice(0))
        {
            cb()
        }
    }
}

/** A failed kubectl invocation. Stderr is redacted of secret-looking tokens before it is surfaced. */
export class KubectlError extends Error
{
    private static readonly Redacted = '[REDACTED]'
    /**
     * Matches, in order: a labelled value (optionally JSON-quoted key; quoted value may hold spaces),
     * a Bearer/Basic credential of any length, and a long opaque run (>= 32 base64-ish chars).
     */
    private static readonly SecretPattern = /["']?(?:password|passwd|token|secret|api[-_]?key|authorization)["']?\s*[=:]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|\S+)|\b(?:Bearer|Basic)\s+\S+|[A-Za-z0-9+/_=-]{32,}/gi
    /** A long run that is really a lowercase resource name or a filesystem path, not a credential. */
    private static readonly BenignRun = /^(?:[a-z0-9]+(?:-[a-z0-9]+)+|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/
    private static readonly Prefix = 'kubectl failed: '
    private static readonly ErrorName = 'KubectlError'

    /** Subclasses that build an already-redacted, self-describing message pass `prefix` '' and `redact` false. */
    public constructor(rawStderr: string, prefix: string = KubectlError.Prefix, redact: boolean = true)
    {
        super(prefix + (redact ? KubectlError.Redact(rawStderr).trim() : rawStderr))
        this.name = KubectlError.ErrorName
    }

    public static Redact(text: string): string
    {
        return text.replace(KubectlError.SecretPattern, match =>
            KubectlError.BenignRun.test(match) ? match : KubectlError.Redacted)
    }
}

/** Real IExecFile: node execFile, argument array (never a shell), 16 MB buffer, optional stdin. */
export class NodeExecFile implements IExecFile
{
    private static readonly MaxBuffer = 16 * 1024 * 1024
    /** Upper bound on one kubectl invocation, so a wedged `rollout status` cannot hang forever. */
    public static readonly DefaultTimeoutMs = 300000
    private static readonly ErrorEvent = 'error'

    public constructor(private readonly timeoutMs: number = NodeExecFile.DefaultTimeoutMs)
    {
    }

    public Run(file: string, args: readonly string[], stdin?: string): Promise<{ stdout: string; stderr: string }>
    {
        return new Promise((resolve, reject) =>
        {
            const child = execFile(file, [...args], { maxBuffer: NodeExecFile.MaxBuffer, timeout: this.timeoutMs }, (err, stdout, stderr) =>
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

export class KubectlCli implements IPortForwardingKubectl
{
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly ApplyVerb = 'apply'
    private static readonly FileFlag = '-f'
    private static readonly Stdin = '-'
    private static readonly ServerSideFlag = '--server-side'
    private static readonly FieldManagerFlag = '--field-manager=pragmatic-control-plane'
    private static readonly ForceConflictsFlag = '--force-conflicts'
    private static readonly DeploymentResource = 'deployment'
    private static readonly SelectorFlag = '-l'
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
    private static readonly NamespacesResource = 'namespaces'
    private static readonly BadNamespaceListMessage = 'kubectl returned a namespace list that is not valid JSON'
    private static readonly IgnoreNotFound = '--ignore-not-found'
    private static readonly NamespaceFlag = '-n'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly StatefulSetPrefix = 'statefulset/'
    private static readonly Assign = '='
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly AnyLocalPort = '0:'
    private static readonly AddressFlag = '--address'
    private static readonly Loopback = '127.0.0.1'
    private static readonly DataEvent = 'data'
    private static readonly Utf8 = 'utf8'
    /** How long a port-forward may take to print its forwarding line. */
    public static readonly PortForwardReadyMs = 15000
    /** `Forwarding from 127.0.0.1:<local> -> <remote>`, matched only once its line is complete. */
    private static readonly ForwardingPattern = /Forwarding from 127\.0\.0\.1:(\d+) -> (\d+)\r?\n/g

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

    public async ApplyServerSide(manifestJson: string): Promise<void>
    {
        const K = KubectlCli
        await this.Invoke([K.ApplyVerb, K.ServerSideFlag, K.FieldManagerFlag, K.ForceConflictsFlag, K.FileFlag, K.Stdin], manifestJson)
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

    public async ScaleStatefulSet(namespace: string, statefulSet: string, replicas: number): Promise<void>
    {
        await this.Invoke([KubectlCli.ScaleVerb, KubectlCli.StatefulSetPrefix + statefulSet, KubectlCli.ReplicasFlag + String(replicas), KubectlCli.NamespaceFlag, namespace])
    }

    public async RolloutRestart(namespace: string, deployment: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Rollout, KubectlCli.Restart, KubectlCli.DeploymentPrefix + deployment, KubectlCli.NamespaceFlag, namespace])
    }

    public async RolloutRestartSelector(namespace: string, selector: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Rollout, KubectlCli.Restart, KubectlCli.DeploymentResource, KubectlCli.SelectorFlag, selector, KubectlCli.NamespaceFlag, namespace])
    }

    public Get(namespace: string, resource: string): Promise<string>
    {
        return this.Invoke([KubectlCli.GetVerb, resource, KubectlCli.NamespaceFlag, namespace, KubectlCli.OutputFlag, KubectlCli.Json])
    }

    public async DeleteNamespace(namespace: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Delete, KubectlCli.Namespace, namespace, KubectlCli.IgnoreNotFound])
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        const stdout = await this.Invoke([KubectlCli.GetVerb, resource, KubectlCli.NamespaceFlag, namespace, KubectlCli.OutputFlag, KubectlCli.Json, KubectlCli.IgnoreNotFound])
        return stdout.trim().length === 0 ? undefined : stdout
    }

    public async DeleteManifest(manifestJson: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Delete, KubectlCli.IgnoreNotFound, KubectlCli.FileFlag, KubectlCli.Stdin], manifestJson)
    }

    public async DeleteBySelector(namespace: string, resource: string, selector: string): Promise<void>
    {
        await this.Invoke([KubectlCli.Delete, resource, KubectlCli.SelectorFlag, selector, KubectlCli.NamespaceFlag, namespace, KubectlCli.IgnoreNotFound])
    }

    public async DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        const stdout = await this.Invoke([KubectlCli.GetVerb, KubectlCli.NamespacesResource, KubectlCli.SelectorFlag, selector, KubectlCli.OutputFlag, KubectlCli.Json])
        let names: string[]
        try
        {
            const list = JSON.parse(stdout) as { items?: Array<{ metadata?: { name?: unknown } }> }
            names = (list.items ?? []).map(i => i.metadata?.name).filter((n): n is string => typeof n === 'string')
        }
        catch
        {
            throw new KubectlError(KubectlCli.BadNamespaceListMessage, '', false)
        }
        return NamespaceSweep.DeleteEach(NamespaceSweep.Select(names, namePrefix), name => this.DeleteNamespace(name))
    }

    /** Whether a kubectl can open port-forwards (it carries a context the platform can tunnel through). */
    public static CanPortForward(kubectl: IKubectl | undefined): kubectl is IPortForwardingKubectl
    {
        return kubectl !== undefined && kubectl !== null && typeof (kubectl as Partial<IPortForwardingKubectl>).PortForward === 'function'
    }

    /**
     * Opens `kubectl --context <ctx> -n <ns> port-forward <target> 0:<remotePort> --address 127.0.0.1` and resolves
     * with the loopback port kubectl picked, once it prints its forwarding line for remotePort. Rejects (and kills the
     * process) after PortForwardReadyMs, or as soon as the process exits first; kubectl's output is never surfaced.
     */
    public PortForward(namespace: string, target: string, remotePort: number, spawner: IProcessSpawner): Promise<PortForwardResult>
    {
        const K = KubectlCli
        const args = [K.ContextFlag, this.context, K.NamespaceFlag, namespace, K.PortForwardVerb, target, K.AnyLocalPort + String(remotePort), K.AddressFlag, K.Loopback]
        const child = spawner.Spawn(K.Kubectl, args)
        return new Promise<PortForwardResult>((resolve, reject) =>
        {
            let buffered = ''
            let settled = false
            const settle = (fail: PortForwardError | undefined, localPort?: number): void =>
            {
                if (settled)
                {
                    return
                }
                settled = true
                clearTimeout(timer)
                child.Stdout.removeListener(K.DataEvent, onData)
                // Keep draining: kubectl logs a line per relayed connection and must never block on a full pipe.
                child.Stdout.resume()
                if (fail !== undefined)
                {
                    child.Kill()
                    reject(fail)
                    return
                }
                resolve({ LocalPort: localPort as number, Process: child })
            }
            const onData = (chunk: Buffer | string): void =>
            {
                buffered += typeof chunk === 'string' ? chunk : chunk.toString(K.Utf8)
                const local = KubectlCli.ForwardedPort(buffered, remotePort)
                if (local !== undefined)
                {
                    settle(undefined, local)
                }
            }
            const timer = setTimeout(() => settle(new PortForwardError(PortForwardError.NotReadyMessage)), K.PortForwardReadyMs)
            child.Stdout.on(K.DataEvent, onData)
            child.OnExit(() => settle(new PortForwardError(PortForwardError.ExitedMessage)))
        })
    }

    /** The local port of the first complete forwarding line for remotePort in the text, if any. */
    private static ForwardedPort(text: string, remotePort: number): number | undefined
    {
        for (const match of text.matchAll(KubectlCli.ForwardingPattern))
        {
            if (Number(match[2]) === remotePort)
            {
                return Number(match[1])
            }
        }
        return undefined
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
