/**
 * In-process orchestrator for the runtime-publishing live-loop e2e (admin side).
 *
 * Composes the control-plane services in-process (as control-plane-smoke.ts does) and exposes three
 * subcommands, each printing ONE JSON descriptor to stdout. Environments live in Docker and the registry
 * file under --data-root, so separate invocations share state. The descriptor is the only channel for
 * tokens and passwords: nothing secret is ever passed to the logger (stderr).
 *
 *   npx tsx admin/control-plane/loop-orchestrator.ts create-dev --data-root <dir>
 *   npx tsx admin/control-plane/loop-orchestrator.ts create-runtime --data-root <dir>
 *   npx tsx admin/control-plane/loop-orchestrator.ts promote --data-root <dir> --graph <g>
 *   npx tsx admin/control-plane/loop-orchestrator.ts teardown --data-root <dir>
 *   npx tsx admin/control-plane/loop-orchestrator.ts db-exec --data-root <dir> --sql <sql>
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { CreateAccountParams, GrantMutationDto, TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EnvDatabase } from '../../environments/seed/bundle.js'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import type { AdminConnectInfo } from './admin-proxy.js'
import type { GraphDto, PromotionResultDto } from './control-plane-host.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { ClientRegistry } from './client-registry.js'
import { TenantRegistry } from './tenant-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { EnvironmentNotFoundError, EnvironmentService } from './environment-service.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpRegistry } from './idp-registry.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { IdpService } from './idp-service.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { GraphService } from './graph-service.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'

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
    dataRoot: string
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
    dataRoot: string
    devEnv: string
    devWsUrl: string
    graphName: string
    makerToken: string
}

/** Output of create-runtime (no promotion): the cross-task JSON contract consumed by the e2e (keys are fixed). */
export interface RuntimeDescriptor
{
    runtimeEnv: string
    tenant: string
    runtimeWsUrl: string
    runtimeHostPort: number
    appOriginBase: string
    deployToken: string
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

/** The slice of the environment service the orchestrator needs. */
export interface ILoopEnvironments
{
    Create(name: string, template: Template, type: EnvType, hostPort?: number): Promise<EnvironmentRecord>
    Delete(name: string): Promise<void>
    AdminInfoFor(name: string): Promise<AdminConnectInfo>
    AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>
    AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
}

export interface ILoopGraphs
{
    Create(envName: string, name: string, description: string): Promise<GraphDto>
    Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
}

export interface ILoopLogin
{
    Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
}

/** Runs SQL against an environment's provisioned Postgres; returns the affected-row count of the last statement. */
export interface ILoopDatabase
{
    /** The database password, so the caller can redact it from any failure output. */
    PasswordFor(env: string): Promise<string>
    Exec(env: string, sql: string): Promise<number>
}

/** The slice of the environment service the database executor needs. */
export interface ILoopDatabaseSource
{
    DatabaseInfoFor(name: string): Promise<EnvDatabase>
}

/** Executes SQL over the host-published DB port (this process runs on the host, not on the docker network). */
export class PgLoopDatabase implements ILoopDatabase
{
    private static readonly HostLoopback = '127.0.0.1'

    public constructor(private readonly source: ILoopDatabaseSource)
    {
    }

    public async PasswordFor(env: string): Promise<string>
    {
        return (await this.source.DatabaseInfoFor(env)).password
    }

    public async Exec(env: string, sql: string): Promise<number>
    {
        const db = await this.source.DatabaseInfoFor(env)
        const client = new pg.Client({ host: PgLoopDatabase.HostLoopback, port: db.hostPort, database: db.database, user: db.user, password: db.password })
        await client.connect()
        try
        {
            const result = await client.query(sql)
            const last = Array.isArray(result) ? result[result.length - 1] : result
            return last?.rowCount ?? 0
        }
        finally
        {
            await client.end()
        }
    }
}

export class StderrLoopLogger implements ILoopLogger
{
    public Log(message: string): void
    {
        process.stderr.write(message + '\n')
    }
}

export class SeederLoopLogin implements ILoopLogin
{
    private readonly seeder = new UserSeeder()

    public Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
    {
        return this.seeder.Login(baseHttpUrl, tenant, email, password)
    }
}

/** Marks a failure already reported (redacted) to the logger. */
export class LoopFailure extends Error
{
}

export class LoopOrchestrator
{
    private static readonly EnvPortFloor = 8100
    private static readonly IdpPortFloor = 12100
    private static readonly IdpsFile = 'idps.json'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly StaticDir = 'static'
    private static readonly DataRootFlag = '--data-root'
    private static readonly GraphFlag = '--graph'
    private static readonly SqlFlag = '--sql'
    private static readonly FlagPrefix = '--'
    private static readonly DevEnvName = 'loop-dev'
    private static readonly RuntimeEnvName = 'loop-rt'
    private static readonly DefaultGraphName = 'loop-graph'
    private static readonly GraphDescription = 'live-loop e2e graph'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsEnvironmentQuery = '/?environment='
    private static readonly ViewerRole = 'Viewer'
    private static readonly TenantKind = 'Tenant'
    private static readonly ReaderPrincipal = 'loop-reader'
    private static readonly ReaderEmail = 'loop-reader@contoso.test'
    private static readonly UngrantedPrincipal = 'loop-ungranted'
    private static readonly UngrantedEmail = 'loop-ungranted@contoso.test'
    private static readonly PasswordBytes = 18
    private static readonly PasswordEncoding = 'base64url'
    private static readonly MsgCreatingDev = 'creating development environment'
    private static readonly MsgCreatingRuntime = 'creating runtime environment'
    private static readonly MsgPromoting = 'promoting graph to runtime environment'
    private static readonly MsgProvisioning = 'provisioning reader and ungranted accounts'
    private static readonly UsageMessage = 'usage: loop-orchestrator <create-dev|create-runtime|promote|teardown|db-exec> --data-root <dir> [--graph <name>] [--sql <sql>] (--graph is required for promote, --sql for db-exec)'
    private static readonly MissingDataRoot = 'missing --data-root'
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
    private static readonly UnhandledCommand = 'unhandled command: '

    private readonly secrets = new Set<string>()

    public constructor(
        private readonly envs: ILoopEnvironments,
        private readonly graphs: ILoopGraphs,
        private readonly login: ILoopLogin,
        private readonly logger: ILoopLogger,
        private readonly dataRoot: string,
        private readonly database: ILoopDatabase)
    {
    }

    /** Parses argv (already stripped of node and script path) into a command; throws a usage error otherwise. */
    public static ParseCommand(argv: readonly string[]): ParsedLoopCommand
    {
        const verb = argv[0]
        const command = Object.values(LoopCommand).find(c => c === verb)
        if (command === undefined)
        {
            throw new Error(LoopOrchestrator.UnknownCommand + String(verb) + LoopOrchestrator.UsageSep + LoopOrchestrator.UsageMessage)
        }
        const dataRoot = LoopOrchestrator.FlagValue(argv, LoopOrchestrator.DataRootFlag)
        if (dataRoot === undefined)
        {
            throw new Error(LoopOrchestrator.MissingDataRoot + LoopOrchestrator.UsageSep + LoopOrchestrator.UsageMessage)
        }
        const graph = LoopOrchestrator.FlagValue(argv, LoopOrchestrator.GraphFlag)
        if (command === LoopCommand.Promote && graph === undefined)
        {
            throw new Error(LoopOrchestrator.MissingGraph + LoopOrchestrator.UsageSep + LoopOrchestrator.UsageMessage)
        }
        const sql = LoopOrchestrator.FlagValue(argv, LoopOrchestrator.SqlFlag)
        if (command === LoopCommand.DbExec && sql === undefined)
        {
            throw new Error(LoopOrchestrator.MissingSql + LoopOrchestrator.UsageSep + LoopOrchestrator.UsageMessage)
        }
        const parsed: ParsedLoopCommand = { command, dataRoot }
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

    /** Wires the real control-plane services over Docker and the registry under dataRoot. */
    public static async Compose(dataRoot: string, logger: ILoopLogger): Promise<LoopOrchestrator>
    {
        mkdirSync(join(dataRoot, LoopOrchestrator.StaticDir), { recursive: true })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, LoopOrchestrator.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dataRoot, LoopOrchestrator.ClientsFile)),
            new TenantRegistry(join(dataRoot, LoopOrchestrator.TenantsFile)),
            new HiveRegistry(join(dataRoot, LoopOrchestrator.HivesFile)),
            registry)
        await directory.Load()
        const allocator = new PortAllocator(LoopOrchestrator.EnvPortFloor, new NetPortProbe())
        const proxy = new AdminProxy(new WsAdminConnector())
        const idpService = new IdpService(new IdpRegistry(join(dataRoot, LoopOrchestrator.IdpsFile)), new DockerIdpDriver(new PortAllocator(LoopOrchestrator.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), dataRoot, DockerEnv.ImageName))
        const service = new EnvironmentService(registry, allocator, new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new UserSeederAdapter(new UserSeeder()), dataRoot, proxy, directory, idpService, conn => new IdpAdminClient(conn))
        const graphs = new GraphService(registry, proxy, name => service.AdminInfoFor(name))
        return new LoopOrchestrator(service, graphs, new SeederLoopLogin(), logger, dataRoot, new PgLoopDatabase(service))
    }

    public async CreateDev(graphName: string = LoopOrchestrator.DefaultGraphName): Promise<DevDescriptor>
    {
        const name = LoopOrchestrator.DevEnvName
        this.logger.Log(LoopOrchestrator.MsgCreatingDev)
        const rec = LoopOrchestrator.RequireRunning(await this.envs.Create(name, Template.DevBlank, EnvType.Development))
        await this.graphs.Create(name, graphName, LoopOrchestrator.GraphDescription)
        const minted = await this.envs.AdminIssueMakerToken(name)
        this.secrets.add(minted.token)
        return {
            dataRoot: this.dataRoot,
            devEnv: name,
            devWsUrl: LoopOrchestrator.WsPrefix + String(rec.hostPort) + LoopOrchestrator.WsEnvironmentQuery + rec.environmentId,
            graphName,
            makerToken: minted.token
        }
    }

    public async CreateRuntime(): Promise<RuntimeDescriptor>
    {
        const name = LoopOrchestrator.RuntimeEnvName
        this.logger.Log(LoopOrchestrator.MsgCreatingRuntime)
        const rec = LoopOrchestrator.RequireRunning(await this.envs.Create(name, Template.RuntimePostgres, EnvType.Runtime))
        // AdminInfoFor reads the env's provisioned-secrets.json (`<tenant>-admin-pw`) into connect info.
        const info = await this.envs.AdminInfoFor(name)
        this.secrets.add(info.password)
        const deployToken = await this.login.Login(info.httpUrl, rec.environmentId, info.email, info.password)
        this.secrets.add(deployToken)
        this.logger.Log(LoopOrchestrator.MsgProvisioning)
        const reader = await this.Provision(name, LoopOrchestrator.ReaderPrincipal, LoopOrchestrator.ReaderEmail, true)
        const ungranted = await this.Provision(name, LoopOrchestrator.UngrantedPrincipal, LoopOrchestrator.UngrantedEmail, false)
        const port = String(rec.hostPort)
        return {
            runtimeEnv: name,
            tenant: rec.environmentId,
            runtimeWsUrl: LoopOrchestrator.WsPrefix + port + LoopOrchestrator.WsEnvironmentQuery + rec.environmentId,
            runtimeHostPort: rec.hostPort as number,
            appOriginBase: LoopOrchestrator.HttpPrefix + port,
            deployToken,
            reader,
            ungranted
        }
    }

    /** Promotes a dev graph into the EXISTING runtime env (never creates it); re-runnable: each call replaces the promoted content. */
    public async Promote(graphName: string): Promise<PromoteDescriptor>
    {
        this.logger.Log(LoopOrchestrator.MsgPromoting)
        const result = await this.graphs.Promote(LoopOrchestrator.DevEnvName, graphName, LoopOrchestrator.RuntimeEnvName)
        return { graphName: result.graphName, packageCount: result.packageCount, targetEnv: result.targetEnv }
    }

    /** Runs the SQL against the runtime env's provisioned Postgres. The statement text is never logged. */
    public async DbExec(sql: string): Promise<DbExecDescriptor>
    {
        this.logger.Log(LoopOrchestrator.MsgDbExec)
        this.secrets.add(await this.database.PasswordFor(LoopOrchestrator.RuntimeEnvName))
        const rowCount = await this.database.Exec(LoopOrchestrator.RuntimeEnvName, sql)
        return { ok: true, rowCount }
    }

    /** Idempotent: removes whichever of the loop environments exist; an absent one is ignored. */
    public async Teardown(): Promise<TeardownDescriptor>
    {
        for (const name of [LoopOrchestrator.DevEnvName, LoopOrchestrator.RuntimeEnvName])
        {
            this.logger.Log(LoopOrchestrator.MsgTearingDownPrefix + name)
            try
            {
                await this.envs.Delete(name)
            }
            catch (err)
            {
                if (!(err instanceof EnvironmentNotFoundError))
                {
                    throw err
                }
            }
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

    /** EnvironmentService.Create returns only after the container is healthy (WaitHealthy, environment-service.ts), so Running is already guaranteed; this guards that contract. */
    private static RequireRunning(rec: EnvironmentRecord): EnvironmentRecord
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
        const orchestrator = await LoopOrchestrator.Compose(parsed.dataRoot, logger)
        try
        {
            console.log(JSON.stringify(await orchestrator.Run(parsed)))
        }
        catch (err)
        {
            orchestrator.ReportFailure(err)
            throw new LoopFailure()
        }
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
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
        // Invariant: only ParseCommand/Compose errors (no secrets held yet) reach here unredacted.
        // Secret-bearing failures go through ReportFailure -> Redact and throw a LoopFailure, which is not re-logged.
        if (!(err instanceof LoopFailure))
        {
            new StderrLoopLogger().Log(err instanceof Error ? err.message : String(err))
        }
        process.exit(1)
    }
}
