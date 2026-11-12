import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError, AccessErrorCode, AccessScope } from '@pragmatic-tech-ai/graph'
import type { CellValue, GraphEngine, GraphReader, GraphTransaction } from '@pragmatic-tech-ai/graph'
import { ShareRight } from '@pragmatic-tech-ai/todl/engine'
import { AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EnvironmentFixture } from './environment-fixture.js'
import { EnvironmentAssignService } from '../environment-assign-service.js'
import { EnvironmentScopeRules } from '../environment-scope-rules.js'
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
    public static readonly M1 = 'm1'

    /** The tier-1 rules of the server's environment (the share and assign services' IEnvironmentTier1). */
    public static async Rules(fx: EnvironmentFixture): Promise<EnvironmentScopeRules>
    {
        return new EnvironmentScopeRules(fx.Server.EnvironmentEngine(), await fx.Server.SecuritySetting())
    }

    /** Renames `record` in its own System transaction. */
    public static async Rename(fx: EnvironmentFixture, record: string): Promise<void>
    {
        const transaction = await (await fx.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
        transaction.SetProperty(record, ShareFx.Name, AssignFx.Renamed)
        await transaction.Commit()
    }

    public static Params(id: string, owner: string, concept: string = ShareFx.Account, kind: ShareSubjectKind = ShareSubjectKind.Principal): AssignParams
    {
        return { concept, id, owner: { kind, id: owner } }
    }

    /**
     * Sets `member` of `record` to `value` in one transaction under `AssignScope.For(p1's assign scope, Account, r1,
     * {owner})` (the base scope the assign service opens under: CompileAssign, no system-field guard).
     */
    public static async Write(fx: EnvironmentFixture, record: string, member: string, value: CellValue): Promise<bigint>
    {
        const engine = await fx.Server.EnvironmentEngine().Engine()
        const snapshot = await fx.Server.EnvironmentEngine().Snapshot()
        const base = await (await AssignFx.Rules(fx)).AssignRecords(ShareFx.Context(fx, ShareFx.P1), snapshot)
        const scope = AssignScope.For(base, ShareFx.Account, ShareFx.R1, new Set([ShareFx.Owner]), snapshot.SchemaCatalog)
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
    test('assign moves the owning unit with the new owner', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const assigned = await fx.Server.AssignForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, AssignFx.Params(ShareFx.R1, ShareFx.P2))
            assert.equal(assigned.status, AssignStatus.Applied, JSON.stringify(assigned))
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Owner), ShareFx.P2)
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.OwningBusinessUnit), ShareFx.Sales, 'p2 is placed in sales')
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

    test('assign to a team uses the team\'s unit', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            const params = AssignFx.Params(ShareFx.R1, ShareFx.T1, ShareFx.Account, ShareSubjectKind.Team)
            const assigned = await fx.Server.AssignForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, params)
            assert.equal(assigned.status, AssignStatus.Applied, JSON.stringify(assigned))
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.Owner), ShareFx.T1)
            assert.equal(await ShareFx.Property(fx, ShareFx.R1, ShareFx.OwningBusinessUnit), ShareFx.Marketing, 'the team\'s unit, not the assigner\'s')
            assert.deepEqual(await ShareFx.Names(fx, ShareFx.P3), [ShareFx.R1], 'a team member owns it at User depth')
        })
    })

    test('assign on an organisation-owned concept is invalid', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            await fx.Seed([{ Concept: ShareFx.Memo, Id: AssignFx.M1, Properties: { [ShareFx.Name]: AssignFx.M1 } }])
            const assigned = await fx.Server.AssignForPragmaticApp(ShareFx.Context(fx, ShareFx.P1), ShareFx.App, AssignFx.Params(AssignFx.M1, ShareFx.P2, ShareFx.Memo))
            assert.deepEqual(assigned, { status: AssignStatus.Invalid, reason: EnvironmentAssignService.OrganizationOwnedReason })
        })
    })

    test('assign cannot touch other members', async () =>
    {
        await ShareFx.Run(async fx =>
        {
            await assert.rejects(AssignFx.Write(fx, ShareFx.R1, ShareFx.Name, AssignFx.Renamed), AssignFx.Code(AccessErrorCode.MemberReadOnly), 'a non-system member')
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
            const rules = await AssignFx.Rules(fx)
            const service = new EnvironmentAssignService(racing, () => fx.Server.EnvironmentScopes(), () => Promise.resolve(rules))
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
