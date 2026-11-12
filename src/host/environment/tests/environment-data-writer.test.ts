import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, WriteOp } from '@pragmatic-tech-ai/graph'
import type { CellValue, INodeView } from '@pragmatic-tech-ai/graph'
import { WriteFailureKind, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import { ShareRight, ShareSubject, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { RuntimeWritePayloadValidator } from '../../runtime-write-payload-validator.js'
import { EnvironmentDataWriter } from '../environment-data-writer.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { IEnvironmentFixtureOptions } from './environment-fixture.js'

/**
 * A runtime tenant delivering `crm` (crm.Account, engine-stored, with an owner field, an integer, a relationship and a
 * seeded `crm.seeded1`) through `crm-app` and `ext` (ext.Customer bound writable over the fixture's MemorySourceAdapter
 * with a text id member, ext.Vendor bound read-only) through `ext-app`; the Customer source holds one row (k1). With
 * identity, p1 and p2 read every account (Organization) but update and delete only their own (User).
 */
class WriterFx
{
    public static readonly App = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly CrmTodl = 'namespace crm {\n  concept Account : todl.system.Owned { name : string?; size : integer?; relationship parent -> Account?; }\n  concept Contact { name : string; }\n'
        + '  role Writer { Account { read = organization; create = user; update = user; delete = user; append = user; appendTo = user; } }\n'
        + '  role Keeper { Account { read = organization; create = user; update = user; append = user; appendTo = user; } }\n'
        + '  model Crm : crm { Account seeded1 { } }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  concept Vendor { name : string?; }\n  concept Ledger { id : integer?; name : string?; }\n  concept Note { text : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } populate Vendor key vend_id { name = "nm"; read-only; } populate Ledger key led_id { name = "nm"; } populate Note key note_id { text = "tx"; } }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Customer = 'ext.Customer'
    public static readonly Vendor = 'ext.Vendor'
    public static readonly Seeded = 'crm.seeded1'
    public static readonly Contact = 'crm.Contact'
    public static readonly Ledger = 'ext.Ledger'
    public static readonly Parent = 'parent'
    public static readonly ClientId = 'c1'
    public static readonly ClientKey = 'k5'
    public static readonly MissingName = 'missing required field: name'
    public static readonly ParentNotWritable = 'reference member is not writable: parent'
    public static readonly UnsupportedExternalChange = 'UnsupportedExternalChange'
    public static readonly Name = 'name'
    public static readonly Owner = 'owner'
    public static readonly Size = 'size'
    public static readonly IdMember = 'id'
    public static readonly Unknown = 'x'
    public static readonly CustomerSource = 'Customer'
    public static readonly CustomerKey = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly AcmeKey = 'k1'
    public static readonly Acme = 'Acme'
    public static readonly Renamed = 'Acme Two'
    public static readonly NewKey = 'k9'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly R1 = 'r1'
    public static readonly R2 = 'r2'
    public static readonly G1 = 'g1'
    public static readonly G2 = 'g2'
    public static readonly Note = 'ext.Note'
    public static readonly DuplicateId = 'duplicate id in batch'
    public static readonly NoIdMember = 'the binding has no id field to take the id'
    public static readonly A = 'a'
    public static readonly B = 'b'
    public static readonly Changed = 'changed'
    public static readonly Root = 'root'
    public static readonly RootName = 'Root'
    public static readonly Role = 'crm.Writer'
    public static readonly KeeperRole = 'crm.Keeper'
    public static readonly RolledBack = 'atomic batch rolled back'
    public static readonly RecordDenied = 'not authorized for this record'
    public static readonly WriteConflict = 'write conflict'
    public static readonly WriteFailed = 'write failed'
    public static readonly UnknownField = 'unknown field: x'
    public static readonly ReadOnlyBinding = 'binding is read-only'
    public static readonly UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    /** Tier 1: read every account; create, update and (unless `deletes` is false: crm.Keeper) delete own ones only. */
    public static Model(deletes: boolean = true): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: WriterFx.Root, name: WriterFx.RootName }],
            users: [{ principalId: WriterFx.P1, businessUnitId: WriterFx.Root }, { principalId: WriterFx.P2, businessUnitId: WriterFx.Root }],
            teams: [],
            roleAssignments: [{ role: deletes ? WriterFx.Role : WriterFx.KeeperRole, principalIds: [WriterFx.P1, WriterFx.P2], teamIds: [] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: [],
        }
    }

    public static Principal(id: string): Principal
    {
        return new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
    }

    /** crm and ext live, the Customer source holding k1, the server started with `options`. */
    public static async Run(options: IEnvironmentFixtureOptions, body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(WriterFx.Crm.id, WriterFx.Crm.version, WriterFx.CrmTodl)
            await fx.Package(WriterFx.Ext.id, WriterFx.Ext.version, WriterFx.ExtTodl)
            fx.Live(WriterFx.App, WriterFx.AppVersion, [WriterFx.Crm])
            fx.Live(WriterFx.ExtApp, WriterFx.AppVersion, [WriterFx.Ext])
            fx.Source.Adapter.Seed(WriterFx.CustomerSource, [{ [WriterFx.CustomerKey]: WriterFx.AcmeKey, [WriterFx.NameField]: WriterFx.Acme }])
            await fx.Start(options)
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** data/write as `principal` (default p1). */
    public static Write(fx: EnvironmentFixture, operations: AppWriteOpDto[], principal: string = WriterFx.P1): Promise<AppWriteResultDto>
    {
        return fx.Server.WriteForPragmaticApp(fx.ContextFor(WriterFx.Principal(principal)), WriterFx.App, operations)
    }

    /** One account per `[id, owner]`, named by its id. */
    public static SeedAccounts(fx: EnvironmentFixture, rows: readonly (readonly [string, string])[]): Promise<bigint>
    {
        return fx.Seed(rows.map(([id, owner]) => ({ Concept: WriterFx.Account, Id: id, Properties: { [WriterFx.Name]: id, [WriterFx.Owner]: owner } })))
    }

    /** The node as a System reader sees it. */
    public static async Node(fx: EnvironmentFixture, id: string): Promise<INodeView | undefined>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return await reader.ReadNode(id)
        }
        finally
        {
            reader.dispose()
        }
    }

    public static async Property(fx: EnvironmentFixture, id: string, member: string): Promise<CellValue | undefined>
    {
        return (await WriterFx.Node(fx, id))?.Properties.get(member)
    }

    public static async Revision(fx: EnvironmentFixture): Promise<bigint>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return reader.SnapshotCommit
        }
        finally
        {
            reader.dispose()
        }
    }

    /** A share grant of `record` to p2 (System transaction). */
    public static async Grant(fx: EnvironmentFixture, id: string, record: string): Promise<void>
    {
        const transaction = await (await fx.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
        transaction.CreateNode(id, SystemNames.ShareGrant, { Owner: SystemNames.Model })
        transaction.SetProperty(id, SystemNames.SubjectKind, ShareSubject.Principal)
        transaction.SetProperty(id, SystemNames.SubjectId, WriterFx.P2)
        transaction.SetProperty(id, ShareRight.Read, true)
        transaction.Link(id, SystemNames.Record, record)
        await transaction.Commit()
    }

    /** The public id of a Customer row keyed `key`. */
    public static async CustomerId(fx: EnvironmentFixture, key: string): Promise<string>
    {
        const identity = (await fx.Server.EnvironmentEngine().Snapshot()).Catalog.Identity
        return identity.Mint(identity.CreateTarget(WriterFx.Customer)!, key)
    }

    public static Statuses(result: AppWriteResultDto): [AppWriteStatus, string | undefined][]
    {
        return result.results.map(r => [r.status, r.reason])
    }
}

describe('data/write on the environment engine', () =>
{
    test('create returns the placed id and is readable; update sets fields', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const created = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Account, fields: { [WriterFx.Name]: WriterFx.A } }])
            assert.equal(created.results[0]!.status, AppWriteStatus.Applied, JSON.stringify(created))
            const id = created.results[0]!.id!
            assert.match(id, WriterFx.UuidPattern, 'the placed public id')
            const node = await WriterFx.Node(fx, id)
            assert.equal(node?.Owner, WriterFx.Crm.id, 'owned by the home package')
            assert.equal(node?.Properties.get(WriterFx.Name), WriterFx.A)
            const updated = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Update, concept: WriterFx.Account, id, fields: { [WriterFx.Name]: WriterFx.B, [WriterFx.Size]: 5 } }])
            assert.deepEqual(updated.results, [{ status: AppWriteStatus.Applied, id }])
            assert.equal(await WriterFx.Property(fx, id, WriterFx.Name), WriterFx.B)
            assert.equal(await WriterFx.Property(fx, id, WriterFx.Size), 5n, 'an integer member is an Int64 cell')
            // ruling R38: a client id is the engine node's id; one naming an existing record cannot overwrite it
            const chosen = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Account, id: WriterFx.ClientId, fields: { [WriterFx.Name]: WriterFx.A } }])
            assert.deepEqual(chosen.results, [{ status: AppWriteStatus.Applied, id: WriterFx.ClientId }])
            const again = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Account, id, fields: { [WriterFx.Name]: WriterFx.Changed } }])
            assert.deepEqual(WriterFx.Statuses(again), [[AppWriteStatus.Denied, WriterFx.RecordDenied]])
            assert.equal(await WriterFx.Property(fx, id, WriterFx.Name), WriterFx.B, 'the existing record is untouched')
        })
    })

    test('delete removes the record', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            await WriterFx.SeedAccounts(fx, [[WriterFx.R1, WriterFx.P1]])
            const deleted = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Delete, concept: WriterFx.Account, id: WriterFx.R1 }])
            assert.deepEqual(deleted.results, [{ status: AppWriteStatus.Applied, id: WriterFx.R1 }])
            assert.equal(await WriterFx.Node(fx, WriterFx.R1), undefined)
        })
    })

    test('invalid op rolls back the batch', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            await WriterFx.SeedAccounts(fx, [[WriterFx.R1, WriterFx.P1]])
            const before = await WriterFx.Revision(fx)
            const result = await WriterFx.Write(fx, [
                { op: AppWriteOpKind.Create, concept: WriterFx.Account, fields: { [WriterFx.Name]: WriterFx.A } },
                { op: AppWriteOpKind.Update, concept: WriterFx.Account, id: WriterFx.R1, fields: { [WriterFx.Unknown]: 1 } },
                { op: AppWriteOpKind.Delete, concept: WriterFx.Account, id: WriterFx.R1 },
            ])
            assert.deepEqual(WriterFx.Statuses(result), [
                [AppWriteStatus.Failed, WriterFx.RolledBack],
                [AppWriteStatus.Invalid, WriterFx.UnknownField],
                [AppWriteStatus.Failed, WriterFx.RolledBack],
            ])
            assert.equal(await WriterFx.Revision(fx), before, 'nothing committed')
            assert.ok((await WriterFx.Node(fx, WriterFx.R1)) !== undefined, 'the delete did not apply')
        })
    })

    test('denied update leaves the batch uncommitted', async () =>
    {
        await WriterFx.Run({ Identity: true, SecurityModel: WriterFx.Model() }, async fx =>
        {
            await WriterFx.SeedAccounts(fx, [[WriterFx.R1, WriterFx.P1], [WriterFx.R2, WriterFx.P2]])
            const before = await WriterFx.Revision(fx)
            // r2 is readable (Organization) but p2's: p1's update of it is refused at commit by the scope
            const result = await WriterFx.Write(fx, [
                { op: AppWriteOpKind.Update, concept: WriterFx.Account, id: WriterFx.R1, fields: { [WriterFx.Name]: WriterFx.Changed } },
                { op: AppWriteOpKind.Update, concept: WriterFx.Account, id: WriterFx.R2, fields: { [WriterFx.Name]: WriterFx.Changed } },
                { op: AppWriteOpKind.Create, concept: WriterFx.Account, fields: { [WriterFx.Name]: WriterFx.A } },
            ])
            assert.deepEqual(WriterFx.Statuses(result), [
                [AppWriteStatus.Failed, WriterFx.RolledBack],
                [AppWriteStatus.Denied, WriterFx.RecordDenied],
                [AppWriteStatus.Failed, WriterFx.RolledBack],
            ])
            assert.equal(await WriterFx.Revision(fx), before, 'nothing committed')
            assert.equal(await WriterFx.Property(fx, WriterFx.R1, WriterFx.Name), WriterFx.R1, 'the own row is unchanged')
        })
    })

    test('seeded record cannot be updated', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Update, concept: WriterFx.Account, id: WriterFx.Seeded, fields: { [WriterFx.Name]: WriterFx.Changed } }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Denied, WriterFx.RecordDenied]])
            assert.notEqual(await WriterFx.Property(fx, WriterFx.Seeded, WriterFx.Name), WriterFx.Changed)
        })
    })

    test('connector conflict is conflict', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            // k1 is already held by the source: the before-image check refuses the create at commit (R113)
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Customer, fields: { [WriterFx.IdMember]: WriterFx.AcmeKey, [WriterFx.Name]: WriterFx.Renamed } }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Conflict, WriterFx.WriteConflict]])
            assert.deepEqual(fx.Source.Adapter.Rows(WriterFx.CustomerSource), [{ [WriterFx.CustomerKey]: WriterFx.AcmeKey, [WriterFx.NameField]: WriterFx.Acme }], 'the source row is untouched')
        })
    })

    test('source failure kinds map', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const create: AppWriteOpDto = { op: AppWriteOpKind.Create, concept: WriterFx.Customer, fields: { [WriterFx.IdMember]: WriterFx.NewKey, [WriterFx.Name]: WriterFx.Renamed } }
            fx.Source.Adapter.FailNext(WriteFailureKind.Unsupported)
            assert.equal((await WriterFx.Write(fx, [create])).results[0]!.status, AppWriteStatus.Invalid)
            fx.Source.Adapter.FailNext(WriteFailureKind.Error)
            assert.deepEqual(WriterFx.Statuses(await WriterFx.Write(fx, [create])), [[AppWriteStatus.Failed, WriterFx.WriteFailed]])
            assert.equal(fx.Source.Adapter.Rows(WriterFx.CustomerSource).length, 1, 'nothing was written')
        })
    })

    test('read-only binding is invalid or denied', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Vendor, fields: { [WriterFx.Name]: WriterFx.A } }])
            const outcome = result.results[0]!
            assert.ok((outcome.status === AppWriteStatus.Denied && outcome.reason === WriterFx.RecordDenied)
                || (outcome.status === AppWriteStatus.Invalid && outcome.reason === WriterFx.ReadOnlyBinding), JSON.stringify(outcome))
            assert.equal(fx.Source.Adapter.Batches.length, 0, 'nothing reached the source')
        })
    })

    test('delete removes the record\'s grants in the same transaction', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            await WriterFx.SeedAccounts(fx, [[WriterFx.R1, WriterFx.P1]])
            await WriterFx.Grant(fx, WriterFx.G1, WriterFx.R1)
            const before = await WriterFx.Revision(fx)
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Delete, concept: WriterFx.Account, id: WriterFx.R1 }])
            assert.deepEqual(result.results, [{ status: AppWriteStatus.Applied, id: WriterFx.R1 }])
            assert.equal(await WriterFx.Node(fx, WriterFx.G1), undefined, 'the grant is gone')
            assert.equal(await WriterFx.Node(fx, WriterFx.R1), undefined, 'the record is gone')
            const commits = []
            for await (const commit of (await fx.Server.EnvironmentEngine().Engine()).ReadChanges(before)) commits.push(commit)
            assert.equal(commits.length, 1, 'one commit')
            const deletes = commits[0]!.Batch.Ops().filter(op => op.Op === WriteOp.DeleteNode).map(op => (op as { PublicId: string }).PublicId)
            assert.deepEqual(deletes.sort(), [WriterFx.G1, WriterFx.R1], 'it holds both deletes')
        })
    })

    test('external update and delete apply at the source', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const id = await WriterFx.CustomerId(fx, WriterFx.AcmeKey)
            const before = await WriterFx.Revision(fx)
            const updated = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Update, concept: WriterFx.Customer, id, fields: { [WriterFx.Name]: WriterFx.Renamed } }])
            assert.deepEqual(updated.results, [{ status: AppWriteStatus.Applied, id }], JSON.stringify(updated))
            assert.equal(fx.Source.Adapter.Rows(WriterFx.CustomerSource)[0]![WriterFx.NameField], WriterFx.Renamed)
            const deleted = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Delete, concept: WriterFx.Customer, id }])
            assert.deepEqual(deleted.results, [{ status: AppWriteStatus.Applied, id }], JSON.stringify(deleted))
            assert.deepEqual(fx.Source.Adapter.Batches.map(batch => batch.Operations.map(op => [op.Kind, op.Key])), [
                [[WriteOperationKind.Upsert, WriterFx.AcmeKey]],
                [[WriteOperationKind.Delete, WriterFx.AcmeKey]],
            ])
            assert.deepEqual(fx.Source.Adapter.Rows(WriterFx.CustomerSource), [])
            assert.equal(await WriterFx.Revision(fx), before, 'nothing in the engine log')
        })
    })

    test('missing required field is invalid', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Contact, fields: {} }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Invalid, WriterFx.MissingName]])
            const named = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Contact, fields: { [WriterFx.Name]: WriterFx.A } }])
            assert.equal(named.results[0]!.status, AppWriteStatus.Applied, JSON.stringify(named))
        })
    })

    test('relationship member is not writable', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Account, fields: { [WriterFx.Parent]: WriterFx.Seeded } }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Invalid, WriterFx.ParentNotWritable]])
        })
    })

    test('the denied op is the one the engine names', async () =>
    {
        await WriterFx.Run({ Identity: true, SecurityModel: WriterFx.Model(false) }, async fx =>
        {
            await WriterFx.SeedAccounts(fx, [[WriterFx.R1, WriterFx.P1]])
            // both ops target r1: the update is allowed, the delete is not
            const result = await WriterFx.Write(fx, [
                { op: AppWriteOpKind.Update, concept: WriterFx.Account, id: WriterFx.R1, fields: { [WriterFx.Name]: WriterFx.Changed } },
                { op: AppWriteOpKind.Delete, concept: WriterFx.Account, id: WriterFx.R1 },
            ])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Failed, WriterFx.RolledBack], [AppWriteStatus.Denied, WriterFx.RecordDenied]])
        })
    })

    test('an external conflict rolls back the engine ops', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const before = await WriterFx.Revision(fx)
            const result = await WriterFx.Write(fx, [
                { op: AppWriteOpKind.Create, concept: WriterFx.Account, fields: { [WriterFx.Name]: WriterFx.A } },
                { op: AppWriteOpKind.Create, concept: WriterFx.Customer, fields: { [WriterFx.IdMember]: WriterFx.AcmeKey, [WriterFx.Name]: WriterFx.Renamed } },
            ])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Failed, WriterFx.RolledBack], [AppWriteStatus.Conflict, WriterFx.WriteConflict]])
            assert.equal(await WriterFx.Revision(fx), before, 'no engine commit')
        })
    })

    test('external create without a numeric key is invalid', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Ledger, fields: { [WriterFx.Name]: WriterFx.A } }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Invalid, WriterFx.UnsupportedExternalChange]])
            assert.equal(fx.Source.Adapter.Batches.length, 0, 'nothing reached the source')
        })
    })

    test('external create keys the row by the client id', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Customer, id: WriterFx.ClientKey, fields: { [WriterFx.Name]: WriterFx.Renamed } }])
            assert.deepEqual(result.results, [{ status: AppWriteStatus.Applied, id: await WriterFx.CustomerId(fx, WriterFx.ClientKey) }], JSON.stringify(result))
            assert.deepEqual(fx.Source.Adapter.Rows(WriterFx.CustomerSource).map(row => row[WriterFx.CustomerKey]), [WriterFx.AcmeKey, WriterFx.ClientKey])
        })
    })

    test('a grant linked after the pre-read refuses the delete', async () =>
    {
        await WriterFx.Run({ Identity: true, SecurityModel: WriterFx.Model() }, async fx =>
        {
            await WriterFx.SeedAccounts(fx, [[WriterFx.R1, WriterFx.P1]])
            await WriterFx.Grant(fx, WriterFx.G1, WriterFx.R1)
            const server = fx.Server
            // the scope source is resolved after the grant pre-read and before the transaction begins: a grant to
            // another subject linked there is not one the caller's own grant rows would show
            const writer = new EnvironmentDataWriter(server.EnvironmentEngine(), async () =>
            {
                await WriterFx.Grant(fx, WriterFx.G2, WriterFx.R1)
                return server.EnvironmentScopes()
            }, new RuntimeWritePayloadValidator())
            const result = await writer.Apply(fx.ContextFor(WriterFx.Principal(WriterFx.P1)), [{ op: AppWriteOpKind.Delete, concept: WriterFx.Account, id: WriterFx.R1 }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Conflict, WriterFx.WriteConflict]])
            for (const id of [WriterFx.R1, WriterFx.G1, WriterFx.G2]) assert.ok((await WriterFx.Node(fx, id)) !== undefined, id + ' is not deleted')
        })
    })

    test('two creates with one client id are invalid', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const create: AppWriteOpDto = { op: AppWriteOpKind.Create, concept: WriterFx.Account, id: WriterFx.ClientId, fields: { [WriterFx.Name]: WriterFx.A } }
            const result = await WriterFx.Write(fx, [create, { ...create }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Failed, WriterFx.RolledBack], [AppWriteStatus.Invalid, WriterFx.DuplicateId]])
            assert.equal(await WriterFx.Node(fx, WriterFx.ClientId), undefined)
        })
    })

    test('a client id on a binding with no id member is invalid', async () =>
    {
        await WriterFx.Run({}, async fx =>
        {
            const result = await WriterFx.Write(fx, [{ op: AppWriteOpKind.Create, concept: WriterFx.Note, id: WriterFx.ClientKey, fields: {} }])
            assert.deepEqual(WriterFx.Statuses(result), [[AppWriteStatus.Invalid, WriterFx.NoIdMember]])
            assert.equal(fx.Source.Adapter.Batches.length, 0, 'nothing reached the source')
        })
    })
})
