import { MemberKind } from '@pragmatic-tech-ai/graph'
import type { IDefinitionDescription, ISchemaDescription } from '@pragmatic-tech-ai/graph'

/**
 * How the engine will see a schema description, read off the description itself (before the engine opens on it): the
 * concepts, each concept's ancestor chain, the keys whose access-scope entries apply to its instances (itself, its
 * ancestors and every aspect it carries) and its effective members (own, aspects, then the parent chain). Scope
 * compilers use it so every name they emit is one the engine's scope validation accepts.
 */
export class EngineSchemaCatalog
{
    private readonly byName: ReadonlyMap<string, IDefinitionDescription>
    private readonly members = new Map<string, ReadonlyMap<string, MemberKind>>()
    private readonly applicable = new Map<string, ReadonlySet<string>>()

    public constructor(public readonly Description: ISchemaDescription)
    {
        this.byName = new Map(Description.Definitions.map(definition => [definition.Name, definition]))
    }

    /** Every concept (not aspect) the description defines, in description order. */
    public Concepts(): readonly string[]
    {
        return this.Description.Definitions.filter(definition => !definition.IsAspect).map(definition => definition.Name)
    }

    public IsConcept(name: string): boolean
    {
        const definition = this.byName.get(name)
        return definition !== undefined && !definition.IsAspect
    }

    /** The proper ancestors of `concept`, nearest first (empty for an unknown name). */
    public Ancestors(concept: string): readonly string[]
    {
        const chain: string[] = []
        const seen = new Set<string>([concept])
        let parent = this.byName.get(concept)?.Parent ?? null
        while (parent !== null && !seen.has(parent))
        {
            chain.push(parent)
            seen.add(parent)
            parent = this.byName.get(parent)?.Parent ?? null
        }
        return chain
    }

    /** The keys whose scope entries apply to an instance of `concept`: itself, its ancestors and every carried aspect. */
    public Applicable(concept: string): ReadonlySet<string>
    {
        let keys = this.applicable.get(concept)
        if (keys === undefined)
        {
            const out = new Set<string>()
            for (const name of [concept, ...this.Ancestors(concept)])
            {
                out.add(name)
                for (const aspect of this.byName.get(name)?.Aspects ?? []) this.AddAspect(aspect, out)
            }
            keys = out
            this.applicable.set(concept, keys)
        }
        return keys
    }

    /** Every effective member name of `concept` (properties and relationships). */
    public Members(concept: string): readonly string[]
    {
        return [...this.MemberKinds(concept).keys()]
    }

    /** True iff `member` is an effective property (not a relationship) of `concept`. */
    public IsProperty(concept: string, member: string): boolean
    {
        return this.MemberKinds(concept).get(member) === MemberKind.Property
    }

    private MemberKinds(concept: string): ReadonlyMap<string, MemberKind>
    {
        let kinds = this.members.get(concept)
        if (kinds === undefined)
        {
            const out = new Map<string, MemberKind>()
            this.Collect(concept, out, new Set<string>())
            kinds = out
            this.members.set(concept, kinds)
        }
        return kinds
    }

    /** Own members first, then aspects, then the parent chain; the first declaration of a name wins. */
    private Collect(name: string, out: Map<string, MemberKind>, seen: Set<string>): void
    {
        const definition = this.byName.get(name)
        if (definition === undefined || seen.has(name)) return
        seen.add(name)
        for (const member of definition.Members)
        {
            if (!out.has(member.Name)) out.set(member.Name, member.Kind)
        }
        for (const aspect of definition.Aspects) this.Collect(aspect, out, seen)
        if (definition.Parent !== null) this.Collect(definition.Parent, out, seen)
    }

    private AddAspect(aspect: string, out: Set<string>): void
    {
        if (out.has(aspect)) return
        out.add(aspect)
        for (const included of this.byName.get(aspect)?.Aspects ?? []) this.AddAspect(included, out)
    }
}
