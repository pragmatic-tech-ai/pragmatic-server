import type { GraphDetailDto, GraphLoadedDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AdminProxyError, AdminProxyErrorKind, type AdminConnectInfo, type IAdminProxy } from './admin-proxy.js'
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
    // Must track the messages thrown in src/host/graphs/dev-graph-service.ts.
    private static readonly ExistsText = 'already exists'
    private static readonly NotFoundText = 'not found'
    private static readonly InvalidNameText = 'invalid graph name'

    public constructor(
        private readonly environments: IEnvironmentLookup,
        private readonly proxy: IAdminProxy,
        private readonly adminInfoFor: (name: string) => Promise<AdminConnectInfo>)
    {
    }

    public async Create(envName: string, name: string, description: string): Promise<GraphDto>
    {
        const info = await this.InfoFor(envName)
        const summary = await GraphService.Classify(name, () => this.proxy.CreateGraph(info, { graphName: name, description }))
        return GraphService.FromSummary(summary)
    }

    public async List(envName: string): Promise<GraphDto[]>
    {
        const info = await this.InfoFor(envName)
        const summaries = await this.proxy.ListGraphs(info)
        return summaries.map(s => GraphService.FromSummary(s))
    }

    public async Get(envName: string, graphName: string): Promise<GraphDto>
    {
        const info = await this.InfoFor(envName)
        const detail = await GraphService.Classify(graphName, () => this.proxy.GetGraph(info, { graphName }))
        return GraphService.FromDetail(detail)
    }

    public async Delete(envName: string, graphName: string): Promise<void>
    {
        const info = await this.InfoFor(envName)
        await GraphService.Classify(graphName, () => this.proxy.DeleteGraph(info, { graphName }))
    }

    /** Relays a dev-environment graph into a runtime environment: read the packages out of the source (as its Owner), write them into the target (as its Owner). The two containers never touch. */
    public async Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        // Both env-type gates run before any proxy call, so a wrong type never opens a container connection.
        const sourceInfo = await this.InfoFor(sourceEnv)
        const targetInfo = await this.RuntimeInfoFor(targetEnv)
        const exported = await GraphService.Classify(graphName, () => this.proxy.ExportGraph(sourceInfo, { graphName }))
        const loaded = await this.proxy.LoadGraph(targetInfo, { graphName, packages: exported.packages })
        return { graphName: loaded.name, packageCount: loaded.packages.length, targetEnv }
    }

    public async GetLoaded(runtimeEnv: string): Promise<GraphLoadedDto | null>
    {
        const info = await this.RuntimeInfoFor(runtimeEnv)
        return this.proxy.GetLoadedGraph(info)
    }

    private async InfoFor(envName: string): Promise<AdminConnectInfo>
    {
        this.Require(envName)
        return this.adminInfoFor(envName)
    }

    private async RuntimeInfoFor(envName: string): Promise<AdminConnectInfo>
    {
        this.RequireRuntime(envName)
        return this.adminInfoFor(envName)
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

    /** Maps the container's graph failure messages (Protocol-kind proxy errors only) back onto the graph error classes; anything else passes through. */
    private static async Classify<T>(graphName: string, call: () => Promise<T>): Promise<T>
    {
        try
        {
            return await call()
        }
        catch (err)
        {
            if (!(err instanceof AdminProxyError) || err.Kind !== AdminProxyErrorKind.Protocol)
            {
                throw err
            }
            const lower = err.message.toLowerCase()
            if (lower.includes(GraphService.InvalidNameText))
            {
                throw new GraphNameInvalidError(graphName)
            }
            if (lower.includes(GraphService.ExistsText))
            {
                throw new GraphExistsError(graphName)
            }
            if (lower.includes(GraphService.NotFoundText))
            {
                throw new GraphNotFoundError(graphName)
            }
            throw err
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
