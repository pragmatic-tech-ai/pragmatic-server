import { ReflectedRepository } from '@pragmatic-tech-ai/todl'
import type { TodlDocument } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IConceptType } from '../host/runtime-write-payload-validator.js'
import type { IConceptTypeSource } from '../host/connector-hydrate-writer.js'

/** Schema-only reflection over a model's base document: materializes the TYPES (no connector data is pulled), so a write
 *  payload can be validated against the reflected concept type exactly like the app-data path (graph.Type(concept)). */
export class ModelSchemaTypes extends ReflectedRepository implements IConceptTypeSource
{
    private static readonly QueryMember = 'query'

    public static For(base: TodlDocument, model: string, version: string): ModelSchemaTypes
    {
        const schema = new ModelSchemaTypes()
        schema.load(base, model, version)
        return schema
    }

    public TypeOf(concept: string): IConceptType | undefined
    {
        const query = (this as unknown as Record<string, IGraphQuery | undefined>)[ModelSchemaTypes.QueryMember]
        return query?.Type(concept) as IConceptType | undefined
    }
}
