/**
 * Orchestrator for the Plexus runtime-publishing live-loop e2e (admin side), driving the RUNNING e2e stack
 * (live-loop-stack.ts up) the way its people would: the tenant OWNER creates the environments on the tenant's hive, the dev
 * graph, the reader and ungranted accounts, the reader's role and the runtime's security setting (tenant API, signed in at
 * the tenant plane); the OPERATOR promotes (operator API). Each subcommand prints ONE JSON descriptor to stdout. Tokens and
 * passwords are never passed to the logger (stderr).
 *
 *   npx tsx admin/control-plane/live-loop/loop-orchestrator.ts create-dev [--stack <stack.json>] [--graph <g>]
 *   npx tsx admin/control-plane/live-loop/loop-orchestrator.ts create-runtime [--stack <stack.json>]
 *   npx tsx admin/control-plane/live-loop/loop-orchestrator.ts promote [--stack <stack.json>] --graph <g>
 *   npx tsx admin/control-plane/live-loop/loop-orchestrator.ts db-exec [--stack <stack.json>] --sql <sql>
 *   npx tsx admin/control-plane/live-loop/loop-orchestrator.ts teardown [--stack <stack.json>]
 *
 * `--stack` defaults to ~/.pragmatic/e2e-stack/stack.json.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CreateAccountParams, GrantMutationDto, SecurityCatalogDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { BundleBuilder } from '../../../environments/seed/bundle.js'
import type { PromotionResultDto } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template } from '../environment-record.js'
import { RuntimeReaderSecurity } from '../runtime-reader-security.js'
import { LiveLoopStack } from './live-loop-stack.js'
import { LoopStackComposition } from './loop-stack-adapters.js'

export enum LoopCommand
{
    CreateDev = 'create-dev',
    CreateRuntime = 'create-runtime',
    Promote = 'promote',
    Teardown = 'teardown',
    DbExec = 'db-exec'
}

export interface ParsedLoopCommand
{
    command: LoopCommand
    stack: string
    graph?: string
    sql?: string
}

export interface CredentialDescriptor
{
    email: string
    password: string
}

/** Output of create-dev: the cross-task JSON contract consumed by the e2e (keys are fixed). */
export interface DevDescriptor
{
    devEnv: string
    graphName: string
}

/** Output of create-runtime (no promotion): the cross-task JSON contract consumed by the e2e (keys are fixed). */
export interface RuntimeDescriptor
{
    runtimeEnv: string
    tenant: string
    runtimeWsUrl: string
    appOriginBase: string
    reader: CredentialDescriptor
    ungranted: CredentialDescriptor
}

/** Output of promote: the non-secret promotion result. */
export interface PromoteDescriptor
{
    graphName: string
    packageCount: number
    targetEnv: string
}

/** Output of teardown. */
export interface TeardownDescriptor
{
    ok: true
}

/** Output of db-exec. */
export interface DbExecDescriptor
{
    ok: true
    rowCount: number
}

export type LoopDescriptor = DevDescriptor | RuntimeDescriptor | PromoteDescriptor | TeardownDescriptor | DbExecDescriptor

export interface ILoopLogger
{
    Log(message: string): void
}

/** What the orchestrator needs of a created environment. */
export interface LoopEnvironment
{
    name: string
    environmentId: string
    status: string
}

/** The tenant owner's environment operations (the tenant API). */
export interface ILoopEnvironments
{
    Create(name: string, template: Template, type: EnvType): Promise<LoopEnvironment>
    /** True when the environment existed and was deleted; false when there was none. */
    Delete(name: string): Promise<boolean>
    AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    AdminGetSecurityModel(name: string): Promise<SecurityModelDto | undefined>
    AdminSetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
    AdminGetSecurityCatalog(name: string): Promise<SecurityCatalogDto>
}

/** Graph create (the owner) and promote (the operator). */
export interface ILoopGraphs
{
    Create(envName: string, name: string, description: string): Promise<void>
    Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
}

/** Runs SQL against an environment's provisioned Postgres; returns the affected-row count of the last statement. */
export interface ILoopDatabase
{
    Exec(env: string, sql: string): Promise<number>
}

/** How the e2e's browser and node clients reach an environment server; the reach outlives the orchestrator process. */
export interface ILoopReach
{
    /** The http origin serving the environment (e.g. http://localhost:18100). */
    Open(envName: string): Promise<string>
    Close(envName: string): Promise<void>
}

/** The adapters the orchestrator runs on, plus their release. */
export interface ILoopComposition
{
    envs: ILoopEnvironments
    graphs: ILoopGraphs
    database: ILoopDatabase
    reach: ILoopReach
    Close(): Promise<void>
}

export class StderrLoopLogger implements ILoopLogger
{
    private static readonly LineEnd = '\n'

    public Log(message: string): void
    {
        process.stderr.write(message + StderrLoopLogger.LineEnd)
    }
}

/** Marks a failure already reported (redacted) to the logger. */
export class LoopFailure extends Error
{
}

export class LoopOrchestrator
{
    private static readonly StackFlag = '--stack'
    private static readonly GraphFlag = '--graph'
    private static readonly SqlFlag = '--sql'
    private static readonly FlagPrefix = '--'
    private static readonly DevEnvName = 'loop-dev'
    private static readonly RuntimeEnvName = 'loop-rt'
    private static readonly DefaultGraphName = 'loop-graph'
    private static readonly GraphDescription = 'live-loop e2e graph'
    private static readonly HttpScheme = 'http:'
    private static readonly WsScheme = 'ws:'
    private static readonly WssScheme = 'wss:'
    private static readonly AuthoritySep = '//'
    private static readonly WsEnvironmentQuery = '/?environment='
    private static readonly ViewerRole = 'Viewer'
    private static readonly TenantKind = 'Tenant'
    private static readonly ReaderPrincipal = 'loop-reader'
    private static readonly ReaderEmail = 'r@t.io'
    private static readonly UngrantedPrincipal = 'loop-ungranted'
    private static readonly UngrantedEmail = 'u@t.io'
    private static readonly PasswordBytes = 12
    private static readonly PasswordEncoding = 'base64url'
    private static readonly MsgCreatingDev = 'creating development environment'
    private static readonly MsgCreatingRuntime = 'creating runtime environment'
    private static readonly MsgPromoting = 'promoting graph to runtime environment'
    private static readonly MsgSecuring = 'granting the runtime admin and reader access in the security setting'
    private static readonly MsgProvisioning = 'provisioning reader and ungranted accounts'
    private static readonly MsgReach = 'opening the runtime environment to the e2e'
    private static readonly UsageMessage = 'usage: loop-orchestrator <create-dev|create-runtime|promote|teardown|db-exec> [--stack <stack.json>] [--graph <name>] [--sql <sql>] (--graph is required for promote, --sql for db-exec)'
    private static readonly MissingGraph = 'promote requires --graph'
    private static readonly MissingSql = 'db-exec requires --sql'
    private static readonly MsgDbExec = 'executing SQL against the runtime database'
    private static readonly MissingValue = 'missing value for '
    private static readonly UnknownCommand = 'unknown command: '
    private static readonly UsageSep = '; '
    private static readonly Redacted = '***'
    private static readonly FailureSep = ': '
    private static readonly NotRunningPrefix = 'environment did not reach running: '
    private static readonly MsgTearingDownPrefix = 'tearing down environment '
    private static readonly MsgAbsentSuffix = ' (absent)'
    private static readonly NoSuffix = ''
    private static readonly UnhandledCommand = 'unhandled command: '

    private readonly secrets = new Set<string>()

    public constructor(
        private readonly envs: ILoopEnvironments,
        private readonly graphs: ILoopGraphs,
        private readonly logger: ILoopLogger,
        private readonly database: ILoopDatabase,
        private readonly reach: ILoopReach)
    {
    }

    /** Parses argv (already stripped of node and script path) into a command; throws a usage error otherwise. */
    public static ParseCommand(argv: readonly string[], defaultStack: string = LiveLoopStack.DescriptorPath()): ParsedLoopCommand
    {
        const L = LoopOrchestrator
        const verb = argv[0]
        const command = Object.values(LoopCommand).find(c => c === verb)
        if (command === undefined)
        {
            throw new Error(L.UnknownCommand + String(verb) + L.UsageSep + L.UsageMessage)
        }
        const stack = L.FlagValue(argv, L.StackFlag) ?? defaultStack
        const graph = L.FlagValue(argv, L.GraphFlag)
        if (command === LoopCommand.Promote && graph === undefined)
        {
            throw new Error(L.MissingGraph + L.UsageSep + L.UsageMessage)
        }
        const sql = L.FlagValue(argv, L.SqlFlag)
        if (command === LoopCommand.DbExec && sql === undefined)
        {
            throw new Error(L.MissingSql + L.UsageSep + L.UsageMessage)
        }
        const parsed: ParsedLoopCommand = { command, stack }
        if (graph !== undefined)
        {
            parsed.graph = graph
        }
        if (sql !== undefined)
        {
            parsed.sql = sql
        }
        return parsed
    }

    private static FlagValue(argv: readonly string[], flag: string): string | undefined
    {
        const at = argv.indexOf(flag)
        if (at < 0)
        {
            return undefined
        }
        const value = argv[at + 1]
        if (value === undefined || value.startsWith(LoopOrchestrator.FlagPrefix))
        {
            throw new Error(LoopOrchestrator.MissingValue + flag)
        }
        return value
    }

    public async CreateDev(graphName: string = LoopOrchestrator.DefaultGraphName): Promise<DevDescriptor>
    {
        const name = LoopOrchestrator.DevEnvName
        this.logger.Log(LoopOrchestrator.MsgCreatingDev)
        LoopOrchestrator.RequireRunning(await this.envs.Create(name, Template.DevBlank, EnvType.Development))
        await this.graphs.Create(name, graphName, LoopOrchestrator.GraphDescription)
        return { devEnv: name, graphName }
    }

    public async CreateRuntime(): Promise<RuntimeDescriptor>
    {
        const L = LoopOrchestrator
        const name = L.RuntimeEnvName
        this.logger.Log(L.MsgCreatingRuntime)
        const rec = L.RequireRunning(await this.envs.Create(name, Template.RuntimePostgres, EnvType.Runtime))
        this.logger.Log(L.MsgProvisioning)
        const reader = await this.Provision(name, L.ReaderPrincipal, L.ReaderEmail, true)
        const ungranted = await this.Provision(name, L.UngrantedPrincipal, L.UngrantedEmail, false)
        this.logger.Log(L.MsgReach)
        const origin = await this.reach.Open(name)
        return {
            runtimeEnv: name,
            tenant: rec.environmentId,
            runtimeWsUrl: L.WsUrlOf(origin, rec.environmentId),
            appOriginBase: origin,
            reader,
            ungranted
        }
    }

    /** The environment server's WebSocket for an http origin: same host and port, ws scheme, `/?environment=<id>`. */
    public static WsUrlOf(httpOrigin: string, environmentId: string): string
    {
        const L = LoopOrchestrator
        const url = new URL(httpOrigin)
        return (url.protocol === L.HttpScheme ? L.WsScheme : L.WssScheme) + L.AuthoritySep + url.host + L.WsEnvironmentQuery + environmentId
    }

    /** Promotes a dev graph into the EXISTING runtime env (never creates it); re-runnable: each call replaces the promoted content. */
    public async Promote(graphName: string): Promise<PromoteDescriptor>
    {
        this.logger.Log(LoopOrchestrator.MsgPromoting)
        const result = await this.graphs.Promote(LoopOrchestrator.DevEnvName, graphName, LoopOrchestrator.RuntimeEnvName)
        await this.SecureRuntime()
        return { graphName: result.graphName, packageCount: result.packageCount, targetEnv: result.targetEnv }
    }

    /**
     * After each promote, as a tenant administrator would: the bootstrap admin is System Administrator and the reader a Reader
     * of every concept the environment now holds. The ungranted user is given nothing, so its read stays refused.
     */
    private async SecureRuntime(): Promise<void>
    {
        const name = LoopOrchestrator.RuntimeEnvName
        this.logger.Log(LoopOrchestrator.MsgSecuring)
        const catalog = await this.envs.AdminGetSecurityCatalog(name)
        const current = await this.envs.AdminGetSecurityModel(name)
        const concepts = catalog.concepts.map(c => c.name)
        await this.envs.AdminSetSecurityModel(name, RuntimeReaderSecurity.Secured(current, BundleBuilder.AdminPrincipalId, [LoopOrchestrator.ReaderPrincipal], concepts))
    }

    /** Runs the SQL against the runtime env's provisioned Postgres. The statement text is never logged. */
    public async DbExec(sql: string): Promise<DbExecDescriptor>
    {
        this.logger.Log(LoopOrchestrator.MsgDbExec)
        const rowCount = await this.database.Exec(LoopOrchestrator.RuntimeEnvName, sql)
        return { ok: true, rowCount }
    }

    /** Idempotent: closes the runtime reach and removes whichever of the loop environments exist. */
    public async Teardown(): Promise<TeardownDescriptor>
    {
        const L = LoopOrchestrator
        await this.reach.Close(L.RuntimeEnvName)
        for (const name of [L.DevEnvName, L.RuntimeEnvName])
        {
            const deleted = await this.envs.Delete(name)
            this.logger.Log(L.MsgTearingDownPrefix + name + (deleted ? L.NoSuffix : L.MsgAbsentSuffix))
        }
        return { ok: true }
    }

    public async Run(parsed: ParsedLoopCommand): Promise<LoopDescriptor>
    {
        switch (parsed.command)
        {
            case LoopCommand.CreateDev:
                return this.CreateDev(parsed.graph)
            case LoopCommand.CreateRuntime:
                return this.CreateRuntime()
            case LoopCommand.Promote:
                return this.Promote(LoopOrchestrator.RequireGraph(parsed))
            case LoopCommand.Teardown:
                return this.Teardown()
            case LoopCommand.DbExec:
                return this.DbExec(LoopOrchestrator.RequireSql(parsed))
            default:
            {
                const unhandled: never = parsed.command
                throw new Error(LoopOrchestrator.UnhandledCommand + String(unhandled))
            }
        }
    }

    /** ParseCommand guarantees --sql for db-exec; this narrows the type. */
    private static RequireSql(parsed: ParsedLoopCommand): string
    {
        if (parsed.sql === undefined)
        {
            throw new Error(LoopOrchestrator.MissingSql)
        }
        return parsed.sql
    }

    /** ParseCommand guarantees --graph for promote; this narrows the type and never substitutes a default. */
    private static RequireGraph(parsed: ParsedLoopCommand): string
    {
        if (parsed.graph === undefined)
        {
            throw new Error(LoopOrchestrator.MissingGraph)
        }
        return parsed.graph
    }

    /** Environment create answers once the workload is up; this guards that contract. */
    private static RequireRunning(rec: LoopEnvironment): LoopEnvironment
    {
        if (rec.status !== EnvStatus.Running)
        {
            throw new Error(LoopOrchestrator.NotRunningPrefix + rec.name)
        }
        return rec
    }

    /** Replaces every held secret in the text with a placeholder. */
    public Redact(text: string): string
    {
        let out = text
        for (const secret of this.secrets)
        {
            if (secret !== '')
            {
                out = out.split(secret).join(LoopOrchestrator.Redacted)
            }
        }
        return out
    }

    /** Holds a secret for redaction (the stack's passwords, read by the composition). */
    public HoldSecret(secret: string): void
    {
        this.secrets.add(secret)
    }

    /** Logs the error class name and the message with held secrets redacted. */
    public ReportFailure(err: unknown): void
    {
        const kind = err instanceof Error ? err.name : typeof err
        const message = err instanceof Error ? err.message : String(err)
        this.logger.Log(this.Redact(kind + LoopOrchestrator.FailureSep + message))
    }

    private async Provision(env: string, principalId: string, email: string, grantViewer: boolean): Promise<CredentialDescriptor>
    {
        const password = randomBytes(LoopOrchestrator.PasswordBytes).toString(LoopOrchestrator.PasswordEncoding)
        this.secrets.add(password)
        await this.envs.AdminCreateAccount(env, { email, principalId, password })
        if (grantViewer)
        {
            await this.envs.AdminGrantRole(env, { subject: principalId, role: LoopOrchestrator.ViewerRole, resourceKind: LoopOrchestrator.TenantKind, resourcePath: [] })
        }
        return { email, password }
    }

    public static async Main(argv: readonly string[]): Promise<void>
    {
        const parsed = LoopOrchestrator.ParseCommand(argv)
        const logger = new StderrLoopLogger()
        const composition = LoopStackComposition.FromStack(LiveLoopStack.ReadDescriptor(parsed.stack))
        const orchestrator = new LoopOrchestrator(composition.envs, composition.graphs, logger, composition.database, composition.reach)
        for (const secret of composition.Secrets())
        {
            orchestrator.HoldSecret(secret)
        }
        try
        {
            console.log(JSON.stringify(await orchestrator.Run(parsed)))
        }
        catch (err)
        {
            orchestrator.ReportFailure(err)
            throw new LoopFailure()
        }
        finally
        {
            await composition.Close()
        }
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
    }
}

if (LoopOrchestrator.IsEntryPoint())
{
    try
    {
        await LoopOrchestrator.Main(process.argv.slice(2))
        process.exit(0)
    }
    catch (err)
    {
        // Invariant: only ParseCommand/composition errors (no generated secrets yet) reach here unredacted.
        // Secret-bearing failures go through ReportFailure -> Redact and throw a LoopFailure, which is not re-logged.
        if (!(err instanceof LoopFailure))
        {
            new StderrLoopLogger().Log(err instanceof Error ? err.message : String(err))
        }
        process.exit(1)
    }
}
