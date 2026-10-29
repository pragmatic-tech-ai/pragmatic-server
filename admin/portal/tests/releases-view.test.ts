import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { ReleasesMode, ReleasesView } from '../src/releases-view.js'
import type { ReleaseListRow } from '../src/releases-view-model.js'
import { ReleaseDetailView } from '../src/release-detail-view.js'
import { OperatorContext } from '../src/operator-context.js'
import { TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ErrorStatePanel, ScreenState } from '../src/kit/index.js'
import type { FleetHiveDto, ManifestDto } from '../src/portal-types.js'

class FakeClient
{
    public manifestCalls = 0

    public constructor(
        private manifests: ManifestDto[],
        private readonly failFirst = false,
        private readonly failFromSecond = false,
        private readonly vanishFromSecond = false,
    )
    {
    }

    public ListManifests(): Promise<ManifestDto[]>
    {
        const n = this.manifestCalls++
        if ((this.failFirst && n === 0) || (this.failFromSecond && n > 0))
        {
            return Promise.reject(new Error('boom'))
        }
        return Promise.resolve(this.vanishFromSecond && n > 0 ? [] : this.manifests)
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return Promise.resolve([])
    }

    public withdrawCalls: Array<[string, boolean]> = []

    public SetManifestWithdrawn(version: string, withdraw: boolean): Promise<ManifestDto>
    {
        this.withdrawCalls.push([version, withdraw])
        return Promise.resolve({ id: version, image: 'registry/app:' + version, publishedAt: '2026-01-02T03:04:05Z', withdrawn: withdraw })
    }

    public failPublish = false
    public published: Array<[string, string, string | undefined]> = []

    public PublishManifest(version: string, image: string, notes?: string): Promise<ManifestDto>
    {
        if (this.failPublish)
        {
            return Promise.reject(new Error('publish boom'))
        }
        this.published.push([version, image, notes])
        return Promise.resolve({ id: version, image, publishedAt: '2026-01-02T03:04:05Z' })
    }
}

class ScriptedClient
{
    private readonly script: Array<(() => Promise<ManifestDto[]>) | undefined> = []

    public constructor(private readonly manifests: ManifestDto[])
    {
    }

    // Queue the behavior of the next ListManifests calls in order; undefined = default resolve.
    public Queue(...steps: Array<(() => Promise<ManifestDto[]>) | undefined>): void
    {
        this.script.push(...steps)
    }

    public ListManifests(): Promise<ManifestDto[]>
    {
        const step = this.script.shift()
        return step === undefined ? Promise.resolve(this.manifests) : step()
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return Promise.resolve([])
    }
}

class Fixtures
{
    public static Retry(view: ReleasesView): void
    {
        const panel = Fixtures.Walk(view).find(n => n instanceof ErrorStatePanel) as ErrorStatePanel
        assert.ok(panel)
        for (const h of (panel.RetryButton as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static ScriptedView(client: ScriptedClient): ReleasesView
    {
        return new ReleasesView(client as unknown as ControlPlaneClient, OperatorContext.FromWire('full'))
    }

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

    public static Manifest(id: string): ManifestDto
    {
        return { id, image: 'registry/app:' + id, publishedAt: '2026-01-02T03:04:05Z', notes: 'n' }
    }

    public static View(client: FakeClient): ReleasesView
    {
        return new ReleasesView(client as unknown as ControlPlaneClient, OperatorContext.FromWire('full'))
    }

    public static async Open(view: ReleasesView): Promise<void>
    {
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
    }
}

describe('ReleasesView', () =>
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

    it('lists releases populated', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0'), Fixtures.Manifest('2.0')]))
        await view.Refresh()
        assert.equal(view.Mode, ReleasesMode.List)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('is empty with no versions', async () =>
    {
        const view = Fixtures.View(new FakeClient([]))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
    })

    it('shows error on a rejected fetch and retries', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')], true))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
    })

    it('error onRetry re-fetches and recovers', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')], true))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
        Fixtures.Retry(view)
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Host.State, ScreenState.Populated)
    })

    it('opens a release into detail and survives a second detail refresh', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')]))
        await view.Refresh()
        await Fixtures.Open(view)
        assert.equal(view.Mode, ReleasesMode.Detail)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof ReleaseDetailView))
        await view.Refresh()
        assert.equal(view.Mode, ReleasesMode.Detail)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof ReleaseDetailView))
    })

    it('falls back to the list error state when the version vanished before detail', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')], false, false, true))
        await view.ShowList()
        await Fixtures.Open(view)
        assert.equal(view.Mode, ReleasesMode.List)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('falls back to the list error state when the detail fetch fails', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')], false, true))
        await view.Refresh()
        await Fixtures.Open(view)
        assert.equal(view.Mode, ReleasesMode.List)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('survives a second list refresh', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0'), Fixtures.Manifest('2.0')]))
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('detail fetch rejection shows a retryable error that recovers', async () =>
    {
        const client = new ScriptedClient([Fixtures.Manifest('1.0')])
        const view = Fixtures.ScriptedView(client)
        await view.Refresh()
        client.Queue(() => Promise.reject(new Error('boom')))
        await Fixtures.Open(view)
        assert.equal(view.Host.State, ScreenState.Error)
        Fixtures.Retry(view)
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ReleasesMode.List)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 1)
    })

    it('detail not-found shows a retryable list error', async () =>
    {
        const client = new ScriptedClient([Fixtures.Manifest('1.0')])
        const view = Fixtures.ScriptedView(client)
        await view.Refresh()
        client.Queue(() => Promise.resolve([]))
        await Fixtures.Open(view)
        assert.equal(view.Mode, ReleasesMode.List)
        assert.equal(view.Host.State, ScreenState.Error)
        Fixtures.Retry(view)
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Host.State, ScreenState.Populated)
    })

    it('a stale list rejection does not clobber a mounted detail view', async () =>
    {
        const client = new ScriptedClient([Fixtures.Manifest('1.0')])
        const view = Fixtures.ScriptedView(client)
        await view.Refresh()
        const row: ReleaseListRow = { id: '1.0', image: 'registry/app:1.0', withdrawn: false, publishedLabel: '', observedEnvCount: 0 }
        let rejectList: (e: Error) => void = () => undefined
        client.Queue(() => new Promise<ManifestDto[]>((_, rej) => { rejectList = rej }))
        const pendingList = view.ShowList()
        await view.ShowDetail(row)
        assert.equal(view.Mode, ReleasesMode.Detail)
        rejectList(new Error('late'))
        await pendingList
        assert.equal(view.Mode, ReleasesMode.Detail)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof ReleaseDetailView))
        assert.ok(!Fixtures.Walk(view).some(n => n instanceof ErrorStatePanel))
        assert.notEqual(view.Host.State, ScreenState.Error)
    })

    it('a second detail refresh re-renders without throwing', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')]))
        await view.Refresh()
        await Fixtures.Open(view)
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Mode, ReleasesMode.Detail)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof ReleaseDetailView))
        assert.equal(Fixtures.Walk(view).filter(n => n instanceof ReleaseDetailView).length, 1)
    })

    it('withdraw from the detail calls the client and re-fetches the detail', async () =>
    {
        const client = new FakeClient([Fixtures.Manifest('1.0')])
        const view = Fixtures.View(client)
        await view.Refresh()
        await Fixtures.Open(view)
        const detail = Fixtures.Walk(view).find(n => n instanceof ReleaseDetailView) as ReleaseDetailView
        assert.ok(detail.WithdrawAction)
        const before = client.manifestCalls
        detail.WithdrawAction?.Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.withdrawCalls, [['1.0', true]])
        assert.ok(client.manifestCalls > before)
        assert.equal(view.Mode, ReleasesMode.Detail)
    })

    it('exposes a publish action', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')]))
        await view.Refresh()
        assert.ok(view.PublishAction)
        assert.equal(view.PublishAction?.Enabled, true)
    })

    it('disables the publish action for an observer', async () =>
    {
        const view = new ReleasesView(new FakeClient([Fixtures.Manifest('1.0')]) as unknown as ControlPlaneClient, OperatorContext.FromWire('read'))
        await view.Refresh()
        assert.equal(view.PublishAction?.Enabled, false)
        assert.ok((view.PublishAction?.DisabledHint ?? '').length > 0)
    })

    it('publishes a version and returns to the list', async () =>
    {
        const client = new FakeClient([Fixtures.Manifest('1.0')])
        const view = Fixtures.View(client)
        await view.Refresh()
        view.ShowPublish()
        const boxes = Fixtures.Walk(view).filter(n => n instanceof TextBox) as TextBox[]
        assert.equal(boxes.length, 3)
        boxes[0].Text = '2.0'
        boxes[1].Text = 'registry/app:2.0'
        const before = client.manifestCalls
        view.SubmitAction?.Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.published, [['2.0', 'registry/app:2.0', undefined]])
        assert.ok(client.manifestCalls > before)
        assert.equal(view.Mode, ReleasesMode.List)
    })

    it('open, cancel and re-open builds a fresh blank publish form', async () =>
    {
        const view = Fixtures.View(new FakeClient([Fixtures.Manifest('1.0')]))
        await view.Refresh()
        view.ShowPublish()
        const first = Fixtures.Walk(view).filter(n => n instanceof TextBox) as TextBox[]
        first[0].Text = 'typed'
        first[1].Text = 'typed'
        first[2].Text = 'typed'
        await view.ShowList()
        view.ShowPublish()
        assert.equal(view.Mode, ReleasesMode.Publish)
        const second = Fixtures.Walk(view).filter(n => n instanceof TextBox) as TextBox[]
        assert.equal(second.length, 3)
        for (const box of second)
        {
            assert.ok(!first.includes(box))
            assert.equal(box.Text, '')
        }
    })

    it('a failed publish shows one error line and stays on the form', async () =>
    {
        const client = new FakeClient([Fixtures.Manifest('1.0')])
        client.failPublish = true
        const view = Fixtures.View(client)
        await view.Refresh()
        view.ShowPublish()
        const boxes = Fixtures.Walk(view).filter(n => n instanceof TextBox) as TextBox[]
        boxes[0].Text = '2.0'
        boxes[1].Text = 'registry/app:2.0'
        const before = client.manifestCalls
        view.SubmitAction?.Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(view.ErrorLine, 'publish boom')
        assert.equal(view.Mode, ReleasesMode.Publish)
        assert.equal(client.manifestCalls, before)
    })

    it('a blank field does not publish and shows the required error', async () =>
    {
        const client = new FakeClient([Fixtures.Manifest('1.0')])
        const view = Fixtures.View(client)
        await view.Refresh()
        view.ShowPublish()
        const boxes = Fixtures.Walk(view).filter(n => n instanceof TextBox) as TextBox[]
        boxes[0].Text = '2.0'
        view.SubmitAction?.Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(client.published.length, 0)
        assert.ok(view.ErrorLine.length > 0)
        assert.equal(view.Mode, ReleasesMode.Publish)
    })
})
