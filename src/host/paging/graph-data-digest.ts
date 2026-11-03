import { createHash } from 'node:crypto'
import { Cypher } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { ReferencedLabelSet } from '../../pragmatic-server.js'

type Mirror = ReturnType<IGraphQuery['AllInstances']>[number]

/**
 * The data revision of a runtime graph as one query sees it: a digest of every instance the query can reach (the
 * concepts its node patterns name, or every instance when a pattern is unlabeled or the labels cannot be resolved),
 * with ids, attributes and references in canonical order. Runtime graphs re-pull connector data per request, so no
 * counter can track an external change; folding this digest into the cursor fingerprint makes a cursor go stale as
 * soon as the data behind it changes, instead of silently skipping or repeating rows.
 */
export class GraphDataDigest
{
    private static readonly Algorithm = 'sha256'
    private static readonly Encoding = 'hex'
    private static readonly RecordSeparator = '\u0001'

    public static Of(graph: IGraphQuery, labels: ReferencedLabelSet): string
    {
        // Every reachable record (duplicates included: a source may repeat an id), each serialized canonically, then sorted,
        // so neither source row order nor which duplicate "wins" can move the digest. The class carries term-fixed values.
        const records = GraphDataDigest.Reachable(graph, labels).map(mirror =>
        {
            const node = mirror.node
            return JSON.stringify([node.id, node.type, node.class ?? null, GraphDataDigest.Sorted(node.attrs), GraphDataDigest.Sorted(node.refs ?? {})])
        })
        const hash = createHash(GraphDataDigest.Algorithm)
        for (const record of records.sort())
        {
            hash.update(record)
            hash.update(GraphDataDigest.RecordSeparator)
        }
        return hash.digest(GraphDataDigest.Encoding)
    }

    private static Reachable(graph: IGraphQuery, labels: ReferencedLabelSet): readonly Mirror[]
    {
        if (labels.wildcard || labels.parseFailed) return graph.AllInstances()
        try
        {
            const resolver = new Cypher.GraphQueryAdapter(graph)
            return labels.labels.flatMap(label => graph.InstancesOf(resolver.ResolveConcept(label)))
        }
        catch
        {
            return graph.AllInstances()
        }
    }

    private static Sorted(record: { readonly [key: string]: unknown }): [string, unknown][]
    {
        return Object.keys(record).sort().map(key => [key, record[key]])
    }
}
