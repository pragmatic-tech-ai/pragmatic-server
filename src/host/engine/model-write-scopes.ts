import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { ISchemaDescription, IWriteRules } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/**
 * The caller's scope with its writes confined to one model (rulings T7-b, S12, S13; shared by both execute paths,
 * S1): `Or(ConceptIs todl.Term, OwnerIs(modelId))` ANDed into the `todl.Element` Create, Update and Delete rules
 * (deny-wins), so a write to another model's instance (dev) or package's data (runtime) is Denied while reads stay
 * tenant-wide; terms keep the caller's own rules. Cached per scope object (one per schema version) and model id.
 */
export class ModelWriteScopes
{
    private readonly scopes = new WeakMap<AccessScope, Map<string, AccessScope>>()
    private catalog: { readonly Description: ISchemaDescription; readonly Catalog: EngineSchemaCatalog } | undefined

    public For(scope: AccessScope, modelId: string, description: ISchemaDescription): AccessScope
    {
        let byModel = this.scopes.get(scope)
        if (byModel === undefined)
        {
            byModel = new Map<string, AccessScope>()
            this.scopes.set(scope, byModel)
        }
        let confined = byModel.get(modelId)
        if (confined === undefined)
        {
            const own = new Or([new ConceptIs(TodlNames.Term), new OwnerIs(new Set([modelId]))])
            const rules: IWriteRules = { Create: own, Update: own, Delete: own }
            const writes = new Map([[TodlNames.Element, rules]])
            confined = AccessScopeConjunction.And(scope, AccessScope.Build({ Default: AccessDefault.Allow, Writes: writes }), this.CatalogOf(description))
            byModel.set(modelId, confined)
        }
        return confined
    }

    private CatalogOf(description: ISchemaDescription): EngineSchemaCatalog
    {
        if (this.catalog === undefined || this.catalog.Description !== description)
        {
            this.catalog = { Description: description, Catalog: new EngineSchemaCatalog(description) }
        }
        return this.catalog.Catalog
    }
}
