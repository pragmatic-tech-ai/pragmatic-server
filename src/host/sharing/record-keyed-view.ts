import type { IInstanceView } from '@pragmatic-tech-ai/todl'

/** An instance view that also carries the record key derived from the graph node id (connector/built-in rows hold their id there, not in a field). */
export interface IRecordKeyedView extends IInstanceView
{
    readonly RecordKey: string | undefined
}

/** Derives a record key from a graph node id: `concept#binding#key` => key; `ns.name` => name. */
export class RecordKey
{
    private static readonly HashSep = '#'
    private static readonly DotSep = '.'

    public static FromNodeId(nodeId: string): string | undefined
    {
        const hash = nodeId.lastIndexOf(RecordKey.HashSep)
        const key = hash >= 0 ? nodeId.substring(hash + 1) : nodeId.substring(nodeId.lastIndexOf(RecordKey.DotSep) + 1)
        return key.length === 0 ? undefined : key
    }

    public static Of(view: IInstanceView): string | undefined
    {
        return (view as Partial<IRecordKeyedView>).RecordKey
    }
}
