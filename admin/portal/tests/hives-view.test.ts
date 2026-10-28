import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { HivesMode, HivesView } from '../src/hives-view.js'
import { HiveDetailView } from '../src/hive-detail-view.js'
import { ScreenState } from '../src/kit/index.js'
import type { FleetHiveDto } from '../src/portal-types.js'

class FakeClient
{
    private calls = 0

    public constructor(
        private readonly fleet: FleetHiveDto[],
        private readonly fail = false,
        private readonly failDetail = false,
    )
    {
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        if (this.fail || (this.failDetail && this.calls++ > 0))
        {
            return Promise.reject(new Error('boom'))
        }
        return Promise.resolve(this.fleet)
    }
}

class Fixtures
{
    public static Walk(root: unknown): unknown[]
    {
        const out: unknown[] = [root]
        const children = (root as { Children?: Iterable<unknown> }).Children
        for (const c of children ?? [])
        {
            out.push(...Fixtures.Walk(c))
        }
        return out
    }

    public static Hive(id: string): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: 't-' + id, displayName: 'Tenant ' + id },
            client: { id: 'c-' + id, displayName: 'Client ' + id },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: new Date().toISOString(),
            environments: [{ name: 'dev', ready: true, detail: '' }],
        } as FleetHiveDto
    }

    public static View(fleet: FleetHiveDto[], fail = false, failDetail = false): HivesView
    {
        return new HivesView(new FakeClient(fleet, fail, failDetail) as unknown as ControlPlaneClient)
    }
}

describe('HivesView', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('lists hives populated', async () =>
    {
        const view = Fixtures.View([Fixtures.Hive('a'), Fixtures.Hive('b')])
        await view.Refresh()
        assert.equal(view.Mode, HivesMode.List)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('is empty with no hives', async () =>
    {
        const view = Fixtures.View([])
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
    })

    it('shows error on a rejected fetch', async () =>
    {
        const view = Fixtures.View([], true)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('opens a hive into detail', async () =>
    {
        const view = Fixtures.View([Fixtures.Hive('a')])
        await view.Refresh()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, HivesMode.Detail)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof HiveDetailView))
        await view.Refresh()
        assert.equal(view.Mode, HivesMode.Detail)
    })

    it('falls back to the list error state when the detail fetch fails', async () =>
    {
        const view = Fixtures.View([Fixtures.Hive('a')], false, true)
        await view.Refresh()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, HivesMode.List)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('survives a second refresh', async () =>
    {
        const view = Fixtures.View([Fixtures.Hive('a'), Fixtures.Hive('b')])
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
    })
})
