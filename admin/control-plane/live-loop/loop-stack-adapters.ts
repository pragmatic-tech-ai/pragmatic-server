import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import type { CreateAccountParams, GrantMutationDto, SecurityCatalogDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PromotionResultDto } from '../control-plane-host.js'
import type { EnvType, Template } from '../environment-record.js'
import { EnvironmentWorkloadFactory } from '../environment-workload.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { IExecFile } from '../kubectl.js'
import { NodeExecFile } from '../kubectl.js'
import { NetPortProbe, PortAllocator } from '../port-allocator.js'
import type { LiveLoopStackDescriptor } from './live-loop-stack.js'
import type { ILoopComposition, ILoopDatabase, ILoopEnvironments, ILoopGraphs, ILoopReach, LoopEnvironment } from './loop-orchestrator.js'
import type { ApiAnswer, IOperatorApi } from './operator-api-client.js'
import { OperatorApiClient } from './operator-api-client.js'
import { TenantOwnerSession } from './tenant-owner-session.js'

/** A JSON API answering `ApiAnswer`s: the owner's tenant API session or the operator API. */
export interface ILoopApi
{
    Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
}

/** Turns a non-success answer into an error naming the operation, the status and the server's own error text (never a secret). */
export class LoopApiAnswers
{
    private static readonly ErrorKey = 'error'
    private static readonly FailedSuffix = ' failed: status '
    private static readonly DetailSep = ': '
    private static readonly SuccessFloor = 200
    private static readonly SuccessCeiling = 300

    public static Require(answer: ApiAnswer, operation: string): ApiAnswer
    {
        const A = LoopApiAnswers
        if (answer.status >= A.SuccessFloor && answer.status < A.SuccessCeiling)
        {
            return answer
        }
        const error = answer.body?.[A.ErrorKey]
        throw new Error(operation + A.FailedSuffix + String(answer.status) + (typeof error === 'string' ? A.DetailSep + error : ''))
    }
}

/** The tenant owner's environment operations over the tenant API. */
export class TenantApiLoopEnvironments implements ILoopEnvironments
{
    private static readonly EnvironmentsPath = '/tenant-api/environments'
    private static readonly AdminSegment = '/admin/'
    private static readonly AccountsLeaf = 'accounts'
    private static readonly GrantsLeaf = 'grants'
    private static readonly SecurityModelLeaf = 'security-model'
    private static readonly SecurityCatalogLeaf = 'security-catalog'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodPut = 'PUT'
    private static readonly MethodDelete = 'DELETE'
    private static readonly StatusNotFound = 404
    private static readonly OpCreate = 'environment create'
    private static readonly OpDelete = 'environment delete'
    private static readonly OpAccount = 'account create'
    private static readonly OpGrant = 'role grant'
    private static readonly OpGetModel = 'security setting read'
    private static readonly OpSetModel = 'security setting write'
    private static readonly OpCatalog = 'security catalog read'
    private static readonly MissingBody = ' answered without a body'

    public constructor(private readonly owner: ILoopApi)
    {
    }

    public async Create(name: string, template: Template, type: EnvType): Promise<LoopEnvironment>
    {
        const E = TenantApiLoopEnvironments
        const answer = LoopApiAnswers.Require(await this.owner.Call(E.MethodPost, E.EnvironmentsPath, { name, template, type }), E.OpCreate)
        const body = answer.body
        if (body === undefined)
        {
            throw new Error(E.OpCreate + E.MissingBody)
        }
        return { name: String(body.name), environmentId: String(body.environmentId), status: String(body.status) }
    }

    public async Delete(name: string): Promise<boolean>
    {
        const E = TenantApiLoopEnvironments
        const answer = await this.owner.Call(E.MethodDelete, E.EnvironmentsPath + '/' + encodeURIComponent(name))
        if (answer.status === E.StatusNotFound)
        {
            return false
        }
        LoopApiAnswers.Require(answer, E.OpDelete)
        return true
    }

    public async AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    {
        const E = TenantApiLoopEnvironments
        LoopApiAnswers.Require(await this.owner.Call(E.MethodPost, this.AdminPath(name, E.AccountsLeaf), params), E.OpAccount)
    }

    public async AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        const E = TenantApiLoopEnvironments
        LoopApiAnswers.Require(await this.owner.Call(E.MethodPost, this.AdminPath(name, E.GrantsLeaf), mutation), E.OpGrant)
    }

    public async AdminGetSecurityModel(name: string): Promise<SecurityModelDto | undefined>
    {
        const E = TenantApiLoopEnvironments
        const answer = LoopApiAnswers.Require(await this.owner.Call(E.MethodGet, this.AdminPath(name, E.SecurityModelLeaf)), E.OpGetModel)
        return answer.body as SecurityModelDto | undefined
    }

    public async AdminSetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
    {
        const E = TenantApiLoopEnvironments
        LoopApiAnswers.Require(await this.owner.Call(E.MethodPut, this.AdminPath(name, E.SecurityModelLeaf), { securityModel }), E.OpSetModel)
    }

    public async AdminGetSecurityCatalog(name: string): Promise<SecurityCatalogDto>
    {
        const E = TenantApiLoopEnvironments
        const answer = LoopApiAnswers.Require(await this.owner.Call(E.MethodGet, this.AdminPath(name, E.SecurityCatalogLeaf)), E.OpCatalog)
        if (answer.body === undefined)
        {
            throw new Error(E.OpCatalog + E.MissingBody)
        }
        return answer.body as unknown as SecurityCatalogDto
    }

    private AdminPath(name: string, leaf: string): string
    {
        return TenantApiLoopEnvironments.EnvironmentsPath + '/' + encodeURIComponent(name) + TenantApiLoopEnvironments.AdminSegment + leaf
    }
}

/** The owner creates the dev graph (tenant API); the operator promotes it (operator API). */
export class StackLoopGraphs implements ILoopGraphs
{
    private static readonly TenantEnvironmentsPath = '/tenant-api/environments'
    private static readonly OperatorEnvironmentsPath = '/api/environments'
    private static readonly GraphsSegment = '/graphs'
    private static readonly PromoteSegment = '/promote'
    private static readonly MethodPost = 'POST'
    private static readonly OpGraphCreate = 'graph create'
    private static readonly OpPromote = 'promote'
    private static readonly MissingBody = ' answered without a body'

    public constructor(private readonly owner: ILoopApi, private readonly operator: ILoopApi)
    {
    }

    public async Create(envName: string, name: string, description: string): Promise<void>
    {
        const G = StackLoopGraphs
        const path = G.TenantEnvironmentsPath + '/' + encodeURIComponent(envName) + G.GraphsSegment
        LoopApiAnswers.Require(await this.owner.Call(G.MethodPost, path, { name, description }), G.OpGraphCreate)
    }

    public async Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        const G = StackLoopGraphs
        const path = G.OperatorEnvironmentsPath + '/' + encodeURIComponent(sourceEnv) + G.GraphsSegment + '/' + encodeURIComponent(graphName) + G.PromoteSegment
        const answer = LoopApiAnswers.Require(await this.operator.Call(G.MethodPost, path, { targetEnv }), G.OpPromote)
        if (answer.body === undefined)
        {
            throw new Error(G.OpPromote + G.MissingBody)
        }
        return answer.body as unknown as PromotionResultDto
    }
}

/**
 * SQL through `psql` in the environment's Postgres pod (`kubectl exec`), as the database's own user; the statement is passed as
 * an argument, never logged. Returns the row count psql reports for the last statement (0 when it reports none).
 */
export class KubectlLoopDatabase implements ILoopDatabase
{
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly ExecVerb = 'exec'
    private static readonly PodOrdinalSuffix = '-0'
    private static readonly ArgsSeparator = '--'
    private static readonly Shell = 'sh'
    private static readonly ShellCommandFlag = '-c'
    private static readonly PsqlScript = 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"'
    private static readonly ScriptName = 'loop-db-exec'
    private static readonly CountPattern = /(?:INSERT \d+|UPDATE|DELETE|SELECT|CREATE TABLE AS|MERGE|COPY) (\d+)\s*$/

    public constructor(private readonly kubeContext: string, private readonly exec: IExecFile = new NodeExecFile())
    {
    }

    public async Exec(env: string, sql: string): Promise<number>
    {
        const D = KubectlLoopDatabase
        const pod = K8sManifestBuilder.DatabaseOf(env) + D.PodOrdinalSuffix
        const { stdout } = await this.exec.Run(D.Kubectl, [D.ContextFlag, this.kubeContext, D.NamespaceFlag, K8sManifestBuilder.NamespaceOf(env), D.ExecVerb, pod, D.ArgsSeparator, D.Shell, D.ShellCommandFlag, D.PsqlScript, D.ScriptName, sql])
        return KubectlLoopDatabase.RowCountOf(stdout)
    }

    /** The count in psql's last command tag (`INSERT 0 1` -> 1, `UPDATE 3` -> 3); 0 for a tag without one (`CREATE TABLE`). */
    public static RowCountOf(stdout: string): number
    {
        const match = KubectlLoopDatabase.CountPattern.exec(stdout.trimEnd())
        return match === null ? 0 : Number(match[1])
    }
}

/**
 * Reaches an environment server through a detached `kubectl port-forward` on a free loopback port, so the reach outlives the
 * orchestrator process (the e2e keeps using it between subcommands). The forward's pid and port are recorded beside the stack
 * descriptor; Open reuses a live one, Close stops it and forgets it.
 */
export class PortForwardLoopReach implements ILoopReach
{
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly ServicePrefix = 'svc/'
    private static readonly AddressFlag = '--address'
    private static readonly Loopback = '127.0.0.1'
    private static readonly OriginPrefix = 'http://localhost:'
    private static readonly PortSep = ':'
    private static readonly RecordPrefix = 'forward-'
    private static readonly RecordSuffix = '.json'
    private static readonly PortFloor = 18100
    private static readonly ReadyDeadlineMs = 30_000
    private static readonly PollMs = 500
    private static readonly Utf8 = 'utf8'
    private static readonly TaskKill = 'taskkill'
    private static readonly TaskKillArgs = ['/T', '/F', '/PID']
    private static readonly NotReadyMessage = 'the port-forward to the environment did not open in time'
    private static readonly ConnectEvent = 'connect'
    private static readonly ErrorEvent = 'error'

    public constructor(private readonly kubeContext: string, private readonly recordDir: string, private readonly exec: IExecFile = new NodeExecFile())
    {
    }

    public async Open(envName: string): Promise<string>
    {
        const R = PortForwardLoopReach
        const record = this.Read(envName)
        if (record !== undefined && await R.Listening(record.port))
        {
            return R.OriginPrefix + String(record.port)
        }
        const port = await new PortAllocator(R.PortFloor, new NetPortProbe()).Allocate([])
        const child = spawn(R.Kubectl, [R.ContextFlag, this.kubeContext, R.NamespaceFlag, K8sManifestBuilder.NamespaceOf(envName), R.PortForwardVerb,
            R.ServicePrefix + K8sManifestBuilder.ServerDeploymentOf(envName), String(port) + R.PortSep + String(EnvironmentWorkloadFactory.ServerPort), R.AddressFlag, R.Loopback],
            { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        writeFileSync(this.RecordPath(envName), JSON.stringify({ pid: child.pid, port }), R.Utf8)
        const deadline = Date.now() + R.ReadyDeadlineMs
        while (Date.now() < deadline)
        {
            if (await R.Listening(port))
            {
                return R.OriginPrefix + String(port)
            }
            await new Promise<void>(r => setTimeout(r, R.PollMs))
        }
        throw new Error(R.NotReadyMessage)
    }

    public async Close(envName: string): Promise<void>
    {
        const R = PortForwardLoopReach
        const record = this.Read(envName)
        if (record === undefined)
        {
            return
        }
        try
        {
            await this.exec.Run(R.TaskKill, [...R.TaskKillArgs, String(record.pid)])
        }
        catch
        {
            // already gone
        }
        rmSync(this.RecordPath(envName), { force: true })
    }

    private Read(envName: string): { pid: number; port: number } | undefined
    {
        const path = this.RecordPath(envName)
        return existsSync(path) ? JSON.parse(readFileSync(path, PortForwardLoopReach.Utf8)) as { pid: number; port: number } : undefined
    }

    private RecordPath(envName: string): string
    {
        return join(this.recordDir, PortForwardLoopReach.RecordPrefix + envName + PortForwardLoopReach.RecordSuffix)
    }

    private static Listening(port: number): Promise<boolean>
    {
        const R = PortForwardLoopReach
        return new Promise(resolve =>
        {
            const socket = createConnection({ host: R.Loopback, port })
            socket.once(R.ConnectEvent, () =>
            {
                socket.destroy()
                resolve(true)
            })
            socket.once(R.ErrorEvent, () => resolve(false))
        })
    }
}

/** The owner's tenant API, signed in on first use (one browser per orchestrator process). */
export class LazyOwnerApi implements ILoopApi
{
    private session: Promise<TenantOwnerSession> | undefined

    public constructor(private readonly origin: string, private readonly email: string, private readonly password: string)
    {
    }

    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        this.session ??= TenantOwnerSession.Open(this.origin, this.email, this.password)
        return (await this.session).Call(method, path, body)
    }

    public async Close(): Promise<void>
    {
        if (this.session !== undefined)
        {
            await (await this.session).Close()
        }
    }
}

/** The operator API, signed in on first use. */
export class LazyOperatorApi implements ILoopApi
{
    private login: Promise<void> | undefined

    public constructor(private readonly api: IOperatorApi, private readonly email: string, private readonly password: string)
    {
    }

    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        this.login ??= this.api.Login(this.email, this.password)
        await this.login
        return this.api.Call(method, path, body)
    }
}

/** The orchestrator's adapters over a running stack (stack.json): owner and operator sessions, kubectl database and reach. */
export class LoopStackComposition implements ILoopComposition
{
    private static readonly Utf8 = 'utf8'

    private constructor(
        public readonly envs: ILoopEnvironments,
        public readonly graphs: ILoopGraphs,
        public readonly database: ILoopDatabase,
        public readonly reach: ILoopReach,
        private readonly owner: LazyOwnerApi,
        private readonly secrets: readonly string[])
    {
    }

    public static FromStack(stack: LiveLoopStackDescriptor): LoopStackComposition
    {
        const C = LoopStackComposition
        const ownerPassword = readFileSync(stack.ownerPasswordFile, C.Utf8)
        const operatorPassword = readFileSync(stack.operatorPasswordFile, C.Utf8)
        const owner = new LazyOwnerApi(stack.tenantPlaneOrigin, stack.ownerEmail, ownerPassword)
        const operator = new LazyOperatorApi(new OperatorApiClient(stack.platformAddress), stack.operatorEmail, operatorPassword)
        return new LoopStackComposition(
            new TenantApiLoopEnvironments(owner),
            new StackLoopGraphs(owner, operator),
            new KubectlLoopDatabase(stack.kubeContext),
            new PortForwardLoopReach(stack.kubeContext, dirname(stack.ownerPasswordFile)),
            owner,
            [ownerPassword, operatorPassword])
    }

    /** The stack passwords this composition read, for redaction. */
    public Secrets(): readonly string[]
    {
        return this.secrets
    }

    public async Close(): Promise<void>
    {
        await this.owner.Close()
    }
}
