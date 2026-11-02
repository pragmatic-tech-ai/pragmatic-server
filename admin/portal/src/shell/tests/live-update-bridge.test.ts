import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalPageViewModel } from '../portal-page-view-model.js'
import { PortalSectionService } from '../portal-section-service.js'
import { LiveUpdateBridge } from '../live-update-bridge.js'
import { PortalTestHost, TestRail, Tick } from './portal-test-fixtures.js'

class CountingPage extends PortalPageViewModel
{
    public Loads = 0

    protected override async LoadCore(): Promise<boolean>
    {
        this.Loads++
        return true
    }
}

class CountingSection extends PortalSectionService
{
    public Root: CountingPage | undefined

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        this.Root = new CountingPage(this.Session)
        return this.Root
    }
}

class ActiveSection extends CountingSection
{
}

class InactiveSection extends CountingSection
{
}

describe('LiveUpdateBridge', () =>
{
    it('refreshes only the active section current page and keeps it shown', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        host.Provider.register(ActiveSection, (p) => new ActiveSection(p))
        host.Provider.register(InactiveSection, (p) => new InactiveSection(p))
        const rail = new TestRail(host.Provider)
        rail.Select(InactiveSection)
        rail.Select(ActiveSection)
        const inactive = host.Provider.getRequired(InactiveSection)
        const active = host.Provider.getRequired(ActiveSection)
        const detail = new CountingPage(host.Session)
        active.Present(detail)
        await Tick.Next()
        const rootLoads = active.Root?.Loads
        const inactiveLoads = inactive.Root?.Loads
        assert.equal(detail.Loads, 1)
        assert.equal(host.Host.Content, detail)

        await new LiveUpdateBridge(rail.Navigation).OnChanged()

        assert.equal(detail.Loads, 2)
        assert.equal(active.Root?.Loads, rootLoads)
        assert.equal(inactive.Root?.Loads, inactiveLoads)
        assert.equal(host.Host.Content, detail)
        assert.equal(active.Current, detail)
    })

    it('does nothing when the active service is not a portal section', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const rail = new TestRail(host.Provider)
        await new LiveUpdateBridge(rail.Navigation).OnChanged()
        assert.equal(rail.Navigation.ActiveService, undefined)
    })
})
