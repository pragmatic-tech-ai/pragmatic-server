import { Action } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { IdentityEnforcement } from '@pragmatic-tech-ai/todl-identity-engine'
import type { Node, IInstanceFilter } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantGraphComposition, type TenantGraphArtifact, type TenantRepository } from './tenant-graph-source.js'

/**
 * Per-tenant cache of the UNFILTERED composed graph artifact, plus the per-request RBAC instance
 * filter. The cache is principal-independent; each GraphFor call removes policy-hidden instances
 * (and every edge touching one) from a copy of the seed BEFORE the graph is bound, so a hidden
 * instance is absent from the queried graph and no query shape can observe it.
 */
export class TenantGraphCache
{
    private artifact: TenantGraphArtifact | undefined
    private subscriptions: IDisposable[] = []
    private subscribed: readonly TenantRepository[] = []

    constructor(private readonly sources: () => readonly TenantRepository[] | Promise<readonly TenantRepository[]>) {}

    /** The queryable graph for `context`: the cached artifact with policy-hidden instances removed. */
    public async GraphFor(context: AccessContext): Promise<IGraphQuery>
    {
        const entries = await this.sources()
        const artifact = this.Artifact(entries)
        const allowed = TenantGraphCache.AllowedIds(entries, context)
        const filtered: TenantGraphArtifact = {
            packages: artifact.packages,
            seedNodes: artifact.seedNodes.filter(n => allowed.has(n.id)),
            seedEdges: artifact.seedEdges.filter(e => allowed.has(e.from) && allowed.has(e.to)),
        }
        return await TenantGraphComposition.BuildQuery(filtered)
    }

    /** Drop the cached artifact; the next GraphFor recomposes. */
    public Invalidate(): void
    {
        this.artifact = undefined
    }

    /** Detach every repository subscription and drop the cache. */
    public Dispose(): void
    {
        this.Unsubscribe()
        this.artifact = undefined
    }

    /** Compose the unfiltered artifact (overridable so callers can observe recomposition). */
    protected Compose(entries: readonly TenantRepository[]): TenantGraphArtifact
    {
        return new TenantGraphComposition(entries).Compose()
    }

    private Artifact(entries: readonly TenantRepository[]): TenantGraphArtifact
    {
        if (this.artifact === undefined || !this.SameSources(entries))
        {
            this.Unsubscribe()
            this.artifact = this.Compose(entries)
            this.subscribed = entries
            this.subscriptions = entries.map(e => e.repo.changed.subscribe(() => this.Invalidate()))
        }
        return this.artifact
    }

    private SameSources(entries: readonly TenantRepository[]): boolean
    {
        return entries.length === this.subscribed.length
            && entries.every((e, i) => e.repo === this.subscribed[i]!.repo && e.model === this.subscribed[i]!.model && e.version === this.subscribed[i]!.version)
    }

    private Unsubscribe(): void
    {
        for (const s of this.subscriptions) s.dispose()
        this.subscriptions = []
        this.subscribed = []
    }

    /**
     * Ids the principal may read, DENY-WINS across repositories: an id is kept when some repository
     * allows it and NO repository that contains it denies it (mirrors ModelReadFilter.keep per repo).
     */
    private static AllowedIds(entries: readonly TenantRepository[], context: AccessContext): Set<string>
    {
        const allowed = new Set<string>()
        const denied = new Set<string>()
        for (const entry of entries)
        {
            const filter = IdentityEnforcement.ForRepository(entry.repo, context, Action.Read).InstanceFilter()
            for (const node of entry.repo.allNodes())
            {
                if (TenantGraphCache.Keep(node, filter)) allowed.add(node.id)
                else denied.add(node.id)
            }
        }
        for (const id of denied) allowed.delete(id)
        return allowed
    }

    private static Keep(node: Node, filter: IInstanceFilter): boolean
    {
        if (node.type === null) return true
        const concept = node.type
        return filter.Keep({ Concept: concept, Field: name => node.attrs.get(name) })
    }
}
