import type { IInstanceView } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PragmaticServer } from '../pragmatic-server.js'
import type { IWriteTargetSource } from './write-target-source.js'

/** Reflects an Update/Delete subject through the policy-filtered read graph, one graph built per concept per request. */
export class FilteredReadWriteTargetSource implements IWriteTargetSource
{
    private static readonly HashSep = '#'
    private static readonly DotSep = '.'
    private readonly graphs = new Map<string, Promise<IGraphQuery>>()

    constructor(
        private readonly server: PragmaticServer,
        private readonly context: AccessContext,
        private readonly app: string)
    {
    }

    public async Fetch(concept: string, id: string): Promise<IInstanceView | undefined>
    {
        const graph = await this.GraphFor(concept)
        const mirror = graph.Reflect(id) ?? this.FindBySuffix(graph, concept, id)
        if (mirror === undefined)
        {
            return undefined
        }
        return { Concept: mirror.type?.fullName ?? concept, Field: name => mirror.field(name)?.value }
    }

    /** Graph node ids are qualified (`ns.name`, or `concept#binding#key` for connector-minted rows); a client writes the bare key. */
    private FindBySuffix(graph: IGraphQuery, concept: string, id: string): ReturnType<IGraphQuery['Reflect']>
    {
        return graph.InstancesOf(concept).find(m => m.node.id.endsWith(FilteredReadWriteTargetSource.HashSep + id) || m.node.id.endsWith(FilteredReadWriteTargetSource.DotSep + id))
    }

    private GraphFor(concept: string): Promise<IGraphQuery>
    {
        let graph = this.graphs.get(concept)
        if (graph === undefined)
        {
            graph = this.server.GraphForPragmaticApp(this.context, this.app, { labels: [concept], wildcard: false, parseFailed: false })
            this.graphs.set(concept, graph)
        }
        return graph
    }
}
