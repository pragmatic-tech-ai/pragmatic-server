import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import { WriteOperationKind } from '@pragmatic-tech-ai/todl'
import { AppWriteStatus, CypherCells, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherQueryPageDto, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { EnvironmentFixture } from './environment-fixture.js'
import type { IEnvironmentFixtureOptions } from './environment-fixture.js'

/**
 * A runtime tenant delivering `crm` (crm.Account, engine-stored, with an owner field) through `crm-app` and `ext`
 * (ext.Customer bound writable over the fixture's MemorySourceAdapter with a text id member, ext.Vendor bound
 * read-only) through `ext-app`; the Customer source holds one row. With identity, p1 and p2 hold User-level access on
 * crm.Account (own rows only).
 */
class CypherFx
{
    public static readonly CrmApp = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  concept Vendor { name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } populate Vendor key vend_id { name = "nm"; read-only; } }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Name = 'name'
    public static readonly Owner = 'owner'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly Root = 'root'
    public static readonly UserRole = 'user-role'
    public static readonly UserRoleName = 'User'
    public static readonly RootName = 'Root'
    public static readonly CustomerSource = 'Customer'
    public static readonly CustomerKey = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly Acme = 'Acme'
    public static readonly NewKey = 'k9'
    public static readonly NewCustomer = 'Newco'
    public static readonly Unknown = 'nope'
    public static readonly System = 'todl.system'
    public static readonly UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    public static readonly ModelNotFound = /model not found/
    public static readonly RevisionAdvanced = 'graph revision has advanced'
    public static readonly RecordDenied = 'not authorized for this record'
    public static readonly Joined = 'MATCH (a:`crm.Account`), (c:`ext.Customer`) RETURN a.name AS account, c.name AS customer ORDER BY account, customer'
    public static readonly Elements = 'MATCH (n:`todl.Element`) WHERE n.name IS NOT NULL RETURN n.name AS name ORDER BY name'
    public static readonly Accounts = 'MATCH (a:`crm.Account`) RETURN a.name AS name ORDER BY name'
    public static readonly Customers = 'MATCH (c:`ext.Customer`) RETURN c.name AS name ORDER BY name'
    public static readonly CreateAccount = 'CREATE (a:`crm.Account`) SET a.name = $name RETURN a'
    public static readonly CreateVendor = 'CREATE (v:`ext.Vendor`) SET v.name = $name'
    /** The id member is inline (a literal): placement mints the public id from it (R112). */
    public static readonly CreateCustomer = `CREATE (c:\`ext.Customer\` {id: '${CypherFx.NewKey}', name: '${CypherFx.NewCustomer}'})`

    public static Model(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: CypherFx.Root, name: CypherFx.RootName }],
            teams: [],
            membership: { claimsMapping: [], overrides: [
                { principalId: CypherFx.P1, homeBusinessUnit: CypherFx.Root, teams: [] },
                { principalId: CypherFx.P2, homeBusinessUnit: CypherFx.Root, teams: [] },
            ] },
            ownershipRules: [{ concept: CypherFx.Account, owner: { kind: OwnershipSourceKind.FromField, value: CypherFx.Owner }, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: CypherFx.Root } }],
            roles: [{ id: CypherFx.UserRole, name: CypherFx.UserRoleName, privileges: [PrivilegeAction.Read, PrivilegeAction.Create, PrivilegeAction.Update, PrivilegeAction.Delete].map(action => ({ action, level: AccessLevel.User, concept: CypherFx.Account })) }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: CypherFx.P1, roles: [CypherFx.UserRole] },
                { principalId: CypherFx.P2, roles: [CypherFx.UserRole] },
            ] },
        }
    }

    public static Principal(id: string): Principal
    {
        return new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
    }

    /** crm and ext live, the Customer source holding one row, the server started with `options`. */
    public static async Run(options: IEnvironmentFixtureOptions, body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(CypherFx.Crm.id, CypherFx.Crm.version, CypherFx.CrmTodl)
            await fx.Package(CypherFx.Ext.id, CypherFx.Ext.version, CypherFx.ExtTodl)
            fx.Live(CypherFx.CrmApp, CypherFx.AppVersion, [CypherFx.Crm])
            fx.Live(CypherFx.ExtApp, CypherFx.AppVersion, [CypherFx.Ext])
            fx.Source.Adapter.Seed(CypherFx.CustomerSource, [{ [CypherFx.CustomerKey]: 'k1', [CypherFx.NameField]: CypherFx.Acme }])
            await fx.Start(options)
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** One account per `[name, owner]`. */
    public static SeedAccounts(fx: EnvironmentFixture, rows: readonly (readonly [string, string])[]): Promise<bigint>
    {
        return fx.Seed(rows.map(([name, owner]) => ({ Concept: CypherFx.Account, Id: name, Properties: { [CypherFx.Name]: name, [CypherFx.Owner]: owner } })))
    }

    public static Rows(page: CypherQueryPageDto): unknown[][]
    {
        return page.items.map(row => [...row])
    }

    public static Column(page: CypherQueryPageDto): unknown[]
    {
        return page.items.map(row => row[0])
    }

    /** Every page of `query`, `pageSize` rows each; `between` runs after the first page. */
    public static async Walk(client: PragmaticClient, query: string, pageSize: number, between: () => Promise<void>): Promise<unknown[]>
    {
        const seen: unknown[] = []
        let page = await client.CypherQuery(query, undefined, { pageSize })
        seen.push(...CypherFx.Column(page))
        await between()
        while (page.nextCursor !== undefined)
        {
            page = await client.CypherQuery(query, undefined, { pageSize, cursor: page.nextCursor })
            seen.push(...CypherFx.Column(page))
        }
        return seen
    }

    public static async Revision(fx: EnvironmentFixture): Promise<number>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return Number(reader.SnapshotCommit)
        }
        finally
        {
            reader.dispose()
        }
    }

    public static async OwnerOf(fx: EnvironmentFixture, id: string): Promise<string | undefined>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return (await reader.ReadNode(id))?.Owner
        }
        finally
        {
            reader.dispose()
        }
    }

    public static async CodeOf(attempt: Promise<unknown>): Promise<{ code?: number; message?: string }>
    {
        try
        {
            await attempt
        }
        catch (error)
        {
            return error as { code?: number; message?: string }
        }
        return {}
    }
}

describe('runtime cypher on the environment engine', () =>
{
    test('runtime query reads engine and external data', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            await CypherFx.SeedAccounts(fx, [['r1', CypherFx.P1]])
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const page = await client.CypherQuery(CypherFx.Joined)
            assert.deepEqual(page.columns, ['account', 'customer'])
            assert.deepEqual(CypherFx.Rows(page), [['r1', CypherFx.Acme]], 'one MATCH over an engine-stored and an external concept')
        })
    })

    test('runtime modelId filters to the package', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            await CypherFx.SeedAccounts(fx, [['r1', CypherFx.P1]])
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const models = (await client.CypherModels()).models
            assert.deepEqual(models, [CypherFx.Crm.id, CypherFx.Ext.id], 'cypher/models lists the delivered packages, sorted, without todl.system')
            assert.ok(!models.includes(CypherFx.System))
            assert.deepEqual(CypherFx.Column(await client.CypherQuery(CypherFx.Elements)), [CypherFx.Acme, 'r1'], 'tenant-wide: both packages')
            assert.deepEqual(CypherFx.Column(await client.CypherQuery(CypherFx.Elements, undefined, undefined, CypherFx.Crm.id)), ['r1'], 'crm: its engine nodes only')
            assert.deepEqual(CypherFx.Column(await client.CypherQuery(CypherFx.Elements, undefined, undefined, CypherFx.Ext.id)), [CypherFx.Acme], 'ext: its binding\'s external rows only')
            for (const unknown of [CypherFx.Unknown, CypherFx.System])
            {
                const error = await CypherFx.CodeOf(client.CypherQuery(CypherFx.Elements, undefined, undefined, unknown))
                assert.equal(error.code, ErrorCodes.InvalidParams, unknown)
                assert.match(String(error.message), CypherFx.ModelNotFound)
            }
        })
    })

    test('query without application/open is scoped and equal with any app open', async () =>
    {
        await CypherFx.Run({ Identity: true, SecurityModel: CypherFx.Model() }, async fx =>
        {
            await CypherFx.SeedAccounts(fx, [['r1', CypherFx.P1], ['r2', CypherFx.P2]])
            const plain = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const unopened = CypherFx.Rows(await plain.CypherQuery(CypherFx.Accounts))
            assert.deepEqual(unopened, [['r1']], 'allowed without application/open, and scoped (User level: own rows)')
            for (const app of [CypherFx.CrmApp, CypherFx.ExtApp])
            {
                const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
                await client.OpenApplication(app)
                assert.deepEqual(CypherFx.Rows(await client.CypherQuery(CypherFx.Accounts)), unopened, app)
            }
        })
    })

    test('commit between pages neither repeats nor skips', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            await CypherFx.SeedAccounts(fx, [['b', CypherFx.P1], ['d', CypherFx.P1], ['f', CypherFx.P1]])
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            // 'a' sorts before page 1's last row: offset paging would repeat 'b'
            const seen = await CypherFx.Walk(client, CypherFx.Accounts, 1, async () => { await CypherFx.SeedAccounts(fx, [['a', CypherFx.P1]]) })
            assert.deepEqual(seen, ['b', 'd', 'f'])
        })
    })

    test('runtime execute creates through placement', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const result = await client.CypherExecute(CypherFx.CreateAccount, { name: 'x' })
            assert.equal(result.status, AppWriteStatus.Applied, JSON.stringify(result))
            assert.equal(result.counts.nodesCreated, 1)
            const node = CypherCells.AsNode(result.rows[0]![0])!
            assert.match(node.id, CypherFx.UuidPattern, 'the public id is a fresh UUID')
            assert.equal(await CypherFx.OwnerOf(fx, node.id), CypherFx.Crm.id, 'owned by the home package')
            assert.equal(result.revision, await CypherFx.Revision(fx), 'revision = the latest commit')
            const scoped = await client.CypherExecute(CypherFx.CreateAccount, { name: 'y' }, CypherFx.Crm.id)
            assert.equal(scoped.status, AppWriteStatus.Applied, 'a write confined to its own package applies')
            const foreign = await client.CypherExecute(CypherFx.CreateAccount, { name: 'z' }, CypherFx.Ext.id)
            assert.equal(foreign.status, AppWriteStatus.Denied, 'a write confined to another package is Denied')
            const unknown = await CypherFx.CodeOf(client.CypherExecute(CypherFx.CreateAccount, { name: 'z' }, CypherFx.Unknown))
            assert.equal(unknown.code, ErrorCodes.InvalidParams)
        })
    })

    test('expectedRevision mismatch is Conflict', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const revision = await CypherFx.Revision(fx)
            const stale = await client.CypherExecute(CypherFx.CreateAccount, { name: 'x' }, undefined, revision - 1)
            assert.equal(stale.status, AppWriteStatus.Conflict)
            assert.equal(stale.reason, CypherFx.RevisionAdvanced)
            assert.equal(stale.revision, revision)
            assert.deepEqual(CypherFx.Column(await client.CypherQuery(CypherFx.Accounts)), [], 'nothing was written')
            assert.equal((await client.CypherExecute(CypherFx.CreateAccount, { name: 'x' }, undefined, revision)).status, AppWriteStatus.Applied)
        })
    })

    test('execute into a read-only binding is Denied', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const result = await client.CypherExecute(CypherFx.CreateVendor, { name: 'v' })
            assert.equal(result.status, AppWriteStatus.Denied)
            assert.equal(result.reason, CypherFx.RecordDenied)
            assert.equal(fx.Source.Adapter.Batches.length, 0, 'nothing reached the source')
        })
    })

    test('external create lands at the source', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const before = await CypherFx.Revision(fx)
            const result = await client.CypherExecute(CypherFx.CreateCustomer)
            assert.equal(result.status, AppWriteStatus.Applied, JSON.stringify(result))
            assert.equal(fx.Source.Adapter.Batches.length, 1)
            const operations = fx.Source.Adapter.Batches[0]!.Operations
            assert.deepEqual(operations.map(op => [op.Kind, op.Key]), [[WriteOperationKind.Upsert, CypherFx.NewKey]], 'one Upsert keyed by the storage key')
            assert.equal(result.revision, before, 'an all-external write makes no engine commit (P13)')
            assert.deepEqual(CypherFx.Column(await client.CypherQuery(CypherFx.Customers)), [CypherFx.Acme, CypherFx.NewCustomer], 'a follow-up query fetches it from the source')
        })
    })

    test('open requires a live app', async () =>
    {
        await CypherFx.Run({}, async fx =>
        {
            const client = await fx.Connect(CypherFx.Principal(CypherFx.P1))
            const error = await CypherFx.CodeOf(client.OpenApplication(CypherFx.Unknown))
            assert.equal(error.code, ErrorCodes.InvalidParams)
            assert.deepEqual(await client.OpenApplication(CypherFx.CrmApp), { name: CypherFx.CrmApp, version: CypherFx.AppVersion })
        })
    })
})
