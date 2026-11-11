import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { ISchemaDescription } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/**
 * The S12 model filter (rulings S12, S14): a caller's scope AND one model's own instances, `Or(ConceptIs todl.Term,
 * OwnerIs({modelId}))` on the `todl.Element` rows (AccessScopeConjunction, deny-wins). The filter reaches every concept
 * but the taxonomy terms, which the caller's own scope alone governs, so term refs survive; an external node's owner is
 * its binding model, so a binding model id selects its connector rows. Shared by `cypher/query` and `connector/read*`;
 * cached per scope object (which is per schema version) and model id.
 */
export class ModelScopes
{
    private catalog: { readonly Description: ISchemaDescription; readonly Catalog: EngineSchemaCatalog } | undefined
    private readonly scopes = new WeakMap<AccessScope, Map<string, AccessScope>>()

    public For(scope: AccessScope, modelId: string, description: ISchemaDescription): AccessScope
    {
        let byModel = this.scopes.get(scope)
        if (byModel === undefined)
        {
            byModel = new Map<string, AccessScope>()
            this.scopes.set(scope, byModel)
        }
        let scoped = byModel.get(modelId)
        if (scoped === undefined)
        {
            const rows = new Map([[TodlNames.Element, new Or([new ConceptIs(TodlNames.Term), new OwnerIs(new Set([modelId]))])]])
            scoped = AccessScopeConjunction.And(scope, AccessScope.Build({ Default: AccessDefault.Allow, Rows: rows }), this.CatalogOf(description))
            byModel.set(modelId, scoped)
        }
        return scoped
    }

    /** The schema catalog of `description` (one cached, the last one asked for). */
    public CatalogOf(description: ISchemaDescription): EngineSchemaCatalog
    {
        if (this.catalog === undefined || this.catalog.Description !== description)
        {
            this.catalog = { Description: description, Catalog: new EngineSchemaCatalog(description) }
        }
        return this.catalog.Catalog
    }
}
