import type { GraphDetailDto, GraphLoadedDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AdminProxyError, type IAdminAccess, type IAdminProxy } from './admin-proxy.js'
import { GraphErrorCode } from './graph-error-code.js'
import { EnvType, type EnvironmentRecord } from './environment-record.js'
import { EnvironmentNotDevelopmentError, EnvironmentNotFoundError, EnvironmentNotRuntimeError } from './environment-service.js'
import type { GraphDto, PromotionResultDto } from './control-plane-host.js'

export interface IEnvironmentLookup
{
    Get(name: string): EnvironmentRecord | undefined
}

export class GraphExistsError extends Error
{
    private static readonly ErrorName = 'GraphExistsError'
    private static readonly MessagePrefix = 'Graph already exists: '

    public constructor(graphName: string)
    {
        super(GraphExistsError.MessagePrefix + graphName)
        this.name = GraphExistsError.ErrorName
    }
}

export class GraphNotFoundError extends Error
{
    private static readonly ErrorName = 'GraphNotFoundError'
    private static readonly MessagePrefix = 'Graph not found: '

    public constructor(graphName: string)
    {
        super(GraphNotFoundError.MessagePrefix + graphName)
        this.name = GraphNotFoundError.ErrorName
    }
}

export class GraphNameInvalidError extends Error
{
    private static readonly ErrorName = 'GraphNameInvalidError'
    private static readonly MessagePrefix = 'Invalid graph name: '

    public constructor(graphName: string)
    {
        super(GraphNameInvalidError.MessagePrefix + graphName)
        this.name = GraphNameInvalidError.ErrorName
    }
}

export class GraphService
{
    public constructor(
        private readonly environments: IEnvironmentLookup,
        private readonly proxy: IAdminProxy,
        private readonly admin: IAdminAccess)
    {
    }

    public async Create(envName: string, name: string, description: string): Promise<GraphDto>
    {
        this.Require(envName)
        const summary = await this.admin.WithAdmin(envName, info => GraphService.Classify(name, () => this.proxy.CreateGraph(info, { graphName: name, description })))
        return GraphService.FromSummary(summary)
    }

    public async List(envName: string): Promise<GraphDto[]>
    {
        this.Require(envName)
        const summaries = await this.admin.WithAdmin(envName, info => this.proxy.ListGraphs(info))
        return summaries.map(s => GraphService.FromSummary(s))
    }

    public async Get(envName: string, graphName: string): Promise<GraphDto>
    {
        this.Require(envName)
        const detail = await this.admin.WithAdmin(envName, info => GraphService.Classify(graphName, () => this.proxy.GetGraph(info, { graphName })))
        return GraphService.FromDetail(detail)
    }

    public async Delete(envName: string, graphName: string): Promise<void>
    {
        this.Require(envName)
        await this.admin.WithAdmin(envName, info => GraphService.Classify(graphName, () => this.proxy.DeleteGraph(info, { graphName })))
    }

    /** Relays a dev-environment graph into a runtime environment: read the packages out of the source (as its Owner), write them into the target (as its Owner). The two containers never touch. */
    public async Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        // Both env-type gates run before any proxy call, so a wrong type never opens a container connection.
        this.Require(sourceEnv)
        this.RequireRuntime(targetEnv)
        // Both environments stay leased for the whole relay: a long export/load can never lose its tunnel mid-call.
        const loaded = await this.admin.WithAdmin(sourceEnv, sourceInfo => this.admin.WithAdmin(targetEnv, async targetInfo =>
        {
            const exported = await GraphService.Classify(graphName, () => this.proxy.ExportGraph(sourceInfo, { graphName }))
            return this.proxy.LoadGraph(targetInfo, { graphName, packages: exported.packages })
        }))
        return { graphName: loaded.name, packageCount: loaded.packages.length, targetEnv }
    }

    public async GetLoaded(runtimeEnv: string): Promise<GraphLoadedDto | null>
    {
        this.RequireRuntime(runtimeEnv)
        return this.admin.WithAdmin(runtimeEnv, info => this.proxy.GetLoadedGraph(info))
    }

    private Require(envName: string): EnvironmentRecord
    {
        const record = this.environments.Get(envName)
        if (!record)
        {
            throw new EnvironmentNotFoundError(envName)
        }
        if (record.type !== EnvType.Development)
        {
            throw new EnvironmentNotDevelopmentError(envName)
        }
        return record
    }

    private RequireRuntime(envName: string): EnvironmentRecord
    {
        const record = this.environments.Get(envName)
        if (!record)
        {
            throw new EnvironmentNotFoundError(envName)
        }
        if (record.type !== EnvType.Runtime)
        {
            throw new EnvironmentNotRuntimeError(envName)
        }
        return record
    }

    /** Maps the container's graph error codes back onto the graph error classes; anything else passes through. */
    private static async Classify<T>(graphName: string, call: () => Promise<T>): Promise<T>
    {
        try
        {
            return await call()
        }
        catch (err)
        {
            switch (err instanceof AdminProxyError ? err.Code : undefined)
            {
                case GraphErrorCode.NameInvalid:
                    throw new GraphNameInvalidError(graphName)
                case GraphErrorCode.Exists:
                    throw new GraphExistsError(graphName)
                case GraphErrorCode.NotFound:
                    throw new GraphNotFoundError(graphName)
                default:
                    throw err
            }
        }
    }

    private static FromSummary(s: GraphSummaryDto): GraphDto
    {
        return { name: s.name, description: s.description, packageCount: s.packageCount, createdAt: s.createdAt }
    }

    private static FromDetail(d: GraphDetailDto): GraphDto
    {
        return { name: d.name, description: d.description, packageCount: d.packages.length, createdAt: d.createdAt }
    }
}
