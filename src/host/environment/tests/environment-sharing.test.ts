import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError } from '@pragmatic-tech-ai/graph'
import type { AccessScope, GraphEngine } from '@pragmatic-tech-ai/graph'
import { ShareGrants, ShareRight, ShareSubject, SystemNames, SystemPackage } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteOpKind, AppWriteStatus, ErrorCodes, ShareStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ShareServiceScope } from '../service-scopes.js'
import { ShareFx } from './share-fixture.js'

/** Fixed literals of the sharing tests. */
class SharingFx
{
    public static readonly Renamed = 'renamed'
    public static readonly UnknownTeam = 'nope'
    public static readonly G1 = 'g1'
    public static readonly G2 = 'g2'
    public static readonly SubjectIdRequired = 'subject id is required'
    public static readonly DetachDeleteR1 = "MATCH (a:`crm.Account`) WHERE a.name = 'r1' DETACH DELETE a"
    public static readonly CreateGrantCypher = "CREATE (g:`todl.system.ShareGrant` {subjectKind: 'principal', subjectId: 'p2', read: true}) RETURN g"

    /** A grant of r1 to p2 created as `id` under `scope`; resolves with the commit. */
    public static async CreateGrant(engine: GraphEngine, scope: AccessScope, id: string): Promise<bigint>
    {
        const transaction = await engine.Begin(scope)
        try
        {
            transaction.CreateNode(id, SystemNames.ShareGrant, { Owner: SystemPackage.Ref.model })
            transaction.SetProperty(id, SystemNames.SubjectKind, ShareSubject.Principal)
            transaction.SetProperty(id, SystemNames.SubjectId, ShareFx.P2)
            transaction.Link(id, SystemNames.Record, ShareFx.R1)
            return await transaction.Commit()
        }
        finally
        {
            transaction.dispose()
        }
    }
}

describe('record shares as graph data', () =>
{
    test('share makes the record visible to the subject', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [], 'p2 owns nothing')
            const owner = await fx.Connect(ShareFx.Principal(ShareFx.P1))
            await owner.OpenApplication(ShareFx.App)
            const shared = await owner.ShareRecord(ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))
            assert.equal(shared.status, ShareStatus.Applied, JSON.stringify(shared))
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [ShareFx.R1], 'r1 only: r2 stays hidden')
        })
    })

    test('update right widens writes', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            const update = [{ op: AppWriteOpKind.Update, concept: ShareFx.Account, id: ShareFx.R1, fields: { [ShareFx.Name]: SharingFx.Renamed } }]
            const p2 = ShareFx.Context(fx, ShareFx.P2)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))
            assert.equal((await fx.Server.WriteForPragmaticApp(p2, ShareFx.App, update)).results[0]!.status, AppWriteStatus.Denied, 'read alone does not write')
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read, ShareRight.Update]))
            assert.equal((await fx.Server.WriteForPragmaticApp(p2, ShareFx.App, update)).results[0]!.status, AppWriteStatus.Applied)
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Name), SharingFx.Renamed)
        })
    })

    test('unshare removes visibility', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [ShareFx.R1])
            const removed = await fx.Server.UnshareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, []))
            assert.equal(removed.status, ShareStatus.Applied)
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [])
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [], 'the grant node is gone')
            const again = await fx.Server.UnshareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, []))
            assert.equal(again.status, ShareStatus.NotFound, 'unshare of an absent grant')
        })
    })

    test('grant id is deterministic', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            const id = ShareGrants.PublicId(ShareFx.R1, ShareSubject.Principal, ShareFx.P2)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read, ShareRight.Delete]))
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [id])
            const grant = await ShareFx.Node(fx, id)
            assert.equal(grant?.Concept, SystemNames.ShareGrant)
            assert.equal(grant?.Owner, SystemPackage.Ref.model)
            // a re-share updates the same grant: rights replaced, still one node
            const reshared = await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Update]))
            assert.equal(reshared.status, ShareStatus.Applied)
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [id])
            const rights = (await ShareFx.Node(fx, id))!.Properties
            assert.deepEqual(ShareGrants.Rights.filter(right => rights.get(right) === true), [ShareRight.Update])
        })
    })

    test('list shows the record\'s grants only', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Update, ShareRight.Read]))
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R2, ShareFx.P3, [ShareRight.Read]))
            const listed = await fx.Server.ListSharesForPragmaticApp(p1, ShareFx.App, { concept: ShareFx.Account, id: ShareFx.R1 })
            assert.deepEqual(listed.grants, [{ concept: ShareFx.Account, recordId: ShareFx.R1, subject: { kind: ShareSubjectKind.Principal, id: ShareFx.P2 }, rights: [ShareRight.Read, ShareRight.Update] }])
            const hidden = await fx.Server.ListSharesForPragmaticApp(ShareFx.Context(fx, ShareFx.P3), ShareFx.App, { concept: ShareFx.Account, id: ShareFx.R1 })
            assert.deepEqual(hidden.grants, [], 'a record the caller cannot see lists nothing')
        })
    })

    test('share without the right is denied', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            const p2 = ShareFx.Context(fx, ShareFx.P2)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))
            const denied = await fx.Server.ShareForPragmaticApp(p2, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P3, [ShareRight.Read]))
            assert.equal(denied.status, ShareStatus.Denied, 'no Share privilege and no share grant')
            assert.equal((await fx.Server.ShareForPragmaticApp(p2, ShareFx.App, ShareFx.Params(ShareFx.R2, ShareFx.P3, [ShareRight.Read]))).status, ShareStatus.NotFound, 'a record p2 cannot see')
            // a share grant allows resharing
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read, ShareRight.Share]))
            const reshared = await fx.Server.ShareForPragmaticApp(p2, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P3, [ShareRight.Read]))
            assert.equal(reshared.status, ShareStatus.Applied, JSON.stringify(reshared))
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P3), [ShareFx.R1])
            const team = await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, SharingFx.UnknownTeam, [ShareRight.Read], ShareSubjectKind.Team))
            assert.equal(team.status, ShareStatus.Invalid, 'unknown team')
        })
    })

    test('grant writes are confined to the grant', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const engine = await fx.Server.EnvironmentEngine().Engine()
            const catalog = (await fx.Server.EnvironmentEngine().Snapshot()).SchemaCatalog
            const scope = ShareServiceScope.For((await ShareFx.Scope(fx, ShareFx.P1)).Scope, new Set([SharingFx.G1]), catalog)
            await assert.rejects(SharingFx.CreateGrant(engine, scope, SharingFx.G2), (error: unknown) => error instanceof AccessError, 'a grant other than the addressed one')
            await SharingFx.CreateGrant(engine, scope, SharingFx.G1)
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [SharingFx.G1])
        })
    })

    test('user cypher cannot create grants', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const client = await fx.Connect(ShareFx.Principal(ShareFx.P1))
            const result = await client.CypherExecute(SharingFx.CreateGrantCypher, {})
            assert.equal(result.status, AppWriteStatus.Denied, JSON.stringify(result))
        })
    })

    test('recreated record is not widened by old grants', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [ShareFx.R1])
            const deleted = await fx.Server.WriteForPragmaticApp(p1, ShareFx.App, [{ op: AppWriteOpKind.Delete, concept: ShareFx.Account, id: ShareFx.R1 }])
            assert.equal(deleted.results[0]!.status, AppWriteStatus.Applied)
            await ShareFx.SeedAccounts(fx, [ShareFx.R1])
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [], 'no grant links the new record')
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [], 'the recreated record is not shared')
        })
    })

    test('team share widens for members', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            const p3 = ShareFx.Context(fx, ShareFx.P3)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.T1, [ShareRight.Read], ShareSubjectKind.Team))
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P3), [ShareFx.R1], 'a t1 member reads through the team grant')
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [], 'a non-member does not')
            assert.equal((await fx.Server.ShareForPragmaticApp(p3, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))).status, ShareStatus.Denied, 'read alone does not reshare')
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.T1, [ShareRight.Read, ShareRight.Share], ShareSubjectKind.Team))
            const reshared = await fx.Server.ShareForPragmaticApp(p3, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))
            assert.equal(reshared.status, ShareStatus.Applied, 'the team grant holds share: ' + JSON.stringify(reshared))
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [ShareFx.R1])
        })
    })

    test('a record deleted through cypher is not widened when recreated', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            const grant = ShareGrants.PublicId(ShareFx.R1, ShareSubject.Principal, ShareFx.P2)
            await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read, ShareRight.Update, ShareRight.Delete]))
            const client = await fx.Connect(ShareFx.Principal(ShareFx.P1))
            const deleted = await client.CypherExecute(SharingFx.DetachDeleteR1, {})
            assert.equal(deleted.status, AppWriteStatus.Applied, JSON.stringify(deleted))
            assert.equal((await ShareFx.Node(fx, grant))?.Concept, SystemNames.ShareGrant, 'the grant is orphaned, not deleted')
            await ShareFx.SeedAccounts(fx, [ShareFx.R1])
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [], 'the orphan links nothing')
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [], 'the recreated record is not shared')
            assert.equal((await fx.Server.UnshareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, []))).status, ShareStatus.NotFound, 'unshare of an orphan')
            // a re-share relinks the orphan with only the new rights
            assert.equal((await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, ShareFx.Params(ShareFx.R1, ShareFx.P2, [ShareRight.Read]))).status, ShareStatus.Applied)
            assert.deepEqual(await ShareFx.GrantsOf(fx, ShareFx.R1), [grant])
            const rights = (await ShareFx.Node(fx, grant))!.Properties
            assert.deepEqual(ShareGrants.Rights.filter(right => rights.get(right) === true), [ShareRight.Read], 'no stale update or delete')
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [ShareFx.R1])
        })
    })

    test('a share needs a subject id', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const result = await fx.Server.ShareForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, ShareFx.Params(ShareFx.R1, '', [ShareRight.Read]))
            assert.deepEqual(result, { status: ShareStatus.Invalid, reason: SharingFx.SubjectIdRequired })
        })
    })

    test('external record cannot be shared', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const p1 = ShareFx.Context(fx, ShareFx.P1)
            const id = await ShareFx.CustomerId(fx, ShareFx.K1)
            const params = ShareFx.Params(id, ShareFx.P2, [ShareRight.Read], ShareSubjectKind.Principal, ShareFx.Customer)
            assert.deepEqual(await fx.Server.ShareForPragmaticApp(p1, ShareFx.App, params), { status: ShareStatus.Invalid, reason: ShareFx.ExternalReason })
            assert.deepEqual(await fx.Server.UnshareForPragmaticApp(p1, ShareFx.App, params), { status: ShareStatus.Invalid, reason: ShareFx.ExternalReason })
            await assert.rejects(fx.Server.ListSharesForPragmaticApp(p1, ShareFx.App, { concept: ShareFx.Customer, id }), (error: { code?: number; message?: string }) =>
                error.code === ErrorCodes.InvalidParams && error.message!.endsWith(ShareFx.ExternalReason))
            assert.deepEqual(await ShareFx.GrantsOf(fx, id), [])
        })
    })
})
