import { AccessDefault, PredicateKind } from '@pragmatic-tech-ai/graph'
import type { AccessScope, And, ConceptIs, Not, Or, Predicate } from '@pragmatic-tech-ai/graph'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** A predicate folded for the instances of one concept: decided either way, or left to each node. */
enum Reach
{
    Never = 1,
    Always = 2,
    Maybe = 3,
}

/**
 * Whether a scope may let a reader see any instance of a concept (ruling S16, shared by both purposes per S1): what the
 * `data/changed` push filters a connection's concepts with. A concept covers its subconcepts, so it is reachable when
 * its own instances or any subconcept's may be visible. One concept's instances are unreachable iff an applicable Rows
 * entry (the concept, an ancestor or a carried aspect) folds to the constant False for them, or the scope's Default is
 * Deny with no applicable entry. Folding decides `ConceptIs` against the concept (the depth compiler's own-concept guard
 * `Or(Not(ConceptIs K), rule)`, ruling R93) and propagates constants through And / Or / Not; any other term is decided
 * per node, so "maybe" (reachable). Connector-bound concepts carry explicit True entries (R12): always reachable.
 */
export class ScopeReach
{
    public static MayRead(scope: AccessScope, concept: string, catalog: EngineSchemaCatalog): boolean
    {
        return [concept, ...catalog.Descendants(concept)].some(own => ScopeReach.MayReadOwn(scope, own, catalog))
    }

    /** May an instance whose own concept is exactly `concept` be visible? */
    private static MayReadOwn(scope: AccessScope, concept: string, catalog: EngineSchemaCatalog): boolean
    {
        let entries = 0
        for (const key of catalog.Applicable(concept))
        {
            const entry = scope.Rows.get(key)
            if (entry === undefined) continue
            entries++
            if (ScopeReach.Fold(entry, concept) === Reach.Never) return false
        }
        return entries > 0 || scope.Default !== AccessDefault.Deny
    }

    private static Fold(predicate: Predicate, concept: string): Reach
    {
        switch (predicate.Kind)
        {
            case PredicateKind.True:
                return Reach.Always
            case PredicateKind.False:
                return Reach.Never
            case PredicateKind.ConceptIs:
                return (predicate as ConceptIs).Concept === concept ? Reach.Always : Reach.Never
            case PredicateKind.Not:
                return ScopeReach.Negate(ScopeReach.Fold((predicate as Not).Term, concept))
            case PredicateKind.And:
                return ScopeReach.Combine((predicate as And).Terms, concept, Reach.Never, Reach.Always)
            case PredicateKind.Or:
                return ScopeReach.Combine((predicate as Or).Terms, concept, Reach.Always, Reach.Never)
            default:
                return Reach.Maybe
        }
    }

    /** `dominant` if any term folds to it, `neutral` if every term does, else Maybe. */
    private static Combine(terms: readonly Predicate[], concept: string, dominant: Reach, neutral: Reach): Reach
    {
        let all = true
        for (const term of terms)
        {
            const folded = ScopeReach.Fold(term, concept)
            if (folded === dominant) return dominant
            if (folded !== neutral) all = false
        }
        return all ? neutral : Reach.Maybe
    }

    private static Negate(reach: Reach): Reach
    {
        switch (reach)
        {
            case Reach.Always:
                return Reach.Never
            case Reach.Never:
                return Reach.Always
            default:
                return Reach.Maybe
        }
    }
}
