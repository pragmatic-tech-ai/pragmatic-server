import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { FleetView } from '../src/fleet-view.js'
import { FleetSegment } from '../src/fleet-view-model.js'
import { ScreenState } from '../src/kit/index.js'
import type { FleetHiveDto } from '../src/portal-types.js'

class FakeClient
{
    public constructor(private readonly hives: FleetHiveDto[], private readonly fail = false)
    {
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return this.fail ? Promise.reject(new Error('boom')) : Promise.resolve(this.hives)
    }
}

class Fixtures
{
    public static Hive(id: string, lastSeen: string | null, ready: boolean): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: 't', displayName: 'Tenant' },
            client: { id: 'c', displayName: 'Client' },
            clusterBackend: 'k8s',
            clusterMode: 'single',
            lastSeen,
            environments: [{ ready }] as unknown as FleetHiveDto['environments'],
        }
    }

    public static View(hives: FleetHiveDto[], fail = false): FleetView
    {
        return new FleetView(new FakeClient(hives, fail) as unknown as ControlPlaneClient)
    }
}

describe('FleetView', () =>
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

    it('is populated with a row per hive for a mixed fleet', async () =>
    {
        const now = new Date().toISOString()
        const view = Fixtures.View([
            Fixtures.Hive('a', now, true),
            Fixtures.Hive('b', null, true),
            Fixtures.Hive('c', now, false),
        ])
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Model?.HiveCount, 3)
        assert.equal(view.Table?.Rows.length, 3)
    })

    it('segment filter narrows the table', async () =>
    {
        const now = new Date().toISOString()
        const view = Fixtures.View([Fixtures.Hive('a', now, true), Fixtures.Hive('b', null, true)])
        await view.Refresh()
        view.Model?.SetSegment(FleetSegment.NotCheckingIn)
        assert.equal(view.Model?.Visible().length, 1)
    })

    it('is empty when there are no hives', async () =>
    {
        const view = Fixtures.View([])
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
    })

    it('shows the error state when the fetch fails', async () =>
    {
        const view = Fixtures.View([], true)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
    })
})
