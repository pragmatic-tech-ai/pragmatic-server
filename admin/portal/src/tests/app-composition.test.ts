import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Style, type Visual } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationItem } from '@pragmatic-tech-ai/mural/framework/navigation/navigation-item.js'
import { ToolTipService } from '@pragmatic-tech-ai/mural/framework/tooltips/tooltip-service.js'
import { Geometry } from '@pragmatic-tech-ai/mural/visual-engine'
import { EditorShell } from '@pragmatic-tech-ai/mural/framework/shell/editor-shell.js'
import { NavigationDestination, NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { ClipboardService } from '@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { app } from '../app.mu.js'
import { PortalNavigationService } from '../shell/portal-navigation-service.js'
import { PortalSessionService } from '../shell/portal-session-service.js'
import { FleetSectionService } from '../sections/fleet/fleet-section-service.js'
import { FleetPageViewModel } from '../sections/fleet/fleet-page-view-model.js'

// The compiled app.mu: a bare EditorShell over the portal's own services,
// with the sections in rail order and Fleet as the first (selected) one.
describe('app.mu composition', () =>
{
    const shell = app.Resources.Root as Visual

    it('roots a bare EditorShell', () =>
    {
        assert.ok(shell instanceof EditorShell)
    })

    it('registers the session at the app root', () =>
    {
        assert.ok(app.Services.get(PortalSessionService.Key) instanceof PortalSessionService)
    })

    it('uses the portal navigation with the side pane hidden and Fleet active', () =>
    {
        const nav = (shell as EditorShell).Services.get(NavigationService.Key)
        assert.ok(nav instanceof PortalNavigationService)
        assert.deepEqual(nav.Items.ToArray().map(i => (i as NavigationDestination).Label),
            ['Fleet', 'Clients', 'Tenants', 'Hives', 'Registry & Releases', 'Release Policy', 'Activity', 'Settings'])
        assert.equal(nav.SidePaneVisible, false)
        assert.ok(nav.ActiveService instanceof FleetSectionService)
    })

    it('gives every rail entry an icon from the portal icon dictionary', () =>
    {
        const nav = (shell as EditorShell).Services.get(NavigationService.Key)
        assert.ok(nav !== undefined)
        for (const item of nav.Items.ToArray())
        {
            const destination = item as NavigationDestination
            assert.ok(destination.Icon instanceof Geometry, destination.Label + ' has no icon')
        }
    })

    it('overrides the rail item style so each rail entry has its section name as a tooltip', () =>
    {
        const style = app.Resources.Get('ActivityBarItem')
        assert.ok(style instanceof Style)
        assert.equal(style.TargetType, NavigationItem)
        const tooltip = style.Setters.find(s => s.owner === ToolTipService && s.property === 'ToolTip')
        assert.ok(tooltip !== undefined, 'no ToolTip setter')
    })

    it('registers the clipboard at the app root', () =>
    {
        assert.ok(app.Services.get(ClipboardService.Key) instanceof ClipboardService)
    })

    it('presents the Fleet page in the shared content host', () =>
    {
        const host = (shell as EditorShell).Services.get(ContentHostService.Key)
        assert.equal(host, app.Services.get(ContentHostService.Key))
        assert.ok(host?.Content instanceof FleetPageViewModel)
    })
})
