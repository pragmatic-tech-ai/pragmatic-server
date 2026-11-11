import type { ExternalIdentity } from '@pragmatic-tech-ai/todl/engine'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'

/**
 * The concepts bound to an external binding in an engine snapshot's identity, and their subconcepts (ruling R6:
 * connector data is outside platform security, so every purpose's depth compile skips them).
 */
export class ExternalConcepts
{
    private readonly bound: ReadonlySet<string>

    public constructor(identity: ExternalIdentity | undefined, private readonly catalog: EngineSchemaCatalog)
    {
        this.bound = new Set((identity?.Bindings() ?? []).map(binding => binding.Binding.Concept))
    }

    /** True when `concept`, or one of its ancestors, is bound externally. */
    public Has(concept: string): boolean
    {
        if (this.bound.size === 0) return false
        return this.bound.has(concept) || this.catalog.Ancestors(concept).some(ancestor => this.bound.has(ancestor))
    }
}
