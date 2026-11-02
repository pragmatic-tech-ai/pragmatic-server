import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import type { IHoldsPendingSecret } from '../holds-pending-secret.js'
import { PageState, PortalPageViewModel } from '../portal-page-view-model.js'
import { PortalSectionService } from '../portal-section-service.js'
import { PortalTestHost, Tick } from './portal-test-fixtures.js'

class StubPage extends PortalPageViewModel
{
    public Loads = 0

    protected override async LoadCore(): Promise<boolean>
    {
        this.Loads++
        return true
    }
}

class DetailPage extends Observable
{
}

// A page showing a one-time value until the operator confirms saving it.
class PendingPage extends Observable implements IHoldsPendingSecret
{
    public HasPendingSecret = true
}

class TestSection extends PortalSectionService
{
    public Creates = 0
    public Root: StubPage | undefined

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        this.Creates++
        this.Root = new StubPage(this.Session)
        return this.Root
    }
}

class SectionA extends TestSection
{
}

class SectionB extends TestSection
{
}

// Two sections behind a real NavigationService rail.
class RailFixture
{
    public readonly Host = PortalTestHost.WithoutClient()
    public readonly Navigation: NavigationService
    private readonly capabilityA = RailFixture.CapabilityFor(SectionA)
    private readonly capabilityB = RailFixture.CapabilityFor(SectionB)

    public constructor()
    {
        this.Host.Provider.register(SectionA, (p) => new SectionA(p))
        this.Host.Provider.register(SectionB, (p) => new SectionB(p))
        this.Navigation = new NavigationService(this.Host.Provider)
        this.Host.Provider.registerInstance(NavigationService.Key, this.Navigation)
    }

    public get A(): SectionA
    {
        return this.Host.Provider.getRequired(SectionA)
    }

    public get B(): SectionB
    {
        return this.Host.Provider.getRequired(SectionB)
    }

    public SelectA(): void
    {
        this.Navigation.SelectedItem = this.capabilityA
    }

    public SelectB(): void
    {
        this.Navigation.SelectedItem = this.capabilityB
    }

    private static CapabilityFor(section: Function): Capability
    {
        const c = new Capability()
        c.ServiceKey = section as never
        return c
    }
}

describe('PortalSectionService', () =>
{
    it('first activation creates and presents the root once', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        section.OnActivated()
        section.OnActivated()
        await Tick.Next()
        assert.equal(section.Creates, 1)
        assert.equal(host.Host.Content, section.Root)
        assert.equal(section.Current, section.Root)
        assert.equal(section.Root?.Loads, 1)
        assert.equal(section.Root?.State, PageState.Populated)
    })

    it('re-activation re-views the current page after another section showed', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        const other = new TestSection(host.Provider)
        section.OnActivated()
        const detail = new DetailPage()
        section.Present(detail)
        other.OnActivated()
        assert.equal(host.Host.Content, other.Root)
        section.OnActivated()
        assert.equal(host.Host.Content, detail)
        assert.equal(section.Creates, 1)
    })

    it('Back returns to the root and is a no-op at the root', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        section.OnActivated()
        assert.equal(section.BackCommand.CanExecute(), false)
        section.Present(new DetailPage())
        assert.equal(section.BackCommand.CanExecute(), true)
        section.BackCommand.Execute()
        assert.equal(host.Host.Content, section.Root)
        assert.equal(section.Current, section.Root)
        section.Back()
        assert.equal(host.Host.Content, section.Root)
        assert.equal(section.Current, section.Root)
    })

    it('RefreshCurrent reloads the current page', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        section.OnActivated()
        await Tick.Next()
        await section.RefreshCurrent()
        assert.equal(section.Root?.Loads, 2)
    })

    it('an off-rail section presents without taking the content region', () =>
    {
        const rail = new RailFixture()
        rail.SelectA()
        assert.equal(rail.Host.Host.Content, rail.A.Root)
        assert.equal(rail.A.IsActive, true)
        rail.SelectB()
        assert.equal(rail.A.IsActive, false)
        assert.equal(rail.B.IsActive, true)
        const late = new DetailPage()
        rail.A.Present(late)
        assert.equal(rail.A.Current, late)
        assert.equal(rail.Host.Host.Content, rail.B.Root)
        rail.SelectA()
        assert.equal(rail.Host.Host.Content, late)
    })

    it('with no navigation registered a section counts as active', () =>
    {
        const section = new TestSection(PortalTestHost.WithoutClient().Provider)
        assert.equal(section.IsActive, true)
    })

    it('Replace swaps the top page, so Back skips the replaced one', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        section.OnActivated()
        section.Present(new DetailPage())
        const next = new DetailPage()
        section.Replace(next)
        assert.equal(host.Host.Content, next)
        section.Back()
        assert.equal(host.Host.Content, section.Root)
    })

    it('PresentOverRoot creates the root when missing and drops pages above it', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        const first = new DetailPage()
        section.PresentOverRoot(first)
        assert.equal(section.Creates, 1)
        assert.equal(section.Current, first)
        section.Present(new DetailPage())
        const second = new DetailPage()
        section.PresentOverRoot(second)
        assert.equal(section.Creates, 1)
        section.Back()
        assert.equal(section.Current, section.Root)
    })

    it('a page holding a pending one-time value stays current through every navigation that would drop or cover it', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const section = new TestSection(host.Provider)
        section.OnActivated()
        const pending = new PendingPage()
        section.Present(pending)
        assert.equal(section.BackCommand.CanExecute(), false)
        section.Present(new DetailPage())
        assert.equal(section.Current, pending)
        section.Replace(new DetailPage())
        assert.equal(section.Current, pending)
        section.PresentOverRoot(new DetailPage())
        assert.equal(section.Current, pending)
        section.Back()
        assert.equal(section.Current, pending)
        await section.BackAndRefresh()
        assert.equal(section.Current, pending)
        assert.equal(host.Host.Content, pending)
        // Once the value is saved and cleared, navigation resumes.
        pending.HasPendingSecret = false
        assert.equal(section.BackCommand.CanExecute(), true)
        const detail = new DetailPage()
        section.Replace(detail)
        assert.equal(section.Current, detail)
        section.Back()
        assert.equal(section.Current, section.Root)
    })

    it('a cross-section open brings a section holding a pending value to the front on that value', () =>
    {
        const rail = new RailFixture()
        const itemB = new Capability()
        itemB.ServiceKey = SectionB as never
        rail.Navigation.Items.Add(itemB)
        rail.SelectB()
        const pending = new PendingPage()
        rail.B.Present(pending)
        rail.SelectA()
        assert.equal(rail.Host.Host.Content, rail.A.Root)
        rail.B.PresentOverRoot(new DetailPage())
        assert.equal(rail.B.BringToFront(), true)
        assert.equal(rail.Navigation.ActiveService, rail.B)
        assert.equal(rail.B.Current, pending)
        assert.equal(rail.Host.Host.Content, pending)
    })

    it('BringToFront selects the rail item naming the section; false when none does', () =>
    {
        const rail = new RailFixture()
        rail.SelectA()
        assert.equal(rail.B.BringToFront(), false)
        const item = new Capability()
        item.ServiceKey = SectionB as never
        rail.Navigation.Items.Add(item)
        assert.equal(rail.B.BringToFront(), true)
        assert.equal(rail.Navigation.ActiveService, rail.B)
        assert.equal(rail.Host.Host.Content, rail.B.Root)
    })
})
