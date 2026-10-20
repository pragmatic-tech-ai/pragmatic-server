/**
 * In-process orchestrator for the runtime-publishing live-loop e2e (admin side).
 *
 * Composes the control-plane services in-process (as control-plane-smoke.ts does) and exposes three
 * subcommands, each printing ONE JSON descriptor to stdout. Environments live in Docker and the registry
 * file under --data-root, so separate invocations share state. The descriptor is the only channel for
 * tokens and passwords: nothing secret is ever passed to the logger (stderr).
 *
 *   npx tsx admin/control-plane/loop-orchestrator.ts create-dev --data-root <dir>
 *   npx tsx admin/control-plane/loop-orchestrator.ts promote-and-provision --data-root <dir> --graph <g>
 *   npx tsx admin/control-plane/loop-orchestrator.ts teardown --data-root <dir>
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CreateAccountParams, GrantMutationDto, TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import type { AdminConnectInfo } from './admin-proxy.js'
import type { GraphDto, PromotionResultDto } from './control-plane-host.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { GraphService } from './graph-service.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'

export enum LoopCommand
{
    CreateDev = 'create-dev',
    PromoteAndProvision = 'promote-and-provision',
    Teardown = 'teardown'
}

export interface ParsedLoopCommand
{
    command: LoopCommand
    dataRoot: string
    graph?: string
}

export interface CredentialDescriptor
{
    email: string
    password: string
}

/** The cross-task JSON contract consumed by the e2e: keys are fixed. Each subcommand fills its own subset. */
export interface LoopDescriptor
{
    dataRoot?: string
    devEnv?: string
    devWsUrl?: string
    graphName?: string
    makerToken?: string
    runtimeEnv?: string
    tenant?: string
    runtimeWsUrl?: string
    runtimeHostPort?: number
    appOriginBase?: string
    deployToken?: string
    reader?: CredentialDescriptor
    ungranted?: CredentialDescriptor
    ok?: boolean
}

export interface ILoopLogger
{
    Log(message: string): void
}

/** The slice of the environment service the orchestrator needs. */
export interface ILoopEnvironments
{
    Create(name: string, template: Template, type: EnvType, hostPort?: number): Promise<EnvironmentRecord>
    Delete(name: string): Promise<void>
    List(): readonly EnvironmentRecord[]
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

export class LoopOrchestrator
{
    private static readonly EnvPortFloor = 8100
    private static readonly RegistryFile = 'registry.json'
    private static readonly StaticDir = 'static'
    private static readonly DataRootFlag = '--data-root'
    private static readonly GraphFlag = '--graph'
    private static readonly FlagPrefix = '--'
    private static readonly DevEnvName = 'loop-dev'
    private static readonly RuntimeEnvName = 'loop-rt'
    private static readonly DefaultGraphName = 'loop-graph'
    private static readonly GraphDescription = 'live-loop e2e graph'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsTenantQuery = '/?tenant='
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
    private static readonly MsgTearingDown = 'tearing down environment'
    private static readonly UsageMessage = 'usage: loop-orchestrator <create-dev|promote-and-provision|teardown> --data-root <dir> [--graph <name>]'
    private static readonly MissingDataRoot = 'missing --data-root'
    private static readonly MissingValue = 'missing value for '
    private static readonly UnknownCommand = 'unknown command: '
    private static readonly UsageSep = '; '
    private static readonly NewLine = '\n'

    public constructor(
        private readonly envs: ILoopEnvironments,
        private readonly graphs: ILoopGraphs,
        private readonly login: ILoopLogin,
        private readonly logger: ILoopLogger,
        private readonly dataRoot: string)
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
        return graph === undefined ? { command, dataRoot } : { command, dataRoot, graph }
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
        const allocator = new PortAllocator(LoopOrchestrator.EnvPortFloor, new NetPortProbe())
        const proxy = new AdminProxy(new WsAdminConnector())
        const service = new EnvironmentService(registry, allocator, docker, new BundleBuilderAdapter(), new UserSeederAdapter(new UserSeeder()), dataRoot, proxy)
        const graphs = new GraphService(registry, proxy, name => service.AdminInfoFor(name))
        return new LoopOrchestrator(service, graphs, new SeederLoopLogin(), logger, dataRoot)
    }

    public async CreateDev(graphName: string = LoopOrchestrator.DefaultGraphName): Promise<LoopDescriptor>
    {
        const name = LoopOrchestrator.DevEnvName
        this.logger.Log(LoopOrchestrator.MsgCreatingDev)
        const rec = await this.envs.Create(name, Template.DevBlank, EnvType.Development)
        await this.graphs.Create(name, graphName, LoopOrchestrator.GraphDescription)
        const minted = await this.envs.AdminIssueMakerToken(name)
        return {
            dataRoot: this.dataRoot,
            devEnv: name,
            devWsUrl: LoopOrchestrator.WsPrefix + String(rec.hostPort) + LoopOrchestrator.WsTenantQuery + rec.tenantId,
            graphName,
            makerToken: minted.token
        }
    }

    public async PromoteAndProvision(graphName: string = LoopOrchestrator.DefaultGraphName): Promise<LoopDescriptor>
    {
        const name = LoopOrchestrator.RuntimeEnvName
        this.logger.Log(LoopOrchestrator.MsgCreatingRuntime)
        const rec = await this.envs.Create(name, Template.DemoContoso, EnvType.Runtime)
        this.logger.Log(LoopOrchestrator.MsgPromoting)
        await this.graphs.Promote(LoopOrchestrator.DevEnvName, graphName, name)
        // AdminInfoFor reads the env's provisioned-secrets.json (`<tenant>-admin-pw`) into connect info.
        const info = await this.envs.AdminInfoFor(name)
        const deployToken = await this.login.Login(info.httpUrl, rec.tenantId, info.email, info.password)
        this.logger.Log(LoopOrchestrator.MsgProvisioning)
        const reader = await this.Provision(name, LoopOrchestrator.ReaderPrincipal, LoopOrchestrator.ReaderEmail, true)
        const ungranted = await this.Provision(name, LoopOrchestrator.UngrantedPrincipal, LoopOrchestrator.UngrantedEmail, false)
        const port = String(rec.hostPort)
        return {
            runtimeEnv: name,
            tenant: rec.tenantId,
            runtimeWsUrl: LoopOrchestrator.WsPrefix + port + LoopOrchestrator.WsTenantQuery + rec.tenantId,
            runtimeHostPort: rec.hostPort,
            appOriginBase: LoopOrchestrator.HttpPrefix + port,
            deployToken,
            reader,
            ungranted
        }
    }

    public async Teardown(): Promise<LoopDescriptor>
    {
        for (const name of [LoopOrchestrator.DevEnvName, LoopOrchestrator.RuntimeEnvName])
        {
            if (this.envs.List().some(e => e.name === name))
            {
                this.logger.Log(LoopOrchestrator.MsgTearingDown)
                await this.envs.Delete(name)
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
            case LoopCommand.PromoteAndProvision:
                return this.PromoteAndProvision(parsed.graph)
            default:
                return this.Teardown()
        }
    }

    private async Provision(env: string, principalId: string, email: string, grantViewer: boolean): Promise<CredentialDescriptor>
    {
        const password = randomBytes(LoopOrchestrator.PasswordBytes).toString(LoopOrchestrator.PasswordEncoding)
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
        const orchestrator = await LoopOrchestrator.Compose(parsed.dataRoot, new StderrLoopLogger())
        console.log(JSON.stringify(await orchestrator.Run(parsed)))
    }

    /** Prints a failure message (never a descriptor or secret) to stderr. */
    public static ReportFailure(err: unknown): void
    {
        process.stderr.write((err instanceof Error ? err.message : String(err)) + LoopOrchestrator.NewLine)
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
        LoopOrchestrator.ReportFailure(err)
        process.exit(1)
    }
}
