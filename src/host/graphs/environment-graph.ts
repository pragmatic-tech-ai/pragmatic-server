import { randomUUID } from 'node:crypto'
import type { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { GraphLoadParamsDto, GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { RuntimeAppGraph } from '../cypher/runtime-app-graph.js'
import type { PackageRef } from './dev-graph-store.js'

/** The runtime-side load/loaded seam a runtime tenant exposes; the handler reaches it without knowing the server type. */
export interface IEnvironmentGraphHost
{
    LoadEnvironmentGraph(params: GraphLoadParamsDto): Promise<GraphLoadedDto>
    LoadedGraph(): Promise<GraphLoadedDto | null>
    EnvironmentGraphQuery(): Promise<IGraphQuery>
}

/** Thrown when a query is requested while no environment graph is loaded. */
export class NoEnvironmentGraphError extends Error
{
    private static readonly ErrorName = 'NoEnvironmentGraphError'
    private static readonly NoGraphMessage = 'no environment graph is loaded on this runtime tenant'

    public constructor()
    {
        super(NoEnvironmentGraphError.NoGraphMessage)
        this.name = NoEnvironmentGraphError.ErrorName
    }
}

/** The single live environment-graph instance: the composed query plus its loaded-manifest record (refs only, no content). */
export class EnvironmentGraph
{
    private readonly query: IGraphQuery
    private readonly record: GraphLoadedDto

    private constructor(query: IGraphQuery, record: GraphLoadedDto)
    {
        this.query = query
        this.record = record
    }

    public static async Build(source: StoragePackageSource, graphName: string, refs: readonly PackageRef[]): Promise<EnvironmentGraph>
    {
        const query = await RuntimeAppGraph.BuildQueryFromPackages(source, refs)
        const record: GraphLoadedDto = { name: graphName, packages: EnvironmentGraph.CopyRefs(refs), promotedAt: new Date().toISOString() }
        return new EnvironmentGraph(query, record)
    }

    public Query(): IGraphQuery
    {
        return this.query
    }

    public Record(): GraphLoadedDto
    {
        return { name: this.record.name, packages: EnvironmentGraph.CopyRefs(this.record.packages), promotedAt: this.record.promotedAt }
    }

    private static CopyRefs(refs: readonly PackageRef[]): { id: string; version: string }[]
    {
        return refs.map(r => ({ id: r.id, version: r.version }))
    }
}

/** Persists the loaded-manifest record to the graphs volume so `graph/loaded` survives a restart; replace-on-promote overwrites it. */
export class LoadedGraphStore
{
    private static readonly FileName = 'loaded-graph.json'
    private static readonly TempPrefix = '.loaded-graph-'
    private static readonly TempSuffix = '.tmp'

    public constructor(private readonly storage: IStorage)
    {
    }

    public async Save(record: GraphLoadedDto): Promise<void>
    {
        const temp = LoadedGraphStore.TempPrefix + randomUUID() + LoadedGraphStore.TempSuffix
        await this.storage.WriteText(temp, JSON.stringify(record, null, 2))
        await this.storage.Rename(temp, LoadedGraphStore.FileName)
    }

    public async Read(): Promise<GraphLoadedDto | null>
    {
        if (!(await this.storage.Exists(LoadedGraphStore.FileName)))
        {
            return null
        }
        return JSON.parse(await this.storage.ReadText(LoadedGraphStore.FileName)) as GraphLoadedDto
    }
}
