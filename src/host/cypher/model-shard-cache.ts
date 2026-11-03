import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { ModelShardGraph, type LocatedShard } from './model-shard-graph.js'
import type { TenantRepository } from './tenant-graph-source.js'

/** The model shards a tenant exposes to model-scoped Cypher: their ids, and the decorated graph of one. */
export interface IModelShardSource
{
    /** The queryable graph of one member shard, filtered and masked for `context`; InvalidParams for a non-member id. */
    ModelGraph(context: AccessContext, modelId: string): Promise<IGraphQuery>
    /** The member shard ids `context` may pass as modelId (membership in the tenant's own sources). */
    ModelIds(context: AccessContext): Promise<readonly string[]>
}

/**
 * Principal-independent cache of the tenant's model shards: the shard index (ids -> owning repository) and each shard's
 * UNFILTERED graph, built once and shared. Callers apply the per-principal filter and mask on top, per request (the
 * TenantGraphCache cache-then-filter pattern). Any source repository change, or a different source set, drops everything.
 */
export class ModelShardCache
{
    private index: ReadonlyMap<string, LocatedShard> | undefined
    // Keyed by the located shard OBJECT, not its name: a request that located a shard before an invalidation builds from
    // that stale document, and must not seed the cache a request of the new generation reads.
    private readonly graphs = new Map<LocatedShard, Promise<IGraphQuery>>()
    private disposed = false
    private subscriptions: IDisposable[] = []
    private subscribed: readonly TenantRepository[] = []

    constructor(private readonly sources: () => Promise<readonly TenantRepository[]>) {}

    /** Member shard ids, sorted. */
    public async Ids(): Promise<string[]>
    {
        return [...(await this.Index()).keys()].sort()
    }

    /** The located shard for `modelId`; undefined for a non-member id. */
    public async Locate(modelId: string): Promise<LocatedShard | undefined>
    {
        return (await this.Index()).get(modelId)
    }

    /** The shard's unfiltered graph, built at most once per cache generation. */
    public Graph(shard: LocatedShard): Promise<IGraphQuery>
    {
        let graph = this.graphs.get(shard)
        if (graph === undefined)
        {
            graph = this.Build(shard)
            // only a shard of the current index is cached; a stale one is built for its caller alone
            if (this.index?.get(shard.Name) === shard)
            {
                this.graphs.set(shard, graph)
                // a failed build is not cached: the next request retries
                graph.catch(() => { if (this.graphs.get(shard) === graph) this.graphs.delete(shard) })
            }
        }
        return graph
    }

    /** Drop the index and every cached shard graph; the next call rebuilds. */
    public Invalidate(): void
    {
        this.index = undefined
        this.graphs.clear()
    }

    /** Detach every repository subscription and drop the cache; later calls still answer but never re-subscribe. */
    public Dispose(): void
    {
        this.disposed = true
        this.Unsubscribe()
        this.Invalidate()
    }

    /** Builds one shard graph (overridable so tests can observe rebuilds). */
    protected Build(shard: LocatedShard): Promise<IGraphQuery>
    {
        return ModelShardGraph.Build(shard)
    }

    private async Index(): Promise<ReadonlyMap<string, LocatedShard>>
    {
        const entries = await this.sources()
        if (this.index === undefined || !this.SameSources(entries))
        {
            this.Unsubscribe()
            this.Invalidate()
            const index = ModelShardGraph.Index(entries.map(e => e.repo))
            if (this.disposed)
            {
                return index
            }
            this.index = index
            this.subscribed = entries
            this.subscriptions = entries.map(e => e.repo.changed.subscribe(() => this.Invalidate()))
        }
        return this.index
    }

    private SameSources(entries: readonly TenantRepository[]): boolean
    {
        return entries.length === this.subscribed.length && entries.every((e, i) => e.repo === this.subscribed[i]!.repo)
    }

    private Unsubscribe(): void
    {
        for (const s of this.subscriptions) s.dispose()
        this.subscriptions = []
        this.subscribed = []
    }
}
