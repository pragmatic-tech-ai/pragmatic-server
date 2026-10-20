import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ControlPlaneClient } from '../src/api-client.js'
import { EnvironmentDetailView } from '../src/environment-detail-view.js'
import type { EnvironmentDto, GraphLoadedDto, IPortalNavigator } from '../src/portal-types.js'

class FakeClient
{
    public LoadedFor: string[] = []

    public constructor(private readonly type: string, private readonly loaded: GraphLoadedDto | null)
    {
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return [{ name: 'e1', template: '', type: this.type, tenantId: '', hostPort: 0, status: 'running', createdAt: '', httpUrl: '', wsUrl: '' }]
    }

    public async Logs(): Promise<string>
    {
        return ''
    }

    public async GetLoadedGraph(name: string): Promise<GraphLoadedDto | null>
    {
        this.LoadedFor.push(name)
        return this.loaded
    }
}

class Fixtures
{
    public static View(client: FakeClient): EnvironmentDetailView
    {
        return new EnvironmentDetailView(client as unknown as ControlPlaneClient, {} as IPortalNavigator, 'e1')
    }
}

describe('EnvironmentDetailView', () =>
{
    it('a runtime env fetches its loaded graph on refresh', async () =>
    {
        const client = new FakeClient('runtime', { name: 'g1', packages: [{ id: 'p', version: '1' }], promotedAt: 't' })
        await Fixtures.View(client).Refresh()
        assert.deepEqual(client.LoadedFor, ['e1'])
    })

    it('a development env does not fetch a loaded graph', async () =>
    {
        const client = new FakeClient('development', null)
        await Fixtures.View(client).Refresh()
        assert.deepEqual(client.LoadedFor, [])
    })

    it('DescribeLoaded shows name, package count and promoted-at, or the empty message', () =>
    {
        const text = EnvironmentDetailView.DescribeLoaded({ name: 'g1', packages: [{ id: 'a', version: '1' }, { id: 'b', version: '2' }], promotedAt: 'T' })
        assert.ok(text.includes('g1') && text.includes('2') && text.includes('T'))
        assert.equal(EnvironmentDetailView.DescribeLoaded(null), 'No graph loaded')
    })
})
