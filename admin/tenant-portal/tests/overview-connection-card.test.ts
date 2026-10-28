import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Act, PillKind } from '../src/kit/index.js'
import { ConnectionState } from '../src/connection-status-view-model.js'
import { OverviewConnectionCard } from '../src/overview-connection-card.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { HiveDto, HiveRolloutDto, IConnectionSource } from '../src/tenant-types.js'

class Fixtures
{
    private static app: Application | undefined

    public static InitApp(): void
    {
        if (Fixtures.app === undefined)
        {
            Fixtures.app = new Application()
            Fixtures.app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        }
        Application.current = Fixtures.app
    }

    public static Collect(v: Visual, out: Visual[] = []): Visual[]
    {
        out.push(v)
        for (const c of v.visualChildren)
        {
            Fixtures.Collect(c, out)
        }
        return out
    }

    public static Texts(v: Visual): string[]
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string')
    }
}

class FakeSource implements IConnectionSource
{
    public Hives: HiveDto[] = [{ id: 'h1', tenantId: 't1', displayName: 'Hive', cluster: { backend: 'k', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }]
    public Failure: unknown
    public RolloutCalls = 0

    public async ListHives(): Promise<HiveDto[]>
    {
        return this.Hives
    }

    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        this.RolloutCalls++
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return { targetVersion: '1.2.3', environments: [{ environmentName: 'dev', runningImage: 'img:dev-7', obsolete: false, ready: true }] }
    }
}

class Harness
{
    public static async Make(src = new FakeSource(), onView: () => void = () => {}): Promise<OverviewConnectionCard>
    {
        Fixtures.InitApp()
        const card = new OverviewConnectionCard(src, onView)
        await card.Load()
        return card
    }
}

describe('OverviewConnectionCard', () =>
{
    it('shows a loading line before the load completes', () =>
    {
        Fixtures.InitApp()
        const card = new OverviewConnectionCard(new FakeSource(), () => {})
        assert.equal(card.Vm.State, ConnectionState.Loading)
        assert.ok(Fixtures.Texts(card).includes(OverviewConnectionCard.LoadingText))
        assert.equal(card.Pill, undefined)
    })

    it('Connected shows the reachable pill and the detail sentence', async () =>
    {
        const card = await Harness.Make()
        assert.equal(card.Pill?.Kind, PillKind.Connected)
        assert.ok(card.DetailText !== undefined && card.DetailText.length > 0)
        assert.equal(card.DetailText, card.Vm.Status?.detail)
    })

    it('a 503 renders Quiet, not an error', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.UnavailableStatus, 'down')
        const card = await Harness.Make(src)
        assert.equal(card.Vm.State, ConnectionState.Quiet)
        assert.equal(card.Pill?.Kind, PillKind.Quiet)
        assert.equal(Fixtures.Texts(card).includes(OverviewConnectionCard.ErrorText), false)
    })

    it('no hive shows an honest no-hive line without a pill', async () =>
    {
        const src = new FakeSource()
        src.Hives = []
        const card = await Harness.Make(src)
        assert.equal(card.Vm.State, ConnectionState.NoHive)
        assert.equal(card.Pill, undefined)
        assert.ok(Fixtures.Texts(card).includes(OverviewConnectionCard.NoHiveText))
    })

    it('403 shows not-available and renders no pill or detail', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.ForbiddenStatus, 'no')
        const card = await Harness.Make(src)
        assert.equal(card.Vm.State, ConnectionState.Forbidden)
        assert.equal(card.Pill, undefined)
        assert.equal(card.DetailText, undefined)
        assert.ok(Fixtures.Texts(card).includes(OverviewConnectionCard.ForbiddenText))
    })

    it('another failure shows the error line', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(500, 'boom')
        const card = await Harness.Make(src)
        assert.equal(card.Vm.State, ConnectionState.Error)
        assert.ok(Fixtures.Texts(card).includes(OverviewConnectionCard.ErrorText))
    })

    it('a 401 is re-thrown to the caller', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.UnauthorizedStatus, 'who')
        Fixtures.InitApp()
        const card = new OverviewConnectionCard(src, () => {})
        await assert.rejects(card.Load(), (e: unknown) => e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
    })

    it('the View connection status link calls onView', async () =>
    {
        let views = 0
        const card = await Harness.Make(new FakeSource(), () => { views++ })
        const act = Fixtures.Collect(card).find(v => v instanceof Act) as Act
        assert.ok(Fixtures.Texts(act).includes(OverviewConnectionCard.ViewLabel))
        act.Press()
        assert.equal(views, 1)
    })

    it('loads once: a repeated Load does not re-probe the rollout', async () =>
    {
        const src = new FakeSource()
        const card = await Harness.Make(src)
        await card.Load()
        await card.Load()
        assert.equal(src.RolloutCalls, 1)
    })
})
