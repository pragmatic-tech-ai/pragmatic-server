import type { CypherCellDto, CypherQueryPageDto, CypherNodeCellDto, CypherFieldSnapshotDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { Cypher } from '@pragmatic-tech-ai/todl'

/** Maps the engine's PascalCase result DTO to the camelCase plain-JSON wire page, carrying the page's continuation cursor. */
export class CypherResultMapper
{
    private static readonly NoOrigin = ''

    public static ToWire(dto: Cypher.CypherResultDto, nextCursor?: string): CypherQueryPageDto
    {
        const page: CypherQueryPageDto = {
            columns: [...dto.Columns],
            items: dto.Rows.map(row => row.map(cell => CypherResultMapper.Cell(cell))),
            truncated: dto.Truncated,
        }
        if (nextCursor !== undefined)
        {
            page.nextCursor = nextCursor
        }
        return page
    }

    private static Cell(cell: unknown): CypherCellDto
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
        if (typeof cell === 'object')
        {
            if (CypherResultMapper.IsNode(cell))
            {
                return CypherResultMapper.Node(cell)
            }
            const record: { [k: string]: CypherCellDto } = Object.create(null)
            for (const [key, value] of Object.entries(cell))
            {
                record[key] = CypherResultMapper.Cell(value)
            }
            return record
        }
        return null
    }

    private static IsNode(cell: object): cell is Record<string, unknown>
    {
        const c = cell as Record<string, unknown>
        return typeof c.id === 'string' && typeof c.concept === 'string' && typeof c.label === 'string'
            && typeof c.fields === 'object' && c.fields !== null && typeof c.refs === 'object' && c.refs !== null
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
