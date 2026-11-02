import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApplicationService, ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { NavigationDestination } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { PortalNavigationService } from '../portal-navigation-service.js'

class Fx
{
    public static Capability(name: string): Capability
    {
        const c = new Capability()
        c.Name = name
        return c
    }

    // A provider whose ApplicationService reports one module with two capabilities.
    public static Provider(): ServiceProvider
    {
        const provider = new ServiceProvider()
        const module = { Capabilities: [Fx.Capability('First'), Fx.Capability('Second')] }
        const app = { Modules: [module] } as unknown as ApplicationService
        provider.registerInstance(ApplicationService.Key, app)
        return provider
    }
}

describe('PortalNavigationService', () =>
{
    it('populates from modules and selects the first destination', () =>
    {
        const nav = new PortalNavigationService(Fx.Provider())
        assert.equal(nav.Items.Count, 2)
        const first = nav.Items.Get(0) as NavigationDestination
        assert.equal(nav.SelectedItem, first)
        assert.equal(first.Label, 'First')
        assert.equal(nav.SidePaneVisible, false)
    })

    it('keeps the side pane hidden on selection and on repeated activation', () =>
    {
        const nav = new PortalNavigationService(Fx.Provider())
        const second = nav.Items.Get(1) as NavigationDestination
        nav.SelectedItem = second
        assert.equal(nav.SidePaneVisible, false)
        second.ActivateCommand?.Execute()
        assert.equal(nav.SidePaneVisible, false)
        second.ActivateCommand?.Execute()
        assert.equal(nav.SidePaneVisible, false)
    })
})
