/**
 * OPERATOR-RUN test stack for the Plexus runtime live-loop e2e (NOT a *.test.ts, never run by CI). It stands up what a
 * customer has, apart from the developer's own data:
 *
 *   - a kind cluster `pragmatic-e2e` (host ports 443 and the in-cluster registry's node port mapped, ingress-nginx with SSL
 *     passthrough, the server, registry and Postgres images loaded);
 *   - a control plane on :7000 (operator) and :7100 (tenant plane) whose state lives in ~/.pragmatic/e2e-stack/data, never in
 *     admin/control-plane/data;
 *   - client `e2e-client`, tenant `e2e` (owner `o@t.io`, its IdP container) and hive `e2e-hive` attached to the kind cluster;
 *   - the owner's one-time password replaced by the short test password, through the tenant plane as the owner would.
 *
 * `up` writes ~/.pragmatic/e2e-stack/stack.json (addresses, emails, password FILE paths, the IdP CA file) for the live-loop
 * orchestrator and the Plexus spec; `down` stops the control plane, removes the IdP container and volume, deletes the kind
 * cluster and the stack folder. Passwords are written to files in the stack folder only: never printed or logged.
 *
 *   npx tsx admin/control-plane/live-loop/live-loop-stack.ts up|down
 *
 * Requires docker, kind and kubectl on PATH, a FRESH `pragmatic-server:dev` image, free host ports 443, 30500, 7000 and 7100, and
 * the Playwright Chromium browser.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InClusterRegistry } from '../in-cluster-registry.js'
import { KindCli } from '../kind.js'
import { NodeExecFile } from '../kubectl.js'
import { NetPortProbe } from '../port-allocator.js'
import { ProcessTree } from './process-tree.js'
import type { IOperatorApi } from './operator-api-client.js'
import { OperatorApiClient } from './operator-api-client.js'
import { TenantOwnerSession } from './tenant-owner-session.js'

/** What `up` hands the orchestrator and the Plexus spec; secrets are FILE paths, never values. */
export type LiveLoopStackDescriptor = {
    platformAddress: string
    tenantPlaneOrigin: string
    tenant: string
    hive: string
    kubeContext: string
    ownerEmail: string
    ownerPasswordFile: string
    operatorEmail: string
    operatorPasswordFile: string
    idpCaFile: string
    /** The IdP's server certificate: the e2e's browser IdP login trusts exactly its public key (no OS trust needed). */
    idpCertFile: string
    /** How the e2e signs in at the IdP: its login is a JavaScript page, so a (headless) browser. */
    idpLogin: string
    dataRoot: string
}

/** The fixed names and test credentials of the stack (short fake emails; passwords meet the 12-character policy). */
export class LiveLoopStackNames
{
    public static readonly ClusterName = 'pragmatic-e2e'
    public static readonly KubeContext = 'kind-pragmatic-e2e'
    public static readonly ClientId = 'e2e-client'
    public static readonly TenantId = 'e2e'
    public static readonly HiveId = 'e2e-hive'
    public static readonly OwnerEmail = 'o@t.io'
    public static readonly OperatorEmail = 'op@t.io'
    public static readonly OwnerPassword = 'e2e-password'
    public static readonly OperatorPassword = 'e2e-operator'
    public static readonly OperatorPort = 7000
    public static readonly TenantPlanePort = 7100
    public static readonly TenantBaseDomain = 'lvh.me'
    public static readonly PlatformAddress = 'http://localhost:7000'
    public static readonly OperatorBase = 'http://127.0.0.1:7000'
    public static readonly TenantPlaneOrigin = 'http://e2e.lvh.me:7100'
    public static readonly StackDir = join(homedir(), '.pragmatic', 'e2e-stack')
    public static readonly DescriptorFile = 'stack.json'
}

/** The operator's seed, as dev-seed.sh does it: client, tenant (its IdP comes up here) and the attached hive. Returns the owner's one-time password. */
export class LiveLoopStackSeed
{
    private static readonly MethodPost = 'POST'
    private static readonly ClientsPath = '/api/clients'
    private static readonly TenantsPath = '/api/tenants'
    private static readonly HivesPath = '/api/hives'
    private static readonly StatusCreated = 201
    private static readonly OwnerKey = 'owner'
    private static readonly PasswordKey = 'password'
    private static readonly LocalBackend = 'local'
    private static readonly AttachMode = 'attach'
    private static readonly ClientName = 'E2E Client'
    private static readonly TenantName = 'E2E'
    private static readonly HiveName = 'E2E Hive'
    private static readonly FailedPrefix = 'seed step failed: '
    private static readonly StatusWord = ' status '

    public constructor(private readonly api: IOperatorApi)
    {
    }

    public async Seed(): Promise<string>
    {
        const S = LiveLoopStackSeed
        const N = LiveLoopStackNames
        await this.Expect(S.ClientsPath, { id: N.ClientId, displayName: S.ClientName })
        const tenant = await this.Expect(S.TenantsPath, { id: N.TenantId, clientId: N.ClientId, displayName: S.TenantName, ownerEmail: N.OwnerEmail })
        const owner = tenant[S.OwnerKey] as Record<string, unknown> | undefined
        const password = owner?.[S.PasswordKey]
        if (typeof password !== 'string' || password.length === 0)
        {
            throw new Error(S.FailedPrefix + S.TenantsPath)
        }
        await this.Expect(S.HivesPath, {
            id: N.HiveId, tenantId: N.TenantId, displayName: S.HiveName,
            cluster: { backend: S.LocalBackend, mode: S.AttachMode, configRef: N.KubeContext },
            // Attach with no endpoint: the hive pulls the images the stack preloaded into the kind node (the passing in-cluster smokes do the same).
            registry: { mode: S.AttachMode },
        })
        return password
    }

    private async Expect(path: string, body: unknown): Promise<Record<string, unknown>>
    {
        const S = LiveLoopStackSeed
        const answer = await this.api.Call(S.MethodPost, path, body)
        if (answer.status !== S.StatusCreated)
        {
            throw new Error(S.FailedPrefix + path + S.StatusWord + String(answer.status))
        }
        return answer.body ?? {}
    }
}

export class LiveLoopStack
{
    private static readonly UpVerb = 'up'
    private static readonly DownVerb = 'down'
    private static readonly UsageMessage = 'usage: live-loop-stack.ts up|down'
    private static readonly HttpsPort = 443
    private static readonly ServerImage = 'pragmatic-server:dev'
    private static readonly PostgresImage = 'postgres:16'
    private static readonly Docker = 'docker'
    private static readonly Kubectl = 'kubectl'
    private static readonly ImageVerb = 'image'
    private static readonly InspectVerb = 'inspect'
    private static readonly PullVerb = 'pull'
    private static readonly RmVerb = 'rm'
    private static readonly ForceFlag = '-f'
    private static readonly VolumeVerb = 'volume'
    private static readonly ContextFlag = '--context'
    private static readonly IngressManifestUrl = 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml'
    private static readonly IngressNamespace = 'ingress-nginx'
    private static readonly IngressDeployment = 'ingress-nginx-controller'
    private static readonly PassthroughPatch = '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--enable-ssl-passthrough"}]'
    private static readonly ControllerSelector = 'app.kubernetes.io/component=controller'
    private static readonly ApplyVerb = 'apply'
    private static readonly FileFlag = '-f'
    private static readonly PatchVerb = 'patch'
    private static readonly DeploymentKind = 'deployment'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly NamespaceFlag = '-n'
    private static readonly TypeFlag = '--type'
    private static readonly JsonPatchType = 'json'
    private static readonly PatchFlag = '-p'
    private static readonly RolloutVerb = 'rollout'
    private static readonly StatusVerb = 'status'
    private static readonly WaitVerb = 'wait'
    private static readonly ReadyCondition = '--for=condition=ready'
    private static readonly PodKind = 'pod'
    private static readonly SelectorFlag = '--selector='
    private static readonly WaitTimeout = '--timeout=300s'
    private static readonly AppendFlag = 'a'
    private static readonly FalseValue = 'false'
    private static readonly HttpScheme = 'http'
    private static readonly IdpContainerPrefix = 'pragmatic-idp-'
    private static readonly IdpVolumePrefix = 'pragmatic-idp-data-'
    private static readonly DataDirName = 'data'
    private static readonly LogFileName = 'control-plane.log'
    private static readonly PidFileName = 'control-plane.pid'
    private static readonly OwnerPasswordFileName = 'owner-password'
    private static readonly OperatorPasswordFileName = 'operator-password'
    private static readonly IdpTlsRelative = ['idp', LiveLoopStackNames.TenantId, 'tls']
    private static readonly IdpCaFileName = 'ca.crt'
    private static readonly IdpCertFileName = 'server.crt'
    private static readonly BrowserLogin = 'browser'
    private static readonly ServerScript = 'server.ts'
    private static readonly TsxCliRelative = ['..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs']
    private static readonly PingPath = '/api/ping'
    private static readonly PingDeadlineMs = 180_000
    private static readonly PollMs = 2_000
    private static readonly Utf8 = 'utf8'
    private static readonly GetVerb = 'get'
    private static readonly OutputFlag = '-o'
    private static readonly ArgsJsonPath = 'jsonpath={.spec.template.spec.containers[0].args}'
    private static readonly PassthroughArg = '--enable-ssl-passthrough'
    private static readonly OwnerOnlyMode = 0o600
    private static readonly Redacted = '***'
    private static readonly PortBusyPrefix = 'port '
    private static readonly PortBusySuffix = ' is in use (is another control plane, e.g. dev-up.sh, running?); stop it before bringing the e2e stack up'
    private static readonly ExitedMessage = 'the control plane exited during start; see the log in the stack folder'
    private static readonly AlreadyUpMessage = 'the e2e stack is already up (stack.json exists); run down first'
    private static readonly NotReadyMessage = 'the control plane did not answer /api/ping in time; see the log in the stack folder'
    private static readonly Steps = {
        Cluster: '[stack] kind cluster pragmatic-e2e (443 + registry node port) and images',
        Ingress: '[stack] ingress-nginx with SSL passthrough',
        ControlPlane: '[stack] control plane on :7000 / :7100 (state in the stack folder)',
        Seed: '[stack] operator seed: client, tenant e2e (IdP), hive e2e-hive',
        Owner: '[stack] owner sign-in and short test password',
        Done: '[stack] up; descriptor written to ',
        Down: '[stack] down',
    }

    private readonly exec = new NodeExecFile()
    private readonly secrets: string[] = [LiveLoopStackNames.OwnerPassword, LiveLoopStackNames.OperatorPassword]
    private readonly kind = new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs))

    public static async Main(): Promise<void>
    {
        const verb = process.argv[2]
        const stack = new LiveLoopStack()
        try
        {
            if (verb === LiveLoopStack.UpVerb)
            {
                await stack.Up()
            }
            else if (verb === LiveLoopStack.DownVerb)
            {
                await stack.Down()
            }
            else
            {
                throw new Error(LiveLoopStack.UsageMessage)
            }
        }
        catch (err)
        {
            // Any failure (a Playwright sign-in error included) is redacted before it can reach the console.
            throw new Error(stack.Redact(err instanceof Error ? err.message : String(err)))
        }
    }

    public static DescriptorPath(): string
    {
        return join(LiveLoopStackNames.StackDir, LiveLoopStackNames.DescriptorFile)
    }

    public static ReadDescriptor(path: string = LiveLoopStack.DescriptorPath()): LiveLoopStackDescriptor
    {
        return JSON.parse(readFileSync(path, LiveLoopStack.Utf8)) as LiveLoopStackDescriptor
    }

    public async Up(): Promise<void>
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        if (existsSync(L.DescriptorPath()))
        {
            throw new Error(L.AlreadyUpMessage)
        }
        const dataRoot = join(N.StackDir, L.DataDirName)
        mkdirSync(dataRoot, { recursive: true })

        console.log(L.Steps.Cluster)
        if (!(await this.kind.ListClusters()).includes(N.ClusterName))
        {
            await this.kind.CreateCluster(N.ClusterName, { extraPortMappings: [L.HttpsPort, InClusterRegistry.NodePort] })
        }
        for (const image of [L.ServerImage, InClusterRegistry.Image, L.PostgresImage])
        {
            await this.EnsureLocalImage(image)
            await this.kind.LoadImage(image, N.ClusterName)
        }

        console.log(L.Steps.Ingress)
        await this.Kubectl([L.ApplyVerb, L.FileFlag, L.IngressManifestUrl])
        // Patch only when passthrough is not on yet: a re-run of up after a partial failure reuses the cluster.
        const args = await this.Kubectl([L.GetVerb, L.DeploymentKind, L.IngressDeployment, L.NamespaceFlag, L.IngressNamespace, L.OutputFlag, L.ArgsJsonPath])
        if (!args.includes(L.PassthroughArg))
        {
            await this.Kubectl([L.PatchVerb, L.DeploymentKind, L.IngressDeployment, L.NamespaceFlag, L.IngressNamespace, L.TypeFlag, L.JsonPatchType, L.PatchFlag, L.PassthroughPatch])
        }
        await this.Kubectl([L.RolloutVerb, L.StatusVerb, L.DeploymentPrefix + L.IngressDeployment, L.NamespaceFlag, L.IngressNamespace, L.WaitTimeout])
        await this.Kubectl([L.WaitVerb, L.NamespaceFlag, L.IngressNamespace, L.ReadyCondition, L.PodKind, L.SelectorFlag + L.ControllerSelector, L.WaitTimeout])

        console.log(L.Steps.ControlPlane)
        const operatorPasswordFile = join(N.StackDir, L.OperatorPasswordFileName)
        writeFileSync(operatorPasswordFile, N.OperatorPassword, { encoding: L.Utf8, mode: L.OwnerOnlyMode })
        await this.RequireFreePorts()
        await this.WaitForPing(this.StartControlPlane(dataRoot))

        console.log(L.Steps.Seed)
        const api = new OperatorApiClient(N.OperatorBase)
        await api.Login(N.OperatorEmail, N.OperatorPassword)
        const oneTime = await new LiveLoopStackSeed(api).Seed()
        this.secrets.push(oneTime)

        console.log(L.Steps.Owner)
        const owner = await TenantOwnerSession.Open(N.TenantPlaneOrigin, N.OwnerEmail, oneTime)
        try
        {
            await owner.ChangePassword(oneTime, N.OwnerPassword)
        }
        finally
        {
            await owner.Close()
        }
        const ownerPasswordFile = join(N.StackDir, L.OwnerPasswordFileName)
        writeFileSync(ownerPasswordFile, N.OwnerPassword, { encoding: L.Utf8, mode: L.OwnerOnlyMode })

        const descriptor: LiveLoopStackDescriptor = {
            platformAddress: N.PlatformAddress,
            tenantPlaneOrigin: N.TenantPlaneOrigin,
            tenant: N.TenantId,
            hive: N.HiveId,
            kubeContext: N.KubeContext,
            ownerEmail: N.OwnerEmail,
            ownerPasswordFile,
            operatorEmail: N.OperatorEmail,
            operatorPasswordFile,
            idpCaFile: join(dataRoot, ...L.IdpTlsRelative, L.IdpCaFileName),
            idpCertFile: join(dataRoot, ...L.IdpTlsRelative, L.IdpCertFileName),
            idpLogin: L.BrowserLogin,
            dataRoot,
        }
        writeFileSync(L.DescriptorPath(), JSON.stringify(descriptor, null, 2), L.Utf8)
        console.log(L.Steps.Done + L.DescriptorPath())
    }

    /** Best effort, every step on its own: stop the control plane, remove the IdP container + volume, delete the cluster and the folder. */
    public async Down(): Promise<void>
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        console.log(L.Steps.Down)
        const pidFile = join(N.StackDir, L.PidFileName)
        // Only a control plane that still answers is ours to stop; a dead one's pid may have been reused by another process.
        if (existsSync(pidFile) && await LiveLoopStack.Pings())
        {
            await this.BestEffort(() => new ProcessTree(this.exec).Kill(Number(readFileSync(pidFile, L.Utf8).trim())))
        }
        await this.BestEffort(() => this.exec.Run(L.Docker, [L.RmVerb, L.ForceFlag, L.IdpContainerPrefix + N.TenantId]))
        await this.BestEffort(() => this.exec.Run(L.Docker, [L.VolumeVerb, L.RmVerb, L.ForceFlag, L.IdpVolumePrefix + N.TenantId]))
        await this.BestEffort(() => this.kind.DeleteCluster(N.ClusterName))
        await this.BestEffort(async () => rmSync(N.StackDir, { recursive: true, force: true }))
    }

    /** Starts `server.ts` detached with the stack's settings; its output goes to the log file in the stack folder. */
    private StartControlPlane(dataRoot: string): ChildProcess
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        const here = dirname(fileURLToPath(import.meta.url))
        const controlPlaneDir = resolve(here, '..')
        const log = openSync(join(N.StackDir, L.LogFileName), L.AppendFlag)
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PRAGMATIC_ADMIN_DATA_ROOT: dataRoot,
            PRAGMATIC_ADMIN_PORT: String(N.OperatorPort),
            PRAGMATIC_ADMIN_OPERATOR_EMAIL: N.OperatorEmail,
            PRAGMATIC_ADMIN_OPERATOR_PASSWORD: N.OperatorPassword,
            PRAGMATIC_ADMIN_SECURE_COOKIE: L.FalseValue,
            PRAGMATIC_TENANT_ADMIN_PORT: String(N.TenantPlanePort),
            PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: N.TenantBaseDomain,
            PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME: L.HttpScheme,
            PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: String(N.TenantPlanePort),
        }
        const child = spawn(process.execPath, [resolve(here, ...L.TsxCliRelative), L.ServerScript], { cwd: controlPlaneDir, env, detached: true, stdio: ['ignore', log, log], windowsHide: true })
        writeFileSync(join(N.StackDir, L.PidFileName), String(child.pid), L.Utf8)
        child.unref()
        return child
    }

    /** The stack's ports must be free: a control plane already listening (the developer's own) must never be seeded. */
    private async RequireFreePorts(): Promise<void>
    {
        const L = LiveLoopStack
        const probe = new NetPortProbe()
        for (const port of [LiveLoopStackNames.OperatorPort, LiveLoopStackNames.TenantPlanePort])
        {
            if (!await probe.Free(port))
            {
                throw new Error(L.PortBusyPrefix + String(port) + L.PortBusySuffix)
            }
        }
    }

    /** True when a control plane answers /api/ping on the stack's operator port. */
    private static async Pings(): Promise<boolean>
    {
        try
        {
            const response = await fetch(LiveLoopStackNames.OperatorBase + LiveLoopStack.PingPath)
            await response.text()
            return response.ok
        }
        catch
        {
            return false
        }
    }

    /** Waits for OUR control plane: an exited child fails at once (its log in the stack folder says why). */
    private async WaitForPing(child: ChildProcess): Promise<void>
    {
        const L = LiveLoopStack
        const deadline = Date.now() + L.PingDeadlineMs
        while (Date.now() < deadline)
        {
            if (child.exitCode !== null)
            {
                throw new Error(L.ExitedMessage)
            }
            if (await LiveLoopStack.Pings())
            {
                return
            }
            await new Promise<void>(r => setTimeout(r, L.PollMs))
        }
        throw new Error(L.NotReadyMessage)
    }

    /** The text with every secret this run handled replaced by a placeholder. */
    public Redact(text: string): string
    {
        return this.secrets.reduce((out, secret) => secret === '' ? out : out.split(secret).join(LiveLoopStack.Redacted), text)
    }

    private async EnsureLocalImage(image: string): Promise<void>
    {
        const L = LiveLoopStack
        try
        {
            await this.exec.Run(L.Docker, [L.ImageVerb, L.InspectVerb, image])
        }
        catch
        {
            await this.exec.Run(L.Docker, [L.PullVerb, image])
        }
    }

    private async Kubectl(args: readonly string[]): Promise<string>
    {
        const L = LiveLoopStack
        return (await this.exec.Run(L.Kubectl, [L.ContextFlag, LiveLoopStackNames.KubeContext, ...args])).stdout
    }

    private async BestEffort(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (err)
        {
            console.log((err as Error).message)
        }
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    LiveLoopStack.Main().catch(err =>
    {
        console.error((err as Error).message)
        process.exitCode = 1
    })
}
