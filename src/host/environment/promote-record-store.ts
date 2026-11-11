import { randomUUID } from 'node:crypto'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * The promote record of a runtime environment: `graphs/loaded-graph.json`, the last promoted set (`graph/load`) as
 * refs only. It is both the input of `graph/loaded` and the environment's Promote delivery (ruling S3); it survives a
 * restart, and a re-promote overwrites it atomically (temp file + rename).
 */
export class PromoteRecordStore
{
    private static readonly FileName = 'loaded-graph.json'
    private static readonly TempPrefix = '.loaded-graph-'
    private static readonly TempSuffix = '.tmp'

    public constructor(private readonly storage: IStorage)
    {
    }

    public async Save(record: GraphLoadedDto): Promise<void>
    {
        const temp = PromoteRecordStore.TempPrefix + randomUUID() + PromoteRecordStore.TempSuffix
        await this.storage.WriteText(temp, JSON.stringify(record, null, 2))
        await this.storage.Rename(temp, PromoteRecordStore.FileName)
    }

    /** The persisted record, or null when nothing was ever promoted. */
    public async Read(): Promise<GraphLoadedDto | null>
    {
        if (!(await this.storage.Exists(PromoteRecordStore.FileName)))
        {
            return null
        }
        return JSON.parse(await this.storage.ReadText(PromoteRecordStore.FileName)) as GraphLoadedDto
    }
}
