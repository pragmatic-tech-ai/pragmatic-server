import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { ISchemaDescription } from '@pragmatic-tech-ai/graph'
import { SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** Which model filter {@link ModelScopes} builds. */
enum ModelFilterKind
{
    /** S12 (R58): the model's own instances, every taxonomy term and the caller's share grants. */
    WithTerms = 'terms',
    /** R53 (R58): the model's own nodes and the caller's share grants. */
    OwnerOnly = 'owner',
}

/**
 * The model filters ANDed into a caller's scope (AccessScopeConjunction, deny-wins), on the `todl.Element` rows:
 *
 * - {@link ModelScopes.For}, the S12 model filter (rulings S12, S14, R58): `Or(ConceptIs todl.Term, ConceptIs
 *   todl.system.ShareGrant, OwnerIs({modelId}))`. It reaches every concept but the taxonomy terms and the share grants,
 *   which the caller's own scope alone governs (GrantRows: its own grants), so term refs survive and share widening
 *   still works under a model filter (a Related target is judged under the same scope, R66; a grant is owned by
 *   `todl.system`, so `OwnerIs` alone would hide it and every shared record with it). A model-scoped read can therefore
 *   return the caller's own grant nodes. An external node's owner is its binding model, so a binding model id selects
 *   its connector rows. Used by `cypher/query` and `connector/read*`.
 * - {@link ModelScopes.ForOwner} (rulings R53, R58): `Or(ConceptIs todl.system.ShareGrant, OwnerIs({modelId}))`, so
 *   another package's terms are not listed while share widening works. Used by the runtime `model/view`, which leaves
 *   the grant nodes out of its items (they are not package members).
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
            const grants = new ConceptIs(SystemNames.ShareGrant)
            const filter = kind === ModelFilterKind.WithTerms ? new Or([new ConceptIs(TodlNames.Term), grants, owner]) : new Or([grants, owner])
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
