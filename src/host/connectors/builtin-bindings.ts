import type { ModelConnectorPlan, ConnectorBinding, ConnectorSpec } from '@pragmatic-tech-ai/todl'
import { DataSourceKind, WriteConcurrency, WriteAtomicity } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { BuiltinAdapterFactory } from './builtin-adapter-factory.js'
import type { BuiltinStoreEngine } from './builtin-store-engine.js'

/** The slice of reflection's TypeInfo this class reads: the concept's id and its scalar fields (relationships are not fields). */
interface ConceptShape
{
    readonly fullName: string
    getFields(): readonly { readonly name: string }[]
}

/** Routes every concept with no explicit `populate` to the app's built-in store by synthesizing a writable binding for it. */
export class BuiltinBindings
{
    private static readonly IdMember = 'id'
    private static readonly NamespaceSeparator = '.'
    private static readonly CollectionSeparator = '/'

    public static Augment(
        plan: ModelConnectorPlan,
        base: IGraphQuery,
        connectorName: string,
        dataRoot: string,
        engine: BuiltinStoreEngine): { plan: ModelConnectorPlan; defaultConcepts: ReadonlySet<string> }
    {
        const bound = new Set(plan.Bindings.map(b => b.Concept))
        const defaults = new Set<string>()
        const bindings: ConnectorBinding[] = [...plan.Bindings]
        for (const type of base.Concepts())
        {
            const concept = type.fullName
            if (bound.has(concept))
            {
                continue
            }
            bindings.push(BuiltinBindings.BindingFor(type, connectorName))
            defaults.add(concept)
        }
        if (defaults.size === 0)
        {
            return { plan, defaultConcepts: defaults }
        }
        const spec: ConnectorSpec = {
            Name: connectorName,
            Kind: DataSourceKind.Builtin,
            Config: { [BuiltinAdapterFactory.DataRootKey]: dataRoot, [BuiltinAdapterFactory.EngineKey]: engine }
        }
        return { plan: { ...plan, Connectors: [...plan.Connectors, spec], Bindings: bindings }, defaultConcepts: defaults }
    }

    private static BindingFor(type: ConceptShape, connectorName: string): ConnectorBinding
    {
        const fieldMap: Record<string, string> = { [BuiltinBindings.IdMember]: BuiltinBindings.IdMember }
        for (const field of type.getFields())
        {
            fieldMap[field.name] = field.name
        }
        return { Concept: type.fullName, Connector: connectorName, Source: BuiltinBindings.CollectionFor(type.fullName), IdKey: BuiltinBindings.IdMember, FieldMap: fieldMap, Writable: true, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential }
    }

    /** The store collection for a concept: its id with namespace dots turned into slashes (document identifiers may not contain dots; concept ids never contain slashes, so this is injective). */
    public static CollectionFor(concept: string): string
    {
        return concept.split(BuiltinBindings.NamespaceSeparator).join(BuiltinBindings.CollectionSeparator)
    }
}
