import type { GraphContributeParamsDto, GraphExportDto, GraphCreateParamsDto, GraphDetailDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { GraphPackageIngest } from './graph-package-ingest.js'
import type { GraphPackageReader } from './graph-package-reader.js'
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
    ContributeGraph(params: GraphContributeParamsDto): Promise<GraphDetailDto>
    ExportGraph(params: GraphRefParamsDto): Promise<GraphExportDto>
}

/** Container-owned graph catalog: create/list/get/delete over the DevGraphStore. */
export class DevGraphService implements IDevGraphService
{
    private static readonly KeySeparator = '\u0000'
    private static readonly GraphNamePattern = /^[a-z0-9][a-z0-9-]*$/

    public constructor(private readonly store: DevGraphStore, private readonly ingest: GraphPackageIngest, private readonly reader: GraphPackageReader)
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

    /** Replaces one solution's slice. Package bytes are ingested first so a Conflict leaves the manifest untouched.
     *  Unlocked Load/Get/Store/Put: concurrent contributes to one graph are last-writer-wins (single-maker dev-env posture; hardening deferred). */
    public async ContributeGraph(params: GraphContributeParamsDto): Promise<GraphDetailDto>
    {
        await this.store.Load()
        const record = this.store.Get(params.graphName)
        if (record === undefined)
        {
            throw new GraphNotFoundError(params.graphName)
        }
        await this.ingest.Store(params.packages)
        record.slices[params.solutionId] = params.packages.map(p => ({ id: p.id, version: p.version }))
        await this.store.Put(record)
        return DevGraphService.ToDetail(record)
    }

    /** Dev-side export: the graph's effective (deduped) packages with their compiled model.json content. */
    public async ExportGraph(params: GraphRefParamsDto): Promise<GraphExportDto>
    {
        await this.store.Load()
        const record = this.store.Get(params.graphName)
        if (record === undefined)
        {
            throw new GraphNotFoundError(params.graphName)
        }
        const packages = await this.reader.ReadAll(DevGraphService.EffectivePackages(record))
        return { name: record.name, packages }
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
