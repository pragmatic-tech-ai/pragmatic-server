import { ModelRegistry, GenericModelDataSource, FederatedModelDataConnector, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ReflectedEntity, DataSourceKind, FlushOutcome, Diagnostic } from '@pragmatic-tech-ai/todl'
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

/** Per-solution in-process connector host: lazily prepares each connector-bearing model's FederatedModelDataConnector
 *  on first touch (cached) and serves reads/write-back. Carries names/node-ids only; never a secret or raw error text. */
export class ConnectorRuntime
{
    private static readonly NoConnectorsPrefix = 'no connectors for model: '
    private static readonly UnknownConnectorDetail = 'unknown connector'
    private static readonly ProbeFailedDetail = 'connection probe failed'

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

    public async ReadEntities(modelId: string, concept: string): Promise<readonly ReflectedEntity[]>
    {
        await this.PrepareModel(modelId)
        return this.registry.GetRequired(modelId).Instances(concept)
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
