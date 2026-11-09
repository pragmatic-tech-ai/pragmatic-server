import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { AccessScope as EngineScope, CellValue, GraphEngine } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, CypherCells, InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherNodeCellDto, ModelMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessLevel, OwnershipSourceKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, IPrivilegeConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { FieldSecurityEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantReadAuthorization } from '../../cypher/read-filter-source.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'

/**
 * Spec §12: no endpoint returns a row or member outside its AccessScope. One dev tenant, three principals (one the
 * security model does not know, a BusinessUnit-level reader/writer, an Organization-level reader/writer holding the
 * secured-field profile); every dev read endpoint, and cypher/execute RETURN after writes, is asked over the wire.
 * Every instance id an answer holds must be in the set the ENGINE shows that principal (GraphReader.ScanNodes under
 * DevAccessScopeSource.ScopeFor(ctx).Scope, intersected for a model-scoped read with an independently built
 * Or(ConceptIs todl.Term, OwnerIs model) scope), every attribute readable under the tenant's FieldSecurityEvaluator.
 * The expected sets are computed from the engine and the identity evaluator directly, never through endpoint code.
 */

/** The fixture: names, model text, the security model and the statements every principal runs. */
class InvariantFx
{
    public static readonly Root = 'todl.Element'
    public static readonly Term = 'todl.Term'
    public static readonly Widget = 'acme.Widget'
    public static readonly Gadget = 'acme.Gadget'
    public static readonly Gizmo = 'acme.Gizmo'
    public static readonly Concepts = [InvariantFx.Widget, InvariantFx.Gadget, InvariantFx.Gizmo]
    public static readonly Big = 'acme.Kinds.Big'
    public static readonly Premium = 'acme.Premium'
    public static readonly A1 = 'acme.a1'
    public static readonly A2 = 'acme.a2'
    public static readonly G1 = 'acme.g1'
    public static readonly B1 = 'acme.b1'
    public static readonly Z1 = 'acme.z1'
    public static readonly ShopA = 'acme.ShopA'
    public static readonly ShopB = 'acme.ShopB'
    public static readonly Instances = [InvariantFx.A1, InvariantFx.A2, InvariantFx.G1, InvariantFx.B1, InvariantFx.Z1]
    /** Hard-coded model membership of the fixture instances. */
    public static readonly Membership: ReadonlyMap<string, readonly string[]> = new Map([
        [InvariantFx.ShopA, [InvariantFx.A1, InvariantFx.A2, InvariantFx.G1]],
        [InvariantFx.ShopB, [InvariantFx.B1, InvariantFx.Z1]],
    ])
    public static readonly Secret = 'secret'
    public static readonly Code = 'code'
    public static readonly OwningBu = PpSecurityHarness.OwningBuField
    public static readonly Label = 'label'
    public static readonly Link = 'link'
    public static readonly Peer = 'peer'
    public static readonly PremiumLabel = 'premium'
    public static readonly PremiumSecret = 'c0'
    public static readonly IconPath = 'resources/big.svg'
    public static readonly NoProfile = 'p-none'
    public static readonly BuReader = 'p-bu'
    public static readonly OrgReader = 'p-org'
    public static readonly ModelsDir = 'models'
    public static readonly ModelFileName = 'model.todl'
    public static readonly NoConnectors = 'no connectors'
    public static readonly ModelViewPageSize = 2
    public static readonly SolutionPrefix = 'inv-sol-'
    public static readonly PackagesPrefix = 'inv-pkgs-'
    public static readonly IdentityPrefix = 'inv-id-'
    private static readonly BuRole = 'bu-reader'
    private static readonly OrgRole = 'org-reader'
    private static readonly RoleName = 'Reader'
    private static readonly ProfileId = 'secret-readers'
    private static readonly ProfileName = 'Secret readers'
    private static readonly RootName = 'Root'
    private static readonly SalesName = 'Sales'

    /** Read statements: every node, a traversal returning its relationship and path, a projection, a secured filter. */
    public static readonly AllNodes = 'MATCH (n) RETURN n'
    public static readonly Traversal = 'MATCH (a)-[r]->(b) RETURN a, r, b'
    public static readonly Paths = 'MATCH p = (a)-[*1..2]->(b) RETURN p'
    public static readonly Projection = 'MATCH (w:Widget) RETURN w, w.secret AS s'
    public static readonly SecretFilter = 'MATCH (w:Widget) WHERE w.secret IS NOT NULL RETURN w'
    public static readonly Reads = [InvariantFx.AllNodes, InvariantFx.Traversal, InvariantFx.Paths, InvariantFx.Projection, InvariantFx.SecretFilter]
    /**
     * Write-and-return statements cypher/execute runs per model before the principal's expected sets are taken. Writes
     * are confined to the model id (a write to another model's instance is Denied), so each touch names an instance
     * of its own model; the RETURN rows still read tenant-wide.
     */
    public static readonly TouchA = "MATCH (w:Widget {label: 'alpha'}) SET w.label = w.label RETURN w"
    public static readonly TouchB = "MATCH (w:Widget {label: 'gamma'}) SET w.label = w.label RETURN w"
    public static readonly Create = `CREATE (w:Widget {owningBu: '${PpSecurityHarness.SalesBu}', label: 'made'}) RETURN w`
    public static readonly Writes: ReadonlyMap<string, readonly string[]> = new Map([
        [InvariantFx.ShopA, [InvariantFx.TouchA, InvariantFx.Create]],
        [InvariantFx.ShopB, [InvariantFx.TouchB, InvariantFx.Create]],
    ])

    /**
     * Widget (secured `secret`), Gadget : Widget (secures nothing, so its inherited `secret` is readable: field security
     * is exact per concept), Gizmo : Widget (secures its own `code`); a term Big with an icon and a class node Premium
     * with attrs. ShopA: a1 (sales; peer -> a2 in root, link -> b1 in ShopB), a2 (root), g1 (Gadget, sales);
     * ShopB: b1 (sales), z1 (Gizmo, sales).
     */
    public static Todl(): string
    {
        const bu = InvariantFx.OwningBu
        const sales = PpSecurityHarness.SalesBu
        const root = PpSecurityHarness.RootBu
        return `namespace acme { concept Widget { ${bu} : string?; secret : string?; relationship peer -> Widget?; relationship link -> Widget?; } `
            + 'concept Gadget : Widget { } concept Gizmo : Widget { code : string?; } '
            + `taxonomy Kinds : represents Widget { term Big { annotate icon { path = "${InvariantFx.IconPath}"; } } } `
            + `class Widget Premium { ${bu} = "${sales}"; label = "${InvariantFx.PremiumLabel}"; secret = "${InvariantFx.PremiumSecret}"; } `
            + `model ShopA : acme { Widget a1 { ${bu} = "${sales}"; label = "alpha"; secret = "s1"; peer = a2; link = b1; } `
            + `Widget a2 { ${bu} = "${root}"; label = "beta"; secret = "s2"; } `
            + `Gadget g1 { ${bu} = "${sales}"; label = "gadget"; secret = "s4"; } } `
            + `model ShopB : acme { Widget b1 { ${bu} = "${sales}"; label = "gamma"; secret = "s3"; } `
            + `Gizmo z1 { ${bu} = "${sales}"; label = "gizmo"; secret = "s5"; code = "k1"; } } }`
    }

    /** BuReader reads/writes Widget, Gadget and Gizmo at BusinessUnit level from sales; OrgReader org-wide with the `secret` profile; NoProfile is unknown. */
    public static SecurityModel(): ISecurityModelConfig
    {
        const fromField = { kind: OwnershipSourceKind.FromField, value: InvariantFx.OwningBu }
        const actions = [PrivilegeAction.Read, PrivilegeAction.Create, PrivilegeAction.Update]
        // privileges are exact per concept (DepthScopeCompiler), so each subconcept is granted alongside Widget
        const privileges = (level: AccessLevel): IPrivilegeConfig[] => InvariantFx.Concepts.flatMap(concept => actions.map(action => ({ action, concept, level })))
        const member = (principalId: string) => ({ principalId, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] })
        return {
            businessUnits: [
                { id: PpSecurityHarness.RootBu, name: InvariantFx.RootName },
                { id: PpSecurityHarness.SalesBu, name: InvariantFx.SalesName, parent: PpSecurityHarness.RootBu },
            ],
            teams: [],
            membership: { claimsMapping: [], overrides: [member(InvariantFx.BuReader), member(InvariantFx.OrgReader)] },
            ownershipRules: InvariantFx.Concepts.map(concept => ({ concept, owningBusinessUnit: fromField })),
            roles: [
                { id: InvariantFx.BuRole, name: InvariantFx.RoleName, privileges: privileges(AccessLevel.BusinessUnit) },
                { id: InvariantFx.OrgRole, name: InvariantFx.RoleName, privileges: privileges(AccessLevel.Organization) },
            ],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: InvariantFx.BuReader, roles: [InvariantFx.BuRole] },
                { principalId: InvariantFx.OrgReader, roles: [InvariantFx.OrgRole] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: InvariantFx.Widget, field: InvariantFx.Secret }, { concept: InvariantFx.Gizmo, field: InvariantFx.Code }],
                profiles: [{ id: InvariantFx.ProfileId, name: InvariantFx.ProfileName, grants: [{ concept: InvariantFx.Widget, field: InvariantFx.Secret, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: InvariantFx.OrgReader, profiles: [InvariantFx.ProfileId] }] },
            },
        }
    }

    /** The class node Premium as a hypothetical Widget, its property values spelled out from the fixture text. */
    public static PremiumProperties(): ReadonlyMap<string, CellValue>
    {
        return new Map<string, CellValue>([
            [InvariantFx.OwningBu, PpSecurityHarness.SalesBu],
            [InvariantFx.Label, InvariantFx.PremiumLabel],
            [InvariantFx.Secret, InvariantFx.PremiumSecret],
        ])
    }
}

/** Endpoint labels and assertion messages. */
class InvariantText
{
    public static readonly NoModel = '(no model)'
    public static readonly CypherQuery = 'cypher/query'
    public static readonly CypherExecute = 'cypher/execute'
    public static readonly ModelView = 'model/view'
    public static readonly Resources = 'model/resources'
    public static readonly Space = ' '
    public static readonly Nothing = ''
    public static readonly Colon = ': '
    public static readonly Arrow = ' -> '
    public static readonly Of = ' of '
    public static readonly Node = 'node '
    public static readonly Member = 'member '
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
    public static readonly NoTenantAuthorization = 'the field-read mask source is not the tenant read authorization'
    public static readonly ModelCount = 'the fixture has two models'

    public static At(...parts: string[]): string
    {
        return parts.join(InvariantText.Space)
    }

    public static Says(where: string, ...parts: string[]): string
    {
        return where + InvariantText.Colon + parts.join(InvariantText.Nothing)
    }
}

/**
 * What one principal may see, computed from the engine and the identity evaluator alone:
 * - `Cypher`: the ids `ScanNodes(todl.Element)` yields under the principal's scope (tenant-wide reads, and every
 *   cypher/execute read, which stays tenant-wide);
 * - `ModelOf(id)`: `Cypher` intersected with the ids a scan under `Or(ConceptIs todl.Term, OwnerIs id)` alone yields
 *   (deny-wins conjunction, built here without endpoint code);
 * - `ModelView`: `Cypher` without the term and the class node, plus each of them the engine admits as a hypothetical
 *   node of its represented concept (`GraphReader.Admits` on its fixture values): model/view judges them that way;
 * - `Held` / `ConceptOf`: every node the engine holds and its concept (unscoped), to tell instances from structure.
 */
class ExpectedVisibility
{
    private constructor(
        public readonly Cypher: ReadonlySet<string>,
        private readonly models: ReadonlyMap<string, ReadonlySet<string>>,
        public readonly ModelView: ReadonlySet<string>,
        private readonly concepts: ReadonlyMap<string, string>,
        private readonly fields: FieldSecurityEvaluator,
        private readonly context: AccessContext)
    {
    }

    public get Held(): ReadonlySet<string>
    {
        return new Set(this.concepts.keys())
    }

    public static async Of(server: PragmaticServer, context: AccessContext, models: readonly string[]): Promise<ExpectedVisibility>
    {
        const engine = await server.DevEngine().Engine()
        const scope = (await (await server.DevScopes()).ScopeFor(context)).Scope
        const cypher = await ExpectedVisibility.Scan(engine, scope)
        const perModel = new Map<string, ReadonlySet<string>>()
        for (const model of models)
        {
            const owned = await ExpectedVisibility.Scan(engine, ExpectedVisibility.ModelScope(model))
            perModel.set(model, new Set([...cypher].filter(id => owned.has(id))))
        }
        const concepts = await ExpectedVisibility.Concepts(engine)
        const typed = [InvariantFx.Big, InvariantFx.Premium]
        const modelView = new Set([...cypher].filter(id => !typed.includes(id)))
        const reader = await engine.BeginRead(scope)
        try
        {
            if (reader.Admits(InvariantFx.Widget, new Map())) modelView.add(InvariantFx.Big)
            if (reader.Admits(InvariantFx.Widget, InvariantFx.PremiumProperties())) modelView.add(InvariantFx.Premium)
        }
        finally
        {
            reader.dispose()
        }
        const authorization = await server.FieldReadMaskSource()
        assert.ok(authorization instanceof TenantReadAuthorization, InvariantText.NoTenantAuthorization)
        const fields = (await authorization.EvaluatorForContext(context)).FieldSecurity()
        return new ExpectedVisibility(cypher, perModel, modelView, concepts, fields, context)
    }

    /** The cypher set for a read scoped to `model` (tenant-wide without one). */
    public CypherFor(model: string | undefined): ReadonlySet<string>
    {
        return model === undefined ? this.Cypher : this.models.get(model)!
    }

    /** The concept whose field security governs a model/view member's attrs: a term or class node by its represented concept. */
    public MemberConcept(id: string): string | undefined
    {
        if (id === InvariantFx.Big || id === InvariantFx.Premium) return InvariantFx.Widget
        return this.concepts.get(id)
    }

    /** The engine's own concept of a held node (unscoped). */
    public EngineConcept(id: string): string | undefined
    {
        return this.concepts.get(id)
    }

    /** Whether the tenant's field security lets the principal read `field` of `concept`. */
    public CanRead(concept: string, field: string): boolean
    {
        return this.fields.CanReadField(this.context.Principal, concept, field)
    }

    private static ModelScope(model: string): EngineScope
    {
        const owned = new Or([new ConceptIs(InvariantFx.Term), new OwnerIs(new Set([model]))])
        return AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[InvariantFx.Root, owned]]) })
    }

    private static async Scan(engine: GraphEngine, scope: EngineScope): Promise<Set<string>>
    {
        const reader = await engine.BeginRead(scope)
        try
        {
            const ids = new Set<string>()
            for await (const id of reader.ScanNodes(InvariantFx.Root)) ids.add(id)
            return ids
        }
        finally
        {
            reader.dispose()
        }
    }

    private static async Concepts(engine: GraphEngine): Promise<Map<string, string>>
    {
        const reader = await engine.BeginRead(AccessScope.System)
        try
        {
            const concepts = new Map<string, string>()
            for await (const id of reader.ScanNodes(InvariantFx.Root)) concepts.set(id, (await reader.ConceptOf(id))!)
            return concepts
        }
        finally
        {
            reader.dispose()
        }
    }
}

/** What an answer held, so the invariant is never vacuously true. */
class Coverage
{
    public Nodes = 0
    public Rels = 0
    public SecretValues = 0
    public Members = 0
    public Resources = 0
    public Applied = 0
}

/** The assertions every endpoint's answer must pass. */
class Invariant
{
    private static readonly RelFrom = 'from'
    private static readonly RelTo = 'to'
    private static readonly RelType = 'type'
    private static readonly RelKeys = [Invariant.RelFrom, Invariant.RelTo, Invariant.RelType]

    /** Every node cell anywhere in `rows` (lists, maps, paths) and every relationship cell's two ends. */
    public static CypherRows(rows: readonly (readonly CypherCellDto[])[], visible: ReadonlySet<string>, expected: ExpectedVisibility, where: string, seen: Coverage): void
    {
        for (const row of rows)
        {
            for (const cell of row) Invariant.Cell(cell, visible, expected, where, seen)
        }
    }

    /** A projected `secret` column: a non-null value needs a readable attribute on the row's node. */
    public static ProjectedSecret(rows: readonly (readonly CypherCellDto[])[], expected: ExpectedVisibility, where: string, seen: Coverage): void
    {
        for (const row of rows)
        {
            const node = CypherCells.AsNode(row[0])!
            if (row[1] === null) continue
            seen.SecretValues += 1
            assert.ok(expected.CanRead(node.concept, InvariantFx.Secret), InvariantText.Says(where, InvariantText.Projected, InvariantFx.Secret, InvariantText.Of, node.id))
        }
    }

    /**
     * A model/view member the engine holds (or the fixture's term / class node): in the principal's model/view set, attrs
     * and edge members readable for its own concept, edge targets visible. Other members (schema, models) are structure.
     */
    public static ModelMember(member: ModelMemberDto, expected: ExpectedVisibility, where: string): boolean
    {
        const concept = expected.MemberConcept(member.id)
        if (concept === undefined) return false
        assert.ok(expected.ModelView.has(member.id), InvariantText.Says(where, InvariantText.Member, member.id, InvariantText.OutsideScope))
        for (const field of Object.keys(member.attrs))
        {
            assert.ok(expected.CanRead(concept, field), InvariantText.Says(where, InvariantText.Attr, field, InvariantText.Of, member.id))
        }
        for (const edge of member.edges)
        {
            if (expected.MemberConcept(edge.to) !== undefined)
            {
                assert.ok(expected.ModelView.has(edge.to), InvariantText.Says(where, InvariantText.Edge, member.id, InvariantText.Arrow, edge.to))
            }
            if (edge.via !== null) assert.ok(expected.CanRead(concept, edge.via), InvariantText.Says(where, InvariantText.EdgeVia, edge.via, InvariantText.Of, member.id))
        }
        return true
    }

    private static Cell(cell: CypherCellDto | undefined, visible: ReadonlySet<string>, expected: ExpectedVisibility, where: string, seen: Coverage): void
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

    private static Node(node: CypherNodeCellDto, visible: ReadonlySet<string>, expected: ExpectedVisibility, where: string): void
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

/** One started dev server with identity, the fixture solution open and the security model seeded. */
class InvariantWorld
{
    private readonly clients: PragmaticClient[] = []
    private readonly handlers: ServerConnectionHandler[] = []

    private constructor(public readonly Server: PragmaticServer, private readonly language: SolutionLanguageService, private readonly manager: SolutionManagerService)
    {
    }

    public static async Run(body: (world: InvariantWorld) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), InvariantFx.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), InvariantFx.PackagesPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), InvariantFx.IdentityPrefix))
        cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, InvariantFx.ModelsDir, InvariantFx.ModelFileName), InvariantFx.Todl())
        PpSecurityHarness.SetKey()
        const server = new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
        let world: InvariantWorld | undefined
        try
        {
            await server.Start()
            await server.OpenSolution(solution)
            await PpSecurityHarness.Seed(server, InvariantFx.SecurityModel())
            const language = await server.LanguageService() as SolutionLanguageService
            await language.WhenIdle()
            world = new InvariantWorld(server, language, await server.Manager())
            await body(world)
        }
        finally
        {
            await world?.Dispose()
            if (world === undefined) await server.Dispose()
            PpSecurityHarness.ClearKey()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
            rmSync(identityRoot, { recursive: true, force: true })
        }
    }

    public get MemberId(): string
    {
        return this.manager.ActiveSolution!.Members.ToArray()[0]!.Ref.path
    }

    /** A client over a handler attached exactly as the host attaches a development connection. */
    public async Connect(context: AccessContext): Promise<PragmaticClient>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const server = this.Server
        const development = ServerConnectionHandler.DevelopmentAttachArgs(server)
        const fieldMasks = await server.FieldReadMaskSource()
        const handler = ServerConnectionHandler.Attach(serverSocket, this.language, this.manager, context, () => Promise.reject(new Error(InvariantFx.NoConnectors)), development.devCypher,
            undefined, undefined, undefined, undefined, undefined, undefined, server.Purpose(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            fieldMasks, ctx => server.ConnectorReadAuthorizationFor(ctx), (ctx, target) => server.ConnectorWriteAuthorizationFor(ctx, target), (ctx, id, request) => server.ExecuteCypher(ctx, id, request),
            undefined, development.devGraphService, undefined, development.devEngine, development.devModelView)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.handlers.push(handler)
        this.clients.push(client)
        return client
    }

    private async Dispose(): Promise<void>
    {
        for (const client of this.clients) await client.DisposeAsync()
        for (const handler of this.handlers) handler.Dispose()
        await this.language.WhenIdle()
        await this.manager.CloseSolution()
        await this.Server.Dispose()
    }
}

/** The tenant-wide and per-model `MATCH (n) RETURN n` rows one sweep saw, for the cross-model checks. */
class SweepRows
{
    public readonly AllNodes = new Map<string, CypherNodeCellDto[]>()

    public Node(model: string | undefined, id: string): CypherNodeCellDto | undefined
    {
        return this.AllNodes.get(model ?? InvariantText.NoModel)?.find(node => node.id === id)
    }
}

/**
 * Runs every endpoint for one client and judges each answer by the expected visibility of `judge` (the client's own
 * principal, or another one for the negative control). With `writes`, the write-and-return statements run first, so
 * the expected sets are taken after them and include what they created.
 */
class PrincipalSweep
{
    public readonly Seen = new Coverage()
    public readonly Rows = new SweepRows()
    public Expected: ExpectedVisibility | undefined

    public constructor(private readonly world: InvariantWorld, private readonly client: PragmaticClient, private readonly judge: AccessContext, private readonly models: readonly string[], private readonly writes: boolean)
    {
    }

    public async Run(): Promise<void>
    {
        const written: { where: string; rows: CypherCellDto[][] }[] = []
        if (this.writes)
        {
            for (const model of this.models)
            {
                for (const statement of InvariantFx.Writes.get(model) ?? [])
                {
                    const result = await this.client.CypherExecute(statement, undefined, model)
                    if (result.status === AppWriteStatus.Applied) this.Seen.Applied += 1
                    written.push({ where: InvariantText.At(InvariantText.CypherExecute, model, statement), rows: result.rows })
                }
            }
        }
        const expected = await ExpectedVisibility.Of(this.world.Server, this.judge, this.models)
        this.Expected = expected
        for (const write of written) Invariant.CypherRows(write.rows, expected.Cypher, expected, write.where, this.Seen)
        await this.CypherQuery(expected)
        await this.CypherExecute(expected)
        await this.ModelView(expected)
        await this.Resources(expected)
    }

    private async CypherQuery(expected: ExpectedVisibility): Promise<void>
    {
        for (const model of [undefined, ...this.models])
        {
            for (const query of InvariantFx.Reads)
            {
                const where = InvariantText.At(InvariantText.CypherQuery, model ?? InvariantText.NoModel, query)
                const rows: CypherCellDto[][] = []
                for await (const page of this.client.QueryAll(query, undefined, undefined, model)) rows.push(...page.items)
                this.Check(rows, query, expected.CypherFor(model), expected, where)
                if (query === InvariantFx.AllNodes) this.Rows.AllNodes.set(model ?? InvariantText.NoModel, rows.flatMap(row => [CypherCells.AsNode(row[0])!]))
            }
        }
    }

    /** cypher/execute reads stay tenant-wide even under a model id (only its writes are confined). */
    private async CypherExecute(expected: ExpectedVisibility): Promise<void>
    {
        for (const model of this.models)
        {
            for (const query of InvariantFx.Reads)
            {
                const where = InvariantText.At(InvariantText.CypherExecute, model, query)
                const result = await this.client.CypherExecute(query, undefined, model)
                assert.equal(result.status, AppWriteStatus.Applied, InvariantText.Says(where, InvariantText.NotApplied))
                this.Check(result.rows, query, expected.Cypher, expected, where)
            }
        }
    }

    private Check(rows: CypherCellDto[][], query: string, visible: ReadonlySet<string>, expected: ExpectedVisibility, where: string): void
    {
        Invariant.CypherRows(rows, visible, expected, where, this.Seen)
        if (query === InvariantFx.Projection) Invariant.ProjectedSecret(rows, expected, where, this.Seen)
        if (query === InvariantFx.SecretFilter)
        {
            // only Widget secures `secret` (field security is exact per concept): an unreadable one may match a Gadget/Gizmo row, never a Widget row
            const widgets = rows.filter(row => CypherCells.AsNode(row[0])!.concept === InvariantFx.Widget)
            if (!expected.CanRead(InvariantFx.Widget, InvariantFx.Secret)) assert.deepEqual(widgets, [], InvariantText.Says(where, InvariantText.FilterLeak))
        }
    }

    private async ModelView(expected: ExpectedVisibility): Promise<void>
    {
        let cursor: string | undefined
        do
        {
            const page = await this.client.ModelView(this.world.MemberId, { cursor, pageSize: InvariantFx.ModelViewPageSize })
            for (const member of page.items)
            {
                if (Invariant.ModelMember(member, expected, InvariantText.ModelView)) this.Seen.Members += 1
            }
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
    }

    private async Resources(expected: ExpectedVisibility): Promise<void>
    {
        for (const id of [...expected.Held, InvariantFx.Big, InvariantFx.Premium])
        {
            const resources = await this.client.Resources(id)
            if (resources.length > 0) assert.ok(expected.ModelView.has(id), InvariantText.Says(InvariantText.Resources, InvariantText.Node, id, InvariantText.OutsideScope))
            this.Seen.Resources += resources.length
        }
    }
}

describe('scope invariant: no dev endpoint returns a row or member outside its AccessScope (spec §12)', () =>
{
    test('three principals across cypher/query (with and without modelId), cypher/execute RETURN (reads and writes), model/view and model/resources', async () =>
    {
        await InvariantWorld.Run(async world =>
        {
            const models = [...await world.Server.DevCypher().Models()]
            assert.deepEqual([...InvariantFx.Membership.keys()].filter(model => models.includes(model)), [...InvariantFx.Membership.keys()], InvariantText.ModelCount)
            const sweeps = new Map<string, PrincipalSweep>()
            for (const principal of [InvariantFx.NoProfile, InvariantFx.BuReader, InvariantFx.OrgReader])
            {
                const context = PpSecurityHarness.Context(principal)
                const sweep = new PrincipalSweep(world, await world.Connect(context), context, models, true)
                await sweep.Run()
                sweeps.set(principal, sweep)
            }
            const none = sweeps.get(InvariantFx.NoProfile)!
            const bu = sweeps.get(InvariantFx.BuReader)!
            const org = sweeps.get(InvariantFx.OrgReader)!
            const fixtureIn = (set: ReadonlySet<string>): string[] => InvariantFx.Instances.filter(id => set.has(id))

            // the engine-visible sets: unknown sees no instance, BU the sales ones, org all of them
            assert.deepEqual(fixtureIn(none.Expected!.Cypher), [])
            assert.deepEqual(fixtureIn(bu.Expected!.Cypher), [InvariantFx.A1, InvariantFx.G1, InvariantFx.B1, InvariantFx.Z1])
            assert.deepEqual(fixtureIn(org.Expected!.Cypher), InvariantFx.Instances)
            // per-model sets match the hard-coded membership, and carry the caller's terms
            for (const [model, members] of InvariantFx.Membership)
            {
                const set = org.Expected!.CypherFor(model)
                assert.deepEqual(fixtureIn(set), members, model)
                for (const id of org.Expected!.Cypher)
                {
                    if (org.Expected!.EngineConcept(id) === InvariantFx.Term) assert.ok(set.has(id), id)
                }
            }
            // a visible node never exposes a hidden target: a1 is BU-visible, its peer a2 is not
            assert.equal(bu.Rows.Node(undefined, InvariantFx.A1)?.refs[InvariantFx.Peer]?.includes(InvariantFx.A2) ?? false, false)
            assert.ok(org.Rows.Node(undefined, InvariantFx.A1)!.refs[InvariantFx.Peer]!.includes(InvariantFx.A2))
            // the cross-model ref a1 -> b1 is there tenant-wide and absent under ShopA
            assert.ok(org.Rows.Node(undefined, InvariantFx.A1)!.refs[InvariantFx.Link]!.includes(InvariantFx.B1))
            assert.equal(org.Rows.Node(InvariantFx.ShopA, InvariantFx.A1)!.refs[InvariantFx.Link]?.includes(InvariantFx.B1) ?? false, false)
            // field security is exact per concept: Gadget's inherited `secret` is readable, Widget's only with the profile
            assert.ok(bu.Rows.Node(undefined, InvariantFx.G1)!.fields[InvariantFx.Secret] !== undefined)
            assert.equal(bu.Rows.Node(undefined, InvariantFx.A1)!.fields[InvariantFx.Secret], undefined)
            assert.equal(org.Rows.Node(undefined, InvariantFx.Z1)!.fields[InvariantFx.Code], undefined)
            // non-vacuous: readers got nodes, relationships, members and applied writes; the icon only for org
            for (const sweep of [bu, org])
            {
                assert.ok(sweep.Seen.Nodes > 0 && sweep.Seen.Rels > 0 && sweep.Seen.Members > 0, String(sweep.Seen.Nodes))
                assert.equal(sweep.Seen.Applied, [...InvariantFx.Writes.values()].flat().length)
            }
            assert.ok(org.Seen.SecretValues > bu.Seen.SecretValues)
            assert.ok(org.Seen.Resources > 0)
            assert.equal(none.Seen.Resources, 0)

            // negative control: p-org's answers judged by p-bu's expected sets must fail the invariant
            const control = new PrincipalSweep(world, await world.Connect(PpSecurityHarness.Context(InvariantFx.OrgReader)), PpSecurityHarness.Context(InvariantFx.BuReader), models, false)
            await assert.rejects(() => control.Run(), assert.AssertionError)
        })
    })
})
