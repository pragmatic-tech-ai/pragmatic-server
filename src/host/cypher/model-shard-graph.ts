import { toJSON, ModelShardExtractor } from '@pragmatic-tech-ai/todl'
import type { Repository, TodlDocument } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { PackageManifestBridge } from '@pragmatic-tech-ai/todl/package-manager'
import { TenantGraphComposition } from './tenant-graph-source.js'

/** A model shard located in one of the tenant's own repositories: the owning repo, its full document, and the shard's node id. */
export interface LocatedShard
{
    readonly Repo: Repository
    readonly Full: TodlDocument
    readonly ModelId: ReturnType<typeof ModelShardExtractor.ModelsOf>[number]
    readonly Name: string
}

/**
 * Builds the queryable graph for ONE model shard of a tenant repository: the shared ontology plus that model's own
 * instances, bound into a fresh Domain. The result is UNFILTERED; the caller decorates it with the same row filter and
 * field mask every other graph path uses. Visibility is pure membership in the tenant's own repositories.
 */
export class ModelShardGraph
{
    private static readonly ShardVersion = '0.0.0'

    /** Finds `modelId` among the models of the tenant's repositories (each document computed once); undefined for a non-member id. */
    public static Locate(repos: readonly Repository[], modelId: string): LocatedShard | undefined
    {
        for (const repo of repos)
        {
            const full = toJSON(repo)
            const id = ModelShardExtractor.ModelsOf(full).find(m => String(m) === modelId)
            if (id !== undefined)
            {
                return { Repo: repo, Full: full, ModelId: id, Name: modelId }
            }
        }
        return undefined
    }

    /** The unfiltered single-shard graph for a located shard. */
    public static async Build(shard: LocatedShard): Promise<IGraphQuery>
    {
        const doc = ModelShardExtractor.Extract(shard.Full, shard.ModelId)
        const resolved = PackageManifestBridge.toResolvedJsonDocument(doc, shard.Name, ModelShardGraph.ShardVersion, [])
        const seed = resolved.seed
        delete resolved.seed
        return await TenantGraphComposition.BuildQuery({ packages: [resolved], seedNodes: [...(seed?.nodes ?? [])], seedEdges: [...(seed?.edges ?? [])] })
    }
}
