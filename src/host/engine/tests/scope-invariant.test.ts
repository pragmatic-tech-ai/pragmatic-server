import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import type { AccessScope as EngineScope, GraphEngine } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, CypherCells, InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherNodeCellDto, ModelMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessLevel, OwnershipSourceKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { FieldSecurityEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantReadAuthorization } from '../../cypher/read-filter-source.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'

/**
 * Spec §12: no endpoint returns a row or member outside its AccessScope. One dev tenant, three principals (one the
 * security model does not know, a BusinessUnit-level reader, an Organization-level reader holding the secured-field
 * profile); every dev read endpoint is asked over the wire, and every instance id it returns must be in the set the
 * ENGINE shows that principal (GraphReader.ScanNodes under DevAccessScopeSource.ScopeFor(ctx).Scope), every attribute
 * readable under the tenant's FieldSecurityEvaluator. The expected sets are computed here from the engine and the
 * identity evaluator directly, never through endpoint code.
 */

/** The fixture: names, model text, the security model and the queries every principal runs. */
class InvariantFx
{
    public static readonly Root = 'todl.Element'
    public static readonly Widget = 'acme.Widget'
    public static readonly Big = 'acme.Kinds.Big'
    public static readonly A1 = 'acme.a1'
    public static readonly A2 = 'acme.a2'
    public static readonly B1 = 'acme.b1'
    public static readonly Secret = 'secret'
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

    /** Read queries: every node, a traversal, an attribute projection, and a filter on the secured attribute. */
    public static readonly AllNodes = 'MATCH (n) RETURN n'
    public static readonly Traversal = 'MATCH (a)-[r]->(b) RETURN a, b'
    public static readonly Projection = 'MATCH (w:Widget) RETURN w, w.secret AS s'
    public static readonly SecretFilter = 'MATCH (w:Widget) WHERE w.secret IS NOT NULL RETURN w'
    public static readonly Queries = [InvariantFx.AllNodes, InvariantFx.Traversal, InvariantFx.Projection, InvariantFx.SecretFilter]

    /** ShopA: a1 (sales, peer -> b1), a2 (root, peer -> a1); ShopB: b1 (sales); every widget has a secret; term Big has an icon. */
    public static Todl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        const sales = PpSecurityHarness.SalesBu
        const root = PpSecurityHarness.RootBu
        return `namespace acme { concept Widget { ${bu} : string?; secret : string?; relationship peer -> Widget?; } `
            + `taxonomy Kinds : represents Widget { term Big { annotate icon { path = "${InvariantFx.IconPath}"; } } } `
            + `model ShopA : acme { Widget a1 { ${bu} = "${sales}"; label = "alpha"; secret = "s1"; peer = b1; } `
            + `Widget a2 { ${bu} = "${root}"; label = "beta"; secret = "s2"; peer = a1; } } `
            + `model ShopB : acme { Widget b1 { ${bu} = "${sales}"; label = "gamma"; secret = "s3"; } } }`
    }

    /** BuReader reads Widget at BusinessUnit level from sales; OrgReader org-wide with the secret profile; NoProfile is unknown. */
    public static SecurityModel(): ISecurityModelConfig
    {
        const fromField = { kind: OwnershipSourceKind.FromField, value: PpSecurityHarness.OwningBuField }
        const read = (level: AccessLevel) => [{ action: PrivilegeAction.Read, concept: InvariantFx.Widget, level }]
        const member = (principalId: string) => ({ principalId, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] })
        return {
            businessUnits: [
                { id: PpSecurityHarness.RootBu, name: InvariantFx.RootName },
                { id: PpSecurityHarness.SalesBu, name: InvariantFx.SalesName, parent: PpSecurityHarness.RootBu },
            ],
            teams: [],
            membership: { claimsMapping: [], overrides: [member(InvariantFx.BuReader), member(InvariantFx.OrgReader)] },
            ownershipRules: [{ concept: InvariantFx.Widget, owningBusinessUnit: fromField }],
            roles: [
                { id: InvariantFx.BuRole, name: InvariantFx.RoleName, privileges: read(AccessLevel.BusinessUnit) },
                { id: InvariantFx.OrgRole, name: InvariantFx.RoleName, privileges: read(AccessLevel.Organization) },
            ],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: InvariantFx.BuReader, roles: [InvariantFx.BuRole] },
                { principalId: InvariantFx.OrgReader, roles: [InvariantFx.OrgRole] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: InvariantFx.Widget, field: InvariantFx.Secret }],
                profiles: [{ id: InvariantFx.ProfileId, name: InvariantFx.ProfileName, grants: [{ concept: InvariantFx.Widget, field: InvariantFx.Secret, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: InvariantFx.OrgReader, profiles: [InvariantFx.ProfileId] }] },
            },
        }
    }
}

/**
 * What one principal may see, computed from the engine and the identity evaluator alone:
 * - `Cypher`: the ids `ScanNodes(todl.Element)` yields under the principal's scope (what any cypher endpoint may return);
 * - `ModelView`: the scanned ids that are not taxonomy terms, plus each term the engine admits as a hypothetical node of
 *   its represented concept (`GraphReader.Admits`; Big has no attrs, so its property map is empty). model/view judges a
 *   term that way, not as the engine's todl.Term node;
 * - `Held`: every id the engine holds (unscoped), so an endpoint's answer for an id outside the graph is not an instance.
 */
class ExpectedVisibility
{
    private constructor(
        public readonly Cypher: ReadonlySet<string>,
        public readonly ModelView: ReadonlySet<string>,
        public readonly Held: ReadonlySet<string>,
        private readonly fields: FieldSecurityEvaluator,
        private readonly context: AccessContext)
    {
    }

    public static async Of(server: PragmaticServer, context: AccessContext): Promise<ExpectedVisibility>
    {
        const engine = await server.DevEngine().Engine()
        const scope = (await (await server.DevScopes()).ScopeFor(context)).Scope
        const cypher = await ExpectedVisibility.Scan(engine, scope)
        const held = await ExpectedVisibility.Scan(engine, AccessScope.System)
        const modelView = new Set([...cypher].filter(id => id !== InvariantFx.Big))
        const reader = await engine.BeginRead(scope)
        try
        {
            if (reader.Admits(InvariantFx.Widget, new Map())) modelView.add(InvariantFx.Big)
        }
        finally
        {
            reader.dispose()
        }
        const authorization = await server.FieldReadMaskSource()
        assert.ok(authorization instanceof TenantReadAuthorization)
        const fields = (await authorization.EvaluatorForContext(context)).FieldSecurity()
        return new ExpectedVisibility(cypher, modelView, held, fields, context)
    }

    /** Whether the tenant's field security lets the principal read `field` of `concept`. */
    public CanRead(concept: string, field: string): boolean
    {
        return this.fields.CanReadField(this.context.Principal, concept, field)
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
}

/** The assertions every endpoint's answer must pass. */
class Invariant
{
    /** Every node cell anywhere in `rows`: its id visible, its fields and refs readable, its ref targets visible. */
    public static CypherRows(rows: readonly (readonly CypherCellDto[])[], expected: ExpectedVisibility, where: string): number
    {
        let nodes = 0
        for (const row of rows)
        {
            for (const cell of row)
            {
                for (const node of Invariant.NodesIn(cell))
                {
                    nodes += 1
                    Invariant.CypherNode(node, expected, where)
                }
            }
        }
        return nodes
    }

    /** A projected attribute column: a non-null value needs a readable attribute on the row's node. */
    public static ProjectedSecret(rows: readonly (readonly CypherCellDto[])[], expected: ExpectedVisibility, where: string): void
    {
        for (const row of rows)
        {
            const node = CypherCells.AsNode(row[0])!
            if (row[1] !== null) assert.ok(expected.CanRead(node.concept, InvariantFx.Secret), `${where}: projected ${InvariantFx.Secret} of ${node.id}`)
        }
    }

    /**
     * A model/view member the engine holds: in the principal's model/view set, attrs and edge members readable, edge
     * targets visible. Members the engine does not hold (schema, models) are structure, not instances. Every held node
     * of the fixture is a Widget or a term typed by Widget, so attrs are checked against Widget's field security.
     */
    public static ModelMember(member: ModelMemberDto, expected: ExpectedVisibility, where: string): void
    {
        if (!expected.Held.has(member.id)) return
        assert.ok(expected.ModelView.has(member.id), `${where}: member ${member.id} is outside the scope`)
        for (const field of Object.keys(member.attrs))
        {
            assert.ok(expected.CanRead(InvariantFx.Widget, field), `${where}: attr ${field} of ${member.id}`)
        }
        for (const edge of member.edges)
        {
            if (expected.Held.has(edge.to)) assert.ok(expected.ModelView.has(edge.to), `${where}: edge ${member.id} -> ${edge.to}`)
            if (edge.via !== null) assert.ok(expected.CanRead(InvariantFx.Widget, edge.via), `${where}: edge via ${edge.via} of ${member.id}`)
        }
    }

    private static CypherNode(node: CypherNodeCellDto, expected: ExpectedVisibility, where: string): void
    {
        assert.ok(expected.Cypher.has(node.id), `${where}: node ${node.id} is outside the scope`)
        for (const field of Object.keys(node.fields))
        {
            assert.ok(expected.CanRead(node.concept, field), `${where}: field ${field} of ${node.id}`)
        }
        for (const [member, targets] of Object.entries(node.refs))
        {
            assert.ok(expected.CanRead(node.concept, member), `${where}: ref ${member} of ${node.id}`)
            for (const target of targets) assert.ok(expected.Cypher.has(target), `${where}: ref ${node.id} -> ${target}`)
        }
    }

    private static NodesIn(cell: CypherCellDto | undefined): CypherNodeCellDto[]
    {
        const node = CypherCells.AsNode(cell)
        if (node !== undefined) return [node]
        if (Array.isArray(cell)) return cell.flatMap(item => Invariant.NodesIn(item))
        const map = CypherCells.AsMap(cell)
        return map === undefined ? [] : Object.values(map).flatMap(item => Invariant.NodesIn(item))
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

    /** Every member model/view returns for the member, page by page. */
    public static async WalkModelView(client: PragmaticClient, memberId: string): Promise<ModelMemberDto[]>
    {
        const members: ModelMemberDto[] = []
        let cursor: string | undefined
        do
        {
            const page = await client.ModelView(memberId, { cursor, pageSize: InvariantFx.ModelViewPageSize })
            members.push(...page.items)
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        return members
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

/** What each principal's answers must at least contain, so the invariant is never vacuously true. */
class Coverage
{
    public Nodes = 0
    public SecretValues = 0
    public Members = 0
    public Resources = 0
}

/** Runs every endpoint for one principal and checks each answer against its expected visibility. */
class PrincipalSweep
{
    public readonly Seen = new Coverage()

    public constructor(private readonly world: InvariantWorld, private readonly client: PragmaticClient, private readonly expected: ExpectedVisibility, private readonly models: readonly string[])
    {
    }

    public async Run(): Promise<void>
    {
        await this.CypherQuery()
        await this.CypherExecute()
        await this.ModelView()
        await this.Resources()
    }

    private async CypherQuery(): Promise<void>
    {
        for (const modelId of [undefined, ...this.models])
        {
            for (const query of InvariantFx.Queries)
            {
                const where = `cypher/query ${modelId ?? '(no model)'} ${query}`
                const rows: CypherCellDto[][] = []
                for await (const page of this.client.QueryAll(query, undefined, undefined, modelId)) rows.push(...page.items)
                this.Check(rows, query, where)
            }
        }
    }

    private async CypherExecute(): Promise<void>
    {
        for (const modelId of this.models)
        {
            for (const query of InvariantFx.Queries)
            {
                const where = `cypher/execute ${modelId} ${query}`
                const result = await this.client.CypherExecute(query, undefined, modelId)
                assert.equal(result.status, AppWriteStatus.Applied, where)
                this.Check(result.rows, query, where)
            }
        }
    }

    private Check(rows: CypherCellDto[][], query: string, where: string): void
    {
        this.Seen.Nodes += Invariant.CypherRows(rows, this.expected, where)
        if (query === InvariantFx.Projection)
        {
            Invariant.ProjectedSecret(rows, this.expected, where)
            this.Seen.SecretValues += rows.filter(row => row[1] !== null).length
        }
        if (query === InvariantFx.SecretFilter && !this.expected.CanRead(InvariantFx.Widget, InvariantFx.Secret))
        {
            assert.deepEqual(rows, [], `${where}: a filter on an unreadable attribute selected rows`)
        }
    }

    private async ModelView(): Promise<void>
    {
        const members = await InvariantWorld.WalkModelView(this.client, this.world.MemberId)
        for (const member of members) Invariant.ModelMember(member, this.expected, 'model/view')
        this.Seen.Members += members.filter(m => this.expected.Held.has(m.id)).length
    }

    private async Resources(): Promise<void>
    {
        for (const id of this.expected.Held)
        {
            const resources = await this.client.Resources(id)
            if (resources.length > 0) assert.ok(this.expected.ModelView.has(id), `model/resources: ${id} is outside the scope`)
            this.Seen.Resources += resources.length
        }
    }
}

describe('scope invariant: no dev endpoint returns a row or member outside its AccessScope (spec §12)', () =>
{
    test('three principals across cypher/query (with and without modelId), cypher/execute RETURN, model/view and model/resources', async () =>
    {
        await InvariantWorld.Run(async world =>
        {
            const models = await world.Server.DevCypher().Models()
            assert.ok(models.length >= 2, 'the fixture has two models')
            const seen = new Map<string, Coverage>()
            const visible = new Map<string, ReadonlySet<string>>()
            for (const principal of [InvariantFx.NoProfile, InvariantFx.BuReader, InvariantFx.OrgReader])
            {
                const context = PpSecurityHarness.Context(principal)
                const expected = await ExpectedVisibility.Of(world.Server, context)
                const sweep = new PrincipalSweep(world, await world.Connect(context), expected, models)
                await sweep.Run()
                seen.set(principal, sweep.Seen)
                visible.set(principal, expected.Cypher)
            }
            // the engine-visible sets themselves: unknown sees no widget, BU sees the sales widgets, org sees all three
            const widgets = [InvariantFx.A1, InvariantFx.A2, InvariantFx.B1]
            assert.deepEqual(widgets.filter(id => visible.get(InvariantFx.NoProfile)!.has(id)), [])
            assert.deepEqual(widgets.filter(id => visible.get(InvariantFx.BuReader)!.has(id)), [InvariantFx.A1, InvariantFx.B1])
            assert.deepEqual(widgets.filter(id => visible.get(InvariantFx.OrgReader)!.has(id)), widgets)
            // non-vacuous: the readers got nodes and members back, only the org reader secret values and the icon
            for (const principal of [InvariantFx.BuReader, InvariantFx.OrgReader])
            {
                assert.ok(seen.get(principal)!.Nodes > 0, principal)
                assert.ok(seen.get(principal)!.Members > 0, principal)
            }
            assert.equal(seen.get(InvariantFx.BuReader)!.SecretValues, 0)
            assert.ok(seen.get(InvariantFx.OrgReader)!.SecretValues > 0)
            assert.ok(seen.get(InvariantFx.OrgReader)!.Resources > 0)
            assert.equal(seen.get(InvariantFx.NoProfile)!.Resources, 0)
        })
    })
})
