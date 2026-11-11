import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError, AccessErrorCode } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { ShareRight } from '@pragmatic-tech-ai/todl/engine'
import { AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EnvironmentFixture } from './environment-fixture.js'
import { AssignScope } from '../service-scopes.js'
import { ShareFx } from './share-fixture.js'

/** Fixed literals of the assign tests. */
class AssignFx
{
    public static readonly Renamed = 'renamed'

    public static Params(id: string, owner: string, concept: string = ShareFx.Account): AssignParams
    {
        return { concept, id, owner: { kind: ShareSubjectKind.Principal, id: owner } }
    }

    /** Sets `member` of `record` to `value` in one transaction under `AssignScope.For(p1 scope, Account, r1, {owner})`. */
    public static async Write(fx: EnvironmentFixture, record: string, member: string, value: CellValue): Promise<bigint>
    {
        const engine = await fx.Server.EnvironmentEngine().Engine()
        const catalog = (await fx.Server.EnvironmentEngine().Snapshot()).SchemaCatalog
        const scope = AssignScope.For((await ShareFx.Scope(fx, ShareFx.P1)).Scope, ShareFx.Account, ShareFx.R1, new Set([ShareFx.Owner]), catalog)
        const transaction = await engine.Begin(scope)
        try
        {
            transaction.SetProperty(record, member, value)
            return await transaction.Commit()
        }
        finally
        {
            transaction.dispose()
        }
    }

    public static Code(code: AccessErrorCode): (error: unknown) => boolean
    {
        return error => error instanceof AccessError && error.Code === code
    }
}

describe('record assign on the environment engine', () =>
{
    test('assign changes the owner', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const assigned = await fx.Server.AssignForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, AssignFx.Params(ShareFx.R1, ShareFx.P2))
            assert.equal(assigned.status, AssignStatus.Applied, JSON.stringify(assigned))
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Owner), ShareFx.P2)
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P2), [ShareFx.R1], 'the new owner reads it')
            // no Assign privilege: denied, unless a grant holds `assign`
            const p2 = ShareFx.Context(fx, ShareFx.P2)
            await fx.Server.ShareForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, ShareFx.Params(ShareFx.R2, ShareFx.P2, [ShareRight.Read]))
            assert.equal((await fx.Server.AssignForPragmaticApp(p2, ShareFx.App, AssignFx.Params(ShareFx.R2, ShareFx.P3))).status, AssignStatus.Denied)
            assert.equal(await ShareFx.Property(fx, ShareFx.R2, ShareFx.Owner), ShareFx.P1, 'nothing written')
            await fx.Server.ShareForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, ShareFx.Params(ShareFx.R2, ShareFx.P2, [ShareRight.Read, ShareRight.Assign]))
            assert.equal((await fx.Server.AssignForPragmaticApp(p2, ShareFx.App, AssignFx.Params(ShareFx.R2, ShareFx.P3))).status, AssignStatus.Applied, 'assign via a share grant')
            assert.equal(await ShareFx.Property(fx, ShareFx.R2, ShareFx.Owner), ShareFx.P3)
        })
    })

    test('assign cannot touch other members', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            await assert.rejects(AssignFx.Write(fx, ShareFx.R1, ShareFx.Name, AssignFx.Renamed), AssignFx.Code(AccessErrorCode.MemberReadOnly), 'a non-ownership member')
            await assert.rejects(AssignFx.Write(fx, ShareFx.R2, ShareFx.Owner, ShareFx.P2), AssignFx.Code(AccessErrorCode.UpdateDenied), 'another record')
            await AssignFx.Write(fx, ShareFx.R1, ShareFx.Owner, ShareFx.P2)
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Owner), ShareFx.P2)
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Name), ShareFx.R1)
        })
    })

    test('external record cannot be assigned', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const id = await ShareFx.CustomerId(fx, ShareFx.K1)
            const assigned = await fx.Server.AssignForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, AssignFx.Params(id, ShareFx.P2, ShareFx.Customer))
            assert.deepEqual(assigned, { status: AssignStatus.Invalid, reason: ShareFx.ExternalReason })
        })
    })
})
