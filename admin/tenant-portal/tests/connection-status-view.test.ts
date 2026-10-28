import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ConnectionStatusView } from '../src/connection-status-view.js'
import { PillKind, ScreenState } from '../src/kit/index.js'
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

    public static Joined(v: Visual): string
    {
        return Fixtures.Texts(v).join('|')
    }
}

class FakeSource implements IConnectionSource
{
    public Hives: HiveDto[] = [{ id: 'h1', tenantId: 't1', displayName: 'Hive', cluster: { backend: 'k', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }]
    public Failure: unknown
    public Rollout: HiveRolloutDto = { targetVersion: '1.2.3', environments: [{ environmentName: 'dev', runningImage: 'img:dev-7', obsolete: false, ready: true }] }

    public async ListHives(): Promise<HiveDto[]>
    {
        return this.Hives
    }

    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return this.Rollout
    }
}

class Harness
{
    public static async Make(src = new FakeSource()): Promise<ConnectionStatusView>
    {
        Fixtures.InitApp()
        const view = new ConnectionStatusView(src)
        await view.Refresh()
        return view
    }
}

describe('ConnectionStatusView', () =>
{
    it('shows the loading host before the first load completes', () =>
    {
        Fixtures.InitApp()
        const view = new ConnectionStatusView(new FakeSource())
        assert.equal(view.StateHost.State, ScreenState.Loading)
    })

    it('Connected shows the hero, diagram, and running list with no quiet banner', async () =>
    {
        const view = await Harness.Make()
        assert.equal(view.StateHost.State, ScreenState.Populated)
        assert.equal(view.HeroPill?.Kind, PillKind.Connected)
        assert.equal(view.HeroText, ConnectionStatusView.ConnectedText)
        assert.ok(Fixtures.Joined(view.Diagram).includes(ConnectionStatusView.NodeHive))
        assert.ok(Fixtures.Joined(view.Diagram).includes(ConnectionStatusView.NodePragmatic))
        const running = Fixtures.Joined(view.RunningList)
        assert.ok(running.includes('img:dev-7'))
        assert.ok(running.includes('1.2.3'))
        assert.equal(view.QuietBanner, undefined)
    })

    it('Quiet shows the quiet hero and banner, keeps the diagram, and is not an error', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.UnavailableStatus, 'down')
        const view = await Harness.Make(src)
        assert.equal(view.StateHost.State, ScreenState.Populated)
        assert.equal(view.HeroPill?.Kind, PillKind.Quiet)
        assert.equal(view.HeroText, ConnectionStatusView.QuietText)
        assert.ok(view.QuietBanner !== undefined)
        assert.ok(view.QuietBanner.Text.includes('keep running'))
        assert.ok(Fixtures.Joined(view.Diagram).includes(ConnectionStatusView.NodeLink))
        assert.ok(Fixtures.Joined(view.RunningList).includes(ConnectionStatusView.QuietUnavailable))
    })

    it('Error shows the error host', async () =>
    {
        const src = new FakeSource()
        src.Failure = new Error('boom')
        const view = await Harness.Make(src)
        assert.equal(view.StateHost.State, ScreenState.Error)
    })

    it('NoHive shows the empty state', async () =>
    {
        const src = new FakeSource()
        src.Hives = []
        const view = await Harness.Make(src)
        assert.equal(view.StateHost.State, ScreenState.Empty)
    })

    it('Forbidden shows the denied host', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.ForbiddenStatus, 'no')
        const view = await Harness.Make(src)
        assert.equal(view.StateHost.State, ScreenState.Denied)
    })

    it('states that Pragmatic never connects into the hive', async () =>
    {
        const view = await Harness.Make()
        assert.ok(Fixtures.Joined(view.Diagram).includes(ConnectionStatusView.OutboundOnlyText))
        assert.ok(ConnectionStatusView.OutboundOnlyText.includes('never initiates a connection into your hive'))
    })

    it('Dispose tears down subscriptions so later VM changes do not re-render', async () =>
    {
        const view = await Harness.Make()
        view.Dispose()
        const before = Fixtures.Joined(view.RunningList)
        await view.Vm.Load()
        assert.equal(Fixtures.Joined(view.RunningList), before)
    })
})
