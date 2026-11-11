import type { GraphEngine, ISchemaDescription, ISignal } from '@pragmatic-tech-ai/graph'
import type { EngineCellMapper, ExternalIdentity, IExternalConnectorPlan } from '@pragmatic-tech-ai/todl/engine'

/**
 * What a graph engine runs, in one read, whatever its purpose (the dev snapshot, the runtime environment catalog):
 * the schema description, the mapper that renders the engine's Cypher cells in TODL's wire shape, the model ids a
 * query may scope to (sorted), the external connector plans the engine's connectors serve, and the identity of their
 * external records (undefined when nothing is bound externally).
 */
export interface IEngineSnapshot
{
    readonly Description: ISchemaDescription
    readonly CellMapper: EngineCellMapper
    readonly Models: readonly string[]
    readonly Connectors: readonly IExternalConnectorPlan[]
    readonly Identity: ExternalIdentity | undefined
}

/**
 * A purpose-free graph engine host: the engine, the snapshot it runs and that snapshot's description. `Changed` is
 * raised after every applied upgrade (or reopen); between two raises `Snapshot().Description.Version` equals the
 * engine's `SchemaVersion` except while an upgrade is being applied. The shared engine-side classes (ruling S1:
 * AccessScopeSource, EngineCypherQuery, ...) depend on this seam only, never on a host's purpose.
 */
export interface IGraphEngineHost
{
    Engine(): Promise<GraphEngine>
    Snapshot(): Promise<IEngineSnapshot>
    Description(): Promise<ISchemaDescription>
    readonly Changed: ISignal<void>
}
