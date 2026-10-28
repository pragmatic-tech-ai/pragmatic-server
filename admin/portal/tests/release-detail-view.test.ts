import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, Key } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ReleaseDetailView } from '../src/release-detail-view.js'
import { ReleaseDetailViewModel } from '../src/release-detail-view-model.js'
import { Banner, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, ScreenState } from '../src/kit/index.js'
import type { FleetHiveDto, ManifestDto } from '../src/portal-types.js'

class Fixtures
{
    public static readonly Image = 'registry/app:1.2.0'

    public static Manifest(over: object = {}): ManifestDto
    {
        return { id: '1.2.0', image: Fixtures.Image, notes: 'Faster sync', publishedAt: '2026-10-01T00:00:00.000Z', ...over } as ManifestDto
    }

    public static Fleet(): FleetHiveDto[]
    {
        return [{
            id: 'h1',
            displayName: 'Hive one',
            tenant: { id: 't1', displayName: 'Tenant t1' },
            client: { id: 'c1', displayName: 'Acme' },
            clusterBackend: 'k8s',
            clusterMode: 'single',
            lastSeen: null,
            environments: [
                { name: 'dev', ready: true, image: Fixtures.Image, detail: 'ok' },
                { name: 'prod', ready: false, image: Fixtures.Image, detail: 'crash' },
                { name: 'other', ready: true, image: 'x:1', detail: 'ok' },
            ],
        } as unknown as FleetHiveDto]
    }

    public static Vm(over: object = {}, fleet: FleetHiveDto[] = Fixtures.Fleet()): ReleaseDetailViewModel
    {
        return new ReleaseDetailViewModel(Fixtures.Manifest(over), fleet)
    }

    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Fixtures.Collect(c, out)
            }
        }
        return out
    }
}

describe('ReleaseDetailView', () =>
{
    const WhereTitle = 'Where it runs'

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

    it('populated view has header, release grid, where-it-runs panel and adoption rows', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.AdoptionTable?.Rows.length, 2)
        const nodes = Fixtures.Collect(view)
        assert.ok(nodes.some(n => n instanceof PageHeader))
        assert.ok(nodes.some(n => n instanceof KeyValueGrid))
        assert.ok(nodes.some(n => n instanceof ObservedPanel && n.Title === WhereTitle))
    })

    it('release grid keys are exactly the five profile keys', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined)
        const grid = Fixtures.Collect(view).find(n => n instanceof KeyValueGrid) as KeyValueGrid
        assert.ok(grid)
        assert.deepEqual(Fixtures.Vm().Profile.map(i => i.key), ['Version', 'Image', 'Published', 'Status', "What's new"])
    })

    it('withdrawn release renders a banner', () =>
    {
        const vm = Fixtures.Vm({ withdrawn: true })
        const view = new ReleaseDetailView(vm, () => undefined)
        const banner = Fixtures.Collect(view).find(n => n instanceof Banner)
        assert.ok(banner)
        assert.ok(vm.WithdrawnBanner.text.length > 0)
    })

    it('published release renders no banner', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined)
        assert.ok(!Fixtures.Collect(view).some(n => n instanceof Banner))
    })

    it('empty adoption rows render an empty table without throwing', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm({}, []), () => undefined)
        assert.equal(view.AdoptionTable?.Rows.length, 0)
    })

    it('a second render builds a fresh slot without a double-parent', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined)
        const first = view.AdoptionTable
        assert.doesNotThrow(() => (view as unknown as { BuildContent(): unknown }).BuildContent())
        assert.notEqual(view.AdoptionTable, first)
        assert.equal(view.AdoptionTable?.Rows.length, 2)
    })

    it('the back button invokes onBack', () =>
    {
        let calls = 0
        const view = new ReleaseDetailView(Fixtures.Vm(), () => { calls++ })
        const button = Fixtures.Collect(view).find(n => n instanceof KeyActivatedButton) as KeyActivatedButton
        assert.ok(button)
        ;(button as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.equal(calls, 1)
    })
})
