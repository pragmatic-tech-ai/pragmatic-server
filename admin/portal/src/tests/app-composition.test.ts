import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { EditorShell } from '@pragmatic-tech-ai/mural/framework/shell/editor-shell.js'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { app } from '../app.mu.js'
import { PortalNavigationService } from '../shell/portal-navigation-service.js'
import { PortalSessionService } from '../shell/portal-session-service.js'
import { FleetSectionService } from '../sections/fleet/fleet-section-service.js'
import { FleetPageViewModel } from '../sections/fleet/fleet-page-view-model.js'

// The compiled app.mu: a bare EditorShell over the portal's own services,
// with the Fleet section as the first (selected) rail destination.
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
        assert.equal(nav.Items.Count, 1)
        assert.equal(nav.SidePaneVisible, false)
        assert.ok(nav.ActiveService instanceof FleetSectionService)
    })

    it('presents the Fleet page in the shared content host', () =>
    {
        const host = (shell as EditorShell).Services.get(ContentHostService.Key)
        assert.equal(host, app.Services.get(ContentHostService.Key))
        assert.ok(host?.Content instanceof FleetPageViewModel)
    })
})
