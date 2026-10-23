import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ControlPlaneClient } from '../src/api-client.js'
import { EnvironmentDetailView } from '../src/environment-detail-view.js'
import { EnvironmentType } from '../src/portal-types.js'
import type { EnvironmentDto, GraphLoadedDto, IPortalNavigator } from '../src/portal-types.js'

class FakeClient
{
    public LoadedFor: string[] = []

    public constructor(private readonly type: string, private readonly loaded: GraphLoadedDto | null)
    {
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return [{ name: 'e1', template: '', type: this.type, environmentId: '', hostPort: 0, status: 'running', createdAt: '', httpUrl: '', wsUrl: '' }]
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
    // Every TextBlock text in the visual tree, following Children and Button.Content.
    public static Texts(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Children?: Iterable<unknown>; Content?: unknown }
        const out: string[] = []
        if (typeof n.Text === 'string')
        {
            out.push(n.Text)
        }
        if (n.Content !== undefined && n.Content !== null)
        {
            out.push(...Fixtures.Texts(n.Content))
        }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                out.push(...Fixtures.Texts(c))
            }
        }
        return out
    }

    public static View(client: FakeClient): EnvironmentDetailView
    {
        return new EnvironmentDetailView(client as unknown as ControlPlaneClient, {} as IPortalNavigator, 'e1')
    }
}

describe('EnvironmentDetailView', () =>
{
    const Loaded: GraphLoadedDto = { name: 'graph-one', packages: [{ id: 'a', version: '1' }, { id: 'b', version: '2' }, { id: 'c', version: '3' }], promotedAt: '2026-10-20T01:02:03Z' }

    it('a development env shows the Promote graph button', async () =>
    {
        const view = Fixtures.View(new FakeClient(EnvironmentType.Development, null))
        await view.Refresh()
        assert.ok(Fixtures.Texts(view).includes(EnvironmentDetailView.PromoteLabel))
    })

    it('a runtime env has no Promote graph button', async () =>
    {
        const view = Fixtures.View(new FakeClient(EnvironmentType.Runtime, Loaded))
        await view.Refresh()
        assert.ok(!Fixtures.Texts(view).includes(EnvironmentDetailView.PromoteLabel))
    })

    it('a runtime env renders its loaded graph name, package count and promoted-at', async () =>
    {
        const client = new FakeClient(EnvironmentType.Runtime, Loaded)
        const view = Fixtures.View(client)
        await view.Refresh()
        assert.deepEqual(client.LoadedFor, ['e1'])
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes(EnvironmentDetailView.DescribeLoaded(Loaded)))
        const line = texts.find(t => t.includes('graph-one'))!
        assert.ok(line.includes('3') && line.includes('2026-10-20T01:02:03Z'))
    })

    it('a runtime env with nothing loaded renders the empty message', async () =>
    {
        const view = Fixtures.View(new FakeClient(EnvironmentType.Runtime, null))
        await view.Refresh()
        assert.ok(Fixtures.Texts(view).includes('No graph loaded'))
    })

    it('a development env renders no loaded-graph text and does not fetch', async () =>
    {
        const client = new FakeClient(EnvironmentType.Development, Loaded)
        const view = Fixtures.View(client)
        await view.Refresh()
        assert.deepEqual(client.LoadedFor, [])
        const texts = Fixtures.Texts(view)
        assert.ok(!texts.some(t => t.includes('graph-one') || t.includes('No graph loaded')))
    })
})
