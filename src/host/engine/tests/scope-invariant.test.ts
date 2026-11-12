import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { AccessScope as EngineScope, CellValue, GraphEngine } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, CypherCells, InMemoryMessageSocket, PragmaticClient, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherNodeCellDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessContext, BaseRole, Principal, PrincipalKind, ResourceAuthorizationPolicy, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import { Coverage, Invariant, InvariantText } from './scope-invariant-assertions.js'
import type { IExpectedVisibility } from './scope-invariant-assertions.js'

/**
 * Spec §12 and §5.1 (PR13), dev half: authoring data is governed by the identity RBAC at the PolicyGate only, so every
 * principal the gate admits gets the same unrestricted scope, whatever security setting the tenant config holds, and the
 * model confinement of a model-scoped read (`OwnerIs(modelId)`) is unchanged. One dev tenant, two principals; every dev
 * read endpoint, and cypher/execute RETURN after writes, is asked over the wire. Every instance id an answer holds must
 * be in the set the ENGINE shows that principal (GraphReader.ScanNodes under AccessScopeSource.ScopeFor(ctx).Scope,
 * intersected for a model-scoped read with an independently built Or(ConceptIs todl.Term, ConceptIs
 * todl.system.ShareGrant, OwnerIs model) scope, R58), every attribute readable under the scope's Hidden.
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
    public static readonly First = 'p-one'
    public static readonly Second = 'p-two'
    public static readonly Outsider = 'p-outsider'
    public static readonly TenantName = 'Tenant One'
    public static readonly ModelsDir = 'models'
    public static readonly ModelFileName = 'model.todl'
    public static readonly NoConnectors = 'no connectors'
    public static readonly ModelViewPageSize = 2
    public static readonly SolutionPrefix = 'inv-sol-'
    public static readonly PackagesPrefix = 'inv-pkgs-'
    public static readonly IdentityPrefix = 'inv-id-'
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

    /** A stored setting assigning nothing to anyone (and only a System Administrator elsewhere): the dev scope ignores it. */
    public static SecurityModel(): ISecurityModelConfig
    {
        return {
            businessUnits: [
                { id: PpSecurityHarness.RootBu, name: InvariantFx.RootName },
                { id: PpSecurityHarness.SalesBu, name: InvariantFx.SalesName, parent: PpSecurityHarness.RootBu },
            ],
            users: [{ principalId: InvariantFx.Outsider, businessUnitId: PpSecurityHarness.SalesBu }],
            teams: [],
            roleAssignments: [{ role: BaseRole.SystemAdministrator, principalIds: [InvariantFx.Outsider], teamIds: [] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: [],
        }
    }

    /** A principal with no grant on the tenant: the PolicyGate refuses it. */
    public static Ungranted(principalId: string): AccessContext
    {
        const tenant = new Tenant(PpSecurityHarness.TenantId, TenantKind.SelfHosted, InvariantFx.TenantName)
        return new AccessContext(new Principal(principalId, PpSecurityHarness.TenantId, PrincipalKind.User, new Map(), []), tenant, [], new ResourceAuthorizationPolicy())
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

/**
 * What one principal may see, computed from the engine and its compiled scope alone:
 * - `Cypher`: the ids `ScanNodes(todl.Element)` yields under the principal's scope (tenant-wide reads, and every
 *   cypher/execute read, which stays tenant-wide);
 * - `ModelOf(id)`: `Cypher` intersected with the ids a scan under `Or(ConceptIs todl.Term, ConceptIs ShareGrant, OwnerIs id)` alone yields
 *   (deny-wins conjunction, built here without endpoint code);
 * - `ModelView`: `Cypher` without the term and the class node, plus each of them the engine admits as a hypothetical
 *   node of its represented concept (`GraphReader.Admits` on its fixture values): model/view judges them that way;
 * - `Held` / `ConceptOf`: every node the engine holds and its concept (unscoped), to tell instances from structure.
 */
class ExpectedVisibility implements IExpectedVisibility
{
    private constructor(
        public readonly Cypher: ReadonlySet<string>,
        private readonly models: ReadonlyMap<string, ReadonlySet<string>>,
        public readonly ModelView: ReadonlySet<string>,
        private readonly concepts: ReadonlyMap<string, string>,
        public readonly Scope: EngineScope)
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
        return new ExpectedVisibility(cypher, perModel, modelView, concepts, scope)
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

    /** Whether the compiled scope lets the principal read `field` of `concept` (it hides nothing on dev). */
    public CanRead(concept: string, field: string): boolean
    {
        return !(this.Scope.Hidden.get(concept)?.has(field) ?? false) && !(this.Scope.HiddenExact.get(concept)?.has(field) ?? false)
    }

    private static ModelScope(model: string): EngineScope
    {
        // R58: the caller's share grants pass the model filter too (none exist on this dev tenant)
        const owned = new Or([new ConceptIs(InvariantFx.Term), new ConceptIs(SystemNames.ShareGrant), new OwnerIs(new Set([model]))])
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
        const handler = ServerConnectionHandler.Attach(serverSocket, this.language, this.manager, context, undefined, development.cypherQuery,
            undefined, undefined, undefined, undefined, undefined, undefined, server.Purpose(), undefined, undefined, undefined,
            development.cypherExecute,
            undefined, development.devGraphService, undefined, development.modelView)
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
        if (query === InvariantFx.Projection) Invariant.ProjectedField(rows, InvariantFx.Secret, expected, where, this.Seen)
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
                if (Invariant.ModelMember(member, expected.ModelView, expected, InvariantText.ModelView)) this.Seen.Members += 1
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

describe('scope invariant: the dev scope is unrestricted for every gate-passing principal (spec §12, §5.1)', () =>
{
    test('dev scope ignores the security setting', async () =>
    {
        await InvariantWorld.Run(async world =>
        {
            const models = [...await world.Server.DevCypher().Models()]
            assert.deepEqual([...InvariantFx.Membership.keys()].filter(model => models.includes(model)), [...InvariantFx.Membership.keys()], InvariantText.ModelCount)
            const sweeps: PrincipalSweep[] = []
            for (const principal of [InvariantFx.First, InvariantFx.Second])
            {
                const context = PpSecurityHarness.Context(principal)
                const sweep = new PrincipalSweep(world, await world.Connect(context), context, models, true)
                await sweep.Run()
                sweeps.push(sweep)
            }
            const fixtureIn = (set: ReadonlySet<string>): string[] => InvariantFx.Instances.filter(id => set.has(id))
            for (const sweep of sweeps)
            {
                // the setting assigns them nothing, yet both read every instance and every secured value
                assert.deepEqual(fixtureIn(sweep.Expected!.Cypher), InvariantFx.Instances)
                assert.equal(sweep.Expected!.Scope.Rows.size, 0, 'no row restriction')
                assert.equal(sweep.Expected!.Scope.Hidden.size + sweep.Expected!.Scope.HiddenExact.size, 0, 'no hidden member')
                // model confinement is unchanged: per-model sets match the hard-coded membership
                for (const [model, members] of InvariantFx.Membership) assert.deepEqual(fixtureIn(sweep.Expected!.CypherFor(model)), members, model)
                assert.ok(sweep.Rows.Node(undefined, InvariantFx.A1)!.fields[InvariantFx.Secret] !== undefined)
                assert.equal(sweep.Rows.Node(InvariantFx.ShopA, InvariantFx.A1)!.refs[InvariantFx.Link]?.includes(InvariantFx.B1) ?? false, false, 'a cross-model ref is absent under ShopA')
                assert.ok(sweep.Seen.Nodes > 0 && sweep.Seen.Rels > 0 && sweep.Seen.Members > 0 && sweep.Seen.Resources > 0, JSON.stringify(sweep.Seen))
                assert.equal(sweep.Seen.Applied, [...InvariantFx.Writes.values()].flat().length)
            }
            // the second sweep ran later (its writes created nodes): it sees everything the first saw
            assert.ok([...sweeps[0]!.Expected!.Cypher].every(id => sweeps[1]!.Expected!.Cypher.has(id)), 'every gate-passing principal sees the same')
            // the PolicyGate still refuses a principal without Read on the tenant
            const outsider = await world.Connect(InvariantFx.Ungranted(InvariantFx.Outsider))
            await assert.rejects(outsider.CypherQuery(InvariantFx.AllNodes), (error: unknown) => error instanceof ResponseError)
        })
    })
})
