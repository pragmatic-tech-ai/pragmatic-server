import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { ActivityView } from '../src/activity-view.js'
import { ScreenState } from '../src/kit/index.js'
import type { ActivityDto } from '../src/portal-types.js'

class FakeClient
{
    public calls = 0

    public constructor(private readonly entries: ActivityDto[], private readonly fail = false)
    {
    }

    public ListActivity(): Promise<ActivityDto[]>
    {
        this.calls++
        return this.fail ? Promise.reject(new Error('boom')) : Promise.resolve(this.entries)
    }
}

class Fixtures
{
    public static Entry(method: string, path: string, status: number): ActivityDto
    {
        return { id: 'a' + status, actor: 'op@example.com', method, path, status, at: '2026-01-02T03:04:05Z' }
    }

    public static View(client: FakeClient): ActivityView
    {
        return new ActivityView(client as unknown as ControlPlaneClient)
    }
}

describe('ActivityView', () =>
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

    it('renders the log as a table', async () =>
    {
        const view = Fixtures.View(new FakeClient([
            Fixtures.Entry('POST', '/api/manifests', 201),
            Fixtures.Entry('POST', '/api/manifests', 403),
        ]))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('is empty with no entries', async () =>
    {
        const view = Fixtures.View(new FakeClient([]))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
    })

    it('shows the error state on a rejected fetch', async () =>
    {
        const view = Fixtures.View(new FakeClient([], true))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('re-fetches on refresh', async () =>
    {
        const client = new FakeClient([Fixtures.Entry('POST', '/api/manifests', 201)])
        const view = Fixtures.View(client)
        await view.Refresh()
        await view.Refresh()
        assert.equal(client.calls, 2)
    })
})
