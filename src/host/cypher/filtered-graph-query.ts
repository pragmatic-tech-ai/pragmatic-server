import type { IInstanceFilter } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'

type Mirror = ReturnType<IGraphQuery['AllInstances']>[number]

/**
 * Deny-wins view over a composed graph: an instance the filter rejects is absent from every
 * listing, cannot be reflected, and is never reachable as a ref/referrer target, nor are its own edges.
 */
export class FilteredGraphQuery implements IGraphQuery
{
    constructor(private readonly inner: IGraphQuery, private readonly filter: IInstanceFilter) {}

    public Concepts(): ReturnType<IGraphQuery['Concepts']> { return this.inner.Concepts() }
    public Type(name: string): ReturnType<IGraphQuery['Type']> { return this.inner.Type(name) }
    public Term(id: string): ReturnType<IGraphQuery['Term']> { return this.inner.Term(id) }
    public Narrower(termId: string): ReturnType<IGraphQuery['Narrower']> { return this.inner.Narrower(termId) }
    public Broader(termId: string): ReturnType<IGraphQuery['Broader']> { return this.inner.Broader(termId) }
    public Descendants(termId: string): ReturnType<IGraphQuery['Descendants']> { return this.inner.Descendants(termId) }
    public Ancestors(termId: string): ReturnType<IGraphQuery['Ancestors']> { return this.inner.Ancestors(termId) }
    public IconKey(typeId: string): string | undefined { return this.inner.IconKey(typeId) }

    public InstancesOf(conceptId: string): Mirror[]
    {
        return this.inner.InstancesOf(conceptId).filter(m => this.Keep(m))
    }

    public Reflect(id: string): Mirror | undefined
    {
        const mirror = this.inner.Reflect(id)
        return mirror !== undefined && this.Keep(mirror) ? mirror : undefined
    }

    public Refs(id: string, member: string): Mirror[]
    {
        if (this.Reflect(id) === undefined) return []
        return this.inner.Refs(id, member).filter(m => this.Keep(m))
    }

    public Referrers(id: string, member?: string): Mirror[]
    {
        if (this.Reflect(id) === undefined) return []
        return this.inner.Referrers(id, member).filter(m => this.Keep(m))
    }

    public Search(text: string): Mirror[]
    {
        return this.inner.Search(text).filter(m => this.Keep(m))
    }

    public AllInstances(): Mirror[]
    {
        return this.inner.AllInstances().filter(m => this.Keep(m))
    }

    private Keep(mirror: Mirror): boolean
    {
        const concept = mirror.type?.fullName
        if (concept === undefined) return true
        return this.filter.Keep({ Concept: concept, Field: name => mirror.field(name)?.value })
    }
}
