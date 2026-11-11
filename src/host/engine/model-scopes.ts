import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { ISchemaDescription } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** Which model filter {@link ModelScopes} builds. */
enum ModelFilterKind
{
    /** S12: the model's own instances and every taxonomy term. */
    WithTerms = 'terms',
    /** R53: the model's own nodes only. */
    OwnerOnly = 'owner',
}

/**
 * The model filters ANDed into a caller's scope (AccessScopeConjunction, deny-wins), on the `todl.Element` rows:
 *
 * - {@link ModelScopes.For}, the S12 model filter (rulings S12, S14): `Or(ConceptIs todl.Term, OwnerIs({modelId}))`.
 *   It reaches every concept but the taxonomy terms, which the caller's own scope alone governs, so term refs survive;
 *   an external node's owner is its binding model, so a binding model id selects its connector rows. Used by
 *   `cypher/query` and `connector/read*`.
 * - {@link ModelScopes.ForOwner} (ruling R53): `OwnerIs({modelId})` alone, so another package's terms are not listed.
 *   Used by the runtime `model/view`.
 *
 * Both are cached per scope object (which is per schema version), filter kind and model id.
 */
export class ModelScopes
{
    private static readonly KeySeparator = '\u0000'

    private catalog: { readonly Description: ISchemaDescription; readonly Catalog: EngineSchemaCatalog } | undefined
    private readonly scopes = new WeakMap<AccessScope, Map<string, AccessScope>>()

    public For(scope: AccessScope, modelId: string, description: ISchemaDescription): AccessScope
    {
        return this.Scoped(scope, ModelFilterKind.WithTerms, modelId, description)
    }

    public ForOwner(scope: AccessScope, modelId: string, description: ISchemaDescription): AccessScope
    {
        return this.Scoped(scope, ModelFilterKind.OwnerOnly, modelId, description)
    }

    private Scoped(scope: AccessScope, kind: ModelFilterKind, modelId: string, description: ISchemaDescription): AccessScope
    {
        let byModel = this.scopes.get(scope)
        if (byModel === undefined)
        {
            byModel = new Map<string, AccessScope>()
            this.scopes.set(scope, byModel)
        }
        const key = kind + ModelScopes.KeySeparator + modelId
        let scoped = byModel.get(key)
        if (scoped === undefined)
        {
            const owner = new OwnerIs(new Set([modelId]))
            const filter = kind === ModelFilterKind.WithTerms ? new Or([new ConceptIs(TodlNames.Term), owner]) : owner
            const rows = new Map([[TodlNames.Element, filter]])
            scoped = AccessScopeConjunction.And(scope, AccessScope.Build({ Default: AccessDefault.Allow, Rows: rows }), this.CatalogOf(description))
            byModel.set(key, scoped)
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
