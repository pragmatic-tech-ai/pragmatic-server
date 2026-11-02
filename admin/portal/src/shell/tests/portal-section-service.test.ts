import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from '../../api-client.js'
import { PageState, PortalPageViewModel } from '../portal-page-view-model.js'
import { PortalSectionService } from '../portal-section-service.js'
import { PortalTestHost } from './portal-test-fixtures.js'

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

class Tick
{
    public static Next(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }
}

class Fx
{
    public static Host(): PortalTestHost
    {
        return new PortalTestHost({} as ControlPlaneClient)
    }
}

describe('PortalSectionService', () =>
{
    it('first activation creates and presents the root once', async () =>
    {
        const host = Fx.Host()
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
        const host = Fx.Host()
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
        const host = Fx.Host()
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
        const host = Fx.Host()
        const section = new TestSection(host.Provider)
        section.OnActivated()
        await Tick.Next()
        await section.RefreshCurrent()
        assert.equal(section.Root?.Loads, 2)
    })
})
