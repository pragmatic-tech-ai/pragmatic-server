import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { ReleasesMode, ReleasesView } from '../src/releases-view.js'
import { ReleaseDetailView } from '../src/release-detail-view.js'
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

    public static Manifest(id: string): ManifestDto
    {
        return { id, image: 'registry/app:' + id, publishedAt: '2026-01-02T03:04:05Z', notes: 'n' }
    }

    public static View(client: FakeClient): ReleasesView
    {
        return new ReleasesView(client as unknown as ControlPlaneClient)
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
        const panel = Fixtures.Walk(view).find(n => n instanceof ErrorStatePanel) as ErrorStatePanel
        assert.ok(panel)
        for (const h of (panel.RetryButton as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
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
})
