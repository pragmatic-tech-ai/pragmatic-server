import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessScope, ConceptIs, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { AccessScope as EngineScope, GraphEngine } from '@pragmatic-tech-ai/graph'
import { ShareRight, SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteStatus, CypherCells, ShareStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherNodeCellDto, EntityDto, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, IPrivilegeConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { FieldSecurityEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { TenantReadAuthorization } from '../../cypher/read-filter-source.js'
import { Coverage, Invariant, InvariantText } from '../../engine/tests/scope-invariant-assertions.js'
import type { IExpectedVisibility } from '../../engine/tests/scope-invariant-assertions.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { SeedRow } from './environment-fixture.js'

/**
 * Spec §12, runtime half: no endpoint returns a row or member outside its AccessScope. One runtime tenant with identity
 * delivering `crm` (crm.Account) through `crm-app`, `ext` (ext.Customer bound over the fixture's MemorySourceAdapter)
 * through `ext-app` and `notes` (notes.Note) through the promote set; crm.a2 (root) is shared to the BU reader. Three
 * principals: one the security model does not know, a BusinessUnit-level reader, an Organization-level reader holding
 * the secured-field profile. Every runtime read endpoint is asked over the wire; every id an answer holds must be in
 * the set the ENGINE shows that principal (GraphReader.ScanNodes(todl.Element) under
 * EnvironmentScopes.ScopeFor(ctx).Scope, intersected for a model-scoped read with an independently built model-filter
 * scan: OwnerIs plus the terms and the caller's share grants, R58)
 * plus the external binding's rows, which every principal sees (amendment A7: connector data is outside platform
 * security); every member must be readable under the identity FieldSecurityEvaluator for the node's concept.
 */
class RuntimeFx
{
    public static readonly Root = 'todl.Element'
    public static readonly AppVersion = '1.0.0'
    public static readonly CrmApp = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly PromoteName = 'promoted'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Notes = { id: 'notes', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly Models = [RuntimeFx.Crm.id, RuntimeFx.Notes.id, RuntimeFx.Ext.id]
    public static readonly Account = 'crm.Account'
    public static readonly Note = 'notes.Note'
    public static readonly Customer = 'ext.Customer'
    public static readonly Governed = [RuntimeFx.Account, RuntimeFx.Note]
    public static readonly Bu = 'bu'
    public static readonly Label = 'label'
    public static readonly Secret = 'secret'
    public static readonly Peer = 'peer'
    public static readonly Next = 'next'
    public static readonly RootBu = 'root'
    public static readonly SalesBu = 'sales'
    public static readonly A1 = 'crm.a1'
    public static readonly A2 = 'crm.a2'
    public static readonly A3 = 'crm.a3'
    public static readonly N1 = 'notes.n1'
    public static readonly N2 = 'notes.n2'
    public static readonly Instances = [RuntimeFx.A1, RuntimeFx.A2, RuntimeFx.A3, RuntimeFx.N1, RuntimeFx.N2]
    public static readonly CustomerSource = 'Customer'
    public static readonly CustomerKey = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly ExternalRows: readonly (readonly [string, string])[] = [['k1', 'Acme'], ['k2', 'Bolt']]
    public static readonly NoProfile = 'p-none'
    public static readonly BuReader = 'p-bu'
    public static readonly OrgReader = 'p-org'
    public static readonly Principals = [RuntimeFx.NoProfile, RuntimeFx.BuReader, RuntimeFx.OrgReader]
    public static readonly PageSize = 2
    public static readonly Alpha = 'alpha'
    private static readonly BuRole = 'bu-reader'
    private static readonly OrgRole = 'org-reader'
    private static readonly RoleName = 'Reader'
    private static readonly ProfileId = 'secret-readers'
    private static readonly ProfileName = 'Secret readers'
    private static readonly RootName = 'Root'
    private static readonly SalesName = 'Sales'

    public static readonly CrmTodl = 'namespace crm {\n  concept Account { bu : string?; secret : string?; relationship peer -> Account?; }\n}\n'
    public static readonly NotesTodl = 'namespace notes {\n  concept Note { bu : string?; relationship next -> Note?; }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } }\n}\n'

    /** Read statements: every node, a traversal returning its relationship, a projection of the secured field, a secured filter. */
    public static readonly AllNodes = 'MATCH (n) RETURN n'
    public static readonly Customers = 'MATCH (c:`ext.Customer`) RETURN c'
    public static readonly Traversal = 'MATCH (a)-[r]->(b) RETURN a, r, b'
    public static readonly Projection = 'MATCH (a:`crm.Account`) RETURN a, a.secret AS s'
    public static readonly SecretFilter = 'MATCH (a:`crm.Account`) WHERE a.secret IS NOT NULL RETURN a'
    public static readonly Reads = [RuntimeFx.AllNodes, RuntimeFx.Customers, RuntimeFx.Traversal, RuntimeFx.Projection, RuntimeFx.SecretFilter]
    /** The write-and-return statement cypher/execute runs (confined to crm) before the expected sets are taken. */
    public static readonly Touch = `MATCH (a:\`crm.Account\` {label: '${RuntimeFx.Alpha}'}) SET a.label = a.label RETURN a`
    /** The connector reads: every (model, concept) the fixture delivers. */
    public static readonly ConnectorCases: readonly (readonly [string, string])[] = [
        [RuntimeFx.Crm.id, RuntimeFx.Account], [RuntimeFx.Notes.id, RuntimeFx.Note], [RuntimeFx.Ext.id, RuntimeFx.Customer],
    ]

    /**
     * a1 (sales, peer -> a3), a2 (root, shared to the BU reader), a3 (root); n1 (sales, next -> n2), n2 (root); every
     * account carries a `secret`.
     */
    public static readonly Seeds: readonly SeedRow[] = [
        { Concept: RuntimeFx.Account, Id: RuntimeFx.A1, Properties: { [RuntimeFx.Bu]: RuntimeFx.SalesBu, [RuntimeFx.Label]: RuntimeFx.Alpha, [RuntimeFx.Secret]: 's1' } },
        { Concept: RuntimeFx.Account, Id: RuntimeFx.A2, Properties: { [RuntimeFx.Bu]: RuntimeFx.RootBu, [RuntimeFx.Label]: 'beta', [RuntimeFx.Secret]: 's2' } },
        { Concept: RuntimeFx.Account, Id: RuntimeFx.A3, Properties: { [RuntimeFx.Bu]: RuntimeFx.RootBu, [RuntimeFx.Label]: 'gamma', [RuntimeFx.Secret]: 's3' } },
        { Concept: RuntimeFx.Note, Id: RuntimeFx.N1, Properties: { [RuntimeFx.Bu]: RuntimeFx.SalesBu, [RuntimeFx.Label]: 'one' } },
        { Concept: RuntimeFx.Note, Id: RuntimeFx.N2, Properties: { [RuntimeFx.Bu]: RuntimeFx.RootBu, [RuntimeFx.Label]: 'two' } },
    ]
    public static readonly Links: readonly (readonly [string, string, string])[] = [[RuntimeFx.A1, RuntimeFx.Peer, RuntimeFx.A3], [RuntimeFx.N1, RuntimeFx.Next, RuntimeFx.N2]]

    /** BuReader reads/updates both governed concepts at BusinessUnit level from sales; OrgReader org-wide, may share, holds the `secret` profile; NoProfile is unknown. */
    public static SecurityModel(): ISecurityModelConfig
    {
        const fromField = { kind: OwnershipSourceKind.FromField, value: RuntimeFx.Bu }
        const privileges = (level: AccessLevel, actions: readonly PrivilegeAction[]): IPrivilegeConfig[] => RuntimeFx.Governed.flatMap(concept => actions.map(action => ({ action, concept, level })))
        const member = (principalId: string) => ({ principalId, homeBusinessUnit: RuntimeFx.SalesBu, teams: [] })
        return {
            businessUnits: [
                { id: RuntimeFx.RootBu, name: RuntimeFx.RootName },
                { id: RuntimeFx.SalesBu, name: RuntimeFx.SalesName, parent: RuntimeFx.RootBu },
            ],
            teams: [],
            membership: { claimsMapping: [], overrides: [member(RuntimeFx.BuReader), member(RuntimeFx.OrgReader)] },
            ownershipRules: RuntimeFx.Governed.map(concept => ({ concept, owningBusinessUnit: fromField })),
            roles: [
                { id: RuntimeFx.BuRole, name: RuntimeFx.RoleName, privileges: privileges(AccessLevel.BusinessUnit, [PrivilegeAction.Read, PrivilegeAction.Update]) },
                { id: RuntimeFx.OrgRole, name: RuntimeFx.RoleName, privileges: privileges(AccessLevel.Organization, [PrivilegeAction.Read, PrivilegeAction.Update, PrivilegeAction.Share]) },
            ],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: RuntimeFx.BuReader, roles: [RuntimeFx.BuRole] },
                { principalId: RuntimeFx.OrgReader, roles: [RuntimeFx.OrgRole] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: RuntimeFx.Account, field: RuntimeFx.Secret }],
                profiles: [{ id: RuntimeFx.ProfileId, name: RuntimeFx.ProfileName, grants: [{ concept: RuntimeFx.Account, field: RuntimeFx.Secret, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: RuntimeFx.OrgReader, profiles: [RuntimeFx.ProfileId] }] },
            },
        }
    }

    public static Context(fx: EnvironmentFixture, id: string): AccessContext
    {
        return fx.ContextFor(new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), []))
    }

    /** The tenant on disk and started, nodes and links seeded, a2 shared to the BU reader by the Org reader. */
    public static async Run(body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(RuntimeFx.Crm.id, RuntimeFx.Crm.version, RuntimeFx.CrmTodl)
            await fx.Package(RuntimeFx.Notes.id, RuntimeFx.Notes.version, RuntimeFx.NotesTodl)
            await fx.Package(RuntimeFx.Ext.id, RuntimeFx.Ext.version, RuntimeFx.ExtTodl)
            fx.Live(RuntimeFx.CrmApp, RuntimeFx.AppVersion, [RuntimeFx.Crm])
            fx.Live(RuntimeFx.ExtApp, RuntimeFx.AppVersion, [RuntimeFx.Ext])
            await fx.Promote(RuntimeFx.PromoteName, [RuntimeFx.Notes])
            fx.Source.Adapter.Seed(RuntimeFx.CustomerSource, RuntimeFx.ExternalRows.map(([key, name]) => ({ [RuntimeFx.CustomerKey]: key, [RuntimeFx.NameField]: name })))
            await fx.Start({ Identity: true, SecurityModel: RuntimeFx.SecurityModel() })
            await fx.Seed(RuntimeFx.Seeds)
            const transaction = await (await fx.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
            for (const [from, relationship, to] of RuntimeFx.Links) transaction.Link(from, relationship, to)
            await transaction.Commit()
            const shared = await fx.Server.ShareForPragmaticApp(RuntimeFx.Context(fx, RuntimeFx.OrgReader), RuntimeFx.CrmApp,
                { concept: RuntimeFx.Account, id: RuntimeFx.A2, subject: { kind: ShareSubjectKind.Principal, id: RuntimeFx.BuReader }, rights: [ShareRight.Read] })
            assert.equal(shared.status, ShareStatus.Applied, JSON.stringify(shared))
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }
}

/**
 * What one principal may see, computed from the engine, the external identity and the identity evaluator alone:
 * - `Cypher`: the ids `ScanNodes(todl.Element)` yields under the principal's scope, plus every external row (A7);
 * - `ModelOf(id)`: the engine part of `Cypher` intersected with the ids a scan under the model filter alone yields
 *   (`Or(ConceptIs todl.Term, ConceptIs todl.system.ShareGrant, OwnerIs id)`, rulings S12 and R58, built here without
 *   endpoint code), plus the external rows when `id` is the binding model;
 * - `ConceptOf`: every node the engine holds (unscoped) and every external row, with its concept.
 */
class RuntimeVisibility implements IExpectedVisibility
{
    private constructor(
        public readonly Cypher: ReadonlySet<string>,
        public readonly External: readonly string[],
        private readonly models: ReadonlyMap<string, ReadonlySet<string>>,
        private readonly concepts: ReadonlyMap<string, string>,
        private readonly fields: FieldSecurityEvaluator,
        private readonly context: AccessContext)
    {
    }

    public static async Of(fx: EnvironmentFixture, context: AccessContext): Promise<RuntimeVisibility>
    {
        const host = fx.Server.EnvironmentEngine()
        const engine = await host.Engine()
        const identity = (await host.Snapshot()).Catalog.Identity
        const external = RuntimeFx.ExternalRows.map(([key]) => identity.Mint(identity.CreateTarget(RuntimeFx.Customer)!, key))
        const scope = (await (await fx.Server.EnvironmentScopes()).ScopeFor(context)).Scope
        const stored = await RuntimeVisibility.Scan(engine, scope)
        const perModel = new Map<string, ReadonlySet<string>>()
        for (const model of RuntimeFx.Models)
        {
            const owned = await RuntimeVisibility.Scan(engine, AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[RuntimeFx.Root, RuntimeVisibility.ModelFilter(model)]]) }))
            perModel.set(model, new Set([...[...stored].filter(id => owned.has(id)), ...(model === RuntimeFx.Ext.id ? external : [])]))
        }
        const concepts = await RuntimeVisibility.Concepts(engine)
        for (const id of external) concepts.set(id, RuntimeFx.Customer)
        const authorization = await fx.Server.SecurityModelReload()
        assert.ok(authorization instanceof TenantReadAuthorization, InvariantText.NoTenantAuthorization)
        const fields = (await authorization.EvaluatorForContext(context)).FieldSecurity()
        return new RuntimeVisibility(new Set([...stored, ...external]), external, perModel, concepts, fields, context)
    }

    /** The set for a read scoped to `model` (tenant-wide without one). */
    public CypherFor(model: string | undefined): ReadonlySet<string>
    {
        return model === undefined ? this.Cypher : this.models.get(model)!
    }

    public MemberConcept(id: string): string | undefined
    {
        return this.concepts.get(id)
    }

    public CanRead(concept: string, field: string): boolean
    {
        return this.fields.CanReadField(this.context.Principal, concept, field)
    }

    /**
     * The model filter as the spec defines it (S12, R58), built here without endpoint code: the model's own nodes, every
     * taxonomy term and the share grants (the caller's scope alone governs those). model/view's owner-only filter (R53)
     * differs only by the terms, which this fixture has none of.
     */
    private static ModelFilter(model: string): Or
    {
        return new Or([new ConceptIs(TodlNames.Term), new ConceptIs(SystemNames.ShareGrant), new OwnerIs(new Set([model]))])
    }

    private static async Scan(engine: GraphEngine, scope: EngineScope): Promise<Set<string>>
    {
        const reader = await engine.BeginRead(scope)
        try
        {
            const ids = new Set<string>()
            for await (const id of reader.ScanNodes(RuntimeFx.Root)) ids.add(id)
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
            for await (const id of reader.ScanNodes(RuntimeFx.Root)) concepts.set(id, (await reader.ConceptOf(id))!)
            return concepts
        }
        finally
        {
            reader.dispose()
        }
    }
}

/** The connector-read signature both connector endpoints share (`connector/read`, `connector/readPage`). */
type ConnectorReader = (client: PragmaticClient, modelId: string, concept: string, cursor: string | undefined) => Promise<{ items: EntityDto[]; nextCursor?: string }>

/**
 * Runs every runtime read endpoint for one client and judges each answer by the expected visibility of `judge` (the
 * client's own principal, or another one for the negative control). With `writes`, the write-and-return statement runs
 * first, so the expected sets are taken after it.
 */
class RuntimeSweep
{
    private static readonly ConnectorEndpoints: readonly (readonly [string, ConnectorReader])[] = [
        [InvariantText.ConnectorRead, (client, modelId, concept, cursor) => client.ReadEntities(modelId, concept, { pageSize: RuntimeFx.PageSize, cursor })],
        [InvariantText.ConnectorReadPage, (client, modelId, concept, cursor) => client.ReadEntitiesPage(modelId, concept, { pageSize: RuntimeFx.PageSize, cursor })],
    ]

    public readonly Seen = new Coverage()
    /** The tenant-wide `MATCH (n) RETURN n` nodes. */
    public readonly AllNodes: CypherNodeCellDto[] = []
    /** The `MATCH (n) RETURN n` node ids per model id. */
    public readonly ModelNodes = new Map<string, string[]>()
    /** The model/view members per model id, as `[id, kind]`. */
    public readonly ViewMembers = new Map<string, (readonly [string, string | null])[]>()
    /** The ids the connector reads returned, per concept (both connector endpoints together). */
    public readonly ConnectorIds = new Map<string, Set<string>>()

    public constructor(private readonly fx: EnvironmentFixture, private readonly client: PragmaticClient, private readonly judge: AccessContext, private readonly writes: boolean)
    {
    }

    /** Runs the sweep and returns the expected visibility it judged by. */
    public async Run(): Promise<RuntimeVisibility>
    {
        let written: CypherCellDto[][] = []
        if (this.writes)
        {
            const result = await this.client.CypherExecute(RuntimeFx.Touch, undefined, RuntimeFx.Crm.id)
            if (result.status === AppWriteStatus.Applied) this.Seen.Applied += 1
            written = result.rows
        }
        const expected = await RuntimeVisibility.Of(this.fx, this.judge)
        Invariant.CypherRows(written, expected.Cypher, expected, InvariantText.At(InvariantText.CypherExecute, RuntimeFx.Touch), this.Seen)
        await this.CypherQuery(expected)
        await this.CypherExecute(expected)
        await this.Connectors(expected)
        await this.ModelView(expected)
        await this.Shares(expected)
        return expected
    }

    /** The sorted ids the connector reads of `concept` returned. */
    public ConnectorRead(concept: string): string[]
    {
        return [...(this.ConnectorIds.get(concept) ?? [])].sort()
    }

    private async CypherQuery(expected: RuntimeVisibility): Promise<void>
    {
        for (const model of [undefined, ...RuntimeFx.Models])
        {
            for (const query of RuntimeFx.Reads)
            {
                const where = InvariantText.At(InvariantText.CypherQuery, model ?? InvariantText.NoModel, query)
                const rows: CypherCellDto[][] = []
                for await (const page of this.client.QueryAll(query, undefined, RuntimeFx.PageSize, model)) rows.push(...page.items)
                this.Check(rows, query, expected.CypherFor(model), expected, where)
                if (query === RuntimeFx.AllNodes && model === undefined) this.AllNodes.push(...rows.map(row => CypherCells.AsNode(row[0])!))
                if (query === RuntimeFx.AllNodes && model !== undefined) this.ModelNodes.set(model, rows.map(row => CypherCells.AsNode(row[0])!.id))
            }
        }
    }

    /** cypher/execute reads stay tenant-wide even under a model id (only its writes are confined). */
    private async CypherExecute(expected: RuntimeVisibility): Promise<void>
    {
        for (const model of [undefined, ...RuntimeFx.Models])
        {
            for (const query of RuntimeFx.Reads)
            {
                const where = InvariantText.At(InvariantText.CypherExecute, model ?? InvariantText.NoModel, query)
                const result = await this.client.CypherExecute(query, undefined, model)
                assert.equal(result.status, AppWriteStatus.Applied, InvariantText.Says(where, InvariantText.NotApplied))
                this.Check(result.rows, query, expected.Cypher, expected, where)
            }
        }
    }

    private Check(rows: CypherCellDto[][], query: string, visible: ReadonlySet<string>, expected: RuntimeVisibility, where: string): void
    {
        Invariant.CypherRows(rows, visible, expected, where, this.Seen)
        if (query === RuntimeFx.Projection) Invariant.ProjectedField(rows, RuntimeFx.Secret, expected, where, this.Seen)
        if (query === RuntimeFx.SecretFilter && !expected.CanRead(RuntimeFx.Account, RuntimeFx.Secret)) assert.deepEqual(rows, [], InvariantText.Says(where, InvariantText.FilterLeak))
    }

    private async Connectors(expected: RuntimeVisibility): Promise<void>
    {
        for (const [endpoint, read] of RuntimeSweep.ConnectorEndpoints)
        {
            for (const [model, concept] of RuntimeFx.ConnectorCases)
            {
                const where = InvariantText.At(endpoint, model, concept)
                let cursor: string | undefined
                do
                {
                    const page = await read(this.client, model, concept, cursor)
                    Invariant.Entities(page.items, expected.CypherFor(model), expected, where, this.Seen)
                    let ids = this.ConnectorIds.get(concept)
                    if (ids === undefined)
                    {
                        ids = new Set<string>()
                        this.ConnectorIds.set(concept, ids)
                    }
                    for (const entity of page.items) ids.add(entity.id)
                    cursor = page.nextCursor
                }
                while (cursor !== undefined)
            }
        }
    }

    private async ModelView(expected: RuntimeVisibility): Promise<void>
    {
        for (const model of RuntimeFx.Models)
        {
            const where = InvariantText.At(InvariantText.ModelView, model)
            const members: (readonly [string, string | null])[] = []
            this.ViewMembers.set(model, members)
            let cursor: string | undefined
            do
            {
                const page = await this.client.ModelView(model, { cursor, pageSize: RuntimeFx.PageSize })
                for (const member of page.items)
                {
                    members.push([member.id, member.kind])
                    if (Invariant.ModelMember(member, expected.CypherFor(model), expected, where)) this.Seen.Members += 1
                }
                cursor = page.nextCursor
            }
            while (cursor !== undefined)
        }
    }

    /** Every engine instance's grants: a listed grant names a record the principal sees. */
    private async Shares(expected: RuntimeVisibility): Promise<void>
    {
        for (const seed of RuntimeFx.Seeds)
        {
            const listed = await this.client.ListRecordShares({ concept: seed.Concept, id: seed.Id })
            for (const grant of listed.grants)
            {
                this.Seen.Shares += 1
                assert.ok(expected.Cypher.has(grant.recordId), InvariantText.Says(InvariantText.ListShares, InvariantText.Record, grant.recordId, InvariantText.OutsideScope))
            }
        }
    }
}

describe('scope invariant: no runtime endpoint returns a row or member outside its AccessScope (spec §12)', () =>
{
    test('three principals across cypher/query (with and without modelId), cypher/execute RETURN, connector/read, connector/readPage, model/view and data/shares/list', async () =>
    {
        await RuntimeFx.Run(async fx =>
        {
            const connect = async (principal: string): Promise<PragmaticClient> =>
            {
                const client = await fx.Connect(new Principal(principal, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), []))
                await client.OpenApplication(RuntimeFx.CrmApp)
                return client
            }
            const sweeps = new Map<string, RuntimeSweep>()
            const expected = new Map<string, RuntimeVisibility>()
            for (const principal of RuntimeFx.Principals)
            {
                const sweep = new RuntimeSweep(fx, await connect(principal), RuntimeFx.Context(fx, principal), true)
                expected.set(principal, await sweep.Run())
                sweeps.set(principal, sweep)
            }
            const none = sweeps.get(RuntimeFx.NoProfile)!
            const bu = sweeps.get(RuntimeFx.BuReader)!
            const org = sweeps.get(RuntimeFx.OrgReader)!
            const noneSees = expected.get(RuntimeFx.NoProfile)!
            const buSees = expected.get(RuntimeFx.BuReader)!
            const orgSees = expected.get(RuntimeFx.OrgReader)!
            const fixtureIn = (set: ReadonlySet<string>): string[] => RuntimeFx.Instances.filter(id => set.has(id))

            // the engine-visible sets: unknown sees no instance, BU the sales ones plus the share, org all of them
            assert.deepEqual(fixtureIn(noneSees.Cypher), [])
            assert.deepEqual(fixtureIn(buSees.Cypher), [RuntimeFx.A1, RuntimeFx.A2, RuntimeFx.N1])
            assert.deepEqual(fixtureIn(orgSees.Cypher), RuntimeFx.Instances)
            assert.deepEqual(fixtureIn(orgSees.CypherFor(RuntimeFx.Crm.id)), [RuntimeFx.A1, RuntimeFx.A2, RuntimeFx.A3])
            assert.deepEqual(fixtureIn(orgSees.CypherFor(RuntimeFx.Notes.id)), [RuntimeFx.N1, RuntimeFx.N2])
            // the connector endpoints return exactly the governed rows each principal sees, and (A7) every binding row to everyone
            assert.deepEqual(none.ConnectorRead(RuntimeFx.Account), [])
            // R58: the share widens under a model filter too (the caller's grant passes it), so BU's crm reads hold a2
            assert.deepEqual(bu.ConnectorRead(RuntimeFx.Account), [RuntimeFx.A1, RuntimeFx.A2])
            assert.deepEqual(fixtureIn(new Set(bu.ModelNodes.get(RuntimeFx.Crm.id))), [RuntimeFx.A1, RuntimeFx.A2])
            // model/view lists the shared record and no grant node (grants are not package members)
            const buView = bu.ViewMembers.get(RuntimeFx.Crm.id)!
            assert.deepEqual(fixtureIn(new Set(buView.map(([id]) => id))), [RuntimeFx.A1, RuntimeFx.A2])
            for (const sweep of [none, bu, org])
            {
                for (const members of sweep.ViewMembers.values()) assert.ok(members.every(([, kind]) => kind !== SystemNames.ShareGrant), JSON.stringify(members))
            }
            assert.deepEqual(org.ConnectorRead(RuntimeFx.Account), [RuntimeFx.A1, RuntimeFx.A2, RuntimeFx.A3])
            assert.deepEqual(none.ConnectorRead(RuntimeFx.Note), [])
            assert.deepEqual(bu.ConnectorRead(RuntimeFx.Note), [RuntimeFx.N1])
            assert.deepEqual(org.ConnectorRead(RuntimeFx.Note), [RuntimeFx.N1, RuntimeFx.N2])
            for (const [sweep, sees] of [[none, noneSees], [bu, buSees], [org, orgSees]] as const) assert.deepEqual(sweep.ConnectorRead(RuntimeFx.Customer), [...sees.External].sort())
            // a visible node never exposes a hidden target: a1 is BU-visible, its peer a3 is not
            const a1 = (sweep: RuntimeSweep): CypherNodeCellDto => sweep.AllNodes.find(node => node.id === RuntimeFx.A1)!
            assert.equal(a1(bu).refs[RuntimeFx.Peer]?.includes(RuntimeFx.A3) ?? false, false)
            assert.ok(a1(org).refs[RuntimeFx.Peer]!.includes(RuntimeFx.A3))
            assert.equal(a1(bu).fields[RuntimeFx.Secret], undefined)
            assert.ok(a1(org).fields[RuntimeFx.Secret] !== undefined)
            // non-vacuous: readers got nodes, relationships, members, grants and the applied write
            for (const sweep of [bu, org])
            {
                assert.ok(sweep.Seen.Nodes > 0 && sweep.Seen.Rels > 0 && sweep.Seen.Members > 0 && sweep.Seen.Shares > 0, JSON.stringify(sweep.Seen))
                assert.equal(sweep.Seen.Applied, 1)
            }
            assert.ok(org.Seen.SecretValues > bu.Seen.SecretValues)
            assert.equal(none.Seen.Shares, 0)

            // negative control: p-org's answers judged by p-bu's expected sets must fail the invariant
            const control = new RuntimeSweep(fx, await connect(RuntimeFx.OrgReader), RuntimeFx.Context(fx, RuntimeFx.BuReader), false)
            await assert.rejects(() => control.Run(), (error: unknown) => InvariantText.IsViolation(error))
        })
    })
})
