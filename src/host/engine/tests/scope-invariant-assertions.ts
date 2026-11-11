import assert from 'node:assert/strict'
import { CypherCells } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherNodeCellDto, EntityDto, ModelMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * What the spec §12 assertions need to know about one principal, computed by each suite from the engine and the
 * identity evaluator alone (never through endpoint code).
 */
export interface IExpectedVisibility
{
    /** Whether the tenant's field security lets the principal read `field` of `concept`. */
    CanRead(concept: string, field: string): boolean
    /** The concept whose field security governs a model/view member, or undefined for structure (schema, models). */
    MemberConcept(id: string): string | undefined
}

/** Endpoint labels and assertion messages of the scope-invariant suites. */
export class InvariantText
{
    public static readonly NoModel = '(no model)'
    public static readonly CypherQuery = 'cypher/query'
    public static readonly CypherExecute = 'cypher/execute'
    public static readonly ModelView = 'model/view'
    public static readonly Resources = 'model/resources'
    public static readonly ConnectorRead = 'connector/read'
    public static readonly ConnectorReadPage = 'connector/readPage'
    public static readonly ListShares = 'data/shares/list'
    public static readonly Space = ' '
    public static readonly Nothing = ''
    public static readonly Colon = ': '
    public static readonly Arrow = ' -> '
    public static readonly Of = ' of '
    public static readonly Node = 'node '
    public static readonly Member = 'member '
    public static readonly Entity = 'entity '
    public static readonly Record = 'shared record '
    public static readonly OutsideScope = ' is outside the scope'
    public static readonly Field = 'unreadable field '
    public static readonly Ref = 'unreadable ref member '
    public static readonly RefTarget = 'ref to a hidden node '
    public static readonly RelEnd = 'relationship end outside the scope '
    public static readonly Attr = 'unreadable attr '
    public static readonly Edge = 'edge to a hidden node '
    public static readonly EdgeVia = 'unreadable edge member '
    public static readonly Projected = 'projected unreadable '
    public static readonly FilterLeak = 'a filter on an unreadable attribute selected rows'
    public static readonly NotApplied = 'statement was not applied'
    public static readonly NoTenantAuthorization = 'the security-model reload is not the tenant read authorization'
    public static readonly ModelCount = 'the fixture has two models'
    /** Common to every unreadable-member message (Field, Ref, Attr, EdgeVia, Projected). */
    public static readonly Unreadable = 'unreadable '

    /** True for an invariant violation (a node outside the scope, an unreadable member, a ref to a hidden node), never another assertion. */
    public static IsViolation(error: unknown): boolean
    {
        if (!(error instanceof assert.AssertionError)) return false
        return [InvariantText.OutsideScope, InvariantText.Unreadable, InvariantText.RefTarget, InvariantText.RelEnd].some(text => error.message.includes(text))
    }

    public static At(...parts: string[]): string
    {
        return parts.join(InvariantText.Space)
    }

    public static Says(where: string, ...parts: string[]): string
    {
        return where + InvariantText.Colon + parts.join(InvariantText.Nothing)
    }
}

/** What an answer held, so the invariant is never vacuously true. */
export class Coverage
{
    public Nodes = 0
    public Rels = 0
    public SecretValues = 0
    public Members = 0
    public Entities = 0
    public Shares = 0
    public Resources = 0
    public Applied = 0
}

/** The assertions every endpoint's answer must pass (spec §12), shared by the dev and the runtime suites. */
export class Invariant
{
    private static readonly RelFrom = 'from'
    private static readonly RelTo = 'to'
    private static readonly RelType = 'type'
    private static readonly RelKeys = [Invariant.RelFrom, Invariant.RelTo, Invariant.RelType]

    /** Every node cell anywhere in `rows` (lists, maps, paths) and every relationship cell's two ends. */
    public static CypherRows(rows: readonly (readonly CypherCellDto[])[], visible: ReadonlySet<string>, expected: IExpectedVisibility, where: string, seen: Coverage): void
    {
        for (const row of rows)
        {
            for (const cell of row) Invariant.Cell(cell, visible, expected, where, seen)
        }
    }

    /** A projected `field` column (column 1 beside the node in column 0): a non-null value needs a readable attribute on the row's node. */
    public static ProjectedField(rows: readonly (readonly CypherCellDto[])[], field: string, expected: IExpectedVisibility, where: string, seen: Coverage): void
    {
        for (const row of rows)
        {
            const node = CypherCells.AsNode(row[0])!
            if (row[1] === null) continue
            seen.SecretValues += 1
            assert.ok(expected.CanRead(node.concept, field), InvariantText.Says(where, InvariantText.Projected, field, InvariantText.Of, node.id))
        }
    }

    /**
     * A model/view member the engine holds (or a term / class node the suite knows): in `visible`, attrs and edge members
     * readable for its own concept, edge targets visible. Other members (schema, models) are structure.
     */
    public static ModelMember(member: ModelMemberDto, visible: ReadonlySet<string>, expected: IExpectedVisibility, where: string): boolean
    {
        const concept = expected.MemberConcept(member.id)
        if (concept === undefined) return false
        assert.ok(visible.has(member.id), InvariantText.Says(where, InvariantText.Member, member.id, InvariantText.OutsideScope))
        for (const field of Object.keys(member.attrs))
        {
            assert.ok(expected.CanRead(concept, field), InvariantText.Says(where, InvariantText.Attr, field, InvariantText.Of, member.id))
        }
        for (const edge of member.edges)
        {
            if (expected.MemberConcept(edge.to) !== undefined)
            {
                assert.ok(visible.has(edge.to), InvariantText.Says(where, InvariantText.Edge, member.id, InvariantText.Arrow, edge.to))
            }
            if (edge.via !== null) assert.ok(expected.CanRead(concept, edge.via), InvariantText.Says(where, InvariantText.EdgeVia, edge.via, InvariantText.Of, member.id))
        }
        return true
    }

    /** A connector entity: its id in `visible`, every field readable for its concept. */
    public static Entities(items: readonly EntityDto[], visible: ReadonlySet<string>, expected: IExpectedVisibility, where: string, seen: Coverage): void
    {
        for (const entity of items)
        {
            seen.Entities += 1
            assert.ok(visible.has(entity.id), InvariantText.Says(where, InvariantText.Entity, entity.id, InvariantText.OutsideScope))
            for (const field of Object.keys(entity.fields))
            {
                assert.ok(expected.CanRead(entity.concept, field), InvariantText.Says(where, InvariantText.Field, field, InvariantText.Of, entity.id))
            }
        }
    }

    private static Cell(cell: CypherCellDto | undefined, visible: ReadonlySet<string>, expected: IExpectedVisibility, where: string, seen: Coverage): void
    {
        const node = CypherCells.AsNode(cell)
        if (node !== undefined)
        {
            seen.Nodes += 1
            Invariant.Node(node, visible, expected, where)
            return
        }
        if (Array.isArray(cell))
        {
            for (const item of cell) Invariant.Cell(item, visible, expected, where, seen)
            return
        }
        const map = CypherCells.AsMap(cell)
        if (map === undefined) return
        if (Invariant.IsRel(map))
        {
            seen.Rels += 1
            for (const end of [map[Invariant.RelFrom] as string, map[Invariant.RelTo] as string])
            {
                assert.ok(visible.has(end), InvariantText.Says(where, InvariantText.RelEnd, end))
            }
            return
        }
        for (const value of Object.values(map)) Invariant.Cell(value, visible, expected, where, seen)
    }

    private static Node(node: CypherNodeCellDto, visible: ReadonlySet<string>, expected: IExpectedVisibility, where: string): void
    {
        assert.ok(visible.has(node.id), InvariantText.Says(where, InvariantText.Node, node.id, InvariantText.OutsideScope))
        for (const field of Object.keys(node.fields))
        {
            assert.ok(expected.CanRead(node.concept, field), InvariantText.Says(where, InvariantText.Field, field, InvariantText.Of, node.id))
        }
        for (const [member, targets] of Object.entries(node.refs))
        {
            assert.ok(expected.CanRead(node.concept, member), InvariantText.Says(where, InvariantText.Ref, member, InvariantText.Of, node.id))
            for (const target of targets) assert.ok(visible.has(target), InvariantText.Says(where, InvariantText.RefTarget, node.id, InvariantText.Arrow, target))
        }
    }

    private static IsRel(map: { [k: string]: CypherCellDto }): boolean
    {
        const keys = Object.keys(map).sort()
        return keys.length === Invariant.RelKeys.length && keys.every((key, i) => key === Invariant.RelKeys[i] && typeof map[key] === 'string')
    }
}
