import type { Cypher, IInstanceView } from '@pragmatic-tech-ai/todl'
import type { IWriteTargetSource } from '../write-target-source.js'

/** Dev analogue of the filtered-read target source: Reflect over the read-filtered/masked graph. Undefined => absent or hidden. */
export class DevWriteTargetSource implements IWriteTargetSource
{
    constructor(private readonly graph: Cypher.ICypherGraph)
    {
    }

    public async Fetch(concept: string, id: string): Promise<IInstanceView | undefined>
    {
        const mirror = this.graph.Reflect(id)
        if (mirror === undefined) return undefined
        return { Concept: mirror.type?.fullName ?? concept, Field: (name: string) => mirror.field(name)?.value }
    }
}
