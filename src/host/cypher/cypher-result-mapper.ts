import { CypherCells } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherQueryPageDto, CypherNodeCellDto, CypherFieldSnapshotDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { CypherWire } from '@pragmatic-tech-ai/todl'

/** Maps the engine's PascalCase result DTO to the camelCase plain-JSON wire page, carrying the page's continuation cursor. */
export class CypherResultMapper
{
    private static readonly NoOrigin = ''

    public static ToWire(dto: CypherWire.CypherResultDto, nextCursor?: string): CypherQueryPageDto
    {
        const page: CypherQueryPageDto = {
            columns: [...dto.Columns],
            items: dto.Rows.map(row => row.map(cell => CypherResultMapper.Cell(cell))),
            // truncated is always false under paging; clients detect more pages via nextCursor, not this flag
            truncated: dto.Truncated,
        }
        if (nextCursor !== undefined)
        {
            page.nextCursor = nextCursor
        }
        return page
    }

    public static Cell(cell: unknown): CypherCellDto
    {
        if (cell === null || cell === undefined)
        {
            return null
        }
        if (typeof cell === 'string' || typeof cell === 'boolean')
        {
            return cell
        }
        if (typeof cell === 'number')
        {
            return Number.isFinite(cell) ? cell : null
        }
        if (Array.isArray(cell))
        {
            return cell.map(c => CypherResultMapper.Cell(c))
        }
        // Node vs map is decided by the engine's reserved-key discriminator, never by shape (a query can build any map).
        const node = CypherWire.CypherCellCodec.AsNode(cell)
        if (node !== undefined)
        {
            return { [CypherCells.NodeKey]: CypherResultMapper.Node(node as unknown as Record<string, unknown>) } as CypherCellDto
        }
        const entries = CypherWire.CypherCellCodec.AsMap(cell)
        if (entries === undefined)
        {
            return null
        }
        const record: { [k: string]: CypherCellDto } = Object.create(null)
        for (const [key, value] of Object.entries(entries))
        {
            record[key] = CypherResultMapper.Cell(value)
        }
        return CypherResultMapper.EscapeMap(record)
    }

    // The wire reuses the engine's escape: a map whose sole key is reserved travels as { "$map": entries }.
    private static EscapeMap(record: { [k: string]: CypherCellDto }): CypherCellDto
    {
        const keys = Object.keys(record)
        const reserved = keys.length === 1 && (keys[0] === CypherCells.NodeKey || keys[0] === CypherCells.MapKey)
        return reserved ? { [CypherCells.MapKey]: record } : record
    }

    private static Node(node: Record<string, unknown>): CypherNodeCellDto
    {
        const fields: { [name: string]: CypherFieldSnapshotDto } = Object.create(null)
        for (const [name, raw] of Object.entries(node.fields as Record<string, { value?: unknown, definitionOrigin?: string | null, valueOrigin?: string | null }>))
        {
            const value = raw.value
            fields[name] = {
                value: value === undefined || value === null ? null : value as string | number | boolean,
                definitionOrigin: raw.definitionOrigin ?? CypherResultMapper.NoOrigin,
                valueOrigin: raw.valueOrigin ?? CypherResultMapper.NoOrigin,
            }
        }
        const refs: { [name: string]: string[] } = Object.create(null)
        for (const [name, targets] of Object.entries(node.refs as Record<string, string[]>))
        {
            refs[name] = [...targets]
        }
        const result: CypherNodeCellDto = { id: node.id as string, concept: node.concept as string, label: node.label as string, fields, refs }
        if (typeof node.class === 'string')
        {
            result.class = node.class
        }
        if (typeof node.iconKey === 'string')
        {
            result.iconKey = node.iconKey
        }
        return result
    }
}
