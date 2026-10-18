import { toJSON, ModelShardExtractor } from '@pragmatic-tech-ai/todl'
import type { Repository, TodlDocument } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { PackageManifestBridge } from '@pragmatic-tech-ai/todl/package-manager'
import { TenantGraphComposition } from './tenant-graph-source.js'

/**
 * Builds the queryable graph for ONE model shard of a tenant repository: the shared ontology plus that model's own
 * instances, bound into a fresh Domain. The result is UNFILTERED; the caller decorates it with the same row filter and
 * field mask every other graph path uses.
 */
export class ModelShardGraph
{
    private static readonly ShardVersion = '0.0.0'
    private static readonly UnknownModelMessage = 'model shard not found in repository'

    /** True when `modelId` names a model container in `repo`. */
    public static Contains(repo: Repository, modelId: string): boolean
    {
        return ModelShardGraph.ModelIds(toJSON(repo)).includes(modelId)
    }

    /** The unfiltered single-shard graph for `modelId` of `repo`. */
    public static async Build(repo: Repository, modelId: string): Promise<IGraphQuery>
    {
        const full = toJSON(repo)
        const id = ModelShardExtractor.ModelsOf(full).find(m => String(m) === modelId)
        if (id === undefined)
        {
            throw new Error(ModelShardGraph.UnknownModelMessage)
        }
        const shard: TodlDocument = ModelShardExtractor.Extract(full, id)
        const resolved = PackageManifestBridge.toResolvedJsonDocument(shard, modelId, ModelShardGraph.ShardVersion, [])
        const seed = resolved.seed
        delete resolved.seed
        return await TenantGraphComposition.BuildQuery({ packages: [resolved], seedNodes: [...(seed?.nodes ?? [])], seedEdges: [...(seed?.edges ?? [])] })
    }

    /**
     * Whether the principal may address the shard: it is visible unless it holds instances and the filtered view shows none of them.
     * Callers report an invisible shard exactly like an absent one so existence is not leaked.
     */
    public static IsVisible(base: IGraphQuery, filtered: IGraphQuery): boolean
    {
        return base.AllInstances().length === 0 || filtered.AllInstances().length > 0
    }

    private static ModelIds(doc: TodlDocument): string[]
    {
        return ModelShardExtractor.ModelsOf(doc).map(m => String(m))
    }
}
