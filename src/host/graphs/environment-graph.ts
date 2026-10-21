import { randomUUID } from 'node:crypto'
import { StoragePackageSource, ConnectorPrefetch, ConnectorRuntimeGraphQuery, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan } from '@pragmatic-tech-ai/todl'
import type { Domain } from '@pragmatic-tech-ai/todl/domain'
import { GraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IStorage, ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { GraphLoadParamsDto, GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { RuntimeAppGraph } from '../cypher/runtime-app-graph.js'
import { AppConnectorPlan } from '../cypher/app-connector-plan.js'
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

/** The single live environment-graph instance: the base query, its connector plan and domain, plus its loaded-manifest record (refs only, no content). */
export class EnvironmentGraph
{
    private static readonly PlanVersion = '0'

    private constructor(
        private readonly base: IGraphQuery,
        private readonly plan: ModelConnectorPlan,
        private readonly domain: Domain,
        private readonly record: GraphLoadedDto)
    {
    }

    public static async Build(storage: IStorage, graphName: string, refs: readonly PackageRef[]): Promise<EnvironmentGraph>
    {
        const domain = await RuntimeAppGraph.BuildDomainFromPackages(new StoragePackageSource(storage), refs)
        const base = new GraphQuery(domain.graph)
        const plan = await AppConnectorPlan.ForPackages(storage, refs, graphName, EnvironmentGraph.PlanVersion)
        const record: GraphLoadedDto = { name: graphName, packages: EnvironmentGraph.CopyRefs(refs), promotedAt: new Date().toISOString() }
        return new EnvironmentGraph(base, plan, domain, record)
    }

    public Base(): IGraphQuery
    {
        return this.base
    }

    public Plan(): ModelConnectorPlan
    {
        return this.plan
    }

    public Domain(): Domain
    {
        return this.domain
    }

    /** The package-only query (no connector overlay). */
    public Query(): IGraphQuery
    {
        return this.base
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

/** Builds the live, connector-overlaid query for ONE request: prefetches every bound concept from its adapter now (read-through, never cached). */
export class EnvironmentGraphOverlay
{
    public static async Apply(graph: EnvironmentGraph, services: ServiceProvider): Promise<IGraphQuery>
    {
        const plan = graph.Plan()
        if (plan.Bindings.length === 0)
        {
            return graph.Base()
        }
        const concepts = plan.Bindings.map(b => b.Concept)
        const snapshot = await ConnectorPrefetch.ForConcepts(concepts, plan, services.getRequired(DataSourceAdapterCatalog.ServiceKey), services, graph.Domain())
        return new ConnectorRuntimeGraphQuery(graph.Base(), snapshot)
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
