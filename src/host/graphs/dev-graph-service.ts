import type { GraphCreateParamsDto, GraphDetailDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { DevGraphRecord, DevGraphStore, PackageRef } from './dev-graph-store.js'

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

export interface IDevGraphService
{
    CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>
    ListGraphs(): Promise<GraphSummaryDto[]>
    GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>
    DeleteGraph(params: GraphRefParamsDto): Promise<void>
}

/** Container-owned graph catalog: create/list/get/delete over the DevGraphStore. */
export class DevGraphService implements IDevGraphService
{
    private static readonly KeySeparator = '@'
    private static readonly GraphNamePattern = /^[a-z0-9][a-z0-9-]*$/

    public constructor(private readonly store: DevGraphStore)
    {
    }

    public async CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>
    {
        DevGraphService.SanitizeGraphName(params.graphName)
        await this.store.Load()
        if (this.store.Get(params.graphName) !== undefined)
        {
            throw new GraphExistsError(params.graphName)
        }
        const record: DevGraphRecord = { name: params.graphName, description: params.description, slices: {}, createdAt: new Date().toISOString() }
        await this.store.Put(record)
        return DevGraphService.ToSummary(record)
    }

    public async ListGraphs(): Promise<GraphSummaryDto[]>
    {
        await this.store.Load()
        return this.store.List().map(r => DevGraphService.ToSummary(r))
    }

    public async GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>
    {
        await this.store.Load()
        const record = this.store.Get(params.graphName)
        if (record === undefined)
        {
            throw new GraphNotFoundError(params.graphName)
        }
        return DevGraphService.ToDetail(record)
    }

    public async DeleteGraph(params: GraphRefParamsDto): Promise<void>
    {
        await this.store.Load()
        if (this.store.Get(params.graphName) === undefined)
        {
            throw new GraphNotFoundError(params.graphName)
        }
        await this.store.Remove(params.graphName)
    }

    private static SanitizeGraphName(name: string): void
    {
        if (!DevGraphService.GraphNamePattern.test(name))
        {
            throw new GraphNameInvalidError(name)
        }
    }

    private static EffectivePackages(record: DevGraphRecord): PackageRef[]
    {
        const seen = new Set<string>()
        const result: PackageRef[] = []
        for (const refs of Object.values(record.slices))
        {
            for (const ref of refs)
            {
                const key = ref.id + DevGraphService.KeySeparator + ref.version
                if (seen.has(key)) continue
                seen.add(key)
                result.push({ id: ref.id, version: ref.version })
            }
        }
        return result
    }

    private static ToSummary(r: DevGraphRecord): GraphSummaryDto
    {
        return { name: r.name, description: r.description, packageCount: DevGraphService.EffectivePackages(r).length, createdAt: r.createdAt }
    }

    private static ToDetail(r: DevGraphRecord): GraphDetailDto
    {
        return { name: r.name, description: r.description, packages: DevGraphService.EffectivePackages(r), createdAt: r.createdAt }
    }
}
