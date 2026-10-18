import { ModelRegistry, GenericModelDataSource, FederatedModelDataConnector, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ReflectedEntity, DataSourceKind, FlushOutcome, Diagnostic, ConnectorSpec } from '@pragmatic-tech-ai/todl'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { ConnectorModel } from './solution-connector-planner.js'

export interface ConnectorInfo
{
    readonly Name: string
    readonly Kind: DataSourceKind
}

export interface BindingInfo
{
    readonly Concept: string
    readonly Connector: string
    readonly Source: string
    readonly Writable: boolean
}

export interface ConnectorModelInfo
{
    readonly ModelId: string
    readonly Connectors: readonly ConnectorInfo[]
    readonly Bindings: readonly BindingInfo[]
}

export interface ConnectionProbe
{
    readonly Ok: boolean
    readonly Detail?: string
}

/** A skip/take window over the id-sorted instances of one concept. */
export interface EntityPage
{
    readonly Skip: number
    readonly Take: number
}

export interface EntityPageResult
{
    readonly Entities: readonly ReflectedEntity[]
    readonly HasMore: boolean
}

export interface RefreshModelOutcome
{
    readonly Diagnostics: readonly Diagnostic[]
}

/** Per-solution in-process connector host: lazily prepares each connector-bearing model's FederatedModelDataConnector
 *  on first touch (cached) and serves reads/write-back. Carries names/node-ids only; never a secret or raw error text. */
export class ConnectorRuntime
{
    private static readonly NoConnectorsPrefix = 'no connectors for model: '
    private static readonly UnknownConnectorDetail = 'unknown connector'
    private static readonly ProbeFailedDetail = 'connection probe failed'

    private static nextInstanceId = 0

    private readonly instanceId = ++ConnectorRuntime.nextInstanceId
    private writeBackCount = 0
    private refreshCount = 0
    private readonly models: ReadonlyMap<string, ConnectorModel>
    private readonly services: IServiceProvider
    private readonly registry = new ModelRegistry()
    private readonly connectors = new Map<string, FederatedModelDataConnector>()
    private readonly prepared = new Map<string, Promise<void>>()

    public constructor(models: readonly ConnectorModel[], services: IServiceProvider)
    {
        const map = new Map<string, ConnectorModel>()
        for (const model of models)
        {
            map.set(model.ModelId, model)
        }
        this.models = map
        this.services = services
    }

    /** Identifies this runtime's data generation: changes on every write-back and refresh and differs across runtimes, so a page cursor never outlives the data it paged. */
    public get Revision(): string
    {
        return `${this.instanceId}:${this.writeBackCount}:${this.refreshCount}`
    }

    /** The process-wide adapter catalog this runtime opens connectors through. */
    public Catalog(): DataSourceAdapterCatalog
    {
        return this.services.getRequired(DataSourceAdapterCatalog.ServiceKey)
    }

    /** Every connector spec of every model (the exact specs passed to catalog.Open). Carries Config: never log or return. */
    public ConnectorSpecs(): readonly ConnectorSpec[]
    {
        const out: ConnectorSpec[] = []
        for (const model of this.models.values())
        {
            out.push(...model.Plan.Connectors)
        }
        return out
    }

    public ModelsWithConnectors(): readonly ConnectorModelInfo[]
    {
        const out: ConnectorModelInfo[] = []
        for (const model of this.models.values())
        {
            out.push({
                ModelId: model.ModelId,
                Connectors: model.Plan.Connectors.map(c => ({ Name: c.Name, Kind: c.Kind })),
                Bindings: model.Plan.Bindings.map(b => ({ Concept: b.Concept, Connector: b.Connector, Source: b.Source, Writable: b.Writable })),
            })
        }
        return out
    }

    public async PrepareModel(modelId: string): Promise<void>
    {
        const existing = this.prepared.get(modelId)
        if (existing !== undefined)
        {
            return existing
        }
        const model = this.models.get(modelId)
        if (model === undefined)
        {
            throw new Error(`${ConnectorRuntime.NoConnectorsPrefix}${modelId}`)
        }
        const prepare = this.Build(model)
        this.prepared.set(modelId, prepare)
        try
        {
            await prepare
        }
        catch (error)
        {
            this.prepared.delete(modelId)
            throw error
        }
    }

    /** Re-pulls one model's data in place (adapters reused, never evicted). An unprepared model is simply prepared. Surfaces dropped-pending-op diagnostics. */
    public async RefreshModel(modelId: string): Promise<RefreshModelOutcome>
    {
        if (!this.prepared.has(modelId))
        {
            await this.PrepareModel(modelId)
            return { Diagnostics: [] }
        }
        const model = this.models.get(modelId)
        if (model === undefined)
        {
            throw new Error(`${ConnectorRuntime.NoConnectorsPrefix}${modelId}`)
        }
        await this.registry.GetRequired(modelId).Refresh(this.services)
        this.refreshCount++
        const diagnostics = this.connectors.get(modelId)?.LastRefreshDiagnostics() ?? []
        return { Diagnostics: diagnostics }
    }

    private async Build(model: ConnectorModel): Promise<void>
    {
        const connector = new FederatedModelDataConnector(model.Plan, model.Base)
        const source = new GenericModelDataSource(model.ModelId, connector)
        this.registry.Register(model.ModelId, source)
        this.connectors.set(model.ModelId, connector)
        await source.Prepare(this.services)
    }

    public async ConceptNames(modelId: string): Promise<readonly string[]>
    {
        await this.PrepareModel(modelId)
        return this.registry.GetRequired(modelId).ConceptNames()
    }

    /** Reads the prefetched instances sorted by id (ordinal). Paging slices that in-memory set; it never reaches the adapters. */
    public async ReadEntities(modelId: string, concept: string, page?: EntityPage): Promise<EntityPageResult>
    {
        await this.PrepareModel(modelId)
        const sorted = [...this.registry.GetRequired(modelId).Instances(concept)].sort((a, b) => ConnectorRuntime.CompareOrdinal(a.id, b.id))
        if (page === undefined)
        {
            return { Entities: sorted, HasMore: false }
        }
        const window = sorted.slice(page.Skip, page.Skip + page.Take + 1)
        const hasMore = window.length > page.Take
        return { Entities: hasMore ? window.slice(0, page.Take) : window, HasMore: hasMore }
    }

    private static CompareOrdinal(a: string, b: string): number
    {
        if (a < b)
        {
            return -1
        }
        return a > b ? 1 : 0
    }

    public async Entity(modelId: string, id: string): Promise<ReflectedEntity | undefined>
    {
        await this.PrepareModel(modelId)
        return this.registry.GetRequired(modelId).entity(id)
    }

    public async WriteBack(modelId: string, dirty: readonly string[], deleted: readonly string[]): Promise<FlushOutcome>
    {
        await this.PrepareModel(modelId)
        const connector = this.connectors.get(modelId)
        if (connector === undefined)
        {
            throw new Error(`${ConnectorRuntime.NoConnectorsPrefix}${modelId}`)
        }
        // count every attempt, even one that throws part-way: a partial apply may already have changed the data, and
        // a false stale-cursor error is safe whereas a falsely valid cursor over changed data is not
        try
        {
            const working = connector.WorkingCopy()
            const marks: Diagnostic[] = []
            for (const id of dirty)
            {
                const diag = working.MarkDirty(id)
                if (diag !== undefined)
                {
                    marks.push(diag)
                }
            }
            for (const id of deleted)
            {
                const diag = working.MarkDeleted(id)
                if (diag !== undefined)
                {
                    marks.push(diag)
                }
            }
            const catalog = this.services.getRequired(DataSourceAdapterCatalog.ServiceKey)
            const outcome = await working.Flush(catalog, this.services)
            return { Results: outcome.Results, Diagnostics: [...marks, ...outcome.Diagnostics] }
        }
        finally
        {
            this.writeBackCount++
        }
    }

    public async TestConnection(modelId: string, connectorName: string): Promise<ConnectionProbe>
    {
        const model = this.models.get(modelId)
        if (model === undefined)
        {
            throw new Error(`${ConnectorRuntime.NoConnectorsPrefix}${modelId}`)
        }
        const spec = model.Plan.Connectors.find(c => c.Name === connectorName)
        if (spec === undefined)
        {
            return { Ok: false, Detail: ConnectorRuntime.UnknownConnectorDetail }
        }
        const binding = model.Plan.Bindings.find(b => b.Connector === connectorName)
        try
        {
            const catalog = this.services.getRequired(DataSourceAdapterCatalog.ServiceKey)
            const adapter = await catalog.Open(spec, this.services)
            if (binding !== undefined)
            {
                await adapter.Query({ Source: binding.Source, Fields: [binding.IdKey] })
            }
            return { Ok: true }
        }
        catch
        {
            return { Ok: false, Detail: ConnectorRuntime.ProbeFailedDetail }
        }
    }
}
