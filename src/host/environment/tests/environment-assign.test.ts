import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError, AccessErrorCode, AccessScope } from '@pragmatic-tech-ai/graph'
import type { CellValue, GraphEngine, GraphReader, GraphTransaction } from '@pragmatic-tech-ai/graph'
import { ShareRight } from '@pragmatic-tech-ai/todl/engine'
import { AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EnvironmentFixture } from './environment-fixture.js'
import type { TenantReadAuthorization } from '../../cypher/read-filter-source.js'
import { EnvironmentAssignService } from '../environment-assign-service.js'
import type { EnvironmentEngineHost, EnvironmentSnapshot } from '../environment-engine-host.js'
import { AssignScope } from '../service-scopes.js'
import { ShareFx } from './share-fixture.js'

/** An engine whose `Begin` runs `race` (a concurrent commit) after the transaction's snapshot is taken. */
class RacingEngine
{
    public constructor(private readonly engine: GraphEngine, private readonly race: () => Promise<void>)
    {
    }

    public BeginRead(scope: AccessScope): Promise<GraphReader>
    {
        return this.engine.BeginRead(scope)
    }

    public async Begin(scope: AccessScope): Promise<GraphTransaction>
    {
        const transaction = await this.engine.Begin(scope)
        await this.race()
        return transaction
    }
}

/** The environment host with its settled engine replaced by a RacingEngine. */
class RacingHost
{
    public constructor(private readonly host: EnvironmentEngineHost, private readonly race: () => Promise<void>)
    {
    }

    public async Settled(): Promise<readonly [GraphEngine, EnvironmentSnapshot]>
    {
        const [engine, snapshot] = await this.host.Settled()
        return [new RacingEngine(engine, this.race) as unknown as GraphEngine, snapshot]
    }
}

/** Fixed literals of the assign tests. */
class AssignFx
{
    public static readonly Renamed = 'renamed'
    public static readonly WriteConflict = 'write conflict'

    /** Renames `record` in its own System transaction. */
    public static async Rename(fx: EnvironmentFixture, record: string): Promise<void>
    {
        const transaction = await (await fx.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
        transaction.SetProperty(record, ShareFx.Name, AssignFx.Renamed)
        await transaction.Commit()
    }

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

    test('assign conflict maps to write conflict', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const host = fx.Server.EnvironmentEngine()
            const racing = new RacingHost(host, () => AssignFx.Rename(fx, ShareFx.R1))
            const service = new EnvironmentAssignService(racing, () => fx.Server.EnvironmentScopes(), () => fx.Server.SecurityModelReload() as Promise<TenantReadAuthorization>)
            const assigned = await service.Assign(ShareFx.Context(fx, ShareFx.P1), AssignFx.Params(ShareFx.R1, ShareFx.P2))
            assert.deepEqual(assigned, { status: AssignStatus.Denied, reason: AssignFx.WriteConflict })
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Owner), ShareFx.P1, 'nothing written')
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Name), AssignFx.Renamed, 'the racing commit landed')
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
