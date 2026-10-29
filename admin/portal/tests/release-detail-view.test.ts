import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, Key } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ReleaseDetailView } from '../src/release-detail-view.js'
import { ReleaseDetailViewModel } from '../src/release-detail-view-model.js'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Banner, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, ScreenState } from '../src/kit/index.js'
import { OperatorContext } from '../src/operator-context.js'
import { ButtonVariant } from '@pragmatic-tech-ai/mural/framework'
import { Act } from '../src/kit/index.js'
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

    public static Full(): OperatorContext
    {
        return OperatorContext.FromWire('full')
    }

    public static NoToggle(): (withdraw: boolean) => Promise<void>
    {
        return () => Promise.resolve()
    }

    public static Action(view: ReleaseDetailView): Act
    {
        const a = view.WithdrawAction
        assert.ok(a)
        return a
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
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.AdoptionTable?.Rows.length, 2)
        const nodes = Fixtures.Collect(view)
        assert.ok(nodes.some(n => n instanceof PageHeader))
        assert.ok(nodes.some(n => n instanceof KeyValueGrid))
        assert.ok(nodes.some(n => n instanceof ObservedPanel && n.Title === WhereTitle))
    })

    it('release grid keys are exactly the five profile keys', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const grid = Fixtures.Collect(view).find(n => n instanceof KeyValueGrid) as KeyValueGrid
        assert.ok(grid)
        assert.deepEqual(Fixtures.Vm().Profile.map(i => i.key), ['Version', 'Image', 'Published', 'Status', "What's new"])
        const nodes = Fixtures.Collect(view)
        assert.equal(nodes.filter(n => n instanceof KeyValueGrid).length, 1)
        const texts = nodes.filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text.toLowerCase())
        assert.ok(texts.length > 0)
        for (const forbidden of ['sign', 'channel', 'digest', 'provenance', 'token', 'credential'])
        {
            assert.ok(!texts.some(t => t.includes(forbidden)), forbidden)
        }
    })

    it('withdrawn release renders a banner', () =>
    {
        const vm = Fixtures.Vm({ withdrawn: true })
        const view = new ReleaseDetailView(vm, () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const banner = Fixtures.Collect(view).find(n => n instanceof Banner) as Banner
        assert.ok(banner)
        assert.ok(vm.WithdrawnBanner.text.length > 0)
        assert.equal(banner.Text, vm.WithdrawnBanner.text)
    })

    it('withdrawn release with running environments shows status, banner and adoption rows', () =>
    {
        const vm = Fixtures.Vm({ withdrawn: true })
        const view = new ReleaseDetailView(vm, () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const banner = Fixtures.Collect(view).find(n => n instanceof Banner) as Banner
        assert.ok(banner)
        assert.equal(banner.Text, vm.WithdrawnBanner.text)
        assert.equal(vm.Profile.find(i => i.key === 'Status')?.value, 'Withdrawn')
        assert.equal(view.AdoptionTable?.Rows.length, 2)
    })

    it('published release renders no banner', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        assert.ok(!Fixtures.Collect(view).some(n => n instanceof Banner))
    })

    it('empty adoption rows render an empty table without throwing', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm({}, []), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        assert.equal(view.AdoptionTable?.Rows.length, 0)
    })

    it('a second render through the host builds a fresh slot without a double-parent', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const first = view.AdoptionTable
        const inputs = (view as unknown as { Inputs(): never }).Inputs()
        assert.doesNotThrow(() => view.Host.Update(inputs))
        assert.notEqual(view.AdoptionTable, first)
        assert.equal(view.AdoptionTable?.Rows.length, 2)
    })

    it('the back button invokes onBack', () =>
    {
        let calls = 0
        const view = new ReleaseDetailView(Fixtures.Vm(), () => { calls++ }, Fixtures.Full(), Fixtures.NoToggle())
        const button = Fixtures.Collect(view).find(n => n instanceof KeyActivatedButton) as KeyActivatedButton
        assert.ok(button)
        ;(button as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.equal(calls, 1)
    })

    it('published manifest renders a Danger Withdraw action', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const a = Fixtures.Action(view)
        assert.equal((a.Content as TextBlock).Text, 'Withdraw version')
        assert.equal(a.Variant, ButtonVariant.Danger)
    })

    it('withdrawn manifest renders a Secondary Restore action', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm({ withdrawn: true }), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const a = Fixtures.Action(view)
        assert.equal((a.Content as TextBlock).Text, 'Restore version')
        assert.equal(a.Variant, ButtonVariant.Secondary)
    })

    it('observer gets a disabled action with a hint', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, OperatorContext.FromWire('read'), Fixtures.NoToggle())
        const a = Fixtures.Action(view)
        assert.equal(a.Enabled, false)
        assert.ok((a.DisabledHint ?? '').length > 0)
    })

    it('observer activation never reaches the callback', () =>
    {
        let calls = 0
        const spy = (_w: boolean): Promise<void> => { calls++; return Promise.resolve() }
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, OperatorContext.FromWire('read'), spy)
        Fixtures.Action(view).Press()
        assert.equal(calls, 0)
    })

    it('full operator activation calls the callback with the negated state', () =>
    {
        const seen: boolean[] = []
        const spy = (w: boolean): Promise<void> => { seen.push(w); return Promise.resolve() }
        const pub = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), spy)
        Fixtures.Action(pub).Press()
        const wd = new ReleaseDetailView(Fixtures.Vm({ withdrawn: true }), () => undefined, Fixtures.Full(), spy)
        Fixtures.Action(wd).Press()
        assert.deepEqual(seen, [true, false])
    })

    it('a rejecting callback leaves an error line and does not throw', async () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), () => Promise.reject(new Error('boom')))
        assert.equal(view.ErrorLine, '')
        await assert.doesNotReject((view as unknown as { Toggle(): Promise<void> }).Toggle())
        assert.equal(view.ErrorLine, 'Could not change the version state. Please try again.')
    })

    it('re-rendering builds a fresh action without a double-parent', () =>
    {
        const view = new ReleaseDetailView(Fixtures.Vm(), () => undefined, Fixtures.Full(), Fixtures.NoToggle())
        const first = view.WithdrawAction
        const inputs = (view as unknown as { Inputs(): never }).Inputs()
        assert.doesNotThrow(() => view.Host.Update(inputs))
        assert.notEqual(view.WithdrawAction, first)
    })
})
